// A chat turn that dies on a transient error is continued on its own (backed off, bounded); limits, auth and stops are not.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import { DRIVER_RETRY_DELAYS_MS, ERROR_STALL_MAX_RETRIES } from '../server/error-stall';

const runtime = (): ManagerRuntime => ({ notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any) } as any);

function setup(t: any) {
  if (!t.__mocked) { t.mock.timers.enable({ apis: ['setTimeout'] }); t.__mocked = true; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-resume-'));
  const mgr = new SessionManager(runtime(), new ChatThreadStore(dir), { driverFactory: () => ({}) as any });
  const th = mgr.store.create({ agent: 'antigravity', cwd: '/r' } as any);
  const sent: any[] = [];
  (mgr as any).sendTurn = async (p: any) => { sent.push(p); return { turnId: 'x' }; };
  const settle = (state: string, errorMessage?: string) => (mgr as any).onEvent({ type: 'turn.settled', threadId: th.id, turnId: 'T', state, errorMessage, seq: 0, at: Date.now() });
  return { mgr, th, sent, settle };
}

test('a transient failure is continued after a back-off, and a finished turn resets the count', (t) => {
  const { sent, settle } = setup(t);
  settle('failed', 'Antigravity stopped: The stream was interrupted.');
  assert.equal(sent.length, 0, 'waits for the back-off');
  t.mock.timers.tick(DRIVER_RETRY_DELAYS_MS[0]);
  assert.equal(sent.length, 1);
  assert.deepEqual({ text: sent[0].text, origin: sent[0].origin }, { text: 'continue', origin: 'kora-notice' });
  settle('completed');
  settle('failed', 'There was a network issue connecting to the server');
  t.mock.timers.tick(DRIVER_RETRY_DELAYS_MS[0]);
  assert.equal(sent.length, 2, 'the count started over after a completed turn');
});

test('retries are bounded; limits, auth and interrupts are never retried', (t) => {
  const { sent, settle } = setup(t);
  for (let i = 0; i < ERROR_STALL_MAX_RETRIES + 2; i++) { settle('failed', 'net/http: TLS handshake timeout'); t.mock.timers.tick(400_000); }
  assert.equal(sent.length, ERROR_STALL_MAX_RETRIES);
  const b = setup(t);
  b.settle('failed', 'Antigravity is not signed in. Run `agy` once');
  b.settle('failed', "You've hit your usage limit");
  b.settle('interrupted');
  t.mock.timers.tick(400_000);
  assert.equal(b.sent.length, 0);
});

test('a worker thread is left to its pane, and a stop cancels a pending continue', async (t) => {
  const w = setup(t);
  w.mgr.store.update(w.th.id, { workerPaneId: 'p3' } as any);
  w.settle('failed', 'API Error: 529 Overloaded');
  t.mock.timers.tick(400_000);
  assert.equal(w.sent.length, 0);
  const s = setup(t);
  s.settle('failed', 'API Error: 529 Overloaded');
  await s.mgr.stop(s.th.id).catch(() => {});
  t.mock.timers.tick(400_000);
  assert.equal(s.sent.length, 0);
});

test('the cap holds through progress and the session restart each continuation makes (agy), and the user\'s own message resets it', async (t) => {
  const { mgr, th, sent, settle } = setup(t);
  for (let i = 0; i < ERROR_STALL_MAX_RETRIES + 2; i++) {
    (mgr as any).onEvent({ type: 'tool.result', threadId: th.id, itemId: `i${i}`, status: 'completed', seq: 0, at: Date.now() }); // progress, then the same failure
    settle('failed', 'Antigravity could not load its model list, usually a network connection problem.');
    t.mock.timers.tick(400_000);
    await mgr.stop(th.id).catch(() => {}); // the continue's own restart
  }
  assert.equal(sent.length, ERROR_STALL_MAX_RETRIES);
  (mgr as any).resumeCount.set(th.id, ERROR_STALL_MAX_RETRIES);
  delete (mgr as any).sendTurn; // the real sendTurn's first line resets the count for a user's message
  await mgr.sendTurn({ threadId: th.id, text: 'hi' }).catch(() => {});
  assert.equal((mgr as any).resumeCount.has(th.id), false);
});

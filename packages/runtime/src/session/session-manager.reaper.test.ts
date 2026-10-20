// SessionManager.reapIdle: a daemon that runs for weeks must not keep one `claude` process per thread ever opened.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  live = new Set<ThreadId>();
  starts: SessionStartInput[] = [];
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.live.has(id); }
  async startSession(input: SessionStartInput) { this.starts.push(input); this.live.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: SendTurnInput) { const turnId = `turn_${Math.random()}`; this.emit(input.threadId, { type: 'turn.started', turnId }); return { threadId: input.threadId, turnId }; }
  async interruptTurn() {}
  async respondToApproval() {}
  async respondToUserInput() {}
  async setModel() {}
  stops: { id: ThreadId; idle: boolean }[] = [];
  async stopSession(id: ThreadId, opts?: { idle?: boolean }) { this.stops.push({ id, idle: !!opts?.idle }); this.live.delete(id); this.emit(id, { type: 'session.exited', recoverable: true }); }
  forgotten: ThreadId[] = [];
  forgetThread(id: ThreadId) { this.forgotten.push(id); }
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-reap-'));
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any) };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver });
  return { mgr, driver, dir };
}
const MIN = 60_000;

test('reapIdle: settled sessions idle past the limit stop; running / waiting ones never do; the next turn resumes', async () => {
  const { mgr, driver, dir } = harness();
  const idle = mgr.create({ agent: 'claude', cwd: '/r' });
  const running = mgr.create({ agent: 'claude', cwd: '/r' });
  const waiting = mgr.create({ agent: 'claude', cwd: '/r' });
  for (const t of [idle, running, waiting]) await mgr.start(t.id);
  await mgr.sendTurn({ threadId: running.id, text: 'long job' });
  driver.emit(waiting.id, { type: 'approval.opened', requestId: 'r1', kind: 'command', title: 'x' } as any);
  assert.equal(mgr.get(waiting.id).state, 'waiting');

  assert.deepEqual(await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 8 }), [], 'nothing is idle long enough yet');
  const later = Date.now() + 31 * MIN;
  assert.deepEqual(await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 8, now: later }), [idle.id]);
  assert.ok(!driver.hasSession(idle.id)); assert.ok(driver.hasSession(running.id)); assert.ok(driver.hasSession(waiting.id));
  assert.deepEqual(driver.stops, [{ id: idle.id, idle: true }], 'a reap tells the driver it is an idle stop (keep-warm chains run on)');

  await mgr.sendTurn({ threadId: idle.id, text: 'back again' });
  assert.ok(driver.hasSession(idle.id), 'the next turn restarts the session');
  assert.equal(driver.starts.filter((s) => s.threadId === idle.id).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reapIdle: past maxLive the least recently active settled sessions go first; a fleet thread with workers waits 4x', async () => {
  const { mgr, driver, dir } = harness();
  const ts = [0, 1, 2, 3].map(() => mgr.create({ agent: 'claude', cwd: '/r' }));
  for (const t of ts) { await mgr.start(t.id); await new Promise((r) => setTimeout(r, 5)); }
  driver.emit(ts[0].id, { type: 'runtime.warning', message: 'activity' } as any); // t0 is now the most recent
  const reaped = await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 2 });
  assert.deepEqual(reaped.sort(), [ts[1].id, ts[2].id].sort(), 'oldest two go, the recently active one stays');

  const fleet = mgr.create({ agent: 'claude', cwd: '/r', agentMode: 'orchestrator' });
  await mgr.start(fleet.id);
  driver.emit(fleet.id, { type: 'worker.attached', paneId: 'p1', agent: 'opencode' } as any);
  assert.deepEqual(await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 99, now: Date.now() + 31 * MIN }).then((r) => r.filter((id) => id === fleet.id)), []);
  assert.deepEqual(await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 99, now: Date.now() + 121 * MIN }).then((r) => r.filter((id) => id === fleet.id)), [fleet.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reapIdle: a thread reaped idle and then deleted is forgotten (its keep-warm chain must not outlive it)', async () => {
  const { mgr, driver, dir } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  assert.deepEqual(await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 8, now: Date.now() + 31 * MIN }), [t.id]);
  assert.deepEqual(driver.forgotten, [], 'an idle reap keeps the chain');
  await mgr.delete(t.id);
  assert.deepEqual(driver.forgotten, [t.id], 'deleting the reaped thread drops what the driver still holds for it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reapIdle: a thread deleted under the reaper gets a real stop, not an idle one (its keep-warm chain ends)', async () => {
  const { mgr, driver, dir } = harness();
  const g = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(g.id);
  (mgr as any).store.delete(g.id);
  await mgr.reapIdle({ idleMs: 30 * MIN, maxLive: 8 });
  assert.deepEqual(driver.stops.at(-1), { id: g.id, idle: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

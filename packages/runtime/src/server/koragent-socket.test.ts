// The event-stream client against the fake koragent (test/fixtures/fake-koragent.cjs, a real process listening on a
// real unix socket): retry until it listens, hello{sinceSeq} + replay, reconnect after a dropped connection with no
// event twice, a "restarted daemon" (a fresh client) getting the whole ring buffer, and steers acknowledged.
import test from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { KoragentEvent } from '../protocol/koragent';
import { KoragentEventClient } from './koragent-socket';

// Koragent (Kora Pro, Bun, a unix:<path> socket) is not ported to Windows yet (docs/windows/PORT.md).
const winSkip = { skip: process.platform === 'win32' };

export const FAKE_KORAGENT = path.resolve(__dirname, '../../test/fixtures/fake-koragent.cjs');
const base = process.env.KORA_TEST_BASE || fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'kgs-'));
const until = async (f: () => boolean, ms = 10_000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); return f(); };

function startFake(name: string, goal: string): { proc: ChildProcess; sock: string; wt: string } {
  const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
  const wt = path.join(dir, 'wt'); fs.mkdirSync(wt, { recursive: true });
  const sock = path.join(dir, 'k.sock');
  const specFile = path.join(dir, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ v: 1, taskId: 's1', goal, acceptance: {}, budget: {}, route: [{ model: 'opencode/a' }, { model: 'opencode/b' }],
    worktree: { path: wt, mainRoot: wt, branch: '' }, permission: 'full', report: { path: path.join(dir, 's1.json') } }));
  const proc = spawn(process.execPath, [FAKE_KORAGENT, '--task-spec', specFile, '--event-stream', `unix:${sock}`], { stdio: 'ignore' });
  return { proc, sock, wt };
}

function collect(c: KoragentEventClient): KoragentEvent[] { const out: KoragentEvent[] = []; c.on('event', (e: KoragentEvent) => out.push(e)); return out; }
const seqs = (es: KoragentEvent[]) => es.filter((e) => e.type !== 'hello').map((e) => e.seq);

test('client retries until koragent listens, replays from seq 0, and dedupes across a dropped connection', winSkip, async () => {
  const f = startFake('drop', 'do it [fake:slow-listen] [fake:wait-steer]');
  const c = new KoragentEventClient(f.sock, { retryMs: 50, maxRetryMs: 200 }).start();
  try {
    const got = collect(c);
    assert.ok(await until(() => got.some((e) => e.type === 'tool.end')), 'events arrive after the late bind');
    assert.equal(got[0].type, 'hello', 'the hello comes first');
    assert.ok(got.some((e) => e.type === 'session.state' && e.state === 'starting'), 'the replay starts at the first event');
    const before = c.lastSeq;
    // A transient drop: koragent closes every connection; the client reconnects with hello{sinceSeq: lastSeq}.
    f.proc.kill('SIGUSR2');
    assert.ok(await until(() => c.connects >= 2), 'reconnected');
    // steer → acknowledged with Kora's id → the scripted round finishes
    c.send({ type: 'steer', text: 'use the new API', source: 'leader', delivery: 'steer', id: 'k-1' });
    assert.ok(await until(() => got.some((e) => e.type === 'session.state' && e.state === 'done')));
    const rec = got.find((e) => e.type === 'steer.received') as Extract<KoragentEvent, { type: 'steer.received' }>;
    assert.deepEqual([rec.id, rec.source, rec.delivery], ['k-1', 'leader', 'steer']);
    assert.ok(got.some((e) => e.type === 'steer.delivered' && e.id === 'k-1'));
    const report = got.find((e) => e.type === 'task.report') as Extract<KoragentEvent, { type: 'task.report' }>;
    assert.match(report.report.summary, /steer: use the new API \(leader, steer\)/);
    const s = seqs(got);
    assert.equal(new Set(s).size, s.length, `no event twice: ${s.join(',')}`);
    assert.deepEqual(s, [...s].sort((a, b) => a - b), 'in order');
    assert.ok(s.includes(before) && before > 0);
  } finally { c.close(); f.proc.kill(); }
});

test('a restarted daemon (a fresh client, sinceSeq 0) gets the ring buffer replayed; sinceSeq N skips 1..N', winSkip, async () => {
  const f = startFake('restart', 'do it');
  const a = new KoragentEventClient(f.sock, { retryMs: 30 }).start();
  try {
    const ga = collect(a);
    assert.ok(await until(() => ga.some((e) => e.type === 'session.state' && e.state === 'done')));
    a.close(); // the daemon died
    const b = new KoragentEventClient(f.sock, { retryMs: 30 }).start();
    const gb = collect(b);
    assert.ok(await until(() => gb.some((e) => e.type === 'session.state' && e.state === 'done')));
    assert.deepEqual(seqs(gb), seqs(ga), 'the same events, replayed');
    b.close();
    const k = 3;
    const cl = new KoragentEventClient(f.sock, { retryMs: 30, sinceSeq: k }).start();
    const gc = collect(cl);
    assert.ok(await until(() => gc.some((e) => e.type === 'session.state' && e.state === 'done')));
    assert.equal(Math.min(...seqs(gc)), k + 1);
    const hello = gc[0] as Extract<KoragentEvent, { type: 'hello' }>;
    assert.equal(hello.type, 'hello'); assert.equal(hello.replayFrom, k + 1);
    cl.close();
  } finally { a.close(); f.proc.kill(); }
});

test('messages sent while disconnected are queued and delivered after the hello', winSkip, async () => {
  const f = startFake('queue', 'do it [fake:slow-listen] [fake:blocked]');
  const c = new KoragentEventClient(f.sock, { retryMs: 50 });
  try {
    const got = collect(c);
    c.send({ type: 'permission.reply', id: 'perm_1', allow: true }); // before start: queued
    c.start();
    assert.ok(await until(() => got.some((e) => e.type === 'session.state' && e.state === 'done')), 'the queued reply unblocked it');
    assert.ok(got.some((e) => e.type === 'permission.request'));
  } finally { c.close(); f.proc.kill(); }
});

test('2026-10-15 #8: a pane socket folder must be our own plain folder; a loose one is tightened, a symlink refused', async () => {
  const { ensurePrivateSocketDir } = await import('./koragent-backend');
  const fsm = await import('node:fs'); const osm = await import('node:os'); const pathm = await import('node:path');
  const base = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'kora-psd-'));
  try {
    const d = pathm.join(base, 'a'); ensurePrivateSocketDir(d); assert.equal(fsm.statSync(d).mode & 0o777, 0o700);
    if (process.platform !== 'win32') {
      fsm.chmodSync(d, 0o777); ensurePrivateSocketDir(d); assert.equal(fsm.statSync(d).mode & 0o077, 0, 'tightened');
      const l = pathm.join(base, 'l'); fsm.symlinkSync(d, l);
      assert.throws(() => ensurePrivateSocketDir(l), /not a plain folder/);
    }
  } finally { fsm.rmSync(base, { recursive: true, force: true }); }
});

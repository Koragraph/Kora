import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, folderProblem, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';

// ── a fake driver that lets the test emit arbitrary events through the manager's fan-out ──────────
class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  started = new Set<ThreadId>();
  approvals: { threadId: string; requestId: string; decision: string }[] = [];
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.started.has(id); }
  async startSession(input: SessionStartInput) { this.starts++; this.started.add(input.threadId); this.emit(input.threadId, { type: 'session.started' }); return { threadId: input.threadId }; }
  async sendTurn(input: any) { const turnId = 'turn_1'; this.emit(input.threadId, { type: 'turn.started', turnId }); return { threadId: input.threadId, turnId }; }
  async interruptTurn() {}
  async respondToApproval(threadId: string, requestId: string, decision: any) { this.approvals.push({ threadId, requestId, decision }); this.emit(threadId, { type: 'approval.resolved', requestId, decision }); }
  async respondToUserInput() {}
  refuseModel = false;
  starts = 0;
  async setModel() { return !this.refuseModel; }
  async stopSession(id: ThreadId) { this.started.delete(id); this.emit(id, { type: 'session.exited', recoverable: true }); }
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const store = new ChatThreadStore(dir);
  const notifs: { method: string; params: any }[] = [];
  const runtime: ManagerRuntime = {
    notify: (method, params) => notifs.push({ method, params: params as any }),
    graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) },
    agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any),
  };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, store, { driverFactory: () => driver });
  const chatEvents = () => notifs.filter((n) => n.method === 'chat.event').map((n) => n.params as ChatEvent);
  return { mgr, store, driver, notifs, chatEvents };
}

test('manager stamps a gap-free seq and fans events onto chat.event', async () => {
  const { mgr, driver, chatEvents } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  for (let i = 0; i < 4; i++) driver.emit(t.id, { type: 'content.delta', itemId: 'i', stream: 'assistant_text', delta: `d${i}` });
  const seqs = chatEvents().map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'session.started(1) then four deltas — gap-free');
  assert.ok(chatEvents().every((e) => e.threadId === t.id));
});

test('manager persists every event to the log (source of truth) and backfills from a cursor', async () => {
  const { mgr, store, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  driver.emit(t.id, { type: 'content.delta', itemId: 'i', stream: 'assistant_text', delta: 'a' });
  driver.emit(t.id, { type: 'content.delta', itemId: 'i', stream: 'assistant_text', delta: 'b' });
  const all = store.read(t.id, 0);
  assert.deepEqual(all.events.map((e) => e.type), ['session.started', 'content.delta', 'content.delta']);
  const backfill = mgr.backfill(t.id, 1);
  assert.deepEqual(backfill.events.map((e) => e.seq), [2, 3], 'backfill skips seq<=cursor');
});

test('turn lifecycle drives the thread head state (running → idle)', async () => {
  const { mgr, store, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  await mgr.sendTurn({ threadId: t.id, text: 'hi' });
  assert.equal(store.get(t.id).state, 'running');
  driver.emit(t.id, { type: 'turn.settled', turnId: 'turn_1', state: 'completed' });
  assert.equal(store.get(t.id).state, 'idle');
  assert.ok(store.get(t.id).lastSeq >= 3);
});

test('worker.attached / detached maintain workerPaneIds on the head', async () => {
  const { mgr, store, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', isOrchestrator: true });
  await mgr.start(t.id);
  driver.emit(t.id, { type: 'worker.attached', paneId: 'p1', workerAgent: 'claude', title: 'A' });
  driver.emit(t.id, { type: 'worker.attached', paneId: 'p2', workerAgent: 'claude', title: 'B' });
  assert.deepEqual(store.get(t.id).workerPaneIds.sort(), ['p1', 'p2']);
  driver.emit(t.id, { type: 'worker.detached', paneId: 'p1' });
  assert.deepEqual(store.get(t.id).workerPaneIds, ['p2']);
});

test('an approval flows through the manager to the driver and resolves', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  await mgr.respondApproval(t.id, 'req-1', 'accept');
  assert.deepEqual(driver.approvals, [{ threadId: t.id, requestId: 'req-1', decision: 'accept' }]);
});

test('list hides archived threads unless asked; create notifies chat.thread.created', async () => {
  const { mgr, notifs } = harness();
  const a = mgr.create({ agent: 'claude', cwd: '/r', title: 'A' });
  mgr.create({ agent: 'claude', cwd: '/r', title: 'B' });
  mgr.archive(a.id);
  assert.equal(mgr.list().length, 1, 'archived hidden by default');
  assert.equal(mgr.list(true).length, 2, 'includeArchived returns all');
  assert.ok(notifs.some((n) => n.method === 'chat.thread.created'));
});

test('setModel persists the model on the head', async () => {
  const { mgr, store } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  await mgr.setModel(t.id, { model: 'claude-opus-4-8' });
  assert.equal(store.get(t.id).model?.model, 'claude-opus-4-8');
});

test('a model switch the live session refuses restarts it before the next turn (pl2 S2-1)', async () => {
  const { mgr, store, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.sendTurn({ threadId: t.id, text: 'hi' });
  assert.equal(driver.starts, 1);
  // Accepted in-session, same effort: no restart.
  await mgr.changeModel(t.id, { model: 'sonnet' });
  await mgr.sendTurn({ threadId: t.id, text: 'again' });
  assert.equal(driver.starts, 1, 'an accepted switch keeps the session');
  // Refused (the bundled CLI's catalog lacks the model), same effort: the old code kept the old model running.
  driver.refuseModel = true;
  await mgr.changeModel(t.id, { model: 'claude-haiku-5-5' });
  assert.equal(store.get(t.id).model?.model, 'claude-haiku-5-5');
  await mgr.sendTurn({ threadId: t.id, text: 'third' });
  assert.equal(driver.starts, 2, 'restarted with the new model before the turn');
});

test('delete stops the session and removes the thread', async () => {
  const { mgr, store, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  await mgr.delete(t.id);
  assert.equal(store.has(t.id), false);
  assert.equal(driver.hasSession(t.id), false);
});

// ── restart semantics (moved here from the desktop chat daemon's hydrate seam) ────────────────────────
class RecordingDriver extends FakeDriver {
  inputs: SessionStartInput[] = [];
  deps: any = null;
  async startSession(input: SessionStartInput) { this.inputs.push(input); return super.startSession(input); }
}

test('the permission mode survives a daemon restart: persisted on the thread head, read back at session start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any) };
  const first = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => new FakeDriver() });
  const t = first.create({ agent: 'claude', cwd: '/r' });
  first.setPermissionMode(t.id, 'full-access');
  // a NEW manager over the same store = the daemon after a restart; nobody replays the mode into it
  const driver = new RecordingDriver();
  const second = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver });
  await second.start(t.id);
  assert.equal(driver.inputs[0].runtimeMode, 'full-access');
  // an untouched thread still starts supervised
  const u = second.create({ agent: 'claude', cwd: '/r' });
  await second.start(u.id);
  assert.equal(driver.inputs[1].runtimeMode, 'approval-required');
});

test('every session start — resume included — asks the runtime to keep the checkout\'s graph fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const fresh: string[] = [];
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }), ensureFresh: (cwd) => fresh.push(cwd) }, agentSpawn: async () => ({} as any) };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver });
  const t = mgr.create({ agent: 'claude', cwd: '/work/app' });
  await mgr.start(t.id);
  await mgr.stop(t.id);
  await mgr.start(t.id); // the resume path
  assert.deepEqual(fresh, ['/work/app', '/work/app']);
});

test('the runtime\'s pane-equivalent preparation reaches the driver as prepareSession', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const seen: any[] = [];
  const runtime: ManagerRuntime = {
    notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any),
    prepareChat: async (p) => { seen.push(p); return { env: { KORA_PANE_ID: `chat:${p.threadId}` }, notes: [] }; },
  };
  let deps: any = null;
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: (_a, d) => { deps = d; return new FakeDriver(); } });
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.start(t.id);
  assert.equal(typeof deps.prepareSession, 'function');
  const prep = await deps.prepareSession({ threadId: t.id, agent: 'claude', cwd: '/r', account: null });
  assert.deepEqual(seen, [{ threadId: t.id, agent: 'claude', cwd: '/r', account: null }]);
  assert.equal(prep.env.KORA_PANE_ID, `chat:${t.id}`);
});

test('a thread whose folder is gone does not start: the error names the folder, not a missing `claude`', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any) };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver, folderExists: (cwd) => cwd !== '/gone' });
  const t = mgr.create({ agent: 'claude', cwd: '/gone' });
  await assert.rejects(mgr.sendTurn({ threadId: t.id, text: 'hi' }), /folder is gone: \/gone\. It was moved, renamed or deleted/);
  assert.equal(driver.started.size, 0);
  const ok = mgr.create({ agent: 'claude', cwd: '/here' });
  await mgr.sendTurn({ threadId: ok.id, text: 'hi' });
  assert.equal(driver.started.size, 1);
});

// B1 (night 2026-10-04): a project folder the user may not read failed with the SDK's "native binary … failed to launch …
// musl … libc" guess, and a file opened as a project with a bare `spawn ENOTDIR`. Both now say what is wrong.
test('folderProblem names a gone folder, a file, and a folder the user may not open', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-folder-'));
  const ok = path.join(base, 'ok'); fs.mkdirSync(ok);
  const file = path.join(base, 'notes.txt'); fs.writeFileSync(file, 'x');
  const locked = path.join(base, 'locked'); fs.mkdirSync(locked); fs.chmodSync(locked, 0o000);
  try {
    assert.equal(folderProblem(ok), null);
    assert.match(folderProblem(path.join(base, 'nope')) ?? '', /folder is gone: .*nope\. It was moved, renamed or deleted/);
    assert.match(folderProblem(file) ?? '', /is a file, not a folder: .*notes\.txt/);
    // Windows has no mode bits: chmod 000 does not lock a folder there.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) assert.match(folderProblem(locked) ?? '', /can't open this thread's folder: .*locked \(permission denied\)/);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a folder the user may not open does not start a session: the error says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-'));
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any) };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver, folderProblem: (cwd) => (cwd === '/denied' ? 'Kora can\'t open this thread\'s folder: /denied (permission denied).' : null) });
  const t = mgr.create({ agent: 'claude', cwd: '/denied' });
  await assert.rejects(mgr.sendTurn({ threadId: t.id, text: 'hi' }), /permission denied/);
  assert.equal(driver.started.size, 0);
});

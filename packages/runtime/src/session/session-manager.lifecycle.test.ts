// B5 plumbing on SessionManager: undo a chip-started compaction, and draft a fresh-thread brief.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';
import { snapshotBeforeCompact } from './compact-undo';
import { claudeSlug } from './prune';
import { SID, thread } from './prune.fixture';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  live = new Set<ThreadId>();
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.live.has(id); }
  async startSession(input: SessionStartInput) { this.live.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: any) { return { threadId: input.threadId, turnId: 't' }; }
  async interruptTurn() {}
  async respondToApproval() {}
  async respondToUserInput() {}
  async setModel() {}
  async stopSession(id: ThreadId) { this.live.delete(id); }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sm-lc-'));
  const cfg = path.join(dir, 'claude'); const cwd = path.join(dir, 'repo'); fs.mkdirSync(cwd, { recursive: true });
  const pdir = path.join(cfg, 'projects', claudeSlug(cwd)); fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), thread(6).map((e) => JSON.stringify(e)).join('\n') + '\n');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any) };
  const driver = new FakeDriver();
  const store = new ChatThreadStore(path.join(dir, 'chat'));
  const mgr = new SessionManager(runtime, store, { driverFactory: () => driver });
  const t = mgr.create({ agent: 'claude', cwd });
  return { dir, cfg, cwd, mgr, store, driver, t, pdir };
}

test('undoCompaction points the thread at a restored copy and stops the live session; refused while busy; nothing to undo otherwise', async () => {
  const s = setup();
  await s.mgr.start(s.t.id);
  s.driver.emit(s.t.id, { type: 'thread.started', providerThreadId: SID });
  assert.equal(s.mgr.canUndoCompaction(s.t.id), false);
  assert.deepEqual(await s.mgr.undoCompaction(s.t.id), { ok: false, reason: 'nothing to undo' });

  assert.equal(await snapshotBeforeCompact({ threadId: s.t.id, sessionId: SID, cwd: s.cwd, configDir: s.cfg }), true);
  assert.equal(s.mgr.canUndoCompaction(s.t.id), true);
  s.driver.emit(s.t.id, { type: 'turn.started', turnId: 'x' } as any);
  s.mgr.get(s.t.id); // state is running now
  const busy = await s.mgr.undoCompaction(s.t.id);
  if (!busy.ok) assert.equal(busy.reason, 'the thread is busy');
  s.driver.emit(s.t.id, { type: 'turn.settled', turnId: 'x', state: 'completed' } as any);

  const r = await s.mgr.undoCompaction(s.t.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const resume = s.store.get(s.t.id).resume as string;
  assert.notEqual(resume, SID);
  assert.ok(fs.existsSync(path.join(s.pdir, `${resume}.jsonl`)));
  assert.equal(s.driver.hasSession(s.t.id), false, 'the live session was stopped; the next turn resumes the restored one');
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('threadBrief is null for a thread with no provider session', async () => {
  const s = setup();
  assert.equal(await s.mgr.threadBrief(s.t.id), null);
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('deleting a thread removes the files kept for it alone: flags, undo copy, spilled Bash output, its Kora-made fork (never the original)', async () => {
  const s = setup();
  const home = process.env.KORA_HOME!;
  await s.mgr.start(s.t.id);
  const forkId = '99999999-2222-3333-4444-555555555555';
  const forkFile = path.join(s.pdir, `${forkId}.jsonl`);
  fs.writeFileSync(forkFile, '{}\n');
  fs.writeFileSync(path.join(home, 'prune-forks.json'), JSON.stringify({ [forkId]: { original: SID, file: forkFile, at: Date.now() } }));
  s.driver.emit(s.t.id, { type: 'thread.started', providerThreadId: forkId });
  fs.mkdirSync(path.join(home, 'thread-flags'), { recursive: true });
  fs.writeFileSync(path.join(home, 'thread-flags', `${s.t.id}.json`), '{"safeTools":true}');
  assert.equal(await snapshotBeforeCompact({ threadId: s.t.id, sessionId: SID, cwd: s.cwd, configDir: s.cfg }), true);
  const spill = path.join(home, 'tool-out', s.t.id); fs.mkdirSync(spill, { recursive: true }); fs.writeFileSync(path.join(spill, 'a.txt'), 'x');
  await s.mgr.delete(s.t.id);
  assert.equal(fs.existsSync(path.join(home, 'thread-flags', `${s.t.id}.json`)), false);
  assert.equal(fs.existsSync(path.join(home, 'compact-undo', `${s.t.id}.jsonl`)), false);
  assert.equal(fs.existsSync(spill), false);
  assert.equal(fs.existsSync(forkFile), false, 'the fork goes');
  assert.ok(fs.existsSync(path.join(s.pdir, `${SID}.jsonl`)), 'the original transcript stays');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'prune-forks.json'), 'utf8')), {});
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(s.dir, { recursive: true, force: true });
});

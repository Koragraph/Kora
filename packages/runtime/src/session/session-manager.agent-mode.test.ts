// SessionManager: the Chat | Orchestrator | Swarm mode, its persisted notice, pendingRestart, the Claude-only
// swarm leader and swarm-worker cleanup (swarm S1, CP3).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, DriverDeps } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  live = new Set<ThreadId>();
  starts: SessionStartInput[] = [];
  turns: SendTurnInput[] = [];
  stops = 0;
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.live.has(id); }
  async startSession(input: SessionStartInput) { this.starts.push(input); this.live.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: SendTurnInput) { this.turns.push(input); const turnId = `turn_${this.turns.length}`; this.emit(input.threadId, { type: 'turn.started', turnId }); return { threadId: input.threadId, turnId }; }
  async interruptTurn() {}
  async respondToApproval() {}
  async respondToUserInput() {}
  async setModel() {}
  async stopSession(id: ThreadId) { this.stops++; this.live.delete(id); this.emit(id, { type: 'session.exited', recoverable: true }); }
}

function harness(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mode-')), indexed = false) {
  const cleanups: { orchestratorId: string; opts?: { kill?: boolean } }[] = [];
  const runtime: ManagerRuntime = {
    notify: () => {},
    graph: { callTool: async () => ({ text: '', data: null, ms: 0 }), ...(indexed ? { status: async () => ({ indexed: true }) as never } : {}) },
    agentSpawn: async () => ({} as any),
    swarm: {
      spawn: async () => { throw new Error('unused'); },
      taskForPane: () => null,
      readReport: async () => null,
      cleanupThread: async (orchestratorId, opts) => { cleanups.push({ orchestratorId, ...(opts ? { opts } : {}) }); },
    },
  };
  const driver = new FakeDriver();
  let deps: DriverDeps | null = null;
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: (_a, d) => { deps = d; return driver; } });
  return { mgr, driver, dir, cleanups, deps: () => deps! };
}

test('the mode survives a daemon restart: a new manager over the same store starts the session in swarm', async () => {
  const a = harness();
  const t = a.mgr.create({ agent: 'claude', cwd: '/r' });
  await a.mgr.setAgentMode(t.id, 'swarm');
  const b = harness(a.dir); // the restarted daemon
  assert.equal(b.mgr.get(t.id).agentMode, 'swarm');
  assert.equal(b.mgr.get(t.id).isOrchestrator, true, 'isOrchestrator stays the derived fleet flag');
  await b.mgr.start(t.id);
  assert.equal(b.driver.starts[0].agentMode, 'swarm');
  assert.equal(b.driver.starts[0].isOrchestrator, true);
  // …and the undelivered notice survived with it.
  const n = b.mgr.takeModeNotice(t.id);
  assert.ok(n && n.from === 'chat' && n.to === 'swarm' && n.text.length > 0);
});

test('a flip mid-turn does not stop the running turn; the next sendTurn restarts the session in the new mode', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.sendTurn({ threadId: t.id, text: 'long task' });
  assert.equal(mgr.get(t.id).state, 'running');
  await mgr.setAgentMode(t.id, 'swarm');
  assert.equal(driver.stops, 0, 'the live turn is untouched');
  assert.ok(driver.hasSession(t.id));
  await mgr.sendTurn({ threadId: t.id, text: 'next' });
  assert.equal(driver.stops, 1, 'restarted before the next turn');
  assert.equal(driver.starts.length, 2);
  assert.equal(driver.starts[1].agentMode, 'swarm');
  await mgr.sendTurn({ threadId: t.id, text: 'again' });
  assert.equal(driver.stops, 1, 'only once');
});

test('the notice is delivered exactly once, and a flip back before delivery cancels it', async () => {
  const { mgr } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  const r = await mgr.setAgentMode(t.id, 'swarm');
  assert.ok(r.notice);
  assert.deepEqual(mgr.takeModeNotice(t.id), r.notice);
  assert.equal(mgr.takeModeNotice(t.id), null, 'taken once');
  assert.equal(mgr.get(t.id) && (mgr.get(t.id) as any).announcedAgentMode, 'swarm');

  const u = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.setAgentMode(u.id, 'swarm');
  const back = await mgr.setAgentMode(u.id, 'chat');
  assert.equal(back.notice, null, 'Chat → Swarm → Chat before delivery: nothing to tell');
  assert.equal(mgr.takeModeNotice(u.id), null);

  const o = mgr.create({ agent: 'claude', cwd: '/r' });
  assert.equal((await mgr.setAgentMode(o.id, 'orchestrator')).notice, null, 'chat ↔ orchestrator needs no notice');
});

test('a thread created in swarm carries the notice to its first turn', () => {
  const { mgr } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', agentMode: 'swarm' });
  assert.equal(t.agentMode, 'swarm');
  const n = mgr.takeModeNotice(t.id);
  assert.ok(n && n.from === 'chat' && n.to === 'swarm');
});

test('Codex and OpenCode lead a swarm; a leader with no fleet bridge is rejected', async () => {
  const { mgr } = harness();
  const t = mgr.create({ agent: 'codex', cwd: '/r' });
  assert.equal((await mgr.setAgentMode(t.id, 'swarm')).thread.agentMode, 'swarm');
  assert.equal(mgr.create({ agent: 'opencode', cwd: '/r', agentMode: 'swarm' }).agentMode, 'swarm');
  const g = mgr.create({ agent: 'antigravity', cwd: '/r' });
  await assert.rejects(mgr.setAgentMode(g.id, 'swarm'), /Claude, Codex or OpenCode/);
  assert.equal(mgr.get(g.id).agentMode, 'chat', 'unchanged');
});

test('leaving swarm for chat and deleting a thread stop its swarm workers; swarm → orchestrator keeps them', async () => {
  const { mgr, cleanups } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', agentMode: 'swarm' });
  await mgr.setAgentMode(t.id, 'orchestrator');
  assert.equal(cleanups.length, 0);
  await mgr.setAgentMode(t.id, 'swarm');
  await mgr.setAgentMode(t.id, 'chat');
  assert.deepEqual(cleanups, [{ orchestratorId: `chat:${t.id}`, opts: { kill: true } }]);
  await mgr.delete(t.id);
  assert.equal(cleanups.length, 2);
  assert.deepEqual(cleanups[1], { orchestratorId: `chat:${t.id}`, opts: { kill: true } });
});

test('sendTurn forwards origin and koraNotice; the system append follows the mode', async () => {
  const { mgr, driver, deps } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.sendTurn({ threadId: t.id, text: 'hi', koraNotice: '[kora] switched' });
  await mgr.sendTurn({ threadId: t.id, text: '[kora] notes', origin: 'kora-notice' });
  assert.equal(driver.turns[0].koraNotice, '[kora] switched');
  assert.equal(driver.turns[0].origin, undefined);
  assert.equal(driver.turns[1].origin, 'kora-notice');
  const d = deps();
  // A plain chat delegates too — through kora_spawn only — so it gets the short delegation rules (not the playbook).
  const chat = d.appendSystemPrompt({ threadId: 'x', agent: 'claude', cwd: '/r', account: null, agentMode: 'chat' });
  assert.match(chat ?? '', /the ONLY way is kora_spawn/);
  assert.doesNotMatch(chat ?? '', /DISCOVERY/);
  const orch = d.appendSystemPrompt({ threadId: 'x', agent: 'claude', cwd: '/r', account: null, agentMode: 'orchestrator', isOrchestrator: true });
  const swarm = d.appendSystemPrompt({ threadId: 'x', agent: 'claude', cwd: '/r', account: null, agentMode: 'swarm', isOrchestrator: true });
  assert.ok(orch && orch.length > 0);
  assert.ok(swarm && swarm.length > 0, 'swarm gets chatSwarmPrompt (or the orchestrator rules while it is a stub)');
  assert.equal(typeof (d as any).swarm?.spawn, 'function', 'the runtime swarm spawner reaches the driver');
});

// ── Blob (assistant) folder: always swarm, no notices, Codex allowed as leader ───────────────────────────────
function chatCwd(): string {
  // A blob's workspace is the assistant folder: <KORA_BLOBS_ROOT>/<slug>.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-blobsroot-'));
  process.env.KORA_BLOBS_ROOT = base;
  const cwd = path.join(base, 'popo');
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test('a blob thread is forced into swarm mode at create, with no mode notice', () => {
  const { mgr } = harness();
  const cwd = chatCwd();
  const t = mgr.create({ agent: 'claude', cwd });
  assert.equal(t.agentMode, 'swarm');
  assert.equal(t.isOrchestrator, true);
  assert.equal(mgr.takeModeNotice(t.id), null, 'a blob is swarm by design, never a switch the agent must hear about');
});

test('a Codex leader is allowed in a blob folder (R10 is a Code-surface rule)', () => {
  const { mgr } = harness();
  const cwd = chatCwd();
  assert.doesNotThrow(() => mgr.create({ agent: 'codex', cwd }));
  const t = mgr.create({ agent: 'codex', cwd });
  assert.equal(t.agentMode, 'swarm');
});

test('a blob thread is treated as swarm on start() even if its stored head predates the rule', async () => {
  const { mgr, driver } = harness();
  const cwd = chatCwd();
  // Simulate an old head: created before blob folders forced swarm at create (agentMode left at 'chat').
  const t = mgr.create({ agent: 'claude', cwd });
  mgr.store.update(t.id, { agentMode: 'chat', isOrchestrator: false });
  assert.equal(mgr.get(t.id).agentMode, 'chat', 'the stored head is stale');
  await mgr.start(t.id);
  assert.equal(driver.starts[0].agentMode, 'swarm', 'start() still treats it as swarm');
  assert.equal(driver.starts[0].isOrchestrator, true);
});

test('a blob folder never runs graph.ensureFresh (no repo to freshen)', async () => {
  const calls: string[] = [];
  const runtime: ManagerRuntime = {
    notify: () => {},
    graph: { callTool: async () => ({ text: '', data: null, ms: 0 }), ensureFresh: (cwd: string) => { calls.push(cwd); } },
    agentSpawn: async () => ({} as any),
  };
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, new ChatThreadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mode-'))), { driverFactory: () => driver });
  const cwd = chatCwd();
  const t = mgr.create({ agent: 'claude', cwd });
  await mgr.start(t.id);
  assert.deepEqual(calls, [], 'ensureFresh was never called for a blob cwd');
  const t2 = mgr.create({ agent: 'claude', cwd: '/some/repo' });
  await mgr.start(t2.id);
  assert.deepEqual(calls, ['/some/repo'], 'a plain repo thread still gets it');
});

// ── the worker picker (kora_ask_workers → popup → answer) ─────────────────────────────────────────
function pickerHarness() {
  const h = harness();
  const events: any[] = [];
  (h.mgr as any).runtime.notify = (_ch: string, e: any) => { if (e?.type) events.push(e); };
  const t = h.mgr.create({ agent: 'claude', cwd: '/r' });
  return { ...h, t, events };
}

test('worker picker: the request is an event; the answer resolves the lead with the user\'s picks', async () => {
  const { mgr, t, events } = pickerHarness();
  const pending = mgr.askWorkers(t.id, [{ title: 'a', agent: 'codex', model: 'gpt-5.5' }]);
  const req = events.find((e) => e.type === 'worker-picker.requested');
  assert.ok(req, 'worker-picker.requested emitted');
  assert.equal(mgr.get(t.id).state, 'waiting');
  await mgr.respondUserInput(t.id, req.requestId, { picks: [{ title: 'a', agent: 'claude', model: 'haiku', effort: 'HIGH' }] });
  const answer = await pending;
  assert.deepEqual(answer, { picks: [{ title: 'a', agent: 'claude', model: 'haiku', effort: 'high' }] });
  assert.ok(events.some((e) => e.type === 'worker-picker.resolved' && e.requestId === req.requestId));
});

test('worker picker: a dismiss is a decline; "don\'t ask again" approves later proposals at once', async () => {
  const { mgr, t, events } = pickerHarness();
  const p1 = mgr.askWorkers(t.id, [{ title: 'a', agent: 'codex' }]);
  await mgr.respondUserInput(t.id, events.at(-1).requestId, {});
  assert.deepEqual(await p1, { picks: [], cancelled: true });
  const p2 = mgr.askWorkers(t.id, [{ title: 'b', agent: 'codex' }]);
  await mgr.respondUserInput(t.id, events.filter((e) => e.type === 'worker-picker.requested').at(-1).requestId, { picks: [{ title: 'b', agent: 'codex' }], autoApprove: true });
  assert.equal((await p2).autoApprove, true);
  const n = events.length;
  const p3 = await mgr.askWorkers(t.id, [{ title: 'c', agent: 'claude' }]);
  assert.deepEqual(p3, { picks: [{ title: 'c', agent: 'claude' }], auto: true });
  assert.equal(events.filter((e, i) => i >= n && e.type === 'worker-picker.requested').length, 0, 'no popup');
  mgr.setAutoApproveWorkers(t.id, false);
  void mgr.askWorkers(t.id, [{ title: 'd', agent: 'claude' }]);
  assert.ok(events.slice(n).some((e) => e.type === 'worker-picker.requested'), 'asks again once turned back on');
});

test('worker picker: interrupting the lead closes an open picker as declined', async () => {
  const { mgr, t } = pickerHarness();
  const p = mgr.askWorkers(t.id, [{ title: 'a', agent: 'codex' }]);
  await mgr.interrupt(t.id);
  assert.deepEqual(await p, { picks: [], cancelled: true });
});

test("a lead's first turn after a restart carries the swarm restart digest once, after any mode notice", async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  const digests = new Map([[`chat:${t.id}`, '[kora] restart digest']]);
  (mgr as any).runtime.swarm.takeRestartDigest = (o: string) => { const d = digests.get(o) ?? null; digests.delete(o); return d; };
  await mgr.sendTurn({ threadId: t.id, text: 'continue', koraNotice: '[kora] switched' });
  await mgr.sendTurn({ threadId: t.id, text: 'next' });
  assert.equal(driver.turns[0].koraNotice, '[kora] switched\n\n[kora] restart digest');
  assert.equal(driver.turns[0].text, 'continue');
  assert.equal(driver.turns[1].koraNotice, undefined);
});

test('a restart digest whose turn failed to start is handed back for the next turn', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  const digests = new Map([[`chat:${t.id}`, '[kora] restart digest']]);
  (mgr as any).runtime.swarm.takeRestartDigest = (o: string) => { const d = digests.get(o) ?? null; digests.delete(o); return d; };
  (mgr as any).runtime.swarm.restoreRestartDigest = (o: string, d: string) => { digests.set(o, d); };
  const send = driver.sendTurn.bind(driver);
  driver.sendTurn = async () => { throw new Error('spawn failed'); };
  await assert.rejects(mgr.sendTurn({ threadId: t.id, text: 'continue' }), /spawn failed/);
  driver.sendTurn = send;
  await mgr.sendTurn({ threadId: t.id, text: 'again' });
  assert.equal(driver.turns.at(-1)!.koraNotice, '[kora] restart digest');
});

// ── a blob's Helpers switch + moving a thread under another folder (the Chat -> Kora migration) ──────────────────────
function blobHarness(helpers: boolean | undefined) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-blobsroot-'));
  process.env.KORA_BLOBS_ROOT = base;
  const ws = path.join(base, 'popo');
  fs.mkdirSync(ws, { recursive: true });
  const driver = new FakeDriver();
  const runtime: ManagerRuntime = {
    notify: () => {},
    graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) },
    agentSpawn: async () => ({} as any),
    blobs: {
      byCwd: (cwd: string) => (cwd.startsWith(ws) ? { id: 'blob_popo', permission: 'auto', ...(helpers === undefined ? {} : { helpers }) } : null),
      systemPrompt: () => 'blob prompt',
      turnContext: async () => '',
    } as any,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mode-'));
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver });
  return { mgr, driver, ws, base };
}

test('a blob thread is swarm either way; only a blob with Helpers switched off starts without fleet tools', async () => {
  for (const [helpers, off] of [[undefined, false], [true, false], [false, true]] as const) {
    const { mgr, driver, ws } = blobHarness(helpers);
    const t = mgr.create({ agent: 'claude', cwd: ws });
    assert.equal(t.agentMode, 'swarm', `helpers ${String(helpers)}`);
    mgr.store.update(t.id, { agentMode: 'chat', isOrchestrator: false }); // an old head that predates the rule
    await mgr.start(t.id);
    assert.equal(driver.starts[0].agentMode, 'swarm');
    assert.equal(driver.starts[0].isOrchestrator, true, 'Claude\'s own subagent tools stay disallowed either way');
    assert.equal(driver.starts[0].helpersOff === true, off, 'the driver wires kora_spawn / kora_map / kora_wait only when helpers are on');
    assert.equal(mgr.takeModeNotice(t.id), null);
  }
});

test('moveThread points a thread at a blob folder, drops its worktree, and copies the Claude transcript beside it', async () => {
  const { mgr, ws, base } = blobHarness(undefined);
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-claudecfg-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    const oldCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-oldchat-'));
    const t = mgr.create({ agent: 'claude', cwd: oldCwd });
    const session = '11111111-2222-3333-4444-555555555555';
    mgr.store.update(t.id, { resume: session });
    const src = path.join(claudeDir, 'projects', oldCwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, '{"type":"user"}\n');
    const r = await mgr.moveThread(t.id, ws);
    assert.equal(r.transcriptCopied, true);
    assert.equal(mgr.get(t.id).cwd, ws);
    const real = fs.realpathSync(ws);
    assert.ok(fs.existsSync(path.join(claudeDir, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)), 'the resumed conversation is found under the new folder');
    assert.ok(fs.existsSync(src), 'copy, never move');
    // idempotent, and a thread already there is a no-op
    assert.deepEqual(await mgr.moveThread(t.id, ws), { transcriptCopied: false });
    // a Codex thread has no Claude transcript to carry
    const c = mgr.create({ agent: 'codex', cwd: oldCwd });
    assert.equal((await mgr.moveThread(c.id, ws)).transcriptCopied, false);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; void base; }
});

test('plan mode: Claude gets the graph notice once per plan stretch; Codex (read-only sandbox, no route to the socket) never does', async () => {
  const { mgr, driver } = harness(undefined, true);
  const claude = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.sendTurn({ threadId: claude.id, text: 'plan the retry change', interactionMode: 'plan' });
  assert.match(driver.turns[0]!.koraNotice ?? '', /Plan mode\. This repo has a Kora code graph/);
  await mgr.sendTurn({ threadId: claude.id, text: 'and the tests', interactionMode: 'plan' });
  assert.doesNotMatch(driver.turns[1]!.koraNotice ?? '', /Plan mode/, 'once per stretch');
  const codex = mgr.create({ agent: 'codex', cwd: '/r' });
  await mgr.sendTurn({ threadId: codex.id, text: 'plan the retry change', interactionMode: 'plan' });
  assert.doesNotMatch(driver.turns[2]!.koraNotice ?? '', /kora graph/);
});

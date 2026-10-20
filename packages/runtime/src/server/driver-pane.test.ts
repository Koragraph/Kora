// DriverPane + WorkerFeed (docs/fleet/WORKER-BOXES.md): a worker on a chat SessionDriver, driven by a fake host.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent } from '../session/events';
import { ERROR_STALL_MAX_RETRIES } from './error-stall';
import { DriverPane, DRIVER_RETRY_DELAYS_MS, DRIVER_RATE_LIMIT_DELAYS_MS, DRIVER_STREAM_STALL_MS, DRIVER_STREAM_STALL_BLIND_MS, type WorkerDriverHost } from './driver-pane';
import { WorkerFeed, applyChatEvent, newFeedMapState, FEED_MAX } from './worker-feed';

class FakeHost implements WorkerDriverHost {
  sent: { text: string; origin: string }[] = [];
  interrupts = 0; disposed: string[] = []; answers: unknown[] = []; approvals: unknown[] = [];
  private cb: ((e: ChatEvent) => void) | null = null;
  private seq = 0;
  supports() { return true; }
  async start(_p?: unknown) { return 'th1'; }
  async send(_t: string, text: string, origin: 'user' | 'kora-notice') { this.sent.push({ text, origin }); }
  async interrupt() { this.interrupts++; }
  async respondApproval(_t: string, requestId: string, decision: string) { this.approvals.push({ requestId, decision }); }
  async respondUserInput(_t: string, _r: string, answers: unknown) { this.answers.push(answers); }
  async dispose(t: string) { this.disposed.push(t); }
  subscribe(_t: string, cb: (e: ChatEvent) => void) { this.cb = cb; return () => { this.cb = null; }; }
  emit(e: Record<string, unknown>) { this.cb?.({ threadId: 'th1', seq: ++this.seq, at: Date.now(), ...e } as ChatEvent); }
}

function makePane(host: FakeHost) {
  return new DriverPane({ id: 'p1', workspaceId: 'w', name: 'Worker', command: '', args: [], cwd: '/tmp', agent: 'claude', env: {}, cols: 80, rows: 24, host, model: 'sonnet', runtimeMode: 'full-access' });
}
const tick = () => new Promise((r) => setImmediate(r));

test('a turn streams into the feed, the screen and the report', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  assert.equal(p.threadId, 'th1');
  await p.steerSink!('fix the bug', 'leader', 'queue');
  assert.deepEqual(host.sent, [{ text: 'fix the bug', origin: 'user' }]);
  assert.equal(p.state, 'working');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'tool.started', turnId: 'T1', itemId: 'i1', toolKind: 'file_change', toolName: 'Edit', title: 'Edit', input: { file_path: 'src/a.ts' } });
  host.emit({ type: 'tool.result', turnId: 'T1', itemId: 'i1', status: 'completed', changedFiles: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] });
  host.emit({ type: 'content.delta', turnId: 'T1', itemId: 'm1', stream: 'assistant_text', delta: 'Done, ' });
  host.emit({ type: 'content.delta', turnId: 'T1', itemId: 'm1', stream: 'assistant_text', delta: 'fixed it.' });
  host.emit({ type: 'thread.token-usage', usage: { costUsd: 0.12, usedTokens: 50_000, maxTokens: 200_000 } });
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'completed' });
  assert.equal(p.state, 'idle');
  assert.equal(p.report(), 'Done, fixed it.');
  const items = p.feed.snapshot();
  assert.deepEqual(items.map((i) => i.kind), ['user', 'tool', 'assistant']);
  const tool = items[1] as any;
  assert.equal(tool.tool, 'Edited'); assert.equal(tool.title, 'src/a.ts'); assert.equal(tool.added, 3); assert.equal(tool.removed, 1);
  assert.equal((items[2] as any).streaming, false);
  const info = p.info();
  assert.equal(info.surface, 'gui'); assert.equal(info.costUsd, 0.12); assert.equal(info.contextPct, 25); assert.equal(info.model, 'sonnet');
  await new Promise((r) => setTimeout(r, 20)); // xterm-headless parses writes asynchronously
  const text = p.read('scrollback');
  assert.match(text, /fix the bug/); assert.match(text, /Done, fixed it\./);
  p.dispose();
});

test('a transient failure is retried while the worker stays working; a hard one stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('go', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'API Error: 529 Overloaded' });
  assert.equal(p.state, 'working', 'a retry is pending: never read as done');
  assert.equal(p.info().retrying?.attempt, 1);
  t.mock.timers.tick(DRIVER_RETRY_DELAYS_MS[0]);
  await tick();
  assert.deepEqual(host.sent.at(-1), { text: 'continue', origin: 'kora-notice' });
  host.emit({ type: 'turn.started', turnId: 'T2' });
  assert.equal(p.info().retrying, null);
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'failed', errorMessage: 'invalid api key' });
  assert.equal(p.state, 'idle');
  assert.ok(p.info().errorStall && !p.info().errorStall!.retrying);
  assert.ok(p.feed.snapshot().some((i) => i.kind === 'error' && /invalid api key/.test(i.text)));
  assert.match(p.report(), /FAILED: invalid api key/);
  host.emit({ type: 'runtime.error', message: 'usage limit hit' });
  host.emit({ type: 'turn.settled', turnId: 'T9', state: 'failed', errorMessage: 'usage limit hit' });
  assert.equal(p.feed.snapshot().filter((i) => i.kind === 'error' && i.text === 'usage limit hit').length, 1, 'one card per failure');
  host.emit({ type: 'turn.started', turnId: 'T4' });
  host.emit({ type: 'content.delta', turnId: 'T4', itemId: 'm', stream: 'assistant_text', delta: 'ok now' });
  host.emit({ type: 'turn.settled', turnId: 'T4', state: 'completed' });
  assert.equal(p.report(), 'ok now', 'a good turn clears the failure');
  p.dispose();
});

test('approvals block the worker; questions are answered with "decide yourself"', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('go', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'approval.opened', turnId: 'T1', requestId: 'r1', requestKind: 'command_execution_approval', title: 'Run rm -rf build' });
  assert.equal(p.state, 'blocked');
  assert.deepEqual(p.info().pendingApproval, { requestId: 'r1', title: 'Run rm -rf build' });
  await p.respondApproval('r1', 'accept');
  assert.deepEqual(host.approvals, [{ requestId: 'r1', decision: 'accept' }]);
  host.emit({ type: 'approval.resolved', turnId: 'T1', requestId: 'r1', decision: 'accept' });
  assert.equal(p.state, 'working');
  assert.equal(p.info().pendingApproval, null);
  host.emit({ type: 'user-input.requested', turnId: 'T1', requestId: 'q1', questions: [{ id: 'a', header: 'H', question: 'Which db?', options: [] }] });
  await tick();
  assert.match(String((host.answers[0] as any)['Which db?']), /Decide yourself/);
  p.dispose();
});

test('a human steer mid-turn interrupts and is sent next; a lead note waits for the turn', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await p.steerSink!('also add tests', 'leader', 'queue');
  await p.steerSink!('stop, use sqlite', 'human', 'steer');
  assert.equal(host.interrupts, 1);
  assert.equal(host.sent.length, 1);
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
  assert.equal(host.sent.at(-1)!.text, 'stop, use sqlite');
  host.emit({ type: 'turn.started', turnId: 'T2' });
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'completed' });
  assert.equal(host.sent.at(-1)!.text, 'also add tests');
  p.kill(); await tick();
  assert.ok(p.exited); assert.deepEqual(host.disposed, ['th1']);
  await assert.rejects(p.steerSink!('x', 'leader', 'queue'));
  p.dispose();
});

test('the feed is capped and keeps ids addressable after trimming', () => {
  const f = new WorkerFeed(); const st = newFeedMapState();
  for (let n = 0; n < FEED_MAX + 20; n++) f.notice(`n${n}`);
  assert.equal(f.size, FEED_MAX);
  applyChatEvent(f, st, { threadId: 't', seq: 1, at: 1, type: 'tool.started', itemId: 'x', toolKind: 'command_execution', toolName: 'Bash', title: 'Bash', input: { command: 'pnpm test\nmore' } } as ChatEvent);
  applyChatEvent(f, st, { threadId: 't', seq: 2, at: 2, type: 'tool.result', itemId: 'x', status: 'failed', output: '1 failing', outputStream: 'command_output' } as ChatEvent);
  const t = f.get('t-x') as any;
  assert.equal(t.title, 'pnpm test'); assert.equal(t.status, 'failed'); assert.equal(t.detail, '1 failing');
  assert.equal(f.lastAction(), 'Bash pnpm test');
});

test('Runtime: a lead worker on a supported engine becomes a GUI DriverPane end to end (spawn, prompt, steer, report, kill)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { Runtime } = await import('./workspace');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-dp-')));
  const rt = new Runtime(path.join(dir, 's.sock'));
  const host = new FakeHost();
  const started: unknown[] = [];
  host.start = async (p: unknown) => { started.push(p); return 'th1'; };
  rt.setDriverHost(host);
  const feed: unknown[] = [];
  rt.on('notify', (m: string, p: any) => { if (m === 'pane.feed') feed.push(p.item); });
  try {
    const info = await rt.agentSpawn({ agent: 'claude', cwd: dir, prompt: 'write hello.txt', orchestratorId: 'chat:T', name: 'Hello', args: ['--model', 'claude-sonnet-5-5', '--effort', 'low', '--dangerously-skip-permissions'] } as any);
    assert.equal(info.surface, 'gui');
    assert.equal(info.role, 'worker');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual((started[0] as any).model, 'claude-sonnet-5-5');
    assert.equal((started[0] as any).effort, 'low');
    assert.equal((started[0] as any).runtimeMode, 'full-access');
    assert.deepEqual(host.sent[0], { text: 'write hello.txt', origin: 'user' });
    host.emit({ type: 'turn.started', turnId: 'T1' });
    await rt.humanSteer(info.id, 'call it hi.txt');
    assert.equal(host.interrupts, 1);
    host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
    assert.equal(host.sent.at(-1)!.text, 'call it hi.txt');
    host.emit({ type: 'turn.started', turnId: 'T2' });
    host.emit({ type: 'content.delta', turnId: 'T2', itemId: 'm', stream: 'assistant_text', delta: 'Wrote hi.txt.' });
    host.emit({ type: 'turn.settled', turnId: 'T2', state: 'completed' });
    assert.equal(rt.report(info.id), 'Wrote hi.txt.');
    assert.ok((rt.workerFeed(info.id) ?? []).length >= 3);
    assert.ok(feed.length >= 3, 'feed items reach notify subscribers');
    assert.equal(rt.panes.get(info.id)!.state, 'idle');
    // Never restored from state.json: the pane is the thread's, not an argv to re-run.
    assert.ok(rt.snapshotState().workspaces.every((w) => w.panes.every((p) => p.id !== info.id)));
    rt.killPane(info.id);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(host.disposed, ['th1']);
  } finally { rt.shutdown(); }
});

test('KORA_GUI_WORKERS=off or an unsupported engine keeps the PTY worker', async () => {
  const { guiWorkersOn, modelFromArgs, runtimeModeFromArgs } = await import('./workspace');
  const prev = process.env.KORA_GUI_WORKERS;
  process.env.KORA_GUI_WORKERS = 'off'; assert.equal(guiWorkersOn(), false);
  if (prev === undefined) delete process.env.KORA_GUI_WORKERS; else process.env.KORA_GUI_WORKERS = prev;
  assert.deepEqual(modelFromArgs(['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="high"']), { model: 'gpt-5.6-luna', effort: 'high' });
  assert.equal(runtimeModeFromArgs(['--dangerously-bypass-approvals-and-sandbox'], false), 'full-access');
  assert.equal(runtimeModeFromArgs([], false), 'approval-required');
});

test('a swarm worker becomes a GUI box from its plugin feed (pane.feed); malformed steps are dropped', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { Runtime } = await import('./workspace');
  const { pluginFeedItem } = await import('./worker-feed');
  assert.equal(pluginFeedItem(null), null);
  assert.equal(pluginFeedItem({ k: 'tool' }), null, 'no id');
  assert.equal(pluginFeedItem({ k: 'nope', id: 'x' }), null);
  assert.deepEqual(pick(pluginFeedItem({ k: 'tool', id: 'c2', tool: 'edit', title: '/a.ts\nmore', added: 3, removed: 1, failed: false })), { id: 'oc-t-c2', kind: 'tool', tool: 'Edited', title: '/a.ts', status: 'done', added: 3, removed: 1 });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-dp-')));
  const rt = new Runtime(path.join(dir, 's.sock'));
  const notes: [string, any][] = [];
  rt.on('notify', (m: string, p: any) => notes.push([m, p]));
  try {
    const info = await rt.agentSpawn({ agent: 'opencode', cwd: dir, command: '/bin/cat', prompt: 'fix the bug', orchestratorId: 'chat:T' } as any);
    assert.notEqual(info.surface, 'gui');
    assert.equal(rt.workerFeed(info.id), null);
    rt.pushPluginFeed(info.id, [{ k: 'tool', id: 'c1', tool: 'bash', title: 'ls' }, 'junk', { k: 'text', id: 'p1', text: 'Fixed it.' }]);
    const feed = rt.workerFeed(info.id)!;
    assert.deepEqual(feed.map((i) => i.kind), ['user', 'tool', 'assistant']);
    assert.equal((feed[0] as any).text, 'fix the bug');
    assert.equal(rt.panes.get(info.id)!.info().surface, 'gui');
    assert.ok(notes.some(([m, p]) => m === 'pane.updated' && p.id === info.id && p.surface === 'gui'));
    assert.equal(notes.filter(([m]) => m === 'pane.feed').length, 3);
    rt.pushPluginFeed(info.id, [{ k: 'text', id: 'p1', text: 'Fixed it, tests pass.' }]);
    assert.equal(rt.workerFeed(info.id)!.length, 3, 'same id upserts');
    rt.killPane(info.id);
  } finally { rt.shutdown(); }
});

function pick(i: any) { const { at: _at, detail: _d, ...rest } = i ?? {}; return rest; }

test('Koragent events map to feed items; a tool end keeps its start', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { Runtime } = await import('./workspace');
  const { koragentFeedItems } = await import('./worker-feed');
  const { setEditionForTests } = await import('../edition');
  setEditionForTests('pro'); t.after(() => setEditionForTests('free'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-dp-')));
  const rt = new Runtime(path.join(dir, 's.sock'));
  try {
    const info = await rt.agentSpawn({ agent: 'koragent', cwd: dir, command: '/bin/cat', orchestratorId: 'chat:T' } as any);
    const push = (e: any) => rt.pushWorkerFeed(info.id, koragentFeedItems(e));
    push({ type: 'tool.start', callID: 'c', tool: 'bash', title: 'pnpm test', ts: 1 });
    push({ type: 'tool.end', callID: 'c', status: 'error', ms: 5, exitCode: 1, ts: 2 });
    push({ type: 'route.failover', from: 'a', to: 'b', reason: '429', ts: 3 });
    push({ type: 'task.report', report: { summary: 'Fixed the bug.' }, ts: 4 });
    push({ type: 'budget.update', usd: 0, steps: 1, tokens: {} });
    const f = rt.workerFeed(info.id)!;
    assert.deepEqual(f.map((i) => i.kind), ['tool', 'notice', 'assistant']);
    assert.deepEqual([(f[0] as any).tool, (f[0] as any).title, (f[0] as any).status, (f[0] as any).detail], ['Bash', 'pnpm test', 'failed', 'exit 1']);
    rt.killPane(info.id);
  } finally { rt.shutdown(); }
});

test('text before and after a tool call are two bubbles even with one engine item id; the report is the last', () => {
  const f = new WorkerFeed(); const st = newFeedMapState();
  const ev = (e: any) => applyChatEvent(f, st, { at: 1, threadId: 'x', ...e } as ChatEvent);
  ev({ type: 'turn.started', turnId: 'T' });
  ev({ type: 'content.delta', turnId: 'T', itemId: 'm', stream: 'assistant_text', delta: 'Looking.' });
  ev({ type: 'tool.started', turnId: 'T', itemId: 'k', toolKind: 'file_read', toolName: 'Read', title: 'a.js', input: {} });
  ev({ type: 'tool.result', turnId: 'T', itemId: 'k', status: 'completed' });
  ev({ type: 'content.delta', turnId: 'T', itemId: 'm', stream: 'assistant_text', delta: 'Fixed it.' });
  ev({ type: 'turn.settled', turnId: 'T', state: 'completed' });
  assert.deepEqual(f.snapshot().filter((i) => i.kind === 'assistant').map((i: any) => i.text), ['Looking.', 'Fixed it.']);
  assert.equal(f.lastAssistantText(), 'Fixed it.');
});

test('a silent turn (dead stream) is interrupted and continued; a long tool call or an open approval is not', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.stallAfterMs = 30;
  p.spawn(); await tick();
  await p.steerSink!('build it', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  // A tool is running: silence is the tool, not a dead stream.
  host.emit({ type: 'tool.started', turnId: 'T1', itemId: 'b1', toolKind: 'command', toolName: 'Bash', title: 'pnpm build' });
  assert.equal(p.toolRunning, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(host.interrupts, 0);
  host.emit({ type: 'tool.result', turnId: 'T1', itemId: 'b1', status: 'completed' });
  assert.equal(p.toolRunning, false);
  // Then nothing: the watchdog stops the turn, the worker stays working and shows the retry.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(host.interrupts, 1);
  assert.equal(p.state, 'working');
  assert.equal(p.info().retrying?.attempt, 1);
  // The interrupt settles; Kora sends "continue" after the first back-off.
  const sentBefore = host.sent.length;
  (p as any).stallAfterMs = 10_000;
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
  assert.equal(p.state, 'working');
  assert.match(String(p.info().retrying?.message), /No response from the engine/);
  (p as any).cancelRetry(); // skip the 4 s back-off: send what the timer would
  await (p as any).sendNow('continue', 'kora-notice');
  assert.deepEqual(host.sent.slice(sentBefore), [{ text: 'continue', origin: 'kora-notice' }]);
  p.dispose();
});

test('the stall watchdog leaves a worker waiting on an approval alone', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.stallAfterMs = 30;
  p.spawn(); await tick();
  await p.steerSink!('deploy', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'approval.opened', turnId: 'T1', requestId: 'r1', title: 'Run deploy', toolName: 'Bash' });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(host.interrupts, 0);
  assert.equal(p.state, 'blocked');
  p.dispose();
});

test('a short rate limit is retried after the long back-off; a plan limit stops the worker', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('research', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  const before = Date.now();
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'Rate limit reached for requests per minute. Try again in 20s.' });
  assert.equal(p.state, 'working');
  const r = p.info().retrying!;
  assert.equal(r.attempt, 1);
  assert.ok(r.nextAt! - before >= DRIVER_RATE_LIMIT_DELAYS_MS[0] - 50);
  (p as any).cancelRetry();
  await (p as any).sendNow('continue', 'kora-notice');
  host.emit({ type: 'turn.started', turnId: 'T2' });
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'failed', errorMessage: "You've hit your usage limit. Upgrade to Plus." });
  assert.equal(p.state, 'idle');
  assert.equal(p.info().retrying, null);
  assert.match(p.report(), /FAILED: You've hit your usage limit/);
  p.dispose();
});

test('watchdog edges: a steady stream never trips it; spent retries leave it to the lead; a human steer mid-recovery goes first', async () => {
  // 1. Events every 10 ms re-arm it: no interrupt however long the turn runs.
  {
    const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 40;
    p.spawn(); await tick();
    await p.steerSink!('long task', 'leader', 'queue');
    host.emit({ type: 'turn.started', turnId: 'T1' });
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 10)); host.emit({ type: 'content.delta', turnId: 'T1', itemId: 'm', stream: 'assistant_text', delta: '.' }); }
    assert.equal(host.interrupts, 0);
    p.dispose();
  }
  // 2. Retries already spent: the watchdog does not interrupt (the fleet's stall note tells the lead instead).
  {
    const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20;
    p.spawn(); await tick();
    await p.steerSink!('task', 'leader', 'queue');
    (p as any).retries = ERROR_STALL_MAX_RETRIES; // spent within this task (a new lead instruction restores them)
    host.emit({ type: 'turn.started', turnId: 'T1' });
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(host.interrupts, 0);
    assert.equal(p.state, 'working');
    p.dispose();
  }
  // 3. The human steers while Kora is recovering: their text is sent, not "continue".
  {
    const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20;
    p.spawn(); await tick();
    await p.steerSink!('task', 'leader', 'queue');
    host.emit({ type: 'turn.started', turnId: 'T1' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(host.interrupts, 1);
    await p.steerSink!('try the other approach', 'human', 'steer');
    host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
    await tick();
    assert.deepEqual(host.sent.map((s) => s.text), ['task', 'try the other approach']);
    assert.equal(p.info().retrying, null);
    p.dispose();
  }
});

test('watchdog edges: a worker killed mid-recovery sends nothing afterwards', async () => {
  const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(host.interrupts, 1);
  p.kill();
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(host.sent.map((s) => s.text), ['task']);
  assert.equal(p.exited, true);
});

test('the last turn end lives on the pane (survives a ui-server restart); a new turn clears it and any old error', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('one', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'API Error: 400 invalid_request' });
  assert.equal(p.info().errorStall?.line, 'API Error: 400 invalid_request');
  assert.equal(p.info().turnEndedAt, null, 'a failed turn is not a finished one');
  await p.steerSink!('two', 'human', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T2' });
  assert.equal(p.info().errorStall, null, 'the new turn clears the old error');
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'completed' });
  assert.equal(typeof p.info().turnEndedAt, 'number');
  await p.steerSink!('three', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T9' });
  assert.equal(p.info().turnEndedAt, null);
  p.dispose();
});

// ── audit 2026-10-15 (docs/qa/AUDIT-2026-10-15/3-bugs-fleet.md) ──

test('a stall interrupt that never settles gives up after a deadline: no retry pill, the fleet stall note can fire (#2)', async () => {
  const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20; p.recoverAfterMs = 30;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(host.interrupts, 1);
  assert.ok(p.info().retrying, 'recovering');
  const quiet = p.lastOutputAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(p.info().retrying, null, 'the retry pill is gone, so the fleet sweep no longer skips it');
  assert.equal(p.lastOutputAt, quiet, 'the give-up card does not restart the "no output" clock');
  assert.ok(p.feed.snapshot().some((i) => i.kind === 'error' && /did not stop when asked/.test(i.text)));
  assert.equal(host.interrupts, 1, 'no second recovery: the watchdog stands down');
  p.dispose();
});

test('a human steer mid-recovery clears the recovery so its turn is not treated as the stall continue (#2)', async () => {
  const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20; p.recoverAfterMs = 10_000;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 35));
  await p.steerSink!('do X instead', 'human', 'steer');
  assert.equal((p as any).stallRecovering, false);
  assert.equal((p as any).recoverTimer, null);
  p.dispose();
});

test('a recovered stall whose turn completes clears the retry pill (#5)', async () => {
  const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 35));
  assert.ok(p.info().retrying);
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'completed' });
  assert.equal(p.info().retrying, null);
  assert.equal(p.state, 'idle');
  p.dispose();
});

test('a stalled turn that settles on a usage limit stops at once instead of three futile continues (#6)', async () => {
  const host = new FakeHost(); const p = makePane(host); p.stallAfterMs = 20;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 35));
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: "You've hit your usage limit" });
  assert.equal(p.state, 'idle');
  assert.equal(p.info().retrying, null);
  assert.match(p.report(), /FAILED: You've hit your usage limit/);
  // A retryable failure while recovering is still continued.
  const host2 = new FakeHost(); const p2 = makePane(host2); p2.stallAfterMs = 20;
  p2.spawn(); await tick();
  await p2.steerSink!('task', 'leader', 'queue');
  host2.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 35));
  host2.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'socket hang up' });
  assert.equal(p2.state, 'working');
  assert.match(String(p2.info().retrying?.message), /No response from the engine/);
  p.dispose(); p2.dispose();
});

test('an interrupt still in flight cannot cancel the queued steer that replaced it (#7)', async () => {
  const host = new FakeHost();
  let release!: () => void; const asked: unknown[] = [];
  host.interrupt = async (...a: unknown[]) => { host.interrupts++; asked.push(a[1]); await new Promise<void>((r) => { release = r; }); };
  const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  const steering = p.steerSink!('use sqlite', 'human', 'steer');
  await tick();
  assert.deepEqual(asked, ['T1'], 'the interrupt names the turn it is for');
  // The turn completes on its own before the engine handles the interrupt: the steer must wait for it.
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'completed' });
  assert.equal(host.sent.length, 1, 'not sent while the interrupt could still land on its new turn');
  assert.equal(p.state, 'working', 'no Done flash in between');
  // A lead note arriving meanwhile queues behind it rather than racing the interrupt.
  await p.steerSink!('also docs', 'leader', 'queue');
  assert.equal(host.sent.length, 1);
  // The late interrupt re-settles the old turn (Claude does) — dropped — then the steer goes out.
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
  release(); await steering; await tick();
  assert.deepEqual(host.sent.map((s) => s.text), ['task', 'use sqlite']);
  host.emit({ type: 'turn.started', turnId: 'T2' });
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'completed' });
  assert.deepEqual(host.sent.map((s) => s.text), ['task', 'use sqlite', 'also docs']);
  p.dispose();
});

test('an engine that reuses one turn id still settles every turn', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  for (const t of ['a', 'b']) {
    await p.steerSink!(t, 'leader', 'queue');
    host.emit({ type: 'turn.started', turnId: 'turn' });
    host.emit({ type: 'turn.settled', turnId: 'turn', state: 'completed' });
    assert.equal(p.state, 'idle');
  }
  p.dispose();
});

test('a new lead instruction clears an old failure and restores the retries (#8)', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'invalid api key' });
  (p as any).retries = 3;
  assert.ok(p.info().errorStall);
  await p.steerSink!('next task', 'leader', 'queue');
  assert.equal(p.info().errorStall, null);
  assert.equal((p as any).retries, 0);
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'interrupted' });
  assert.doesNotMatch(p.report(), /FAILED/, 'the old error is not reported against the new task');
  p.dispose();
});

test('a first turn that fails without turn.started clears promptPending (#9)', async () => {
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  p.promptPending = true;
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'failed', errorMessage: 'not logged in' });
  assert.equal(p.promptPending, false);
  assert.equal(p.state, 'idle');
  p.dispose();
});

test('an interrupt the engine never answers gives up after the deadline; later prompts are not queued forever', async () => {
  const host = new FakeHost();
  host.interrupt = async () => { host.interrupts++; await new Promise<void>(() => {}); };
  const p = makePane(host); p.recoverAfterMs = 30;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await p.steerSink!('stop, use sqlite', 'human', 'steer'); // resolves once the deadline passes
  assert.equal(host.interrupts, 1);
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'interrupted' });
  assert.equal(host.sent.at(-1)!.text, 'stop, use sqlite');
  host.emit({ type: 'turn.started', turnId: 'T2' });
  host.emit({ type: 'turn.settled', turnId: 'T2', state: 'completed' });
  await p.steerSink!('next', 'leader', 'queue');
  assert.equal(host.sent.at(-1)!.text, 'next', 'sent at once, not parked behind the dead interrupt');
  p.dispose();
});

test('a stall interrupt that never settles releases the queue: a prompt that arrived meanwhile is sent', async () => {
  const host = new FakeHost();
  host.interrupt = async () => { host.interrupts++; await new Promise<void>(() => {}); };
  const p = makePane(host); p.stallAfterMs = 20; p.recoverAfterMs = 40;
  p.spawn(); await tick();
  await p.steerSink!('task', 'leader', 'queue');
  host.emit({ type: 'turn.started', turnId: 'T1' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host.interrupts, 1);
  // The turn ends by itself while the interrupt hangs; a lead note arrives — both wait on the interrupt…
  host.emit({ type: 'turn.settled', turnId: 'T1', state: 'completed' });
  await p.steerSink!('note', 'leader', 'queue');
  assert.equal(host.sent.length, 1);
  // …until it is given up on.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(host.sent.at(-1)!.text, 'note');
  p.dispose();
});

test('an engine that cannot report a tool start gets the long watchdog (capability, not a name)', () => {
  const blind = new FakeHost(); (blind as WorkerDriverHost).reportsToolStart = () => false;
  assert.equal(makePane(blind).stallAfterMs, DRIVER_STREAM_STALL_BLIND_MS);
  const seeing = new FakeHost(); (seeing as WorkerDriverHost).reportsToolStart = () => true;
  assert.equal(makePane(seeing).stallAfterMs, DRIVER_STREAM_STALL_MS);
  assert.equal(makePane(new FakeHost()).stallAfterMs, DRIVER_STREAM_STALL_MS);
  assert.ok(DRIVER_STREAM_STALL_BLIND_MS >= 6 * DRIVER_STREAM_STALL_MS);
});

test('six transient failures in a row are retried, the seventh stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = new FakeHost(); const p = makePane(host);
  p.spawn(); await tick();
  await p.steerSink!('go', 'leader', 'queue');
  for (let i = 1; i <= ERROR_STALL_MAX_RETRIES; i++) {
    host.emit({ type: 'turn.started', turnId: `T${i}` });
    host.emit({ type: 'tool.started', turnId: `T${i}`, itemId: `x${i}` } as any); host.emit({ type: 'tool.result', turnId: `T${i}`, itemId: `x${i}`, status: 'completed' } as any); // progress, then the same failure
    host.emit({ type: 'turn.settled', turnId: `T${i}`, state: 'failed', errorMessage: 'Antigravity stopped: The stream was interrupted.' });
    assert.equal(p.info().retrying?.attempt, i, `retry ${i} scheduled`);
    t.mock.timers.tick(DRIVER_RETRY_DELAYS_MS[i - 1]); await tick();
  }
  host.emit({ type: 'turn.started', turnId: 'T7' });
  host.emit({ type: 'turn.settled', turnId: 'T7', state: 'failed', errorMessage: 'Antigravity stopped: The stream was interrupted.' });
  assert.equal(p.info().retrying, null, 'retries spent');
  assert.ok(p.info().errorStall && !p.info().errorStall!.retrying);
});

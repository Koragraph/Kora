// ACP driver against a scripted fixture agent (fixtures/fake-acp-agent.cjs): handshake, streaming, permission mapping, fs/terminal
// confinement, process reuse, session/load + the one-replacement rule, idle close, contract change, crash recovery, MCP wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpDriver, acpActionClass, acpContentText, acpPlan, acpToolKind, acpTurnUsage, discoverAcpModels, pickPermissionOption, type AcpEngine } from './acp-driver';
import { AcpPool } from './acp-pool';
import type { ChatEvent, RuntimeMode } from '../events';
import type { DriverDeps, SessionStartInput } from '../session-driver';

const FIXTURE = [path.join(__dirname, 'fixtures', 'fake-acp-agent.cjs'), path.resolve(__dirname, '../../../src/session/drivers/fixtures/fake-acp-agent.cjs')].find((p) => fs.existsSync(p))!;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-t-')));
const waitFor = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + f.toString()); await new Promise((r) => setTimeout(r, 10)); } };

function rig(o: { env?: Record<string, string>; idleMs?: number; deps?: Partial<DriverDeps>; mode?: RuntimeMode; cwd?: string; driverOpts?: Partial<ConstructorParameters<typeof AcpDriver>[2]> } = {}) {
  const cwd = o.cwd ?? tmp();
  const logFile = path.join(tmp(), 'fake.log');
  const engine: AcpEngine = { agentId: 'gemini', label: 'Fake ACP', command: 'node', args: [FIXTURE], env: { FAKE_LOG: logFile, ...(o.env ?? {}) } };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => 'PERSONA', ...(o.deps ?? {}) } as unknown as DriverDeps;
  const driver = new AcpDriver(deps, engine, { resolveBinary: () => process.execPath, idleMs: o.idleMs ?? 60_000, ...(o.driverOpts ?? {}) });
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  const auto: { decision: 'accept' | 'decline' | 'acceptForSession' | null } = { decision: 'accept' };
  driver.streamEvents((e) => { if (e.type === 'approval.opened' && auto.decision) void driver.respondToApproval(e.threadId, e.requestId, auto.decision); });
  const input = (over: Partial<SessionStartInput> = {}): SessionStartInput => ({ threadId: 't1', agent: 'gemini', cwd, account: null, runtimeMode: o.mode ?? 'auto', ...over });
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as any[];
  const turn = async (text: string, threadId = 't1') => {
    const from = events.length;
    const h = await driver.sendTurn({ threadId, text });
    await waitFor(() => events.slice(from).some((e) => e.type === 'turn.settled' && e.turnId === h.turnId));
    return events.slice(from);
  };
  const text = (evs: ChatEvent[]) => evs.filter((e) => e.type === 'content.delta' && e.stream === 'assistant_text').map((e: any) => e.delta).join('');
  return { cwd, driver, events, input, log, turn, text, auto, done: () => driver.shutdown() };
}
const types = (evs: ChatEvent[]) => evs.map((e) => e.type);

test('handshake once, prompt streaming -> content / reasoning / plan / usage events, persona prepended', async () => {
  const r = rig();
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.deepEqual(types(evs).filter((t) => t !== 'session.state'), ['turn.started', 'thread.started', 'content.delta', 'turn.plan', 'content.delta', 'content.delta', 'thread.token-usage', 'turn.settled']);
  assert.match(r.text(evs), /^Hello from sess-/);
  const settled = evs.find((e) => e.type === 'turn.settled') as any;
  assert.equal(settled.state, 'completed'); assert.equal(settled.stopReason, 'end_turn');
  assert.deepEqual((evs.find((e) => e.type === 'turn.plan') as any).plan, [{ step: 'greet', status: 'inProgress' }]);
  assert.equal((evs.find((e) => e.type === 'thread.token-usage') as any).usage.usedTokens, 120);
  assert.equal((evs.find((e) => e.type === 'content.delta' && (e as any).stream === 'reasoning_text') as any).delta, 'thinking');
  const prompt = r.log().find((l) => l.method === 'session/prompt');
  assert.match(prompt.params.prompt[0].text, /^<system-instructions>\nPERSONA\n<\/system-instructions>\n\n.*\n\nhello$/s);
  const init = r.log().find((l) => l.method === 'initialize');
  assert.equal(init.params.protocolVersion, 1); assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  await r.done();
});

test('one process serves every turn: a single initialize + session/new, persona sent once', async () => {
  const r = rig();
  await r.driver.startSession(r.input());
  await r.turn('hello'); await r.turn('hello'); await r.turn('hello');
  const methods = r.log().map((l) => l.method);
  assert.equal(methods.filter((m) => m === 'initialize').length, 1);
  assert.equal(methods.filter((m) => m === 'session/new').length, 1);
  assert.equal(methods.filter((m) => m === 'session/prompt').length, 3);
  assert.equal(r.driver.pool.stats.spawned, 1); assert.equal(r.driver.pool.stats.reused, 2);
  assert.equal(r.log().filter((l) => l.method === 'session/prompt' && /PERSONA/.test(l.params.prompt[0].text)).length, 1);
  await r.done();
});

test('permissions: Supervised asks and maps Allow/Deny to allow_once/reject_once; Auto inside the folder does not ask', async () => {
  const r = rig({ mode: 'approval-required' });
  await r.driver.startSession(r.input());
  const f = path.join(r.cwd, 'a.txt');
  let evs = await r.turn(`edit ${f}`);
  const opened = evs.find((e) => e.type === 'approval.opened') as any;
  assert.equal(opened.requestKind, 'file_change_approval'); assert.equal(fs.readFileSync(f, 'utf8'), 'edited\n');
  assert.deepEqual(r.log().filter((l) => l.permissionOutcome).map((l) => l.permissionOutcome), [{ outcome: 'selected', optionId: 'a1' }]);
  fs.unlinkSync(f);
  r.auto.decision = 'decline';
  evs = await r.turn(`edit ${f}`);
  assert.equal(fs.existsSync(f), false); assert.equal(r.text(evs), 'rejected');
  assert.deepEqual(r.log().filter((l) => l.permissionOutcome).pop().permissionOutcome, { outcome: 'selected', optionId: 'r1' });
  assert.ok(evs.some((e) => e.type === 'tool.result' && e.status === 'failed'));
  await r.done();

  const a = rig({ mode: 'auto' });
  await a.driver.startSession(a.input());
  evs = await a.turn(`edit ${path.join(a.cwd, 'b.txt')}`);
  assert.equal(evs.some((e) => e.type === 'approval.opened'), false);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'b.txt'), 'utf8'), 'edited\n');
  await a.done();
});

test('permissions: acceptForSession -> allow_always; cancel -> cancelled outcome; outbound shell asks on Auto, free on Full access', async () => {
  const r = rig({ mode: 'approval-required' });
  await r.driver.startSession(r.input());
  r.auto.decision = 'acceptForSession';
  await r.turn(`edit ${path.join(r.cwd, 'c.txt')}`);
  assert.deepEqual(r.log().filter((l) => l.permissionOutcome).pop().permissionOutcome, { outcome: 'selected', optionId: 'a2' });
  await r.done();

  const a = rig({ mode: 'auto' });
  await a.driver.startSession(a.input());
  let evs = await a.turn('exec echo hi');
  assert.equal(evs.some((e) => e.type === 'approval.opened'), false); assert.equal(a.text(evs), 'out:hi');
  evs = await a.turn('exec echo curl'); // contains the word curl: outbound by the blob policy
  const ap = evs.find((e) => e.type === 'approval.opened') as any;
  assert.ok(ap, 'outbound must ask'); assert.equal(ap.requestKind, 'command_execution_approval'); assert.match(ap.detail, /send data out/);
  assert.equal(a.text(evs), 'out:curl');
  await a.done();

  const f = rig({ mode: 'full-access' });
  await f.driver.startSession(f.input({ runtimeMode: 'full-access' }));
  evs = await f.turn('exec echo curl');
  assert.equal(evs.some((e) => e.type === 'approval.opened'), false); assert.equal(f.text(evs), 'out:curl');
  await f.done();
});

test('interrupting a turn with an open approval answers the agent with a cancelled outcome and settles the approval', async () => {
  const r = rig({ mode: 'approval-required' });
  r.auto.decision = null;
  await r.driver.startSession(r.input());
  const h = await r.driver.sendTurn({ threadId: 't1', text: `edit ${path.join(r.cwd, 'z.txt')}` });
  await waitFor(() => r.events.some((e) => e.type === 'approval.opened'));
  await r.driver.interruptTurn('t1');
  await waitFor(() => r.events.some((e) => e.type === 'turn.settled' && e.turnId === h.turnId));
  assert.ok(r.events.some((e) => e.type === 'approval.resolved' && e.decision === 'cancel'));
  assert.deepEqual(r.log().find((l) => l.permissionOutcome).permissionOutcome, { outcome: 'cancelled' });
  assert.equal(fs.existsSync(path.join(r.cwd, 'z.txt')), false);
  await r.done();
});

test('fs/* and terminal are confined to the workspace (incl. symlink escapes); Supervised terminals need approval', async () => {
  const r = rig({ mode: 'auto' });
  const outside = tmp(); fs.writeFileSync(path.join(outside, 'secret.txt'), 'S3CRET');
  fs.writeFileSync(path.join(r.cwd, 'ok.txt'), 'line1\nline2\nline3');
  fs.symlinkSync(outside, path.join(r.cwd, 'link'));
  await r.driver.startSession(r.input());
  assert.equal(r.text(await r.turn(`read ${path.join(r.cwd, 'ok.txt')}`)), 'line1\nline2\nline3');
  assert.match(r.text(await r.turn(`read ${path.join(outside, 'secret.txt')}`)), /read failed: path is outside the workspace/);
  assert.match(r.text(await r.turn(`read ${path.join(r.cwd, 'link', 'secret.txt')}`)), /read failed: path is outside the workspace/);
  assert.match(r.text(await r.turn('read relative.txt')), /read failed: path must be absolute/);
  r.auto.decision = 'accept';
  const w = await r.turn(`edit ${path.join(outside, 'x.txt')}`); // out of bounds: asks, and even when allowed the write is refused
  assert.ok(w.some((e) => e.type === 'approval.opened'));
  assert.match(r.text(w), /write failed: path is outside the workspace/); assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
  await r.done();

  const s = rig({ mode: 'approval-required' });
  await s.driver.startSession(s.input());
  s.auto.decision = 'decline';
  const evs = await s.turn('term echo hi'); // the agent never asked; the driver asks as a backstop
  assert.ok(evs.some((e) => e.type === 'approval.opened')); assert.match(s.text(evs), /terminal failed: the user declined/);
  await s.done();
});

test('session/load: a fresh process loads the stored session, drops the history replay, and does not load again', async () => {
  const r = rig();
  await r.driver.startSession(r.input({ resume: 'prev-session' }));
  const evs = await r.turn('hello');
  const load = r.log().filter((l) => l.method === 'session/load');
  assert.equal(load.length, 1); assert.equal(load[0].params.sessionId, 'prev-session'); assert.equal(r.log().filter((l) => l.method === 'session/new').length, 0);
  assert.match(r.text(evs), /^Hello from prev-session/); assert.equal(/OLD/.test(r.text(evs)), false);
  assert.equal(r.log().find((l) => l.method === 'session/prompt').params.sessionId, 'prev-session');
  assert.equal(/PERSONA/.test(r.log().find((l) => l.method === 'session/prompt').params.prompt[0].text), false, 'a loaded session already has the persona');
  await r.turn('hello');
  assert.equal(r.log().filter((l) => l.method === 'session/load').length, 1);
  await r.done();
});

test('a live process that refuses session/load gets exactly ONE replacement process, the conversation is kept', async () => {
  const r = rig({ env: { FAKE_LOAD: 'refuse-live' } });
  await r.driver.startSession(r.input());
  await r.turn('hello'); // P1: session/new
  await r.driver.startSession(r.input({ resume: 'conv-42' })); // a new resume cursor for the live thread
  const evs = await r.turn('hello');
  const log = r.log(); const pids = [...new Set(log.map((l) => l.pid))];
  assert.equal(pids.length, 2); assert.equal(r.driver.pool.stats.spawned, 2);
  assert.equal(log.filter((l) => l.method === 'session/new').length, 1, 'never traded for a new session');
  const loads = log.filter((l) => l.method === 'session/load'); assert.equal(loads.length, 2);
  assert.notEqual(loads[0].pid, loads[1].pid); assert.equal(loads[1].params.sessionId, 'conv-42');
  assert.match(r.text(evs), /^Hello from conv-42/); assert.equal(evs.some((e) => e.type === 'runtime.warning'), false);
  await r.done();
});

test('if the replacement refuses too, it falls back to session/new with a visible warning (never silently), still one replacement', async () => {
  const r = rig({ env: { FAKE_LOAD: 'refuse' } });
  await r.driver.startSession(r.input());
  await r.turn('hello');
  await r.driver.startSession(r.input({ resume: 'conv-42' }));
  const evs = await r.turn('hello');
  assert.equal(r.driver.pool.stats.spawned, 2);
  assert.equal(r.log().filter((l) => l.method === 'session/load').length, 2);
  assert.equal(r.log().filter((l) => l.method === 'session/new').length, 2);
  const w = evs.find((e) => e.type === 'runtime.warning') as any;
  assert.match(w.message, /could not reload the earlier session/); assert.match(w.message, /has not seen the earlier messages/);
  assert.equal((evs.find((e) => e.type === 'turn.settled') as any).state, 'completed');
  await r.done();
});

test('a fresh process whose session/load fails starts a new session with a warning, no replacement process', async () => {
  const r = rig({ env: { FAKE_LOAD: 'refuse' } });
  await r.driver.startSession(r.input({ resume: 'gone' }));
  const evs = await r.turn('hello');
  assert.equal(r.driver.pool.stats.spawned, 1);
  assert.equal(r.log().filter((l) => l.method === 'session/new').length, 1);
  assert.ok(evs.some((e) => e.type === 'runtime.warning'));
  await r.done();
});

test('an agent without loadSession says so instead of pretending to resume', async () => {
  const r = rig({ env: { FAKE_NOLOAD: '1' } });
  await r.driver.startSession(r.input({ resume: 'x' }));
  const evs = await r.turn('hello');
  assert.equal(r.log().filter((l) => l.method === 'session/load').length, 0);
  assert.match((evs.find((e) => e.type === 'runtime.warning') as any).message, /cannot resume earlier conversations/);
  await r.done();
});

test('idle close: the process goes after idleMs, the next turn respawns and session/loads the same conversation', async () => {
  const r = rig({ idleMs: 120 });
  await r.driver.startSession(r.input());
  const first = await r.turn('hello');
  const sid = (first.find((e) => e.type === 'thread.started') as any).providerThreadId;
  assert.equal(r.driver.hasProcess('t1'), true);
  await waitFor(() => !r.driver.hasProcess('t1'), 3000);
  assert.equal(r.driver.pool.stats.closed, 1);
  await r.turn('hello');
  const loads = r.log().filter((l) => l.method === 'session/load');
  assert.equal(loads.length, 1); assert.equal(loads[0].params.sessionId, sid); assert.equal(r.driver.pool.stats.spawned, 2);
  await r.done();
});

test('a busy process is never idle-closed mid-turn', async () => {
  const r = rig({ idleMs: 50 });
  await r.driver.startSession(r.input());
  const h = await r.driver.sendTurn({ threadId: 't1', text: 'wait' });
  // Wait for the turn to be live first: under the Seatbelt wrapper the handshake alone can take ~1 s, so a fixed
  // sleep raced the spawn rather than the idle timer. Then outlast idleMs several times over.
  await waitFor(() => r.text(r.events) === 'waiting');
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(r.driver.hasProcess('t1'), true);
  await r.driver.interruptTurn('t1');
  await waitFor(() => r.events.some((e) => e.type === 'turn.settled' && e.turnId === h.turnId));
  assert.equal((r.events.find((e) => e.type === 'turn.settled') as any).state, 'interrupted');
  assert.equal(r.driver.hasProcess('t1'), true, 'interrupt cancels the turn, not the process');
  await r.done();
});

test('spawn-contract change (model, approval posture) closes the process; the next turn loads the session on a fresh one', async () => {
  const r = rig();
  await r.driver.startSession(r.input());
  await r.turn('hello');
  await r.driver.setModel('t1', { model: 'm2' });
  await r.turn('hello');
  assert.equal(r.driver.pool.stats.spawned, 2); assert.equal(r.log().filter((l) => l.method === 'session/load').length, 1);
  assert.ok(r.log().some((l) => l.method === 'session/set_model' && l.params.modelId === 'm2'), 'model applied via session/set_model');
  await r.driver.setPermissionMode('t1', 'full-access');
  await r.turn('hello');
  assert.equal(r.driver.pool.stats.spawned, 3);
  await r.turn('hello');
  assert.equal(r.driver.pool.stats.spawned, 3, 'same contract: reused');
  await r.done();
});

test('crash recovery: a process that dies at once gets one fresh start; a repeated crash fails calmly; the next message works', async () => {
  const r = rig();
  await r.driver.startSession(r.input());
  const evs = await r.turn('crash');
  const settled = evs.find((e) => e.type === 'turn.settled') as any;
  assert.equal(settled.state, 'failed'); assert.match(settled.errorMessage, /stopped unexpectedly/);
  assert.equal(r.driver.pool.stats.spawned, 2, 'exactly one retry');
  const ok = await r.turn('hello');
  assert.equal((ok.find((e) => e.type === 'turn.settled') as any).state, 'completed');
  assert.equal(r.log().filter((l) => l.method === 'session/load').length >= 1, true, 'the conversation was loaded, not restarted');
  await r.done();
});

test('a missing executable fails the turn with an install hint, never throws out of the driver', async () => {
  const r = rig();
  const d = new AcpDriver({ graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('x'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as any, { agentId: 'grok', label: 'Grok CLI', command: 'nope', args: [] }, { resolveBinary: () => null });
  const evs: ChatEvent[] = []; d.streamEvents((e) => evs.push(e));
  await d.startSession({ threadId: 'x', agent: 'grok', cwd: r.cwd, account: null });
  await d.sendTurn({ threadId: 'x', text: 'hi' });
  await waitFor(() => evs.some((e) => e.type === 'turn.settled'));
  assert.match((evs.find((e) => e.type === 'runtime.error') as any).message, /Grok CLI isn't installed.*Settings > Engines/);
  await r.done();
});

test('MCP: the blob bridge rides session/new as an ACP stdio server (token on argv); token revoked when the thread stops', async () => {
  const cwd = tmp(); const issued: any[] = []; const revoked: string[] = [];
  const r = rig({ cwd, deps: {
    socketPath: '/h/kora.sock', binPath: '/app/bin/kora.js',
    blobs: { byCwd: (c: string) => (c === cwd ? { id: 'blob_a', role: 'member', permission: 'auto', workspace: cwd } : null), toolSpecs: () => [], skills: () => ({ dir: '', qualified: [] }), mcpIssue: (s: any) => { issued.push(s); return 'TOKEN123'; }, mcpRevoke: (t: string) => { revoked.push(t); } },
  } as any });
  await r.driver.startSession(r.input());
  await r.turn('hello');
  const nw = r.log().find((l) => l.method === 'session/new');
  assert.equal(nw.params.cwd, cwd);
  const srv = nw.params.mcpServers[0];
  assert.equal(srv.name, 'kora_blobs'); assert.deepEqual(srv.env, []);
  for (const a of ['mcp', '--blobs', '--blob', 'blob_a', '--token', 'TOKEN123', '--socket', '/h/kora.sock', '--thread', 't1', '--agent', 'gemini']) assert.ok(srv.args.includes(a), a);
  assert.equal(issued[0].agent, 'gemini');
  await r.driver.stopSession('t1');
  assert.ok(revoked.includes('t1'));
  await r.done();
  // a plain (non-blob) thread gets no MCP server
  const p = rig(); await p.driver.startSession(p.input()); await p.turn('hello');
  assert.deepEqual(p.log().find((l) => l.method === 'session/new').params.mcpServers, []);
  await p.done();
});

test('live model discovery: reads models from session/new; an agent that lists none says so', async () => {
  const logFile = path.join(tmp(), 'x.log');
  const engine: AcpEngine = { agentId: 'gemini', label: 'Fake ACP', command: 'node', args: [FIXTURE], env: { FAKE_LOG: logFile } };
  const ok = await discoverAcpModels(engine, { binary: process.execPath });
  assert.deepEqual(ok.models, [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }]); assert.equal(ok.current, 'm1');
  const none = await discoverAcpModels({ ...engine, env: { FAKE_NO_MODELS: '1' } }, { binary: process.execPath });
  assert.deepEqual(none.models, []); assert.match(none.error!, /does not list its models/);
  const missing = await discoverAcpModels(engine, { binary: null, spawn: undefined });
  assert.ok(Array.isArray(missing.models));
});

test('pure mappers: tool kinds, plan, content, permission options, usage', () => {
  assert.equal(acpToolKind('execute'), 'command_execution'); assert.equal(acpToolKind('edit'), 'file_change'); assert.equal(acpToolKind('search'), 'file_read');
  assert.equal(acpToolKind('other', 'kora_blobs: recall'), 'mcp_tool_call'); assert.equal(acpToolKind('think'), 'dynamic_tool_call');
  assert.equal(acpActionClass('think'), 'read'); assert.equal(acpActionClass('switch_mode'), 'other');
  assert.deepEqual(acpPlan([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }, { content: '' }]), [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }]);
  const c = acpContentText([{ type: 'content', content: { type: 'text', text: 'hi' } }, { type: 'diff', path: '/w/a', oldText: 'a\nb', newText: 'a\nb\nc' }, { type: 'terminal', terminalId: 't9' }]);
  assert.equal(c.text, 'hi'); assert.deepEqual(c.files, [{ path: '/w/a', additions: 1, deletions: 0 }]); assert.deepEqual(c.terminalIds, ['t9']);
  const opts = [{ optionId: 'x', kind: 'allow_always' }, { optionId: 'y', kind: 'reject_always' }];
  assert.deepEqual(pickPermissionOption(opts, 'accept'), { outcome: 'selected', optionId: 'x' });
  assert.deepEqual(pickPermissionOption(opts, 'decline'), { outcome: 'selected', optionId: 'y' });
  assert.deepEqual(pickPermissionOption([{ optionId: 'x', kind: 'allow_once' }], 'decline'), { outcome: 'cancelled' });
  assert.deepEqual(pickPermissionOption(opts, 'cancel'), { outcome: 'cancelled' });
  assert.deepEqual(acpTurnUsage({ usage: { inputTokens: 5, outputTokens: 2, cachedReadTokens: 1 } }), { usageStatus: 'complete', inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 });
  assert.equal(acpTurnUsage({}), undefined);
});

test('pool: closeAll kills every process; a handshake failure leaves nothing behind', async () => {
  const pool = new AcpPool({ spawn: () => { throw new Error('ENOENT'); } });
  await assert.rejects(pool.acquire('k', 'c', { command: 'x', args: [], env: {}, cwd: '/' }, async () => ({ caps: {}, authMethods: [] })), /ENOENT/);
  assert.equal(pool.size(), 0);
});

// ── a failing agent fails ONCE and is never respawned (launch fix P0) ────────────────────────────────────────────────
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function healthRig(env: Record<string, string>, setupTimeoutMs = 400) {
  const parked: { reason: string | null } = { reason: null };
  const fails: string[] = [];
  const r = rig({ env, driverOpts: { setupTimeoutMs, health: { blocked: () => parked.reason, fail: (reason) => { fails.push(reason); parked.reason = reason; } } } });
  return { r, parked, fails };
}
const settledOf = (evs: ChatEvent[]) => evs.find((e) => e.type === 'turn.settled') as any;

test('unsupported-client agent: the turn fails once with its message, the engine is parked, later turns spawn nothing', async () => {
  const { r, fails } = healthRig({ FAKE_FAIL: 'unsupported' });
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.equal(settledOf(evs).state, 'failed');
  assert.match(settledOf(evs).errorMessage, /no longer supported.*Antigravity/);
  assert.match(settledOf(evs).errorMessage, /re-check it in Settings > Engines/);
  assert.equal(fails.length, 1);
  assert.equal(r.driver.pool.stats.spawned, 1, 'no retry');
  const again = await r.turn('hello'); await r.turn('hello');
  assert.equal(settledOf(again).state, 'failed');
  assert.equal(r.driver.pool.stats.spawned, 1, 'a parked engine is never spawned again');
  assert.equal(r.log().filter((l) => l.method === 'initialize').length, 1);
  assert.equal(r.driver.pool.size(), 0);
  await r.done();
});

test('auth/startup timeout: one failure, the hung process is killed, nothing respawns', async () => {
  const { r, fails } = healthRig({ FAKE_FAIL: 'hang-init' });
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.match(settledOf(evs).errorMessage, /did not finish starting or signing in/);
  assert.equal(fails.length, 1); assert.equal(r.driver.pool.stats.spawned, 1);
  assert.equal(r.driver.pool.size(), 0);
  const pids = [...new Set(r.log().map((l) => l.pid))];
  await waitFor(() => pids.every((p) => !alive(p)));
  await r.turn('hello'); assert.equal(r.driver.pool.stats.spawned, 1);
  await r.done();
});

test('session/new timeout after a good handshake also parks the engine and closes the process', async () => {
  const { r, fails } = healthRig({ FAKE_FAIL: 'hang-new' });
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.equal(settledOf(evs).state, 'failed'); assert.equal(fails.length, 1);
  assert.equal(r.driver.pool.stats.spawned, 1); assert.equal(r.driver.pool.size(), 0);
  await waitFor(() => [...new Set(r.log().map((l) => l.pid))].every((p) => !alive(p)));
  await r.done();
});

test('crash at start (exits before the handshake): one spawn, failure carries the agent stderr', async () => {
  // A long setup budget: the fake exits on its own, and under a loaded run spawning it alone can outlast 400 ms, so the
  // timeout used to win the race and the failure read "timed out" instead of the agent's stderr.
  const { r, fails } = healthRig({ FAKE_FAIL: 'exit-start' }, 15_000);
  await r.driver.startSession(r.input());
  const evs = await r.turn('hello');
  assert.equal(settledOf(evs).state, 'failed');
  assert.equal(fails.length, 1); assert.equal(r.driver.pool.stats.spawned, 1, 'no second process');
  assert.match(settledOf(evs).errorMessage, /boom at startup/);
  await r.done();
});

test('re-check: once the engine is un-parked the next turn starts it normally', async () => {
  const { r, parked } = healthRig({});
  parked.reason = 'Fake ACP did not start.';
  await r.driver.startSession(r.input());
  assert.equal(settledOf(await r.turn('hello')).state, 'failed');
  assert.equal(r.driver.pool.stats.spawned, 0);
  parked.reason = null;
  assert.equal(settledOf(await r.turn('hello')).state, 'completed');
  assert.equal(r.driver.pool.stats.spawned, 1);
  await r.done();
});

test('model discovery never leaves a process behind, even when the agent hangs or is unsupported', async () => {
  const logFile = path.join(tmp(), 'd.log');
  const base: AcpEngine = { agentId: 'gemini', label: 'Fake ACP', command: 'node', args: [FIXTURE], env: { FAKE_LOG: logFile } };
  const pidsOf = () => [...new Set((fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []).map((l) => JSON.parse(l).pid))] as number[];
  const hung = await discoverAcpModels({ ...base, env: { ...base.env, FAKE_FAIL: 'hang-init' } }, { binary: process.execPath, timeoutMs: 300 });
  assert.ok(hung.error && hung.failed);
  // The unsupported agent answers at once; a short timeout only raced its Seatbelt-wrapped start-up.
  const uns = await discoverAcpModels({ ...base, env: { ...base.env, FAKE_FAIL: 'unsupported' } }, { binary: process.execPath, timeoutMs: 10_000 });
  assert.match(uns.error!, /no longer supported/); assert.equal(uns.failed, true);
  const ok = await discoverAcpModels(base, { binary: process.execPath });
  assert.equal(ok.models.length, 2);
  await waitFor(() => pidsOf().every((p) => !alive(p)));
});

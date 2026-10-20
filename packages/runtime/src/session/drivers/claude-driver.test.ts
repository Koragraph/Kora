import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, proxyPaneId, SAFE_DISALLOWED_TOOLS, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

// ── a controllable fake SDK query (the SDK is mocked — no network) ────────────────────────────────
function makeFakeQuery() {
  const buffer: any[] = [];
  let waiting: ((v: IteratorResult<any>) => void) | null = null;
  let failWaiting: ((e: unknown) => void) | null = null;
  let ended = false;
  const control = { interruptCalls: 0, models: [] as (string | undefined)[], permModes: [] as string[], options: undefined as any };
  const iterator: any = {
    async next() {
      if (buffer.length) return { value: buffer.shift(), done: false };
      if (ended) return { value: undefined, done: true };
      return new Promise<IteratorResult<any>>((r, j) => { waiting = r; failWaiting = j; });
    },
    async return() { ended = true; return { value: undefined, done: true }; },
    async throw(e: any) { throw e; },
    [Symbol.asyncIterator]() { return this; },
    interrupt() { control.interruptCalls++; return Promise.resolve(); },
    setModel(m?: string) { control.models.push(m); return Promise.resolve(); },
    setPermissionMode(m: string) { control.permModes.push(m); return Promise.resolve(); },
  };
  const push = (msg: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); } else buffer.push(msg); };
  /** The SDK child dies: the pending read rejects the way the SDK reports a killed process. */
  const crash = (e: unknown) => { const f = failWaiting; waiting = null; failWaiting = null; f?.(e); };
  return { iterator, control, push, crash };
}

function makeDriver(depOverrides: Partial<DriverDeps> = {}) {
  const fake = makeFakeQuery();
  const queryFn: QueryFn = (params) => { fake.control.options = params.options; return fake.iterator; };
  const spawnCalls: any[] = [];
  const deps: DriverDeps = {
    graphCall: async () => ({ text: 'graph text', data: null, ms: 1 }),
    spawnWorker: async (p) => { spawnCalls.push(p); return { id: 'p_worker', agent: p.agent, account: p.account ?? null }; },
    spawnEnv: (_t, account): Record<string, string> => (account ? { CLAUDE_CONFIG_DIR: `/accounts/${account}` } : {}),
    appendSystemPrompt: (i) => (i.isOrchestrator ? 'orchestrator instructions' : undefined),
    // These tests describe a TRUSTED folder; the untrusted lane is claude-driver.trust.test.ts.
    isFolderTrusted: () => true,
    ...depOverrides,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  return { driver, events, fake, spawnCalls, deps };
}
const flush = () => new Promise((r) => setImmediate(r));

test('startSession builds SDK options: cwd, resume, account env, preset systemPrompt, canUseTool', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/repo', account: 'work', resume: 'sess-1', isOrchestrator: true });
  const opts = fake.control.options;
  assert.equal(opts.cwd, '/repo');
  assert.equal(opts.resume, 'sess-1');
  assert.equal(opts.forkSession, false);
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, '/accounts/work', 'per-account isolation env applied');
  assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'orchestrator instructions' });
  assert.equal(typeof opts.canUseTool, 'function');
  assert.ok(opts.mcpServers && opts.mcpServers.kora, 'in-process kora MCP server wired');
});

test('a system/init message flows through the pump into session.started + thread.started', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  fake.push({ type: 'system', subtype: 'init', session_id: 'sess-42', model: 'claude' });
  await flush();
  const types = events.map((e) => e.type);
  assert.ok(types.includes('session.started'));
  const started = events.find((e) => e.type === 'thread.started') as any;
  assert.equal(started.providerThreadId, 'sess-42');
});

test('sendTurn emits turn.started + running, and a switch calls query.setModel', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId: 'T', text: 'do the thing', model: { model: 'claude-opus-4-8' } });
  assert.deepEqual(fake.control.models, ['claude-opus-4-8'], 'per-turn model override hits setModel');
  const turn = events.find((e) => e.type === 'turn.started') as any;
  assert.ok(turn && turn.turnId);
  assert.ok(events.some((e) => e.type === 'session.state' && (e as any).state === 'running'));
});

test('canUseTool parks on a Promise and respondToApproval(accept) resolves it to allow', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId: 'T', text: 'x' });
  const decisionP = fake.control.options.canUseTool('Bash', { command: 'rm -rf x' }, { title: 'Run rm?' });
  await flush();
  const opened = events.find((e) => e.type === 'approval.opened') as any;
  assert.ok(opened, 'approval.opened emitted');
  assert.equal(opened.requestKind, 'command_execution_approval');
  await driver.respondToApproval('T', opened.requestId, 'accept');
  const decision = await decisionP;
  assert.deepEqual(decision, { behavior: 'allow' });
  assert.ok(events.some((e) => e.type === 'approval.resolved' && (e as any).decision === 'accept'));
});

test('approval ids never repeat across session restarts of the same thread (a resolved id is final in the client)', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { driver, events, fake } = makeDriver();
    await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
    void fake.control.options.canUseTool('WebSearch', { query: 'q' }, {});
    await flush();
    ids.push((events.find((e) => e.type === 'approval.opened') as any).requestId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('sessions may be switched to Full access live (allowDangerouslySkipPermissions), without starting in it', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  assert.equal(fake.control.options.allowDangerouslySkipPermissions, true);
  assert.equal(fake.control.options.permissionMode, 'default');
});

test('respondToApproval(decline) resolves the parked promise to deny', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const decisionP = fake.control.options.canUseTool('Write', { file_path: '/etc/hosts' }, {});
  await flush();
  const opened = events.find((e) => e.type === 'approval.opened') as any;
  await driver.respondToApproval('T', opened.requestId, 'decline');
  const decision = await decisionP;
  assert.equal((decision as any).behavior, 'deny');
});

test('kora MCP tools are auto-allowed (never parked)', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const decision = await fake.control.options.canUseTool('mcp__kora__explore', {}, {});
  assert.deepEqual(decision, { behavior: 'allow' });
});

test('orchestrator sessions disallow the SDK subagent tool (the fleet is the only delegation)', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null, isOrchestrator: true });
  // the SDK subagent tools plus the safe subset every NEW code thread gets (see claude-driver.savings.test.ts)
  assert.deepEqual(fake.control.options.disallowedTools, ['Agent', 'Task', 'Workflow', ...SAFE_DISALLOWED_TOOLS]);
});

test('swarm leader sessions run the lean lane: fewer tools, no skill listing, no auto-memory block; settings still load', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null, isOrchestrator: true, agentMode: 'swarm' });
  const o = fake.control.options;
  for (const t of ['Agent', 'Task', 'Workflow', 'Skill']) assert.ok(o.disallowedTools.includes(t), t);
  assert.ok(!o.disallowedTools.includes('Bash'));
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.settingSources, ['user', 'project', 'local'], 'the repo hooks + CLAUDE.md still load (one injection owner)');
});

test('plain chat sessions keep the SDK subagent tool (only the safe subset is off)', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  assert.deepEqual(fake.control.options.disallowedTools, [...SAFE_DISALLOWED_TOOLS]);
});

test('AskUserQuestion waits for the user and returns answers keyed by question text — no approval, no extra message', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const input = { questions: [
    { question: 'What should the swarm research?', header: 'Topic', options: [{ label: 'Competitors', description: '' }, { label: 'Papers', description: '' }], multiSelect: false },
    { question: 'Where should results go?', header: 'Output', options: [{ label: 'Chat only', description: '' }, { label: 'A file', description: '' }], multiSelect: false },
  ] };
  let settled: any = null;
  const pending = fake.control.options.canUseTool('AskUserQuestion', input, { toolUseID: 'toolu_q1' }).then((d: any) => (settled = d));
  await flush();
  assert.equal(settled, null, 'the callback stays pending until the user answers (SDK contract)');
  const pushedBefore = (fake as any).control.pushed ?? 0;
  await driver.respondToUserInput('T', 'toolu_q1', { q0: 'Competitors', q1: 'Chat only' });
  const decision = await pending;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual(decision.updatedInput.answers, { 'What should the swarm research?': 'Competitors', 'Where should results go?': 'Chat only' });
  assert.deepEqual(decision.updatedInput.questions, input.questions);
  assert.equal(events.filter((e: any) => e.type === 'approval.opened').length, 0);
  assert.equal((fake as any).control.pushed ?? 0, pushedBefore, 'answered in-turn, not re-sent as a fresh user message');
});

test('an interrupted AskUserQuestion is denied (never answered by itself)', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const ac = new AbortController();
  const pending = fake.control.options.canUseTool('AskUserQuestion', { questions: [] }, { toolUseID: 'toolu_q2', signal: ac.signal });
  ac.abort();
  const decision = await pending;
  assert.equal(decision.behavior, 'deny');
});

test('output arriving with no open turn opens one; a stray result of a settled turn is dropped', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  fake.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  await flush();
  assert.equal(events.filter((e: any) => e.type === 'turn.settled').length, 0, 'no open turn → the stray result is dropped');
  fake.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'continuing' }], usage: { input_tokens: 5, output_tokens: 2 } } });
  await flush();
  const started = events.filter((e: any) => e.type === 'turn.started');
  assert.equal(started.length, 1, 'turn-less output opened a turn');
  fake.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 5, output_tokens: 2 } });
  await flush();
  const settled = events.filter((e: any) => e.type === 'turn.settled');
  assert.equal(settled.length, 1);
  assert.equal((settled[0] as any).turnId, (started[0] as any).turnId);
});

test('an assistant tool_use + user tool_result stream into tool.started/tool.result', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId: 'T', text: 'x' });
  fake.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } }] } });
  fake.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', tool_name: 'Read', is_error: false, content: 'file body' }] } });
  await flush();
  const started = events.find((e) => e.type === 'tool.started') as any;
  const result = events.find((e) => e.type === 'tool.result') as any;
  assert.equal(started.itemId, 'tu1');
  assert.equal(result.itemId, 'tu1');
  assert.equal(result.status, 'completed');
});

test('files a Claude thread reads feed the deictic recall memory (as Codex and agy do)', async () => {
  const { driver, fake } = makeDriver();
  const threadId = `T-carry-${process.pid}-${Date.now()}`;
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId, text: 'x' });
  fake.push({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/r/src/lock.ts' } }] } });
  await flush();
  const { loadCarry } = require('../../graph/inject-carry') as typeof import('../../graph/inject-carry');
  assert.ok(loadCarry(threadId).files.some((f) => f.rel === 'src/lock.ts'), 'the opened file is in the thread\'s recall memory');
  const { carryPath } = require('../../graph/inject-carry') as typeof import('../../graph/inject-carry');
  try { fs.unlinkSync(carryPath(threadId)); } catch { /* ignore */ }
});

test('B16: a code thread registers the Bash trim hook (on by default: a big result is cut; shadow never changes a result)', async () => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T-bt', agent: 'claude', cwd: '/r', account: null });
  const entry = (fake.control.options.hooks.PostToolUse as any[]).find((e) => e.matcher === 'Bash');
  assert.ok(entry, 'PostToolUse Bash entry');
  const big = Array.from({ length: 500 }, (_, i) => `line ${i} of a long build log with some padding text`).join('\n');
  const call = () => entry.hooks[0]({ tool_name: 'Bash', tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false } });
  const out = (await call())?.hookSpecificOutput?.updatedToolOutput;
  assert.ok(typeof out?.stdout === 'string' && out.stdout.length < big.length, 'on: output cut');
  const prev = process.env.KORA_BASH_TRIM;
  process.env.KORA_BASH_TRIM = 'shadow';
  try {
    assert.deepEqual(await call(), {}, 'shadow: output untouched');
  } finally {
    if (prev === undefined) delete process.env.KORA_BASH_TRIM; else process.env.KORA_BASH_TRIM = prev;
  }
});

test('interruptTurn calls query.interrupt and settles the turn as interrupted', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId: 'T', text: 'x' });
  await driver.interruptTurn('T');
  assert.equal(fake.control.interruptCalls, 1);
  assert.ok(events.some((e) => e.type === 'turn.settled' && (e as any).state === 'interrupted'));
});

test('interruptTurn for a turn that is no longer current is a no-op; the current turn id still stops it', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const { turnId } = await driver.sendTurn({ threadId: 'T', text: 'x' });
  await driver.interruptTurn('T', 'old-turn' as any);
  assert.equal(fake.control.interruptCalls, 0);
  assert.ok(!events.some((e) => e.type === 'turn.settled'));
  await driver.interruptTurn('T', turnId);
  assert.equal(fake.control.interruptCalls, 1);
});

test('stopSession fails parked approvals and emits session.exited', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const decisionP = fake.control.options.canUseTool('Bash', {}, {});
  await driver.stopSession('T');
  const decision = await decisionP;
  assert.equal((decision as any).behavior, 'deny', 'parked approval released so the SDK loop cannot hang');
  assert.ok(events.some((e) => e.type === 'session.exited'));
  assert.equal(driver.hasSession('T'), false);
});

test('proxyPaneId is the stable chat: prefix (D4 orchestratorId linkage)', () => {
  assert.equal(proxyPaneId('T'), 'chat:T');
});

test('desktop chat lane: a code-shaped prompt on an indexed repo is prepended with graph declarations', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const explore = '3 match(es) for "buildDriver". Focus: 1 symbol(s).\n\n■ METHOD buildDriver @ src/session/session-manager.ts:80 — buildDriver(input)\n  callers: startSession@src/session/session-manager.ts:120\n';
  const { driver, fake } = makeDriver({ graphCall: async () => ({ text: explore, data: null, ms: 1 }), graphStatus: async () => ({ indexed: true }) });
  const threadId = `T-inject-${process.pid}-${Date.now()}`; // unique: the injected-prompt marker is per session id and persists in tmp
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId, text: 'how does buildDriver pick a driver?' });
  await flush();
  assert.ok(fake.control.options, 'query options recorded');
  const rec = require('../../graph/prompt-inject').lastInjectRecord;
  assert.ok(rec && rec.lane === 'desktop-chat' && rec.decision === 'injected', `telemetry says ${rec && rec.lane}/${rec && rec.reason}`);
  assert.ok(rec.decls >= 1);
});

// ── assistant lane (no graph, general-assistant leader) ─────────────────────────────────────────────
// Async bodies must keep KORA_BLOBS_ROOT set until they settle: startSession reads it after its first await, and restoring it
// synchronously (the old `finally`) made the assistant-lane cwd look like a code repo, so the lean code-swarm lane applied.
function withChatHome<T>(fn: (cwd: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chathome-'));
  const prev = process.env.KORA_BLOBS_ROOT;
  process.env.KORA_BLOBS_ROOT = dir;
  const cwd = path.join(dir, 'popo');
  fs.mkdirSync(cwd, { recursive: true });
  const restore = () => { if (prev === undefined) delete process.env.KORA_BLOBS_ROOT; else process.env.KORA_BLOBS_ROOT = prev; };
  let out: T;
  try { out = fn(cwd); } catch (e) { restore(); throw e; }
  if (out && typeof (out as any).then === 'function') return (out as any).then((v: unknown) => { restore(); return v; }, (e: unknown) => { restore(); throw e; }) as T;
  restore();
  return out;
}

test('a assistant-lane swarm leader keeps the full toolset (not the lean code-swarm lane)', () => withChatHome(async (cwd) => {
  const { driver, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd, account: null, isOrchestrator: true, agentMode: 'swarm' });
  const o = fake.control.options;
  assert.deepEqual(o.disallowedTools, ['Agent', 'Task', 'Workflow'], 'only the SDK subagent tools are disallowed, unlike the code-swarm lean lane');
  assert.equal(o.skills, undefined, 'the code-swarm lane\'s empty skills list is not forced here');
  assert.equal(o.hooks.PreToolUse.length, 1, 'only the sensitive-path guard: the code-swarm delegate-first gate never applies to Chat');
}));

test('a assistant-lane prompt never triggers the code-graph injection lookup', () => withChatHome(async (cwd) => {
  let graphCalled = false;
  const { driver, fake } = makeDriver({ graphCall: async () => { graphCalled = true; return { text: 'x', data: null, ms: 1 }; }, graphStatus: async () => ({ indexed: true }) });
  await driver.startSession({ threadId: 'T-chat', agent: 'claude', cwd, account: null, isOrchestrator: true, agentMode: 'swarm' });
  await driver.sendTurn({ threadId: 'T-chat', text: 'find me the best noodle place near me' });
  await flush();
  assert.ok(fake.control.options, 'query options recorded');
  assert.equal(graphCalled, false, 'no graph lookup ran for a assistant-lane cwd');
}));

test('a prepared session gets the pane preparation: KORA_* env, rulebook + orchestrator append, strict MCP, all setting sources', async () => {
  const prev = process.env.CLAUDECODE; process.env.CLAUDECODE = '1'; // the daemon may itself run inside an agent session
  try {
    const { driver, fake } = makeDriver({
      prepareSession: async (i) => ({ env: { KORA_PANE_ID: `chat:${i.threadId}`, KORA_SOCKET_PATH: '/tmp/d.sock', KORA_INJECT_OWNER: 'driver' }, appendSystemPrompt: 'RULEBOOK', strictMcp: true, notes: ['ok'] }),
    });
    await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/repo', account: 'work', isOrchestrator: true });
    const opts = fake.control.options;
    assert.equal(opts.env.KORA_PANE_ID, 'chat:T');
    assert.equal(opts.env.KORA_SOCKET_PATH, '/tmp/d.sock', 'hooks dial the daemon that drives the session');
    assert.equal(opts.env.KORA_INJECT_OWNER, 'driver', 'the prompt hook leaves injection to the driver');
    assert.equal(opts.env.CLAUDE_CONFIG_DIR, '/accounts/work', 'account env still applied');
    assert.equal(opts.env.CLAUDECODE, undefined, 'inherited agent-session markers are stripped');
    assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'RULEBOOK\n\norchestrator instructions' });
    assert.equal(opts.strictMcpConfig, true);
    assert.deepEqual(opts.settingSources, ['user', 'project', 'local'], 'the repo\'s .claude/settings.local.json hooks load');
  } finally { if (prev === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prev; }
});

test('a failing or hanging preparation never blocks the session: it starts unprepared', async () => {
  const { driver, fake } = makeDriver({ prepareSession: async () => { throw new Error('boom'); } });
  await driver.startSession({ threadId: 'T2', agent: 'claude', cwd: '/repo', account: null });
  assert.equal(fake.control.options.strictMcpConfig, undefined);
  assert.equal(fake.control.options.systemPrompt.append, undefined);
});

test('worker notes ride on every tool result of a fleet-wired lead (PostToolUse additionalContext), next to the swarm gate', async () => {
  const { workerNoteHooks, buildSessionOptions } = await import('./claude-driver');
  let pending = ['[kora] worker p2 STOPPED on an error'];
  const hooks: any = workerNoteHooks(() => { const n = pending; pending = []; return n; });
  const out = await hooks.PostToolUse[0].hooks[0]({ tool_name: 'WebSearch' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /p2 STOPPED/);
  assert.deepEqual(await hooks.PostToolUse[0].hooks[0]({ tool_name: 'Read' }), {}, 'drained: nothing twice');
  const opts = buildSessionOptions({ threadId: 'T', agent: 'claude', cwd: '/r', account: null, isOrchestrator: true, agentMode: 'swarm' } as any, null, undefined, {}, { mcpServers: {}, canUseTool: null, drainNotes: () => [] });
  assert.ok(opts.hooks.PreToolUse && opts.hooks.PostToolUse, 'the swarm gate and the note hook both stay');
  const plain = buildSessionOptions({ threadId: 'T', agent: 'claude', cwd: '/r', account: null } as any, null, undefined, {}, { mcpServers: {}, canUseTool: null, drainNotes: () => [] });
  assert.equal(plain.hooks.PostToolUse, undefined, 'a session without fleet tools gets no note hook');
  assert.equal(plain.hooks.PreToolUse.length, 1, 'but every session carries the sensitive-path guard');
});

test('helpersOff (a blob with Free helpers switched off) wires no fleet tools but keeps the SDK subagent tools disallowed', async () => {
  const names = async (helpersOff: boolean) => {
    const { driver, fake } = makeDriver({ fleet: {} as any });
    await driver.startSession({ threadId: `T-${helpersOff}`, agent: 'claude', cwd: '/r', account: null, isOrchestrator: true, agentMode: 'swarm', ...(helpersOff ? { helpersOff: true } : {}) });
    const tools = Object.keys((fake.control.options.mcpServers.kora?.instance as any)?._registeredTools ?? {});
    return { tools, disallowed: fake.control.options.disallowedTools as string[] };
  };
  const on = await names(false);
  assert.ok(on.tools.includes('kora_spawn') && on.tools.includes('kora_wait'));
  const off = await names(true);
  assert.ok(!off.tools.some((t) => /^kora_(spawn|map|wait|workers|read|kill|prompt|ask_workers)$/.test(t)), `no fleet tools: ${off.tools.join(',')}`);
  assert.ok(off.disallowed.includes('Agent') && off.disallowed.includes('Task'), 'the harness\'s own subagents stay off');
});

test('a Claude child killed mid-turn: the turn says it stopped (error on the turn), then settles interrupted (pl10 S3-3)', async () => {
  const { driver, events, fake } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/r', account: null });
  const { turnId } = await driver.sendTurn({ threadId: 'T', text: 'write a lot' });
  fake.crash(new Error('Claude Code process terminated by signal SIGTERM'));
  await flush(); await flush();
  const err = events.find((e) => e.type === 'runtime.error') as any;
  assert.ok(err, 'an error banner for the cut-off reply');
  assert.equal(err.turnId, turnId);
  assert.match(err.message, /stopped before finishing/);
  const settledAt = events.findIndex((e) => e.type === 'turn.settled');
  assert.equal((events[settledAt] as any).state, 'interrupted');
  assert.ok(events.indexOf(err) < settledAt, 'said before the turn settles');
  assert.ok(events.some((e) => e.type === 'session.exited'));
});

// The token-saving wiring of the Claude chat lane: the safe tool subset, Lean context, thread flags that outlive a resume,
// the bounded-Read hooks, the no-graph -> indexed notice, per-call cost telemetry, and the tool.result `bounded` marker.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, SAFE_DISALLOWED_TOOLS, SAFE_TOOLS_ENV, buildSessionOptions, mergeLaneOptions, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';
import { readThreadFlags } from '../thread-flags';
import { flushCostLog, readCostLog } from '../../util/cost-log';
import { resetSavingsSettingsCache } from '../../util/savings-settings';
import { koraHome } from '../../protocol/types';

// Kora's compaction point rides in every session's flag settings env (buildSessionOptions); these checks are about the rest.
const noEnv = (s: any) => { if (!s) return s; const { env: _env, ...rest } = s; return Object.keys(rest).length ? rest : undefined; };

const flush = () => new Promise((r) => setImmediate(r));
function makeDriver(over: Partial<DriverDeps> = {}) {
  const buffer: any[] = []; let waiting: ((v: IteratorResult<any>) => void) | null = null; let prompt: AsyncGenerator<any> | null = null; let options: any;
  const iterator: any = {
    next: async () => (buffer.length ? { value: buffer.shift(), done: false } : new Promise<IteratorResult<any>>((r) => { waiting = r; })),
    return: async () => ({ value: undefined, done: true }),
    [Symbol.asyncIterator]() { return this; },
  };
  const push = (m: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: m, done: false }); } else buffer.push(m); };
  const queryFn: QueryFn = (p: any) => { prompt = p.prompt; options = p.options; return iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), graphStatus: async () => ({ indexed: false }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined,
    isFolderTrusted: () => true, ...over,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = []; driver.streamEvents((e) => events.push(e));
  return { driver, events, push, options: () => options, nextPrompt: async (): Promise<string> => (await prompt!.next()).value.message.content };
}
let n = 0; const tid = (p: string) => `${p}-${process.pid}-${Date.now()}-${++n}`;
process.env.KORA_INJECT_LOG = '0';

test('a NEW code thread gets the safe tool subset, the env flag, and the bounded-Read hooks; the flags are remembered', async () => {
  const { driver, options } = makeDriver();
  const threadId = tid('S1');
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  const o = options();
  for (const t of SAFE_DISALLOWED_TOOLS) assert.ok(o.disallowedTools.includes(t), t);
  assert.equal(o.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, '1');
  assert.deepEqual(o.skills, undefined, 'lean context is off by default');
  assert.equal(noEnv(o.settings), undefined);
  const pre = o.hooks.PreToolUse.find((e: any) => e.matcher === 'Read|Edit|Write|MultiEdit|NotebookEdit');
  assert.ok(pre, 'bounded-Read PreToolUse hook installed');
  assert.deepEqual(readThreadFlags(threadId), { safeTools: true });
});

test('a resumed LEGACY thread keeps its full tool list; a resumed new thread keeps the subset (a live thread\'s tools never change)', async () => {
  const legacy = makeDriver(); const legacyId = tid('S2');
  await legacy.driver.startSession({ threadId: legacyId, agent: 'claude', cwd: '/r', account: null, resume: 'sess-old' });
  assert.equal(legacy.options().disallowedTools, undefined);
  assert.equal(legacy.options().env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, undefined);
  const a = makeDriver(); const id = tid('S3');
  await a.driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null });
  const b = makeDriver();
  await b.driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null, resume: 'sess-new' });
  assert.ok(b.options().disallowedTools.includes('CronCreate'));
});

test('Lean context (opt-in) hides skills and auto-memory for a new thread only, and sticks to it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-lean-')); fs.mkdirSync(path.join(dir, 'x'));
  const prev = process.env.KORA_LEAN_CONTEXT;
  process.env.KORA_LEAN_CONTEXT = '1';
  try {
    const { driver, options } = makeDriver(); const id = tid('L1');
    await driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null });
    assert.deepEqual(options().skills, []);
    assert.deepEqual(noEnv(options().settings), { autoMemoryEnabled: false });
    assert.deepEqual(readThreadFlags(id), { safeTools: true, lean: true });
    process.env.KORA_LEAN_CONTEXT = '0'; // the user switches it off: the already-started thread resumes the way it began
    const r = makeDriver();
    await r.driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null, resume: 's' });
    assert.deepEqual(r.options().skills, []);
  } finally { if (prev === undefined) delete process.env.KORA_LEAN_CONTEXT; else process.env.KORA_LEAN_CONTEXT = prev; }
});

test('the assistant (blob) lane gets none of it', async () => {
  const { driver, options } = makeDriver();
  const blobCwd = path.join(os.homedir(), 'Blobs', 'someone');
  await driver.startSession({ threadId: tid('B'), agent: 'claude', cwd: blobCwd, account: null });
  assert.equal(options().disallowedTools, undefined);
  assert.equal(options().hooks?.PreToolUse?.some((e: any) => e.matcher?.startsWith('Read|')) ?? false, false);
});

test('mergeLaneOptions: lane options merge instead of the last spread winning', () => {
  const o = mergeLaneOptions({ disallowedTools: ['Agent'], settings: { autoMemoryEnabled: false } }, { koraHooks: { PreToolUse: [] }, safeTools: true, lean: true });
  assert.deepEqual(o.disallowedTools, ['Agent', ...SAFE_DISALLOWED_TOOLS]);
  assert.deepEqual(noEnv(o.settings), { hooks: { PreToolUse: [] }, autoMemoryEnabled: false });
  const none = mergeLaneOptions({ a: 1 }, { koraHooks: null, safeTools: false, lean: false });
  assert.deepEqual(none, { a: 1 });
  assert.deepEqual(SAFE_TOOLS_ENV, { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1' });
});

test('a swarm leader in an UNTRUSTED folder keeps Kora\'s own hooks beside its lean settings', () => {
  const o = buildSessionOptions({ threadId: 'T', agent: 'claude', cwd: '/r', account: null, isOrchestrator: true, agentMode: 'swarm' } as any,
    { env: {}, notes: ['x'], appendSystemPrompt: 'rb' } as any, undefined, {}, { mcpServers: {}, canUseTool: () => {}, trusted: false, safeTools: true });
  assert.ok(o.settings.hooks && o.settings.hooks.PreToolUse, 'kora hooks present');
  assert.equal(o.settings.autoMemoryEnabled, false);
});

test('B3: a thread started in an unindexed repo is told once, in a user message, when the index lands', async () => {
  let indexed = false;
  const { driver, nextPrompt } = makeDriver({ graphStatus: async () => ({ indexed }) , appendSystemPrompt: () => undefined, prepareSession: async () => ({ env: {}, notes: ['n'], appendSystemPrompt: 'kora: this repo is not indexed yet, so there is no code graph' }) as any });
  const id = tid('N1');
  await driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null });
  assert.equal(readThreadFlags(id).noGraphRulebook, true);
  await driver.sendTurn({ threadId: id, text: 'add a flag' });
  assert.equal(await nextPrompt(), 'add a flag', 'still unindexed: nothing added');
  indexed = true;
  await new Promise((r) => setTimeout(r, 3100)); // the status check is throttled to once per 3 s
  await driver.sendTurn({ threadId: id, text: 'now explain handler' });
  const sent = await nextPrompt();
  assert.match(sent, /^kora: the code graph for this repository is ready now/);
  assert.ok(sent.endsWith('now explain handler'));
  assert.equal(readThreadFlags(id).noGraphRulebook, undefined);
  await driver.sendTurn({ threadId: id, text: 'and again' });
  assert.equal(await nextPrompt(), 'and again', 'only once');
});

test('cost telemetry: one line per API call with a cache verdict, tool result sizes; the SDK\'s repeated per-block messages count once', async () => {
  const { driver, push } = makeDriver(); const id = tid('C1');
  await driver.startSession({ threadId: id, agent: 'claude', cwd: '/r', account: null });
  const asst = (mid: string, usage: any, content: any[] = [{ type: 'text', text: 'x' }]) => ({ type: 'assistant', message: { id: mid, model: 'claude-sonnet-5-5', usage, content } });
  push(asst('m1', { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000, output_tokens: 10 }, [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]));
  push(asst('m1', { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000, output_tokens: 80 }, [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]));
  push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(5000) }] } });
  push(asst('m2', { input_tokens: 3, cache_read_input_tokens: 20000, cache_creation_input_tokens: 2000, output_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 2000 } }));
  push({ type: 'result', subtype: 'success', is_error: false, usage: {} });
  await flush(); await flush();
  await flushCostLog();
  const lines = readCostLog({ home: koraHome() }).filter((l) => l.thread === id);
  const calls = lines.filter((l) => l.k === 'call') as any[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].out, 80, 'final output of call 1');
  assert.equal(calls[0].cause, 'start'); assert.equal(calls[0].miss, false);
  assert.equal(calls[1].miss, false); assert.equal(calls[1].cc1h, 2000); assert.equal(calls[1].tools, 1);
  const tool = lines.find((l) => l.k === 'tool') as any;
  assert.equal(tool.tool, 'Read'); assert.equal(tool.bytes, 5000);
});

test('a bounded Read marks its tool.result so the card can say "read lines a-b of N"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-bd-'));
  const file = path.join(dir, 'big.ts');
  fs.writeFileSync(file, Array.from({ length: 700 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  process.env.KORA_BOUNDED_READS = 'on'; resetSavingsSettingsCache();
  try {
    const { driver, options, push, events } = makeDriver({ graphStatus: async () => ({ indexed: true }), graphCall: async () => ({ text: '', data: null, ms: 1 }) });
    const id = tid('R1');
    await driver.startSession({ threadId: id, agent: 'claude', cwd: dir, account: null });
    await driver.sendTurn({ threadId: id, text: 'how does the parser behave' });
    const hook = options().hooks.PreToolUse.find((e: any) => e.matcher?.startsWith('Read|')).hooks[0];
    const out = await hook({ tool_name: 'Read', tool_input: { file_path: file }, cwd: dir, tool_use_id: 'tuR' }, 'tuR');
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.updatedInput.file_path, file);
    assert.ok(out.hookSpecificOutput.updatedInput.limit >= 100);
    assert.match(out.hookSpecificOutput.additionalContext, /bounded to lines 1-250 of 700/);
    // the second Read of the same file passes through
    assert.deepEqual(await hook({ tool_name: 'Read', tool_input: { file_path: file }, cwd: dir }, 'tuR2'), {});
    push({ type: 'assistant', message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tuR', name: 'Read', input: { file_path: file } }] } });
    push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tuR', content: 'ok' }] } });
    await flush(); await flush();
    const res = events.find((e) => e.type === 'tool.result' && (e as any).itemId === 'tuR') as any;
    assert.deepEqual(res.bounded, { path: file, offset: 1, limit: 250, total: 700 });
  } finally { delete process.env.KORA_BOUNDED_READS; resetSavingsSettingsCache(); }
});

test('bounded Read off (the setting) or a failing graph passes the original input through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-bd2-'));
  const file = path.join(dir, 'big.ts');
  fs.writeFileSync(file, Array.from({ length: 700 }, (_, i) => `// ${i}`).join('\n') + '\n');
  const run = async (mode: string, deps: Partial<DriverDeps> = {}) => {
    process.env.KORA_BOUNDED_READS = mode; resetSavingsSettingsCache();
    const { driver, options } = makeDriver({ graphStatus: async () => ({ indexed: true }), ...deps });
    await driver.startSession({ threadId: tid('R2'), agent: 'claude', cwd: dir, account: null });
    const hook = options().hooks.PreToolUse.find((e: any) => e.matcher?.startsWith('Read|')).hooks[0];
    return hook({ tool_name: 'Read', tool_input: { file_path: file }, cwd: dir }, 'x');
  };
  try {
    assert.deepEqual(await run('off'), {});
    assert.deepEqual(await run('on', { graphStatus: async () => { throw new Error('graph down'); } }), {}, 'a status failure fails open');
    const shadow = await run('shadow');
    assert.deepEqual(shadow, {}, 'shadow mode rewrites nothing');
  } finally { delete process.env.KORA_BOUNDED_READS; resetSavingsSettingsCache(); }
});

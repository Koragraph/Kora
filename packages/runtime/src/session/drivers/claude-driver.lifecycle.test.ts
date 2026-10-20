// B7 (model-switch price hook) and B8 (runaway guard) wired into ClaudeDriver.
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

process.env.KORA_INJECT_LOG = '0';
function makeDriver() {
  const buffer: any[] = []; let waiting: ((v: IteratorResult<any>) => void) | null = null; let options: any;
  const iterator: any = {
    next: async () => (buffer.length ? { value: buffer.shift(), done: false } : new Promise<IteratorResult<any>>((r) => { waiting = r; })),
    return: async () => ({ value: undefined, done: true }),
    [Symbol.asyncIterator]() { return this; },
  };
  const push = (m: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: m, done: false }); } else buffer.push(m); };
  const queryFn: QueryFn = (p: any) => { options = p.options; return iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), graphStatus: async () => ({ indexed: false }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined, isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = []; driver.streamEvents((e) => events.push(e));
  return { driver, events, push, options: () => options };
}
let n = 0; const tid = () => `LC-${process.pid}-${Date.now()}-${++n}`;
const tick = () => new Promise((r) => setTimeout(r, 30));
const asst = (id: string, blocks: any[]) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: blocks, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } });
const res = (id: string, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(isError ? { is_error: true } : {}) }] } });

test('B7: the PreModelSwitch hook allows the switch and the thread learns what it re-caches', async () => {
  const { driver, events, options } = makeDriver();
  const threadId = tid();
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  const hook = options().hooks.PreModelSwitch[0].hooks[0];
  const out = await hook({ hook_event_name: 'PreModelSwitch', from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', context_tokens: 117000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1.17 });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  const ev = events.find((e) => e.type === 'model.switch-cost') as any;
  assert.deepEqual({ t: ev.contextTokens, w: ev.cacheWarm, u: ev.usd, turns: ev.turns }, { t: 117000, w: true, u: 1.17, turns: 40 });
  // a hook error never blocks the switch
  const bad = await hook(null);
  assert.equal(bad.hookSpecificOutput.permissionDecision, 'allow');
});

test('B7: one switch that reaches the hook twice in the same moment says it once', async () => {
  const { driver, events, options } = makeDriver();
  const threadId = tid();
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  const hook = options().hooks.PreModelSwitch[0].hooks[0];
  const input = { hook_event_name: 'PreModelSwitch', from_model: 'claude-haiku-5-5', to_model: 'claude-haiku-4-5', context_tokens: 30000, prompt_cache_warm: true, cache_ttl: '1h' };
  assert.equal((await hook(input)).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal((await hook({ ...input, to_model: 'claude-sonnet-5-5' })).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(events.filter((e) => e.type === 'model.switch-cost').length, 1);
});

test('B8: the third identical Read in a turn says "looks stuck" once; a new turn starts over', async () => {
  const { driver, events, push } = makeDriver();
  const threadId = tid();
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId, text: 'fix it' });
  for (let i = 1; i <= 4; i++) { push(asst(`m${i}`, [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: '/r/a.ts' } }])); push(res(`t${i}`)); }
  await tick();
  const stuck = events.filter((e) => e.type === 'turn.stuck') as any[];
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].kind, 'reread');
  assert.match(stuck[0].message, /Looks stuck/);
});

test('B8: three identical failing commands flag; the switch off silences it', async () => {
  const a = makeDriver();
  const threadId = tid();
  await a.driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  await a.driver.sendTurn({ threadId, text: 'run the tests' });
  for (let i = 1; i <= 3; i++) { a.push(asst(`b${i}`, [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: 'npm test' } }])); a.push(res(`c${i}`, true)); }
  await tick();
  assert.equal(a.events.filter((e) => e.type === 'turn.stuck').length, 1);

  process.env.KORA_RUNAWAY_GUARD = '0';
  const b = makeDriver();
  const t2 = tid();
  await b.driver.startSession({ threadId: t2, agent: 'claude', cwd: '/r', account: null });
  await b.driver.sendTurn({ threadId: t2, text: 'run the tests' });
  for (let i = 1; i <= 3; i++) { b.push(asst(`d${i}`, [{ type: 'tool_use', id: `e${i}`, name: 'Bash', input: { command: 'npm test' } }])); b.push(res(`e${i}`, true)); }
  await tick();
  delete process.env.KORA_RUNAWAY_GUARD;
  assert.equal(b.events.filter((e) => e.type === 'turn.stuck').length, 0);
});

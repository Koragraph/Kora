// ClaudeDriver context meter + plan usage, from recorded SDK shapes (0.3.286). The SDK is faked — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

function makeDriver(extra: Record<string, unknown> = {}) {
  const buffer: any[] = [];
  let waiting: ((v: IteratorResult<any>) => void) | null = null;
  const calls = { context: 0, usage: 0 };
  const iterator: any = {
    async next() { if (buffer.length) return { value: buffer.shift(), done: false }; return new Promise<IteratorResult<any>>((r) => { waiting = r; }); },
    async return() { return { value: undefined, done: true }; },
    async throw(e: any) { throw e; },
    [Symbol.asyncIterator]() { return this; },
    async getContextUsage() { calls.context++; return { totalTokens: 42_850 + calls.context * 1000, maxTokens: 1_000_000, percentage: 4, autoCompactThreshold: 967_000, isAutoCompactEnabled: true, categories: [] }; },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      calls.usage++;
      return { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 50, resets_at: '2026-10-01T23:00:00Z', scope: null }] } };
    },
    ...extra,
  };
  const push = (msg: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); } else buffer.push(msg); };
  const queryFn: QueryFn = () => iterator;
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  return { driver, events, push, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const usageEvents = (events: ChatEvent[]) => events.filter((e) => e.type === 'thread.token-usage') as any[];

test('the meter starts at session start from Claude Code\'s own /context numbers', async () => {
  const { driver, events, calls } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null, model: { model: 'sonnet' } } as any);
  await settle();
  assert.equal(calls.context, 1);
  const [u] = usageEvents(events);
  assert.deepEqual(u.usage, { usedTokens: 43_850, maxTokens: 1_000_000, autoCompactThreshold: 967_000, compactsAutomatically: true, source: 'provider' });
});

test('assistant usage → an estimate incl. cache reads, once per API message; a result → cost + a fresh /context', async () => {
  const { driver, events, push, calls } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null, model: { model: 'sonnet' } } as any);
  await settle();
  await driver.sendTurn({ threadId: 'T', text: 'hello' } as any);
  const usage = { input_tokens: 6, cache_read_input_tokens: 41_200, cache_creation_input_tokens: 1_300, output_tokens: 250 };
  // the SDK repeats one API message per content block: same id, same usage
  push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', usage, content: [{ type: 'thinking', thinking: '…' }] } });
  push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', usage, content: [{ type: 'text', text: 'hi' }] } });
  await settle();
  const est = usageEvents(events).filter((e) => e.usage.source === 'estimate');
  assert.equal(est.length, 1);
  assert.equal(est[0].usage.usedTokens, 42_756);
  assert.equal(est[0].usage.maxTokens, 1_000_000, 'the window learned from /context at start');
  assert.equal(est[0].usage.cachedInputTokens, 42_500);
  assert.ok(est[0].turnId, 'tied to the running turn');
  push({ type: 'result', subtype: 'success', is_error: false, result: 'hi', usage, total_cost_usd: 0.0123, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 6, cacheReadInputTokens: 41_200, cacheCreationInputTokens: 1_300, outputTokens: 250, contextWindow: 1_000_000 } } });
  await settle();
  assert.equal(calls.context, 2);
  const last = usageEvents(events).at(-1);
  assert.equal(last.usage.source, 'provider');
  assert.equal(last.usage.costUsd, 0.0123);
  assert.equal(last.usage.usedTokens, 44_850);
});

test('live cost: moves during a turn (list-price estimate on top of the last result) and the final turn\'s cost lands even if /context fails', async () => {
  let failContext = false;
  const { driver, events, push } = makeDriver({ async getContextUsage() { if (failContext) throw new Error('boom'); return { totalTokens: 1000, maxTokens: 1_000_000, percentage: 0, autoCompactThreshold: 967_000, isAutoCompactEnabled: true, categories: [] }; } });
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null, model: { model: 'sonnet' } } as any);
  await settle();
  const usage1 = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_000, output_tokens: 100 };
  await driver.sendTurn({ threadId: 'T', text: 'one' } as any);
  push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5-5', usage: usage1, content: [] } });
  await settle();
  const turn1Live = usageEvents(events).filter((e) => e.usage.source === 'estimate').at(-1).usage.costUsd;
  // 10 in @2 + 10000 write @4 + 100 out @10, per million
  assert.ok(Math.abs(turn1Live - (10 * 2 + 10_000 * 4 + 100 * 10) / 1e6) < 1e-9, `first turn live cost ${turn1Live}`);
  failContext = true;
  push({ type: 'result', subtype: 'success', is_error: false, result: 'x', usage: usage1, total_cost_usd: 0.05, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 10_000, outputTokens: 100, contextWindow: 1_000_000 } } });
  await settle();
  // the /context refresh failed, yet the settled cost went out with the result
  assert.equal(usageEvents(events).at(-1).usage.costUsd, 0.05);
  // turn 2: the estimate rides on the settled 0.05, not on nothing
  await driver.sendTurn({ threadId: 'T', text: 'two' } as any);
  push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } });
  await settle();
  const live2 = usageEvents(events).filter((e) => e.usage.source === 'estimate').at(-1).usage.costUsd;
  assert.ok(Math.abs(live2 - (0.05 + (10 * 2 + 10_000 * 0.1 + 100 * 10) / 1e6)) < 1e-9, `second turn live cost ${live2}`);
});

test('a subagent / sidechain message never moves the meter', async () => {
  const { driver, events, push } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  await settle();
  const before = usageEvents(events).length;
  push({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'msg_s', usage: { input_tokens: 999_999 }, content: [] } });
  await settle();
  assert.equal(usageEvents(events).length, before);
});

test('rate_limit_event: allowed → a usage window; rejected → a rate-limit with its reset', async () => {
  const { driver, events, push } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1_791_000_000 }, uuid: 'u', session_id: 's' });
  push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1_791_000_000 }, uuid: 'u2', session_id: 's' });
  await settle();
  const limits = events.filter((e) => e.type === 'usage.limits') as any[];
  assert.equal(limits.length, 2);
  assert.equal(limits[0].report.windows[0].usedPercent, 50);
  assert.equal(limits[1].report.limited, true);
  const rl = events.filter((e) => e.type === 'usage.rate-limit') as any[];
  assert.equal(rl.length, 1);
  assert.equal(rl[0].resetsAt, 1_791_000_000_000);
  assert.match(rl[0].message, /5-hour session/);
});

test('readPlanUsage asks a live session (no turn) and maps the windows; null with no session', async () => {
  const { driver, calls } = makeDriver();
  assert.equal(await driver.readPlanUsage(), null);
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  const r = await driver.readPlanUsage();
  assert.equal(calls.usage, 1);
  assert.equal(r?.plan, 'Max');
  assert.deepEqual(r?.windows.map((w) => [w.id, w.usedPercent]), [['five_hour', 50]]);
});

test('a slash command reaches Claude Code first: no graph injection or notice in front of /compact', async () => {
  const pushed: any[] = [];
  const { driver } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  const state = (driver as any).sessions.get('T');
  const orig = state.push;
  state.push = (m: any) => { pushed.push(m); orig(m); };
  await driver.sendTurn({ threadId: 'T', text: '/compact', koraNotice: '[kora] mode changed' } as any);
  assert.equal(pushed[0].message.content, '/compact');
});

test('a compaction is announced with its before/after, and the next /context read counts afresh', async () => {
  const details: string[] = [];
  const { driver, events, push } = makeDriver({
    async getContextUsage(opts: any) { details.push(opts?.detail); return { totalTokens: 33_000, maxTokens: 1_000_000, categories: [] }; },
  });
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  await settle();
  await driver.sendTurn({ threadId: 'T', text: '/compact' } as any);
  push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 32_829, post_tokens: 1_124 } });
  push({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
  await settle();
  const c = events.find((e) => e.type === 'context.compacted') as any;
  assert.deepEqual([c.trigger, c.preTokens, c.postTokens], ['manual', 32_829, 1_124]);
  assert.deepEqual(details, ['summary', 'full']);
});

test('a reply Claude Code writes itself (synthetic message, no stream events) reaches the chat', async () => {
  const { driver, events, push } = makeDriver();
  await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  await driver.sendTurn({ threadId: 'T', text: '/compact' } as any);
  // recorded (SDK 0.3.286): /compact on an empty conversation
  push({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' });
  push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'syn-1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not enough messages to compact.' }], usage: { input_tokens: 0, output_tokens: 0 } } });
  await settle();
  const d = events.filter((e) => e.type === 'content.delta') as any[];
  assert.equal(d.length, 1);
  assert.equal(d[0].delta, 'Not enough messages to compact.');
  assert.ok(d[0].turnId);
});

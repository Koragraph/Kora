import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETURN_DIST, analyzeBody, cacheControlTtls, conditionalReturn, estTokens, parseReturnDist, prefixSizes, priceRatios,
  refreshIntervalMs, shouldWarm, streamKeyOf, warmBody, TTL_MS,
} from './policy';

const HAIKU = 'claude-haiku-4-5-20251001';
const body = (over: Record<string, any> = {}) => ({
  model: HAIKU, max_tokens: 4096, stream: true,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=abc;' }, { type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 'Bash', description: 'run', input_schema: {} }, { name: 'mcp__kora__spawn', description: 'x', input_schema: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  ...over,
});

test('price ratios: Opus/Sonnet 5.5 read at 0.05, others 0.1; 1h writes 2x, 5m 1.25x', () => {
  assert.deepEqual(priceRatios('claude-sonnet-5-5', '1h'), { read: 0.05, write: 2, output: 5 });
  assert.deepEqual(priceRatios('claude-opus-5.5', '5m'), { read: 0.05, write: 1.25, output: 5 });
  assert.equal(priceRatios(HAIKU, '1h').read, 0.1);
});

test('shouldWarm: break-even is a return probability, not a clock', () => {
  const r = priceRatios('claude-sonnet-5-5', '1h');
  const at = (idleMin: number, ctx = 50_000, dist = DEFAULT_RETURN_DIST) => shouldWarm({ idleMs: idleMin * 60_000, ttl: '1h', ctxTokens: ctx, ratios: r, dist });
  assert.equal(at(54).warm, true, 'a user silent for 54 min has a real chance of coming back inside the next window');
  assert.equal(at(54, 3_000).reason, 'too-small');
  assert.equal(at(130).reason, 'past-horizon');
  // a distribution where nobody ever returns after the first hour never warms
  const never = parseReturnDist({ bins: [{ fromMin: 0, toMin: 30, p: 0.99 }, { fromMin: 30, toMin: 55, p: 0.0001 }], horizonMin: 120, minCtxTokens: 4000 }, DEFAULT_RETURN_DIST);
  assert.equal(at(54, 50_000, never).warm, false);
  assert.equal(at(54, 50_000, never).reason, 'unlikely-return');
});

test('a 5-minute entry is refreshed at 0.9 x TTL', () => {
  assert.equal(refreshIntervalMs('5m'), 0.9 * TTL_MS['5m']);
  assert.equal(refreshIntervalMs('1h'), 0.9 * TTL_MS['1h']);
});

test('conditionalReturn stays in [0,1] and never throws on odd input', () => {
  for (const idle of [0, 1, 60_000, 3_600_000, 1e12]) {
    const p = conditionalReturn(DEFAULT_RETURN_DIST, idle, 3_240_000);
    assert.ok(p >= 0 && p <= 1, String(p));
  }
});

test('parseReturnDist falls back on anything malformed', () => {
  for (const bad of [null, 5, 'x', {}, { bins: [] }, { bins: [{ fromMin: 0, toMin: 5, p: 2 }] }, { bins: [{ fromMin: 0, toMin: 5, p: 0.5 }, { fromMin: 3, toMin: 10, p: 0.1 }] }]) {
    assert.equal(parseReturnDist(bad, DEFAULT_RETURN_DIST), DEFAULT_RETURN_DIST);
  }
});

test('cacheControlTtls: finds markers anywhere, absent ttl is 5m', () => {
  assert.deepEqual(cacheControlTtls(body()), ['1h', '1h']);
  const b = body({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] }] }] });
  assert.deepEqual(cacheControlTtls(b), ['1h', '5m']);
});

test('analyzeBody: replayable only for one ttl and a verified shape', () => {
  assert.deepEqual(analyzeBody(body()), { ok: true, ttl: '1h', model: HAIKU });
  assert.equal(analyzeBody(body({ thinking: { type: 'enabled', budget_tokens: 2000 } })).ok, true);
  assert.equal(analyzeBody(body({ model: 'claude-haiku-5-5', thinking: { type: 'adaptive' } })).ok, true, 'haiku 5.5 adaptive thinking is a verified shape');
  assert.equal(analyzeBody(body({ model: 'claude-opus-5-5' })).ok, false, 'an unverified shape (opus without thinking) fails closed');
  assert.equal(analyzeBody(body({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', display: 'omitted' } })).ok, true, 'opus/sonnet adaptive were checked live');
  assert.equal(analyzeBody(body({ tool_choice: { type: 'tool', name: 'Bash' } })).reason, 'forced-tool-choice');
  assert.equal(analyzeBody(body({ output_config: { format: { type: 'json_schema' } } })).reason, 'output-format');
  const mixed = body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] }] });
  assert.equal(analyzeBody(mixed).reason, 'mixed-or-unknown-ttl');
  // the title call: no cache_control at all
  assert.equal(analyzeBody({ model: HAIKU, max_tokens: 100, system: 'title', messages: [{ role: 'user', content: 'hi' }] }).reason, 'no-cache-marker');
  assert.equal(analyzeBody(null as any).ok, false);
});

test('warmBody changes only max_tokens and stream', () => {
  const b = body();
  const w = warmBody(b);
  assert.equal(w.max_tokens, 0); assert.equal(w.stream, false);
  assert.deepEqual({ ...w, max_tokens: b.max_tokens, stream: b.stream }, b);
  assert.equal(b.max_tokens, 4096, 'the original is untouched');
});

test('streamKeyOf: stable across the billing header and later messages, different for another conversation', () => {
  const a = body();
  const b = body({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=OTHER;' }, a.system[1]], messages: [...a.messages, { role: 'assistant', content: 'hi' }] });
  assert.equal(streamKeyOf(a), streamKeyOf(b));
  assert.notEqual(streamKeyOf(a), streamKeyOf(body({ messages: [{ role: 'user', content: 'different' }] })));
  assert.match(streamKeyOf(a), /^[0-9a-f]{16}$/);
});

test('prefixSizes groups builtin and MCP tools; estTokens is chars/3.5', () => {
  const p = prefixSizes(body());
  assert.equal(p.toolCount, 2);
  assert.ok(p.system > 0 && p.tools > 0);
  assert.deepEqual(Object.keys(p.groups).sort(), ['builtin', 'mcp__kora']);
  assert.equal(estTokens(350), 100);
});

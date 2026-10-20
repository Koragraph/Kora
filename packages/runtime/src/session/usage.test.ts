// Context-window and plan-limit maths, from recorded provider shapes (Claude Agent SDK 0.3.286, codex-cli 0.155.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeContextTokens, claudeContextUsageToTokenUsage, claudeRateLimitEventReport, claudeResultContextWindow,
  claudeUsageReport, codexAppServerRateLimitsReport, codexRateLimitsReport, codexRolloutUsage, knownClaudeContextWindow,
  parseUsageLimitMessage, toEpochMs,
} from './usage';

test('claudeContextTokens counts cache reads and writes — the bulk of a cached context', () => {
  assert.equal(claudeContextTokens({ input_tokens: 6, cache_read_input_tokens: 41_200, cache_creation_input_tokens: 1_300, output_tokens: 250 }), 42_756);
  assert.equal(claudeContextTokens({ input_tokens: 10 }), 10);
  assert.equal(claudeContextTokens({}), undefined);
  assert.equal(claudeContextTokens(null), undefined);
});

test('context window: [1m] ids are known up front; modelUsage names the window of the model that answered', () => {
  assert.equal(knownClaudeContextWindow('claude-opus-5-5[1m]'), 1_000_000);
  assert.equal(knownClaudeContextWindow('sonnet'), undefined);
  const modelUsage = {
    'claude-haiku-4-5-20251001': { inputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200_000 },
    'claude-sonnet-5-5': { inputTokens: 12, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 0, contextWindow: 1_000_000 },
  };
  assert.equal(claudeResultContextWindow(modelUsage, 'claude-sonnet-5-5'), 1_000_000);
  assert.equal(claudeResultContextWindow(modelUsage, 'sonnet'), 1_000_000); // alias: falls back to the biggest window used
  assert.equal(claudeResultContextWindow(modelUsage, 'claude-haiku-4-5-20251001'), 200_000);
  assert.equal(claudeResultContextWindow({}, 'x'), undefined);
});

test('getContextUsage (recorded, Sonnet 5.5, no turn yet) → provider-sourced usage', () => {
  const resp = { totalTokens: 42_850, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 4, model: 'claude-sonnet-5-5', autoCompactThreshold: 967_000, isAutoCompactEnabled: true, categories: [] };
  assert.deepEqual(claudeContextUsageToTokenUsage(resp), {
    usedTokens: 42_850, maxTokens: 1_000_000, autoCompactThreshold: 967_000, compactsAutomatically: true, source: 'provider',
  });
  assert.equal(claudeContextUsageToTokenUsage({ maxTokens: 5 }), null);
});

test('claudeUsageReport reads the limits[] rows (recorded Max account)', () => {
  const resp = {
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 50, resets_at: '2026-10-01T23:00:00.076596+00:00' },
      seven_day: { utilization: 4, resets_at: '2026-10-08T21:00:00.076619+00:00' },
      limits: [
        { kind: 'session', group: 'session', percent: 50, resets_at: '2026-10-01T23:00:00.076596+00:00', scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 4, resets_at: '2026-10-08T21:00:00.076619+00:00', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-10-08T21:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
      ],
    },
  };
  const r = claudeUsageReport(resp)!;
  assert.equal(r.plan, 'Max');
  assert.equal(r.complete, true);
  assert.equal(r.limited, undefined);
  assert.deepEqual(r.windows.map((w) => [w.id, w.kind, w.label, w.usedPercent]), [
    ['five_hour', 'session', '5-hour session', 50],
    ['seven_day', 'weekly', 'Weekly · all models', 4],
    ['seven_day_fable', 'weekly', 'Weekly · Fable', 0],
  ]);
  assert.equal(r.windows[0]!.resetsAt, Date.parse('2026-10-01T23:00:00.076Z'));
});

test('claudeUsageReport: named windows when limits[] is absent; API-key accounts report no windows', () => {
  const r = claudeUsageReport({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: '2026-10-02T01:00:00Z' }, seven_day_opus: { utilization: 12, resets_at: null }, model_scoped: [{ display_name: 'Opus', utilization: 99, resets_at: null }] } })!;
  assert.deepEqual(r.windows.map((w) => w.id), ['five_hour', 'seven_day_opus']); // model_scoped Opus dedupes onto seven_day_opus
  assert.equal(r.limited, true);
  assert.deepEqual(claudeUsageReport({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { provider: 'claude', windows: [], complete: true });
});

test('rate_limit_event: fraction utilization → percent; rejected = limited with its reset', () => {
  const ok = claudeRateLimitEventReport({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_791_000_000 })!;
  assert.deepEqual(ok.windows, [{ id: 'five_hour', kind: 'session', label: '5-hour session', windowMinutes: 300, usedPercent: 42, resetsAt: 1_791_000_000_000 }]);
  assert.equal(ok.limited, undefined);
  const hit = claudeRateLimitEventReport({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_791_000_000 })!;
  assert.equal(hit.limited, true);
  assert.equal(hit.resetsAt, 1_791_000_000_000);
  // a rejection without a utilization still names its window, at its limit
  assert.deepEqual(hit.windows.map((w) => [w.id, w.usedPercent]), [['seven_day_opus', 100]]);
  assert.equal(claudeRateLimitEventReport({ status: 'allowed' }), null);
});

test('Codex app-server account/rateLimits/read (recorded, free plan, limit hit)', () => {
  const result = {
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1792162517 }, secondary: null, planType: 'free', rateLimitReachedType: 'rate_limit_reached' },
  };
  const r = codexAppServerRateLimitsReport(result)!;
  assert.equal(r.provider, 'codex');
  assert.equal(r.plan, 'Free');
  assert.equal(r.limited, true);
  assert.equal(r.resetsAt, 1_792_162_517_000);
  assert.deepEqual(r.windows, [{ id: 'primary', kind: 'monthly', label: 'Monthly', usedPercent: 100, resetsAt: 1_792_162_517_000, windowMinutes: 43200 }]);
});

test('Codex exec/rollout snake_case snapshot (recorded Plus account)', () => {
  const r = codexRateLimitsReport({ limit_id: 'codex', primary: { used_percent: 1.0, window_minutes: 10080, resets_at: 1786356596 }, secondary: { used_percent: 33, window_minutes: 300, resets_at: 1786300000 }, plan_type: 'plus', rate_limit_reached_type: null })!;
  assert.equal(r.plan, 'Plus');
  assert.equal(r.limited, undefined);
  assert.deepEqual(r.windows.map((w) => [w.id, w.kind, w.label, w.usedPercent]), [['primary', 'weekly', 'Weekly', 1], ['secondary', 'session', '5-hour window', 33]]);
  // an account that reports nothing at all (recorded: info null, primary/secondary null, no plan)
  assert.equal(codexRateLimitsReport({ limit_id: 'premium', primary: null, secondary: null, plan_type: null, rate_limit_reached_type: null }), null);
});

test('codexRolloutUsage reads the LAST token_count: last request = context, model_context_window = max', () => {
  const lines = [
    '{"type":"session_meta","payload":{"id":"x"}}',
    '{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11},"last_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11},"model_context_window":258400},"rate_limits":null}}',
    '{"timestamp":"2026-09-29T10:48:01.552Z","ordinal":67,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":91176,"cached_input_tokens":77312,"cache_write_input_tokens":0,"output_tokens":408,"reasoning_output_tokens":77,"total_tokens":91584},"last_token_usage":{"input_tokens":15781,"cached_input_tokens":15104,"cache_write_input_tokens":0,"output_tokens":36,"reasoning_output_tokens":13,"total_tokens":15817},"model_context_window":258400},"rate_limits":{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":null},"individual_limit":null,"spend_control_reached":null,"plan_type":"free","rate_limit_reached_type":null}}}',
    '',
  ];
  const { context, limits } = codexRolloutUsage(lines);
  assert.deepEqual(context, { usedTokens: 15817, maxTokens: 258400, inputTokens: 91176, cachedInputTokens: 77312, outputTokens: 408, totalProcessedTokens: 91584, compactsAutomatically: true, source: 'provider' });
  assert.deepEqual(limits, { provider: 'codex', windows: [], complete: true, plan: 'Free' });
  assert.deepEqual(codexRolloutUsage(['garbage', '{"type":"x"}']), { context: null, limits: null });
});

test('parseUsageLimitMessage: Codex "try again at …" (recorded) and Claude "limit reached|epoch"', () => {
  const codex = 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 16th, 2026 8:25 PM.';
  assert.deepEqual(parseUsageLimitMessage(codex), { resetsAt: new Date(2026, 9, 16, 20, 25).getTime() });
  assert.deepEqual(parseUsageLimitMessage('Claude AI usage limit reached|1791000000'), { resetsAt: 1_791_000_000_000 });
  assert.deepEqual(parseUsageLimitMessage("You've hit your limit · resets 5pm (Asia/Calcutta)"), {});
  assert.equal(parseUsageLimitMessage('codex exited (code 1)'), null);
  assert.equal(parseUsageLimitMessage(''), null);
});

test('toEpochMs: seconds, ms and ISO', () => {
  assert.equal(toEpochMs(1_792_162_517), 1_792_162_517_000);
  assert.equal(toEpochMs(1_792_162_517_000), 1_792_162_517_000);
  assert.equal(toEpochMs('2026-10-08T21:00:00Z'), Date.parse('2026-10-08T21:00:00Z'));
  assert.equal(toEpochMs(null), undefined);
});

test('session cost: Haiku 5.5 rows are re-priced (the bundled CLI prices them like Opus), others kept (pl2 S3-5)', async () => {
  const { claudeResultCostUsd } = await import('./usage');
  // pl2-a's first Haiku 5.5 pong: 28,466 cache-write tokens reported as $0.229.
  const haiku = { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 28_466, costUSD: 0.229 } };
  const fixed = claudeResultCostUsd(0.229, haiku)!;
  assert.ok(fixed > 0.004 && fixed < 0.008, `about $0.006 at Haiku 5.5 list rates, got ${fixed}`);
  // A mixed session keeps the SDK's own price for the model it knows.
  const mixed = { ...haiku, 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 0.1 } };
  assert.ok(Math.abs(claudeResultCostUsd(0.329, mixed)! - (fixed + 0.1)) < 1e-9);
  assert.equal(claudeResultCostUsd(0.5, { 'claude-opus-5-5': { costUSD: 0.5 } }), 0.5);
  assert.equal(claudeResultCostUsd(0, haiku), undefined);
});

test('price table: list prices, specific model rows first (Opus 5.5 is $4/$20, not $15/$75)', async () => {
  const { priceFor } = await import('../ledger/transcript');
  assert.deepEqual([priceFor('claude-opus-5-5').in, priceFor('claude-opus-5-5').out], [4, 20]);
  assert.deepEqual([priceFor('claude-opus-4-8').in, priceFor('claude-opus-4-8').out], [5, 25]);
  assert.deepEqual([priceFor('claude-sonnet-5-5').in, priceFor('claude-sonnet-5-5').out], [2, 10]);
  assert.equal(priceFor('claude-sonnet-4-6').in, 3);
  assert.equal(priceFor('claude-haiku-5-5').in, 0.1);
  assert.equal(priceFor('claude-haiku-4-5-20251001').in, 1);
  assert.equal(priceFor('claude-fable-5-1').out, 50);
});

test('claudeResultCostUsd: Haiku 5.5 rows are re-priced (the SDK prices it as an unknown model, ~40x too high); measured 2026-10-15', async () => {
  const { claudeResultCostUsd } = await import('./usage');
  // First result of an isolated Haiku 5.5 session: SDK total 0.126529 = haiku-5-5 row 0.125564 (costBasis "unknown") + a
  // haiku-4.5 side call 0.000965 (costBasis "list"). At list price the haiku-5-5 row is 2*0.1 + 15687*0.2 + 3*0.5 = 3139 µ$.
  const cost = claudeResultCostUsd(0.126529, {
    'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 13, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000965 },
    'claude-haiku-5-5': { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 15687, costUSD: 0.125564 },
  });
  assert.ok(cost !== undefined && Math.abs(cost - (0.000965 + 0.0031391)) < 1e-6, `got ${cost}`);
});

test('claudeResultCostUsd: Sonnet 5.5 rows are re-priced (the SDK bills its cache reads at $0.20/M, the page says $0.10/M)', async () => {
  const { claudeResultCostUsd } = await import('./usage');
  // SAV-E's 2-turn Sonnet 5.5 session: SDK costUSD 0.0800302 = 4 in @2 + 19,449 writes @4 + 10,831 reads @0.20 + 6 out @10.
  const cost = claudeResultCostUsd(0.0800302, {
    'claude-sonnet-5-5': { inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 10_831, cacheCreationInputTokens: 19_449, costUSD: 0.0800302 },
  });
  assert.ok(cost !== undefined && Math.abs(cost - (0.0800302 - 10_831 * 0.1 / 1e6)) < 1e-9, `got ${cost}`);
});

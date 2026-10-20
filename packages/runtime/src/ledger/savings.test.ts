import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLedgers, CarryPricer, GRAPH_ROUND_TRIPS, KORA_PREFIX_TOKENS, mergeDays, resetSavingsMemoForTests, SAFE_TOOLS_TOKENS, savingsReport, SUBAGENT_TOOLS_TOKENS } from './savings';
import type { CostLine } from '../util/cost-log';

// Sonnet 4.x list prices ($/M): write 6, read 0.3, out 15.
const M = 'claude-sonnet-4-6';
const call = (ts: number, ctx: number, o: Partial<{ cr: number; cc: number; miss: boolean; out: number }> = {}): CostLine =>
  ({ k: 'call', ts, thread: 't1', model: M, ctx, in: 0, cr: o.cr ?? ctx, cc: o.cc ?? 0, out: o.out ?? 0, miss: o.miss ?? false });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
/** One lever's events (a Claude thread also books the delegation tools Kora removes, as trims, on every call). */
const lever = (l: { events: { lever: string; usd: number }[] }, k: string) => l.events.filter((e) => e.lever === k);

test('a token kept out is worth one write plus a read on every later call of its segment', () => {
  const p = new CarryPricer([call(1, 10_000), call(2, 11_000), call(3, 12_000), call(4, 13_000)] as any);
  near(p.perToken(2), (6 + 0.3 + 0.3) / 1e6); // carried by call 2, then read by calls 3 and 4
  near(p.perToken(5), 0); // after the last call: never paid for
});

test('a compaction ends the carry, and a miss re-writes instead of reading', () => {
  const p = new CarryPricer([call(1, 50_000), call(2, 52_000, { miss: true }), call(3, 10_000), call(4, 11_000)] as any);
  near(p.perToken(1), (6 + 6) / 1e6); // write at 1, re-written by the miss at 2, gone at the compaction (3)
});

test('bounded reads earn their carry unless the file was expanded later', () => {
  const cost: CostLine[] = [
    call(1, 20_000), call(3, 21_000), call(4, 22_000),
    { k: 'read-bound', ts: 2, thread: 't1', file: 'a.ts', offset: 0, limit: 100, total: 900, source: 'x', avoided: 1000 },
    { k: 'read-bound', ts: 2, thread: 't1', file: 'b.ts', offset: 0, limit: 100, total: 900, source: 'x', avoided: 5000 },
    { k: 'read-expand', ts: 3, thread: 't1', file: 'b.ts' },
  ];
  const l = buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!;
  const reads = l.events.filter((e) => e.lever === 'reads');
  assert.equal(reads.length, 1);
  near(reads[0]!.usd, 1000 * (6 + 0.3) / 1e6);
});

test('a graph injection is worth the search round trips it replaced, minus its own tokens', () => {
  const cost: CostLine[] = [call(1, 40_000), call(2_000, 41_000)];
  const inject = [{ v: 1, ts: new Date(1_500).toISOString(), lane: 'desktop-chat', sessionId: 't1', decision: 'injected', decls: 3, chars: 400 }] as any;
  const l = buildLedgers({ cost, inject, outcomes: [], workers: [] }).get('t1')!;
  const per = 6 / 1e6; // carried only by call 2 (the last)
  const extra = 41_000 * 0.3 / 1e6 + 80 * 15 / 1e6;
  near(lever(l, 'graph')[0]!.usd, GRAPH_ROUND_TRIPS * (extra + 290 * per) - 100 * per);
});

test('a safe-tool-subset thread saves the dropped schemas on every call', () => {
  const cost: CostLine[] = [call(1, 30_000, { cr: 0, cc: 30_000 }), call(2, 31_000), call(3, 32_000)];
  const l = buildLedgers({ cost, inject: [], outcomes: [], workers: [], flags: () => ({ safeTools: true }) }).get('t1')!;
  near(l.events.reduce((a, e) => a + e.usd, 0), (SAFE_TOOLS_TOKENS + SUBAGENT_TOOLS_TOKENS) * (6 + 0.3 + 0.3) / 1e6);
  // audit 2026-10-15 #9: booked per call (each day gets its share), like the overhead — not all on the first call
  assert.deepEqual(l.events.map((e) => e.ts), [1, 2, 3]);
});

test('a free swarm worker saves what the lead would have paid to do the task itself, minus delegating and the report', () => {
  const cost: CostLine[] = [call(1, 30_000), call(20_000, 31_000)];
  const outcomes = [{ v: 1, ts: 10_000, thread: 'chat:t1', taskId: 's1', status: 'done', startedAt: 5_000, durationMs: 1, attempts: [{ model: 'm', provider: 'zen', outcome: 'ok', at: 1 }], verify: null, reportBytes: 400, worktree: '/wt/a' }] as any;
  const workers = [{ directory: '/wt/a', created: 6_000, input: 10_000, cacheRead: 90_000, cacheWrite: 0, output: 1_000, requests: 10, firstPrompt: 18_000, maxPrompt: 23_000 }];
  const l = buildLedgers({ cost, inject: [], outcomes, workers }).get('t1')!;
  const read = 0.3 / 1e6, out = 15 / 1e6, carry = 6 / 1e6; // the task's content is carried by call 2 (written once)
  // the lead's context is the first call after the task starts (31k)
  const g = 0.4 * 5_000; // Claude brings in 0.4x the worker's new content
  const claude = 3 * (31_000 + g / 2) * read + g * carry + 0.3 * 1_000 * out; // 0.3x the calls (min 2), 0.3x the output
  const delegation = 3.34 * (31_000 * read + 150 * out);
  near(lever(l, 'swarm')[0]!.usd, claude - delegation - 100 * carry);
});

test('a Claude thread books the delegation tools Kora removes; a GPT thread does not', () => {
  const cost: CostLine[] = [call(1, 30_000, { cr: 0, cc: 30_000 }), call(2, 31_000)];
  near(lever(buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!, 'trims').reduce((a, e) => a + e.usd, 0), SUBAGENT_TOOLS_TOKENS * (6 + 0.3) / 1e6);
  const gpt = cost.map((c) => ({ ...c, model: 'gpt-6-luna' })) as CostLine[];
  assert.equal(lever(buildLedgers({ cost: gpt, inject: [], outcomes: [], workers: [] }).get('t1')!, 'trims').length, 0);
  // a Claude model in another harness (Antigravity, OpenCode) is not Claude Code: no credit
  const agy = cost.map((c) => ({ ...c, h: 'agy' })) as CostLine[];
  assert.equal(lever(buildLedgers({ cost: agy, inject: [], outcomes: [], workers: [] }).get('t1')!, 'trims').length, 0);
});

test("Kora's own prompt is paid on every call and comes off the headline", () => {
  const cost: CostLine[] = [call(1, 30_000, { cr: 0, cc: 30_000 }), call(2, 31_000), call(3, 32_000)];
  const l = buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!;
  near(l.overhead.reduce((a, p) => a + p.usd, 0), KORA_PREFIX_TOKENS * (6 + 0.3 + 0.3) / 1e6);
});

test('days the logs fully cover replace the stored ones; the first log day keeps the fuller row; older days are kept', () => {
  const t0 = new Date(2026, 9, 10, 12).getTime(), t1 = new Date(2026, 9, 11, 12).getTime();
  const stored = { '2026-10-01': { paid: 1, byLever: { swarm: 1, reads: 0, trims: 0, graph: 0, cache: 0 } }, '2026-10-10': { paid: 9, byLever: { swarm: 9, reads: 0, trims: 0, graph: 0, cache: 0 } } };
  const ledgers = [{ events: [{ ts: t0, lever: 'reads' as const, usd: 0.5 }, { ts: t1, lever: 'graph' as const, usd: 0.25 }], paid: [{ ts: t1, usd: 2 }], overhead: [] }];
  const merged = mergeDays(stored, ledgers, t0);
  assert.equal(merged['2026-10-01']!.paid, 1);
  assert.equal(merged['2026-10-10']!.byLever.swarm, 9); // the first log day lost its start: the stored row has more
  assert.equal(merged['2026-10-11']!.byLever.graph, 0.25);
  // today is the first log day and keeps growing: the fresh row must win, not freeze at the first save
  const today = mergeDays({ '2026-10-11': { paid: 1, byLever: { swarm: 0, reads: 0, trims: 0, graph: 0.1, cache: 0 } } }, ledgers, t1);
  assert.equal(today['2026-10-11']!.paid, 2);
});

test('savingsReport reads a home, scopes the session, and persists the day table', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-'));
  const now = Date.now();
  const lines: CostLine[] = [
    { ...call(now - 3000, 20_000), thread: 't1' } as CostLine, { ...call(now - 1000, 21_000), thread: 't1' } as CostLine,
    { k: 'bash-trim', ts: now - 2000, thread: 't1', bytes: 1, lines: 1, errors: 0, saved: 2000 },
  ];
  fs.writeFileSync(path.join(home, 'cost.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  resetSavingsMemoForTests();
  const r = savingsReport({ home, threadId: 't1', now });
  near(r.session!.byLever.trims, 2000 * 6 / 1e6 + SUBAGENT_TOOLS_TOKENS * (0.3 + 0.3) / 1e6);
  assert.ok(r.session!.paidUsd > 0);
  near(r.week.savedUsd, r.session!.savedUsd);
  near(r.all.savedUsd, r.session!.savedUsd);
  assert.ok(fs.existsSync(path.join(home, 'savings-days.json')));
  assert.equal(savingsReport({ home, threadId: 'nope', now }).session!.savedUsd, 0);
});

test('list prices match the published table (cache reads, 5-minute writes)', () => {
  const { priceFor, requestCostOf } = require('./transcript') as typeof import('./transcript');
  assert.equal(priceFor('claude-sonnet-5-5').cacheRead, 0.1, 'pricing page 2026-10-15: Sonnet 5.5 reads $0.10/M (0.05x); the SDK\'s own total bills them at $0.20/M');
  assert.equal(priceFor('claude-sonnet-5').cacheRead, 0.2);
  assert.equal(priceFor('claude-opus-5-5').cacheRead, 0.2);
  assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(priceFor('claude-fable-5').cacheRead, 1);
  assert.equal(priceFor('claude-opus-4-1').in, 15);
  assert.equal(priceFor('claude-opus-4-8').in, 5);
  // 1M cache writes on Opus 5.5: half 1-hour ($8/M), half 5-minute ($5/M)
  near(requestCostOf({ input: 0, cacheWrite: 1e6, cacheRead: 0, output: 0, cacheWrite1h: 5e5 }, 'claude-opus-5-5'), 6.5);
  // Haiku 5.5 past 100K prompt tokens: every price 5x
  near(requestCostOf({ input: 0, cacheWrite: 0, cacheRead: 2e5, output: 0 }, 'claude-haiku-5-5'), 2e5 * 0.05 / 1e6);
});

// User decision 2026-10-15 (reverting audit #3): only wins are booked, so the number never goes down. A losing event
// (an injection dearer than the round trip it replaced) adds nothing; the winning one still counts in full.
test('a losing event is dropped: a lever never goes below its wins', () => {
  const cost: CostLine[] = [call(1, 40_000), call(2_000, 41_000), call(4_000, 42_000)];
  // a big injection (40k chars = 10k tokens) costs more than the round trip it saved: a loss
  const inject = [
    { v: 1, ts: new Date(1_500).toISOString(), lane: 'desktop-chat', sessionId: 't1', decision: 'injected', decls: 3, chars: 400 },
    { v: 1, ts: new Date(1_600).toISOString(), lane: 'desktop-chat', sessionId: 't1', decision: 'injected', decls: 3, chars: 40_000 },
  ] as any;
  const l = buildLedgers({ cost, inject, outcomes: [], workers: [] }).get('t1')!;
  const graph = l.events.filter((e) => e.lever === 'graph');
  assert.equal(graph.length, 1, 'the loss is not booked');
  assert.ok(graph[0]!.usd > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sav-loss-'));
  try {
    fs.writeFileSync(path.join(dir, 'cost.jsonl'), cost.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'inject.jsonl'), inject.map((r: any) => JSON.stringify(r)).join('\n') + '\n');
    resetSavingsMemoForTests();
    const r = savingsReport({ threadId: 't1', home: dir, now: 5_000 });
    near(r.session!.byLever.graph, graph[0]!.usd);
    near(r.all.byLever.graph, graph[0]!.usd);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); resetSavingsMemoForTests(); }
});

test('an assistant/blob lane (noKoraPrompt) is charged no Kora prompt overhead; a code thread still is', () => {
  const cost: CostLine[] = [call(1, 30_000, { cr: 0, cc: 30_000 }), call(2, 31_000)];
  const blob = buildLedgers({ cost, inject: [], outcomes: [], workers: [], flags: () => ({ noKoraPrompt: true }) }).get('t1')!;
  assert.equal(blob.overhead.length, 0);
  const code = buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!;
  assert.ok(code.overhead.length === 2 && code.overhead[0]!.usd > 0);
});

test('"week" and "all time" read the same day table: a rotated-away day still counts in the week', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-week-'));
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = (d: number) => { const t = new Date(now - d * 86_400_000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const row = (reads: number) => ({ paid: 1, byLever: { swarm: 0, reads, trims: 0, graph: 0, cache: 0 } });
  // 3 days ago was rotated out of cost.jsonl (the log is empty), but its row was stored; 20 days ago is outside the week
  fs.writeFileSync(path.join(home, 'savings-days.json'), JSON.stringify({ v: 1, days: { [day(3)]: row(0.5), [day(20)]: row(2) } }));
  resetSavingsMemoForTests();
  const r = savingsReport({ home, now });
  near(r.week.savedUsd, 0.5);
  near(r.all.savedUsd, 2.5);
  assert.ok(r.week.savedUsd <= r.all.savedUsd);
});

test('Auto model: light calls are priced again at the ceiling until the thread moves up; side calls and later calls earn nothing', () => {
  const H = 'claude-haiku-5-5';
  const hcall = (ts: number, model: string, cc: number, cr: number, out: number): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx: cc + cr, in: 0, cr, cc, out, miss: false });
  const cost: CostLine[] = [
    { k: 'auto-model', ts: 1, thread: 't1', model: H, reason: 'a question about the code', ceiling: 'claude-sonnet-5-5' },
    hcall(2, H, 20_000, 0, 500),
    hcall(3, 'claude-haiku-4-5-20251001', 900, 0, 10), // Claude Code's own title call: not Auto's
    hcall(4, H, 2_000, 20_000, 300),
    { k: 'auto-model', ts: 5, thread: 't1', model: 'default', reason: 'you said the answer was not right', escalated: true },
    hcall(6, 'claude-sonnet-5-5', 22_000, 0, 400),
  ];
  const l = buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!;
  const model = l.events.filter((e) => e.lever === 'model');
  assert.equal(model.length, 1, 'net per thread, booked once at the pick');
  assert.equal(model[0]!.ts, 1);
  // Sonnet 5.5 (write 4, read 0.10, out 10) minus Haiku 5.5 (write 0.2, read 0.01, out 0.5), $/M; then the move-up's
  // first call re-writes the 22k Sonnet would have read all along (R6 review #1): charged as (read - write) at Sonnet.
  near(model[0]!.usd, (20_000 * (4 - 0.2) + 500 * (10 - 0.5)) / 1e6 + (2_000 * (4 - 0.2) + 20_000 * (0.1 - 0.01) + 300 * (10 - 0.5)) / 1e6 - 22_000 * (4 - 0.1) / 1e6);
});

test('Auto middle tier: Sonnet calls priced at the Opus ceiling, light -> middle stretches both count, the advisor is subtracted and paid', () => {
  const H = 'claude-haiku-5-5'; const S = 'claude-sonnet-5-5'; const O = 'claude-opus-5-5';
  const call = (ts: number, model: string, cc: number, cr: number, out: number): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx: cc + cr, in: 0, cr, cc, out, miss: false });
  const cost: CostLine[] = [
    { k: 'auto-model', ts: 1, thread: 't1', model: H, reason: 'a question about the code', ceiling: O },
    call(2, H, 10_000, 0, 100),
    { k: 'auto-model', ts: 3, thread: 't1', model: S, reason: 'the thread moved on to real work', escalated: true, ceiling: O, advisor: O },
    call(4, S, 30_000, 0, 1_000),
    { k: 'advisor', ts: 4, thread: 't1', model: O, in: 30_000, cr: 0, cc: 0, out: 500 },
    call(5, S, 1_000, 30_000, 1_000),
  ];
  const l = buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!;
  const model = l.events.filter((e) => e.lever === 'model');
  assert.equal(model.length, 1);
  // Opus 5.5 $/M: write 8, read 0.20, in 4, out 20. Haiku 5.5: write 0.2, out 0.5. Sonnet 5.5: write 4, read 0.10, out 10.
  const light = (10_000 * (8 - 0.2) + 100 * (20 - 0.5)) / 1e6;
  // The first Sonnet call re-wrote the 10k light context Opus would have read: those 10k count as Opus reads, not writes.
  const midCalls = (10_000 * 0.2 + 20_000 * 8 - 30_000 * 4 + 1_000 * (20 - 10) + 1_000 * (8 - 4) + 30_000 * (0.2 - 0.1) + 1_000 * (20 - 10)) / 1e6;
  const advisor = (30_000 * 4 + 500 * 20) / 1e6;
  near(model[0]!.usd, light + midCalls - advisor);
  assert.ok(l.paid.some((p) => Math.abs(p.usd - advisor) < 1e-9), 'the advisor is in what the thread paid');
  // An advisor that costs more than Sonnet saved books nothing (wins only).
  const dear: CostLine[] = [cost[2]!, call(4, S, 1_000, 0, 10), { k: 'advisor', ts: 4, thread: 't1', model: O, in: 200_000, cr: 0, cc: 0, out: 800 }];
  assert.equal(buildLedgers({ cost: dear, inject: [], outcomes: [], workers: [] }).get('t1')!.events.filter((e) => e.lever === 'model').length, 0);
});

test('Auto model: a move-up that re-writes more than the light stretch saved books nothing (wins only)', () => {
  const H = 'claude-haiku-5-5'; const O = 'claude-opus-5-5';
  const call = (ts: number, model: string, cc: number, cr: number, out: number): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx: cc + cr, in: 0, cr, cc, out, miss: false });
  const cost: CostLine[] = [
    { k: 'auto-model', ts: 1, thread: 't1', model: H, reason: 'a question about the code', ceiling: O },
    call(2, H, 2_000, 0, 50),
    call(3, H, 1_000, 100_000, 50), // grew big on Haiku
    { k: 'auto-model', ts: 4, thread: 't1', model: 'default', reason: 'the thread grew past 80k tokens', escalated: true, ceiling: O },
    call(5, O, 101_000, 0, 300), // the Default writes what it would have read
  ];
  assert.equal(buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!.events.filter((e) => e.lever === 'model').length, 0);
});

test('Auto model: leaving Auto ends the stretch; the user\'s own pick of the same model books nothing', () => {
  const H = 'claude-haiku-5-5'; const O = 'claude-opus-5-5';
  const call = (ts: number, model: string, cc: number, cr: number, out: number): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx: cc + cr, in: 0, cr, cc, out, miss: false });
  const base: CostLine[] = [
    { k: 'auto-model', ts: 1, thread: 't1', model: H, reason: 'a question about the code', ceiling: O },
    call(2, H, 10_000, 0, 100),
  ];
  const later = [call(4, H, 1_000, 10_000, 100), call(5, H, 1_000, 11_000, 100)];
  const usd = (cost: CostLine[]) => buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!.events.filter((e) => e.lever === 'model').reduce((a, e) => a + e.usd, 0);
  const left = usd([...base, { k: 'auto-model', ts: 3, thread: 't1', model: 'manual', reason: 'you picked a model' }, ...later]);
  near(left, usd(base));
  assert.ok(usd([...base, ...later]) > left, 'without the row the same calls would have booked');
});

test('Auto model: a move-up after the cache expired is not charged a re-write the Default would have paid too', () => {
  const H = 'claude-haiku-5-5'; const O = 'claude-opus-5-5';
  const call = (ts: number, model: string, cc: number, cr: number, out: number): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx: cc + cr, in: 0, cr, cc, out, miss: false });
  const hour = 60 * 60_000;
  const rows = (gap: number): CostLine[] => [
    { k: 'auto-model', ts: 1, thread: 't1', model: H, reason: 'a question about the code', ceiling: O },
    call(2, H, 30_000, 0, 100),
    { k: 'auto-model', ts: 3 + gap, thread: 't1', model: 'default', reason: 'you said the answer was not right', escalated: true, ceiling: O },
    call(4 + gap, O, 30_000, 0, 100),
  ];
  const usd = (cost: CostLine[]) => buildLedgers({ cost, inject: [], outcomes: [], workers: [] }).get('t1')!.events.filter((e) => e.lever === 'model').reduce((a, e) => a + e.usd, 0);
  near(usd(rows(0)), 100 * (20 - 0.5) / 1e6); // warm: the re-write cancels the write saving, only the output difference is left
  near(usd(rows(2 * hour)), (30_000 * (8 - 0.2) + 100 * (20 - 0.5)) / 1e6);
});

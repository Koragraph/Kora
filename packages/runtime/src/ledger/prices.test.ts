import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogContextWindow, compactModelsDev, normalizeModelId, priceCatalogPath, priceFor, refreshPriceCatalog, resetPricesForTests, writePriceCatalog } from './prices';
import { requestCostOf } from './transcript';
import { buildLedgers } from './savings';
import { codexRequestUsages } from '../session/usage';
import type { CostLine } from '../util/cost-log';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-prices-'));
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/** A models.dev payload in its own shape (cost per M, Anthropic's cache_write = the 5-minute write). */
const API = {
  anthropic: { models: { 'claude-opus-6': { cost: { input: 6, output: 30, cache_read: 0.3, cache_write: 7.5 } } } },
  openai: { models: { 'gpt-7': { limit: { context: 1_050_000 }, cost: { input: 3, output: 18, cache_read: 0.3, tiers: [{ input: 6, output: 27, cache_read: 0.6, tier: { type: 'context', size: 272000 } }] } } } },
  opencode: { models: { 'big-pickle': { cost: { input: 0, output: 0 } } } },
  openrouter: { models: { 'qwen/qwen3-coder': { cost: { input: 0.2, output: 0.8 } } } },
  noprice: { models: { 'x-1': { name: 'no cost field' } } },
  // resellers: a $0 coding-plan row and a marked-up row must never price a maker's model
  iflowcn: { models: { 'qwen3-max': { cost: { input: 0, output: 0 } }, 'claude-opus-6': { cost: { input: 0, output: 0 } } } },
  azure: { models: { 'claude-opus-4-1': { cost: { input: 99, output: 99 } } } },
  alibaba: { models: { 'qwen3-max': { cost: { input: 1.2, output: 6 } } } },
  aaa: { models: { 'mystery-coder': { cost: { input: 0, output: 0 } } } },
  bbb: { models: { 'mystery-coder': { cost: { input: 0.5, output: 1 } } } },
};

test('ids from every harness normalise to one model id', () => {
  assert.deepEqual(normalizeModelId('claude-sonnet-5-5[1m]'), { provider: null, id: 'claude-sonnet-5-5' });
  assert.deepEqual(normalizeModelId('us.anthropic.claude-sonnet-5-5-v1:0'), { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  assert.deepEqual(normalizeModelId('claude-opus-4-1@20250805'), { provider: null, id: 'claude-opus-4-1' });
  assert.deepEqual(normalizeModelId('claude-haiku-4-5-20251001'), { provider: null, id: 'claude-haiku-4-5' });
  assert.deepEqual(normalizeModelId('openrouter/qwen/qwen3-coder'), { provider: 'openrouter', id: 'qwen/qwen3-coder' });
});

test('with no catalog: Claude, GPT and Gemini each at their own maker\'s built-in price', () => {
  resetPricesForTests();
  const home = tmpHome();
  const opus = priceFor('claude-opus-5-5', home);
  assert.equal(opus.provider, 'anthropic'); assert.equal(opus.in, 4); assert.equal(opus.cacheWrite, 8); assert.equal(opus.write5m, 5);
  const gpt = priceFor('gpt-6-luna', home);
  assert.equal(gpt.provider, 'openai'); assert.equal(gpt.source, 'built-in'); assert.equal(gpt.in, 0.1); assert.equal(gpt.out, 0.5);
  assert.equal(gpt.long?.above, 272_000);
  // Antigravity's effort suffix
  const gem = priceFor('gemini-3.8-flash-high', home);
  assert.equal(gem.provider, 'google'); assert.equal(gem.key, 'gemini-3.8-flash'); assert.equal(gem.in, 0.75);
  // never "assume Sonnet" for a GPT the table does not know
  const unknown = priceFor('gpt-7', home);
  assert.equal(unknown.source, 'unpriced'); assert.equal(unknown.in, 0);
  // a new Claude id takes its family row until the catalog lists it
  const opus6 = priceFor('claude-opus-6', home);
  assert.equal(opus6.source, 'family'); assert.equal(opus6.provider, 'anthropic');
});

test('a catalog snapshot prices a model Kora has never heard of, with its provider\'s cache rules', () => {
  resetPricesForTests();
  const home = tmpHome();
  assert.ok(writePriceCatalog(API, 'models.dev', home, 1_000));
  const gpt7 = priceFor('gpt-7', home);
  assert.equal(gpt7.source, 'catalog'); assert.equal(gpt7.provider, 'openai');
  assert.equal(gpt7.cacheWrite, 3); // no write premium: a written token costs input
  assert.equal(gpt7.long?.above, 272_000); assert.equal(gpt7.long?.in, 6);
  const opus6 = priceFor('claude-opus-6', home);
  assert.equal(opus6.source, 'catalog');
  assert.equal(opus6.cacheWrite, 12); // the 1-hour write Kora's lanes use: 2x input
  assert.equal(opus6.write5m, 7.5); // models.dev lists the 5-minute write
  // OpenCode's provider/model ids, a free model at $0
  const free = priceFor('opencode/big-pickle', home);
  assert.equal(free.source, 'catalog'); assert.equal(free.in, 0);
  assert.equal(priceFor('openrouter/qwen/qwen3-coder', home).in, 0.2);
  // the context window rides along, so a context meter knows a new model's limit too
  assert.equal(catalogContextWindow('openai/gpt-7', home), 1_050_000);
  assert.equal(catalogContextWindow('claude-opus-6', home), null);
});

test('the maker\'s price beats a reseller\'s; Claude/GPT/Gemini never take a reseller row; $0 reseller rows are not prices', () => {
  resetPricesForTests();
  const home = tmpHome();
  writePriceCatalog(API, 'models.dev', home, 1_000);
  assert.equal(priceFor('qwen3-max', home).key, 'alibaba/qwen3-max');
  assert.equal(priceFor('claude-opus-4-1', home).source, 'built-in'); // not azure's 99
  assert.equal(priceFor('claude-opus-4-1', home).in, 15);
  assert.equal(priceFor('mystery-coder', home).key, 'bbb/mystery-coder'); // aaa's $0 row skipped
  assert.equal(priceFor('opencode/big-pickle', home).in, 0); // the provider that ran it: its $0 is real
});

test('a partial snapshot never replaces a fuller one', () => {
  resetPricesForTests();
  const home = tmpHome();
  assert.ok(writePriceCatalog(API, 'models.dev', home, 1_000));
  assert.equal(writePriceCatalog({ openai: API.openai }, 'models.dev', home, 2_000), false);
  assert.equal(priceFor('qwen3-max', home).key, 'alibaba/qwen3-max');
});

test('the user\'s prices.json wins over everything', () => {
  resetPricesForTests();
  const home = tmpHome();
  writePriceCatalog(API, 'models.dev', home, 1_000);
  fs.writeFileSync(path.join(home, 'prices.json'), JSON.stringify({ 'gpt-7': { in: 1, out: 2, cacheWrite: 1, cacheRead: 0.1 } }));
  const p = priceFor('gpt-7', home);
  assert.equal(p.source, 'user'); assert.equal(p.in, 1);
});

test('a GPT request past its long-context tier is billed at the tier\'s rates', () => {
  resetPricesForTests();
  // gpt-6-luna: 0.1 / 0.5 / read 0.01; past 272k: 0.2 / 0.75 / read 0.02
  near(requestCostOf({ input: 1_000, cacheWrite: 0, cacheRead: 9_000, output: 100 }, 'gpt-6-luna'), (1_000 * 0.1 + 9_000 * 0.01 + 100 * 0.5) / 1e6);
  near(requestCostOf({ input: 10_000, cacheWrite: 0, cacheRead: 290_000, output: 100 }, 'gpt-6-luna'), (10_000 * 0.2 + 290_000 * 0.02 + 100 * 0.75) / 1e6);
});

test('compactModelsDev keeps every priced model and skips the rest', () => {
  const cat = compactModelsDev(API, 5, 'x')!;
  assert.deepEqual(Object.keys(cat.providers).sort(), ['aaa', 'alibaba', 'anthropic', 'azure', 'bbb', 'iflowcn', 'openai', 'opencode', 'openrouter']);
  assert.equal(compactModelsDev({}, 5, 'x'), null);
});

test('refresh: fresh snapshot is left alone; OpenCode\'s local copy is used before the network; network off is honoured', async () => {
  resetPricesForTests();
  const home = tmpHome();
  const cache = tmpHome();
  let fetched = 0;
  const fakeFetch = (async () => { fetched++; return new Response(JSON.stringify(API)); }) as unknown as typeof fetch;
  // nothing anywhere, network off
  assert.equal(await refreshPriceCatalog({ home, env: { XDG_CACHE_HOME: cache, KORA_PRICE_CATALOG: '0' }, fetch: fakeFetch }), 'off');
  assert.equal(fetched, 0);
  // OpenCode's copy, fresh: used, no network
  fs.mkdirSync(path.join(cache, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'opencode', 'models.json'), JSON.stringify(API));
  assert.equal(await refreshPriceCatalog({ home, env: { XDG_CACHE_HOME: cache }, fetch: fakeFetch }), 'opencode');
  assert.equal(fetched, 0);
  assert.equal(await refreshPriceCatalog({ home, env: { XDG_CACHE_HOME: cache }, fetch: fakeFetch }), 'fresh');
  // a day later, OpenCode's copy is stale: one fetch
  const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
  assert.equal(await refreshPriceCatalog({ home, env: { XDG_CACHE_HOME: cache }, fetch: fakeFetch, now: later }), 'fetched');
  assert.equal(fetched, 1);
  assert.ok(fs.existsSync(priceCatalogPath(home)));
});

test('Codex rollout: one usage row per model request, fresh input apart from cached, the turn\'s model', () => {
  const line = (ts: string, payload: unknown, type = 'event_msg') => JSON.stringify({ timestamp: ts, type, payload });
  const tc = (total: number, input: number, cached: number, out: number) => ({ type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out } } });
  const rows = codexRequestUsages([
    line('2026-10-18T06:24:08.000Z', { model: 'gpt-5.6-luna' }, 'turn_context'),
    line('2026-10-18T06:24:11.000Z', tc(15_643, 15_531, 0, 112)),
    line('2026-10-18T06:24:12.000Z', tc(15_643, 15_531, 0, 112)), // repeated (rate limits only): not a request
    line('2026-10-18T06:24:14.000Z', tc(37_856, 21_939, 15_360, 274)),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { ts: Date.parse('2026-10-18T06:24:14.000Z'), model: 'gpt-5.6-luna', in: 21_939 - 15_360, cr: 15_360, cc: 0, out: 274 });
});

test('a Codex thread\'s graph saving is priced at GPT\'s rates, not Claude\'s', () => {
  resetPricesForTests();
  const call = (ts: number, ctx: number, model: string): CostLine => ({ k: 'call', ts, thread: 't1', model, ctx, in: 0, cr: ctx, cc: 0, out: 0, miss: false });
  const inject = [{ v: 1, ts: new Date(1_500).toISOString(), lane: 'codex-chat', sessionId: 't1', decision: 'injected', decls: 3, chars: 400 }] as any;
  const usd = (model: string) => buildLedgers({ cost: [call(1, 40_000, model), call(2_000, 41_000, model)], inject, outcomes: [], workers: [] }).get('t1')!.events.find((e) => e.lever === 'graph')!.usd;
  // gpt-6-luna reads at $0.01/M and lists a $0.125/M cache write: the same event on Opus 5.5 ($0.2 / $8) is worth far more
  const per = 0.125 / 1e6; const extra = 41_000 * 0.01 / 1e6 + 80 * 0.5 / 1e6;
  near(usd('gpt-6-luna'), extra + 290 * per - 100 * per);
  assert.ok(usd('claude-opus-5-5') > 10 * usd('gpt-6-luna'));
  // an unpriced model books nothing rather than a guess
  assert.equal(buildLedgers({ cost: [call(1, 40_000, 'mystery-9'), call(2_000, 41_000, 'mystery-9')], inject, outcomes: [], workers: [] }).get('t1')!.events.length, 0);
});

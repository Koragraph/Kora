import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SWARM_MODEL_SEED, SWARM_PAID_SEED, filterCatalog, filterPaidCatalog, orderBySupply, paidCatalog, refreshSwarmCatalog } from './swarm-catalog';
import { modelTier } from './swarm-health';

const api = {
  opencode: { models: {
    'big-pickle': { cost: { input: 0, output: 0 }, tool_call: true },
    'grok-code': { cost: { input: 0, output: 0 }, tool_call: true },
    'kimi-k2.5-free': { cost: { input: 1, output: 2 } },             // no longer free → dropped (R7: never a paid Zen model)
    'fresh-free': { cost: { input: 0, output: 0 }, tool_call: true }, // new free Zen model → added after the seed's Zen
    'no-tools-free': { cost: { input: 0, output: 0 }, tool_call: false },
    'claude-opus-5-5': { cost: { input: 5, output: 25 } },
  } },
  openrouter: { models: { 'qwen/qwen3.8-27b:free': { cost: { input: 0, output: 0 } } } },
  cerebras: { models: { 'gpt-oss-120b': { cost: { input: 0.25, output: 0.69 } } } },
};

test('seed: only free ids, Zen → OpenRouter → Cerebras', () => {
  assert.ok(SWARM_MODEL_SEED.length >= 5);
  const rankOf = (p: string) => ['zen', 'openrouter', 'cerebras'].indexOf(p);
  const order = SWARM_MODEL_SEED.map((m) => m.provider);
  assert.deepEqual(order, [...order].sort((a, b) => rankOf(a) - rankOf(b)));
  for (const m of SWARM_MODEL_SEED) if (m.provider === 'openrouter') assert.match(m.id, /^openrouter\/.+:free$/);
  for (const m of SWARM_MODEL_SEED) if (m.provider === 'zen') assert.match(m.id, /^opencode\//);
});

test('filterCatalog: seed ∩ live free models, new free Zen models appended, paid and tool-less ones never', () => {
  const ids = filterCatalog(api).map((m) => m.id);
  assert.deepEqual(ids, ['opencode/big-pickle', 'opencode/grok-code', 'opencode/fresh-free', 'openrouter/qwen/qwen3.8-27b:free', 'cerebras/gpt-oss-120b']);
});

test('refreshSwarmCatalog: fetches models.dev once, caches 24 h, falls back to the cache / seed on failure', async () => {
  let calls = 0;
  const fetchOk: any = async () => { calls++; return { ok: true, json: async () => api }; };
  const a = await refreshSwarmCatalog({ fetch: fetchOk });
  assert.equal(calls, 1);
  assert.equal(a[0].id, 'opencode/big-pickle');
  assert.ok(fs.existsSync(path.join(process.env.KORA_HOME!, 'swarm', 'catalog.json')));
  await refreshSwarmCatalog({ fetch: fetchOk });
  assert.equal(calls, 1, 'cached');
  const fetchBad: any = async () => { throw new Error('offline'); };
  assert.deepEqual((await refreshSwarmCatalog({ force: true, fetch: fetchBad })).map((m) => m.id), a.map((m) => m.id), 'offline → last cache');
  fs.rmSync(path.join(process.env.KORA_HOME!, 'swarm', 'catalog.json'));
  assert.equal((await refreshSwarmCatalog({ fetch: fetchBad })).length, SWARM_MODEL_SEED.length, 'no cache → the seed');
});

test('paid tier: seed ∩ models.dev with live prices; free / pricey / tool-less / missing ids dropped', () => {
  const live = { openrouter: { models: {
    'qwen/qwen3.7-flash': { cost: { input: 0.04, output: 0.15 }, tool_call: true },
    'openai/gpt-oss-20b': { cost: { input: 0, output: 0 }, tool_call: true },      // free now → not "paid"
    'deepseek/deepseek-v4-flash': { cost: { input: 3, output: 9 }, tool_call: true }, // no longer cheap
    'z-ai/glm-4.7-flash': { cost: { input: 0.06, output: 0.4 }, tool_call: false },
  } } };
  assert.deepEqual(filterPaidCatalog(live), [{ id: 'openrouter/qwen/qwen3.7-flash', price: { input: 0.04, output: 0.15 } }]);
  assert.equal(filterPaidCatalog({}).length, SWARM_PAID_SEED.length, 'no feed: the seed');
  assert.ok(SWARM_PAID_SEED.every((x) => modelTier(x.id) === 'paid'));
  const cfg = paidCatalog(['qwen/qwen3.7-flash', 'openrouter/x/y:free']);
  assert.deepEqual(cfg.map((x) => [x.model.id, x.model.provider]), [['openrouter/qwen/qwen3.7-flash', 'openrouter']], 'user ids get the prefix; :free ids are not paid');
});

test('orderBySupply: free-first / paid-first / local-only (stable within a tier)', () => {
  const ids = ['opencode/a', 'ollama/q', 'openrouter/p/aid', 'openrouter/f/ree:free', 'lmstudio/l', 'cerebras/c'].map((id) => ({ id }));
  const order = (p: any) => orderBySupply(ids, p).map((x) => x.id);
  assert.deepEqual(order('free-first'), ['opencode/a', 'openrouter/f/ree:free', 'cerebras/c', 'ollama/q', 'lmstudio/l', 'openrouter/p/aid']);
  assert.deepEqual(order('paid-first'), ['openrouter/p/aid', 'opencode/a', 'openrouter/f/ree:free', 'cerebras/c', 'ollama/q', 'lmstudio/l']);
  assert.deepEqual(order('local-only'), ['ollama/q', 'lmstudio/l']);
});

test('filterCatalog: a model models.dev marks deprecated is dropped, seed or newly discovered', () => {
  const free = { cost: { input: 0, output: 0 }, tool_call: true };
  const api = { opencode: { models: { 'big-pickle': { ...free, status: 'deprecated' }, 'grok-code': free, 'shiny-free': free, 'old-free': { ...free, status: 'deprecated' } } } };
  const ids = filterCatalog(api).map((m) => m.id);
  assert.ok(!ids.includes('opencode/big-pickle'), 'a deprecated seed entry is dropped');
  assert.ok(ids.includes('opencode/grok-code') && ids.includes('opencode/shiny-free'));
  assert.ok(!ids.includes('opencode/old-free'), 'a deprecated new one is never added');
});

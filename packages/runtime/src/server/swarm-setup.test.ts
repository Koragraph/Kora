// SwarmSetup: the R2 readiness rule and its blockers, consent versioning, Cerebras off by default, keys/probes via the
// setup surface, preferences validation, install through installStart/installCancel, onStatus. Everything injected:
// no network, no real opencode, temp HOME/KORA_HOME (test-isolate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import type { SwarmInstallState, SwarmModelInfo, SwarmProviderTestResult, SwarmStatus } from '../protocol/types';
import { configPath, invalidateConfig, loadConfig, saveConfig } from '../config';
import type { SwarmHealth } from './swarm-health';
import { SwarmSetup, koragentRunnable } from './swarm-setup';

const ZEN_MODEL: SwarmModelInfo = { id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: null };
const OR_MODEL: SwarmModelInfo = { id: 'openrouter/qwen/qwen3-coder:free', provider: 'openrouter', label: 'qwen3-coder', rank: 0, maxConcurrent: null };
const CB_MODEL: SwarmModelInfo = { id: 'cerebras/qwen-3-coder', provider: 'cerebras', label: 'qwen-3-coder', rank: 0, maxConcurrent: 1 };

function fakeHealth(cooling: string[] = []): SwarmHealth {
  return {
    cooling: () => cooling.map((model) => ({ model, provider: 'zen' as const, until: Date.now() + 60_000, reason: 'rate-limited (429)' })),
    isAvailable: (m: string) => !cooling.includes(m),
    markCooling: () => {},
  } as unknown as SwarmHealth;
}
const test_ = (ok: boolean, outcome: SwarmProviderTestResult['outcome'], freeModels: string[] = []): SwarmProviderTestResult =>
  ({ ok, outcome, message: ok ? null : outcome, freeModels, latencyMs: 1, testedAt: Date.now(), limits: null });

function make(o: { installed?: boolean; version?: string | null; cooling?: string[]; catalog?: SwarmModelInfo[]; noticeVersion?: number; zen?: SwarmProviderTestResult } = {}) {
  return new SwarmSetup({
    health: fakeHealth(o.cooling),
    noticeVersion: o.noticeVersion,
    resolveOpencode: async () => (o.installed === false ? { path: null, source: null } : { path: '/fake/opencode', source: 'kora' }),
    opencodeVersion: async () => (o.version === undefined ? '1.18.32' : o.version),
    catalog: () => o.catalog ?? [ZEN_MODEL, OR_MODEL, CB_MODEL],
    probes: {
      zen: async () => o.zen ?? test_(true, 'ok', [ZEN_MODEL.id]),
      openrouter: async (k) => (k ? test_(true, 'ok', [OR_MODEL.id]) : test_(false, 'invalid-key')),
      cerebras: async (k) => (k ? test_(true, 'ok', [CB_MODEL.id]) : test_(false, 'invalid-key')),
    },
  });
}
const codes = (s: SwarmStatus) => s.blockers.map((b) => b.code).sort();
const accept = () => saveConfig({ swarm: { consent: { noticeVersion: 1, acceptedAt: 1_790_000_000_000 } } });

test.beforeEach(() => {
  fs.rmSync(configPath(), { force: true });
  fs.rmSync(path.join(koraHome(), 'secrets'), { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY; delete process.env.CEREBRAS_API_KEY; delete process.env.OPENCODE_API_KEY;
  process.env.XDG_DATA_HOME = path.join(process.env.HOME!, 'xdg-none');
  invalidateConfig();
});

test('defaults: Cerebras disabled, Zen/OpenRouter enabled, order zen → openrouter → cerebras, consent missing', async () => {
  const s = await make().getStatus();
  assert.deepEqual(s.providers.map((p) => [p.provider, p.enabled]), [['zen', true], ['openrouter', true], ['cerebras', false]]);
  assert.deepEqual(s.preferences, { providerOrder: ['zen', 'openrouter', 'cerebras'], defaultModel: null, maxWorkers: 4 });
  assert.deepEqual(codes(s), ['consent-missing']);
  assert.equal(s.ready, false);
  assert.equal(s.keyStorage, 'file');
  assert.equal(s.install.phase, 'idle');
  // Cerebras is disabled, so its models are not pickable even with a key.
  assert.ok(!s.models.available.some((m) => m.provider === 'cerebras'));
  assert.equal(s.providers.find((p) => p.provider === 'zen')!.keyRequired, false);
});

test('readiness matrix: each R2 term alone produces its blocker; all met → ready', async () => {
  accept();
  assert.equal((await make().getStatus()).ready, true);
  assert.deepEqual(codes(await make({ installed: false }).getStatus()), ['opencode-missing']);
  assert.deepEqual(codes(await make({ version: '1.17.9' }).getStatus()), ['opencode-too-old']);
  assert.deepEqual(codes(await make({ version: null }).getStatus()), ['opencode-too-old']);
  // every model cooling → all-models-cooling
  assert.deepEqual(codes(await make({ cooling: [ZEN_MODEL.id] }).getStatus()), ['all-models-cooling']);
  // no usable provider: Zen off, OpenRouter has no key
  saveConfig({ swarm: { providers: { zen: false } } });
  assert.deepEqual(codes(await make().getStatus()), ['no-provider']);
  // …an OpenRouter key makes it usable again
  const setup = make();
  await setup.setKey({ provider: 'openrouter', apiKey: 'sk-or-v1-000000000000000000000000fake' });
  const s = await setup.getStatus();
  assert.equal(s.ready, true);
  assert.deepEqual(s.models.available.map((m) => m.id), [OR_MODEL.id]);
  // an empty catalog with a usable provider → not ready (no-provider: nothing to pick)
  saveConfig({ swarm: { providers: { zen: true } } });
  assert.deepEqual(codes(await make({ catalog: [] }).getStatus()), ['no-provider']);
});

test('Zen: a failed test makes it unusable and (on invalid-key) marks the key required, per the probe (D-h)', async () => {
  accept();
  const setup = make({ zen: test_(false, 'invalid-key') });
  const st = await setup.testProvider({ provider: 'zen' });
  assert.equal(st.lastTest!.outcome, 'invalid-key');
  assert.equal(st.keyRequired, true);
  const s = await setup.getStatus();
  assert.deepEqual(codes(s), ['no-provider']);
  assert.equal(s.models.available.length, 0);
});

test('consent: accept → ready; a notice version bump makes it not-ready again; withdraw clears it', async () => {
  const setup = make();
  const c = await setup.setConsent({ noticeVersion: 1, accepted: true });
  assert.equal(c.acceptedVersion, 1); assert.equal(c.requiredVersion, 1); assert.ok(c.acceptedAt! > 0);
  assert.equal((await setup.getStatus()).ready, true);
  const bumped = await make({ noticeVersion: 2 }).getStatus();
  assert.deepEqual(codes(bumped), ['consent-missing']);
  assert.match(bumped.blockers[0].message, /changed \(v2\)/);
  await assert.rejects(setup.setConsent({ noticeVersion: 9, accepted: true }), /unknown privacy notice version/);
  await assert.rejects(setup.setConsent({ noticeVersion: 0, accepted: true }), /positive integer/);
  const w = await setup.setConsent({ noticeVersion: 1, accepted: false });
  assert.equal(w.acceptedVersion, null);
  assert.deepEqual(codes(await setup.getStatus()), ['consent-missing']);
});

test('config: a malformed swarm.consent is dropped; bad fields fall back to defaults', () => {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ swarm: { consent: { noticeVersion: 'yes', acceptedAt: 1 }, maxWorkers: 99, providerOrder: ['cerebras', 'bogus'], providers: { cerebras: 'on' } } }));
  invalidateConfig();
  const c = loadConfig().swarm;
  assert.equal(c.consent, null);
  assert.equal(c.maxWorkers, 4);
  assert.deepEqual(c.providerOrder, ['cerebras', 'zen', 'openrouter']);
  assert.equal(c.providers.cerebras, false);
  assert.equal(c.autoVerify, true); assert.equal(c.maxBounces, 2);
});

test('keys through the setup surface: status shows only the hint, never the key; test uses the stored key', async () => {
  accept();
  const setup = make();
  const KEY = 'csk-000000000000000000000000000secret';
  const st = await setup.setKey({ provider: 'cerebras', apiKey: KEY });
  assert.equal(st.hasKey, true); assert.equal(st.keySource, 'kora'); assert.equal(st.keyHint, 'csk-…cret');
  assert.equal(st.enabled, false, 'setting a key does not enable Cerebras (D-f)');
  const t = await setup.testProvider({ provider: 'cerebras' });
  assert.equal(t.lastTest!.ok, true);
  assert.ok(!JSON.stringify(await setup.getStatus()).includes(KEY), 'the key never appears in the status');
  await setup.setPreferences({ enabled: [{ provider: 'cerebras', enabled: true }] });
  assert.ok((await setup.getStatus()).models.available.some((m) => m.id === CB_MODEL.id));
  const cleared = await setup.clearKey({ provider: 'cerebras' });
  assert.equal(cleared.hasKey, false); assert.equal(cleared.lastTest, null);
  await assert.rejects(setup.setKey({ provider: 'nope' as any, apiKey: KEY }), /unknown swarm provider/);
});

test('pickableModels: provider order, defaultModel first, cooling and vanished models excluded', async () => {
  accept();
  const setup = make({ cooling: [] });
  await setup.setKey({ provider: 'openrouter', apiKey: 'sk-or-v1-000000000000000000000000fake' });
  await setup.setPreferences({ providerOrder: ['openrouter', 'zen'] });
  assert.deepEqual(setup.pickableModels().map((m) => m.id), [OR_MODEL.id, ZEN_MODEL.id]);
  await setup.setPreferences({ defaultModel: ZEN_MODEL.id });
  assert.deepEqual(setup.pickableModels().map((m) => m.id), [ZEN_MODEL.id, OR_MODEL.id]);
  // Zen's live listing no longer has big-pickle → it is gone from the picker
  const gone = new SwarmSetup({ ...setup.deps, probes: { zen: async () => test_(true, 'ok', ['opencode/other-free']) } });
  await gone.setKey({ provider: 'openrouter', apiKey: 'sk-or-v1-000000000000000000000000fake' });
  await gone.testProvider({ provider: 'zen' });
  assert.ok(!gone.pickableModels().some((m) => m.id === ZEN_MODEL.id));
  assert.ok(!make({ cooling: [OR_MODEL.id] }).pickableModels().some((m) => m.id === OR_MODEL.id));
});

test('setPreferences validates and persists; the order is completed with the missing providers', async () => {
  const setup = make();
  const p = await setup.setPreferences({ providerOrder: ['cerebras'], maxWorkers: 2, defaultModel: null });
  assert.deepEqual(p, { providerOrder: ['cerebras', 'zen', 'openrouter'], defaultModel: null, maxWorkers: 2 });
  await assert.rejects(setup.setPreferences({ maxWorkers: 0 }), /1 to 16/);
  await assert.rejects(setup.setPreferences({ providerOrder: ['x' as any] }), /unknown swarm provider/);
  await assert.rejects(setup.setPreferences({ enabled: [{ provider: 'zen', enabled: 'yes' as any }] }), /true or false/);
  assert.equal(loadConfig().swarm.maxWorkers, 2);
});

test('installStart runs the install in the background with progress on onStatus; installCancel stops it', async () => {
  let release!: (s: SwarmInstallState) => void;
  const setup = new SwarmSetup({
    health: fakeHealth(), resolveOpencode: async () => ({ path: null, source: null }), opencodeVersion: async () => null, catalog: () => [],
    install: (opts) => new Promise<SwarmInstallState>((resolve) => {
      const base: SwarmInstallState = { operationId: 'op-7', phase: 'downloading', downloadedBytes: 5, totalBytes: 10, version: '1.18.32', installedVersion: null, message: null };
      opts.onProgress?.(base);
      release = resolve;
      opts.signal?.addEventListener('abort', () => { const c = { ...base, phase: 'cancelled' as const, message: 'cancelled' }; opts.onProgress?.(c); resolve(c); });
    }),
  });
  const seen: SwarmStatus[] = [];
  const off = setup.onStatus((s) => seen.push(s));
  await assert.rejects(setup.installStart({ confirm: false as any }), /confirm: true/);
  const started = await setup.installStart({ confirm: true });
  assert.equal(started.operationId, 'op-7'); assert.equal(started.phase, 'downloading');
  assert.equal((await setup.installStart({ confirm: true })).operationId, 'op-7', 'a second start joins the running one');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.some((s) => s.install.phase === 'downloading' && s.install.downloadedBytes === 5));
  const cancelled = await setup.installCancel({ operationId: 'op-7' });
  assert.equal(cancelled.phase, 'cancelled');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await setup.getStatus()).install.phase, 'cancelled');
  off();
  void release;
});

test('onStatus: a key change pushes a new status; unsubscribe stops it', async () => {
  const setup = make();
  const seen: SwarmStatus[] = [];
  const off = setup.onStatus((s) => seen.push(s));
  await setup.setKey({ provider: 'openrouter', apiKey: 'sk-or-v1-000000000000000000000000fake' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(seen.length >= 1);
  assert.equal(seen.at(-1)!.providers.find((p) => p.provider === 'openrouter')!.hasKey, true);
  off();
  const n = seen.length;
  await setup.clearKey({ provider: 'openrouter' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, n);
});

test('a throwing SwarmHealth (the W0 stub) does not break status', async () => {
  const setup = new SwarmSetup({
    health: { cooling: () => { throw new Error('not implemented'); }, isAvailable: () => { throw new Error('not implemented'); } } as unknown as SwarmHealth,
    resolveOpencode: async () => ({ path: null, source: null }), catalog: () => [ZEN_MODEL],
  });
  const s = await setup.getStatus();
  assert.deepEqual(s.models.cooling, []);
  assert.deepEqual(s.models.available.map((m) => m.id), [ZEN_MODEL.id]);
});

// ---- supply: paid OpenRouter tier, local servers, ordering -------------------------------------------------------------

function makeSupply(o: { ollama?: SwarmProviderTestResult } = {}) {
  return new SwarmSetup({
    health: fakeHealth(),
    resolveOpencode: async () => ({ path: '/fake/opencode', source: 'kora' }),
    opencodeVersion: async () => '1.18.32',
    catalog: () => [ZEN_MODEL, OR_MODEL],
    probes: {
      zen: async () => test_(true, 'ok', [ZEN_MODEL.id]),
      openrouter: async (k) => (k ? test_(true, 'ok', [OR_MODEL.id]) : test_(false, 'invalid-key')),
      ollama: async () => o.ollama ?? test_(true, 'ok', ['ollama/qwen3-coder:30b', 'ollama/llama3.1:8b']),
      lmstudio: async () => ({ ...test_(false, 'unreachable'), message: 'LM Studio is not running at http://127.0.0.1:1234 — start it' }),
    },
  });
}

test('supply: paid needs an OpenRouter key, then its models follow the free tiers (or lead with paid-first)', async () => {
  const s = makeSupply();
  await assert.rejects(s.setSupply({ paid: { enabled: true } }), /add one first: kora swarm key set openrouter/);
  await s.setKey({ provider: 'openrouter', apiKey: 'sk-or-v1-test-000000000000' });
  await s.testProvider({ provider: 'openrouter' });
  const st = await s.setSupply({ paid: { enabled: true, maxTaskUsd: 0.02 } });
  assert.deepEqual([st.paid.enabled, st.paid.maxTaskUsd, st.paid.hasKey], [true, 0.02, true]);
  let ids = s.pickableModels().map((m) => m.id);
  assert.deepEqual(ids.slice(0, 2), [ZEN_MODEL.id, OR_MODEL.id]);
  assert.ok(ids.slice(2).every((id) => id.startsWith('openrouter/') && !id.endsWith(':free')) && ids.length > 2, ids.join(' '));
  await s.setSupply({ policy: 'paid-first' });
  ids = s.pickableModels().map((m) => m.id);
  assert.ok(!ids[0].endsWith(':free') && ids[0].startsWith('openrouter/'));
  assert.equal(loadConfig().swarm.supply, 'paid-first');
  await assert.rejects(s.setSupply({ paid: { maxTaskUsd: 0 } }), /spend cap/);
  await assert.rejects(s.setSupply({ policy: 'cheapest' as any }), /supply must be one of/);
});

test('supply: a local server is probed on enable, its models are pickable (one worker each), local-only drops remote', async () => {
  accept();
  const s = makeSupply();
  await assert.rejects(s.setSupply({ local: { provider: 'lmstudio', enabled: true } }), /LM Studio is not running/);
  assert.equal(loadConfig().swarm.local.lmstudio.enabled, false, 'a failed probe does not enable it');
  const st = await s.setSupply({ local: { provider: 'ollama', enabled: true, models: ['qwen3-coder:30b'] } });
  assert.equal(st.local.find((l) => l.provider === 'ollama')!.lastTest!.ok, true);
  const models = s.pickableModels();
  assert.deepEqual(models.map((m) => m.id), [ZEN_MODEL.id, 'ollama/qwen3-coder:30b'], 'configured filter; local after free remote');
  assert.deepEqual([models[1].provider, models[1].maxConcurrent], ['ollama', 1]);
  await s.setSupply({ policy: 'local-only' });
  assert.deepEqual(s.pickableModels().map((m) => m.id), ['ollama/qwen3-coder:30b']);
  assert.equal((await s.getStatus()).ready, true, 'local-only is ready on a working local server');
});

test('supply: local-only without a usable local server is a clear blocker', async () => {
  accept();
  const s = makeSupply({ ollama: { ...test_(false, 'unreachable'), message: 'Ollama is not running at http://127.0.0.1:11434 — run `ollama serve`' } });
  await s.setSupply({ policy: 'local-only' });
  let st = await s.getStatus();
  assert.deepEqual(codes(st), ['no-provider']);
  assert.match(st.blockers[0].message, /Local-only mode: .*kora swarm models local ollama on/);
  await s.setSupply({ local: { provider: 'ollama', enabled: true, force: true } });
  await s.testLocal({ provider: 'ollama' });
  st = await s.getStatus();
  assert.match(st.blockers[0].message, /Ollama is not running/);
});

test('supply on the wire: status carries supplyState in the UI shape; setPreferences({supplyState}) applies it with setSupply checks', async () => {
  accept();
  const s = makeSupply();
  assert.deepEqual((await s.getStatus()).supplyState, {
    supply: 'free-first',
    paid: { enabled: false, maxTaskUsd: 0.05, models: [] },
    local: { ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434', models: [] }, lmstudio: { enabled: false, baseUrl: 'http://127.0.0.1:1234', models: [] } },
  });
  await assert.rejects(s.setPreferences({ supplyState: { paid: { enabled: true } } }), /add one first/);
  await assert.rejects(s.setPreferences({ supplyState: { local: { lmstudio: { enabled: true } } } }), /LM Studio is not running/);
  await s.setPreferences({ supplyState: { supply: 'local-only', local: { ollama: { enabled: true, models: ['qwen3-coder:30b'] } } } });
  const st = (await s.getStatus()).supplyState!;
  assert.equal(st.supply, 'local-only');
  assert.deepEqual(st.local.ollama, { enabled: true, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3-coder:30b'] });
});

test('koragent backend: a known Koragent list filters the probe (Zen with no key → none)', () => {
  assert.deepEqual(koragentRunnable(['opencode/big-pickle', 'opencode/ling-free'], []), []);
  assert.deepEqual(koragentRunnable(['openrouter/a:free', 'openrouter/b:free'], ['openrouter/b:free']), ['openrouter/b:free']);
  assert.deepEqual(koragentRunnable(['opencode/big-pickle'], null), ['opencode/big-pickle']);
});

test('an ok provider listing with no free models offers none of its catalog models', async () => {
  const s = make({ zen: test_(true, 'ok', []) });
  await s.testProvider({ provider: 'zen' });
  assert.ok(!s.pickableModels().some((m) => m.provider === 'zen'));
});

test('auto-refresh never contacts free providers before the user accepts Swarm', async () => {
  let zenCalls = 0;
  const setup = new SwarmSetup({
    ...make().deps,
    probes: { zen: async () => { zenCalls++; return test_(true, 'ok', [ZEN_MODEL.id]); } },
  });
  const stop = setup.startAutoRefresh();
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(zenCalls, 0, 'no consent, no probe');
  accept();
  const stop2 = setup.startAutoRefresh();
  await new Promise((r) => setTimeout(r, 20));
  stop2();
  assert.equal(zenCalls, 1, 'after consent the providers are tested');
});

test('a first `--version` that timed out is retried within seconds, not held for the whole TTL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let calls = 0;
  const setup = new SwarmSetup({
    health: fakeHealth(),
    resolveOpencode: async () => ({ path: '/fake/opencode-miss', source: 'kora' }),
    opencodeVersion: async () => (++calls === 1 ? null : '1.18.32'),
    catalog: () => [ZEN_MODEL],
    probes: { zen: async () => test_(true, 'ok', [ZEN_MODEL.id]), openrouter: async () => test_(false, 'invalid-key'), cerebras: async () => test_(false, 'invalid-key') },
  });
  assert.equal((await setup.getStatus()).opencode.versionOk, false);
  t.mock.timers.tick(6_000);
  assert.equal((await setup.getStatus()).opencode.versionOk, true, 'a miss is cached for seconds, not 60 s');
});

test('a plain status read refreshes the free-model catalog: a model Zen just published is offered, a retired one is not', async () => {
  accept();
  const api = { opencode: { models: {
    'big-pickle': { cost: { input: 0, output: 0 }, tool_call: true },
    'grok-code': { cost: { input: 0, output: 0 }, tool_call: true, status: 'deprecated' },
    'brand-new-free': { cost: { input: 0, output: 0 }, tool_call: true },
  } } };
  const setup = new SwarmSetup({
    health: fakeHealth(),
    resolveOpencode: async () => ({ path: '/fake/opencode', source: 'kora' }),
    opencodeVersion: async () => '1.18.32',
    fetch: (async () => ({ ok: true, json: async () => api })) as unknown as typeof fetch,
    probes: { zen: async () => test_(true, 'ok', []), openrouter: async () => test_(false, 'invalid-key'), cerebras: async () => test_(false, 'invalid-key') },
  });
  await setup.getStatus();
  await new Promise((r) => setTimeout(r, 50));
  const ids = (await setup.getStatus()).models.available.map((m) => m.id);
  assert.ok(ids.includes('opencode/brand-new-free'), ids.join(','));
  assert.ok(!ids.includes('opencode/grok-code'), ids.join(','));
});

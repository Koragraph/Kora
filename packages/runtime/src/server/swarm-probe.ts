// Provider probes (8 s timeout, async fetch, injectable for tests). Zen's key requirement is whatever probeZen finds
// (PLAN D-h) — never hard-coded. A probe never throws: every failure is a SwarmProviderTestResult with an outcome.
// Keys are sent only to their own provider and never appear in a result message.
import type { SwarmProviderLimits, SwarmProviderTestResult, SwarmTestOutcome } from '../protocol/types';

const DEFAULT_TIMEOUT_MS = 8000;
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CEREBRAS_MODELS_URL = 'https://api.cerebras.ai/v1/models';
/** Zen's free models carry no price in /zen/v1/models; they are the `-free` ids plus these named ones (models.dev
 *  cost.input === 0, checked 2026-09-24). The catalog (S2) is the authority on what the picker may use. */
const ZEN_FREE_NAMED = new Set(['big-pickle']);

type ProbeOpts = { fetch?: typeof fetch; timeoutMs?: number };
type Got = { ok: true; status: number; json: any; ms: number } | { ok: false; status: number | null; error: string; ms: number };

async function get(url: string, headers: Record<string, string>, opts: ProbeOpts): Promise<Got> {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await f(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: ac.signal });
    const ms = Date.now() - t0;
    if (!res.ok) { try { await res.text(); } catch { /* drain */ } return { ok: false, status: res.status, error: `HTTP ${res.status}`, ms }; }
    let json: any = null;
    try { json = await res.json(); } catch { return { ok: false, status: res.status, error: 'the response was not JSON', ms: Date.now() - t0 }; }
    return { ok: true, status: res.status, json, ms: Date.now() - t0 };
  } catch (e: any) {
    const ms = Date.now() - t0;
    const error = ac.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code || e?.message || e);
    return { ok: false, status: null, error, ms };
  } finally { clearTimeout(timer); }
}

function result(outcome: SwarmTestOutcome, p: { message?: string | null; freeModels?: string[]; latencyMs?: number | null; limits?: SwarmProviderLimits | null; ok?: boolean }): SwarmProviderTestResult {
  return {
    ok: p.ok ?? outcome === 'ok',
    outcome,
    message: p.message ?? null,
    freeModels: p.freeModels ?? [],
    latencyMs: p.latencyMs ?? null,
    testedAt: Date.now(),
    limits: p.limits ?? null,
  };
}

/** Map a failed GET to an outcome: 401/403 → invalid-key, 429 → rate-limited, anything else → unreachable. */
function failure(name: string, g: Extract<Got, { ok: false }>, keyed: boolean): SwarmProviderTestResult {
  if (g.status === 401 || g.status === 403) {
    return result('invalid-key', { latencyMs: g.ms, message: keyed ? `${name} rejected the key (HTTP ${g.status})` : `${name} needs an API key (HTTP ${g.status})` });
  }
  if (g.status === 429) return result('rate-limited', { latencyMs: g.ms, message: `${name} is rate-limiting requests right now (HTTP 429)` });
  return result('unreachable', { latencyMs: g.ms, message: `${name} is unreachable: ${g.error}` });
}

const ids = (json: any): string[] => (Array.isArray(json?.data) ? json.data.map((m: any) => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean) : []);

/** GET https://opencode.ai/zen/v1/models → reachable + the free ids (as opencode `-m` ids, `opencode/<id>`). */
export async function probeZen(opts: { apiKey?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SwarmProviderTestResult> {
  const keyed = !!opts.apiKey;
  const g = await get(ZEN_MODELS_URL, keyed ? { authorization: `Bearer ${opts.apiKey}` } : {}, opts);
  if (!g.ok) return failure('OpenCode Zen', g, keyed);
  const free = ids(g.json).filter((id) => id.endsWith('-free') || ZEN_FREE_NAMED.has(id)).map((id) => `opencode/${id}`);
  if (!free.length) return result('no-free-models', { latencyMs: g.ms, message: 'OpenCode Zen lists no free models right now' });
  return result('ok', { latencyMs: g.ms, freeModels: free });
}

/** Next 00:00 UTC (OpenRouter's free-model daily counter resets then). */
function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * GET https://openrouter.ai/api/v1/key (Bearer) → key validity + free-model limits. 20 req/min for `:free` models;
 * the daily cap is `free_model_daily_requests` when present, else 50 (free tier) / 1000 (≥ $10 credit). A best-effort
 * GET /api/v1/models adds the `:free` ids (as `openrouter/<id>`); its failure does not fail the probe.
 */
export async function probeOpenRouter(apiKey: string, opts: ProbeOpts = {}): Promise<SwarmProviderTestResult> {
  if (!apiKey) return result('invalid-key', { message: 'No OpenRouter key is set. Add one above to test the connection.' });
  const g = await get(OPENROUTER_KEY_URL, { authorization: `Bearer ${apiKey}` }, opts);
  if (!g.ok) return failure('OpenRouter', g, true);
  const d = g.json?.data ?? g.json ?? {};
  const isFreeTier = typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null;
  const daily = d.free_model_daily_requests && typeof d.free_model_daily_requests === 'object' ? d.free_model_daily_requests : null;
  const requestsPerDay = numOrNull(daily?.limit) ?? (isFreeTier === true ? 50 : isFreeTier === false ? 1000 : null);
  const remainingToday = numOrNull(daily?.remaining);
  const limits: SwarmProviderLimits = {
    requestsPerMinute: 20,
    requestsPerDay,
    remainingToday,
    resetsAt: epochMs(daily?.reset ?? daily?.resets_at ?? daily?.reset_at) ?? (requestsPerDay != null ? nextUtcMidnight() : null),
    isFreeTier,
  };
  let freeModels: string[] = [];
  const m = await get(OPENROUTER_MODELS_URL, {}, opts);
  if (m.ok) freeModels = ids(m.json).filter((id) => id.endsWith(':free')).map((id) => `openrouter/${id}`);
  if (remainingToday === 0) {
    return result('rate-limited', { latencyMs: g.ms, freeModels, limits, message: 'The key is valid, but today\'s free-model requests are used up.' });
  }
  return result('ok', { latencyMs: g.ms, freeModels, limits });
}

/** GET https://api.cerebras.ai/v1/models (Bearer) → key validity + model ids (`cerebras/<id>`). Static limits. */
export async function probeCerebras(apiKey: string, opts: ProbeOpts = {}): Promise<SwarmProviderTestResult> {
  if (!apiKey) return result('invalid-key', { message: 'No Cerebras key is set. Add one above to test the connection.' });
  const g = await get(CEREBRAS_MODELS_URL, { authorization: `Bearer ${apiKey}` }, opts);
  if (!g.ok) return failure('Cerebras', g, true);
  const models = ids(g.json).map((id) => `cerebras/${id}`);
  // ref-runtime B10: the trial's limits are static (5 requests/min; 1M tokens/day is not a request count).
  const limits: SwarmProviderLimits = { requestsPerMinute: 5, requestsPerDay: null, remainingToday: null, resetsAt: null, isFreeTier: null };
  if (!models.length) return result('no-free-models', { latencyMs: g.ms, limits, message: 'Cerebras lists no models for this key' });
  return result('ok', { latencyMs: g.ms, freeModels: models, limits });
}

// ---- local model servers (Ollama / LM Studio): localhost, no key, nothing leaves the machine ----------------------

const LOCAL_TIMEOUT_MS = 3000;
const LOCAL_LABEL = { ollama: 'Ollama', lmstudio: 'LM Studio' } as const;
/** What to do when the server is down / empty — the probe's message is shown as-is by the CLI and the UI. */
const LOCAL_HELP = {
  ollama: { start: 'start the Ollama app, or run `ollama serve`', pull: 'pull a tool-calling model, e.g. `ollama pull qwen3-coder:30b`' },
  lmstudio: { start: 'in LM Studio open Developer → Start Server, or run `lms server start`', pull: 'download a tool-calling model in LM Studio (e.g. Qwen3 Coder 30B)' },
} as const;

async function postJson(url: string, body: unknown, opts: ProbeOpts): Promise<any | null> {
  const f = opts.fetch ?? globalThis.fetch;
  try {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? LOCAL_TIMEOUT_MS) });
    if (!res.ok) { try { await res.text(); } catch { /* drain */ } return null; }
    return await res.json();
  } catch { return null; }
}

function localUnreachable(provider: 'ollama' | 'lmstudio', baseUrl: string, g: Extract<Got, { ok: false }>): SwarmProviderTestResult {
  const down = g.status == null; // connection refused / timeout: nothing is listening
  const why = down ? `is not running at ${baseUrl}` : `at ${baseUrl} answered HTTP ${g.status}`;
  return result('unreachable', { latencyMs: g.ms, message: `${LOCAL_LABEL[provider]} ${why} — ${LOCAL_HELP[provider].start}` });
}

const isEmbedding = (name: string, caps: string[] | null) => /embed/i.test(name) || (!!caps && caps.includes('embedding') && !caps.includes('completion'));

/**
 * Ollama: GET /api/tags → installed models; POST /api/show per model (≤ 16, parallel) → `capabilities`, keeping the
 * ones that list `tools` (workers are tool-calling agents). Unknown capabilities (older Ollama) are kept.
 * `freeModels` holds opencode `-m` ids: `ollama/<name>`.
 */
export async function probeOllama(baseUrl: string, opts: ProbeOpts = {}): Promise<SwarmProviderTestResult> {
  const o = { ...opts, timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS };
  const g = await get(`${baseUrl}/api/tags`, {}, o);
  if (!g.ok) return localUnreachable('ollama', baseUrl, g);
  const names: string[] = Array.isArray(g.json?.models) ? g.json.models.map((x: any) => (typeof x?.name === 'string' ? x.name : typeof x?.model === 'string' ? x.model : null)).filter(Boolean) : [];
  if (!names.length) return result('no-free-models', { latencyMs: g.ms, message: `Ollama has no models — ${LOCAL_HELP.ollama.pull}` });
  const caps = await Promise.all(names.slice(0, 16).map(async (name) => {
    const j = await postJson(`${baseUrl}/api/show`, { model: name }, o);
    return Array.isArray(j?.capabilities) ? (j.capabilities as unknown[]).map(String) : null;
  }));
  const usable = names.slice(0, 16).filter((name, i) => !isEmbedding(name, caps[i]) && (caps[i] == null || caps[i]!.includes('tools')));
  if (!usable.length) return result('no-free-models', { latencyMs: g.ms, message: `none of Ollama's ${names.length} model(s) supports tool calls, which workers need — ${LOCAL_HELP.ollama.pull}` });
  return result('ok', { latencyMs: g.ms, freeModels: usable.map((n) => `ollama/${n}`) });
}

/**
 * LM Studio: GET /api/v0/models (type + capabilities, LM Studio ≥ 0.3.6), else the OpenAI-compatible /v1/models.
 * Embedding models are dropped; a listed `capabilities` without `tool_use` drops the model too.
 */
export async function probeLmStudio(baseUrl: string, opts: ProbeOpts = {}): Promise<SwarmProviderTestResult> {
  const o = { ...opts, timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT_MS };
  let g = await get(`${baseUrl}/api/v0/models`, {}, o);
  if (!g.ok && g.status != null) g = await get(`${baseUrl}/v1/models`, {}, o);
  if (!g.ok) return localUnreachable('lmstudio', baseUrl, g);
  const rows: any[] = Array.isArray(g.json?.data) ? g.json.data : [];
  const all = rows.filter((x) => typeof x?.id === 'string');
  if (!all.length) return result('no-free-models', { latencyMs: g.ms, message: `LM Studio lists no models — ${LOCAL_HELP.lmstudio.pull}` });
  const usable = all.filter((x) => x.type !== 'embeddings' && !isEmbedding(x.id, null) && (!Array.isArray(x.capabilities) || x.capabilities.includes('tool_use')));
  if (!usable.length) return result('no-free-models', { latencyMs: g.ms, message: `none of LM Studio's ${all.length} model(s) supports tool calls, which workers need — ${LOCAL_HELP.lmstudio.pull}` });
  return result('ok', { latencyMs: g.ms, freeModels: usable.map((x) => `lmstudio/${x.id}`) });
}

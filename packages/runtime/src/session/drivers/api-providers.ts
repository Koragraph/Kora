// API-endpoint engines (Phase 7): OpenAI-compatible and Anthropic-compatible HTTP endpoints (OpenRouter, DeepSeek,
// Fireworks, Mistral, Groq, LM Studio, Ollama, any URL + key). This file is the endpoint model: presets, URLs, headers,
// the model list, the key-free Test call and the error classification that feeds the rate-limit card. `fetch` is injected
// so every test runs against a local fake server. Keys live in the daemon SecretStore (blobs/apps/secrets.ts) under
// `secretNameFor(endpointId)` - never in profile.json, env or logs.
import type { SecretStore } from '../../blobs/apps/secrets';

export type ApiProtocol = 'openai' | 'anthropic';
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiEndpoint {
  /** Slug, [a-z0-9-]{1,30}. Also the secret name suffix. */
  id: string;
  /** The driver's agent id: `api-<id>`. */
  agentId: string;
  label: string;
  protocol: ApiProtocol;
  /** Includes the version segment for OpenAI-style hosts (`https://api.groq.com/openai/v1`); the bare host for Anthropic. */
  baseUrl: string;
  /** False for local servers (LM Studio, Ollama) that take no key. */
  requiresKey: boolean;
  defaultModel?: string;
  /** Extra static headers (e.g. OpenRouter's HTTP-Referer). Never put secrets here. */
  headers?: Record<string, string>;
  /** Context window hint for the usage ring when the endpoint does not report one. */
  contextWindow?: number;
}

export const API_PRESETS: Omit<ApiEndpoint, 'agentId'>[] = [
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', requiresKey: true, defaultModel: 'deepseek-chat' },
  { id: 'fireworks', label: 'Fireworks', protocol: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', requiresKey: true },
  { id: 'mistral', label: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true, defaultModel: 'mistral-large-latest' },
  { id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true },
  { id: 'lmstudio', label: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', requiresKey: false },
  { id: 'ollama', label: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', requiresKey: false },
  { id: 'anthropic-api', label: 'Anthropic API', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', requiresKey: true },
];

const SLUG = /^[a-z0-9][a-z0-9-]{0,29}$/;

/** Validate + normalise a user-entered endpoint. Throws a sentence the form can show. */
export function normalizeEndpoint(i: Partial<ApiEndpoint> & { id: string }): ApiEndpoint {
  if (!SLUG.test(i.id)) throw new Error('The endpoint id may use lowercase letters, numbers and dashes (up to 30 characters).');
  const protocol: ApiProtocol = i.protocol === 'anthropic' ? 'anthropic' : 'openai';
  let u: URL;
  try { u = new URL(String(i.baseUrl ?? '')); } catch { throw new Error('The base URL is not a valid web address (include http:// or https://).'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The base URL must start with http:// or https://.');
  if (u.username || u.password) throw new Error('Put the key in the key field, not in the URL.');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.hostname.endsWith('.localhost');
  if (u.protocol === 'http:' && !local) throw new Error('Only local servers may use http://. Use https:// for a remote endpoint so your key is not sent in the clear.');
  const baseUrl = u.toString().replace(/\/+$/, '');
  return {
    id: i.id, agentId: `api-${i.id}`, label: (i.label ?? i.id).slice(0, 60), protocol, baseUrl,
    requiresKey: i.requiresKey ?? !local, ...(i.defaultModel ? { defaultModel: i.defaultModel } : {}),
    ...(i.headers ? { headers: i.headers } : {}), ...(i.contextWindow ? { contextWindow: i.contextWindow } : {}),
  };
}
export function presetEndpoint(id: string): ApiEndpoint | null {
  const p = API_PRESETS.find((x) => x.id === id);
  return p ? normalizeEndpoint(p) : null;
}

export const secretNameFor = (endpointId: string): string => `api-${endpointId}`.slice(0, 40);

/** Save / read / forget an endpoint's key through the daemon SecretStore. The store validates the value. */
export const endpointKeys = (store: SecretStore) => ({
  get: (id: string) => store.get(secretNameFor(id)),
  has: async (id: string) => !!(await store.get(secretNameFor(id)).catch(() => null)),
  set: (id: string, key: string) => store.set(secretNameFor(id), key.trim()),
  delete: (id: string) => store.delete(secretNameFor(id)),
});

// ── URLs + headers ───────────────────────────────────────────────────────────────────────────────────────────────
const trimV1 = (b: string) => b.replace(/\/v1$/, '');
export function chatUrl(ep: ApiEndpoint): string { return ep.protocol === 'anthropic' ? `${trimV1(ep.baseUrl)}/v1/messages` : `${ep.baseUrl}/chat/completions`; }
export function modelsUrl(ep: ApiEndpoint): string { return ep.protocol === 'anthropic' ? `${trimV1(ep.baseUrl)}/v1/models?limit=1000` : `${ep.baseUrl}/models`; }
export function authHeaders(ep: ApiEndpoint, key: string | null): Record<string, string> {
  const h: Record<string, string> = { ...(ep.headers ?? {}) };
  if (ep.protocol === 'anthropic') { h['anthropic-version'] = '2023-06-01'; if (key) h['x-api-key'] = key; }
  else if (key) h.authorization = `Bearer ${key}`;
  return h;
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type ApiErrorKind = 'auth' | 'rate_limit' | 'credit' | 'server' | 'client' | 'network' | 'aborted';
export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, message: string, readonly status?: number, readonly retryAfterMs?: number) { super(message); this.name = 'ApiError'; }
}

function providerMessage(body: string): string {
  try { const j = JSON.parse(body); const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail; if (m) return typeof m === 'string' ? m : JSON.stringify(m); } catch { /* not JSON */ }
  return body.replace(/\s+/g, ' ').trim();
}
export function parseRetryAfter(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

/** Turn an HTTP failure into a calm sentence + a kind the driver maps to the rate-limit card / a plain error. */
export function classifyHttp(ep: ApiEndpoint, status: number, body: string, headers?: Headers): ApiError {
  const detail = providerMessage(body).slice(0, 200);
  const retry = parseRetryAfter(headers?.get('retry-after'));
  if (status === 401 || status === 403) return new ApiError('auth', `${ep.label} rejected the API key (HTTP ${status}). Check or replace it in Settings > Engines.`, status);
  if (status === 402) return new ApiError('credit', `${ep.label} says the account is out of credit (HTTP 402). Top it up, or switch the blob to another engine.`, status);
  if (status === 429) return new ApiError('rate_limit', `${ep.label} is rate-limiting this key (HTTP 429)${retry ? `; it asks to wait ${Math.ceil(retry / 1000)}s` : ''}. Try again shortly or switch the blob to another engine.`, status, retry);
  if (status >= 500) return new ApiError('server', `${ep.label} is having trouble right now (HTTP ${status}). Try again in a moment.`, status, retry);
  if (status === 404) return new ApiError('client', `${ep.label} does not know that address or model (HTTP 404)${detail ? `: ${detail}` : ''}. Check the base URL and the model name.`, status);
  return new ApiError('client', `${ep.label} refused the request (HTTP ${status})${detail ? `: ${detail}` : ''}.`, status);
}
export function networkError(ep: ApiEndpoint, e: unknown): ApiError {
  const c = (e as any)?.cause;
  const m = String(c?.code ?? c?.errors?.[0]?.code ?? (e as any)?.code ?? c?.message ?? (e as any)?.message ?? e);
  if ((e as any)?.name === 'AbortError') return new ApiError('aborted', 'Cancelled.');
  const local = /localhost|127\.0\.0\.1/.test(ep.baseUrl);
  return new ApiError('network', local && /ECONNREFUSED/.test(m)
    ? `Nothing is listening at ${ep.baseUrl}. Start ${ep.label} and try again.`
    : /ENOTFOUND|EAI_AGAIN/.test(m)
      ? `Can't find ${ep.label} at that address. Check the base URL and your connection.`
      : /ECONNREFUSED/.test(m)
        ? `${ep.label} refused the connection. Check the base URL and that the service is running.`
        : /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout/i.test(m)
          ? `${ep.label} did not answer in time. Check your connection and the base URL.`
          : `Can't reach ${ep.label}. Check your connection and the base URL.`);
}

async function call(ep: ApiEndpoint, url: string, key: string | null, f: FetchFn, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try { res = await f(url, { method: 'GET', headers: authHeaders(ep, key), ...(signal ? { signal } : {}) }); }
  catch (e) { throw networkError(ep, e); }
  if (!res.ok) throw classifyHttp(ep, res.status, await res.text().catch(() => ''), res.headers);
  return res;
}

// ── model list + Test ────────────────────────────────────────────────────────────────────────────────────────────
export interface ApiModel { id: string; name: string }

export function parseModelList(json: any): ApiModel[] {
  const rows: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  return rows.map((m) => ({ id: String(m?.id ?? m?.name ?? ''), name: String(m?.display_name ?? m?.name ?? m?.id ?? '') })).filter((m) => m.id);
}

/** `GET /v1/models`. Throws ApiError. */
export async function listApiModels(ep: ApiEndpoint, key: string | null, f: FetchFn = fetch, signal?: AbortSignal): Promise<ApiModel[]> {
  const res = await call(ep, modelsUrl(ep), key, f, signal);
  return parseModelList(await res.json().catch(() => null));
}

export interface ApiTestResult { ok: boolean; kind: 'ok' | ApiErrorKind | 'no-model-list'; message: string; status?: number; modelCount?: number; models?: ApiModel[] }
/**
 * The Test button: checks the key and the catalog with `GET /models` - no chat request, so it costs nothing and sends no
 * message. A server that has no model list (404) but is reachable is reported as reachable, with the key untested.
 */
export async function testApiEndpoint(ep: ApiEndpoint, key: string | null, f: FetchFn = fetch, signal?: AbortSignal): Promise<ApiTestResult> {
  if (ep.requiresKey && !key) return { ok: false, kind: 'auth', message: `${ep.label} needs an API key. Paste one first.` };
  try {
    const models = await listApiModels(ep, key, f, signal);
    return { ok: true, kind: 'ok', message: models.length ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` : 'Connected, but the endpoint lists no models.', modelCount: models.length, models };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404) return { ok: true, kind: 'no-model-list', message: `${ep.label} answered but has no model list. Type the model name yourself; the key was not checked.`, status: 404 };
      return { ok: false, kind: e.kind, message: e.message, ...(e.status ? { status: e.status } : {}) };
    }
    return { ok: false, kind: 'network', message: String((e as any)?.message ?? e) };
  }
}

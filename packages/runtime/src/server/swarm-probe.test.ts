// swarm-probe with a fake fetch: parsing, 401 → invalid-key, 429 → rate-limited, timeouts, keys never in messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCerebras, probeLmStudio, probeOllama, probeOpenRouter, probeZen } from './swarm-probe';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(route: Route): { fetch: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const h = new Headers(init.headers as any);
    calls.push({ url, auth: h.get('authorization') });
    return route(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (n: number) => new Response('{"error":"x"}', { status: n });
const SECRET = 'sk-or-v1-secret-value-0000000000000000';

test('probeZen: free ids only (-free + big-pickle), as opencode/<id>; no auth header without a key', async () => {
  const f = fakeFetch(() => ok({ object: 'list', data: [{ id: 'claude-opus-5-5' }, { id: 'big-pickle' }, { id: 'glm-5-free' }, { id: 'gpt-5.5' }] }));
  const r = await probeZen({ fetch: f.fetch });
  assert.equal(r.ok, true); assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.freeModels, ['opencode/big-pickle', 'opencode/glm-5-free']);
  assert.equal(f.calls[0].url, 'https://opencode.ai/zen/v1/models');
  assert.equal(f.calls[0].auth, null);
  assert.equal(typeof r.latencyMs, 'number');
  assert.equal(r.limits, null);
});

test('probeZen: 401 without a key → invalid-key "needs an API key"; no free models → no-free-models', async () => {
  const r = await probeZen({ fetch: fakeFetch(() => status(401)).fetch });
  assert.equal(r.ok, false); assert.equal(r.outcome, 'invalid-key'); assert.match(r.message!, /needs an API key/);
  const n = await probeZen({ fetch: fakeFetch(() => ok({ data: [{ id: 'gpt-5.5' }] })).fetch });
  assert.equal(n.outcome, 'no-free-models'); assert.equal(n.ok, false);
});

test('probeOpenRouter: limits from /key (free_model_daily_requests), :free ids from /models', async () => {
  const f = fakeFetch((url) => url.endsWith('/key')
    ? ok({ data: { label: 'x', is_free_tier: true, free_model_daily_requests: { limit: 50, remaining: 41 } } })
    : ok({ data: [{ id: 'qwen/qwen3-coder:free' }, { id: 'openai/gpt-5.5' }] }));
  const r = await probeOpenRouter(SECRET, { fetch: f.fetch });
  assert.equal(r.outcome, 'ok'); assert.equal(r.ok, true);
  assert.deepEqual(r.freeModels, ['openrouter/qwen/qwen3-coder:free']);
  assert.equal(r.limits!.requestsPerMinute, 20);
  assert.equal(r.limits!.requestsPerDay, 50);
  assert.equal(r.limits!.remainingToday, 41);
  assert.equal(r.limits!.isFreeTier, true);
  assert.ok(r.limits!.resetsAt! > Date.now());
  assert.equal(f.calls[0].auth, `Bearer ${SECRET}`);
  assert.equal(f.calls[1].auth, null, 'the public models list gets no key');
});

test('probeOpenRouter: no daily block → 50/day on the free tier, 1000 with credit; 0 remaining → rate-limited', async () => {
  const paid = await probeOpenRouter(SECRET, { fetch: fakeFetch((u) => (u.endsWith('/key') ? ok({ data: { is_free_tier: false } }) : status(500))).fetch });
  assert.equal(paid.limits!.requestsPerDay, 1000); assert.deepEqual(paid.freeModels, []); assert.equal(paid.ok, true);
  const used = await probeOpenRouter(SECRET, { fetch: fakeFetch((u) => (u.endsWith('/key') ? ok({ data: { is_free_tier: true, free_model_daily_requests: { limit: 50, remaining: 0 } } }) : ok({ data: [] }))).fetch });
  assert.equal(used.outcome, 'rate-limited'); assert.equal(used.ok, false);
});

test('probeOpenRouter: 401 → invalid-key, 429 → rate-limited, network error → unreachable; the key never appears', async () => {
  const bad = await probeOpenRouter(SECRET, { fetch: fakeFetch(() => status(401)).fetch });
  assert.equal(bad.outcome, 'invalid-key'); assert.equal(bad.ok, false);
  const busy = await probeOpenRouter(SECRET, { fetch: fakeFetch(() => status(429)).fetch });
  assert.equal(busy.outcome, 'rate-limited');
  const down = await probeOpenRouter(SECRET, { fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }).fetch });
  assert.equal(down.outcome, 'unreachable');
  for (const r of [bad, busy, down]) assert.ok(!JSON.stringify(r).includes(SECRET));
  const none = await probeOpenRouter('', { fetch: fakeFetch(() => ok({})).fetch });
  assert.equal(none.outcome, 'invalid-key');
});

test('probes time out (8 s default; here 50 ms) as unreachable', async () => {
  const hang = ((_u: any, init: RequestInit = {}) => new Promise<Response>((_res, rej) => {
    init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  const r = await probeZen({ fetch: hang, timeoutMs: 50 });
  assert.equal(r.outcome, 'unreachable'); assert.match(r.message!, /no answer within/);
});

test('probeCerebras: ids as cerebras/<id>, static limits; 403 → invalid-key', async () => {
  const r = await probeCerebras('csk-000000000000000000', { fetch: fakeFetch(() => ok({ data: [{ id: 'qwen-3-coder-480b' }] })).fetch });
  assert.equal(r.outcome, 'ok'); assert.deepEqual(r.freeModels, ['cerebras/qwen-3-coder-480b']);
  assert.equal(r.limits!.requestsPerMinute, 5);
  const bad = await probeCerebras('csk-000000000000000000', { fetch: fakeFetch(() => status(403)).fetch });
  assert.equal(bad.outcome, 'invalid-key');
});

test('probeOllama: tool-capable models only (embeddings and tool-less dropped), as ollama/<name>', async () => {
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/api/tags')) return ok({ models: [{ name: 'qwen3-coder:30b' }, { name: 'nomic-embed-text:latest' }, { name: 'gemma3:4b' }, { name: 'old:1b' }] });
    const model = JSON.parse(String(init.body)).model;
    if (model === 'qwen3-coder:30b') return ok({ capabilities: ['completion', 'tools'] });
    if (model === 'gemma3:4b') return ok({ capabilities: ['completion', 'vision'] });
    if (model === 'nomic-embed-text:latest') return ok({ capabilities: ['embedding'] });
    return status(404); // older Ollama without capabilities: kept
  });
  const r = await probeOllama('http://127.0.0.1:11434', { fetch: f.fetch });
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.freeModels, ['ollama/qwen3-coder:30b', 'ollama/old:1b']);
  assert.ok(f.calls.every((c) => c.url.startsWith('http://127.0.0.1:11434/') && c.auth === null));
});

test('probeOllama / probeLmStudio: clear messages when the server is down, empty, or has no tool model', async () => {
  const down = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const r1 = await probeOllama('http://127.0.0.1:11434', { fetch: down.fetch });
  assert.equal(r1.outcome, 'unreachable');
  assert.match(r1.message!, /Ollama is not running at http:\/\/127\.0\.0\.1:11434 — start the Ollama app, or run `ollama serve`/);
  const empty = await probeOllama('http://x', { fetch: fakeFetch(() => ok({ models: [] })).fetch });
  assert.equal(empty.outcome, 'no-free-models'); assert.match(empty.message!, /ollama pull/);
  const lmDown = await probeLmStudio('http://127.0.0.1:1234', { fetch: down.fetch });
  assert.match(lmDown.message!, /LM Studio is not running .* Start Server/);
  const noTools = await probeLmStudio('http://x', { fetch: fakeFetch(() => ok({ data: [{ id: 'e5', type: 'embeddings' }, { id: 'tiny', type: 'llm', capabilities: [] }] })).fetch });
  assert.equal(noTools.outcome, 'no-free-models'); assert.match(noTools.message!, /tool calls/);
});

test('probeLmStudio: /api/v0/models, else /v1/models; lmstudio/<id>', async () => {
  const v0 = await probeLmStudio('http://x', { fetch: fakeFetch(() => ok({ data: [{ id: 'qwen3-coder-30b', type: 'llm', capabilities: ['tool_use'] }, { id: 'nomic-embed', type: 'embeddings' }] })).fetch });
  assert.deepEqual(v0.freeModels, ['lmstudio/qwen3-coder-30b']);
  const f = fakeFetch((url) => (url.includes('/api/v0/') ? status(404) : ok({ data: [{ id: 'openai/gpt-oss-20b' }] })));
  const v1 = await probeLmStudio('http://x', { fetch: f.fetch });
  assert.deepEqual(v1.freeModels, ['lmstudio/openai/gpt-oss-20b']);
  assert.deepEqual(f.calls.map((c) => c.url), ['http://x/api/v0/models', 'http://x/v1/models']);
});

test('probeOpenRouter / probeCerebras with no key: a full sentence, no request made', async () => {
  const f = fakeFetch(() => ok({}));
  const or = await probeOpenRouter('', { fetch: f.fetch });
  assert.equal(or.outcome, 'invalid-key');
  assert.equal(or.message, 'No OpenRouter key is set. Add one above to test the connection.');
  const cb = await probeCerebras('', { fetch: f.fetch });
  assert.equal(cb.message, 'No Cerebras key is set. Add one above to test the connection.');
  assert.equal(f.calls.length, 0);
});

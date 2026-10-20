import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWarmProxy, splitSessionPath, UsageTap } from './proxy';
import type { WarmMode, WarmRow } from './warm-engine';

const H = 'claude-haiku-4-5-20251001';
const mainBody = (extra: Record<string, any> = {}) => ({
  model: H, max_tokens: 4096, stream: true,
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '5m' } }],
  tools: [{ name: 'Bash', description: 'd', input_schema: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...extra,
});
const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":40000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"héllo 🌍"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
];

interface Seen { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }
async function rig(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void, mode: WarmMode = 'off') {
  const seen: Seen[] = [];
  const up = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const s = { url: req.url!, method: req.method!, headers: req.headers, body: Buffer.concat(chunks).toString() }; seen.push(s); handler(req, res, s); });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const rows: WarmRow[] = [];
  const proxy = createWarmProxy({ upstream: { protocol: 'http:', host: '127.0.0.1', port: (up.address() as any).port }, mode: () => mode, emit: (r) => rows.push(r) });
  const port = await proxy.listen(0);
  return { port, seen, rows, proxy, close: async () => { await proxy.close(); up.closeAllConnections?.(); await new Promise((r) => up.close(r)); } };
}
function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; chunks: Array<{ at: number; data: Buffer }>; body: string }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now(); const chunks: Array<{ at: number; data: Buffer }> = [];
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-SECRET', ...headers } }, (res) => {
      res.on('data', (c: Buffer) => chunks.push({ at: Date.now() - t0, data: c }));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, chunks, body: Buffer.concat(chunks.map((c) => c.data)).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

test('splitSessionPath', () => {
  assert.deepEqual(splitSessionPath('/s/abc/v1/messages?beta=true'), { session: 'abc', path: '/v1/messages?beta=true' });
  assert.deepEqual(splitSessionPath('/s/a%2Fb/v1/models'), { session: 'a/b', path: '/v1/models' });
  assert.deepEqual(splitSessionPath('/v1/messages'), { session: null, path: '/v1/messages' });
  assert.deepEqual(splitSessionPath('/s/%E0%A4%A/v1'), { session: null, path: '/s/%E0%A4%A/v1' });
});

test('UsageTap reads usage from SSE split at any byte, and from JSON', () => {
  const raw = Buffer.from(SSE.join(''));
  for (const cut of [1, 7, 100, 200, raw.length - 3]) {
    const t = new UsageTap(true); t.push(raw.subarray(0, cut)); t.push(raw.subarray(cut));
    assert.deepEqual(t.end(), { in: 5, cr: 0, cc: 40000, out: 12 }, `cut ${cut}`);
  }
  const j = new UsageTap(false); j.push(Buffer.from('{"usage":{"input_tokens":3,"cache_read_input_tokens":35560,"cache_creation_input_tokens":0,"output_tokens":0}}'));
  assert.deepEqual(j.end(), { in: 3, cr: 35560, cc: 0, out: 0 });
  assert.equal(new UsageTap(false).end(), null);
});

test('SSE passes through byte-exact, in chunks as the upstream sent them, with the session prefix stripped', async () => {
  const r = await rig((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
    let i = 0;
    const next = () => { if (i < SSE.length) { res.write(SSE[i++]); setTimeout(next, 120); } else res.end(); };
    next();
  });
  try {
    const out = await post(r.port, '/s/thread-1/v1/messages?beta=true', JSON.stringify(mainBody()), { 'anthropic-version': '2023-06-01' });
    assert.equal(out.status, 200);
    assert.equal(out.body, SSE.join(''));
    assert.equal(out.headers['x-upstream'], 'yes');
    assert.ok(out.chunks.length >= 3 && out.chunks[out.chunks.length - 1].at - out.chunks[0].at >= 200, 'streamed, not buffered until the end');
    assert.equal(r.seen[0].url, '/v1/messages?beta=true');
    assert.equal(r.seen[0].headers['x-api-key'], 'sk-SECRET');
    assert.equal(r.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(r.seen[0].headers['accept-encoding'], 'identity');
    assert.equal(r.seen[0].body, JSON.stringify(mainBody()), 'request body byte-exact');
  } finally { await r.close(); }
});

test('non-messages routes and unprefixed paths are forwarded untouched', async () => {
  const r = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
  try {
    const out = await post(r.port, '/v1/models', '{}', { 'accept-encoding': 'gzip' });
    assert.equal(out.body, '{"data":[]}');
    assert.equal(r.seen[0].headers['accept-encoding'], 'gzip', 'only /v1/messages gets identity encoding');
  } finally { await r.close(); }
});

test('upstream status codes (429 with retry-after) pass through unchanged', async () => {
  const r = await rig((_q, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }); res.end('{"type":"error"}'); });
  try {
    const out = await post(r.port, '/s/t/v1/messages', JSON.stringify(mainBody()));
    assert.equal(out.status, 429); assert.equal(out.headers['retry-after'], '7'); assert.equal(out.body, '{"type":"error"}');
  } finally { await r.close(); }
});

test('upstream unreachable: a 502 JSON error (so the CLI retries), never a hang', async () => {
  const p = createWarmProxy({ upstream: { protocol: 'http:', host: '127.0.0.1', port: 1 }, mode: () => 'off', emit: () => {} });
  const port = await p.listen(0);
  try {
    const out = await post(port, '/s/t/v1/messages', JSON.stringify(mainBody()));
    assert.equal(out.status, 502); assert.match(out.body, /api_error/);
  } finally { await p.close(); }
});

test('upstream dying mid-stream destroys the client connection (no clean-looking truncation)', async () => {
  const r = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(SSE[0]); setTimeout(() => res.destroy(), 50); });
  try {
    await assert.rejects(post(r.port, '/s/t/v1/messages', JSON.stringify(mainBody())));
  } finally { await r.close(); }
});

test('a client that aborts takes the upstream request with it', async () => {
  let upstreamClosed: () => void = () => {}; const closed = new Promise<void>((r) => { upstreamClosed = r; });
  const r = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(SSE[0]); res.on('close', upstreamClosed); });
  try {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: r.port, path: '/s/t/v1/messages', method: 'POST' }, (res) => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.on('error', () => {}); req.end(JSON.stringify(mainBody()));
    });
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream still open')), 2000))]);
  } finally { await r.close(); }
});

test('shadow mode: usage is tapped into the engine, nothing is sent upstream, headers and bodies never appear in rows', async () => {
  const r = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE.join('')); }, 'shadow');
  try {
    await post(r.port, '/s/t1/v1/messages', JSON.stringify(mainBody()));
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(r.seen.length, 1);
    assert.equal(r.proxy.engine.stats().streams, 1);
    const dump = JSON.stringify(r.rows);
    assert.ok(!dump.includes('sk-SECRET') && !dump.includes('hello'));
  } finally { await r.close(); }
});

test('off mode tracks nothing; a tiny probe request is never tracked', async () => {
  const r = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{"input_tokens":1,"output_tokens":1}}'); }, 'shadow');
  try {
    await post(r.port, '/s/t/v1/messages', JSON.stringify({ model: H, max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }));
    await new Promise((x) => setTimeout(x, 30));
    assert.equal(r.proxy.engine.stats().streams, 0);
  } finally { await r.close(); }
});

test('health endpoint', async () => {
  const r = await rig((_q, res) => res.end());
  try {
    const out = await new Promise<string>((resolve) => http.get({ host: '127.0.0.1', port: r.port, path: '/__kora_health' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }));
    assert.equal(out, 'ok');
  } finally { await r.close(); }
});

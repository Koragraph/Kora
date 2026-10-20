// Edge cases of the keep-warm engine, proxy and manager (test/savings 2026-10-14): mode flips at runtime, a model switch, two
// threads with one prefix, shadow sending nothing through the real proxy, a proxy child that dies mid-stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RETURN_DIST } from './policy';
import { WarmEngine, type HeldRequest, type WarmMode, type WarmRow, type WarmSendResult } from './warm-engine';
import { createWarmProxy } from './proxy';
import { CacheWarmManager } from './manager';

const MIN = 60_000;
const H = 'claude-haiku-4-5-20251001';
const mkBody = (model = H, first = 'hello', ttl: '5m' | '1h' = '5m') => ({
  model, max_tokens: 4096, stream: true,
  ...(model.includes('haiku') ? {} : { thinking: { type: 'adaptive' } }),
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
  tools: [{ name: 'Bash', description: 'd', input_schema: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: first }] }],
});

function rig(mode: WarmMode = 'on') {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; dead?: boolean }> = [];
  const rows: WarmRow[] = []; const sent: Array<{ held: HeldRequest; body: any }> = [];
  const state = { mode };
  const engine = new WarmEngine({
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: (h) => { (h as any).dead = true; },
    send: async (held, b): Promise<WarmSendResult> => { sent.push({ held, body: JSON.parse(b) }); return { status: 200, usage: { in: 3, cr: 40_000, cc: 0, out: 0 } }; },
    emit: (r) => rows.push(r),
    mode: () => state.mode,
    dist: () => DEFAULT_RETURN_DIST,
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.dead = true; t = Math.max(t, next.at); next.fn();
      await new Promise((r) => setImmediate(r));
    }
    t = end;
  };
  const request = (session: string, body: any) => {
    const tk = engine.onRequest(session, body, Buffer.from(JSON.stringify(body)), '/v1/messages', { authorization: 'Bearer SECRET' });
    engine.onResponseStart(tk, 200); engine.onResponseEnd(tk, 200, { in: 5, cr: 0, cc: 40_000, out: 100 });
    return tk;
  };
  return { engine, rows, sent, advance, request, state };
}

test('edge: shadow over three hours sends nothing and holds nothing', async () => {
  const r = rig('shadow');
  r.request('s', mkBody());
  await r.advance(180 * MIN);
  assert.equal(r.sent.length, 0);
  assert.equal(r.engine.stats().held, 0);
  assert.ok(r.rows.some((x) => x.k === 'warm-shadow' && x.go === true), 'shadow still decides');
});

test('edge: a flip on -> shadow mid-chain stops sending and drops the held credentials', async () => {
  const r = rig('on');
  r.request('s', mkBody());
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.engine.stats().held, 1);
  r.state.mode = 'shadow';
  await r.advance(30 * MIN);
  assert.equal(r.sent.length, 1, 'no warm in shadow');
  assert.equal(r.engine.stats().held, 0, 'shadow holds no body or credentials');
});

test('edge: a flip shadow -> on takes effect at the next real request; on -> off stops the chain', async () => {
  const r = rig('shadow');
  r.request('s', mkBody());
  r.state.mode = 'on';
  r.request('s', mkBody());
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 1);
  r.state.mode = 'off';
  await r.advance(60 * MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.engine.stats().held, 0);
});

test('edge: a model switch mid-thread is the same stream and the warm replays the NEW model', async () => {
  const r = rig('on');
  r.request('s', mkBody(H));
  r.request('s', mkBody('claude-sonnet-5'));
  assert.equal(r.engine.stats().streams, 1);
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body.model, 'claude-sonnet-5');
  // a switch to a family no replay was verified for stops warming (fail closed)
  r.request('s', mkBody('claude-fable-5-1'));
  await r.advance(60 * MIN);
  assert.equal(r.sent.length, 1);
});

test('edge: two threads sharing a prefix keep separate chains; forgetting one leaves the other', async () => {
  const r = rig('on');
  r.request('a', mkBody()); r.request('b', mkBody());
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 2);
  r.engine.forget('a');
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 3);
  assert.ok(r.rows.filter((x) => x.k === 'warm').every((x) => x.thread === 'a' ? (x.ts as number) < 1_000_000 + 6 * MIN : true));
});

test('edge (real proxy, fake clock): shadow sends no extra upstream request however long the session idles', async () => {
  const seen: string[] = [];
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => { seen.push(req.url!); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":40000,"output_tokens":3}}'); }); });
  await new Promise<void>((x) => up.listen(0, '127.0.0.1', x));
  let t = 5_000_000; const timers: Array<{ at: number; fn: () => void; dead?: boolean }> = [];
  const rows: WarmRow[] = [];
  const p = createWarmProxy({
    upstream: { protocol: 'http:', host: '127.0.0.1', port: (up.address() as any).port }, mode: () => 'shadow', emit: (row) => rows.push(row),
    clock: { now: () => t, setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; }, clearTimer: (h) => { (h as any).dead = true; } },
  });
  const port = await p.listen(0);
  try {
    await new Promise<void>((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, path: '/s/th/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
      q.on('error', reject); q.end(JSON.stringify({ ...mkBody(), stream: false }));
    });
    await new Promise((x) => setTimeout(x, 50));
    for (let i = 0; i < 40; i++) {
      const next = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.dead = true; t = next.at; next.fn(); await new Promise((x) => setTimeout(x, 5));
    }
    assert.equal(seen.length, 1, 'only the real request went upstream');
    assert.ok(rows.some((x) => x.k === 'warm-shadow'), 'shadow rows were logged');
  } finally { await p.close(); await new Promise((x) => up.close(x)); }
});

test('edge (real child): the proxy dying MID-STREAM errors that request; the same URL works again after the restart', async () => {
  let release: () => void = () => {};
  const up = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
      if (req.headers['x-slow']) { release = () => { try { res.end(); } catch { /* gone */ } }; } else res.end('event: message_stop\ndata: {}\n\n');
    });
  });
  await new Promise<void>((x) => up.listen(0, '127.0.0.1', x));
  const m = new CacheWarmManager({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cwe-')), mode: () => 'shadow', env: {}, upstream: `http://127.0.0.1:${(up.address() as any).port}`, sink: () => {} });
  const hit = (u: string, slow = false) => new Promise<number>((resolve, reject) => {
    const q = http.request(`${u}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(slow ? { 'x-slow': '1' } : {}) } }, (res) => {
      if (slow) res.once('data', () => (m as any).child.kill('SIGKILL'));
      res.resume(); res.on('end', () => resolve(res.statusCode!)); res.on('error', reject);
    });
    q.on('error', reject); q.end(JSON.stringify(mkBody()));
  });
  try {
    const url = (await m.baseUrl('t-mid'))!;
    assert.ok(url);
    await assert.rejects(hit(url, true), 'a stream cut by the dying child is an error, not a clean end');
    // the CLI retries; the child comes back on the same port
    let status = 0;
    for (let i = 0; i < 30 && status !== 200; i++) { await new Promise((x) => setTimeout(x, 100)); status = await hit(url).catch(() => 0); }
    assert.equal(status, 200);
    assert.equal(await m.baseUrl('t-mid'), url);
  } finally { release(); await m.shutdown(); up.closeAllConnections?.(); await new Promise((x) => up.close(x)); }
});

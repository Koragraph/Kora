import test from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS } from './policy';
import { MAX_IN_FLIGHT, WarmEngine, type HeldRequest, type WarmMode, type WarmRow, type WarmSendResult } from './warm-engine';

const MIN = 60_000;
const H = 'claude-haiku-4-5-20251001';
const mkBody = (ttl: '5m' | '1h', first = 'hello') => ({
  model: H, max_tokens: 4096, stream: true,
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
  tools: [{ name: 'Bash', description: 'd', input_schema: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: first }] }],
});
const HEADERS = { authorization: 'Bearer SECRET', 'anthropic-version': '2023-06-01' };

function rig(mode: WarmMode = 'on', send?: (h: HeldRequest, body: string) => Promise<WarmSendResult>) {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number; dead?: boolean }> = [];
  let ids = 0;
  const rows: WarmRow[] = []; const sent: Array<{ held: HeldRequest; body: any }> = [];
  const state = { mode };
  const engine = new WarmEngine({
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn, id: ++ids }; timers.push(x); return x; },
    clearTimer: (h) => { (h as any).dead = true; },
    send: send ?? (async (held, b) => { sent.push({ held, body: JSON.parse(b) }); return { status: 200, usage: { in: 3, cr: 40_000, cc: 0, out: 0 } }; }),
    emit: (r) => rows.push(r),
    mode: () => state.mode,
    dist: () => (require('./policy') as typeof import('./policy')).DEFAULT_RETURN_DIST,
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
  const request = (session: string, body: any, usage = { in: 5, cr: 0, cc: 40_000, out: 100 }) => {
    const raw = Buffer.from(JSON.stringify(body));
    const tk = engine.onRequest(session, body, raw, '/v1/messages', HEADERS);
    engine.onResponseStart(tk, 200);
    engine.onResponseEnd(tk, 200, usage);
    return tk;
  };
  return { engine, rows, sent, advance, request, state, live: () => timers.filter((x) => !x.dead).length, now: () => t };
}

test('5m stream: one warm at 0.9 x TTL, replay is the same body with max_tokens 0 and stream false', async () => {
  const r = rig();
  r.request('s1', mkBody('5m'));
  await r.advance(4 * MIN); assert.equal(r.sent.length, 0);
  await r.advance(MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body.max_tokens, 0); assert.equal(r.sent[0].body.stream, false);
  assert.equal(r.sent[0].held.headers.authorization, 'Bearer SECRET');
  const w = r.rows.find((x) => x.k === 'warm')!;
  assert.equal(w.status, 200); assert.equal(w.cr, 40_000); assert.equal(w.cc, 0);
});

test('a real request cancels the pending warm and restarts the clock', async () => {
  const r = rig();
  r.request('s1', mkBody('5m'));
  await r.advance(4 * MIN);
  r.request('s1', mkBody('5m'));
  await r.advance(4 * MIN); assert.equal(r.sent.length, 0, 'the first timer must be dead');
  await r.advance(MIN); assert.equal(r.sent.length, 1);
});

test('the chain stops by itself once the return probability is too small', async () => {
  const r = rig();
  r.request('s1', mkBody('5m'));
  await r.advance(300 * MIN);
  const n = r.sent.length;
  assert.ok(n >= 1 && n < 40, `warms sent: ${n}`);
  const idleMax = r.sent.length * 4.5;
  assert.ok(idleMax <= 125, 'never past the 120 min horizon (+ one interval)');
  await r.advance(300 * MIN); assert.equal(r.sent.length, n, 'and it stays stopped');
  assert.equal(r.live(), 0);
});

test('off mode tracks nothing; shadow mode holds nothing and sends nothing', async () => {
  const off = rig('off');
  assert.equal(off.request('s1', mkBody('5m')), null);
  await off.advance(10 * MIN); assert.equal(off.sent.length + off.rows.length, 0);

  const sh = rig('shadow');
  sh.request('s1', mkBody('1h'));
  await sh.advance(55 * MIN);
  assert.equal(sh.sent.length, 0);
  const row = sh.rows.find((x) => x.k === 'warm-shadow')!;
  assert.ok(row, 'a shadow row was logged'); assert.equal(row.go, true);
  assert.ok(!JSON.stringify(sh.rows).includes('SECRET'));
});

test('a request without cache_control (the title call) is neither held nor counted', async () => {
  const r = rig();
  const title = { model: H, max_tokens: 64, system: 'make a title', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(r.engine.onRequest('s1', title, Buffer.from(JSON.stringify(title)), '/v1/messages', HEADERS), null);
  r.request('s1', mkBody('5m'));
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body.system[0].text, 'sys', 'the replayed body is the main request');
});

test('only the primary stream of a session is warmed (a subagent does not get its own chain)', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.request('s1', mkBody('5m', 'main'));
  r.request('s1', mkBody('5m', 'subagent task'));
  await r.advance(5 * MIN);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body.messages[0].content[0].text, 'main');
});

test('non-200 or a rewrite stops that stream; 429 pauses everyone', async () => {
  const r = rig('on', async () => ({ status: 429, usage: null, retryAfterMs: 1000 }));
  r.request('a', mkBody('5m', 'a')); r.request('b', mkBody('5m', 'b'));
  await r.advance(5 * MIN);
  assert.equal(r.rows.filter((x) => x.k === 'warm').length, 1, 'the second stream is held back by the backoff');
  await r.advance(60 * MIN);
  assert.equal(r.rows.filter((x) => x.k === 'warm').length, 1, 'neither retries');

  const rw = rig('on', async () => ({ status: 200, usage: { in: 1, cr: 0, cc: 40_000, out: 0 } }));
  rw.request('a', mkBody('5m'));
  await rw.advance(60 * MIN);
  const warms = rw.rows.filter((x) => x.k === 'warm');
  assert.equal(warms.length, 1); assert.equal(warms[0].rewrote, true);
});

test('at most MAX_IN_FLIGHT replays at once', async () => {
  let live = 0; let peak = 0;
  const r = rig('on', async () => { live++; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 15)); live--; return { status: 200, usage: { in: 1, cr: 40_000, cc: 0, out: 0 } }; });
  for (const s of ['a', 'b', 'c', 'd']) r.request(s, mkBody('5m', s));
  await r.advance(5 * MIN);
  await new Promise((x) => setTimeout(x, 100));
  assert.ok(peak <= MAX_IN_FLIGHT, `peak ${peak}`);
});

test('forget drops the timers and the held credentials', async () => {
  const r = rig();
  r.request('s1', mkBody('5m'));
  r.engine.forget('s1');
  await r.advance(10 * MIN);
  assert.equal(r.sent.length, 0); assert.equal(r.live(), 0);
});

test('warm-next reports whether the cache survived a gap', async () => {
  const r = rig();
  r.request('s1', mkBody('5m'));
  await r.advance(5 * MIN); // one warm
  r.request('s1', mkBody('5m'), { in: 5, cr: 40_100, cc: 10, out: 50 });
  const next = r.rows.find((x) => x.k === 'warm-next')!;
  assert.ok(next); assert.equal(next.hit, true);
});

test('a 1h TTL is the one the timer follows', () => {
  assert.equal(TTL_MS['1h'], 60 * MIN);
});

// The cheap-model chain (free OpenCode -> opt-in Claude haiku -> nothing), its daily cap, the QA stub, and the rule that a
// blob folder is an assistant folder for the pane preparation (no rulebook, no hooks written there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-ex-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');

import { makeOneShot, makeWarmClaude, stubExtractor, CLAUDE_DAILY_CAP, type OneShotDeps } from './extractor';
import { BlobStore } from './store';
import { Runtime } from '../server/workspace';

function deps(over: Partial<OneShotDeps> = {}): OneShotDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    consent: () => true,
    opencodePath: () => '/bin/opencode',
    pickFree: (ex) => (['m1', 'm2'].find((m) => !ex.includes(m)) ? { id: ['m1', 'm2'].find((m) => !ex.includes(m))!, env: { K: 'v' } } : null),
    runOpencode: async (i) => { calls.push(`oc:${i.model}`); return { text: `answer from ${i.model}`, failed: false, rateLimited: false, error: null }; },
    markCooling: (m) => { calls.push(`cool:${m}`); },
    claudeFallback: () => false,
    runClaude: async () => { calls.push('claude'); return { text: 'haiku says hi', failed: false }; },
    scratchDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-')),
    ...over,
  };
}

test('chain: a free model answers first', async () => {
  const d = deps();
  const r = await makeOneShot(d)('extract');
  assert.deepEqual(r, { text: 'answer from m1', model: 'm1' });
  assert.deepEqual(d.calls, ['oc:m1']);
});

test('chain: a rate-limited model cools down and the next free model is tried once', async () => {
  const d = deps({ runOpencode: async (i) => { d.calls.push(`oc:${i.model}`); return i.model === 'm1' ? { text: '', failed: true, rateLimited: true, error: '429' } : { text: 'ok from m2', failed: false, rateLimited: false, error: null }; } });
  const r = await makeOneShot(d)('x');
  assert.equal(r?.model, 'm2');
  assert.deepEqual(d.calls, ['oc:m1', 'cool:m1', 'oc:m2']);
});

test('chain: no consent -> free models are NOT used (chat text stays on the Mac); Claude only when switched on, capped per day', async () => {
  const d = deps({ consent: () => false });
  assert.equal(await makeOneShot(d)('x'), null, 'no consent, no fallback');
  assert.deepEqual(d.calls, []);
  const f = path.join(root, 'counter.json');
  const d2 = deps({ consent: () => false, claudeFallback: () => true, counterFile: f });
  const one = makeOneShot(d2);
  assert.equal((await one('x'))?.model, 'claude-haiku-5-5');
  assert.equal(one.claudeCallsToday(), 1);
  fs.writeFileSync(f, JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: CLAUDE_DAILY_CAP }));
  assert.equal(await one('x'), null, 'daily cap reached');
  assert.equal(makeOneShot(d2).claudeCallsToday(), CLAUDE_DAILY_CAP);
});

test('chain: free models exhausted falls back to Claude when enabled; everything failing yields null, never a throw', async () => {
  const d = deps({ claudeFallback: () => true, runOpencode: async () => ({ text: '', failed: true, rateLimited: true, error: null }) });
  assert.equal((await makeOneShot(d)('x'))?.model, 'claude-haiku-5-5');
  const dead = deps({ runOpencode: async () => { throw new Error('boom'); }, claudeFallback: () => true, runClaude: async () => { throw new Error('nope'); } });
  assert.equal(await makeOneShot(dead)('x'), null);
  assert.equal(await makeOneShot(deps({ opencodePath: () => null }))('x'), null);
});

test('chain: calls run one at a time', async () => {
  let running = 0, max = 0;
  const d = deps({ runOpencode: async (i) => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 15)); running--; return { text: i.prompt, failed: false, rateLimited: false, error: null }; } });
  const one = makeOneShot(d);
  await Promise.all([one('a'), one('b'), one('c')]);
  assert.equal(max, 1);
});

test('stub extractor (KORA_BLOBS_EXTRACTOR=stub): deterministic memory ops and summaries for QA', () => {
  const ops = JSON.parse(stubExtractor('Existing facts:\n(none)\n\nUSER said:\nplease remember that my dog is called Biscuit\n\nASSISTANT replied:\nok\n\nJSON:'));
  assert.equal(ops.ops[0].op, 'add');
  assert.match(ops.ops[0].text, /dog is called Biscuit/);
  assert.deepEqual(JSON.parse(stubExtractor('USER said:\nhello\n\nASSISTANT replied:\nhi')), { ops: [] });
  assert.match(JSON.parse(stubExtractor('Conversation:\nuser: x'))?.summary, /stub/);
});

test('prepareChatSession for a blob folder: assistant folder - KORA_* env only, no rulebook, no files written into the workspace', async () => {
  const store = new BlobStore();
  const b = store.create({ name: 'Popo', title: 'Researcher', soul: '', engine: { instanceId: 'claude', model: 'sonnet', effort: null } });
  const rt = new Runtime(path.join(root, 's.sock'));
  try {
    const prep = await rt.prepareChatSession({ threadId: 't1', agent: 'claude', cwd: path.join(b.workspace, 'outputs') });
    assert.ok(prep.notes.some((n) => /no rulebook\/hooks/.test(n)), prep.notes.join('|'));
    assert.equal(prep.appendSystemPrompt, undefined);
    assert.equal(prep.env.KORA_INJECT_OWNER, 'driver');
    for (const f of ['CLAUDE.md', 'AGENTS.md', path.join('.claude', 'settings.local.json')]) assert.equal(fs.existsSync(path.join(b.workspace, f)), false, f);
  } finally { rt.shutdown(); }
});

// ---- 2026-10-09: the extractor chain could never succeed (2 x 60 s free attempts inside a 120 s host timeout) ----------
import { CHAIN_WORST_CASE_MS, CLAUDE_ATTEMPT_MS, EXTRACT_CALL_TIMEOUT_MS, EXTRACT_DEADLINE_MS, FREE_ATTEMPT_MS } from './extract-budget';
import { callTimeoutMs } from './memory-host';

function clocked(over: Partial<OneShotDeps> = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  const d: OneShotDeps & { calls: string[]; clock: { t: number } } = {
    ...deps(),
    calls,
    clock: { get t() { return t; }, set t(v: number) { t = v; } },
    now: () => t,
    pickFree: (ex) => { const id = ['m1', 'm2', 'm3'].find((m) => !ex.includes(m)); return id ? { id, env: {} } : null; },
    runOpencode: async (i) => { calls.push(`oc:${i.model}`); t += i.budgetMs; return { text: '', failed: true, rateLimited: false, error: null }; }, // hangs to the budget
    runClaude: async (_p, budget) => { calls.push('claude'); t += 4_000; return { text: '{"ops":[]}', failed: false }; },
    ...over,
  };
  return d;
}

test('budget: the chain finishes inside the engine deadline, and the host timeout is longer than both', () => {
  assert.equal(CHAIN_WORST_CASE_MS, 2 * FREE_ATTEMPT_MS + CLAUDE_ATTEMPT_MS);
  assert.ok(CHAIN_WORST_CASE_MS < EXTRACT_DEADLINE_MS, 'chain < engine deadline');
  assert.ok(EXTRACT_DEADLINE_MS < EXTRACT_CALL_TIMEOUT_MS, 'engine deadline < host timeout');
  assert.equal(callTimeoutMs('ingestTurn'), EXTRACT_CALL_TIMEOUT_MS);
  assert.equal(callTimeoutMs('summarizeThread'), EXTRACT_CALL_TIMEOUT_MS);
  assert.ok(callTimeoutMs('tidy') >= EXTRACT_DEADLINE_MS);
});

test('chain: two hung free models then Claude haiku answers - all inside the host timeout (fake clock)', async () => {
  const d = clocked({ claudeFallback: () => true });
  const t0 = d.clock.t;
  const r = await makeOneShot(d)('extract');
  assert.equal(r?.model, 'claude-haiku-5-5');
  assert.deepEqual(d.calls, ['oc:m1', 'oc:m2', 'claude']);
  const elapsed = d.clock.t - t0;
  assert.ok(elapsed <= CHAIN_WORST_CASE_MS, `chain took ${elapsed} ms`);
  assert.ok(elapsed < EXTRACT_CALL_TIMEOUT_MS);
});

test('breaker: a rate-limited model rests 15 min, is not asked again, and comes back after; repeats double the rest', async () => {
  const d = clocked({ runOpencode: async (i) => { d.calls.push(`oc:${i.model}`); return i.model === 'm1' ? { text: '', failed: true, rateLimited: true, error: '429' } : { text: 'ok', failed: false, rateLimited: false, error: null }; } });
  const one = makeOneShot(d);
  assert.equal((await one('a'))?.model, 'm2');
  d.calls.length = 0;
  assert.equal((await one('b'))?.model, 'm2');
  assert.deepEqual(d.calls, ['oc:m2'], 'm1 is resting: not spawned');
  d.clock.t += 14 * 60_000;
  await one('c');
  assert.ok(!d.calls.includes('oc:m1'), 'still resting at 14 min');
  d.clock.t += 61_000;
  d.calls.length = 0;
  await one('d');
  assert.equal(d.calls[0], 'oc:m1', 'back after 15 min');
  // second rate limit on m1: the rest doubles to 30 min
  d.clock.t += 20 * 60_000;
  d.calls.length = 0;
  await one('e');
  assert.ok(!d.calls.includes('oc:m1'), '20 min after the second limit is still inside the doubled rest');
  assert.ok(one.status().breakers.some((b) => b.model === 'm1' && b.kind === 'rate-limit' && b.fails === 2));
});

test('no hammering: a dead chain (everything limited, Claude off) spawns at most once per model, then nothing', async () => {
  const d = clocked({ runOpencode: async (i) => { d.calls.push(`oc:${i.model}`); return { text: '', failed: true, rateLimited: true, error: '429' }; } });
  const one = makeOneShot(d);
  for (let i = 0; i < 25; i++) { assert.equal(await one(`turn ${i}`), null); d.clock.t += 60_000; } // a retry every minute for 25 min
  assert.ok(d.calls.length <= 2 + 2 + 2, `spawned ${d.calls.length} times in 25 minutes`);
  const st = one.status();
  assert.ok(st.retryAt && st.retryAt > d.clock.t - 60_000, 'status tells the caller when to try again');
  assert.equal(st.lastModel, null);
});

test('breaker: a timeout rests the model 5 min, a plain error 1 min', async () => {
  const hang = clocked();
  const one = makeOneShot(hang);
  await one('x');
  assert.deepEqual(one.status().breakers.map((b) => [b.model, b.kind]).sort(), [['m1', 'timeout'], ['m2', 'timeout']]);
  const quick = clocked({ runOpencode: async (i) => { quick.calls.push(`oc:${i.model}`); return { text: '', failed: true, rateLimited: false, error: 'bad gateway' }; } });
  const o2 = makeOneShot(quick);
  await o2('x');
  const b = o2.status().breakers.find((x) => x.model === 'm1')!;
  assert.equal(b.kind, 'error');
  assert.equal(b.until - quick.clock.t, 60_000);
});

test('breaker state survives a daemon restart (stored beside the Claude counter) and Claude has its own breaker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-'));
  const counterFile = path.join(dir, 'claude.json');
  const d = clocked({ counterFile, claudeFallback: () => true, pickFree: (ex) => { const id = ['m1', 'm2'].find((m) => !ex.includes(m)); return id ? { id, env: {} } : null; }, runClaude: async () => { d.calls.push('claude'); return { text: '', failed: true }; } });
  await makeOneShot(d)('x');
  d.calls.length = 0;
  const again = makeOneShot(d); // "restart"
  assert.equal(await again('y'), null);
  assert.deepEqual(d.calls, [], 'free models and haiku all still resting after the restart: nothing spawned');
  assert.equal(again.status().breakers.length, 3);
});

test('status names the model that actually answered (not the first one picked)', async () => {
  const d = clocked({ runOpencode: async (i) => { d.calls.push(`oc:${i.model}`); return i.model === 'm1' ? { text: '', failed: true, rateLimited: true, error: '429' } : { text: 'x', failed: false, rateLimited: false, error: null }; } });
  const one = makeOneShot(d);
  await one('q');
  assert.equal(one.status().lastModel, 'm2');
  assert.ok(one.status().lastAt);
});

test('a throwing free runner does not stop the chain before Claude', async () => {
  const d = clocked({ claudeFallback: () => true, runOpencode: async () => { throw new Error('spawn failed'); } });
  assert.equal((await makeOneShot(d)('x'))?.model, 'claude-haiku-5-5');
});

// ---- the real runner, against fake `opencode` executables ---------------------------------------------------------------
import { runOpencodeFast } from './extractor';

function fakeOpencode(body: string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakeoc-')), 'opencode');
  fs.writeFileSync(f, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return f;
}
const run = (opencode: string, budgetMs = 5000) => runOpencodeFast({ opencode, model: 'opencode/x-free', cwd: os.tmpdir(), prompt: 'p', env: {}, budgetMs });
const textEvent = (t: string) => JSON.stringify({ type: 'text', part: { type: 'text', text: t } });

test('runOpencodeFast: never waits on stdin (opencode blocks reading an open pipe - the bug that failed every extraction)', async () => {
  // this fake blocks on `cat` exactly like opencode did; it only answers once stdin reaches EOF
  const oc = fakeOpencode(`cat >/dev/null\necho '${textEvent('{"ops":[]}')}'`);
  const t0 = Date.now();
  const r = await run(oc);
  assert.equal(r.text, '{"ops":[]}');
  assert.equal(r.failed, false);
  assert.ok(Date.now() - t0 < 3000);
});

test('runOpencodeFast: a rate-limit event ends the call at once (not at the budget)', async () => {
  const oc = fakeOpencode(`echo '{"type":"error","error":{"name":"APIError","data":{"statusCode":429,"message":"Rate limit exceeded"}}}'\nsleep 30`);
  const t0 = Date.now();
  const r = await run(oc, 20_000);
  assert.equal(r.rateLimited, true);
  assert.equal(r.failed, true);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('runOpencodeFast: a hung process is killed at the budget and reported as a plain failure', async () => {
  const oc = fakeOpencode('sleep 30');
  const t0 = Date.now();
  const r = await run(oc, 600);
  assert.equal(r.failed, true);
  assert.equal(r.rateLimited, false);
  assert.ok(Date.now() - t0 < 3000);
  const missing = await runOpencodeFast({ opencode: '/no/such/opencode', model: 'm', cwd: os.tmpdir(), prompt: 'p', env: {}, budgetMs: 500 });
  assert.equal(missing.failed, true);
});

// ── live QA #2: rotation skips dead / deprecated models ──────────────────────────────────────────────────────────────────
import { NEVER_EXTRACT_WITH } from './extractor';

test('chain: a model the provider says does not exist is reported gone (off the swarm catalog for a day) and not asked again; exo-free is never asked', async () => {
  const gone: string[] = [];
  const d = deps({
    pickFree: (ex) => { const id = ['opencode/exo-free', 'm1', 'm2'].find((m) => !ex.includes(m)); return id ? { id, env: {} } : null; },
    markGone: (m) => gone.push(m),
    runOpencode: async (i) => { d.calls.push(`oc:${i.model}`); return i.model === 'm1' ? { text: '', failed: true, rateLimited: false, error: 'ProviderModelNotFoundError: model m1 not found' } : { text: `ok ${i.model}`, failed: false, rateLimited: false, error: null }; },
  });
  assert.ok(NEVER_EXTRACT_WITH.includes('opencode/exo-free'));
  const one = makeOneShot(d);
  assert.equal((await one('x'))?.model, 'm2');
  assert.deepEqual(d.calls, ['oc:m1', 'oc:m2'], 'exo-free was skipped without a call');
  assert.deepEqual(gone, ['m1']);
  const st = one.status();
  assert.equal(st.breakers[0]!.model, 'm1');
  assert.equal(st.breakers[0]!.kind, 'gone');
  assert.ok(st.breakers[0]!.until - Date.now() > 5 * 3_600_000, 'rested for hours, not minutes');
  assert.equal((await one('y'))?.model, 'm2');
  assert.deepEqual(d.calls, ['oc:m1', 'oc:m2', 'oc:m2'], 'm1 is not retried');
});

test('chain: memory work never reaches Claude unless the user allowed it (claudeMemoryFallback), even when signed in', async () => {
  // signed in, flag OFF, no free model: nothing runs (the turn is queued by the caller)
  let asked = 0;
  const off = deps({ claudeReady: () => true, consent: () => false, runClaude: async () => { asked++; return { text: 'x', failed: false }; } });
  assert.equal(await makeOneShot(off)('extract'), null);
  assert.equal(asked, 0, 'Haiku memory work must not run while the setting is off');
  // flag ON: a free model still goes first, Claude is the fallback
  const on = deps({ claudeReady: () => true, claudeFallback: () => true });
  assert.equal((await makeOneShot(on)('extract'))?.model, 'm1');
  assert.deepEqual(on.calls, ['oc:m1']);
  const only = deps({ claudeReady: () => true, claudeFallback: () => true, consent: () => false });
  assert.deepEqual(await makeOneShot(only)('extract'), { text: 'haiku says hi', model: 'claude-haiku-5-5' });
  // routing (fast) is the one latency-bound use: signed in = Haiku answers it
  const fast = deps({ claudeReady: () => true });
  assert.equal((await makeOneShot(fast)('route', { fast: true }))?.model, 'claude-haiku-5-5');
  // Haiku fails -> the breaker keeps it from being asked on every call
  let n = 0;
  const f = deps({ claudeReady: () => true, claudeFallback: () => true, consent: () => false, runClaude: async () => { n++; return { text: '', failed: true }; } });
  const one = makeOneShot(f);
  await one('x'); await one('x');
  assert.equal(n, 1, 'the breaker keeps a failing Haiku from being asked on every call');
});

test('prewarm: starts the routing session only when Claude is the usable first model; a no-op otherwise', () => {
  let started = 0;
  const on = makeOneShot(deps({ claudeReady: () => true, prewarmClaude: () => { started++; } }));
  on.prewarm(); assert.equal(started, 1);
  const off = makeOneShot(deps({ claudeReady: () => false, prewarmClaude: () => { started++; } }));
  off.prewarm(); assert.equal(started, 1, 'not signed in: nothing to warm');
  const throws = makeOneShot(deps({ claudeReady: () => true, prewarmClaude: () => { throw new Error('x'); } }));
  assert.doesNotThrow(() => throws.prewarm());
});

test('makeWarmClaude.warm: one tiny prompt starts the session; the next ask finds it ready and warm() twice does not start a second process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-fake-'));
  const log = path.join(dir, 'starts.log');
  // Windows: the fake is installed the way npm installs claude there (a .cmd shim winCommand unwraps to node <script>)
  const win = process.platform === 'win32';
  const bin = path.join(dir, win ? 'claude.cmd' : 'claude');
  const script = win ? path.join(dir, 'claude-fake.js') : bin;
  if (win) fs.writeFileSync(bin, '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\claude-fake.js" %*\r\n');
  // a fake stream-json claude: logs each start, answers every input line with a result
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(log)}, 'start' + String.fromCharCode(10));`,
    "let buf = ''; process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); console.log(JSON.stringify({ type: 'result', is_error: false, result: 'echo:' + m.message.content })); } });",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(script, 0o755);
  const w = makeWarmClaude(bin);
  try {
    w.warm(); w.warm();
    const t0 = Date.now();
    const r = await w.ask('pick one', 5000);
    assert.equal(r.failed, false); assert.equal(r.text, 'echo:pick one');
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split(String.fromCharCode(10)).length, 1, 'one process for warm, warm and the ask');
  } finally { w.close(); }
});

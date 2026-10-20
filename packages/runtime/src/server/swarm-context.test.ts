import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DriverDeps } from '../session/session-driver';
import { buildSwarmContextPacket, checkSwarmOverlap, planCheck } from './swarm-context';

type GraphCall = DriverDeps['graphCall'];
const EXPLORE = [
  'explore "validateSignup"',
  '■ FUNCTION validateSignup @ src/signup/form.ts:42 — validateSignup(input: SignupInput): Result',
  '  callers: submitSignup@src/signup/submit.ts:17, SignupPage@src/pages/signup.tsx:88',
  '  callees: isEmail@src/lib/email.ts:3',
  '  --- source src/signup/form.ts:42-60 ---',
  '  export function validateSignup(input) {',
  '■ METHOD SignupPage.render @ src/pages/signup.tsx:80 — render()',
  'other matches:',
  '  FUNCTION validateSignupAsync @ src/signup/async.ts:9',
].join('\n');
const graph = (text: string, calls: Array<{ name: string; args: Record<string, unknown>; opts: unknown }> = []): GraphCall =>
  async (name, args, opts) => { calls.push({ name, args, opts }); return { text, data: null, ms: 3 }; };

test('buildSwarmContextPacket: declarations + callers under the header, files from the hits, one fresh:false explore', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown>; opts: unknown }> = [];
  const r = await buildSwarmContextPacket({ cwd: '/nonexistent-repo', task: 'Make validateSignup reject empty emails; run pnpm test signup', graphCall: graph(EXPLORE, calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'explore');
  assert.equal(calls[0].args.query, 'validateSignup');
  assert.deepEqual(calls[0].opts, { cwd: '/nonexistent-repo', fresh: false });
  const lines = r.text.split('\n');
  assert.equal(lines[0], '## Context (from Kora graph)');
  assert.ok(lines.includes('■ FUNCTION validateSignup @ src/signup/form.ts:42 — validateSignup(input: SignupInput): Result'));
  assert.ok(lines.some((l) => l.startsWith('callers: submitSignup@src/signup/submit.ts:17')));
  assert.ok(!r.text.includes('export function validateSignup'), 'no source body: a declaration list, not a file dump');
  assert.ok(r.files.includes('src/signup/form.ts'));
  assert.equal(r.files[0], 'src/signup/form.ts');
});

test('buildSwarmContextPacket: files named in the task that exist are added to files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ctx-'));
  fs.mkdirSync(path.join(cwd, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'auth', 'session.ts'), 'export {}\n');
  const r = await buildSwarmContextPacket({ cwd, task: 'In src/auth/session.ts make validateSignup strict', graphCall: graph(EXPLORE) });
  assert.ok(r.files.includes('src/auth/session.ts'));
  assert.ok(r.files.includes('src/signup/form.ts'));
});

test('buildSwarmContextPacket: empty on an unindexed repo, a miss, an irrelevant top hit, no identifier, an error', async () => {
  const empty = { text: '', files: [] };
  const task = 'Make validateSignup reject empty emails';
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: graph('This repository (x) is not indexed yet. …') }), empty);
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: graph('NO DECLARATION NAMED validateSignup') }), empty);
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: graph('') }), empty);
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: graph('■ METHOD call @ src/protocol/client.ts:42 — call()') }), empty);
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task: 'tidy up the readme a bit please', graphCall: graph(EXPLORE) }), empty);
  const boom: GraphCall = async () => { throw new Error('graph down'); };
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: boom }), empty);
  const syncBoom = (() => { throw new Error('sync'); }) as unknown as GraphCall;
  assert.deepEqual(await buildSwarmContextPacket({ cwd: '/x', task, graphCall: syncBoom }), empty);
});

test('buildSwarmContextPacket: a graph that never answers → empty within the 1.5 s budget (never blocks a spawn)', async () => {
  const hang: GraphCall = () => new Promise(() => { /* never */ });
  // The budget timer is unref'd on purpose (it must never hold the daemon open); in a test nothing else keeps the
  // loop alive, and node:test cancelled this test ("event loop has already resolved") every run. Hold it here.
  const keepAlive = setInterval(() => {}, 1000);
  const t0 = Date.now();
  const r = await buildSwarmContextPacket({ cwd: '/x', task: 'Make validateSignup strict', graphCall: hang }).finally(() => clearInterval(keepAlive));
  const ms = Date.now() - t0;
  assert.deepEqual(r, { text: '', files: [] });
  assert.ok(ms >= 1400 && ms < 1900, `${ms} ms`);
});

test('checkSwarmOverlap: pure — per running worker, the shared files (normalized, sorted); none → []', () => {
  const running = [
    { paneId: 'p4', files: ['src/auth.ts', 'src/db.ts', './src/auth.ts'] },
    { paneId: 'p5', files: ['README.md'] },
    { paneId: 'p6', files: ['src/db.ts', 'src/auth.ts'] },
  ];
  assert.deepEqual(checkSwarmOverlap({ files: ['src/auth.ts'], running }), [
    { paneId: 'p4', files: ['src/auth.ts'] },
    { paneId: 'p6', files: ['src/auth.ts'] },
  ]);
  assert.deepEqual(checkSwarmOverlap({ files: ['./src/db.ts', 'src/auth.ts'], running }), [
    { paneId: 'p4', files: ['src/auth.ts', 'src/db.ts'] },
    { paneId: 'p6', files: ['src/auth.ts', 'src/db.ts'] },
  ]);
  assert.deepEqual(checkSwarmOverlap({ files: ['src/other.ts'], running }), []);
  assert.deepEqual(checkSwarmOverlap({ files: [], running }), []);
  assert.deepEqual(checkSwarmOverlap({ files: ['src/auth.ts'], running: [] }), []);
  const input = { files: ['src/auth.ts'], running: [{ paneId: 'p1', files: ['src/auth.ts'] }] };
  const before = JSON.stringify(input);
  checkSwarmOverlap(input);
  assert.equal(JSON.stringify(input), before, 'inputs untouched');
});

// ---- planCheck ----
// Fakes copied from the real engine's output on the ledgerkit fixture (kora graph neighbours/search_code, 2026-10-15).
const REAL: Record<string, { sc: string; nb: string; data?: unknown }> = {
  applyPayment: {
    sc: '1 match(es) for "applyPayment" across 1 file(s)\n  src/invoice.js: METHOD applyPayment:69',
    nb: 'METHOD applyPayment @ src/invoice.js:L69\n  in   ← CALLS ←  METHOD postPayment @ src/ledger.js:L57 (line 64)\n  in   ← CONTAINS ←  FILE src/invoice.js @ src/invoice.js:L1\n  in   ← IMPORTS_SYMBOL ←  FILE src/index.js @ src/index.js:L1 [inferred]\n  in   ← IMPORTS_SYMBOL ←  FILE test/payment.test.js @ test/payment.test.js:L1 [inferred]',
  },
  allocat: { // a typo: search_code lists substring hits only, neighbours fuzzy-resolves and returns the union
    sc: '25 match(es) for "allocat" across 12 file(s)\n  src/money.js: CLASS Money:7, METHOD allocate:76, METHOD zero:19\n  src/payment.js: METHOD allocatePayment:16\n  src/index.js: FILE src/index.js:1',
    nb: 'METHOD allocate @ src/money.js:L76\nMETHOD allocatePayment @ src/payment.js:L16\n7 caller(s), 0 callee(s) shown of 7 relation(s).\n(3 declarations share this name — relations below are the union)\n  in   ← IMPORTS_SYMBOL ←  FILE src/index.js @ src/index.js:L1 [inferred]\n  in   ← CONTAINS ←  FILE src/money.js @ src/money.js:L1',
  },
  allocate: { // a method called only through an instance: no CALLS edge
    sc: '2 match(es) for "allocate" across 2 file(s)\n  src/money.js: METHOD allocate:76\n  src/payment.js: METHOD allocatePayment:16',
    nb: 'METHOD allocate @ src/money.js:L76\n  in   ← CONTAINS ←  FILE src/money.js @ src/money.js:L1',
  },
  'Money#allocate': { sc: '1 match(es) for "Money#allocate" across 1 file(s)\n  src/money.js: METHOD allocate:76', nb: 'METHOD allocate @ src/money.js:L76\n  in   ← CONTAINS ←  FILE src/money.js @ src/money.js:L1' },
  fileCaller: { // a caller row that is a bare file, not an import: stays a caller
    sc: '1 match(es) for "fileCaller" across 1 file(s)\n  src/a.js: FUNCTION fileCaller:3',
    nb: 'FUNCTION fileCaller @ src/a.js:L3\n  in   ← CALLS ←  FILE src/ledger.js @ src/ledger.js:L64',
  },
};
const planGraph = (hang: string[] = []): GraphCall => async (name, args) => {
  const sym = String(args.symbol ?? args.query);
  if (hang.includes(sym)) return new Promise(() => {});
  const r = REAL[sym];
  if (!r) return { text: name === 'search_code' ? `0 match(es) for "${sym}"` : `NO DECLARATION NAMED ${sym}`, data: null, ms: 1 };
  return { text: name === 'search_code' ? r.sc : r.nb, data: r.data ?? null, ms: 1 };
};
const PLAN = [{ title: 'rounding', files: ['src/money.js'], symbols: ['allocate'] }, { title: 'split', files: ['src/payment.js'], symbols: ['applyPayment', 'allocat'] }];

test('planCheck: two slices on one file', async () => {
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/x.js'] }, { title: 'b', files: ['./src/x.js'] }, { title: 'c', files: ['src/y.js'] }] });
  assert.match(out, /^slices 1 and 2 both edit src\/x\.js: merge them or run them in order$/m);
  assert.doesNotMatch(out, /every caller covered/);
});

test('planCheck (real shapes): typo flagged, imports on one line, real callers, zero-caller method, tests line', async () => {
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: PLAN });
  assert.match(out, /^not in the graph: allocat \(new, or a typo\?\)$/m);
  assert.doesNotMatch(out, /calls allocat /);
  assert.match(out, /^uncovered caller: postPayment @ src\/ledger\.js:57 calls applyPayment \(slice 2\): add it to a slice or keep the signature$/m);
  assert.match(out, /^importers of applyPayment: src\/index\.js$/m);
  assert.doesNotMatch(out, /uncovered caller: .*src\/(index|invoice)\.js:1 /);
  assert.match(out, /^allocate \(slice 1\): no callers in the graph; calls through an instance are not tracked, so grep `\.allocate\(`$/m);
  assert.match(out, /^tests for slice 2: test\/payment\.test\.js$/m);
  assert.doesNotMatch(out, /every caller covered|no collisions found/);
});

test('planCheck: a caller in another slice; structured data is preferred; a nameless file caller stays a caller', async () => {
  const data = { neighbours: { in: [{ name: 'postPayment', type: 'METHOD', file: 'src/ledger.js', line: 57, edge_type: 'CALLS', call_line: 64 }, { name: 'src/invoice.js', type: 'FILE', file: 'src/invoice.js', line: 1, edge_type: 'CONTAINS' }] } };
  REAL.dataSym = { sc: 'x\n  src/m.js: METHOD dataSym:2', nb: 'METHOD dataSym @ src/m.js:L2', data };
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/m.js'], symbols: ['dataSym'] }, { title: 'b', files: ['src/ledger.js'] }] });
  assert.match(out, /slice 2 edits a caller of dataSym \(slice 1\): run 1 first or give 2 the new signature/);
  assert.doesNotMatch(out, /uncovered|importers/); // the CONTAINS row is not a relation
  const nameless = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/a.js'], symbols: ['fileCaller'] }] });
  assert.match(nameless, /^uncovered caller: src\/ledger\.js:64 calls fileCaller \(slice 1\)/m);
  delete REAL.dataSym;
});

test('planCheck: Class#method resolves by its last segment; a clean plan with zero-caller symbols is not "every caller covered"', async () => {
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/money.js'], symbols: ['Money#allocate'] }] });
  assert.doesNotMatch(out, /not in the graph/);
  assert.match(out, /^plan check: no collisions found; 1 symbol\(s\) have no graph callers \(see above\)$/m);
});

test('planCheck: a timeout and a throwing graph never throw', { timeout: 20_000 }, async () => {
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(['allocate']), slices: [{ title: 'a', files: ['src/a.js'], symbols: ['allocate', 'ghost'] }] });
  assert.match(out, /^could not check allocate \(graph timeout\)$/m);
  assert.match(out, /^not in the graph: ghost/m);
  const boom = (() => { throw new Error('sync'); }) as unknown as GraphCall;
  assert.match(await planCheck({ cwd: '/x', graphCall: boom, slices: [{ title: 'a', files: ['a.js'], symbols: ['f'] }] }), /could not check f/);
});

test('planCheck: a fully covered plan says so', async () => {
  REAL.cov = { sc: 'x\n  src/m.js: METHOD cov:2', nb: 'METHOD cov @ src/m.js:L2\n  in   ← CALLS ←  METHOD user @ src/u.js:L5 (line 9)' };
  const out = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/m.js'], symbols: ['cov'] }, { title: 'b', files: ['src/u.js'] }] });
  delete REAL.cov;
  assert.match(out, /slice 2 edits a caller of cov/); // covered by ANOTHER slice is still a finding
  REAL.cov2 = { sc: 'x\n  src/m.js: METHOD cov2:2', nb: 'METHOD cov2 @ src/m.js:L2\n  in   ← CALLS ←  METHOD user @ src/m.js:L5 (line 9)' };
  const clean = await planCheck({ cwd: '/x', graphCall: planGraph(), slices: [{ title: 'a', files: ['src/m.js'], symbols: ['cov2'] }] });
  delete REAL.cov2;
  assert.equal(clean, 'plan check: no collisions, every caller covered');
});

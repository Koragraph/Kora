import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bugProseQualifies, bugNouns, bugScopeWords, scoreBug, decide, renderBugInjection, BUG_INJECT_TRAILER, type BugSymbol, type BugCandidate } from './bug-localize';
import { injectForPrompt, INJECT_HEADER, declarationLines, tidyRefs, dropShown, readInjectLog } from './prompt-inject';
import { injectBugProseMode, resetSavingsSettingsCache } from '../util/savings-settings';

let nextId = 1;
const sym = (name: string, file: string, line = 10, type = 'METHOD', doc = '', span = 8): BugSymbol => ({ id: nextId++, name, type, path: file, line, doc, span });
// a small storefront: the same shape the live fixture has
const REPO: BugSymbol[] = [
  sym('withRetry', 'web/src/http/retry.ts', 29, 'METHOD', 'Run fn until it succeeds or the policy gives up', 12),
  sym('shouldRetry', 'web/src/http/retry.ts', 16, 'METHOD', 'Only server errors and rate limits are worth another try', 3),
  sym('backoffDelay', 'web/src/http/retry.ts', 10, 'METHOD', '', 4),
  sym('RetryPolicy', 'web/src/http/retry.ts', 1, 'CLASS'),
  sym('HttpClient', 'web/src/http/client.ts', 8, 'CLASS'),
  sym('send', 'web/src/http/client.ts', 33),
  sym('bulkDiscount', 'web/src/pricing/discount.ts', 11, 'METHOD', '10% off the line total once an order is a bulk order'),
  sym('BULK_THRESHOLD', 'web/src/pricing/discount.ts', 1, 'CONSTANT'),
  sym('applyCoupon', 'web/src/pricing/discount.ts', 17),
  sym('cartTotal', 'web/src/cart/cart.ts', 4),
  sym('exportOrdersCsv', 'web/src/reports/export.ts', 7, 'METHOD', 'One CSV line per order'),
  sym('csvCell', 'web/src/reports/format.ts', 1),
  sym('shipping_cost', 'warehouse/warehouse/shipping.py', 18),
  sym('heavy_surcharge', 'warehouse/warehouse/shipping.py', 8, 'METHOD', 'Flat surcharge for heavy parcels'),
  sym('low_stock_items', 'warehouse/warehouse/stock.py', 13, 'METHOD', 'Items that need reordering: stock has fallen below the reorder level'),
  sym('test_total', 'warehouse/tests/test_stock.py', 6),
];
const nbNone = () => ({ calls: [], calledBy: [] });
const lead = (prompt: string) => { const c = scoreBug(bugNouns(prompt), REPO, { scope: bugScopeWords(prompt) }); return { c, d: decide(c, nbNone, bugNouns(prompt).length <= 2 && c.length === 1 && c[0]!.matched.length === 1 && c[0]!.matched[0]!.length >= 6) }; };

test('bugProseQualifies: bug-shaped prose in, feature requests / questions / statements out', () => {
  for (const p of [
    'the retry count is off by one somewhere in the http client',
    'the bulk discount threshold is wrong, 50 should get the discount too',
    'why is the export slow?',
    'customers who order 50 items don\'t get the bulk discount',
    'a 45 kilo box costs way less than it should',
    'the report crashes when the range spans new year',
    'bash output trimming drops the error lines when the output is long',
    'the folder trust dialog comes back every time even though I trusted it',
  ]) assert.equal(bugProseQualifies(p), true, p);
  for (const p of [
    'add a new endpoint for listing products', 'how does the cart total get computed?', 'thanks, that works now', 'fix it',
    'the docs should also mention how retries work', 'rename the config loader to something clearer',
    'the lock holder check should also log who holds it', 'how should I structure the tax rates table',
    'Important: we do NOT use JWTs anywhere', 'reuse the retry helper in the upload code', 'add a column to the stale report table', '/compact keep the decisions', 'rename every occurrence of the retry count in the docs',
  ]) assert.equal(bugProseQualifies(p), false, p);
});

test('bugNouns drops symptom talk and keeps the nouns; bugScopeWords finds the "in the X" tail', () => {
  assert.deepEqual(bugNouns('the retry count is off by one somewhere in the http client'), ['retry', 'count', 'http', 'client']);
  assert.deepEqual(bugNouns('why is the export slow?'), ['export']);
  assert.deepEqual(bugNouns('heavy parcels are undercharged: a 25kg parcel'), ['heavy', 'parcels', 'undercharged', '25kg', 'parcel']);
  assert.deepEqual([...bugScopeWords('the retry count is off by one somewhere in the http client')].sort(), ['client', 'http']);
  assert.equal(bugScopeWords('the bulk discount is wrong').size, 0);
});

test('scoreBug: names, file paths and doc comments carry the evidence; symptom words never do', () => {
  const a = lead('the bulk discount threshold is wrong, ordering exactly 50 units should get the discount too');
  assert.equal(a.d.status, 'lead'); assert.equal(a.c[0]!.name, 'bulkDiscount', 'the function outranks the constant it reads');
  const b = lead('heavy parcels are undercharged: a 25kg parcel gets the same surcharge as a 12kg one');
  assert.equal(b.d.status, 'lead'); assert.equal(b.c[0]!.name, 'heavy_surcharge');
  const c = lead('the low stock alert fires for items exactly at their reorder level, it should only fire below it');
  assert.equal(c.d.status, 'lead'); assert.equal(c.c[0]!.name, 'low_stock_items');
  assert.ok(!c.c.some((x) => x.name === 'test_total'), 'test declarations are not candidates');
});

test('the scope of a sentence ("in the http client") does not make the class the answer', () => {
  const r = lead('the retry count is off by one somewhere in the http client');
  assert.equal(r.d.status, 'lead');
  assert.equal(r.c[0]!.name, 'withRetry', 'bigger body wins the tie against shouldRetry; HttpClient is only the scope');
  assert.ok(!r.d.show.some((x) => x.name === 'HttpClient'));
});

test('precision: one topic word, a stranger of equal weight, or a weak top gives no lead', () => {
  assert.equal(lead('the build is too slow, the export step in CI takes forever').d.status, 'unclear', 'one word of a long prompt');
  assert.equal(lead('stock photos on the landing page are broken on safari').d.status, 'unclear');
  assert.equal(lead('the login page crashes on mobile').d.status, 'none');
  // focused: a short prompt whose only noun names exactly one declaration
  assert.equal(lead('why is the export slow?').d.status, 'lead');
  // two different files, no call link between them: a coin flip, so nothing
  const tie = decide([cand('alpha', 'a.ts', 2), cand('beta', 'b.ts', 1.9)], nbNone);
  assert.equal(tie.status, 'unclear'); assert.match(tie.note!, /^tie:/);
  // but when the graph says one calls the other it is one feature and both are shown
  const linked = decide([cand('alpha', 'a.ts', 2, 1), cand('beta', 'b.ts', 1.9, 2)], (c) => c.name === 'alpha' ? { calls: [{ id: 2, name: 'beta' }], calledBy: [] } : nbNone());
  assert.equal(linked.status, 'lead'); assert.deepEqual(linked.show.map((x) => x.name), ['alpha', 'beta']);
});
function cand(name: string, file: string, score: number, id = 0): BugCandidate { return { id, name, type: 'METHOD', file, line: 1, score, matched: ['one', 'two'], channels: ['name'], why: '' }; }

test('renderBugInjection: header, <= 3 declarations with a why line, a trailer that says it is a guess, within the cap', () => {
  const cands: BugCandidate[] = ['a', 'b', 'c'].map((n, i) => ({ ...cand(n + 'Func', `src/${n}.ts`, 3 - i), line: 10 + i, why: 'matches "x" "y" (name+file); calls helper', sig: `${n}Func(a, b)` }));
  const t = renderBugInjection({ status: 'lead', nouns: [], candidates: cands, ms: 1 }, INJECT_HEADER)!;
  assert.ok(t.startsWith(INJECT_HEADER) && t.endsWith(BUG_INJECT_TRAILER));
  assert.equal(t.split('\n').filter((l) => l.startsWith('■')).length, 3); assert.equal(t.split('\n').filter((l) => l.startsWith('  why:')).length, 3);
  assert.ok(t.length <= 1600);
  assert.equal(renderBugInjection({ status: 'unclear', nouns: [], candidates: cands, ms: 1 }, INJECT_HEADER), null);
  // a block this session already saw is dropped, trailer and all
  const shown = new Set(t.split('\n').filter((l) => l.startsWith('■')).map((l) => l.trim()));
  assert.equal(dropShown(t, shown), null);
});

test('renderInjection cleanup: callers drop doc-comment nodes, a class\'s own members and empty entries; a repeated ■ is one', () => {
  assert.equal(tidyRefs('callers: withRetry — Run `fn` until it succeeds. Returns the last response either way.@web/src/http/retry.ts:28, send@web/src/http/client.ts:33 (call at :35)', '■ METHOD withRetry @ web/src/http/retry.ts:29 — withRetry()'), 'callers: send@web/src/http/client.ts:33');
  assert.equal(tidyRefs('callers:, baseUrl@web/src/http/client.ts:10, constructor@web/src/http/client.ts:14, caller@web/src/other.ts:3', '■ CLASS HttpClient @ web/src/http/client.ts:8 — class HttpClient'), 'callers: caller@web/src/other.ts:3');
  assert.equal(tidyRefs('callers:, baseUrl@web/src/http/client.ts:10', '■ CLASS HttpClient @ web/src/http/client.ts:8 — class HttpClient'), null, 'nothing left, no line');
  assert.equal(tidyRefs('callees: a@x.ts:1, b@x.ts:2, c@x.ts:3, d@x.ts:4, e@x.ts:5', '■ METHOD f @ x.ts:9')!.split(', ').length, 4, 'at most four');
  const text = '2 match(es)\n■ METHOD f @ a.ts:1 — f()\n  callers: g@b.ts:2\n\n■ METHOD f @ a.ts:1 — f()\n  callers: h@c.ts:3\n\nother matches:\n  METHOD f @ a.ts:1\n  METHOD k @ a.ts:5\n';
  const lines = declarationLines(text, 1600, 0);
  assert.equal(lines.filter((l) => l.startsWith('■')).length, 1, 'one ■ for one declaration');
  assert.ok(!lines.some((l) => /^\s*METHOD f @/.test(l)), 'an "other matches" row for a declaration already shown is dropped');
  assert.deepEqual(lines.filter((l) => /callers/.test(l)), ['callers: g@b.ts:2'], 'the repeat\'s callers are not merged in');
});

test('injectBugProse setting: shadow by default; settings.json and env override', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bugprose-'));
  resetSavingsSettingsCache();
  assert.equal(injectBugProseMode(home, {} as any), 'shadow');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ injectBugProse: 'on' })); resetSavingsSettingsCache();
  assert.equal(injectBugProseMode(home, {} as any), 'on');
  assert.equal(injectBugProseMode(home, { KORA_INJECT_BUG_PROSE: 'off' } as any), 'off');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ injectBugProse: 'bogus' })); resetSavingsSettingsCache();
  assert.equal(injectBugProseMode(home, {} as any), 'shadow', 'a bad value falls back to the default');
});

// --- the hook: shadow logs and injects nothing; on injects; off never looks ---
const VERDICT = { status: 'lead', nouns: ['bulk', 'discount'], ms: 3, candidates: [{ name: 'bulkDiscount', type: 'METHOD', file: 'web/src/pricing/discount.ts', line: 11, score: 2.5, matched: ['bulk', 'discount'], channels: ['name'], why: 'matches "bulk" "discount" (name)', sig: 'bulkDiscount(line: Line): number' }] };
function fakeGraph(verdict: unknown = VERDICT) {
  let calls = 0;
  return { calls: () => calls, g: { status: async () => ({ indexed: true, repoRoot: '/nope', lastIngestAt: 7 }), callTool: async () => ({ text: '' }), bugLocalize: async () => { calls++; return verdict; } } as any };
}
const BUG_PROMPT = 'the bulk discount threshold is wrong, ordering exactly 50 units should get the discount too';
async function withMode<T>(mode: string, f: () => Promise<T>): Promise<T> {
  const prev = process.env.KORA_INJECT_BUG_PROSE; process.env.KORA_INJECT_BUG_PROSE = mode;
  try { return await f(); } finally { if (prev === undefined) delete process.env.KORA_INJECT_BUG_PROSE; else process.env.KORA_INJECT_BUG_PROSE = prev; }
}
test('hook: shadow injects nothing and logs what it would have; on injects the block; off never calls the localizer', async () => {
  const home = process.env.KORA_HOME!; const log = path.join(home, 'inject.jsonl');
  const since = Date.now() - 1000;
  const shadow = fakeGraph();
  const t1 = await withMode('shadow', () => injectForPrompt({ prompt: BUG_PROMPT, cwd: '/nope', sessionId: 'bp-shadow-' + Date.now(), graph: shadow.g, fileHints: false }));
  assert.equal(t1, null, 'shadow changes nothing');
  assert.equal(shadow.calls(), 1);
  const rec = readInjectLog(log, { since }).filter((r) => r.promptHash && r.bug?.mode === 'shadow').pop()!;
  assert.equal(rec.decision, 'skipped'); assert.equal(rec.reason, 'not-code-shaped');
  assert.equal(rec.bug!.verdict, 'lead'); assert.match(rec.bug!.would!, /■ METHOD bulkDiscount @ web\/src\/pricing\/discount\.ts:11/); assert.equal(rec.bug!.cands[0]!.name, 'bulkDiscount');

  const on = fakeGraph();
  const t2 = await withMode('on', () => injectForPrompt({ prompt: BUG_PROMPT, cwd: '/nope', sessionId: 'bp-on-' + Date.now(), graph: on.g, fileHints: false }));
  assert.ok(t2 && t2.startsWith(INJECT_HEADER) && t2.includes('■ METHOD bulkDiscount') && t2.endsWith(BUG_INJECT_TRAILER));
  const recOn = readInjectLog(log, { since }).filter((r) => r.via === 'bug-prose').pop()!;
  assert.equal(recOn.decision, 'injected'); assert.equal(recOn.topHit, 'bulkDiscount'); assert.equal(recOn.bug!.mode, 'on');

  const off = fakeGraph();
  const t9 = await withMode('off', () => injectForPrompt({ prompt: BUG_PROMPT, cwd: '/nope', sessionId: 'bp-off-' + Date.now(), graph: off.g, fileHints: false }));
  assert.equal(t9, null); assert.equal(off.calls(), 0, 'off never looks');

  // an unclear verdict injects nothing even when on, and the old outcome stands
  const unclear = fakeGraph({ status: 'unclear', note: 'tie:x', nouns: ['a'], candidates: [], ms: 1 });
  const t4 = await withMode('on', () => injectForPrompt({ prompt: BUG_PROMPT, cwd: '/nope', sessionId: 'bp-unclear-' + Date.now(), graph: unclear.g, fileHints: false }));
  assert.equal(t4, null);
  // a prompt that names an identifier is not the localizer's job
  const ident = fakeGraph();
  await withMode('on', () => injectForPrompt({ prompt: 'the bulkDiscount threshold is wrong, 50 should get the discount too', cwd: '/nope', sessionId: 'bp-ident-' + Date.now(), graph: { ...ident.g, callTool: async () => ({ text: '' }) }, fileHints: false }));
  assert.equal(ident.calls(), 0);
  // a failing or hanging localizer fails open
  const boom = { ...fakeGraph().g, bugLocalize: async () => { throw new Error('worker died'); } };
  const t5 = await withMode('on', () => injectForPrompt({ prompt: BUG_PROMPT, cwd: '/nope', sessionId: 'bp-boom-' + Date.now(), graph: boom, fileHints: false }));
  assert.equal(t5, null);
  assert.equal(readInjectLog(log, { since }).filter((r) => r.bug?.verdict === 'error').length, 1);
});

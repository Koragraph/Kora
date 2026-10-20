import test from 'node:test';
import assert from 'node:assert/strict';
import { DENY_ANSWER_MAX_CHARS, denyAnswerFor, parseCallers, renderDenyAnswer, type DenyGraphCall } from './deny-answer';

const SEARCH = '3 match(es) for "applyDiscount" across 2 file(s)\n  src/pricing.js: METHOD applyDiscount:5, METHOD applyDiscountCode:40\n  test/pricing.test.js: FILE test/pricing.test.js:1';
const NEIGH = [
  'METHOD applyDiscount @ src/pricing.js:L5',
  '  in   ← CALLS ←  METHOD placeOrder @ src/checkout.js:L5 (line 14) [inferred]',
  '  in   ← CALLS ←  METHOD renderQuote @ src/report.js:L30',
  '  in   ← CONTAINS ←  FILE src/pricing.js @ src/pricing.js:L1',
].join('\n');
const graph = (texts: Record<string, string | null>, calls: string[] = []): DenyGraphCall => async (n) => { calls.push(n); return texts[n] ?? null; };

test('parseCallers: CALLS in-edges with their call line; the CONTAINS edge of the declaring file is not a caller', () => {
  assert.deepEqual(parseCallers(NEIGH), [
    { name: 'placeOrder', file: 'src/checkout.js', line: 14 },
    { name: 'renderQuote', file: 'src/report.js', line: 30 },
  ]);
  assert.deepEqual(parseCallers(''), []);
});

test('denyAnswerFor: the exact declaration (not applyDiscountCode) and top callers, under the cap, with the read-a-range hint', async () => {
  const calls: string[] = [];
  const a = (await denyAnswerFor('applyDiscount', graph({ search_code: SEARCH, neighbours: NEIGH }, calls)))!;
  assert.deepEqual(calls.sort(), ['neighbours', 'search_code']);
  assert.match(a, /METHOD applyDiscount — src\/pricing\.js:5/);
  assert.doesNotMatch(a, /applyDiscountCode/);
  assert.match(a, /called from 2 place\(s\):\n    src\/checkout\.js: placeOrder:14\n    src\/report\.js: renderQuote:30/);
  assert.match(a, /offset\/limit/);
  assert.match(a, /Searches for TEXT .* never blocked/);
  assert.ok(a.length < DENY_ANSWER_MAX_CHARS + 260, `short enough (${a.length})`);
});

test('denyAnswerFor: null (today\'s plain redirect) when the graph has no exact declaration, is down, slow or throws', async () => {
  assert.equal(await denyAnswerFor('applyDisc', graph({ search_code: SEARCH, neighbours: NEIGH })), null, 'a longer name is not the name');
  assert.equal(await denyAnswerFor('nothing', graph({ search_code: '0 match(es) for "nothing" across 0 file(s)\n  (nothing)', neighbours: 'NO DECLARATION NAMED "nothing"' })), null);
  assert.equal(await denyAnswerFor('applyDiscount', graph({})), null);
  assert.equal(await denyAnswerFor('applyDiscount', async () => { throw new Error('boom'); }), null);
  assert.equal(await denyAnswerFor('applyDiscount', () => new Promise(() => {}), { timeoutMs: 30 }), null, 'bounded');
});

test('denyAnswerFor: a declaration with no callers still answers (callers: none); neighbours failing keeps the declaration', async () => {
  const a = (await denyAnswerFor('applyDiscount', graph({ search_code: SEARCH, neighbours: 'METHOD applyDiscount @ src/pricing.js:L5\n  in   ← CONTAINS ←  FILE src/pricing.js @ src/pricing.js:L1' })))!;
  assert.match(a, /callers: none found/);
  const b = (await denyAnswerFor('applyDiscount', graph({ search_code: SEARCH })))!;
  assert.match(b, /src\/pricing\.js:5/);
});

test('renderDenyAnswer: many declarations and callers are counted, not listed; the block stays near the cap', () => {
  const decls = Array.from({ length: 6 }, (_, i) => ({ file: `src/a${i}.ts`, kind: 'METHOD', line: i + 1 }));
  const callers = Array.from({ length: 40 }, (_, i) => ({ name: `caller${i}WithALongName`, file: `src/some/deep/path/file${i}.ts`, line: i + 1 }));
  const a = renderDenyAnswer('render', decls, callers);
  assert.match(a, /\+3 more declaration/); assert.match(a, /called from 40 place/); assert.match(a, /\+\d+ more: `kora graph neighbours render --direction in`/);
  assert.ok(a.length < DENY_ANSWER_MAX_CHARS + 260, `${a.length}`);
  // few callers: ALL of them are listed, grouped by file (the agent asked to list usages; a truncated list sends it back to grep)
  const six = ['sendReceipt:src/notifications.js:8', 'buildInvoice:src/invoices.js:9', 'renderReceipt:src/report.js:8', 'renderSalesSummary:src/report.js:20', 'handleCheckout:src/api/handlers.js:9', 'main:src/cli.js:11'].map((x) => { const [name, file, line] = x.split(':'); return { name: name!, file: file!, line: Number(line) }; });
  const b = renderDenyAnswer('formatMoney', [{ file: 'src/util/format.js', kind: 'METHOD', line: 4 }], six);
  assert.match(b, /src\/report\.js: renderReceipt:8, renderSalesSummary:20/); assert.doesNotMatch(b, /more:/); assert.ok(b.length < DENY_ANSWER_MAX_CHARS + 260, `${b.length}`);
});

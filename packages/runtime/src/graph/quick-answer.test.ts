import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuickQuestion, clipAnswer, declFile, exactDecls, isCodeName, isPlainName, parseQuickQuestion, parseQuickQuestionPlain, type QuickGraph } from './quick-answer';

test('parseQuickQuestion: fixed phrasings with a code-shaped name; ordinary prompts and English words are not questions', () => {
  assert.deepEqual(parseQuickQuestion('who calls lockHolder?'), { kind: 'callers', name: 'lockHolder' });
  assert.deepEqual(parseQuickQuestion('What uses `resolve_scope`'), { kind: 'callers', name: 'resolve_scope' });
  assert.deepEqual(parseQuickQuestion('callers of Session.start'), { kind: 'callers', name: 'Session.start' });
  assert.deepEqual(parseQuickQuestion("where's the function injectForPrompt defined?"), { kind: 'where', name: 'injectForPrompt' });
  assert.deepEqual(parseQuickQuestion('where is injectForPrompt defined'), { kind: 'where', name: 'injectForPrompt' });
  assert.deepEqual(parseQuickQuestion('Where is ReadBounder?'), { kind: 'where', name: 'ReadBounder' });
  assert.deepEqual(parseQuickQuestion('what breaks if I rename chooseWindow'), { kind: 'impact', name: 'chooseWindow' });
  assert.deepEqual(parseQuickQuestion('blast radius of read_window'), { kind: 'impact', name: 'read_window' });
  for (const p of ['where is the button', 'who calls the plumber', 'who calls main', 'how does lockHolder work', 'where is lockHolder and also fix it', '/who calls fooBar', 'who calls fooBar\nand more', '', 'x'.repeat(200)]) assert.equal(parseQuickQuestion(p), null, p);
  assert.ok(isCodeName('camelCase') && isCodeName('snake_case') && isCodeName('a.b.c') && !isCodeName('button') && !isCodeName('Main'));
});

const graph = (over: Partial<QuickGraph> = {}, texts: Record<string, string> = {}): QuickGraph & { calls: any[] } => {
  const calls: any[] = [];
  return {
    calls,
    status: async () => ({ indexed: true }),
    callTool: async (n, a) => { calls.push([n, a]); return { text: texts[n] ?? '' }; },
    ...over,
  };
};

test('answerQuickQuestion: one graph call per question (neighbours in / search_code / blast_radius), clipped; null when unindexed, empty, absent or slow', async () => {
  const body = 'METHOD lockHolder @ src/graph/lock.ts:L43\n5 caller(s)\n' + Array.from({ length: 30 }, (_, i) => `  in ← CALLS ← METHOD caller${i} @ src/a.ts:L${i}`).join('\n');
  const g = graph({}, { neighbours: body, search_code: '1 match(es)\n  src/graph/lock.ts: METHOD lockHolder:43', blast_radius: 'blast: 3 files' });
  const a = (await answerQuickQuestion({ kind: 'callers', name: 'lockHolder' }, '/r', g))!;
  assert.deepEqual(g.calls[0], ['neighbours', { symbol: 'lockHolder', direction: 'in' }]);
  assert.match(a.text, /^Graph answer \(no agent turn\) — Callers of lockHolder:\nMETHOD lockHolder/);
  assert.match(a.text, /… \d+ more line\(s\)$/);
  assert.ok(a.text.length < 1700 && a.approxTokens < 450);
  assert.match((await answerQuickQuestion({ kind: 'where', name: 'lockHolder' }, '/r', g))!.text, /src\/graph\/lock\.ts: METHOD lockHolder:43/);
  assert.deepEqual(g.calls[1], ['search_code', { query: 'lockHolder' }]);
  assert.match((await answerQuickQuestion({ kind: 'impact', name: 'lockHolder' }, '/r', g))!.text, /blast: 3 files/);
  assert.deepEqual(g.calls.slice(-2), [['search_code', { query: 'lockHolder' }], ['blast_radius', { files_changed: ['src/graph/lock.ts'] }]], 'blast_radius takes the declaring file');
  assert.equal(await answerQuickQuestion({ kind: 'impact', name: 'nothere' }, '/r', g), null, 'no declaring file: no guess');
  assert.equal(declFile('1 match(es)\n  src/a.ts: METHOD foo:3, DOC foo — text:2', 'foo'), 'src/a.ts');
  assert.equal(declFile('1 match(es)\n  src/a.ts: METHOD fooBar:3', 'foo'), null, 'a longer name is not the name');
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({ status: async () => ({ indexed: false }) })), null, 'never starts an index');
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({ status: async () => ({ indexed: true, incomplete: true }) })), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({}, { search_code: '0 match(es)' })), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({}, { search_code: 'NO DECLARATION NAMED "x" EXISTS' })), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({ callTool: async () => { throw new Error('boom'); } })), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'x' }, '/r', graph({ callTool: () => new Promise(() => {}) }), { timeoutMs: 30 }), null, 'bounded');
  assert.equal(clipAnswer(''), '');
});

test('plain words: parsed only with the fixed phrasings and a non-prose word; the strict parser still refuses them', () => {
  assert.deepEqual(parseQuickQuestionPlain('who calls checkout'), { kind: 'callers', name: 'checkout', plain: true });
  assert.deepEqual(parseQuickQuestionPlain('Where is render?'), { kind: 'where', name: 'render', plain: true });
  assert.deepEqual(parseQuickQuestionPlain('what breaks if I rename Checkout'), { kind: 'impact', name: 'Checkout', plain: true });
  for (const p of ['where is the button', 'who calls this', 'where is it', 'who calls run', 'where is src/app', 'where is the code', 'how does checkout work', 'where is checkout and fix it', '/where is checkout', 'where is Session.start', 'where is fooBar']) assert.equal(parseQuickQuestionPlain(p), null, p);
  assert.equal(parseQuickQuestion('who calls checkout'), null, 'strict parser unchanged');
  assert.ok(isPlainName('render') && isPlainName('Checkout') && !isPlainName('this') && !isPlainName('run') && !isPlainName('a-b'));
});

test('exactDecls: exact name only, qualified rows count, FILE/DOC rows and longer names do not', () => {
  const t = '5 match(es)\n  src/a.ts: METHOD render:3, METHOD renderAll:9, FILE src/render.ts:1, DOC render — text:2\n  src/b.ts: METHOD Widget.render:40, CLASS Widget:10';
  assert.deepEqual(exactDecls(t, 'render'), [{ file: 'src/a.ts', kind: 'METHOD', line: 3 }, { file: 'src/b.ts', kind: 'METHOD', line: 40 }]);
  assert.deepEqual(exactDecls(t, 'Widget.render'), [{ file: 'src/b.ts', kind: 'METHOD', line: 40 }]);
  assert.deepEqual(exactDecls(t, 'rend'), []);
});

test('answerQuickQuestion (plain word): answered only when the graph holds exactly ONE declaration of that name', async () => {
  const one = graph({}, { search_code: '4 match(es)\n  src/checkout.js: METHOD placeOrder:5, FILE src/checkout.js:1\n  src/a.js: METHOD checkout:7, METHOD checkoutAll:12', neighbours: 'METHOD checkout @ src/a.js:L7\n  in   ← CALLS ←  METHOD placeOrder @ src/checkout.js:L5 (line 14)', blast_radius: 'blast: 2 files' });
  const callers = (await answerQuickQuestion({ kind: 'callers', name: 'checkout', plain: true }, '/r', one))!;
  assert.match(callers.text, /Callers of checkout/); assert.match(callers.text, /placeOrder/);
  assert.deepEqual(one.calls.map((c: any) => c[0]), ['search_code', 'neighbours']);
  const where = (await answerQuickQuestion({ kind: 'where', name: 'checkout', plain: true }, '/r', one))!;
  assert.match(where.text, /src\/a\.js: METHOD checkout:7/); assert.doesNotMatch(where.text, /checkoutAll|placeOrder/, 'only the declaration, not the fuzzy rows');
  assert.match((await answerQuickQuestion({ kind: 'impact', name: 'checkout', plain: true }, '/r', one))!.text, /blast: 2 files/);
  assert.deepEqual(one.calls.at(-1), ['blast_radius', { files_changed: ['src/a.js'] }]);
  // zero declarations (an English word the code merely mentions), or two: prose / ambiguous, no guess
  const none = graph({}, { search_code: '2 match(es)\n  src/a.js: METHOD checkoutAll:12, FILE src/render.js:1', neighbours: 'x' });
  assert.equal(await answerQuickQuestion({ kind: 'callers', name: 'checkout', plain: true }, '/r', none), null);
  assert.deepEqual(none.calls.map((c: any) => c[0]), ['search_code'], 'no caller lookup without a declaration');
  const two = graph({}, { search_code: '2 match(es)\n  src/a.js: METHOD render:7\n  src/b.js: METHOD render:9', neighbours: 'x' });
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'render', plain: true }, '/r', two), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'render', plain: true }, '/r', graph({ status: async () => ({ indexed: false }) })), null);
  assert.equal(await answerQuickQuestion({ kind: 'where', name: 'render', plain: true }, '/r', graph({ callTool: () => new Promise(() => {}) }), { timeoutMs: 30 }), null);
});

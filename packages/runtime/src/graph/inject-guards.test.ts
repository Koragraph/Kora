import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distillQuery, relevantTo, renderInjection } from './prompt-inject';
import { createGraphService } from './service';

test('distillQuery: identifiers first, stopwords out, at most six tokens', () => {
  const d = distillQuery('Who calls resolveProjectScope, and what does each caller pass as the scope value?');
  assert.equal(d.tokens[0], 'resolveprojectscope');
  assert.ok(!d.tokens.includes('value'), 'stopword dropped');
  assert.ok(d.tokens.length <= 6);
  const f = distillQuery('How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved and file:line. Under 250 words.');
  assert.ok(!f.tokens.some((t) => /[.]$/.test(t)), 'no trailing punctuation in tokens');
  assert.ok(f.tokens.includes('server') && f.tokens.includes('scoped'));
  const e = distillQuery('I want graphStaleness() to also return an ageMs field. What would need to change?');
  assert.deepEqual(e.tokens.slice(0, 2), ['graphstaleness', 'agems']);
  assert.equal(e.query, 'graphStaleness ageMs', 'identifiers alone form the query when present');
});
test('relevantTo: needs a hit sharing a strong token; renderInjection refuses degraded results', () => {
  const good = '2 match(es)\n■ METHOD resolveProjectScope @ src/mcp/tool-handlers.js:154 — resolveProjectScope(value, svc)\n  callers: neighbours@src/mcp/tool-handlers.js:378\n';
  assert.ok(relevantTo(good, ['resolveprojectscope', 'scope']));
  assert.ok(!relevantTo(good, ['unrelatedthing']));
  assert.equal(renderInjection('25 match(es) — PARTIAL: the lexical channel(s) did not answer\n■ METHOD call @ x.py:2 — call()\n'), null);
  assert.equal(renderInjection('0 match(es) — NO DECLARATION NAMED "foo" EXISTS IN THE GRAPH\n'), null);
  const r = renderInjection(good)!; assert.match(r, /^Graph, for this prompt/); assert.match(r, /no further graph calls/);
});
test('existence filter drops hits whose files are not in this checkout and says so when most vanish', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-exist-'));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
  const svc: any = createGraphService();
  const text = '3 match(es)\n■ METHOD keep @ src/a.js:1 — keep()\n  callers: here@src/a.js:9, ghost@test/unit/z.test.js:3\n■ METHOD gone @ other/b.py:2 — gone()\n  callers: z@other/c.py:1\n  --- source other/b.py:2-9 ---\n  body\n■ METHOD gone2 @ nope/d.js:3 — gone2()\n';
  const out = svc.__slim('explore', { text, data: {}, ms: 1 }, root).text;
  assert.match(out, /keep @ src\/a\.js:1/);
  assert.match(out, /callers: here@src\/a\.js:9$/m); assert.ok(!/ghost@test\/unit/.test(out), 'inline caller in a missing file is dropped');
  assert.ok(!/gone @ other/.test(out) && !/gone2/.test(out) && !/body/.test(out), 'dropped hits and their bodies are gone');
  assert.match(out, /3 hit\(s\) omitted: their files do not exist in this checkout/);
  // a caller ref carrying its call site (`(call at :12/:15)`) is still one ref: kept or dropped whole
  const withSite = '1 match(es)\n■ METHOD keep @ src/a.js:1 — keep()\n  callers: here@src/a.js:9 (call at :12/:15), ghost@test/unit/z.test.js:3 (call at :4)\n';
  assert.match(svc.__slim('explore', { text: withSite, data: {}, ms: 1 }, root).text, /callers: here@src\/a\.js:9 \(call at :12\/:15\)$/m);
});

// Audit 2026-10-15 #7: a digit before the capital (s3Client, sha256Hex) was neither code-shaped nor an identifier.
test('identifiers with a digit before a capital are code-shaped and distilled', async () => {
  const { looksCodeShaped } = await import('./prompt-inject');
  assert.equal(looksCodeShaped('who calls s3Client'), true);
  assert.equal(looksCodeShaped('fix sha256Hex'), true);
  assert.equal(looksCodeShaped('turn on 2FA'), false, 'an acronym after a digit is not camelCase');
  assert.deepEqual(distillQuery('who calls s3Client').idents, ['s3Client']);
  assert.ok(distillQuery('fix sha256Hex please').idents.includes('sha256Hex'));
});

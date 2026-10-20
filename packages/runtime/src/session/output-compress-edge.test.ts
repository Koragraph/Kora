// Edge cases of the Bash output compressor (test/savings 2026-10-14): odd inputs, errors buried mid-output, unicode, ANSI.
import { test } from 'node:test';
import assert from 'node:assert';
import { compressBashOutput, stripTerminalNoise, isViewingCommand, IMPORTANT } from './output-compress';

const LOW = { minChars: 500 };
const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const importantKept = (raw: string, out: string): string[] =>
  [...new Set(stripTerminalNoise(raw).split('\n').filter((l) => IMPORTANT.test(l)))].filter((l) => !out.includes(l));

test('edge: empty, non-string, small and over-the-cap inputs are left alone', () => {
  assert.equal(compressBashOutput(''), null);
  assert.equal(compressBashOutput(undefined as any), null);
  assert.equal(compressBashOutput(42 as any), null);
  assert.equal(compressBashOutput('x'.repeat(1999)), null);
  assert.equal(compressBashOutput(lines(300_000, (i) => `line ${i % 7} same same same`)), null, 'over 2M chars passes through');
});

test('edge: binary output (NUL bytes, invalid UTF-8 replacement chars) never throws', () => {
  const bin = Buffer.from(Array.from({ length: 20_000 }, (_, i) => (i * 37) % 256)).toString('utf8');
  const r = compressBashOutput(bin);
  assert.ok(r === null || typeof r.text === 'string');
  const binLines = lines(400, (i) => `\u0000\u0001chunk ${i}��`);
  assert.doesNotThrow(() => compressBashOutput(binLines));
});

test('edge: ANSI-only noise is stripped and a progress bar collapses to its final state', () => {
  const ESC = String.fromCharCode(27);
  const bar = Array.from({ length: 200 }, (_, i) => `${ESC}[32m${'█'.repeat(i % 40)}${ESC}[0m ${i}%`).join('\r') + '\ndone\n';
  const raw = bar.repeat(3);
  const r = compressBashOutput(raw)!;
  assert.ok(r, 'compressed');
  assert.ok(!r.text.includes(ESC), 'no escapes left');
  assert.ok(r.text.includes('199%') && r.text.includes('done'));
});

test('edge: an error buried in the middle of a long unrecognised log survives the head/tail trim', () => {
  const raw = lines(2000, (i) => (i === 1000 ? 'ERROR: disk quota exceeded on /var/data (errno 122)' : `step ${i}: processed record batch with id=${(i * 7919) % 100000} ok`));
  const r = compressBashOutput(raw)!;
  assert.ok(r, 'compressed');
  assert.ok(r.text.includes('ERROR: disk quota exceeded on /var/data (errno 122)'));
});

test('edge: a failure buried among thousands of passing tests survives, with its stack top', () => {
  const pass = (i: number) => `✔ passes case ${i} (0.${i % 9}ms)`;
  const raw = [lines(1500, pass), '✖ buried failure (2.1ms)', '  AssertionError [ERR_ASSERTION]: 1 !== 2', '      at TestContext.<anonymous> (/tmp/a.test.js:9:10)', lines(1500, (i) => pass(i + 2000)), 'ℹ tests 3001', 'ℹ pass 3000', 'ℹ fail 1'].join('\n');
  const r = compressBashOutput(raw)!;
  assert.match(r.compressor, /^test-node/);
  for (const must of ['✖ buried failure', '1 !== 2', 'a.test.js:9:10', 'ℹ fail 1']) assert.ok(r.text.includes(must), must);
  assert.equal(r.totalLines, 3006, 'totalLines is the input\'s count (the footer says "Original: N lines"), not the kept lines');
  assert.deepEqual(importantKept(raw, r.text), []);
});

test('edge: unicode (CJK, emoji, RTL) lines round-trip unchanged where kept', () => {
  const raw = lines(400, (i) => `${i % 50 === 0 ? 'エラー error: 失败 🔥 שגיאה' : `処理中 ✨ item`} ${i}`);
  const r = compressBashOutput(raw, LOW)!;
  assert.ok(r);
  assert.ok(r.text.includes('エラー error: 失败 🔥 שגיאה 0') && r.text.includes('エラー error: 失败 🔥 שגיאה 350'));
});

test('edge: TAP output cut off inside a passing test\'s YAML block does not swallow the failures after it', () => {
  // `| head`, a killed run or a crash can end a TAP stream without the closing `...` of a YAML block
  const ok = (i: number) => `ok ${i} - passes ${i}\n  ---\n  duration_ms: 0.1\n  ...`;
  const raw = [lines(60, (i) => ok(i + 1)), 'ok 61 - truncated', '  ---', '  duration_ms: 0.2', 'not ok 62 - real failure', '  error: \'boom\'', '# tests 62', '# pass 61', '# fail 1'].join('\n');
  const r = compressBashOutput(raw, LOW)!;
  assert.ok(r);
  for (const must of ['not ok 62 - real failure', "error: 'boom'", '# fail 1']) assert.ok(r.text.includes(must), `${must} kept`);
});

test('edge: graph lookups are content the agent asked for (left alone like cat / rg)', () => {
  assert.equal(isViewingCommand('kora graph explore "warm engine"'), true);
  assert.equal(isViewingCommand('kora-dev graph search_code WarmEngine'), true);
  assert.equal(isViewingCommand('kora ingest .'), false);
});

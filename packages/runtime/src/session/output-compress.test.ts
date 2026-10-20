// Fixtures under test/fixtures/bash-output/ are REAL outputs captured on 2026-10-14 by running the real tools (node:test spec + TAP,
// vitest, pytest, go test, cargo test, tsc, eslint, pnpm/npm/pip install, npm ls --json) in a temp dir; paths were rewritten to /tmp/fx.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { compressBashOutput, stripTerminalNoise, isViewingCommand, IMPORTANT, FOOTER_RESERVE, COMPRESS_MIN_CHARS, COMPRESS_MIN_SAVE, type CompressResult } from './output-compress';

const fx = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bash-output', name), 'utf8');
const LOW = { minChars: 500 };

/** Every distinct error / fail / warning line of the (cleaned) original must still be in the result. */
function assertImportantKept(raw: string, r: CompressResult, label: string): void {
  const cleaned = stripTerminalNoise(raw).split('\n').filter((l) => IMPORTANT.test(l));
  const missing = [...new Set(cleaned)].filter((l) => !r.text.includes(l));
  assert.deepEqual(missing, [], `${label}: important lines dropped`);
}

test('every fixture: nothing important is dropped, the saving beats the footer and 20%, and compression is deterministic', () => {
  let compressed = 0;
  for (const f of fs.readdirSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bash-output'))) {
    const raw = fx(f);
    const r = compressBashOutput(raw, LOW);
    if (!r) continue;
    compressed++;
    if (r.compressor === 'head-tail') continue; // the old trim: keeps its 80-error-line cap, covered by the trim tests
    assertImportantKept(raw, r, f);
    assert.ok(r.savedChars - FOOTER_RESERVE >= raw.length * COMPRESS_MIN_SAVE, `${f}: saved ${r.savedChars} of ${raw.length}`);
    assert.equal(compressBashOutput(raw, LOW)!.text, r.text, `${f}: deterministic`);
  }
  assert.ok(compressed >= 10, `compressed ${compressed} fixtures`);
});

test('node:test spec output: passing lines go; counts, every failing test, its assertion text and the top of its stack stay', () => {
  const raw = fx('nodetest-fail.txt');
  const r = compressBashOutput(raw, LOW)!;
  assert.match(r.compressor, /^test-node/);
  assert.ok(r.text.length < raw.length * 0.3, `${r.text.length} of ${raw.length}`);
  for (const must of ['ℹ tests 118', 'ℹ pass 115', 'ℹ fail 3', '✖ inner failing', '✖ top-level failing: wrong total', '✖ throws TypeError', 'Expected values to be strictly deep-equal', '4 !== 5', "Cannot read properties of null (reading 'foo')", 'a.test.js:62:126']) assert.ok(r.text.includes(must), must);
  assert.ok(!r.text.includes('✔ passes case 17'), 'passing lines are gone');
  assert.match(r.text, /passing-test lines omitted/);
  assert.match(r.text, /more stack frames\) omitted|more stack frames? omitted/);
  assert.equal((r.text.match(/at Test\.run \(/g) ?? []).length <= 6, true, 'stack frames capped per failure');
});

test('node:test pass-only output collapses to the counts', () => {
  const r = compressBashOutput(fx('nodetest-pass.txt'), LOW)!;
  assert.match(r.text, /ℹ pass 40/);
  assert.ok(r.text.length < 250);
});

test('TAP output: passing ok lines and their YAML blocks go; failing YAML (error, expected, actual, stack) stays', () => {
  const raw = fx('nodetest-tap-fail.txt');
  const r = compressBashOutput(raw, LOW)!;
  assert.match(r.compressor, /test-tap/);
  assert.ok(r.text.length < raw.length * 0.25, `${r.text.length} of ${raw.length}`);
  assert.ok(!/^\s*ok \d+ - passes case/m.test(r.text));
  assert.ok(!/duration_ms: 0\.0[0-9]*\n\s+type: 'test'\n\s+\.\.\./.test(r.text.split('not ok')[0]!), 'no orphan YAML from a passing test before the first failure');
  for (const must of ['# tests 118', '# fail 3', 'not ok 16 - inner failing', 'not ok 62 - top-level failing: wrong total', 'not ok 63 - throws TypeError', "expected: 5", 'actual: 4', "error: \"Cannot read properties of null (reading 'foo')\""]) assert.ok(r.text.includes(must), must);
});

test('vitest verbose, pytest, go test and cargo test: passes dropped, failures and summary kept', () => {
  const cases: Array<[string, string, string[]]> = [
    ['vitest-verbose.txt', 'test-js', ['FAIL  a.test.ts > math > wrong sum', 'AssertionError: expected 4 to be 5', 'AssertionError: expected { a: 1, b: [ 1, 2 ] } to deeply equal', 'Tests  2 failed | 40 passed (42)']],
    ['pytest-fail.txt', 'test-pytest', ['test_x.py::test_bad_sum FAILED', 'E       AssertionError: sum is wrong', 'E       assert 6 == 7', "E       KeyError: 'missing'", '2 failed, 50 passed in']],
    ['gotest-fail.txt', 'test-go', ['a_test.go:43: sum = 4, want 5', '--- FAIL: TestBad', 'FAIL\tfx\t0.491s']],
    ['cargo-test-fail.txt', 'test-cargo', ['test t::bad ... FAILED', "assertion `left == right` failed: sum was wrong", 'left: 4', 'right: 5', 'test result: FAILED. 40 passed; 1 failed']],
  ];
  for (const [file, name, must] of cases) {
    const raw = fx(file);
    const r = compressBashOutput(raw, LOW)!;
    assert.ok(r, file);
    assert.equal(r.compressor, name, file);
    for (const m of must) assert.ok(r.text.includes(m), `${file}: ${m}`);
    assert.ok(r.text.length < raw.length * 0.7, `${file}: ${r.text.length} of ${raw.length}`);
  }
});

test('jest-shaped output: PASS/✓ lines go, ● failure blocks and the Tests: line stay (hand-written, jest is not installed here)', () => {
  const body = ['PASS src/a.test.js', ...Array.from({ length: 30 }, (_, i) => `  ✓ case ${i} works as the spec says (${i} ms)`), 'FAIL src/b.test.js', '  ● suite › breaks', '', '    expect(received).toBe(expected)', '', '    Expected: 5', '    Received: 4', '      at Object.<anonymous> (src/b.test.js:9:20)', '', 'Tests:       1 failed, 30 passed, 31 total', 'Time:        1.2 s'].join('\n');
  const r = compressBashOutput(body, { minChars: 300 })!;
  assert.ok(r);
  for (const m of ['FAIL src/b.test.js', '● suite › breaks', 'Expected: 5', 'Received: 4', 'Tests:       1 failed, 30 passed, 31 total', 'src/b.test.js:9:20']) assert.ok(r.text.includes(m), m);
  assert.ok(!r.text.includes('case 7 works'));
});

test('a few passing lines in a non-test output are not treated as a test run', () => {
  const raw = ['✔ step one done', '✔ step two done', ...Array.from({ length: 80 }, (_, i) => `building module ${i} with a long descriptive line of text about it`)].join('\n');
  const r = compressBashOutput(raw, LOW);
  assert.ok(!r || !/^test-/.test(r.compressor));
});

test('package-manager noise: pip resolution / download lines go, the install summary stays; warnings always stay', () => {
  const raw = fx('pip-install.txt');
  const r = compressBashOutput(raw, LOW)!;
  assert.equal(r.compressor, 'pkg-noise');
  assert.ok(r.text.includes('Installing collected packages'));
  assert.ok(/Successfully installed/.test(r.text));
  assert.ok(!r.text.includes('Collecting pytest'));
  const pnpm = ['Progress: resolved 1, reused 0, downloaded 0, added 0', ...Array.from({ length: 12 }, (_, i) => `Progress: resolved ${i + 2}, reused ${i}, downloaded 1, added 0`), '[WARN] deprecated request@2.88.2: request has been deprecated', 'WARN  8 deprecated subdependencies found', 'Packages: +246', '++++++++++++++++++++++++++++++++++++++', ...Array.from({ length: 12 }, (_, i) => `Progress: resolved 246, reused ${i}, downloaded 1, added ${i}`), 'dependencies:', '+ express 4.21.2', 'Done in 1.6s using pnpm v11.10.0'].join('\n');
  const p = compressBashOutput(pnpm, { minChars: 300 })!;
  assert.ok(p);
  for (const m of ['[WARN] deprecated request@2.88.2', 'WARN  8 deprecated subdependencies found', '+ express 4.21.2', 'Done in 1.6s using pnpm v11.10.0']) assert.ok(p.text.includes(m), m);
  assert.ok(!p.text.includes('Progress: resolved 5,'));
});

test('compiler output (tsc plain, eslint) is left alone: every line is a distinct diagnostic, there is nothing honest to remove', () => {
  assert.equal(compressBashOutput(fx('tsc-errors.txt'), LOW), null);
  assert.equal(compressBashOutput(fx('eslint.txt'), LOW), null);
  assert.equal(compressBashOutput(fx('npm-ls.json')!, { command: 'npm ls --json' })!.compressor, 'head-tail', 'big JSON gets only the old head/tail trim, never a lossy skeleton');
});

test('repeated lines fold (identical, or identical but for digits / timestamps); error lines are only folded when exactly identical', () => {
  const raw = fx('repeat-log.txt');
  const r = compressBashOutput(raw)!;
  assert.equal(r.compressor, 'repeats');
  assert.ok(r.text.includes('retrying...  (repeated 120 times)'));
  assert.ok(r.text.includes('WARN done with 4 retries'));
  for (const n of [0, 97, 194, 291, 388]) assert.ok(r.text.includes(`ERROR connection refused to 127.0.0.1:5432 (attempt ${n})`), `attempt ${n} kept (digits differ)`);
  assert.ok(r.text.length < raw.length * 0.2);
  const exact = Array.from({ length: 200 }, () => 'ERROR connection refused to the database host').join('\n');
  assert.match(compressBashOutput(exact)!.text, /ERROR connection refused to the database host {2}\(repeated 200 times\)/);
  const blank = ['x', ...Array(300).fill(''), '}', ...Array(300).fill('}')].join('\n');
  assert.equal(compressBashOutput(blank), null, 'blank and bracket-only lines are not folded');
});

test('ANSI escapes and carriage-return progress bars keep only the final state', () => {
  const raw = fx('progress-cr.txt');
  const r = compressBashOutput(raw, LOW)!;
  assert.equal(r.compressor, 'clean');
  assert.ok(!r.text.includes('\x1b') && !r.text.includes('\r'));
  assert.ok(r.text.includes('Downloading [' + '#'.repeat(50) + '] 100%'));
  assert.ok(r.text.includes('warning: peer dep missing'));
  assert.ok(r.text.includes('Extracting...'));
  assert.equal(stripTerminalNoise('a\r\nb\r\n'), 'a\nb\n', 'CRLF is not a rewrite');
  assert.equal(stripTerminalNoise('abc'), 'abc');
});

test('file-viewing commands are only cleaned: the agent asked for exactly those lines', () => {
  const log = fx('repeat-log.txt');
  assert.equal(compressBashOutput(log, { command: 'cat build.log' })!.compressor, 'head-tail', 'no escape codes, no shape work: only the old trim over 8k');
  assert.equal(compressBashOutput(log.slice(0, 7000), { command: 'cat build.log' }), null, 'under 8k a viewed file is untouched');
  assert.equal(compressBashOutput(fx('nodetest-fail.txt'), { command: "cd /x && sed -n '1,200p' out.txt" }), null);
  assert.ok(compressBashOutput(fx('nodetest-fail.txt'), { command: 'cd /x && pnpm test 2>&1 | tail -200', minChars: 500 }), 'a runner piped into tail is still a test run');
  const colored = '\x1b[31m' + fx('progress-cr.txt') + '\x1b[0m';
  assert.ok(compressBashOutput(colored, { command: 'cat x.log', minChars: 500 })!.compressor === 'clean');
  assert.equal(isViewingCommand('cat a.txt'), true);
  assert.equal(isViewingCommand('cd ~/p && rg -n foo src | head -50'), true);
  assert.equal(isViewingCommand('git diff HEAD~1 -- a.ts'), true);
  assert.equal(isViewingCommand('git commit -m x'), false);
  assert.equal(isViewingCommand('pnpm test'), false);
  assert.equal(isViewingCommand('cat a.txt && node build.js'), false);
  assert.equal(isViewingCommand('FOO=1 /usr/bin/grep -a x y'), true);
  assert.equal(isViewingCommand(undefined), false);
  assert.equal(isViewingCommand(''), false);
});

test('the head / errors / tail trim is still the fallback for unrecognised big output, and only above 8,000 chars', () => {
  const unknown = Array.from({ length: 400 }, (_, i) => `row ${i}: value=${(i * 7919) % 1000} name=entry_${i}_${'z'.repeat(i % 13)} status ok`).join('\n');
  assert.ok(unknown.length > 8000);
  const r = compressBashOutput(unknown)!;
  assert.equal(r.compressor, 'head-tail');
  assert.ok(r.text.startsWith('row 0:') && r.text.endsWith(' status ok'));
  const mid = unknown.slice(0, 7900);
  assert.equal(compressBashOutput(mid), null, 'unrecognised and under 8k: left alone');
});

test('thresholds and failure: small output, huge output and a blown time budget all pass the original through; garbage never throws', () => {
  const big = fx('nodetest-fail.txt');
  assert.ok(big.length >= COMPRESS_MIN_CHARS);
  assert.ok(compressBashOutput(big));
  assert.equal(compressBashOutput(big.slice(0, COMPRESS_MIN_CHARS - 1)), null);
  assert.equal(compressBashOutput('x'.repeat(3_000_000)), null);
  assert.equal(compressBashOutput(big, { budgetMs: -5 }), null, 'out of time: fail open');
  for (const g of [undefined, null, 5, {}, [], '', '\ud800'.repeat(3000), '\r'.repeat(5000), '\x1b['.repeat(2000), 'a\n'.repeat(5000)]) assert.doesNotThrow(() => compressBashOutput(g as any, LOW));
  assert.equal(compressBashOutput(undefined as any), null);
});

// ── adversarial (2026-10-14): lines a reader needs that a compressor dropped ──

test('parameterised failing tests (jest ✕, vitest ×, mocha "N)") are never folded as "similar lines" in a test run', () => {
  const jest = ['PASS src/a.test.js', ...Array.from({ length: 30 }, (_, i) => `    ✓ works case ${i} (${i % 5} ms)`), 'FAIL src/div.test.js', ...[1, 2, 3, 4, 5].map((i) => `    ✕ divides ${i} by zero (${i} ms)`), '', 'Tests:       5 failed, 30 passed, 35 total'].join('\n');
  const vitest = [...Array.from({ length: 30 }, (_, i) => ` ✓ src/t${i}.test.ts (3 tests) ${i}ms`), ...[1, 2, 3, 4, 5].map((i) => `   × parses row ${i} ${i}ms`), ' Test Files  1 failed | 30 passed (31)', '      Tests  5 failed | 90 passed (95)'].join('\n');
  const mocha = ['  suite', ...Array.from({ length: 40 }, (_, i) => `    ✔ passes ${i}`), ...[1, 2, 3, 4, 5].map((i) => `    ${i}) breaks on input ${i}`), '', '  40 passing (20ms)', '  5 failing'].join('\n');
  for (const [name, raw, mark] of [['jest', jest, '✕ divides 3 by zero'], ['vitest', vitest, '× parses row 3'], ['mocha', mocha, '3) breaks on input 3']] as const) {
    const r = compressBashOutput(raw, { minChars: 200 });
    assert.ok(r, name);
    assert.ok(r.text.includes(mark), `${name}: a failing test name was folded away:\n${r.text}`);
  }
});

test('a progress redraw never erases an error printed on the same line', () => {
  assert.equal(stripTerminalNoise('Error: disk full\r[====================] 100%'), 'Error: disk full\n[====================] 100%');
  assert.equal(stripTerminalNoise(' 10%\r 50%\r100%'), '100%', 'plain redraws still keep only the final state');
});

test('rows that are nothing but numbers (a query result) are content, not a timestamped log: they are not folded', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `${i}|${(i * 37) % 1000}|${(i * 0.13).toFixed(2)}`).join('\n');
  assert.equal(compressBashOutput(rows, { command: 'sqlite3 db.sqlite "select id, n, avg from t"' }), null);
});

test('an unclosed YAML block of a passing TAP test does not swallow the failing tests and counts after it', () => {
  const raw = ['TAP version 13', ...Array.from({ length: 30 }, (_, i) => `# Subtest: t${i}\nok ${i + 1} - t${i}\n  ---\n  duration_ms: 1.2\n  ...`), 'ok 31 - last', '  ---', '  duration_ms: 3', 'not ok 32 - broken', '  ---', '  error: boom', '  ...', '# tests 32', '# fail 1'].join('\n');
  const r = compressBashOutput(raw, { minChars: 200 })!;
  for (const must of ['not ok 32 - broken', 'error: boom', '# tests 32', '# fail 1']) assert.ok(r.text.includes(must), must);
});

test('a stack thrown inside a library keeps the first frame of the caller\'s own code', () => {
  const raw = [...Array.from({ length: 80 }, (_, i) => `✔ ok number ${i} passes fine (1.0ms)`), '✖ bad (2ms)', '  TypeError: x is not a function', '      at lib (node_modules/a/i.js:1:1)', '      at lib2 (node_modules/a/i.js:2:1)', '      at lib3 (node_modules/a/i.js:3:1)', '      at lib4 (node_modules/a/i.js:4:1)', '      at myCode (src/mine.ts:42:7)', '      at more (src/mine.ts:50:1)', 'ℹ tests 81', 'ℹ fail 1'].join('\n');
  const r = compressBashOutput(raw, { minChars: 200 })!;
  assert.ok(r.text.includes('at myCode (src/mine.ts:42:7)'), r.text);
});

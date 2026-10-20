// Warning folding (SAV-D, 2026-10-15): a warning-heavy build is IMPORTANT on every line, so nothing shrank it. Warnings that differ
// only in numbers / paths / quoted names now fold into their first occurrence + a count; an error line is never touched.
import { test } from 'node:test';
import assert from 'node:assert';
import { compressBashOutput, lineTemplate, isWarningOnly, IMPORTANT } from './output-compress';

function warnBuild(n: number): string[] {
  const out: string[] = ['> app@1.0.0 build', '> tsc -p .'];
  for (let i = 0; i < n; i++) out.push(`src/mod${i % 40}/file${i}.ts(${10 + i},${i % 7 + 1}): warning TS6133: '${['a', 'tmp', 'value'][i % 3]}' is declared but its value is never read.`);
  return out;
}

test('lineTemplate blanks numbers, paths, file names and quoted names', () => {
  assert.equal(lineTemplate("src/a/b.ts(12,3): warning TS6133: 'x' is declared"), lineTemplate("src/c/d.ts(99,1): warning TS6133: 'yy' is declared"));
  assert.notEqual(lineTemplate('warning: unused import'), lineTemplate('warning: deprecated call'));
  assert.ok(isWarningOnly('WARN something odd happened here'));
  assert.ok(!isWarningOnly('warning: the build failed'), 'a warning that says failed is an error line');
  assert.ok(!isWarningOnly('plain line without anything'));
});

test('a build with hundreds of warnings and one error: warnings fold, the error stays verbatim, in place', () => {
  const lines = warnBuild(300);
  lines.splice(150, 0, "src/core/engine.ts(88,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  lines.push('Found 1 error and 300 warnings.');
  const raw = lines.join('\n');
  assert.ok(lines.every((l) => l === '> app@1.0.0 build' || l === '> tsc -p .' || IMPORTANT.test(l)), 'every line but the banner is IMPORTANT');
  const r = compressBashOutput(raw, { command: 'pnpm run build' })!;
  assert.ok(r, 'compressed');
  assert.match(r.compressor, /warn-fold/);
  assert.ok(r.text.includes("src/core/engine.ts(88,5): error TS2322: Type 'string' is not assignable to type 'number'."), 'error line kept verbatim');
  assert.ok(r.text.includes('Found 1 error and 300 warnings.'));
  assert.ok(r.text.length < raw.length * 0.2, `${r.text.length} of ${raw.length}`);
  assert.match(r.text, /more lines like the one above/);
  const kept = r.text.split('\n');
  assert.ok(kept.indexOf(lines[2]!) >= 0, 'the first warning of each template stays');
});

test('error lines are never folded, even when only the digits differ; warnings that mention failure stay too', () => {
  const lines: string[] = [];
  for (let i = 0; i < 120; i++) lines.push(`ERROR connection refused to 127.0.0.1:${5000 + i} for worker ${i}`);
  for (let i = 0; i < 120; i++) lines.push(`warning: failed to resolve module ${i}`);
  for (let i = 0; i < 120; i++) lines.push(`warning: deprecated call number ${i} in the legacy adapter`);
  const raw = lines.join('\n');
  const r = compressBashOutput(raw, { command: 'make' })!;
  assert.ok(r);
  for (const l of lines.slice(0, 240)) assert.ok(r.text.includes(l), `kept: ${l}`);
  assert.ok(r.text.split('\n').filter((l) => /deprecated call/.test(l)).length === 1, 'the deprecated-call warnings fold to one');
});

test('distinct warnings are all kept and plain rows that differ in an id are not folded (a table is content)', () => {
  const distinct = Array.from({ length: 80 }, (_, i) => `warning: distinct problem ${'abcdefghij'[i % 10]!.repeat(3)} variant ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))} found`).join('\n');
  const r1 = compressBashOutput(distinct, { command: 'make' });
  if (r1) for (const l of new Set(distinct.split('\n'))) assert.ok(r1.text.includes(l));
  const rows = Array.from({ length: 200 }, (_, i) => `user ${i} signed in from region eu-west-${i % 3} with plan pro`).join('\n');
  const r2 = compressBashOutput(rows, { command: 'node report.js' });
  assert.ok(!r2 || !/warn-fold/.test(r2.compressor));
});

test('file-viewing commands are never folded (the agent asked for those lines)', () => {
  const raw = warnBuild(300).join('\n');
  const r = compressBashOutput(raw, { command: 'cat build.log' });
  assert.ok(!r || !/warn-fold/.test(r.compressor));
});

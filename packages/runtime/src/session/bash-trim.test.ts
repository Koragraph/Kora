import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimBashOutput, createBashTrimHooks, toolOutDir, KEEP_HEAD_LINES, KEEP_TAIL_LINES } from './bash-trim';
import { flushCostLog, readCostLog, summarizeCostLog } from '../util/cost-log';

function bigLog(): string {
  const out: string[] = [];
  for (let i = 0; i < 600; i++) out.push(`ok ${i} - passing test number ${i} in a very verbose reporter line`);
  out[300] = 'not ok 300 - FAIL: the lock holder is wrong';
  out[420] = 'WARNING: deprecated call in src/a.ts';
  return out.join('\n');
}
const hookOf = (hooks: Record<string, any>) => hooks.PostToolUse[0].hooks[0] as (i: any) => Promise<any>;
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-bt-'));

test('trimBashOutput keeps the head, every error and warning line and the tail; small or incompressible output is left alone', () => {
  const raw = bigLog();
  const t = trimBashOutput(raw)!;
  assert.ok(t, 'trimmed');
  const lines = t.text.split('\n');
  assert.equal(lines[0], 'ok 0 - passing test number 0 in a very verbose reporter line');
  assert.ok(t.text.includes('not ok 300 - FAIL: the lock holder is wrong'), 'failure line kept');
  assert.ok(t.text.includes('WARNING: deprecated call in src/a.ts'), 'warning line kept');
  assert.ok(t.text.endsWith('ok 599 - passing test number 599 in a very verbose reporter line'), 'tail kept');
  assert.ok(lines.length <= KEEP_HEAD_LINES + KEEP_TAIL_LINES + 6);
  assert.equal(t.keptErrorLines, 2);
  assert.ok(t.savedChars > raw.length * 0.5);
  assert.equal(trimBashOutput('short'), null);
  assert.equal(trimBashOutput('x'.repeat(20000)), null, 'one huge line: nothing to cut by line');
  assert.equal(trimBashOutput(Array.from({ length: 120 }, (_, i) => `error line ${i} ${'y'.repeat(70)}`).join('\n')), null, 'all lines matter: not worth it');
});

test('shadow (the default): logs what a trim would save and never changes the output', async () => {
  const h = home();
  const hook = hookOf(createBashTrimHooks({ threadId: 'T1', mode: () => 'shadow', home: h }));
  const r = await hook({ tool_name: 'Bash', tool_response: { stdout: bigLog(), stderr: '', interrupted: false, isImage: false } });
  assert.deepEqual(r, {}, 'the original output goes through');
  await flushCostLog(h);
  const rows = readCostLog({ home: h });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.k, 'bash-trim-shadow');
  assert.ok((rows[0] as any).saved > 1000);
  assert.equal(summarizeCostLog(rows).bash.shadow, 1);
  assert.ok(!fs.existsSync(path.join(h, 'tool-out')), 'nothing spilled in shadow');
});

test('on: replaces stdout (other fields kept), spills the full text to a private file and names the path', async () => {
  const h = home();
  const seen: any[] = [];
  const hook = hookOf(createBashTrimHooks({ threadId: 'T/2', mode: () => 'on', home: h, onTrimmed: (i) => seen.push(i) }));
  const raw = bigLog();
  const r = await hook({ tool_name: 'Bash', tool_response: { stdout: raw, stderr: 'warn: x', interrupted: false, isImage: false, extra: 1 } });
  const out = r.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.equal(out.updatedToolOutput.stderr, 'warn: x');
  assert.equal(out.updatedToolOutput.extra, 1);
  assert.ok(out.updatedToolOutput.stdout.length < raw.length / 2);
  const file = /saved at (\S+\.txt)/.exec(out.updatedToolOutput.stdout)![1]!;
  assert.ok(file.startsWith(toolOutDir('T/2', h)), 'thread id is sanitised into one directory');
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'the full output is kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(seen.length, 1);
});

test('never touches: off, other tools, small output, interrupted, images, background tasks; a failed spill passes the output through', async () => {
  const h = home();
  const big = bigLog();
  const call = (mode: 'off' | 'on', input: any, dir = h) => hookOf(createBashTrimHooks({ threadId: 'T9', mode: () => mode, home: dir }))(input);
  assert.deepEqual(await call('off', { tool_name: 'Bash', tool_response: { stdout: big } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Read', tool_response: { stdout: big } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: { stdout: 'hi' } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: { stdout: big, interrupted: true } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: { stdout: big, isImage: true } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: { stdout: big, backgroundTaskId: 'b1' } }), {});
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: 'a string' }), {});
  const blocker = path.join(h, 'blocked'); fs.writeFileSync(blocker, 'file, not a dir'); // tool-out cannot be created beneath a file
  assert.deepEqual(await call('on', { tool_name: 'Bash', tool_response: { stdout: big } }, blocker), {}, 'fail open: the full text is never dropped');
});

test('S6: a dot-only thread id cannot name tool-out itself or the Kora home', () => {
  const h = home();
  for (const id of ['.', '..', '...', '']) assert.equal(path.dirname(toolOutDir(id, h)), path.join(h, 'tool-out'), JSON.stringify(id));
  assert.notEqual(toolOutDir('..', h), h);
  assert.equal(path.dirname(toolOutDir('../../x', h)), path.join(h, 'tool-out'));
});

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'bash-output', name), 'utf8');

test('content-aware: shadow logs the compressor name for a 7 KB test run (under the old 8k line) and never changes the output', async () => {
  const h = home();
  const raw = fixture('nodetest-fail.txt');
  assert.ok(raw.length < 8000, 'the old trim would have ignored this');
  await flushCostLog(home()); // the cost buffer is process-global: drain rows other tests left pending
  const hook = hookOf(createBashTrimHooks({ threadId: 'T4', mode: () => 'shadow', home: h }));
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'node --test' }, tool_response: { stdout: raw, stderr: '' } }), {});
  await flushCostLog(h);
  const row = readCostLog({ home: h })[0] as any;
  assert.equal(row.k, 'bash-trim-shadow');
  assert.match(row.c, /^test-node/);
  assert.ok(row.saved > 1000);
  assert.ok(!fs.existsSync(path.join(h, 'tool-out')));
});

test('content-aware on: stdout and stderr each compressed with their own spill file and footer; failures survive; the file holds the original', async () => {
  const h = home();
  const out = fixture('nodetest-fail.txt');
  const err = fixture('pip-install.txt');
  await flushCostLog(home()); // the cost buffer is process-global: drain rows other tests left pending
  const hook = hookOf(createBashTrimHooks({ threadId: 'T5', mode: () => 'on', home: h }));
  const r = await hook({ tool_name: 'Bash', tool_input: { command: 'pnpm test' }, tool_response: { stdout: out, stderr: err, interrupted: false, isImage: false } });
  const u = r.hookSpecificOutput.updatedToolOutput;
  assert.ok(u.stdout.includes('✖ top-level failing: wrong total') && u.stdout.includes('ℹ fail 3'));
  assert.match(u.stdout, /\[Kora compressed this stdout \(test-node\)[^\]]*saved at \S+\.txt/);
  assert.match(u.stderr, /\[Kora compressed this stderr \(pkg-noise\)[^\]]*saved at \S+\.txt/);
  const f1 = /saved at (\S+\.txt)/.exec(u.stdout)![1]!;
  const f2 = /saved at (\S+\.txt)/.exec(u.stderr)![1]!;
  assert.notEqual(f1, f2);
  assert.equal(fs.readFileSync(f1, 'utf8'), out);
  assert.equal(fs.readFileSync(f2, 'utf8'), err);
  await flushCostLog(h);
  const row = readCostLog({ home: h })[0] as any;
  assert.equal(row.k, 'bash-trim');
  assert.match(row.c, /stdout:test-node.*stderr:pkg-noise/);
});

test('content-aware on: a file-viewing command keeps its lines (only the old 8k trim applies); a failed spill still passes the original through', async () => {
  const h = home();
  const raw = fixture('repeat-log.txt').slice(0, 7000);
  const hook = hookOf(createBashTrimHooks({ threadId: 'T6', mode: () => 'on', home: h }));
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'cat server.log' }, tool_response: { stdout: raw, stderr: '' } }), {});
  const blocker = path.join(h, 'blocked'); fs.writeFileSync(blocker, 'x');
  const bad = hookOf(createBashTrimHooks({ threadId: 'T6', mode: () => 'on', home: blocker }));
  assert.deepEqual(await bad({ tool_name: 'Bash', tool_input: { command: 'node run.js' }, tool_response: { stdout: fixture('repeat-log.txt'), stderr: '' } }), {});
});

// Edge cases of the Bash spill-and-compress hook (test/savings 2026-10-14): shadow writes nothing, interrupted and odd responses
// pass through, stderr is compressed on its own, an unwritable spill keeps the original.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBashTrimHooks } from './bash-trim';
import { flushCostLog } from '../util/cost-log';

const noisy = Array.from({ length: 3000 }, (_, i) => `✔ passes case ${i} (0.1ms)`).join('\n') + '\n✖ the one failure\n  AssertionError: 1 !== 2\nℹ fail 1';
const run = async (mode: 'on' | 'shadow', resp: unknown, home: string, command = 'pnpm test') => {
  const hooks = createBashTrimHooks({ threadId: 'th', mode: () => mode, home }) as any;
  return hooks.PostToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command }, tool_response: resp });
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-bt-'));
const rows = (home: string) => { try { return fs.readFileSync(path.join(home, 'cost.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('edge: shadow logs one row, writes no spill file and returns nothing', async () => {
  const home = tmp();
  try {
    assert.deepEqual(await run('shadow', { stdout: noisy, stderr: '', interrupted: false, isImage: false }, home), {});
    assert.equal(fs.existsSync(path.join(home, 'tool-out')), false);
    await flushCostLog(home);
    const r = rows(home);
    assert.equal(r.length, 1); assert.equal(r[0].k, 'bash-trim-shadow'); assert.ok(r[0].saved > 1000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('edge: interrupted, image, background and non-object responses pass through', async () => {
  const home = tmp();
  try {
    for (const resp of [{ stdout: noisy, interrupted: true }, { stdout: noisy, isImage: true }, { stdout: noisy, backgroundTaskId: 'b1' }, noisy, null, { stdout: 42 }])
      assert.deepEqual(await run('on', resp, home), {}, JSON.stringify(resp).slice(0, 40));
    await flushCostLog(home);
    assert.equal(rows(home).length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('edge: a noisy stderr is compressed on its own, the failure kept, the full text spilled 0600', async () => {
  const home = tmp();
  try {
    const r = await run('on', { stdout: 'ok', stderr: noisy, interrupted: false, isImage: false, extra: 1 }, home);
    const out = r.hookSpecificOutput.updatedToolOutput;
    assert.equal(out.stdout, 'ok'); assert.equal(out.extra, 1);
    assert.ok(out.stderr.includes('✖ the one failure') && out.stderr.includes('1 !== 2'));
    const file = /saved at (\S+?) \(/.exec(out.stderr)![1]!;
    assert.equal(fs.readFileSync(file, 'utf8'), noisy);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('edge: when the spill cannot be written the original output goes through', async () => {
  const home = tmp();
  try {
    fs.writeFileSync(path.join(home, 'tool-out'), 'not a dir');
    assert.deepEqual(await run('on', { stdout: noisy, stderr: '', interrupted: false, isImage: false }, home), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('edge: a viewing command (cat of a big log) gets no shape work, only the old head/tail trim over 8k', async () => {
  const home = tmp();
  try {
    const r = await run('on', { stdout: noisy, stderr: '' }, home, 'cat build.log');
    assert.match(r.hookSpecificOutput.updatedToolOutput.stdout, /compressed this stdout \(head-tail\)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Found live 2026-10-14: an output over Claude Code's ~30k cap reaches PostToolUse as a cut head plus `persistedOutputPath`,
// and while those fields stay the CLI shows the model only a 2 KB preview of stdout. The trim compressed the head (the
// failure further down lost) and the CLI then cut the result to its preview anyway.
test('edge: a CLI-persisted output is compressed from the full file and the persisted fields are dropped', async () => {
  const home = tmp();
  try {
    const full = path.join(home, 'cli-out.txt');
    fs.writeFileSync(full, noisy);
    const head = noisy.slice(0, 28_000);
    const out = await run('on', { stdout: head, stderr: '', interrupted: false, isImage: false, persistedOutputPath: full, persistedOutputSize: noisy.length }, home);
    const o = out.hookSpecificOutput?.updatedToolOutput;
    assert.ok(o, 'replaced');
    assert.ok(o.stdout.includes('✖ the one failure') && o.stdout.includes('AssertionError: 1 !== 2'), 'failure from past the head kept');
    assert.ok(o.stdout.length < 6500);
    assert.equal('persistedOutputPath' in o, false); assert.equal('persistedOutputSize' in o, false);
    await flushCostLog(home);
    assert.equal(rows(home)[0].k, 'bash-trim');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('edge: a persisted output with no usable shape (or an unreadable file) keeps the CLI preview', async () => {
  const home = tmp();
  try {
    const words = ['alpha', 'quartz', 'meadow', 'copper', 'lantern', 'ripple', 'saffron', 'tundra', 'velvet', 'zephyr'];
    const plain = Array.from({ length: 4000 }, (_, i) => `${words[i % 10]} ${words[(i * 7) % 10]}/${(i * 2654435761) % 4294967296} ${words[(i * 3 + 1) % 10]}`).join('\n');
    const full = path.join(home, 'plain.txt'); fs.writeFileSync(full, plain);
    assert.deepEqual(await run('on', { stdout: plain.slice(0, 28_000), stderr: '', persistedOutputPath: full, persistedOutputSize: plain.length }, home, 'node gen.js'), {}, 'head-tail would beat nothing');
    assert.deepEqual(await run('on', { stdout: noisy.slice(0, 28_000), stderr: '', persistedOutputPath: path.join(home, 'gone.txt'), persistedOutputSize: 1 }, home), {}, 'missing file');
    assert.deepEqual(await run('on', { stdout: noisy.slice(0, 28_000), stderr: '', persistedOutputPath: 'relative.txt', persistedOutputSize: 1 }, home), {}, 'relative path');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

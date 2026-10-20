// Edge cases of bounded reads (test/savings 2026-10-14): ranges, paths outside the repo, stale hints, boundary sizes, a slow graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseWindow, decideRead, newReadWindowState, startTurn, type ReadIO } from './read-window';
import { createReadBounder, statLines } from './read-bounder';

const CWD = '/repo';
const OUTLINE = '3 symbol(s) in src/big.ts\n  src/big.ts: FUNCTION a:10, FUNCTION b:400, FUNCTION c:800, FILE src/big.ts:1';
const io = (lines = 1000): ReadIO => ({ stat: async () => ({ lines, bytes: lines * 40 }), indexed: async () => true, outline: async () => OUTLINE });

test('edge: any explicit range (even offset 0) and any path outside the repo pass through untouched', async () => {
  for (const [input, why] of [
    [{ file_path: 'src/big.ts', offset: 0 }, 'has-range'],
    [{ file_path: 'src/big.ts', limit: 5000 }, 'has-range'],
    [{ file_path: '../other/big.ts' }, 'outside-repo'],
    [{ file_path: '/etc/big.ts' }, 'outside-repo'],
    [{ file_path: '/repo' + '/' }, 'not-code'],
    [{ file_path: 'src/big.min.css' }, 'not-code'],
  ] as const) {
    const s = newReadWindowState();
    const out = await decideRead(s, { ...input }, CWD, io());
    assert.equal(out.bound, null); assert.equal(out.skip, why, JSON.stringify(input));
  }
});

test('edge: the size boundary — 300 lines is small, a file just over it whose head would cover most of it is no-gain', async () => {
  assert.equal((await decideRead(newReadWindowState(), { file_path: 'src/big.ts' }, CWD, io(300))).skip, 'small');
  assert.equal((await decideRead(newReadWindowState(), { file_path: 'src/big.ts' }, CWD, io(301))).skip, 'no-gain');
  const big = await decideRead(newReadWindowState(), { file_path: 'src/big.ts' }, CWD, io(1000));
  assert.deepEqual(big.bound?.updatedInput, { file_path: 'src/big.ts', offset: 1, limit: 250 });
});

test('edge: a hint for a line past the end of the (shrunk) file is ignored and the window is labelled head, not injection', async () => {
  const s = newReadWindowState();
  s.hints['src/big.ts'] = { inj: [5000] };
  const out = await decideRead(s, { file_path: 'src/big.ts' }, CWD, io(1000));
  assert.equal(out.bound?.record.offset, 1);
  assert.equal(out.bound?.record.source, 'head');
  assert.equal(chooseWindow(1000, [], [0, -3, 1.5], undefined)?.source, 'head');
  assert.deepEqual(chooseWindow(1000, [], [5000], [600]), { offset: 588, limit: 250, source: 'explore' }, 'a stale injection hint falls back to explore');
});

test('edge: a prompt that names the file, or asks for the whole thing, keeps the Read whole', async () => {
  const s = newReadWindowState();
  startTurn(s, 'walk me through big.ts');
  assert.equal((await decideRead(s, { file_path: 'src/big.ts' }, CWD, io())).skip, 'prompt-names-file');
  const t = newReadWindowState();
  startTurn(t, 'read the ENTIRE parser please');
  assert.equal((await decideRead(t, { file_path: 'src/big.ts' }, CWD, io())).skip, 'prompt-wants-whole');
});

test('edge: statLines counts CRLF, a missing final newline, an empty file and refuses a directory', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rw-'));
  try {
    fs.writeFileSync(path.join(d, 'a.ts'), 'x\r\ny\r\nz');
    assert.deepEqual(await statLines(path.join(d, 'a.ts')), { lines: 3, bytes: 7 });
    fs.writeFileSync(path.join(d, 'e.ts'), '');
    assert.deepEqual(await statLines(path.join(d, 'e.ts')), { lines: 0, bytes: 0 });
    assert.equal(await statLines(d), null);
    assert.equal(await statLines(path.join(d, 'missing.ts')), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('edge: a graph that never answers lets the Read through whole inside the budget', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-rw-'));
  try {
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src', 'big.ts'), 'const x = 1;\n'.repeat(1200));
    const b = createReadBounder({ threadId: 't', cwd: d, mode: () => 'on', graphStatus: () => new Promise(() => {}), graphCall: () => new Promise(() => {}) } as any);
    const pre = (b.hooks().PreToolUse as any)[0].hooks[0];
    const t0 = Date.now();
    const r = await pre({ tool_name: 'Read', tool_input: { file_path: 'src/big.ts' }, cwd: d }, 'tu1');
    assert.deepEqual(r, {});
    assert.ok(Date.now() - t0 < 1500, 'within the budget');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphService, progressPct } from './service';

test('progressPct: files map to 3–85, the post-file tail to 85–95 by time, no store row → time estimate capped at 85', () => {
  assert.equal(progressPct({ done: 0, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: false }), 3);
  assert.equal(progressPct({ done: 104, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: false }), 44);
  assert.equal(progressPct({ done: 209, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: false }), 85);
  assert.equal(progressPct({ done: 300, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: false }), 85, 'never over 85 in the files phase');
  assert.equal(progressPct({ done: 209, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: true, tailElapsedMs: 0, tailEstMs: 1200 }), 85);
  assert.equal(progressPct({ done: 209, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: true, tailElapsedMs: 600, tailEstMs: 1200 }), 90);
  assert.equal(progressPct({ done: 209, total: 209, elapsedMs: 0, estMs: 6000, filesPhaseDone: true, tailElapsedMs: 9000, tailEstMs: 1200 }), 95, 'tail never claims 100 — the exit does');
  assert.equal(progressPct({ done: 0, total: 0, elapsedMs: 3000, estMs: 6000, filesPhaseDone: false }), 50, 'no row yet: time estimate');
  assert.equal(progressPct({ done: 0, total: 0, elapsedMs: 60000, estMs: 6000, filesPhaseDone: false }), 85, 'time estimate capped below the tail band');
  assert.equal(progressPct({ done: 0, total: 0, elapsedMs: 0, estMs: 0, filesPhaseDone: false }), 0);
});

const INDEXED_REPO = process.env.KORA_TEST_INDEXED_REPO ?? path.join(os.homedir(), 'Projects', 'KoragraphMCP');
const haveStore = fs.existsSync(INDEXED_REPO) && fs.existsSync(`${process.env.KORAGRAPH_DB || `${process.env.HOME}/.koragraph/graph.db`}`);

test('callTool rejects the memory tools (remember, recall) and never reaches koragraph', async () => {
  const g = createGraphService();
  await assert.rejects(() => g.callTool('remember' as any, { body: 'x' }, { cwd: process.cwd() }), /Unknown graph tool "remember"/);
  await assert.rejects(() => g.callTool('recall' as any, { symbol: 'x' }, { cwd: process.cwd() }), /Unknown graph tool "recall"/);
  await assert.rejects(() => g.callTool('nope' as any, {}, { cwd: process.cwd() }), /Unknown graph tool/);
});

test('status never throws outside a repo and returns zeros', async () => {
  const g = createGraphService();
  const st = await g.status('/');
  assert.equal(st.indexed, false);
  assert.equal(st.nodes, 0);
  assert.equal(g.repoRoot('/'), null);
});

test('brief returns a bounded, non-empty string with the how-to section', { skip: !haveStore && 'user store / KoragraphMCP not present' }, async () => {
  const g = createGraphService();
  const text = await g.brief(INDEXED_REPO, 'claude');
  assert.ok(text.length > 200, 'non-empty');
  assert.ok(text.length <= 2500, `bounded (${text.length})`);
  assert.match(text, /kora graph explore/);
  assert.match(text, /mcp__kora__explore/);
  assert.match(text, /GRAPH — KoragraphMCP/);
  const st = await g.status(INDEXED_REPO);
  assert.equal(st.indexed, true);
  assert.ok(st.nodes > 1000);
});

import { ingestRoot } from './service';
import { spawnSync as _sp } from 'node:child_process';
import _fs from 'node:fs'; import _os from 'node:os'; import _path from 'node:path';
test('ingestRoot: inside a linked worktree the MAIN checkout is what gets indexed', () => {
  const repo = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nh-ir-'));
  const git = (...a: string[]) => _sp('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  _fs.writeFileSync(_path.join(repo, 'a.txt'), 'x'); git('add', '.'); git('commit', '-q', '-m', 'i');
  const wt = _path.join(_os.tmpdir(), `nh-ir-wt-${process.pid}`); git('worktree', 'add', '-q', '-b', 'kora/t', wt, 'HEAD');
  try {
    assert.equal(ingestRoot(repo).fromWorktree, null);
    const r = ingestRoot(_path.join(wt));
    assert.equal(_fs.realpathSync(r.root), _fs.realpathSync(repo)); assert.ok(r.fromWorktree);
  } finally { git('worktree', 'remove', '--force', wt); _fs.rmSync(repo, { recursive: true, force: true }); }
});

test('ingestRoot: a symlinked spelling indexes the real checkout (no duplicate index under the link name)', () => {
  const real = _fs.realpathSync(_fs.mkdtempSync(_path.join(_os.tmpdir(), 'nh-link-')));
  const link = _path.join(_os.tmpdir(), `nh-link-${process.pid}`);
  _fs.symlinkSync(real, link);
  try { assert.equal(ingestRoot(link).root, real); } finally { _fs.unlinkSync(link); _fs.rmSync(real, { recursive: true, force: true }); }
});

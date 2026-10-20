// Phase 2 collisions: a nested git repo inside the checkout, a symlinked node_modules in the worktree, and the same
// agent spawned twice — each must give a usable worktree and a clean merge of only the agent's work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktree, mergeWorktree, listWorktrees, removeWorktree } from './worktree';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-coll-'));
process.env.KORA_WORKTREES = path.join(home, 'wt');
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function mkRepo(name: string): string {
  const repo = path.join(home, name); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('same agent twice → two distinct worktrees and branches', () => {
  const repo = mkRepo('twice');
  const a = createWorktree(repo, 'claude'); const b = createWorktree(repo, 'claude');
  assert.notEqual(a.path, b.path); assert.notEqual(a.branch, b.branch);
  assert.equal(listWorktrees(repo).length, 2);
});

test('a nested git repository inside the checkout (untracked) does not break worktree creation or merge', () => {
  const repo = mkRepo('nested');
  const inner = path.join(repo, 'vendor/inner'); fs.mkdirSync(inner, { recursive: true });
  git(inner, 'init', '-q'); fs.writeFileSync(path.join(inner, 'x.txt'), 'x\n'); git(inner, 'add', '.'); git(inner, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'inner');
  const w = createWorktree(repo, 'codex');
  fs.writeFileSync(path.join(w.path, 'src/b.js'), 'export const b = 2;\n');
  // the agent's run leaves a nested repo in ITS worktree too (a cloned dependency, say)
  const innerW = path.join(w.path, 'vendor/inner'); fs.mkdirSync(innerW, { recursive: true }); git(innerW, 'init', '-q'); fs.writeFileSync(path.join(innerW, 'y.txt'), 'y\n');
  const r = mergeWorktree(w.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  const tracked = git(repo, 'ls-files').split('\n');
  assert.ok(tracked.includes('src/b.js'), 'the work landed');
  assert.ok(!tracked.some((f) => f.startsWith('vendor/inner')), `a nested repo is never committed as a gitlink: ${tracked.join(',')}`);
});

test('a symlinked node_modules in the worktree is neither committed nor a merge blocker', () => {
  const repo = mkRepo('symlink');
  const w = createWorktree(repo, 'gemini');
  const target = path.join(home, 'shared-node_modules'); fs.mkdirSync(path.join(target, 'left-pad'), { recursive: true }); fs.writeFileSync(path.join(target, 'left-pad/index.js'), 'module.exports = 1;\n');
  fs.symlinkSync(target, path.join(w.path, 'node_modules'));
  fs.writeFileSync(path.join(w.path, 'src/c.js'), 'export const c = 3;\n');
  const r = mergeWorktree(w.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  const tracked = git(repo, 'ls-files').split('\n');
  assert.ok(tracked.includes('src/c.js')); assert.ok(!tracked.includes('node_modules'), `symlink not committed: ${tracked.join(',')}`);
});

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });

test('a submodule in the checkout: the worktree gets the gitlink, the agent\'s edits merge, the submodule pointer is untouched', () => {
  const repo = mkRepo('submod');
  const dep = mkRepo('dep');
  const r0 = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dep, 'deps/dep'], { cwd: repo, encoding: 'utf8' });
  if (r0.status !== 0) { assert.ok(true, `submodule add unavailable here: ${r0.stderr.slice(0, 80)}`); return; }
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add submodule');
  const before = git(repo, 'ls-tree', 'HEAD', 'deps/dep');
  const w = createWorktree(repo, 'claude');
  assert.ok(fs.existsSync(path.join(w.path, '.gitmodules')), 'worktree carries .gitmodules');
  assert.ok(fs.existsSync(path.join(w.path, 'deps/dep/src/a.js')), 'A2-11: the submodule is checked out, so the worker can build');
  assert.equal(git(w.path, 'status', '--porcelain'), '', 'and the worktree is clean');
  fs.writeFileSync(path.join(w.path, 'src/d.js'), 'export const d = 4;\n');
  const r = mergeWorktree(w.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.ok(git(repo, 'ls-files').split('\n').includes('src/d.js'));
  assert.equal(git(repo, 'ls-tree', 'HEAD', 'deps/dep'), before, 'submodule pointer unchanged');
  const rm = removeWorktree(w.path, { deleteBranch: true });
  assert.equal(rm.ok, true, `a clean worktree with a checked-out submodule is removable: ${rm.message}`);
  assert.equal(fs.existsSync(w.path), false);
});

test('A2-10: a merge into another branch puts the user\'s checkout back on the branch it was on', () => {
  const repo = mkRepo('intoback');
  git(repo, 'branch', 'release');
  const w = createWorktree(repo, 'claude');
  fs.writeFileSync(path.join(w.path, 'src/r.js'), 'export const r = 1;\n');
  const r = mergeWorktree(w.path, { commitFirst: true, into: 'release' });
  assert.equal(r.ok, true, r.message);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the checkout is back on main');
  assert.ok(git(repo, 'ls-tree', '-r', '--name-only', 'release').split('\n').includes('src/r.js'), 'release got the work');
  assert.ok(!git(repo, 'ls-files').split('\n').includes('src/r.js'), 'main did not');
  // a refused merge also leaves the checkout alone
  const w2 = createWorktree(repo, 'claude');
  const bad = mergeWorktree(w2.path, { into: 'no-such-branch' });
  assert.equal(bad.ok, false);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

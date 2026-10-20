import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktree, listWorktrees, mergeWorktree, removeWorktree, mainRoot, isLinkedWorktree, hasCommits, worktreeStatus } from './worktree';

function git(cwd: string, ...args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wt-'));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('worktree: create → edit → merge → remove, isolated from the main checkout', () => {
  const repo = tmpRepo();
  const wtHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wth-'));
  process.env.KORA_WORKTREES = wtHome;
  assert.ok(hasCommits(repo));
  const w = createWorktree(repo, 'claude');
  assert.ok(w.path.startsWith(wtHome)); assert.match(w.branch, /^kora\/claude-/);
  assert.equal(mainRoot(w.path), fs.realpathSync(repo)); assert.ok(isLinkedWorktree(w.path)); assert.ok(!isLinkedWorktree(repo));
  assert.equal(listWorktrees(repo).length, 1);
  // agent edits in its worktree; main is untouched. kora's own rulebook file is not "the agent's work".
  fs.writeFileSync(path.join(w.path, 'b.txt'), 'two\n');
  fs.writeFileSync(path.join(w.path, 'CLAUDE.md'), '<!-- kora:begin -->rules<!-- kora:end -->\n');
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')));
  assert.equal(worktreeStatus(w.path).dirty, 1);
  // merge refuses uncommitted work unless commitFirst
  assert.equal(mergeWorktree(w.path).ok, false);
  const m = mergeWorktree(w.path, { commitFirst: true });
  assert.ok(m.ok, m.message); assert.equal(m.commitsMerged, 1);
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  assert.ok(!fs.existsSync(path.join(repo, 'CLAUDE.md')), 'managed rulebook must not ride along in the merge');
  // conflict path: both sides edit a.txt
  fs.writeFileSync(path.join(w.path, 'a.txt'), 'agent\n'); git(w.path, 'commit', '-qam', 'agent');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'human\n'); git(repo, 'commit', '-qam', 'human');
  const c = mergeWorktree(w.path);
  assert.equal(c.ok, false); assert.deepEqual(c.conflicts, ['a.txt']);
  assert.equal(git(repo, 'status', '--porcelain'), ''); // aborted cleanly
  const r = removeWorktree(w.path, { force: true, deleteBranch: true });
  assert.ok(r.ok, r.message); assert.equal(listWorktrees(repo).length, 0);
});

test('worktree: a repo without commits is refused with a clear message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wt0-')); git(dir, 'init', '-q');
  assert.throws(() => createWorktree(dir, 'claude'), /no commits/);
});

test('a wholly-untracked managed directory (`?? .gemini/`) does not make the checkout dirty', () => {
  const { worktreeStatus } = require('./worktree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-managed-dir-'));
  const g = (a: string[]) => spawnSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(dir, 'README.md'), 'x\n'); g(['add', '-A']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  fs.mkdirSync(path.join(dir, '.gemini')); fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# managed\n');
  assert.equal(worktreeStatus(dir).dirty, 0);
  fs.writeFileSync(path.join(dir, 'user.txt'), 'mine\n');
  assert.equal(worktreeStatus(dir).dirty, 1);
});

test('worktree: installed dependency dirs of the main checkout are linked in, and stay out of the worker commit', () => {
  const repo = tmpRepo();
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wth-'));
  fs.mkdirSync(path.join(repo, 'api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}'); fs.writeFileSync(path.join(repo, 'api/package.json'), '{}');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'pkgs');
  fs.mkdirSync(path.join(repo, 'node_modules/x'), { recursive: true }); fs.mkdirSync(path.join(repo, 'api/node_modules/y'), { recursive: true });
  const w = createWorktree(repo, 'swarm');
  assert.ok(fs.existsSync(path.join(w.path, 'node_modules/x')));
  assert.ok(fs.existsSync(path.join(w.path, 'api/node_modules/y')));
  assert.ok(fs.lstatSync(path.join(w.path, 'api/node_modules')).isSymbolicLink());
  fs.writeFileSync(path.join(w.path, 'api/b.js'), '1\n');
  const m = mergeWorktree(w.path, { commitFirst: true });
  assert.ok(m.ok, m.message);
  assert.equal(git(repo, 'ls-files', 'api').split('\n').sort().join(','), 'api/b.js,api/package.json');
});

test('git operations and gitTopLevel do not spawn git when macOS CLT is missing', () => {
  const { setCltForTests, gitTopLevel } = require('../graph/embedded');
  const repo = tmpRepo();
  try {
    setCltForTests(false);
    if (process.platform === 'darwin') {
      assert.equal(gitTopLevel(repo), repo);
      assert.equal(gitTopLevel(os.tmpdir()), null);
      const r = (require('./worktree') as any).mainRoot(repo);
      assert.equal(r, null);
    }
  } finally {
    setCltForTests(null);
  }
});


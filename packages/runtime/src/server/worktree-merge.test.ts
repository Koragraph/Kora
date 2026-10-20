import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktree, mergeWorktree } from './worktree';

function git(cwd: string, args: string[]) { return spawnSync('git', args, { cwd, encoding: 'utf8' }); }
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wt-'));
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'user.email', 't@t.co']); git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('merge auto-commits the agent work and is NOT blocked by kora managed files in main', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-'));
  const dir = repo();
  const wt = createWorktree(dir, 'claude');
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\ntwo\n'); // agent edit, uncommitted
  // kora setup writes these into the MAIN checkout; they must not block the merge
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'rulebook');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rulebook');
  const r = mergeWorktree(wt.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.into, 'main', 'target branch is named, never null');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n', 'main received the agent edit');
});

test('merge still refuses when the main checkout has a real (non-managed) uncommitted change', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir2-'));
  const dir = repo();
  const wt = createWorktree(dir, 'claude');
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'user-edit.txt'), 'a real edit by the user'); // NOT managed
  const r = mergeWorktree(wt.path, { commitFirst: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /uncommitted change/);
  assert.equal(r.into, 'main', 'even the refusal names the target');
});

test("merge takes kora's own onboarding files back out when a worker's `git add -A` committed them; a user-authored one stays", () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir3-'));
  const dir = repo();
  const wt = createWorktree(dir, 'claude');
  // the enforcer's files, untracked in the worktree — then the worker commits everything, as workers do
  fs.writeFileSync(path.join(wt.path, 'CLAUDE.md'), '<!-- kora:begin -->\nrulebook\n<!-- kora:end -->\n');
  fs.writeFileSync(path.join(wt.path, 'AGENTS.md'), '---\nalwaysApply: true\n---\n\n<!-- kora:begin -->\nrulebook\n<!-- kora:end -->\n');
  fs.writeFileSync(path.join(wt.path, 'GEMINI.md'), '<!-- kora:begin -->\nrulebook\n<!-- kora:end -->\n# Team notes\nkeep this — a human wrote it\n');
  fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'the actual work\n');
  git(wt.path, ['add', '-A']); git(wt.path, ['commit', '-q', '-m', 'work + swept-in onboarding files']);
  const r = mergeWorktree(wt.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /kept kora's own AGENTS\.md, CLAUDE\.md out of main/);
  const tracked = git(dir, ['ls-files']).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.includes('feature.txt'), 'the work landed');
  assert.ok(!tracked.includes('CLAUDE.md') && !tracked.includes('AGENTS.md'), "kora's own files are not tracked on main");
  assert.ok(tracked.includes('GEMINI.md'), 'a file with content outside the kora block is the user\'s and stays');
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')), 'the file stays on disk for the enforcer');
  assert.equal(git(dir, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).filter((l) => !/CLAUDE\.md|AGENTS\.md/.test(l)).length, 0, 'main is otherwise clean');
});

test('merge: generated output (__pycache__, .pyc, node_modules, dist) an agent left behind is never committed as its work', () => {
  const { createWorktree, mergeWorktree, isGeneratedPath } = require('./worktree') as typeof import('./worktree');
  const { spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-gen-')); process.env.KORA_WORKTREES = path.join(home, 'wt');
  const repo = path.join(home, 'app'); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const g = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'src/app.py'), 'def f():\n    return 1\n'); g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
  const a = createWorktree(repo, 'claude'); const b = createWorktree(repo, 'codex');
  for (const w of [a, b]) {
    fs.mkdirSync(path.join(w.path, 'src/__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(w.path, 'src/__pycache__/app.cpython-312.pyc'), Buffer.from([0xa7, 0x0d, w === a ? 1 : 2, 0, 0xff, 0xfe]));
    fs.mkdirSync(path.join(w.path, 'node_modules/x'), { recursive: true }); fs.writeFileSync(path.join(w.path, 'node_modules/x/index.js'), 'junk');
    fs.mkdirSync(path.join(w.path, 'dist'), { recursive: true }); fs.writeFileSync(path.join(w.path, 'dist/bundle.js'), 'built');
    fs.writeFileSync(path.join(w.path, '.DS_Store'), 'x');
  }
  fs.writeFileSync(path.join(a.path, 'src/util.py'), 'def g():\n    return 2\n');
  fs.writeFileSync(path.join(b.path, 'src/other.py'), 'def h():\n    return 3\n');
  const r1 = mergeWorktree(a.path, { commitFirst: true }); assert.equal(r1.ok, true, r1.message);
  const r2 = mergeWorktree(b.path, { commitFirst: true }); assert.equal(r2.ok, true, `second worker with its own .pyc merges cleanly: ${r2.message}`);
  const tracked = g(repo, 'ls-files').split('\n');
  assert.ok(tracked.includes('src/util.py') && tracked.includes('src/other.py'), 'the real work landed');
  assert.ok(!tracked.some((f: string) => /__pycache__|node_modules|^dist\/|\.DS_Store|\.pyc$/.test(f)), `generated output stayed out: ${tracked.join(',')}`);
  assert.equal(isGeneratedPath('src/__pycache__/'), true); assert.equal(isGeneratedPath('lib/output.js'), false); assert.equal(isGeneratedPath('build/'), true); assert.equal(isGeneratedPath('src/builder.ts'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Kora\'s own git ops never run repo hooks (a worker-authored .husky/post-merge must not execute in main)', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-hooks-'));
  const dir = repo();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-hookmark-')), 'ran');
  // A committed hooks dir wired the way husky wires it (core.hooksPath = a path inside the repo).
  fs.mkdirSync(path.join(dir, '.husky'));
  for (const h of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge']) {
    fs.writeFileSync(path.join(dir, '.husky', h), `#!/bin/sh\necho ${h} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  }
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '--no-verify', '-m', 'hooks']); git(dir, ['config', 'core.hooksPath', '.husky']);
  try { fs.rmSync(marker); } catch { /* none yet */ }
  const wt = createWorktree(dir, 'opencode');
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\nworker\n'); // uncommitted worker edit → Kora commits it
  const r = mergeWorktree(wt.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\nworker\n');
  assert.equal(fs.existsSync(marker), false, `a repo hook ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
});

// Swarm QA 2026-10-02 #4: two workers each added an export line at the same spot; kora_merge aborted and the lead
// merged by hand with raw git.
test('two branches that only ADDED lines at the same spot merge by keeping both; an edit conflict still aborts', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-union-'));
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.js'), "export const VERSION = '1';\n"); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'index']);
  const a = createWorktree(dir, 'opencode');
  const b = createWorktree(dir, 'opencode');
  fs.writeFileSync(path.join(a.path, 'index.js'), "export const VERSION = '1';\nexport * from './strings.js';\n");
  fs.writeFileSync(path.join(b.path, 'index.js'), "export const VERSION = '1';\nexport * from './numbers.js';\n");
  assert.equal(mergeWorktree(a.path, { commitFirst: true }).ok, true);
  const r = mergeWorktree(b.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /only added lines .* index\.js/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), "export const VERSION = '1';\nexport * from './strings.js';\nexport * from './numbers.js';\n");
  assert.equal(git(dir, ['status', '--porcelain']).stdout, '', 'committed, clean');
  // both rewrite the same existing line: a real conflict, aborted as before
  const c = createWorktree(dir, 'opencode');
  const d = createWorktree(dir, 'opencode');
  fs.writeFileSync(path.join(c.path, 'index.js'), "export const VERSION = '2';\nexport * from './strings.js';\nexport * from './numbers.js';\n");
  fs.writeFileSync(path.join(d.path, 'index.js'), "export const VERSION = '3';\nexport * from './strings.js';\nexport * from './numbers.js';\n");
  assert.equal(mergeWorktree(c.path, { commitFirst: true }).ok, true);
  const e = mergeWorktree(d.path, { commitFirst: true });
  assert.equal(e.ok, false);
  assert.deepEqual(e.conflicts, ['index.js']);
  assert.equal(git(dir, ['status', '--porcelain']).stdout, '', 'aborted cleanly');
});

test('isPureAdditionConflict', () => {
  const { isPureAdditionConflict } = require('./worktree');
  assert.equal(isPureAdditionConflict('a\n<<<<<<< o\nx\n||||||| b\n=======\ny\n>>>>>>> t\n'), true);
  assert.equal(isPureAdditionConflict('a\n<<<<<<< o\nx\n||||||| b\nold\n=======\ny\n>>>>>>> t\n'), false);
  assert.equal(isPureAdditionConflict('no conflict\n'), false);
});

test('merge refuses a target branch that git would read as an option', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-opt-'));
  const dir = repo();
  const wt = createWorktree(dir, 'claude');
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'one\ntwo\n');
  for (const into of ['--orphan=x', '-b', 'main\nx', '']) {
    const r = mergeWorktree(wt.path, { into, commitFirst: true });
    assert.equal(r.ok, false, `refused: ${JSON.stringify(into)}`);
    assert.equal(r.message, 'invalid target branch');
  }
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main', 'main checkout untouched');
  assert.equal(mergeWorktree(wt.path, { into: 'main', commitFirst: true }).ok, true, 'a real branch still merges');
});

// Deep audit 2026-10-13 A2-4: three workers merged into one checkout at the same moment (separate processes, as the
// daemon's worktreeInChild runs them): two failed "merge aborted: 0 conflict(s)" on git's index.lock.
test('merges into one checkout from several processes at once are serialized: every one lands', async () => {
  const { worktreeInChild } = require('./worktree') as typeof import('./worktree');
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-par-'));
  const dir = repo();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'files']);
  const wts = [0, 1, 2].map((i) => { const w = createWorktree(dir, 'opencode'); fs.writeFileSync(path.join(w.path, `f${i}.txt`), `${i} by worker\n`); return w; });
  const rs = await Promise.all(wts.map((w) => worktreeInChild<ReturnType<typeof mergeWorktree>>('mergeWorktree', [w.path, { commitFirst: true }])));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true], rs.map((r) => r.message).join(' | '));
  for (let i = 0; i < 3; i++) assert.equal(fs.readFileSync(path.join(dir, `f${i}.txt`), 'utf8'), `${i} by worker\n`);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'kora-merge.lock')), false, 'the lock is released');
});

// Deep audit 2026-10-13 A2-5: a worker's slug was re-rolled only when its FOLDER existed; a leftover `kora/<slug>`
// branch (an unmerged worker whose worktree went, or the other Kora flavor's worker) failed `git worktree add -b`.
test('createWorktree never picks a slug whose branch already exists', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-slug-'));
  const dir = repo();
  const ADJ = ['brisk', 'calm', 'bold', 'quiet', 'swift', 'keen', 'warm', 'wry', 'deft', 'lucid', 'nimble', 'steady', 'vivid', 'candid', 'plucky', 'sly'];
  const NOUN = ['otter', 'heron', 'fox', 'lynx', 'finch', 'wren', 'ibex', 'newt', 'crane', 'stoat', 'raven', 'marten', 'plover', 'egret', 'tern', 'vole'];
  for (const a of ADJ) for (const n of NOUN) git(dir, ['branch', `kora/claude-${a}-${n}`]); // every plain slug is taken
  for (let i = 0; i < 3; i++) { const w = createWorktree(dir, 'claude'); assert.ok(fs.existsSync(w.path), w.branch); }
});

// test/fleet 2026-10-14: a lead working in the user's own linked checkout (kora-dev beside kora) got workers branched from
// the MAIN checkout's HEAD, and their merges landed on main.
test('a worker spawned from a linked checkout branches from it and merges back into it, never into the main checkout', () => {
  const { prepareAgentWorktree, mergeTarget, isAgentWorktree } = require('./worktree') as typeof import('./worktree');
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-linked-'));
  const dir = repo();
  const dev = `${dir}-dev`;
  git(dir, ['worktree', 'add', '-q', '-b', 'dev', dev, 'main']);
  fs.mkdirSync(path.join(dev, 'sub')); fs.writeFileSync(path.join(dev, 'sub', 'dev.txt'), 'dev only\n');
  git(dev, ['add', '-A']); git(dev, ['commit', '-q', '-m', 'dev work']);
  assert.equal(isAgentWorktree(dev), false, "the user's checkout is not an agent worktree");
  const p = prepareAgentWorktree(path.join(dev, 'sub'), 'claude')!;
  assert.equal(fs.realpathSync(p.worktree.mainRoot), fs.realpathSync(dev));
  assert.equal(p.cwd, path.join(p.worktree.path, 'sub'), 'the sub-directory carries over');
  assert.ok(fs.existsSync(path.join(p.worktree.path, 'sub', 'dev.txt')), 'branched from dev, not main');
  assert.equal(isAgentWorktree(p.worktree.path), true);
  assert.equal(fs.realpathSync(mergeTarget(p.worktree.path)!), fs.realpathSync(dev));
  fs.writeFileSync(path.join(p.worktree.path, 'w.txt'), 'worker\n');
  const before = git(dir, ['rev-parse', 'main']).stdout.trim();
  const r = mergeWorktree(p.worktree.path, { commitFirst: true });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.into, 'dev');
  assert.equal(fs.readFileSync(path.join(dev, 'w.txt'), 'utf8'), 'worker\n');
  assert.equal(git(dir, ['rev-parse', 'main']).stdout.trim(), before, 'main untouched');
  assert.equal(fs.existsSync(path.join(dir, 'w.txt')), false);
});

test('a worker spawned from the main checkout still merges into it', () => {
  const { prepareAgentWorktree, mergeTarget } = require('./worktree') as typeof import('./worktree');
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-main-'));
  const dir = repo();
  git(dir, ['worktree', 'add', '-q', '-b', 'dev', `${dir}-dev`, 'main']);
  const p = prepareAgentWorktree(dir, 'claude')!;
  assert.equal(fs.realpathSync(mergeTarget(p.worktree.path)!), fs.realpathSync(dir));
  fs.writeFileSync(path.join(p.worktree.path, 'w.txt'), 'worker\n');
  assert.equal(mergeWorktree(p.worktree.path, { commitFirst: true }).into, 'main');
  assert.ok(fs.existsSync(path.join(dir, 'w.txt')));
});

test('merge: a worker that committed its work and left only generated output / a nested repo is mergeable (audit fleet #3)', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-gen-'));
  const { worktreeStatus } = require('./worktree') as typeof import('./worktree');
  for (const commitFirst of [true, false]) {
    const dir = repo();
    const wt = createWorktree(dir, 'claude');
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'work\n');
    git(wt.path, ['add', '-A']); git(wt.path, ['commit', '-q', '-m', 'work']);
    fs.mkdirSync(path.join(wt.path, '__pycache__')); fs.writeFileSync(path.join(wt.path, '__pycache__/x.pyc'), 'x');
    fs.writeFileSync(path.join(wt.path, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(wt.path, 'vendor/lib'), { recursive: true }); git(path.join(wt.path, 'vendor/lib'), ['init', '-q']);
    assert.equal(worktreeStatus(wt.path).dirty, 0, 'leftovers are not the agent\'s dirty work');
    const r = mergeWorktree(wt.path, { commitFirst });
    assert.equal(r.ok, true, `commitFirst=${commitFirst}: ${r.message}`);
    assert.equal(r.commitsMerged, 1);
    assert.ok(fs.existsSync(path.join(dir, 'feature.txt')));
  }
  // A new source folder is still dirty work.
  const dir = repo(); const wt = createWorktree(dir, 'claude');
  fs.mkdirSync(path.join(wt.path, 'src')); fs.writeFileSync(path.join(wt.path, 'src/new.ts'), 'x');
  assert.equal(worktreeStatus(wt.path).dirty, 1);
});

test('merge refuses on top of a merge left half-done in the main checkout (MERGE_HEAD) (audit fleet #4)', () => {
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-mh-'));
  const dir = repo();
  const wt = createWorktree(dir, 'claude');
  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'b\n');
  git(wt.path, ['add', '-A']); git(wt.path, ['commit', '-q', '-m', 'b']);
  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), head + '\n');
  const r = mergeWorktree(wt.path, { commitFirst: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /merge is already in progress/);
});

test('the merge child budget covers the lock wait; the remote merge RPC outlasts the child (audit fleet #4, #11)', async () => {
  const wt = require('./worktree') as typeof import('./worktree');
  assert.ok(wt.MERGE_CHILD_TIMEOUT_MS >= wt.MERGE_LOCK_WAIT_MS + 120_000);
  const { MERGE_RPC_TIMEOUT_MS } = await import('./fleet-ops');
  assert.ok(MERGE_RPC_TIMEOUT_MS > wt.MERGE_CHILD_TIMEOUT_MS + 15_000);
});

// Review 2026-10-15 fleet #3: a merge child killed on its timeout must say what it left in the user's checkout.
test('a timed-out merge child names a leftover index.lock / MERGE_HEAD and the fix', async () => {
  const { worktreeInChild, leftoverGitState } = require('./worktree') as typeof import('./worktree');
  process.env.KORA_WORKTREES = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-wtdir-kill-'));
  const dir = repo();
  const w = createWorktree(dir, 'claude');
  assert.deepEqual(leftoverGitState(dir), []);
  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), head + '\n');
  const left = leftoverGitState(dir);
  assert.deepEqual(left.map((l) => path.basename(l.file)), ['index.lock', 'MERGE_HEAD']);
  assert.match(left[1].fix, /merge --abort/);
  await assert.rejects(worktreeInChild('mergeWorktree', [w.path, {}], 1), (e: Error) => /timed out/.test(e.message) && /index\.lock/.test(e.message) && /merge --abort/.test(e.message));
});

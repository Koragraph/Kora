import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorktree, sweepWorktrees, listWorktrees } from './worktree';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-sweep-'));
process.env.KORA_WORKTREES = path.join(home, 'wt');
function git(cwd: string, ...args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function mkRepo(name: string): string {
  const repo = path.join(home, name); fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('sweep: clean+unowned removed, dirty kept, ahead kept, busy untouched, dead parent parked; idempotent', () => {
  const repo = mkRepo('app');
  const clean = createWorktree(repo, 'claude');
  fs.writeFileSync(path.join(clean.path, 'CLAUDE.md'), 'managed\n'); // kora's own file: not dirt
  const dirty = createWorktree(repo, 'codex'); fs.writeFileSync(path.join(dirty.path, 'work.txt'), 'uncommitted\n');
  const ahead = createWorktree(repo, 'gemini'); fs.writeFileSync(path.join(ahead.path, 'b.txt'), 'x\n'); git(ahead.path, 'add', '.'); git(ahead.path, 'commit', '-q', '-m', 'work');
  const busy = createWorktree(repo, 'claude');
  const dead = mkRepo('gone'); const deadWt = createWorktree(dead, 'claude'); fs.rmSync(dead, { recursive: true, force: true });
  assert.equal(fs.readdirSync(path.join(home, 'wt', 'app')).length, 4);

  const dry = sweepWorktrees({ live: [busy.path], dryRun: true });
  assert.equal(dry.scanned, 5); assert.deepEqual(dry.removed, [clean.path]); assert.deepEqual(dry.busy, [busy.path]); assert.deepEqual(dry.parked, [deadWt.path]);
  assert.ok(fs.existsSync(clean.path) && fs.existsSync(deadWt.path), 'dry run touches nothing');

  const r = sweepWorktrees({ live: [busy.path] });
  assert.deepEqual(r.removed, [clean.path]);
  assert.ok(!fs.existsSync(clean.path), 'clean worktree gone');
  assert.ok(!git(repo, 'branch', '--list', clean.branch), 'its branch gone too');
  assert.deepEqual(r.orphans.map((o) => o.path).sort(), [dirty.path, ahead.path].sort());
  assert.ok(fs.existsSync(dirty.path) && fs.existsSync(ahead.path), 'dirty and ahead kept');
  assert.equal(r.orphans.find((o) => o.path === dirty.path)!.dirty, 1);
  assert.equal(r.orphans.find((o) => o.path === ahead.path)!.ahead, 1);
  assert.deepEqual(r.busy, [busy.path]); assert.ok(fs.existsSync(busy.path));
  assert.deepEqual(r.parked, [deadWt.path]); assert.ok(!fs.existsSync(deadWt.path));
  assert.equal(fs.readdirSync(path.join(home, 'wt', '.orphaned')).length, 1, 'parked, not deleted');
  assert.equal(listWorktrees(repo).length, 3);
  assert.deepEqual(r.errors, []);

  const again = sweepWorktrees({ live: [busy.path] });
  assert.deepEqual({ removed: again.removed, parked: again.parked, errors: again.errors }, { removed: [], parked: [], errors: [] }, 'idempotent');
  assert.equal(again.orphans.length, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('sweep: leftover agent branches — merged ones deleted, unmerged kept, checked-out ones untouched; reclaimed bytes counted', () => {
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-sweepb-'));
  const prev = process.env.KORA_WORKTREES; process.env.KORA_WORKTREES = path.join(h2, 'wt');
  try {
    const repo = path.join(h2, 'r'); fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'branch', 'worktree-agent-merged'); git(repo, 'branch', 'kora/merged-too'); git(repo, 'branch', 'feature-user'); // user branch: never ours
    git(repo, 'checkout', '-q', '-b', 'worktree-agent-unmerged'); fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'w'); git(repo, 'checkout', '-q', 'main');
    const clean = createWorktree(repo, 'claude'); fs.writeFileSync(path.join(clean.path, 'big.bin'), Buffer.alloc(64 * 1024)); git(clean.path, 'add', '.'); git(clean.path, 'commit', '-q', '-m', 'x'); git(clean.path, 'reset', '-q', '--hard', 'main');
    const busy = createWorktree(repo, 'codex'); // its branch is checked out: untouched even though merged

    const dry = sweepWorktrees({ live: [busy.path], dryRun: true, repos: [repo] });
    assert.deepEqual(dry.branchesDeleted.sort(), ['r:kora/merged-too', 'r:worktree-agent-merged']);
    assert.ok(git(repo, 'branch', '--list', 'worktree-agent-merged'), 'dry run deletes nothing');

    const r = sweepWorktrees({ live: [busy.path], repos: [repo] });
    assert.deepEqual(r.removed, [clean.path]);
    assert.ok(r.reclaimedBytes > 0, `reclaimed ${r.reclaimedBytes}`);
    // the clean worktree's own branch goes with it (removeWorktree), the leftovers by the branch pass
    assert.deepEqual(r.branchesDeleted.sort(), ['r:kora/merged-too', 'r:worktree-agent-merged']);
    assert.deepEqual(r.branchesKept.map((b) => [b.branch, b.ahead]), [['worktree-agent-unmerged', 1]]);
    const left = git(repo, 'branch', '--format=%(refname:short)').split('\n').sort();
    assert.deepEqual(left, [busy.branch, 'feature-user', 'main', 'worktree-agent-unmerged'].sort());
    assert.deepEqual(r.errors, []);
  } finally {
    if (prev === undefined) delete process.env.KORA_WORKTREES; else process.env.KORA_WORKTREES = prev;
    fs.rmSync(h2, { recursive: true, force: true });
  }
});

test('sweep: minAgeMs keeps a fresh worktree', () => {
  const h3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-sweepa-'));
  const prev = process.env.KORA_WORKTREES; process.env.KORA_WORKTREES = path.join(h3, 'wt');
  try {
    const repo = path.join(h3, 'r'); fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const w = createWorktree(repo, 'opencode');
    const r1 = sweepWorktrees({ minAgeMs: 60 * 60_000 });
    assert.deepEqual(r1.busy, [w.path], 'fresh: busy'); assert.ok(fs.existsSync(w.path));
    const r2 = sweepWorktrees({ minAgeMs: 1 });
    assert.deepEqual(r2.removed, [w.path], 'old enough and clean: removed');
  } finally {
    if (prev === undefined) delete process.env.KORA_WORKTREES; else process.env.KORA_WORKTREES = prev;
    fs.rmSync(h3, { recursive: true, force: true });
  }
});

test('daemon start-up sweep: runs with STARTUP_SWEEP_MIN_AGE_MS, so a swarm worktree created just before (pane not live yet) survives', async () => {
  const { scheduleWorktreeSweeps, STARTUP_SWEEP_MIN_AGE_MS } = require('./daemon') as typeof import('./daemon');
  assert.ok(STARTUP_SWEEP_MIN_AGE_MS >= 60_000, 'a minute at least');
  const h4 = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-sweeps-'));
  const prev = process.env.KORA_WORKTREES; process.env.KORA_WORKTREES = path.join(h4, 'wt');
  try {
    const repo = path.join(h4, 'r'); fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
    const fresh = createWorktree(repo, 'koragent'); // a swarm spawn's worktree, clean, no live pane yet
    const calls: { repos: string[]; minAgeMs: number }[] = [];
    const stop = scheduleWorktreeSweeps(async (p) => { calls.push(p); return sweepWorktrees({ repos: p.repos, minAgeMs: p.minAgeMs }); }, () => [repo], { delayMs: 5, everyMs: 60 * 60_000 });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].minAgeMs, STARTUP_SWEEP_MIN_AGE_MS);
    assert.ok(fs.existsSync(fresh.path), 'the fresh worktree survived the start-up sweep');
  } finally {
    if (prev === undefined) delete process.env.KORA_WORKTREES; else process.env.KORA_WORKTREES = prev;
    fs.rmSync(h4, { recursive: true, force: true });
  }
});

test('A2-13: parked worktrees are listed with their age and removed only by an explicit purge', async () => {
  const { listOrphaned, purgeOrphaned } = await import('./worktree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-orph-'));
  try {
    const old = path.join(dir, '.orphaned', 'repo-a-1'), fresh = path.join(dir, '.orphaned', 'repo-b-2');
    for (const d of [old, fresh]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'work.txt'), 'x'); }
    const t = new Date(Date.now() - 40 * 86_400_000); fs.utimesSync(old, t, t);
    const l = listOrphaned(dir);
    assert.deepEqual(l.map((o) => o.name), ['repo-a-1', 'repo-b-2']);
    assert.equal(l[0]!.ageDays >= 40, true);
    assert.deepEqual(purgeOrphaned({ dir, olderThanDays: 30 }), [old], 'only the old one');
    assert.equal(fs.existsSync(fresh), true);
    assert.deepEqual(purgeOrphaned({ dir, names: ['nope'] }), []);
    assert.equal(sweepWorktrees({ dir, dryRun: true }).parkedHeld?.length, 1, 'a sweep reports what is held');
    assert.equal(fs.existsSync(fresh), true, 'a sweep never deletes it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

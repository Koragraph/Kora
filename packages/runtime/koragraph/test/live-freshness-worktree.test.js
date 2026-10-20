'use strict';

// The worktree write-guard (repo-identity.js#isLinkedWorktree + live-freshness.js#branchRowFor).
//
// A linked worktree shares the MAIN checkout's index and resolves to the main branch row BY NAME.
// Before the guard, a graph query from a worktree ran the freshness write path and re-ingested THIS
// worktree's edits into the shared main index — corrupting what the main checkout and sibling
// worktrees read, and advancing the main branch's recorded SHA to the worktree's HEAD. The overlay
// (kora worktree-overlay) surfaces worktree divergence read-side; the write path must stay out.
//
// This is a REAL test against a REAL store: it runs `koragraph ingest` on a fixture repo, then drives
// the actual ensureFilesFresh path — the same operation from a worktree vs the main checkout — and
// reads the store back. The A/B is the whole point: identical edit + identical call, only the cwd
// differs; the worktree must write nothing, the main checkout must write.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

// Store lives under a throwaway KORAGRAPH_HOME — set BEFORE any package internal is required so
// pool.js / resolve.js open the temp graph.db, never the developer's real ~/.koragraph store.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-wt-guard-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME;
delete process.env.KORAGRAPH_DB; // HOME/graph.db, not a stray override

const MAIN = path.join(TMP, 'app');
const REL = 'src/target.js';
const sha40 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 40);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });

// The single tracked file the A/B mutates, plus a caller so it is a real graph node with an edge.
const V0 = 'export function target(x) {\n  return x + 1;\n}\n';
const V_WT = 'export function target(x) {\n  return x + 999; // edited only in the worktree\n}\n';
const V_MAIN = 'export function target(x) {\n  return x + 7; // edited in the main checkout\n}\n';

let fresh; let pool; let wt;

async function storedSha(cwd, rel) {
  // Resolve the branch the same way the code does, then read the file row that branch tracks.
  const { repoIdentity } = require('../src/practice/repo-identity');
  const { openGraphDb, resolveBranch } = require('../src/practice/resolve');
  const id = repoIdentity(cwd);
  const gdb = openGraphDb();
  try {
    const m = resolveBranch(gdb, { repoId: id.repoId, repoName: id.repoName, repoRoot: id.repoRoot });
    if (!m) return { branchId: null, fileSha: null, commitSha: null };
    const b = gdb.prepare('SELECT last_commit_sha FROM repository_branches WHERE id = ?').get(m.branchId);
    const f = gdb.prepare('SELECT file_sha FROM files WHERE repository_branch_id = ? AND path = ?').get(m.branchId, rel);
    return { branchId: m.branchId, fileSha: f ? f.file_sha : null, commitSha: b ? b.last_commit_sha : null };
  } finally {
    try { gdb.close(); } catch { /* already gone */ }
  }
}

test.before(async () => {
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, REL), V0);
  fs.writeFileSync(path.join(MAIN, 'src/caller.js'), "import { target } from './target.js';\nexport const run = () => target(1);\n");
  git(MAIN, 'init', '-q');
  // A SHARED ORIGIN REMOTE is what makes the bug bite: with one, a worktree's identity comes from the
  // remote (shared via the common .git/config), so it resolves to the MAIN branch row by name/identity
  // — the pollution condition. Without a remote, identity falls back to the checkout's own dir basename
  // (which differs per worktree) and nothing matches, masking the bug. Every real repo (meridian
  // included) has an origin, so the fixture must too or the guard would be tested against a no-op.
  git(MAIN, 'remote', 'add', 'origin', 'https://github.com/test/app.git');
  git(MAIN, 'add', '-A');
  git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial');

  execFileSync('node', [CLI, 'ingest', MAIN], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });

  // A linked worktree on its own branch, forked from main's HEAD — the exact shape `kora agent
  // spawn` creates, and the shape the guard must refuse to write from.
  wt = path.join(TMP, 'wt-feature');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feature', wt, 'HEAD');

  fresh = require('../src/services/live-freshness');
  pool = require('../src/db/pool');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('isLinkedWorktree distinguishes a worktree from the main checkout', () => {
  const { isLinkedWorktree } = require('../src/practice/repo-identity');
  assert.equal(isLinkedWorktree(MAIN), false, 'main checkout (.git is a directory) is not a worktree');
  assert.equal(isLinkedWorktree(wt), true, 'linked worktree (.git file → gitdir under /worktrees/) is a worktree');
  assert.equal(isLinkedWorktree(TMP), false, 'a plain non-git directory is not a worktree');
});

test('a query from a WORKTREE writes nothing to the shared main index (the guard)', async () => {
  const before = await storedSha(MAIN, REL);
  assert.ok(before.fileSha, 'precondition: the file is tracked in the store after ingest');
  assert.notEqual(before.fileSha, sha40(V_WT), 'precondition: worktree edit differs from indexed content');
  // The pollution CONDITION must actually hold, or a no-write proves nothing: confirm the worktree
  // resolves to the SAME branch row as the main checkout (shared origin identity → matched by name).
  const wtResolve = await storedSha(wt, REL);
  assert.equal(wtResolve.branchId, before.branchId, 'precondition: the worktree resolves to the MAIN branch row (pollution would target it)');
  assert.ok(before.branchId, 'precondition: a real branch row exists');

  // Edit the tracked file ONLY in the worktree, then run the exact freshness call a worktree graph
  // query triggers. Pre-guard this re-ingested V_WT into the main branch row.
  fs.writeFileSync(path.join(wt, REL), V_WT);
  fresh.resetFreshnessCache();
  await fresh.ensureFilesFresh({ cwd: wt, files: [REL] });

  const after = await storedSha(MAIN, REL);
  assert.equal(after.fileSha, before.fileSha, 'the shared main index file_sha is UNCHANGED by a worktree query');
  assert.equal(after.commitSha, before.commitSha, 'the main branch recorded SHA is UNCHANGED by a worktree query');
});

test('control: the same query from the MAIN checkout DOES write (guard is worktree-specific, not a blanket disable)', async () => {
  const before = await storedSha(MAIN, REL);
  // Edit the tracked file in the main checkout and run the identical call. This must catch up.
  fs.writeFileSync(path.join(MAIN, REL), V_MAIN);
  fresh.resetFreshnessCache();
  await fresh.ensureFilesFresh({ cwd: MAIN, files: [REL] });

  const after = await storedSha(MAIN, REL);
  assert.notEqual(after.fileSha, before.fileSha, 'the main-checkout edit was caught up into the store');
  assert.equal(after.fileSha, sha40(V_MAIN), 'the store now holds the main checkout content hash');
});

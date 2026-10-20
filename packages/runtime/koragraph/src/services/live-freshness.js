'use strict';

// Keeps a tool ANSWER current with the working tree, without the developer having to remember a
// separate `--watch` process or a manual re-ingest. The read path itself checks, and catches up
// only what is actually dirty, right before answering — so the cost is paid exactly once per real
// edit, exactly when something is asked about it, never on an idle background clock.
//
// Two granularities, chosen by what the caller already knows:
//   - ensureFilesFresh: the caller named specific file(s) (file_symbols' `path`, blast_radius's
//     `files_changed`, a resolved symbol's own file). Cheapest possible check — one stat + one
//     hash per file, compared against the `files` rows the graph already tracks them under. No
//     git, no subprocess. Several files check and catch up together in ONE ingest call, not one
//     per file.
//   - ensureRepoFresh: the caller has no file to scope to at all (explore's query-driven search,
//     search_code, recall/neighbours with no `file`, overview). Falls back to the same
//     `git status`-based dirty set `--watch` already uses (repo-watcher.js), scoped to whatever
//     that reveals.
//
// Both funnel into the exact same `runIncrementalIngest` the CLI and `--watch` already use — this
// is a new TRIGGER, not a new ingest mechanism. Never throws: a freshness probe that can fail a
// tool call is worse than one that occasionally answers one edit late.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pool = require('../db/pool');

// A burst of tool calls in the same few seconds (an agent calling explore three times in a row
// while reasoning about one function) should not each re-stat/re-hash/re-query the same file or
// re-run `git status` on the same repo. Short TTL, not a cache of the ANSWER — only of "did we
// already just check this."
const TTL_MS = Number(process.env.KORAGRAPH_FRESHNESS_TTL_MS) > 0
  ? Number(process.env.KORAGRAPH_FRESHNESS_TTL_MS)
  : 1500;

const fileChecked = new Map(); // cache key -> { at, promise }
const repoChecked = new Map(); // cwd -> { at, promise }

function cacheGuard(map, key, ttl, fn) {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.promise;
  const promise = fn().catch(() => null);
  map.set(key, { at: now, promise });
  return promise;
}

// Same four-way match (root/identity/web_url/name) resolve.js#resolveBranch already implements
// and tests for the practice layer — reused as-is via a short-lived read-only handle, rather than
// re-deriving repo/branch identity a second, possibly-diverging way. `repoRoot` comes from
// repoIdentity(cwd) (a pure filesystem/git operation), not the graph's own `full_path` column,
// which the ingest path can store as a bare repo NAME rather than a real directory — see
// checkoutRoot's own comment in resolve.js.
function branchRowFor(cwd) {
  const { repoIdentity, isLinkedWorktree } = require('../practice/repo-identity');
  const { openGraphDb, resolveBranch } = require('../practice/resolve');
  const identity = repoIdentity(cwd);
  if (!identity.repoRoot) return null;
  // A linked worktree shares the main checkout's index but is on its own branch. resolveBranch below
  // matches it to the MAIN branch row by name, so catching up here would re-ingest THIS worktree's
  // branch into the shared main index and stamp the main branch's recorded SHA to this worktree's
  // HEAD — corrupting what the main checkout and every sibling worktree read. Worktree divergence is
  // surfaced read-side instead, by the overlay (kora worktree-overlay), which stores nothing. The
  // write path must stay out. (Main checkout: `.git` is a directory → not a worktree → unaffected.)
  if (isLinkedWorktree(identity.repoRoot)) return null;
  let graphDb;
  try {
    graphDb = openGraphDb();
  } catch {
    return null; // no graph.db yet — nothing to freshen
  }
  try {
    const match = resolveBranch(graphDb, {
      repoId: identity.repoId, repoName: identity.repoName, repoRoot: identity.repoRoot,
    });
    if (!match) return null;
    // resolveBranch falls back to identity / name, and two different checkouts can share both (`local:app`). Freshening
    // THIS checkout's files into a row that was indexed from another live folder would write one repo's code into the
    // other's index. Only a row that is this checkout (or whose folder is gone: a moved repo) may be caught up.
    if (require('./repo-name').sameCheckout(match.repoRoot, identity.repoRoot) === false) return null;
    // The graph's last-indexed commit for this branch. ensureRepoFresh needs it to fold in files a
    // PRIOR session committed (HEAD moved past this SHA) — `git status` alone only reports the
    // working tree, so a committed-and-untouched change would otherwise never be caught on read.
    const shaRow = graphDb.prepare('SELECT last_commit_sha FROM repository_branches WHERE id = ?').get(match.branchId);
    return {
      repoPath: identity.repoRoot,
      projectId: null, // resolved from the repository row on first use — see projectIdFor
      repoId: match.repositoryId,
      branchId: match.branchId,
      branchName: match.branchName,
      recordedSha: shaRow ? shaRow.last_commit_sha : null,
    };
  } finally {
    try { graphDb.close(); } catch { /* already gone */ }
  }
}

async function projectIdFor(repositoryId) {
  const { rows } = await pool.query('SELECT project_id FROM repositories WHERE id = $1', [repositoryId]);
  return rows[0] ? rows[0].project_id : null;
}

function hashOf(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  // Matches ingest-file-processor.js's own fileSha computation exactly (sha256 of the raw utf8
  // content, first 40 hex chars) — a mismatched algorithm here would make every file look dirty
  // on every call, which is a correctness-neutral but very expensive bug (a false "dirty" still
  // pays the full unscoped tail on this incremental run, since nothing was actually touched to
  // scope resolveCallExpressionEdges against).
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
}

// `newCommitSha` advances the branch's recorded SHA to the caught-up HEAD. ensureRepoFresh passes
// it (its change set is the full commit-diff, so recording HEAD is correct and stops every later
// read re-diffing the same range); ensureFilesFresh must NOT — its set is only the named files, so
// claiming the branch is at HEAD would skip every other file the same commit touched.
async function runCatchUp(branchRow, changedPaths, removedPaths, newCommitSha = null, signalPaths = []) {
  // The handed record (freshness_handed) says "the graph holds this content" — written only AFTER the run that
  // extracted it succeeded. Recorded up front, a catch-up that never ran (one already in flight), failed, or timed out
  // on the lock left the file marked handed, and every later read skipped it while the graph held the old content.
  // Hashed now, before extraction: an edit landing mid-run is recorded at the old content and picked up next read.
  let handed = [...changedPaths, ...signalPaths].map((p) => [p, hashSafe(path.join(branchRow.repoPath, p))]);
  // A file whose grammar aborts a process without node --liftoff-only (Swift; see ast-extractor.js) is caught up by the
  // detached child, which runs with the flag. Extracted here it would be stored with no declarations at its current
  // content, and the content compare would then never look at it again. (kora patch, PATCHES.md)
  try {
    const { needsLiftoffOnly } = require('./ast-extractor');
    const deferred = changedPaths.filter(needsLiftoffOnly);
    if (deferred.length) {
      if (!inflightCatchUp.has(branchRow.branchId)) spawnCatchUp(branchRow, deferred, [], null); // the child records its own
      changedPaths = changedPaths.filter((p) => !deferred.includes(p));
      handed = handed.filter(([p]) => !deferred.includes(p));
      if (!changedPaths.length && !removedPaths.length && !signalPaths.length && !newCommitSha) return true;
    }
  } catch { /* extractor unavailable: catch up as before */ }
  const { runIncrementalIngest } = require('./ingest');
  const { openJob, closeJob } = require('../cli/ingest');
  const { acquire } = require('./ingest-lock');
  // One run per repo at a time (see ingest-lock.js): a concurrent run's generation flip drops this one's edges.
  const lock = await acquire(branchRow.repoPath);
  if (!lock) return false; // another run held the store for 10 min — leave it to them (nothing recorded: retried next read)
  let ok = false;
  try { ok = await runCatchUpLocked(branchRow, changedPaths, removedPaths, newCommitSha, { runIncrementalIngest, openJob, closeJob, signalPaths }); }
  finally { lock.release(); }
  if (ok) rememberHanded(branchRow.branchId, handed);
  return ok;
}
async function runCatchUpLocked(branchRow, changedPaths, removedPaths, newCommitSha, { runIncrementalIngest, openJob, closeJob, signalPaths = [] }) {
  const projectId = branchRow.projectId ?? await projectIdFor(branchRow.repoId);
  const jobId = await openJob(pool, {
    projectId, repoPath: branchRow.repoPath, branchName: branchRow.branchName,
    stack: null, jobType: 'INCREMENTAL',
  });
  try {
    const res = await runIncrementalIngest({
      repoPath: branchRow.repoPath, projectId, repoId: branchRow.repoId,
      branchId: branchRow.branchId, branchName: branchRow.branchName,
      changedPaths, removedPaths, newCommitSha, jobId, signalPaths,
    });
    await closeJob(pool, jobId, {
      status: res.errors > 0 ? 'DEGRADED' : 'COMPLETE',
      files_done: res.done || 0, files_total: (res.done || 0) + (res.skipped || 0),
      nodes_written: res.nodes || 0,
    });
  } catch (err) {
    await closeJob(pool, jobId, { status: 'FAILED', error_msg: String(err.message || err).slice(0, 2000) })
      .catch(() => {});
    return false; // the graph didn't move — nothing for revalidation to check against yet
  }
  revalidatePractice();
  try { await require('../db/maintenance').afterIncrementalIngest(pool); } catch { /* best effort */ }
  return true;
}

// The graph catching up is only half the freshness story — a fact/open-loop anchored to code
// that just changed still needs its own check against the NEW body (unconfirmed_since, a
// rename/move follow, an orphan expiry). `koragraph ingest` already runs this right after every
// ingest (cli/ingest.js); this is the same pairing, just on the reactive per-query trigger
// instead of only a manual/CLI ingest. Best-effort and silent: this fires on the read path behind
// a tool call already in flight, and a revalidation hiccup must never surface as a tool error.
// Sync (better-sqlite3), same as the CLI path — practice.db is small (facts, not graph nodes), so
// this is cheap relative to the ingest tail it rides behind. Deliberately skips the CLI's
// ops_runs audit-log row: that is for a deliberate `koragraph ingest`/`revalidate` invocation, and
// this can fire many times per session — logging every one would make the audit trail noise, not
// signal, without changing what the developer can actually do about it.
function revalidatePractice() {
  let practice;
  let graph;
  try {
    practice = require('../practice/db').openPracticeDb();
    const liveFacts = practice.prepare('SELECT count(*) c FROM facts WHERE expired_at IS NULL').get().c;
    if (!liveFacts) return;
    graph = require('../practice/resolve').openGraphDb();
    require('../practice/revalidate').revalidate(practice, graph);
    try { require('../practice/loop-anchors').revalidateLoopAnchors(practice, graph); } catch { /* best-effort */ }
  } catch {
    // No practice.db yet, a locked file, a mid-migration store — say nothing, try again next call.
  } finally {
    if (graph) { try { graph.close(); } catch { /* already gone */ } }
    if (practice) { try { practice.close(); } catch { /* already gone */ } }
  }
}

// `file` is repo-relative, the same form every tool already carries (files.path). Convenience
// single-file wrapper over the plural form below.
async function ensureFileFresh({ cwd = process.cwd(), file } = {}) {
  if (!file) return;
  return ensureFilesFresh({ cwd, files: [file] });
}

// blast_radius's files_changed is an array — checking and, if needed, catching up each file with
// its own separate ingest call would pay the whole-branch tail cost once PER file instead of once
// for the batch. One dirty set computed for all of them, one catch-up call for whichever are
// actually dirty.
async function ensureFilesFresh({ cwd = process.cwd(), files = [] } = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return;
  const key = `${cwd} ${list.slice().sort().join(',')}`;
  return cacheGuard(fileChecked, key, TTL_MS, async () => {
    const branchRow = branchRowFor(cwd);
    if (!branchRow) return;

    const relPaths = [];
    for (const file of list) {
      const relPath = path.isAbsolute(file) ? path.relative(branchRow.repoPath, file) : file.replace(/^\.\//, '');
      if (!relPath.startsWith('..')) relPaths.push(relPath); // outside this checkout: not ours to freshen
    }
    if (!relPaths.length) return;

    const { rows } = await pool.query(
      `SELECT path, file_sha FROM files
        WHERE repository_branch_id = $1 AND index_status != 'REMOVED'
          AND path IN (SELECT value FROM json_each($2))`,
      [branchRow.branchId, relPaths],
    );
    const storedByPath = new Map(rows.map((r) => [r.path, r.file_sha]));

    const changed = [];
    const removed = [];
    for (const relPath of relPaths) {
      const absPath = path.join(branchRow.repoPath, relPath);
      const onDisk = fs.existsSync(absPath);
      const stored = storedByPath.get(relPath);
      if (!onDisk) {
        if (stored !== undefined) removed.push(relPath); // deleted since last look
        continue;
      }
      if (stored === undefined) { changed.push(relPath); continue; } // new file, never seen
      let currentSha;
      try { currentSha = hashOf(absPath); } catch { continue; } // unreadable — leave it, not our call
      if (currentSha !== stored) changed.push(relPath);
    }
    // runCatchUp remembers what it caught up from the WORKING TREE (once it succeeded): if the edit is later reverted
    // (checkout -- / stash), git status goes quiet and only that record says the graph holds the uncommitted version.
    if (changed.length || removed.length) await runCatchUp(branchRow, changed, removed);
  });
}

// No single file to scope to — the same working-tree dirty set `--watch` computes
// (repo-watcher.js), applied once instead of polled.
async function ensureRepoFresh({ cwd = process.cwd() } = {}) {
  return cacheGuard(repoChecked, cwd, TTL_MS, async () => {
    const branchRow = branchRowFor(cwd);
    if (!branchRow) return;
    // computeChangesAsync, not computeChanges: it folds the commit-diff (recordedSha..HEAD) into the
    // working-tree set, so a change a prior session COMMITTED and never re-touched is caught here on
    // the next repo-scoped read — not left lagging until a manual `koragraph ingest`. Paid once per
    // new commit: runCatchUp advances the recorded SHA to HEAD, after which this is a working-tree-
    // only no-op again.
    const { computeChangesAsync } = require('./repo-watcher');
    let changes;
    try { changes = await computeChangesAsync(branchRow.repoPath, branchRow.recordedSha); } catch { return; } // not a git repo, or git unavailable
    // An uncommitted edit the graph caught up, then reverted (`git checkout -- f`, `git stash`): git status no longer
    // lists the file, so the dirty set alone never looks at it again and its declarations stayed in the graph for good
    // (measured: a stashed function kept answering search_code; `ingest` said "unchanged"). The handed record names
    // every path ever caught up from the working tree; those that are clean again are compared with the store.
    const reverted = revertedHanded(branchRow, new Set([...changes.changed, ...changes.removed]));
    if (!changes.changed.length && !changes.removed.length && !reverted.changed.length && !reverted.removed.length) return;
    // `git status` lists a dirty file on EVERY call for as long as it stays uncommitted — but the graph only needs
    // to catch up when the CONTENT differs from what it last extracted. Without this compare, a repo with a
    // handful of uncommitted files paid a full incremental run (and its unscoped edge-resolution tail) on every
    // graph call more than TTL_MS apart: measured 17–25 s per `explore` with 10 dirty files, vs 0.3 s warm.
    // Same sha rule as ensureFilesFresh; plus a per-process memo of what was already handed to a catch-up at
    // this content, so a dirty file the ingest does not store (nothing extractable) is not resubmitted forever.
    const dirty = await dirtyByContent(branchRow, changes.changed, changes.removed);
    const changed = [...new Set([...dirty.changed, ...reverted.changed])];
    const removed = [...new Set([...dirty.removed, ...reverted.removed])];
    const headMoved = Boolean(changes.head && branchRow.recordedSha && changes.head !== branchRow.recordedSha);
    // Manifest / proto / API-spec edits are not ingested, but they are a cross-repo signal for the tail — and they
    // count as work only once per content (the handed memo covers them like any other path).
    const signals = (changes.signals || []).filter((p) => { const sha = hashSafe(path.join(branchRow.repoPath, p)); return sha !== null && submitted.get(`${branchRow.branchId}:${p}`) !== sha && handedShas(branchRow.branchId, [p]).get(p) !== sha; });
    if (!changed.length && !removed.length && !signals.length && !headMoved) return;
    const handed = [...changed, ...signals].map((p) => [p, hashSafe(path.join(branchRow.repoPath, p))]);
    // What was handed over is persisted by runCatchUp once the run SUCCEEDED (freshness_handed): a dirty file the ingest
    // does NOT store (docs, manifests, lockfiles, a file that extracted zero nodes) has no `files` row to compare
    // against, so every NEW process re-submitted the whole dirty set — measured 10.3 s on the first repo-scoped read of
    // every process. `submitted` is only the in-flight memo of this process; it is set when a run is actually
    // dispatched and dropped when that run ends, so a set that found a catch-up already running is retried next read.
    const memo = (on) => { for (const [p, sha] of handed) { const k = `${branchRow.branchId}:${p}`; if (on) submitted.set(k, sha); else if (submitted.get(k) === sha) submitted.delete(k); } };
    // A large dirty set is caught up in the BACKGROUND: the query in flight answers from the index as it stands
    // (a few minutes stale for those files; the tool's staleness line says so) instead of blocking the caller for
    // as long as the ingest takes — measured: the first MCP explore after a burst of edits to 13 files blocked
    // 17–20 s, past what a prompt hook (7 s) or a waiting agent tolerates. Small sets stay synchronous: correct
    // beats fast when fast is only a second away. One background run per branch at a time.
    // …and the catch-up itself runs as a DETACHED CHILD (`koragraph catch-up`): better-sqlite3 is synchronous, so a
    // same-process background run blocks every other query for the whole ~15 s tail — measured on the MCP lane:
    // two explores at 6.5 s each while an in-process "background" catch-up held the loop. The default is to always
    // hand it off on the query path (KORAGRAPH_FRESHNESS_MAX_SYNC_FILES=0); a positive value keeps sets up to that
    // size synchronous (tests, and callers that would rather wait than read a briefly stale index).
    const maxSync = Number(process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES) >= 0 ? Number(process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES) : 0;
    if (changed.length + removed.length + signals.length > maxSync) {
      if (inflightCatchUp.has(branchRow.branchId)) return; // one child per branch: this set is picked up on the read after it exits
      const child = spawnCatchUp(branchRow, changed, removed, changes.head, signals);
      if (child) { memo(true); child.done.then(() => memo(false)); }
      return;
    }
    memo(true);
    try { await runCatchUp(branchRow, changed, removed, changes.head, signals); } finally { memo(false); }
  });
}
/**
 * Paths a working-tree catch-up handed to the graph (freshness_handed) that are CLEAN again (not in `stillDirty`) but
 * whose stored content differs from the disk: the edit was reverted. Paths that are back in sync (or that the store
 * never held) are forgotten, so the record stays as small as the set of edits in flight. Sync, cheap: one indexed read
 * of the handed rows + one hash per handed path.
 */
function revertedHanded(branchRow, stillDirty) {
  const out = { changed: [], removed: [] };
  if (!ensureHandedTable()) return out;
  try {
    const db = pool.db;
    const rows = db.prepare('SELECT path, file_sha FROM freshness_handed WHERE repository_branch_id = ?').all(branchRow.branchId).filter((r) => !stillDirty.has(r.path));
    if (!rows.length) return out;
    const stored = new Map(db.prepare(`SELECT path, file_sha FROM files WHERE repository_branch_id = ? AND index_status != 'REMOVED' AND path IN (SELECT value FROM json_each(?))`)
      .all(branchRow.branchId, JSON.stringify(rows.map((r) => r.path))).map((r) => [r.path, r.file_sha]));
    const forget = [];
    for (const r of rows) {
      const abs = path.join(branchRow.repoPath, r.path);
      const have = stored.get(r.path);
      if (!fs.existsSync(abs)) { if (have !== undefined) out.removed.push(r.path); else forget.push(r.path); continue; }
      const sha = hashSafe(abs);
      if (sha === null) continue;
      if (have === undefined || have === sha) { forget.push(r.path); continue; } // in sync, or nothing stored to undo
      if (r.file_sha === sha) continue; // already handed at this content: that catch-up is pending (or failed) — no loop
      out.changed.push(r.path);
    }
    if (forget.length) {
      const del = db.prepare('DELETE FROM freshness_handed WHERE repository_branch_id = ? AND path = ?');
      db.transaction((ps) => { for (const p of ps) del.run(branchRow.branchId, p); })(forget);
    }
  } catch { /* best effort: a read-only or older store just skips the sweep */ }
  return out;
}
/**
 * `ingest` at an unchanged HEAD: undo reverted working-tree catch-ups synchronously (the CLI can wait). Returns the
 * number of paths re-extracted or dropped.
 */
async function catchUpReverted({ cwd }) {
  const branchRow = branchRowFor(cwd);
  if (!branchRow) return 0;
  const { computeChangesAsync } = require('./repo-watcher');
  let changes;
  try { changes = await computeChangesAsync(branchRow.repoPath, branchRow.recordedSha); } catch { return 0; }
  const rv = revertedHanded(branchRow, new Set([...changes.changed, ...changes.removed]));
  if (!rv.changed.length && !rv.removed.length) return 0;
  await runCatchUp(branchRow, rv.changed, rv.removed);
  return rv.changed.length + rv.removed.length;
}
/** The synchronous form, for `koragraph catch-up` (the child) and for callers that must wait. */
async function catchUpNow({ cwd, changed = [], removed = [], head = null, signals = [] }) {
  const branchRow = branchRowFor(cwd);
  if (!branchRow) return null;
  return runCatchUp(branchRow, changed, removed, head, signals); // true = caught up, false = failed / lock timed out
}
const inflightCatchUp = new Map(); // branchId -> promise resolving when the detached catch-up child exits
// A catch-up child that keeps failing (exit != 0: a store error, the lock timing out) was respawned on every read.
// Per branch: after a failure, no new child until the backoff passes (2 s, doubling, capped at 5 min); a success clears it.
const catchUpFailures = new Map(); // branchId -> { n, until }
const BACKOFF_BASE_MS = 2000, BACKOFF_MAX_MS = 5 * 60 * 1000;
function noteCatchUpExit(branchId, code) {
  if (code === 0) { catchUpFailures.delete(branchId); return; }
  const n = (catchUpFailures.get(branchId)?.n ?? 0) + 1;
  if (catchUpFailures.size > 500) catchUpFailures.clear();
  catchUpFailures.set(branchId, { n, until: Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1)) });
}
function catchUpBlocked(branchRow) {
  const f = catchUpFailures.get(branchRow.branchId);
  if (f && Date.now() < f.until) return 'backoff';
  // Another run (an ingest, another process's catch-up) holds this repo's lock: a child now would only sit waiting on
  // it, and the next read after that run finds whatever is still dirty.
  try { if (require('./ingest-lock').isHeld(branchRow.repoPath)) return 'locked'; } catch { /* no lock dir: not held */ }
  return null;
}
function spawnCatchUp(branchRow, changed, removed, head, signals = []) {
  const blocked = catchUpBlocked(branchRow);
  if (blocked) {
    if (process.env.KORAGRAPH_DEBUG || process.env.KORA_TRACE) console.error(`[live-freshness] catch-up not started (${blocked === 'locked' ? 'another run holds the ingest lock' : 'backing off after a failed catch-up'})`);
    return null;
  }
  const { spawn } = require('node:child_process');
  const bin = path.resolve(__dirname, '..', '..', 'bin', 'koragraph.js');
  const args = ['--liftoff-only', bin, 'catch-up', '--repo', branchRow.repoPath, '--changed', JSON.stringify(changed), '--removed', JSON.stringify(removed), '--signals', JSON.stringify(signals), ...(head ? ['--head', head] : [])];
  let logFd = 'ignore';
  try { const home = require('../practice/paths').koragraphHome(); fs.mkdirSync(home, { recursive: true }); logFd = fs.openSync(path.join(home, 'catch-up.log'), 'a'); } catch { logFd = 'ignore'; }
  let child;
  try { child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], env: process.env }); }
  catch (e) { if (process.env.KORAGRAPH_DEBUG || process.env.KORA_TRACE) console.error(`[live-freshness] catch-up spawn failed: ${e && e.message}`); return null; }
  const done = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); child.on('error', () => resolve(-1)); })
    .then((code) => noteCatchUpExit(branchRow.branchId, code))
    .finally(() => inflightCatchUp.delete(branchRow.branchId));
  const entry = { done, child };
  inflightCatchUp.set(branchRow.branchId, entry);
  child.unref(); // never keeps the parent alive on its own — settleCatchUps re-refs it for a caller that waits
  if (process.env.KORAGRAPH_DEBUG || process.env.KORA_TRACE) console.error(`[live-freshness] ${changed.length + removed.length} changed file(s): catching up in a detached child (pid ${child.pid}); answering from the current index`);
  return entry;
}
/** Test/CLI hook: wait for any background catch-up child to exit. */
async function settleCatchUps() {
  const entries = [...inflightCatchUp.values()];
  for (const e of entries) { try { e.child.ref(); } catch { /* gone */ } }
  await Promise.all(entries.map((e) => e.done));
}

const submitted = new Map(); // `${branchId}:${relPath}` -> sha last handed to a catch-up (this process)
function hashSafe(absPath) { try { return hashOf(absPath); } catch { return null; } }
function ensureHandedTable() {
  try { pool.db?.exec('CREATE TABLE IF NOT EXISTS freshness_handed (repository_branch_id INTEGER NOT NULL, path TEXT NOT NULL, file_sha TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (repository_branch_id, path))'); return true; } catch { return false; }
}
function rememberHanded(branchId, handed) {
  if (!handed.length || !ensureHandedTable()) return;
  try {
    const db = pool.db;
    const stmt = db.prepare("INSERT INTO freshness_handed (repository_branch_id, path, file_sha, at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT (repository_branch_id, path) DO UPDATE SET file_sha = excluded.file_sha, at = excluded.at");
    const tx = db.transaction((rows) => { for (const [p, sha] of rows) if (sha) stmt.run(branchId, p, sha); });
    tx(handed);
  } catch { /* best effort */ }
}
function handedShas(branchId, paths) {
  if (!paths.length || !ensureHandedTable()) return new Map();
  try {
    const rows = pool.db.prepare(`SELECT path, file_sha FROM freshness_handed WHERE repository_branch_id = ? AND path IN (SELECT value FROM json_each(?))`).all(branchId, JSON.stringify(paths));
    return new Map(rows.map((r) => [r.path, r.file_sha]));
  } catch { return new Map(); }
}
async function dirtyByContent(branchRow, changedPaths, removedPaths) {
  const all = [...changedPaths, ...removedPaths];
  if (!all.length) return { changed: [], removed: [] };
  const { rows } = await pool.query(
    `SELECT path, file_sha FROM files
      WHERE repository_branch_id = $1 AND index_status != 'REMOVED'
        AND path IN (SELECT value FROM json_each($2))`,
    [branchRow.branchId, all],
  );
  const storedByPath = new Map(rows.map((r) => [r.path, r.file_sha]));
  const handedBefore = handedShas(branchRow.branchId, changedPaths);
  const changed = [];
  for (const relPath of changedPaths) {
    const absPath = path.join(branchRow.repoPath, relPath);
    if (!fs.existsSync(absPath)) continue;
    const sha = hashSafe(absPath);
    if (sha === null) continue; // unreadable — not ours to call
    const stored = storedByPath.get(relPath);
    if (stored !== undefined && stored === sha) continue;              // graph already has this content
    if (submitted.get(`${branchRow.branchId}:${relPath}`) === sha) continue; // handed over at this content already (this process)
    if (handedBefore.get(relPath) === sha) continue;                   // handed over at this content already (any process)
    changed.push(relPath);
  }
  // A removal is only work when the graph still holds the file.
  const removed = removedPaths.filter((p) => storedByPath.has(p));
  return { changed, removed };
}

function resetFreshnessCache() { fileChecked.clear(); repoChecked.clear(); submitted.clear(); catchUpFailures.clear(); }

module.exports = { ensureFileFresh, ensureFilesFresh, ensureRepoFresh, resetFreshnessCache, settleCatchUps, catchUpNow, catchUpReverted, _catchUp: { spawnCatchUp, noteCatchUpExit, catchUpFailures } };

'use strict';

// Keeping the shared store honest over time. Three kinds of debris used to accumulate for ever:
//
//   1. files deleted while still UNTRACKED (an agent's scratch file created then removed). Incremental ingest is driven
//      by `git diff`, which never names them, so their nodes stayed live and searchable until a --full re-extract.
//      -> reapGoneFiles: cheap existence sweep over the branch's live file rows.
//   2. repository rows whose checkout is gone (folder renamed / moved / deleted). Each held a full copy of an index
//      that could no longer be used, and kept answering `overview` and `--repo all`.
//      -> pruneMissingRepos: two-step (seen missing, then deleted after a grace period), or immediately for a twin.
//      Also a plain folder that holds other indexed checkouts (reason 'holds-checkouts'): its index is only loose files.
//   3. ARCHIVED nodes: soft-deleted declarations of edited/removed files, kept for history and never collected.
//      -> gcArchivedNodes: delete the ones older than a retention window.
//
// Everything here is best effort and refuses to act when it cannot tell "gone" from "not mounted".

const fs = require('fs');
const path = require('path');
const { folderState } = require('./repo-name');

const DAY_MS = 24 * 3600 * 1000;
const PRUNE_GRACE_HOURS = Number(process.env.KORAGRAPH_PRUNE_GRACE_HOURS) >= 0 ? Number(process.env.KORAGRAPH_PRUNE_GRACE_HOURS) : 24 * 7;
const ARCHIVE_RETENTION_DAYS = Number(process.env.KORAGRAPH_ARCHIVE_RETENTION_DAYS) >= 0 ? Number(process.env.KORAGRAPH_ARCHIVE_RETENTION_DAYS) : 14;

function maint() { return require('../db/maintenance'); }

/** Archive the nodes of files that no longer exist on disk. Returns how many file rows were reaped. */
async function reapGoneFiles(pool, branchId, repoPath) {
  if (!branchId || !repoPath || folderState(repoPath) !== 'present') return 0;
  const { rows } = await pool.query(
    "SELECT path FROM files WHERE repository_branch_id = $1 AND index_status != 'REMOVED'", [branchId]);
  if (!rows.length) return 0;
  const gone = rows.map((r) => r.path).filter((rel) => !fs.existsSync(path.join(repoPath, rel)));
  if (!gone.length) return 0;
  // A tree that lost most of its files at once is a sparse checkout / a half-mounted volume, not an edit.
  if (gone.length > 20 && gone.length / rows.length > 0.6) return 0;
  const { archiveDeletedFileNodes } = require('./ingest');
  await archiveDeletedFileNodes(branchId, gone);
  return gone.length;
}

/** Repository rows whose recorded checkout is missing. `emptied`: the folder is there but is no longer that repo. */
async function findMissingRepos(pool) {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.full_path,
            (SELECT count(*) FROM repository_branches b JOIN nodes n ON n.repository_branch_id = b.id
              WHERE b.repository_id = r.id AND n.approval_status != 'ARCHIVED') AS nodes
       FROM repositories r WHERE r.is_archived = 0`);
  const out = [];
  for (const r of rows) {
    const st = folderState(r.full_path);
    if (st === 'gone') { out.push({ ...r, reason: 'gone' }); continue; }
    if (st !== 'present') continue;
    if (fs.existsSync(path.join(r.full_path, '.git'))) continue;
    // A plain folder that HOLDS checkouts (a workspace like ~/Projects/app-suite with app/, api/ inside): its index is
    // only the loose files around them (kora patch 2026-10-15: 77 nodes for ~/Projects/koraplex), and agents opened there
    // were told real symbols do not exist. The runtime no longer resolves to it; prune drops it like a missing repo.
    if (rows.some((o) => o.id !== r.id && o.full_path && o.full_path.startsWith(r.full_path + path.sep))) { out.push({ ...r, reason: 'holds-checkouts' }); continue; }
    // A folder that is no longer a git checkout: is anything the index knows about still in it?
    const { rows: sample } = await pool.query(
      `SELECT f.path FROM files f JOIN repository_branches b ON b.id = f.repository_branch_id
        WHERE b.repository_id = $1 AND f.index_status != 'REMOVED' LIMIT 40`, [r.id]);
    if (sample.length >= 5 && sample.every((f) => !fs.existsSync(path.join(r.full_path, f.path)))) out.push({ ...r, reason: 'emptied' });
  }
  return out;
}

/**
 * Delete repositories whose checkout has been missing for `graceHours` (default a week; 0 = now). A repository is
 * first only NOTED (store_maintenance `missing:<id>`); a later call deletes it, so a disk that is unplugged for an
 * afternoon never costs an index. `dryRun` reports without noting or deleting. Returns { pruned, pending }.
 */
async function pruneMissingRepos(pool, { graceHours = PRUNE_GRACE_HOURS, dryRun = false, now = Date.now(), only = null } = {}) {
  const m = maint();
  const missing = (await findMissingRepos(pool)).filter((r) => !only || only.includes(r.id));
  const missingIds = new Set(missing.map((r) => r.id));
  const pruned = []; const pending = [];
  for (const r of missing) {
    const key = `missing:${r.id}`;
    const since = Number(m.getMaint(pool, key)) || 0;
    if (!since && !dryRun) m.setMaint(pool, key, now);
    const ageH = since ? (now - since) / 3600e3 : 0;
    if (since && ageH >= graceHours || graceHours === 0 || r.reason === 'holds-checkouts') { // nothing to wait for: the folder is there
      if (!dryRun) await deleteRepo(pool, r.id);
      pruned.push({ id: r.id, name: r.name, path: r.full_path, nodes: Number(r.nodes), reason: r.reason });
    } else pending.push({ id: r.id, name: r.name, path: r.full_path, nodes: Number(r.nodes), reason: r.reason, daysLeft: Math.max(0, (graceHours - ageH) / 24) });
  }
  // A row that came back (folder mounted again) stops its clock.
  if (!dryRun) {
    try {
      const db = pool.db;
      if (db) for (const row of db.prepare("SELECT key FROM store_maintenance WHERE key LIKE 'missing:%'").all()) {
        const id = Number(String(row.key).split(':')[1]);
        if (!missingIds.has(id)) db.prepare('DELETE FROM store_maintenance WHERE key = ?').run(row.key);
      }
    } catch { /* best effort */ }
  }
  return { pruned, pending };
}

async function deleteRepo(pool, repoId) {
  await pool.query('DELETE FROM repositories WHERE id = $1', [repoId]);
  await cleanOrphans(pool);
  try { pool.db.prepare('DELETE FROM store_maintenance WHERE key = ?').run(`missing:${repoId}`); } catch { /* fine */ }
}

/**
 * A repo folder that was RENAMED is not the same row (rows are keyed by folder name): the old row is left pointing at a
 * folder that no longer exists, holding a full copy of the index. When the checkout just indexed contains the old row's
 * last indexed commit it is provably the same repository — the old row is a twin and is removed at once.
 */
async function pruneTwins(pool, newRepoId, repoPath) {
  const { execFileSync } = require('child_process');
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.full_path,
            (SELECT b.last_commit_sha FROM repository_branches b WHERE b.repository_id = r.id ORDER BY b.id LIMIT 1) AS sha
       FROM repositories r WHERE r.id != $1`, [newRepoId]);
  const out = [];
  for (const r of rows) {
    if (!r.sha || folderState(r.full_path) !== 'gone') continue;
    try {
      execFileSync('git', ['-C', repoPath, 'cat-file', '-e', `${r.sha}^{commit}`], { stdio: 'ignore', timeout: 5000 });
    } catch { continue; }
    await deleteRepo(pool, r.id);
    out.push({ id: r.id, name: r.name, path: r.full_path });
  }
  return out;
}

/** Rows the schema has no FK cascade for (tables keyed by a bare branch id). */
async function cleanOrphans(pool) {
  for (const sql of [
    'DELETE FROM ingest_coverage_files WHERE repository_branch_id NOT IN (SELECT id FROM repository_branches)',
    'DELETE FROM file_text_chunks WHERE repository_branch_id NOT IN (SELECT id FROM repository_branches)',
  ]) { try { await pool.query(sql); } catch { /* table absent in an older store */ } }
}

/** Delete ARCHIVED nodes older than the retention window. Returns the count. */
async function gcArchivedNodes(pool, { days = ARCHIVE_RETENTION_DAYS, branchId = null, now = Date.now() } = {}) {
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  const r = await pool.query(
    `DELETE FROM nodes WHERE approval_status = 'ARCHIVED' AND last_updated_at < $1
       AND ($2 IS NULL OR repository_branch_id = $2)`, [cutoff, branchId]);
  return r.rowCount || 0;
}

/** Throttled housekeeping run at the tail of an ingest: at most once a day per store. */
async function routineHygiene(pool, { now = Date.now() } = {}) {
  const m = maint();
  const last = Number(m.getMaint(pool, 'hygiene_at')) || 0;
  if (now - last < DAY_MS) return null;
  m.setMaint(pool, 'hygiene_at', now);
  const gc = await gcArchivedNodes(pool, { now }).catch(() => 0);
  const pr = await pruneMissingRepos(pool, { now }).catch(() => ({ pruned: [], pending: [] }));
  return { archivedDeleted: gc, pruned: pr.pruned, pending: pr.pending };
}

/**
 * Keep the query planner's statistics current: `PRAGMA optimize` (with a bounded sample) re-analyzes tables that have none
 * or whose size changed a lot. A store that grew from thousands to hundreds of thousands of rows under stale or missing
 * sqlite_stat1 picked a nested loop over the whole store for the UI's status/explorer reads (the 2026-10-14 daemon
 * freeze). Cheap when nothing changed; run at the tail of every ingest/catch-up, never fails one.
 */
function refreshPlannerStats(pool) {
  try { pool.db.pragma('analysis_limit = 2000'); pool.db.pragma('optimize'); return true; } catch { return false; }
}

module.exports = { refreshPlannerStats, pruneTwins, reapGoneFiles, findMissingRepos, pruneMissingRepos, deleteRepo, cleanOrphans, gcArchivedNodes, routineHygiene, PRUNE_GRACE_HOURS, ARCHIVE_RETENTION_DAYS };

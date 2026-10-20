'use strict';

// A repository row is keyed (project, name) and `name` used to be the checkout directory's BASENAME, so two different
// checkouts called `app` (~/work/app, ~/side/app) were one row: the second ingest silently replaced the first's
// index, and every alternation after that re-extracted a whole repo and archived the other's nodes.
//
// The name is now chosen per checkout:
//   1. a row whose full_path IS this checkout keeps its name (re-index, incl. after upgrade);
//   2. a row with the same basename whose folder is GONE is this repo moved: adopt it (its full_path is rewritten);
//   3. a row with the same basename whose folder is still there is a DIFFERENT checkout: this one gets a distinct name
//      (`app~side`, then `app~side~<hash>` if that is taken too) and its own index.
// Nothing outside ingest picks a name: every reader resolves cwd -> row by full_path first (see sameCheckout).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Does the row's recorded folder exist (as a directory)? A missing folder is a moved/deleted repo. A folder on a
// volume that is not mounted must not read as "gone": the caller treats an absent PARENT as "cannot tell".
function folderState(fullPath) {
  if (!fullPath || !path.isAbsolute(fullPath)) return 'unknown';
  try { if (fs.statSync(fullPath).isDirectory()) return 'present'; } catch { /* fall through */ }
  // Walk up to the nearest ancestor that exists: a whole deleted tree (a bench scratch dir, a removed worktree root) is
  // gone too. Only a path under a mount point (/Volumes, /mnt, /media) whose volume is absent stays "cannot tell".
  if (/^\/(Volumes|mnt|media)\//.test(fullPath) && !fs.existsSync(fullPath.split('/').slice(0, 3).join('/'))) return 'unknown';
  for (let dir = path.dirname(fullPath); ; dir = path.dirname(dir)) {
    try { if (fs.statSync(dir).isDirectory()) return 'gone'; } catch { /* keep walking up */ }
    if (dir === path.dirname(dir)) return 'unknown';
  }
}

/** Is `fullPath` (a row's recorded checkout) the checkout at `root`? true / false; null = cannot tell. */
function sameCheckout(fullPath, root) {
  if (!fullPath || !root) return null;
  if (!path.isAbsolute(fullPath)) return null; // legacy rows stored a bare name
  if (path.resolve(fullPath) === path.resolve(root)) return true;
  const st = folderState(fullPath);
  if (st === 'present') return real(fullPath) === real(root);
  return null;
}

// Is `row` (a repository row whose folder is gone) really the repo now at `root`, moved? A shared basename is not
// identity: an unrelated `~/new/app` must not take over a deleted `~/old/app`'s index (audit 2026-10-15 #2). The row's
// last indexed commit must exist in this checkout's history (a moved repo carries its .git along), and a recorded
// remote, when both sides have one, must agree. true / false; null = the row records no commit (cannot tell).
const commitMemo = new Map();
function commitKey(root, sha) {
  if (!root || !sha || !/^[0-9a-f]{7,64}$/i.test(String(sha))) return null;
  return `${root}\0${sha}`;
}
function remember(key, ok) {
  if (commitMemo.size > 500) commitMemo.clear();
  commitMemo.set(key, ok);
  return ok;
}
function hasCommit(root, sha) {
  const key = commitKey(root, sha);
  if (!key) return false;
  if (commitMemo.has(key)) return commitMemo.get(key);
  let ok = false;
  try { ok = require('child_process').spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore', timeout: 1500 }).status === 0; } catch { ok = false; }
  return remember(key, ok);
}
/** hasCommit off the event loop: the runtime's status path runs inside the daemon. */
function hasCommitAsync(root, sha) {
  const key = commitKey(root, sha);
  if (!key) return Promise.resolve(false);
  if (commitMemo.has(key)) return Promise.resolve(commitMemo.get(key));
  return new Promise((resolve) => {
    try {
      require('child_process').execFile('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], { timeout: 1500 }, (err) => resolve(remember(key, !err)));
    } catch { resolve(false); }
  });
}
/** A recorded remote that disagrees with this checkout's: a different repository whatever the commits say. */
function remoteDisagrees(row, root) {
  if (!row.web_url) return false;
  try {
    const { repoIdentity, normaliseRemote } = require('../practice/repo-identity');
    const mine = repoIdentity(root).repoId; const theirs = normaliseRemote(row.web_url);
    return !!(mine && theirs && !String(mine).startsWith('local:') && mine !== theirs);
  } catch { return false; /* no remote to compare */ }
}
function sameRepoIdentity(row, root) {
  if (!row || !root || remoteDisagrees(row, root)) return false;
  if (!row.last_commit_sha) return null;
  return hasCommit(root, row.last_commit_sha);
}
async function sameRepoIdentityAsync(row, root) {
  if (!row || !root || remoteDisagrees(row, root)) return false;
  if (!row.last_commit_sha) return null;
  return hasCommitAsync(root, row.last_commit_sha);
}

function shortHash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 6); }

async function resolveRepoName(pool, projectId, repoPath) {
  const base = path.basename(repoPath);
  const abs = path.resolve(repoPath);
  const r = real(repoPath);
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.full_path, r.web_url,
            (SELECT rb.last_commit_sha FROM repository_branches rb WHERE rb.repository_id = r.id AND rb.last_commit_sha IS NOT NULL
              ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1) AS last_commit_sha
       FROM repositories r
      WHERE r.project_id = $1 AND (r.name = $2 OR r.name LIKE $3 ESCAPE '\\')`,
    [projectId, base, `${base.replace(/[\\%_]/g, '\\$&')}~%`],
  );
  // 1. this exact checkout
  // (compare real paths too: macOS /var → /private/var, /tmp → /private/tmp — one folder, two spellings)
  const own = rows.find((x) => x.full_path && path.isAbsolute(x.full_path) && (path.resolve(x.full_path) === abs || path.resolve(x.full_path) === r || real(x.full_path) === r));
  if (own) return own.name;
  // 2. the same basename, its folder is gone, and it is the same repository (its indexed commit is in this history):
  //    the repo was moved/renamed — take it over. A row that recorded no commit (a plain folder) cannot be checked, so
  //    it is not taken over (same rule as the runtime's movedRow: unproven identity = a different repo, a new row).
  const moved = rows.find((x) => x.name === base && folderState(x.full_path) === 'gone' && sameRepoIdentity(x, abs) === true);
  if (moved) return moved.name;
  // legacy rows (full_path is a bare name) and unknown volumes: keep the old behaviour, one row per basename
  const legacy = rows.find((x) => x.name === base && (folderState(x.full_path) === 'unknown'));
  if (legacy) return legacy.name;
  const baseTaken = rows.some((x) => x.name === base);
  if (!baseTaken) return base;
  // 3. a different live checkout owns the plain name
  const parent = path.basename(path.dirname(abs)) || 'root';
  const taken = new Set(rows.map((x) => x.name));
  const cand = `${base}~${parent}`;
  if (!taken.has(cand)) return cand;
  return `${cand}~${shortHash(abs)}`;
}

// resolveRepoName reads the rows and the row is written much later (runIngest), so two first ingests of `~/a/app` and
// `~/b/app` started together both picked `app` and shared ONE row: the second silently took the first's index, and the
// first could never be indexed again (deep audit 2026-10-13 A2-2). Pick the name and write this checkout's row in one
// write transaction (BEGIN = BEGIN IMMEDIATE in the sqlite pool, so the other ingest waits on its busy_timeout); the
// later upsert in runIngest finds it by (project, name).
async function claimRepoName(pool, projectId, repoPath) {
  const abs = path.resolve(repoPath);
  await pool.query('BEGIN');
  try {
    const name = await resolveRepoName(pool, projectId, repoPath);
    const { rows } = await pool.query('SELECT id, full_path FROM repositories WHERE project_id = $1 AND name = $2', [projectId, name]);
    if (!rows.length) {
      await pool.query('INSERT INTO repositories (project_id, name, full_path) VALUES ($1, $2, $3) ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL DO NOTHING', [projectId, name, abs]);
    } else if (sameCheckout(rows[0].full_path, abs) !== true && folderState(rows[0].full_path) === 'gone') {
      await pool.query('UPDATE repositories SET full_path = $1 WHERE id = $2', [abs, rows[0].id]); // a moved repo, adopted
    }
    await pool.query('COMMIT');
    return name;
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

module.exports = { resolveRepoName, claimRepoName, sameCheckout, folderState, sameRepoIdentity, sameRepoIdentityAsync };

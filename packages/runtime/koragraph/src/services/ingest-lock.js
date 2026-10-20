'use strict';
// One ingest per repository at a time. Two incremental runs on the same branch — a query's catch-up child and a
// `koragraph ingest`, or two agents' hooks — each open a generation and the later activation supersedes the other's
// nodes; measured on KoragraphMCP: a one-file catch-up that overlapped another run logged edges_removed=15958 and the
// branch went from 26.6k to 21.1k edges. SQLite's busy_timeout serialises statements, not runs. This lock serialises
// runs: a file per repo under <koragraph home>/locks, holder pid + time, stale when the pid is gone or older than
// two hours. Waiters poll; a caller that would rather skip passes { wait: 0 }.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function lockDir() { const { koragraphHome } = require('../practice/paths'); return path.join(koragraphHome(), 'locks'); }
// Keyed on the REAL path: `/tmp/app` and `/private/tmp/app` (or a symlinked parent) are one repository and must share one lock.
function repoKey(repoPath) { const abs = path.resolve(repoPath); try { return fs.realpathSync.native(abs); } catch { return abs; } }
function lockFile(repoPath) { return path.join(lockDir(), `ingest-${crypto.createHash('sha1').update(repoKey(repoPath)).digest('hex').slice(0, 16)}.lock`); }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
const STALE_MS = 2 * 60 * 60 * 1000;
const TAKEOVER_STALE_MS = 30 * 1000; // a takeover is a read + two file ops; one older than this was abandoned (killed)
const readLock = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : ''; } };
const isStale = (raw) => { let cur = null; try { cur = JSON.parse(raw); } catch { /* corrupt → stale */ } return !cur || !alive(Number(cur.pid)) || Date.now() - Number(cur.at || 0) > STALE_MS; };

// Replacing a stale lock must be atomic: two waiters that both saw it stale used to both unlink + create, the second
// deleting the first's FRESH lock — two runs at once, the edge loss this lock exists to stop. Only the holder of an
// exclusive-create takeover file may remove the stale lock, and it re-reads the lock first: if it is no longer the
// stale one it saw (another waiter already took over), it backs off.
function takeOver(file, seen) {
  const tk = `${file}.takeover`;
  try { fs.writeFileSync(tk, String(process.pid), { flag: 'wx' }); }
  catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    try { if (Date.now() - fs.statSync(tk).mtimeMs > TAKEOVER_STALE_MS) fs.unlinkSync(tk); } catch { /* raced */ }
    return false;
  }
  try {
    const now = readLock(file);
    if (now !== null && (now !== seen || !isStale(now))) return false; // someone else's lock now: not ours to remove
    if (now !== null) fs.unlinkSync(file);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(tk); } catch { /* gone */ } }
}

function tryAcquire(repoPath) {
  const file = lockFile(repoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), repo: repoKey(repoPath) }), { flag: 'wx' });
      return { release() { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } }, file };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const seen = readLock(file);
      if (seen === null) continue; // released between the create and the read: try again
      if (!isStale(seen)) return null;
      if (!takeOver(file, seen)) return null; // another waiter is taking it over — poll again
    }
  }
  return null;
}
/** Another live run holds this repo's lock right now (a stale lock — dead pid, too old — does not count). */
function isHeld(repoPath) { const raw = readLock(lockFile(repoPath)); return raw !== null && !isStale(raw); }
function holder(repoPath) { try { return JSON.parse(fs.readFileSync(lockFile(repoPath), 'utf8')); } catch { return null; } }
/** Acquire, waiting up to `wait` ms (default 10 min) for another run to finish. Null on timeout. */
async function acquire(repoPath, { wait = 10 * 60 * 1000, pollMs = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const l = tryAcquire(repoPath); if (l) return l;
    if (Date.now() - t0 >= wait) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
module.exports = { acquire, tryAcquire, holder, isHeld, lockFile };

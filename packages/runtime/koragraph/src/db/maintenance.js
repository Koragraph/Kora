'use strict';
// Store maintenance the query planner depends on. Without `sqlite_stat1` (never ANALYZEd) SQLite guessed that
// `idx_nodes_approval_status` was the way into `nodes` for the ranked search — a scan over every APPROVED node of
// every repository in the store (258k rows across 60 repos) to find 14 in one branch. Measured on a 2.5 GB store:
// 2.1–3.6 s cold / 70 ms warm per search; with statistics the planner takes the branch-scoped index and the same
// search is 208 ms cold / 26 ms warm. The prompt-injection hook is a fresh process per prompt with a 7 s budget, so
// the cold number is the one that decides whether declarations reach the agent at all.
//
//   analyzeStore({ force })  — ANALYZE when statistics are missing or older than a full ingest (2 s on 2.5 GB);
//                              otherwise `PRAGMA optimize`, which is cheap and only re-analyzes what changed enough.
//   checkpointStore()        — `wal_checkpoint(TRUNCATE)`, best effort: a WAL that grew to 869 MB during an ingest is
//                              folded back so cold readers open a compact main file.
// Both are best effort and silent; they run AFTER an ingest, never on a query path.
const ANALYZE_EVERY_MS = 24 * 60 * 60 * 1000;

async function hasStats(pool) {
  const { rows } = await pool.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'");
  return Number(rows[0]?.n) > 0;
}

async function analyzeStore(pool, { force = false, now = Date.now() } = {}) {
  try {
    const stats = await hasStats(pool);
    const last = lastAnalyzeAt(pool);
    if (force || !stats || now - last > ANALYZE_EVERY_MS) {
      await pool.query('ANALYZE');
      rememberAnalyze(pool, now);
      return 'analyze';
    }
    await pool.query('PRAGMA optimize');
    return 'optimize';
  } catch {
    return null;
  }
}

async function checkpointStore(pool) {
  try { await pool.query('PRAGMA wal_checkpoint(TRUNCATE)'); return true; } catch { return false; }
}

// `PRAGMA user_version` is free scalar storage; the last-ANALYZE time lives in a tiny side table instead so it
// never collides with a schema-version convention.
function lastAnalyzeAt(pool) {
  try {
    const db = pool.db; if (!db) return 0;
    db.exec('CREATE TABLE IF NOT EXISTS store_maintenance (key TEXT PRIMARY KEY, value TEXT)');
    const row = db.prepare("SELECT value FROM store_maintenance WHERE key = 'analyzed_at'").get();
    return row ? Number(row.value) || 0 : 0;
  } catch { return 0; }
}
function rememberAnalyze(pool, at) {
  try {
    const db = pool.db; if (!db) return;
    db.exec('CREATE TABLE IF NOT EXISTS store_maintenance (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO store_maintenance (key, value) VALUES ('analyzed_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(at));
  } catch { /* best effort */ }
}

/** After a FULL ingest: statistics (forced) + checkpoint. */
async function afterFullIngest(pool) { const a = await analyzeStore(pool, { force: true }); const c = await checkpointStore(pool); return { analyze: a, checkpoint: c }; }
/** After an INCREMENTAL catch-up (runs behind a live query): cheap optimize, passive checkpoint. */
async function afterIncrementalIngest(pool) {
  const a = await analyzeStore(pool);
  try { await pool.query('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* fine */ }
  return { analyze: a };
}

/** Small key/value side table (store_maintenance) — timestamps of passes worth debouncing. */
function getMaint(pool, key) {
  try { const db = pool.db; if (!db) return null; db.exec('CREATE TABLE IF NOT EXISTS store_maintenance (key TEXT PRIMARY KEY, value TEXT)'); const row = db.prepare('SELECT value FROM store_maintenance WHERE key = ?').get(key); return row ? row.value : null; } catch { return null; }
}
function setMaint(pool, key, value) {
  try { const db = pool.db; if (!db) return; db.exec('CREATE TABLE IF NOT EXISTS store_maintenance (key TEXT PRIMARY KEY, value TEXT)'); db.prepare('INSERT INTO store_maintenance (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value)); } catch { /* best effort */ }
}
module.exports = { analyzeStore, checkpointStore, afterFullIngest, afterIncrementalIngest, hasStats, ANALYZE_EVERY_MS, getMaint, setMaint };

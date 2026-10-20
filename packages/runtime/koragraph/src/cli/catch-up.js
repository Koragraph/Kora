'use strict';
// `koragraph catch-up` — the live-freshness catch-up as a CHILD PROCESS. A repo-scoped graph read on a dirty checkout
// finds files whose content the graph does not hold and must re-extract them; that incremental run costs ~15 s of
// branch-wide SQL passes however few files changed (measured: one file, 17 s), and because better-sqlite3 is
// synchronous a "background" run in the same process still blocks every other query for that long. So the read
// answers from the index as it stands and hands the set to this command, detached; the next read sees the catch-up.
const path = require('node:path');

const USAGE = `Usage: koragraph catch-up --repo <path> --changed <json array> [--removed <json array>] [--head <sha>]

Internal: re-extract the given files into the repository's graph (what live freshness does on a dirty checkout),
run as a detached child so the query that noticed the change does not wait ~15 s for it.`;
const USES_STORE = true;

function parse(argv) {
  const out = { repo: null, changed: [], removed: [], signals: [], head: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--changed') out.changed = JSON.parse(argv[++i] || '[]');
    else if (a === '--removed') out.removed = JSON.parse(argv[++i] || '[]');
    else if (a === '--signals') out.signals = JSON.parse(argv[++i] || '[]');
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function run(parsed, io) {
  if (parsed.help || !parsed.repo) { io.err(USAGE + '\n'); return parsed.help ? 0 : 2; }
  const { catchUpNow } = require('../services/live-freshness');
  // A catch-up is a writer like `ingest`: wait for another repo's ingest to release the write lock (same
  // KORAGRAPH_INGEST_BUSY_MS as ingestAll) instead of failing "database is locked" after the pool's 2 s read default.
  try { require('../db/pool').db.pragma(`busy_timeout = ${ingestBusyMs()}`); } catch { /* :memory: / older pool */ }
  const t0 = Date.now();
  const r = await catchUpNow({ cwd: path.resolve(parsed.repo), changed: parsed.changed, removed: parsed.removed, head: parsed.head, signals: parsed.signals });
  // Planner statistics (PATCHES.md 2026-10-14): cheap no-op unless a table changed a lot.
  try { require('../services/store-hygiene').refreshPlannerStats(require('../db/pool')); } catch { /* never fails a catch-up */ }
  io.err(`catch-up: ${r === true ? 'done' : r === false ? 'FAILED' : 'no branch row'} for ${parsed.repo} (${parsed.changed.length} changed, ${parsed.removed.length} removed) in ${Date.now() - t0} ms\n`);
  return r === false ? 1 : 0;
}

function ingestBusyMs() { return Number(process.env.KORAGRAPH_INGEST_BUSY_MS) > 0 ? Number(process.env.KORAGRAPH_INGEST_BUSY_MS) : 120000; }

module.exports = { parse, run, USAGE, USES_STORE, ingestBusyMs };

'use strict';
// 2026-10-14 daemon freeze: ingest must leave planner statistics behind (PRAGMA optimize at the tail).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqlitePool } = require('../src/db/sqlite-pool');
const hygiene = require('../src/services/store-hygiene');

test('refreshPlannerStats creates sqlite_stat1 for indexed tables that have none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-stats-'));
  const pool = new SqlitePool(path.join(dir, 'g.db'));
  try {
    pool.db.exec('CREATE TABLE t (a INTEGER, b INTEGER); CREATE INDEX t_a ON t(a)');
    const ins = pool.db.prepare('INSERT INTO t VALUES (?, ?)');
    for (let i = 0; i < 500; i++) ins.run(i % 7, i);
    assert.equal(hygiene.refreshPlannerStats(pool), true);
    const row = pool.db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 't' AND idx = 't_a'").get();
    assert.ok(row && /^500 /.test(row.stat), `stat row: ${JSON.stringify(row)}`);
  } finally { try { pool.db.close(); } catch { /* fine */ } fs.rmSync(dir, { recursive: true, force: true }); }
});

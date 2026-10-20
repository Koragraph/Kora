'use strict';
// Deep audit 2026-10-13 A2-1: two first ingests into a brand-new store raced on `journal_mode = WAL` (SQLite runs no
// busy handler for it) and one died "database is locked". Several processes now open one fresh file at once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const POOL = path.resolve(__dirname, '..', 'src', 'db', 'sqlite-pool.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-openrace-')));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const opener = (file, startAt) => new Promise((resolve) => {
  const src = `const { SqlitePool } = require(${JSON.stringify(POOL)});
    while (Date.now() < ${startAt}) {}
    try { const p = new SqlitePool(${JSON.stringify(file)}); p.db.exec('CREATE TABLE IF NOT EXISTS t (x)'); p.db.close(); process.exit(0); }
    catch (e) { process.stderr.write(String(e.message)); process.exit(3); }`;
  const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('exit', (code) => resolve({ code, err }));
});

test('processes opening one brand-new store at the same moment all get it (no "database is locked")', async () => {
  const failures = [];
  for (let round = 0; round < 6; round++) {
    const file = path.join(TMP, `r${round}.db`);
    const startAt = Date.now() + 400; // every child spins until the same instant, then opens
    const rs = await Promise.all([0, 1, 2, 3].map(() => opener(file, startAt)));
    for (const r of rs) if (r.code !== 0) failures.push(r.err.slice(0, 120));
  }
  assert.deepEqual(failures, []);
});

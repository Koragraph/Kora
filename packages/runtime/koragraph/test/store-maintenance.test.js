'use strict';
// After a full ingest the store must carry planner statistics (sqlite_stat1) and a folded WAL. Without statistics
// the ranked search scanned every APPROVED node in the store (3.5 s cold on 2.5 GB) instead of one branch (0.2 s).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-maint-'));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;
const MAIN = path.join(TMP, 'app');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });

test.before(() => {
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, 'src/a.js'), 'export function a(x) { return x + 1; }\n');
  fs.writeFileSync(path.join(MAIN, 'src/b.js'), "import { a } from './a.js';\nexport const b = () => a(1);\n");
  git(MAIN, 'init', '-q'); git(MAIN, 'add', '-A'); git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  execFileSync('node', [CLI, 'ingest', MAIN], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });
});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('a full ingest leaves planner statistics and a truncated WAL behind', () => {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(HOME, 'graph.db'), { readonly: true });
  try {
    const stat = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get().n;
    assert.equal(stat, 1, 'sqlite_stat1 exists after ingest');
    assert.ok(db.prepare("SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = 'nodes'").get().n > 0, 'nodes has statistics');
    const at = db.prepare("SELECT value FROM store_maintenance WHERE key = 'analyzed_at'").get();
    assert.ok(at && Number(at.value) > 0, 'analyzed_at recorded');
  } finally { db.close(); }
  const wal = path.join(HOME, 'graph.db-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL folded back after ingest');
});

test('analyzeStore is cheap (optimize) when statistics are fresh, and forced when asked', async () => {
  const m = require('../src/db/maintenance');
  const pool = require('../src/db/pool');
  assert.equal(await m.analyzeStore(pool), 'optimize');
  assert.equal(await m.analyzeStore(pool, { force: true }), 'analyze');
  assert.equal(await m.analyzeStore(pool, { now: Date.now() + m.ANALYZE_EVERY_MS + 1 }), 'analyze');
});

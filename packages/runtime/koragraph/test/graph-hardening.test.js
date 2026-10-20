'use strict';
// Regressions from the 2026-09-30 graph stability audit. Each test is a real repo + the real CLI against a scratch store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'koragraph.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-harden-')));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
const ENV = { ...process.env, KORAGRAPH_HOME: HOME, KORAGRAPH_DB: '', KORAGRAPH_PRACTICE_DB: '' };
delete ENV.KORAGRAPH_DB; delete ENV.KORAGRAPH_PRACTICE_DB;
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe', encoding: 'utf8' });
function mkrepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
}
const ingest = (dir, ...extra) => execFileSync('node', [CLI, 'ingest', dir, '--no-hooks', ...extra], { env: ENV, stdio: 'pipe', encoding: 'utf8' });
function db() { const D = require('better-sqlite3'); return new D(path.join(HOME, 'graph.db')); }
const q = (sql, ...p) => { const d = db(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };

const LIB = {
  'lib.js': 'function helperFn(x) { return x + 1; }\nmodule.exports = { helperFn };\n',
  'use.js': "const { helperFn } = require('./lib.js');\nfunction callerFn() { return helperFn(2); }\nmodule.exports = { callerFn };\n",
};
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('a file renamed away and back keeps its nodes AND the calls into it', () => {
  const r = path.join(TMP, 'rb'); mkrepo(r, LIB); ingest(r);
  const incoming = () => q(`SELECT count(*) AS n FROM edges e JOIN nodes t ON t.id = e.to_node_id JOIN files f ON f.id = t.file_id
                             WHERE f.path = 'lib.js' AND t.approval_status = 'APPROVED' AND e.edge_type IN ('CALLS','HEURISTIC_CALLS','IMPORTS','IMPORTS_SYMBOL')`)[0].n;
  const before = incoming(); assert.ok(before > 0, 'baseline has callers into lib.js');
  git(r, 'mv', 'lib.js', 'lib2.js'); git(r, 'commit', '-qm', 'away'); ingest(r);
  git(r, 'mv', 'lib2.js', 'lib.js'); git(r, 'commit', '-qm', 'back'); ingest(r);
  const live = q("SELECT count(*) AS n FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'lib.js' AND n.approval_status = 'APPROVED'")[0].n;
  assert.ok(live > 0, 'lib.js is back in the graph (was: stuck REMOVED, sha-skipped)');
  assert.equal(incoming(), before, 'callers in untouched files were re-linked');
});

test('two different checkouts with the same folder name get separate indexes and never thrash', () => {
  const a = path.join(TMP, 'x', 'app'), b = path.join(TMP, 'y', 'app');
  mkrepo(a, { 'a.js': 'function onlyInA() { return 1; }\n' }); mkrepo(b, { 'b.js': 'function onlyInB() { return 2; }\n' });
  ingest(a); ingest(b);
  const rows = q("SELECT name, full_path FROM repositories WHERE full_path IN (?, ?) ORDER BY id", a, b);
  assert.equal(rows.length, 2, 'two rows, not one overwritten');
  assert.notEqual(rows[0].name, rows[1].name);
  assert.match(ingest(a), /unchanged/, 'the first is still indexed at HEAD — the second did not replace it');
  assert.match(ingest(b), /unchanged/);
  const names = (repo) => q("SELECT n.name FROM nodes n JOIN repository_branches b ON b.id = n.repository_branch_id JOIN repositories r ON r.id = b.repository_id WHERE r.full_path = ? AND n.node_type = 'METHOD'", repo).map((x) => x.name);
  assert.ok(names(a).includes('onlyInA') && !names(a).includes('onlyInB'));
  assert.ok(names(b).includes('onlyInB') && !names(b).includes('onlyInA'));
});

test('a renamed repo folder replaces its old row (same history) instead of leaving a ghost; a moved one is adopted', () => {
  const r = path.join(TMP, 'ren1'); mkrepo(r, LIB); ingest(r);
  const r2 = path.join(TMP, 'ren2'); fs.renameSync(r, r2);
  const out = ingest(r2);
  assert.equal(q('SELECT count(*) AS n FROM repositories WHERE full_path = ?', r)[0].n, 0, 'old row is gone');
  assert.equal(q('SELECT count(*) AS n FROM repositories WHERE full_path = ?', r2)[0].n, 1);
  assert.ok(out !== undefined);
  // same basename, new parent: one row, path follows
  const m1 = path.join(TMP, 'p1', 'mv'); mkrepo(m1, LIB); ingest(m1);
  const id = q('SELECT id FROM repositories WHERE full_path = ?', m1)[0].id;
  const m2 = path.join(TMP, 'p2', 'mv'); fs.mkdirSync(path.dirname(m2), { recursive: true }); fs.renameSync(m1, m2);
  assert.match(ingest(m2), /unchanged/);
  assert.equal(q('SELECT full_path FROM repositories WHERE id = ?', id)[0].full_path, m2, 'the row follows the folder');
});

test('a file created and deleted while untracked leaves no live nodes after the next ingest', () => {
  const r = path.join(TMP, 'ghost'); mkrepo(r, LIB); ingest(r);
  fs.writeFileSync(path.join(r, 'scratch.js'), 'function scratchFn() {}\n');
  // the freshness pass (a query) is what indexes an untracked file; emulate it with an incremental ingest of the file
  const { execFileSync: ex } = require('node:child_process');
  ex('node', [CLI, 'ingest', r, '--full'], { env: ENV, stdio: 'pipe' });
  assert.ok(q("SELECT count(*) AS n FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'scratch.js' AND n.approval_status = 'APPROVED'")[0].n > 0);
  fs.rmSync(path.join(r, 'scratch.js'));
  ingest(r);
  assert.equal(q("SELECT count(*) AS n FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'scratch.js' AND n.approval_status = 'APPROVED'")[0].n, 0);
});

test('pruneMissingRepos: noted first, deleted after the grace period, restored folders stop the clock', async () => {
  const hyg = require('../src/services/store-hygiene');
  const pool = require('../src/db/pool');
  const r = path.join(TMP, 'gone1'); mkrepo(r, LIB); ingest(r);
  fs.rmSync(r, { recursive: true, force: true });
  const dry = await hyg.pruneMissingRepos(pool, { dryRun: true });
  assert.ok(dry.pending.some((p) => p.path === r), 'reported as missing');
  assert.equal(q('SELECT count(*) AS n FROM repositories WHERE full_path = ?', r)[0].n, 1, 'dry run deletes nothing');
  const t0 = Date.now();
  const first = await hyg.pruneMissingRepos(pool, { now: t0 });
  assert.equal(first.pruned.length, 0, 'first sighting only notes it');
  const later = await hyg.pruneMissingRepos(pool, { now: t0 + 8 * 24 * 3600e3 });
  assert.ok(later.pruned.some((p) => p.path === r), 'pruned after the grace period');
  assert.equal(q('SELECT count(*) AS n FROM repositories WHERE full_path = ?', r)[0].n, 0);
  assert.equal(q('SELECT count(*) AS n FROM nodes WHERE repository_branch_id NOT IN (SELECT id FROM repository_branches)')[0].n, 0, 'no orphan nodes');
});

test('gcArchivedNodes only removes archived nodes older than the window', async () => {
  const hyg = require('../src/services/store-hygiene');
  const pool = require('../src/db/pool');
  const r = path.join(TMP, 'gc'); mkrepo(r, LIB); ingest(r);
  git(r, 'rm', '-q', 'lib.js'); git(r, 'commit', '-qm', 'rm'); ingest(r);
  const archived = () => q("SELECT count(*) AS n FROM nodes WHERE approval_status = 'ARCHIVED'")[0].n;
  assert.ok(archived() > 0, 'deleting a file archives its nodes');
  assert.equal(await hyg.gcArchivedNodes(pool, { days: 14 }), 0, 'fresh archives are kept');
  const n = archived();
  assert.equal(await hyg.gcArchivedNodes(pool, { days: 14, now: Date.now() + 15 * 24 * 3600e3 }), n, 'old archives are collected');
  assert.equal(archived(), 0);
});

test('concurrent first ingests of different repos all succeed', async () => {
  const dirs = ['c1', 'c2', 'c3', 'c4'].map((n) => path.join(TMP, n));
  dirs.forEach((d, i) => mkrepo(d, { [`f${i}.js`]: `function fn${i}() { return ${i}; }\n`, 'x.js': 'function shared() {}\n' }));
  const { spawn } = require('node:child_process');
  const codes = await Promise.all(dirs.map((d) => new Promise((res) => {
    const p = spawn('node', [CLI, 'ingest', d, '--no-hooks'], { env: ENV, stdio: 'ignore' }); p.on('exit', res);
  })));
  assert.deepEqual(codes, [0, 0, 0, 0]);
});

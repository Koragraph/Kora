'use strict';
// Regressions from the 2026-10-02 launch-readiness graph run. Each test is a real repo + the real CLI against a scratch
// store (the same shape as graph-hardening.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'koragraph.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-harden2-')));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB; delete process.env.KORAGRAPH_PRACTICE_DB;
process.env.KORAGRAPH_FRESHNESS_TTL_MS = '1';
process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1000'; // synchronous catch-ups so the assertions see their result
const ENV = { ...process.env };

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe', encoding: 'utf8' });
function mkrepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
}
const ingest = (dir, ...extra) => execFileSync('node', [CLI, 'ingest', dir, '--no-hooks', ...extra], { env: ENV, stdio: 'pipe', encoding: 'utf8' });
function q(sql, ...p) { const D = require('better-sqlite3'); const d = new D(path.join(HOME, 'graph.db')); try { return d.prepare(sql).all(...p); } finally { d.close(); } }
const live = (name) => q("SELECT count(*) AS n FROM nodes WHERE name = ? AND approval_status != 'ARCHIVED'", name)[0].n;
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('an uncommitted edit that is reverted (checkout / stash) leaves no ghost declaration — query path and ingest path', async () => {
  const fresh = require('../src/services/live-freshness');
  const r = path.join(TMP, 'revert'); mkrepo(r, { 'a.js': 'function keepMe() { return 1; }\nmodule.exports = { keepMe };\n' });
  ingest(r);
  // 1. dirty edit → the query-time catch-up puts it in the graph
  fs.appendFileSync(path.join(r, 'a.js'), 'function dirtyOnly() { return 2; }\n');
  fresh.resetFreshnessCache(); await fresh.ensureRepoFresh({ cwd: r });
  assert.equal(live('dirtyOnly'), 1, 'the uncommitted declaration is caught up');
  // 2. revert it: git status is clean again, so the diff-driven check alone never looked at the file again
  git(r, 'checkout', '--', 'a.js');
  fresh.resetFreshnessCache(); await fresh.ensureRepoFresh({ cwd: r });
  assert.equal(live('dirtyOnly'), 0, 'reverted declaration is gone after the next repo-scoped read');
  assert.equal(live('keepMe'), 1, 'the committed declaration stays');
  // 3. same again, but healed by `ingest` (HEAD unchanged → the "nothing changed" path) instead of a query
  fs.appendFileSync(path.join(r, 'a.js'), 'function stashedFn() { return 3; }\n');
  fresh.resetFreshnessCache(); await fresh.ensureRepoFresh({ cwd: r });
  assert.equal(live('stashedFn'), 1);
  git(r, 'stash', '-q');
  ingest(r);
  assert.equal(live('stashedFn'), 0, '`ingest` at an unchanged HEAD drops a stashed edit');
  // 4. a file-scoped catch-up (ensureFilesFresh) is tracked the same way
  fs.appendFileSync(path.join(r, 'a.js'), 'function fileScoped() { return 4; }\n');
  fresh.resetFreshnessCache(); await fresh.ensureFilesFresh({ cwd: r, files: ['a.js'] });
  assert.equal(live('fileScoped'), 1);
  git(r, 'checkout', '--', 'a.js');
  fresh.resetFreshnessCache(); await fresh.ensureRepoFresh({ cwd: r });
  assert.equal(live('fileScoped'), 0, 'a file-scoped catch-up that was reverted is undone too');
  // and the bookkeeping does not grow: every handed path is back in sync and forgotten
  fresh.resetFreshnessCache(); await fresh.ensureRepoFresh({ cwd: r });
  assert.equal(q('SELECT count(*) AS n FROM freshness_handed')[0].n, 0, 'in-sync paths are forgotten');
});

test('a generated file with thousands of declarations indexes without the quadratic CONTAINS join', () => {
  // The trap needs planner statistics that say "file_id is selective" — a store that already holds an ordinary repo
  // (many small files) and was ANALYZEd by its full ingest, as every real store is.
  const many = {}; for (let i = 0; i < 400; i++) many[`m${i}.js`] = `function a${i}() {}\nfunction b${i}() { a${i}(); }\n`;
  const o = path.join(TMP, 'ordinary'); mkrepo(o, many); ingest(o);
  const r = path.join(TMP, 'generated'); fs.mkdirSync(r, { recursive: true });
  let body = ''; for (let i = 0; i < 12000; i++) body += `export function gen${i}() { return ${i}; }\n`;
  mkrepo(r, { 'api.ts': body });
  const res = require('node:child_process').spawnSync('node', [CLI, 'ingest', r, '--no-hooks'], { env: { ...ENV, KORAGRAPH_SLOW_SQL_MS: '3000' }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /\[slow-sql\][^\n]*'CONTAINS'/, 'the CONTAINS writer is not a multi-second statement (was 19 s at 20k declarations)');
  const contains = q(`SELECT count(*) AS n FROM edges e JOIN nodes t ON t.id = e.to_node_id JOIN files f ON f.id = t.file_id WHERE f.path = 'api.ts' AND e.edge_type = 'CONTAINS'`)[0].n;
  assert.ok(contains >= 12000, `every declaration has its CONTAINS edge (${contains})`);
});

test('a full index that died, followed by a commit, is rebuilt in full by the next ingest (not patched incrementally)', () => {
  const r = path.join(TMP, 'diedthencommit'); mkrepo(r, { 'a.js': 'function firstFn() { return 1; }\n' });
  ingest(r);
  const D = require('better-sqlite3'); const d = new D(path.join(HOME, 'graph.db'));
  d.prepare("UPDATE ingest_jobs SET status = 'FAILED' WHERE local_path = ?").run(r); d.close();
  fs.writeFileSync(path.join(r, 'b.js'), 'function secondFn() { return 2; }\n'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'more');
  const res = require('node:child_process').spawnSync('node', [CLI, 'ingest', r, '--no-hooks'], { env: ENV, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /never finished .* re-indexing in full/);
  assert.equal(q("SELECT status FROM ingest_jobs WHERE local_path = ? AND coalesce(job_type, 'FULL') != 'INCREMENTAL' ORDER BY id DESC LIMIT 1", r)[0].status, 'COMPLETE');
});

test('a repo with a .swift file indexes (the grammar used to abort the process: V8 "Fatal process out of memory: Zone")', () => {
  const r = path.join(TMP, 'swifty'); mkrepo(r, { 'App.swift': 'func swiftFn() -> Int { return swiftHelper() }\nfunc swiftHelper() -> Int { return 1 }\n', 'a.js': 'function jsFn() {}\n' });
  const res = require('node:child_process').spawnSync('node', [CLI, 'ingest', r, '--no-hooks'], { env: ENV, encoding: 'utf8' });
  assert.equal(res.status, 0, `exit ${res.status} ${res.stderr.slice(0, 300)}`);
  assert.equal(live('swiftFn'), 1, 'the bin re-runs under --liftoff-only, so swift is parsed');
  // a process WITHOUT the flag (an embedder, a daemon worker) never loads the grammar: no abort, the file is just shallower
  const r2 = path.join(TMP, 'swifty2'); mkrepo(r2, { 'B.swift': 'func otherSwift() -> Int { return 2 }\n' });
  const res2 = require('node:child_process').spawnSync('node', [CLI, 'ingest', r2, '--no-hooks'], { env: { ...ENV, KORA_NO_LIFTOFF_REEXEC: '1' }, encoding: 'utf8' });
  assert.equal(res2.status, 0, `exit ${res2.status} ${res2.stderr.slice(0, 300)}`);
});

test('git re-index hooks carry the installing runtime\'s store env (a Kora Dev hook must not index into the default store)', () => {
  const gh = require('../src/services/git-hooks');
  const cmd = gh.reindexCommand({ nodeBin: '/n/node', cliEntry: '/k/kora.js', repoPath: '/r', project: 'default', env: { KORAGRAPH_DB: "/h/it's/graph.db", KORA_HOME: '/h' } });
  assert.match(cmd, /KORAGRAPH_DB='\/h\/it'\\''s\/graph\.db' KORA_HOME='\/h' '\/n\/node' '\/k\/kora\.js' ingest '\/r'/);
  assert.doesNotMatch(gh.reindexCommand({ nodeBin: '/n', cliEntry: '/k', repoPath: '/r', project: 'p' }), /=/, 'no env → the block is byte-identical to before');
});

test('a dirty .swift file caught up by a process WITHOUT --liftoff-only is handed to the flagged child, not stored empty', async () => {
  const fresh = require('../src/services/live-freshness');
  const r = path.join(TMP, 'swiftdirty'); mkrepo(r, { 'App.swift': 'func baseSwift() -> Int { return 1 }\n' });
  ingest(r);
  assert.equal(live('baseSwift'), 1);
  fs.appendFileSync(path.join(r, 'App.swift'), 'func addedSwift() -> Int { return 2 }\n');
  assert.ok(!process.execArgv.includes('--liftoff-only'), 'this test process is the no-flag case');
  fresh.resetFreshnessCache(); await fresh.ensureFilesFresh({ cwd: r, files: ['App.swift'] });
  await fresh.settleCatchUps();
  assert.equal(live('addedSwift'), 1, 'the detached child (with the flag) extracted it');
  assert.equal(live('baseSwift'), 1);
});

test('an edit to a Kotlin / Swift / Zig file reaches the graph on the next incremental (they used to need --full)', () => {
  const r = path.join(TMP, 'grammaronly');
  mkrepo(r, { 'A.kt': 'fun kotlinOld(): Int { return 1 }\n', 'B.swift': 'func swiftOld() -> Int { return 1 }\n', 'c.zig': 'fn zigOld() i32 { return 1; }\n' });
  ingest(r);
  for (const n of ['kotlinOld', 'swiftOld', 'zigOld']) assert.equal(live(n), 1, `${n} indexed by the full run`);
  fs.writeFileSync(path.join(r, 'A.kt'), 'fun kotlinNew(): Int { return 2 }\n');
  fs.writeFileSync(path.join(r, 'B.swift'), 'func swiftNew() -> Int { return 2 }\n');
  fs.writeFileSync(path.join(r, 'c.zig'), 'fn zigNew() i32 { return 2; }\n');
  git(r, 'commit', '-qam', 'rename');
  const out = ingest(r);
  assert.match(out, /incremental/);
  for (const n of ['kotlinNew', 'swiftNew', 'zigNew']) assert.equal(live(n), 1, `${n} extracted incrementally`);
  for (const n of ['kotlinOld', 'swiftOld', 'zigOld']) assert.equal(live(n), 0, `${n} retired`);
});

test('a --full re-index retires a generic-AST file\'s renamed declarations too', () => {
  const r = path.join(TMP, 'grammarfull'); mkrepo(r, { 'S.swift': 'func swiftFirst() -> Int { return 1 }\n' });
  ingest(r);
  fs.writeFileSync(path.join(r, 'S.swift'), 'func swiftSecond() -> Int { return 2 }\n'); git(r, 'commit', '-qam', 'r');
  ingest(r, '--full');
  assert.equal(live('swiftSecond'), 1); assert.equal(live('swiftFirst'), 0);
});

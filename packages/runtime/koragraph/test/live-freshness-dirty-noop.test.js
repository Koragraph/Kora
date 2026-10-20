'use strict';

// ensureRepoFresh on a DIRTY repo must be a no-op when the graph already holds the dirty file's CONTENT.
//
// `git status` lists an uncommitted file on every call for as long as it stays uncommitted. Before the
// content compare, each repo-scoped graph read more than TTL_MS apart re-ran a full incremental ingest
// for the whole dirty set (and its unscoped edge-resolution tail): measured 17–25 s per `explore` on a
// repo with 10 dirty files, vs 0.3 s warm — the prompt-injection hook's 7 s budget was blown on every
// dirty working tree. Real store, real ingest, real git: count ingest_jobs rows between calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dirty-noop-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME;
process.env.KORAGRAPH_FRESHNESS_TTL_MS = '1'; // every call re-evaluates; the content compare must do the saving
process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1000'; // synchronous catch-ups for the compare assertions; the last test flips it
delete process.env.KORAGRAPH_DB;

const MAIN = path.join(TMP, 'app');
const REL = 'src/target.js';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });

function jobCount() {
  const { openGraphDb } = require('../src/practice/resolve');
  const gdb = openGraphDb();
  try { return gdb.prepare("SELECT count(*) AS n FROM ingest_jobs WHERE job_type = 'INCREMENTAL'").get().n; }
  finally { try { gdb.close(); } catch { /* gone */ } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(() => {
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, REL), 'export function target(x) {\n  return x + 1;\n}\n');
  fs.writeFileSync(path.join(MAIN, 'src/caller.js'), "import { target } from './target.js';\nexport const run = () => target(1);\n");
  git(MAIN, 'init', '-q');
  git(MAIN, 'remote', 'add', 'origin', 'https://github.com/test/dirty-noop.git');
  git(MAIN, 'add', '-A');
  git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial');
  execFileSync('node', [CLI, 'ingest', MAIN], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });
});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

test('a dirty file is caught up ONCE, then every later repo-fresh call is a no-op while its content stands', async () => {
  const fresh = require('../src/services/live-freshness');
  const before = jobCount();
  // clean tree: no job
  await fresh.ensureRepoFresh({ cwd: MAIN });
  assert.equal(jobCount(), before, 'clean working tree → no incremental job');

  // dirty the file (uncommitted) → exactly one catch-up
  fs.writeFileSync(path.join(MAIN, REL), 'export function target(x) {\n  return x + 42; // uncommitted edit\n}\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  const afterFirst = jobCount();
  assert.equal(afterFirst, before + 1, 'first read after the edit runs one incremental catch-up');

  // still dirty, same content → git status still lists it → must NOT re-ingest
  for (let i = 0; i < 3; i++) { await sleep(5); await fresh.ensureRepoFresh({ cwd: MAIN }); }
  assert.equal(jobCount(), afterFirst, 'same uncommitted content on later calls → no new incremental job');

  // a NEW edit to the same file → one more catch-up, then quiet again
  fs.writeFileSync(path.join(MAIN, REL), 'export function target(x) {\n  return x + 43; // second uncommitted edit\n}\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  assert.equal(jobCount(), afterFirst + 1, 'changed content → exactly one more catch-up');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  assert.equal(jobCount(), afterFirst + 1, 'and quiet again');

  // an untracked file the ingest does not store must not be resubmitted on every call either
  fs.writeFileSync(path.join(MAIN, 'notes.unknownext'), 'not source\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  const afterUntracked = jobCount();
  for (let i = 0; i < 3; i++) { await sleep(5); await fresh.ensureRepoFresh({ cwd: MAIN }); }
  assert.equal(jobCount(), afterUntracked, 'an unstorable untracked file is submitted at most once per process');

  // …and at most once ACROSS processes: a fresh process (a hook, a CLI call, an MCP server) must not re-submit it
  const child = `require(${JSON.stringify(path.join(REPO, 'src/services/live-freshness.js'))}).ensureRepoFresh({ cwd: ${JSON.stringify(MAIN)} }).then(() => process.exit(0), () => process.exit(1))`;
  for (let i = 0; i < 2; i++) execFileSync('node', ['-e', child], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });
  assert.equal(jobCount(), afterUntracked, 'a new process does not re-ingest a dirty set the store already holds');
});

test('a dirty set above KORAGRAPH_FRESHNESS_MAX_SYNC_FILES is caught up by a detached child: the read returns at once, the job lands later', async () => {
  const fresh = require('../src/services/live-freshness');
  process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1';
  try {
    const before = jobCount();
    for (const f of ['src/x1.js', 'src/x2.js', 'src/x3.js']) fs.writeFileSync(path.join(MAIN, f), `export function ${f.slice(4, 6)}(a) { return a + 1; }\n`);
    await sleep(5);
    const t0 = Date.now();
    await fresh.ensureRepoFresh({ cwd: MAIN });
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `returned immediately (${ms} ms)`);
    await fresh.settleCatchUps();
    assert.equal(jobCount(), before + 1, 'the catch-up ran in the background exactly once');
    await sleep(5);
    await fresh.ensureRepoFresh({ cwd: MAIN });
    await fresh.settleCatchUps();
    assert.equal(jobCount(), before + 1, 'and is not repeated for the same content');
  } finally { process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1000'; }
});

// Audit 2026-10-15 #1: a file edited while a background catch-up was already running was recorded as "handed" without
// being caught up, and every later read skipped it — the graph kept its old declarations for as long as it stayed dirty.
test('a file edited while a catch-up is in flight is caught up by a later read, not marked handed and skipped', async () => {
  const fresh = require('../src/services/live-freshness');
  process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '0';
  const storedSha = (rel) => {
    const { openGraphDb } = require('../src/practice/resolve');
    const gdb = openGraphDb();
    try { return gdb.prepare("SELECT file_sha FROM files WHERE path = ? AND index_status != 'REMOVED'").get(rel)?.file_sha ?? null; }
    finally { try { gdb.close(); } catch { /* gone */ } }
  };
  const diskSha = (rel) => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(MAIN, rel), 'utf8')).digest('hex').slice(0, 40);
  try {
    fs.writeFileSync(path.join(MAIN, 'src/inflight-a.js'), 'export function inflightA() { return 1; }\n');
    await sleep(5);
    await fresh.ensureRepoFresh({ cwd: MAIN }); // spawns the child for inflight-a
    fs.writeFileSync(path.join(MAIN, 'src/inflight-b.js'), 'export function inflightB() { return 2; }\n');
    await sleep(5);
    await fresh.ensureRepoFresh({ cwd: MAIN }); // child still running: inflight-b must not be recorded as handed
    await fresh.settleCatchUps();
    await sleep(5);
    await fresh.ensureRepoFresh({ cwd: MAIN }); // picks up inflight-b
    await fresh.settleCatchUps();
    assert.equal(storedSha('src/inflight-b.js'), diskSha('src/inflight-b.js'), 'the file edited mid-catch-up reaches the graph');
  } finally { process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1000'; }
});

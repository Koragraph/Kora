'use strict';
// The post-ingest tail on an INCREMENTAL run must not re-run project-wide passes a small edit cannot affect.
// Measured before: a one-file comment edit cost 15 s — resolveProjectCrossRepoEdges 6.0 s + resolveHttpClientEdges
// 4.4 s, both project-wide. Now: the HTTP pass is scoped to the touched files, the cross-repo pass runs only for a
// change that can plausibly alter cross-repo edges (manifest / proto / API spec, a removed file, a touched file that
// declares an ENDPOINT / DEPENDENCY / DB_TABLE / …) or when it last ran over 30 minutes ago.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tail-'));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;
process.env.KORAGRAPH_FRESHNESS_TTL_MS = '1';
process.env.KORAGRAPH_FRESHNESS_MAX_SYNC_FILES = '1000';
const MAIN = path.join(TMP, 'app');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(() => {
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  fs.writeFileSync(path.join(MAIN, 'src/a.js'), 'export function a(x) { return x + 1; }\n');
  fs.writeFileSync(path.join(MAIN, 'src/b.js'), "import { a } from './a.js';\nexport const b = () => a(1);\n");
  fs.writeFileSync(path.join(MAIN, 'package.json'), '{ "name": "tail-fixture", "version": "1.0.0" }\n');
  git(MAIN, 'init', '-q'); git(MAIN, 'add', '-A'); git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  execFileSync('node', [CLI, 'ingest', MAIN], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });
});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('a comment edit runs the HTTP pass scoped and skips the project-wide cross-repo pass; a manifest edit runs it', async () => {
  const fresh = require('../src/services/live-freshness');
  const tail = require('../src/services/ingest-post-tail');
  const ingest = require('../src/services/ingest');
  const { setMaint } = require('../src/db/maintenance');
  const pool = require('../src/db/pool');
  // the floor: pretend the cross-repo pass ran just now for every project
  const { rows } = await pool.query('SELECT id FROM projects');
  for (const r of rows) setMaint(pool, `cross_repo_at:${r.id}`, Date.now());

  fs.appendFileSync(path.join(MAIN, 'src/a.js'), '\n// a comment\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  const plan = tail.lastTailPlan();
  assert.ok(plan && plan.mode === 'incremental', `an incremental tail ran (${JSON.stringify(plan)})`);
  assert.equal(plan.httpScoped, true, `HTTP-client pass scoped to the touched files (${JSON.stringify(plan)})`);
  assert.equal(plan.projectCrossRepoStale, false, `project-wide cross-repo pass skipped for a comment edit (${JSON.stringify(ingest.lastCrossRepoDecision())})`);
  assert.equal(ingest.lastCrossRepoDecision().run, false, JSON.stringify(ingest.lastCrossRepoDecision()));

  fs.writeFileSync(path.join(MAIN, 'package.json'), '{ "name": "tail-fixture", "version": "1.0.1", "dependencies": { "left-pad": "1.0.0" } }\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  const d = ingest.lastCrossRepoDecision();
  assert.equal(d.run, true, `a manifest change runs it (${JSON.stringify(d)})`);
  assert.equal(d.reason, 'manifest');

  // the 30-minute floor
  for (const r of rows) setMaint(pool, `cross_repo_at:${r.id}`, Date.now() - 31 * 60 * 1000);
  fs.appendFileSync(path.join(MAIN, 'src/b.js'), '\n// another comment\n');
  await sleep(5);
  await fresh.ensureRepoFresh({ cwd: MAIN });
  assert.equal(ingest.lastCrossRepoDecision().reason, 'floor');
});

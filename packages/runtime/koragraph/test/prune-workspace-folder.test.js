'use strict';
// A plain folder indexed for its loose files, with checkouts inside it (~/Projects/koraplex: 77 nodes of notes around
// kora/, kora-dev/ …), answered "NO DECLARATION NAMED X EXISTS" for every real symbol to agents opened there. prune drops
// such a row at once (the folder is present, there is nothing to wait for) and leaves the checkouts alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-wsprune-')));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;
const WS = path.join(TMP, 'workspace'); const APP = path.join(WS, 'app'); const LONE = path.join(TMP, 'lone');
const ingest = (d) => execFileSync('node', [CLI, 'ingest', d], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('prune drops a plain folder that holds indexed checkouts, keeps the checkouts and a plain folder that holds none', async () => {
  fs.mkdirSync(APP, { recursive: true }); fs.mkdirSync(LONE, { recursive: true });
  fs.writeFileSync(path.join(WS, 'notes.js'), 'function looseNote() { return 0; }\n');
  fs.writeFileSync(path.join(LONE, 'l.js'), 'function loneFn() { return 2; }\n');
  fs.writeFileSync(path.join(APP, 'x.js'), 'function realSymbol() { return 1; }\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: APP, stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'i');
  ingest(WS); ingest(APP); ingest(LONE);

  const pool = require('../src/db/pool');
  const hyg = require('../src/services/store-hygiene');
  const found = await hyg.findMissingRepos(pool);
  assert.deepEqual(found.map((r) => [r.full_path, r.reason]), [[WS, 'holds-checkouts']]);
  const dry = await hyg.pruneMissingRepos(pool, { dryRun: true });
  assert.deepEqual(dry.pruned.map((p) => p.path), [WS], 'reported at once, no grace period');
  const { rows: still } = await pool.query('SELECT full_path FROM repositories ORDER BY full_path');
  assert.equal(still.length, 3, 'a dry run deletes nothing');
  const res = await hyg.pruneMissingRepos(pool, {});
  assert.deepEqual([res.pruned.map((p) => p.path), res.pending], [[WS], []]);
  const { rows } = await pool.query('SELECT full_path FROM repositories ORDER BY full_path');
  assert.deepEqual(rows.map((r) => r.full_path), [APP, LONE].sort());
});

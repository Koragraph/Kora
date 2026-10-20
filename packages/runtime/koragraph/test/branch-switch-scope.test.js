'use strict';
// A checkout that switches branch gets a second repository_branches row (one per branch name), and both stayed
// is_tracked. Every repo-scoped query (branchIdsByRepoName / orgBranchIds filter on is_tracked) then answered from the
// UNION: found 2026-10-15 on the kora repo, `neighbours graphReady` listed the declaration twice (L289 from the stale
// `feature` branch's row, L306 from `main`) and a caller that no longer existed. A repository row is one checkout and a checkout is
// on one branch, so a completed ingest of a branch now leaves only that branch tracked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-branch-'));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;
const APP = path.join(TMP, 'app');
const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: APP, stdio: 'pipe', encoding: 'utf8' });
const ingest = (...a) => execFileSync('node', [CLI, 'ingest', APP, ...a], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: 'pipe' });

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('after a branch switch + ingest, only the checked-out branch is tracked, so a repo-scoped query sees one declaration', async () => {
  fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'src/a.js'), 'export function graphReady(x) { return !!x; }\n');
  git('init', '-q', '-b', 'old'); git('add', '-A'); git('commit', '-qm', 'init');
  ingest();
  git('checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(APP, 'src/a.js'), '// moved down\n\n\nexport function graphReady(x) { return !!x; }\n');
  git('commit', '-qam', 'move');
  ingest('--full'); // a full index (the chip's "Full re-index", or a rebuild after a failed run) writes a row per branch name

  const pool = require('../src/db/pool');
  const gts = require('../src/services/graph-tool-service');
  const { rows } = await pool.query("SELECT rb.branch_name, rb.is_tracked FROM repository_branches rb JOIN repositories r ON r.id = rb.repository_id WHERE r.full_path IN ($1, $2) ORDER BY rb.id", [APP, fs.realpathSync(APP)]);
  assert.deepEqual(rows.map((r) => [r.branch_name, Number(r.is_tracked)]), [['old', 0], ['main', 1]], 'the stale branch row is kept but untracked');
  const ids = await gts.branchIdsByRepoName(1, 'app');
  assert.equal(ids.length, 1, `repo scope is one branch, not the union (${JSON.stringify(ids)})`);
  const { rows: decl } = await pool.query("SELECT start_line FROM nodes WHERE name = 'graphReady' AND approval_status != 'ARCHIVED' AND repository_branch_id IN (SELECT value FROM json_each($1))", [JSON.stringify(ids)]);
  assert.deepEqual(decl.map((d) => d.start_line), [4], 'only the current declaration');

  // the next catch-up (incremental) lands on the tracked row, not on the oldest one
  fs.writeFileSync(path.join(APP, 'src/a.js'), '// moved further\n\n\n\n\nexport function graphReady(x) { return !!x; }\n');
  git('commit', '-qam', 'again');
  ingest();
  const { rows: inc } = await pool.query("SELECT rb.branch_name, n.start_line FROM nodes n JOIN repository_branches rb ON rb.id = n.repository_branch_id WHERE n.name = 'graphReady' AND n.approval_status != 'ARCHIVED' AND rb.is_tracked = 1");
  assert.deepEqual(inc.map((r) => [r.branch_name, r.start_line]), [['main', 6]], 'the incremental updated main, the tracked row');
});

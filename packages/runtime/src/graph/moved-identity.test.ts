// Audit 2026-10-15 #2: a store row whose folder is gone was taken as "this repo, moved" on its BASENAME alone, so an
// unrelated `~/new/app` you never indexed matched a deleted `~/old/app`: staleForCheckout, a silent full index on pane
// open, and the old repo's lines injected. A moved repo is recognised by identity (its indexed commit is here) instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-moved-')));
process.env.KORA_HOME = path.join(home, 'kh'); process.env.KORAGRAPH_HOME = path.join(home, 'kg');
delete process.env.KORAGRAPH_DB; delete process.env.KORAGRAPH_PRACTICE_DB;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_INJECT_LOG = '0';
test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function repo(dir: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'x.js'), body);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'i'); return dir;
}
const kgBin = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');

test('a same-named unrelated repo is not the deleted one; the same repo moved still is', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const old = repo(path.join(home, 'old', 'app'), 'function onlyInOld() { return 1; }\n');
  const r = spawnSync('node', [kgBin, 'ingest', old, '--no-hooks'], { env: process.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);

  // the indexed folder moves away; a different repo with the same basename appears elsewhere
  const moved = path.join(home, 'moved', 'app'); fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.renameSync(old, moved);
  const other = repo(path.join(home, 'new', 'app'), 'function onlyInNew() { return 2; }\n');

  const g = createGraphService();
  const st = await g.status(other, { nocache: true });
  assert.equal(st.indexed, false, 'the unrelated repo has no index');
  assert.ok(!st.indexedFrom && !st.staleForCheckout, `not matched to the deleted repo's row (${st.indexedFrom})`);

  const sm = await g.status(moved, { nocache: true });
  assert.equal(sm.indexed, true, 'the moved repo still finds its own index');
  assert.equal(sm.indexedFrom, old);

  // engine side: an explicit index of the unrelated repo gets its own row instead of taking over the moved one's
  const rn = require(path.resolve(__dirname, '..', '..', 'koragraph', 'src', 'services', 'repo-name.js'));
  const pool = require(path.resolve(__dirname, '..', '..', 'koragraph', 'src', 'db', 'pool.js'));
  const { rows } = await pool.query('SELECT project_id FROM repositories LIMIT 1');
  assert.notEqual(await rn.resolveRepoName(pool, rows[0].project_id, other), 'app');
  assert.equal(await rn.resolveRepoName(pool, rows[0].project_id, moved), 'app');

  // a row that recorded no commit cannot prove identity: the engine rejects it, like the runtime's movedRow
  await pool.query('UPDATE repository_branches SET last_commit_sha = NULL');
  assert.notEqual(await rn.resolveRepoName(pool, rows[0].project_id, moved), 'app');
  const sn = await g.status(moved, { nocache: true });
  assert.ok(!sn.indexedFrom, 'nor does the runtime adopt it');
});

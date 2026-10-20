'use strict';
// Deep audit 2026-10-13 A2-2: two first ingests of different checkouts with the same folder name (`p1/app`, `p2/app`)
// started together both picked the name `app` and shared one repository row; one checkout lost its index for good.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'koragraph.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-namerace-')));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
function mkrepo(dir, file, body) {
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
}
const ingest = (dir, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, 'ingest', dir, '--no-hooks'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('exit', (code) => resolve({ code, err }));
});

test('same-named checkouts indexed at the same moment get one row each, and both keep their index', async () => {
  for (let round = 0; round < 2; round++) {
    const home = path.join(TMP, `home${round}`); fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, KORAGRAPH_HOME: home }; delete env.KORAGRAPH_DB; delete env.KORAGRAPH_PRACTICE_DB;
    const a = path.join(TMP, `r${round}`, 'p1', 'app'); const b = path.join(TMP, `r${round}`, 'p2', 'app');
    mkrepo(a, 'a.js', 'function onlyInA() { return 1; }\nmodule.exports = { onlyInA };\n');
    mkrepo(b, 'b.js', 'function onlyInB() { return 2; }\nmodule.exports = { onlyInB };\n');
    const rs = await Promise.all([ingest(a, env), ingest(b, env)]);
    assert.deepEqual(rs.map((r) => r.code), [0, 0], rs.map((r) => r.err.slice(-300)).join('\n'));
    const D = require('better-sqlite3'); const d = new D(path.join(home, 'graph.db'), { readonly: true });
    try {
      const rows = d.prepare('SELECT name, full_path FROM repositories ORDER BY name').all();
      assert.equal(rows.length, 2, JSON.stringify(rows));
      assert.deepEqual(rows.map((r) => r.full_path).sort(), [a, b].sort());
      for (const fn of ['onlyInA', 'onlyInB']) assert.equal(d.prepare("SELECT count(*) AS n FROM nodes WHERE name = ? AND approval_status != 'ARCHIVED'").get(fn).n, 1, fn);
    } finally { d.close(); }
  }
});

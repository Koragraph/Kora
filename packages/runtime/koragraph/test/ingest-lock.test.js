'use strict';
// Two runs on one repo must serialise (services/ingest-lock.js). Real store, real ingest, real child processes:
// two `koragraph catch-up` children race on the same dirty file; both must finish, and the graph must equal what a
// single clean run produces (a concurrent generation flip used to drop the other run's edges).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lock-'));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME; delete process.env.KORAGRAPH_DB;
const MAIN = path.join(TMP, 'app');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
const env = { ...process.env, KORAGRAPH_HOME: HOME };

function counts() {
  const { openGraphDb } = require('../src/practice/resolve');
  const db = openGraphDb();
  try {
    return { nodes: db.prepare("SELECT count(*) AS n FROM nodes WHERE approval_status != 'ARCHIVED'").get().n, edges: db.prepare("SELECT count(*) AS n FROM edges e JOIN nodes a ON a.id = e.from_node_id WHERE a.approval_status != 'ARCHIVED' AND e.edge_type != 'CO_CHANGES'").get().n, jobs: db.prepare("SELECT count(*) AS n FROM ingest_jobs WHERE job_type = 'INCREMENTAL'").get().n };
  } finally { try { db.close(); } catch { /* fine */ } }
}
const run = (args) => new Promise((resolve) => { const c = spawn('node', [CLI, ...args], { env, stdio: 'ignore' }); c.on('exit', (code) => resolve(code)); });

test.before(() => {
  fs.mkdirSync(path.join(MAIN, 'src'), { recursive: true });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(MAIN, `src/m${i}.js`), `import { f${(i + 1) % 6} } from './m${(i + 1) % 6}.js';\nexport function f${i}(x) { return f${(i + 1) % 6}(x) + ${i}; }\n`);
  git(MAIN, 'init', '-q'); git(MAIN, 'add', '-A'); git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  execFileSync('node', [CLI, 'ingest', MAIN], { env, stdio: 'pipe' });
});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

test('two concurrent catch-ups of the same repo serialise and leave the graph as one clean run would', async () => {
  const clean = counts();
  fs.appendFileSync(path.join(MAIN, 'src/m0.js'), '\n// edit\n');
  const changed = JSON.stringify(['src/m0.js']);
  const codes = await Promise.all([run(['catch-up', '--repo', MAIN, '--changed', changed]), run(['catch-up', '--repo', MAIN, '--changed', changed])]);
  assert.deepEqual(codes, [0, 0], 'both children exit cleanly');
  const after = counts();
  assert.equal(after.nodes, clean.nodes, `nodes unchanged by a comment edit (${clean.nodes} → ${after.nodes})`);
  assert.equal(after.edges, clean.edges, `edges unchanged by a comment edit (${clean.edges} → ${after.edges})`);
  assert.equal(after.jobs - clean.jobs, 2, 'two jobs ran, one after the other');
  const { lockFile } = require('../src/services/ingest-lock');
  assert.ok(!fs.existsSync(lockFile(MAIN)), 'lock released');
});

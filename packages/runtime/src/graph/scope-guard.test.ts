// A query from a repo that is not (fully) in the store must say so — never answer from another repo's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-scope-')));
process.env.KORA_HOME = path.join(home, 'kh'); process.env.KORAGRAPH_HOME = path.join(home, 'kg');
delete process.env.KORAGRAPH_DB; delete process.env.KORAGRAPH_PRACTICE_DB;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_INJECT_LOG = '0';
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function repo(name: string, body: string): string {
  const d = path.join(home, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x.js'), body);
  git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'i'); return d;
}
const kg = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');
const ingest = (d: string) => { const r = spawnSync('node', [kg, 'ingest', d, '--no-hooks'], { env: process.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

test('unindexed repo: graph tools refuse instead of answering from another repo; indexed repo is unaffected', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const a = repo('indexed', 'function onlyInIndexed() { return 1; }\n');
  const b = repo('fresh', 'function onlyInFresh() { return 2; }\n');
  ingest(a);
  const g = createGraphService();
  await assert.rejects(() => g.callTool('search_code', { query: 'onlyInIndexed' }, { cwd: b }), /not indexed/);
  const ok = await g.callTool('search_code', { query: 'onlyInIndexed' }, { cwd: a });
  assert.match(ok.text, /onlyInIndexed/);
  const all = await g.callTool('search_code', { query: 'onlyInIndexed', project_id: null }, { cwd: b });
  assert.match(all.text, /onlyInIndexed/, '--repo all still asks the whole store on purpose');
});

test('a full index that failed is incomplete: status says so and queries refuse', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const c = repo('halfdone', 'function halfFn() { return 3; }\n');
  ingest(c);
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.KORAGRAPH_HOME as string, 'graph.db'));
  db.prepare("UPDATE ingest_jobs SET status = 'FAILED' WHERE local_path = ?").run(c); db.close();
  const g = createGraphService();
  const st = await g.status(c);
  assert.equal(st.incomplete, true); assert.equal(st.indexed, false);
  await assert.rejects(() => g.callTool('search_code', { query: 'halfFn' }, { cwd: c }), /incomplete/);
});

test('a first full index still running is not an index yet: status says so, queries refuse, the Grep redirect stands down', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const c = repo('building', 'function buildFn() { return 4; }\n');
  ingest(c);
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.KORAGRAPH_HOME as string, 'graph.db'));
  // Rewind the store to "first full index in flight": its only full job RUNNING, a live process holding the lock.
  db.prepare("UPDATE ingest_jobs SET status = 'RUNNING', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE local_path = ?").run(c); db.close();
  const lock = await require('../../koragraph/src/services/ingest-lock.js').acquire(c, { wait: 0 });
  try {
    const g = createGraphService();
    const st = await g.status(c);
    assert.equal(st.indexed, false); assert.equal(st.firstIndexRunning, true); assert.equal(st.incomplete, undefined);
    await assert.rejects(() => g.callTool('search_code', { query: 'buildFn' }, { cwd: c }), (e: any) => e.code === 'indexing');
    const { graphReady } = require('../cli/commands/hook') as typeof import('../cli/commands/hook');
    assert.equal(graphReady(c), false, 'no Grep deny toward a graph that would refuse');
  } finally { lock?.release(); }
});

test('an indexed plain (non-git) folder answers for its subfolders; an unindexed non-git cwd refuses instead of searching the whole store', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const plain = path.join(home, 'plain'); fs.mkdirSync(path.join(plain, 'deep', 'er'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'deep', 'er', 'p.js'), 'function plainOnly() { return 5; }\n');
  ingest(plain);
  const g = createGraphService();
  const st = await g.status(path.join(plain, 'deep'));
  assert.equal(st.indexed, true); assert.equal(st.repoRoot, plain);
  const ok = await g.callTool('search_code', { query: 'plainOnly' }, { cwd: path.join(plain, 'deep', 'er') });
  assert.match(ok.text, /plainOnly/);
  const nowhere = path.join(home, 'nowhere'); fs.mkdirSync(nowhere, { recursive: true });
  await assert.rejects(() => g.callTool('search_code', { query: 'plainOnly' }, { cwd: nowhere }), (e: any) => e.code === 'not_indexed');
});

test('a full index killed mid-run (RUNNING row, nobody holding the lock, quiet for a while) is incomplete — never "Fresh"', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const c = repo('killed', 'function killedFn() { return 6; }\n');
  ingest(c);
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.KORAGRAPH_HOME as string, 'graph.db'));
  db.prepare("UPDATE ingest_jobs SET status = 'RUNNING', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes') WHERE local_path = ?").run(c); db.close();
  const st = await createGraphService().status(c);
  assert.equal(st.incomplete, true); assert.equal(st.indexed, false); assert.equal(st.firstIndexRunning, undefined);
});

test('a miss on a symbol that only exists in an uncommitted edit says where it is, instead of a bare negative', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const r = repo('dirtymiss', 'function oldFn() { return 1; }\n');
  ingest(r);
  fs.appendFileSync(path.join(r, 'x.js'), 'function freshlyWritten() { return 2; }\n');
  const g = createGraphService();
  const res = await g.callTool('search_code', { query: 'freshlyWritten' }, { cwd: r, fresh: false }); // the index as it stood
  assert.match(res.text, /freshlyWritten is declared in x\.js, an uncommitted change/);
  const hit = await g.callTool('search_code', { query: 'oldFn' }, { cwd: r, fresh: false });
  assert.doesNotMatch(hit.text, /uncommitted change/, 'no note when the graph has the declaration');
});

// B2 (night 2026-10-04): a symbol COMMITTED after the last index (HEAD moved) got a confident "(nothing)" on the first
// query — the catch-up runs detached. Say where it is, like an uncommitted edit.
test('a miss on a symbol committed after the last index says where it is', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const r = repo('stalemiss', 'function beforeIndex() { return 1; }\n');
  ingest(r);
  fs.writeFileSync(path.join(r, 'y.js'), 'function committedLater() { return 2; }\n');
  git(r, 'add', '.'); git(r, 'commit', '-qm', 'later');
  const g = createGraphService();
  const res = await g.callTool('search_code', { query: 'committedLater' }, { cwd: r, fresh: false });
  assert.match(res.text, /committedLater is declared in y\.js, committed after the graph was last indexed \(at [0-9a-f]{7}\)/);
  const hit = await g.callTool('search_code', { query: 'beforeIndex' }, { cwd: r, fresh: false });
  assert.doesNotMatch(hit.text, /committed after/, 'no note when the graph has the declaration');
});

// At exit, not test.after: koragraph's file logger still flushes into <home>/kg/logs after the last test ends.
process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });

test('a plain folder of checkouts never answers from its own loose-file index: it refuses and names the checkouts', async () => {
  const { createGraphService } = require('./service') as typeof import('./service');
  const ws = path.join(home, 'workspace'); fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes.js'), 'function looseNote() { return 0; }\n');
  ingest(ws); // indexed as a plain folder first, then a checkout appears inside it (the ~/Projects/koraplex shape)
  const app = path.join(ws, 'app'); fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'x.js'), 'function realSymbol() { return 1; }\n');
  git(app, 'init', '-q', '-b', 'main'); git(app, 'add', '.'); git(app, 'commit', '-qm', 'i');
  ingest(app);
  const g = createGraphService();
  const st = await g.status(ws);
  assert.notEqual(st.repoRoot, ws, 'the workspace index is not the graph for the workspace');
  await assert.rejects(() => g.callTool('search_code', { query: 'realSymbol' }, { cwd: ws }),
    (e: any) => e.code === 'not_indexed' && /folder of checkouts/.test(e.message) && /app \(--repo app\)/.test(e.message) && !/NO DECLARATION/.test(e.message));
  const inApp = await g.callTool('search_code', { query: 'realSymbol' }, { cwd: app });
  assert.match(inApp.text, /realSymbol/, 'the checkout itself is unaffected');
  const byName = await g.callTool('search_code', { query: 'realSymbol', project_id: 'app' }, { cwd: ws });
  assert.match(byName.text, /realSymbol/, 'the --repo name the refusal suggests works from the workspace');
});

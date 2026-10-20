// A graph store SQLite cannot open (garbage / truncated file): status says so, tools say so (not "not indexed"), and the
// next ingest moves it aside and rebuilds instead of failing every time with "file is not a database".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-damage-')));
process.env.KORAGRAPH_HOME = path.join(home, 'kg'); fs.mkdirSync(process.env.KORAGRAPH_HOME, { recursive: true });
process.env.KORAGRAPH_DB = path.join(process.env.KORAGRAPH_HOME, 'graph.db');
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_INJECT_LOG = '0';

test('damaged store: status.storeError, tools refuse with store_damaged, ingest quarantines and rebuilds', async () => {
  const repo = path.join(home, 'app'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'x.js'), 'function damagedFn() { return 1; }\n');
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'i');
  fs.writeFileSync(process.env.KORAGRAPH_DB!, 'not a database '.repeat(100));
  const { createGraphService } = require('./service') as typeof import('./service');
  const g = createGraphService();
  const st = await g.status(repo);
  assert.match(String(st.storeError), /not a database/);
  await assert.rejects(() => g.callTool('search_code', { query: 'damagedFn' }, { cwd: repo }), (e: any) => e.code === 'store_damaged');
  const errs: string[] = [];
  await g.ingest(repo, { wait: true, io: { out: () => {}, err: (s: string) => { errs.push(s); } } } as any);
  assert.ok(errs.some((s) => /damaged .*moved it to/.test(s)), errs.join(''));
  assert.ok(fs.readdirSync(process.env.KORAGRAPH_HOME!).some((f) => f.startsWith('graph.db.damaged-')), 'the damaged file is kept aside, not deleted');
  const ok = await g.callTool('search_code', { query: 'damagedFn' }, { cwd: repo });
  assert.match(ok.text, /damagedFn/);
});

process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });

test('a failed index is recorded for the chip and doctor, and the next successful one clears it', async () => {
  const { createGraphService, ingestErrorFile, recordIngestOutcome } = require('./service') as typeof import('./service');
  const g = createGraphService();
  const missing = path.join(home, 'gone', 'repo');
  await assert.rejects(() => g.ingest(missing, { wait: true, io: { out: () => {}, err: () => {} } } as any));
  assert.ok(fs.existsSync(ingestErrorFile(missing)), 'failure recorded');
  const repo = path.join(home, 'ok'); fs.mkdirSync(repo, { recursive: true }); fs.writeFileSync(path.join(repo, 'y.js'), 'function okFn() {}\n');
  spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'i', '--allow-empty'], { cwd: repo });
  spawnSync('git', ['add', '.'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ii'], { cwd: repo });
  recordIngestOutcome(repo, 'an earlier failure');
  await g.ingest(repo, { wait: true, io: { out: () => {}, err: () => {} } } as any);
  assert.ok(!fs.existsSync(ingestErrorFile(repo)), 'cleared by a successful index');
});

// B2 (night 2026-10-04): a detached first index killed before it wrote its job row left no trace — the chip went back
// to "Not indexed · Index?" as if the click did nothing.
test('a detached index that dies without a word records why; a reason the indexer wrote itself is kept', () => {
  const { noteDetachedIngestExit, ingestErrorFile } = require('./service') as typeof import('./service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-detached-'));
  const file = ingestErrorFile(root);
  noteDetachedIngestExit(root, Date.now(), 0, null);
  assert.equal(fs.existsSync(file), false, 'a clean exit records nothing');
  noteDetachedIngestExit(root, Date.now(), null, 'SIGKILL');
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).error, /stopped \(SIGKILL\) before it finished/);
  fs.writeFileSync(file, JSON.stringify({ root, at: new Date().toISOString(), error: 'Refusing to index: it is your home folder' }));
  noteDetachedIngestExit(root, Date.now() - 500, 2, null);
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).error, /home folder/, 'the indexer\'s own reason wins');
});

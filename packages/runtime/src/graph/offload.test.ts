import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphService, GraphToolError } from './service';
import { withGraphWorkers } from './offload';

test('graph workers: status and callTool answer from a worker thread; tool errors keep their class and code', async () => {
  const g = withGraphWorkers(createGraphService(), { size: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-offload-'));
  const st = await g.status(dir);
  assert.equal(st.indexed, false);
  assert.equal((g as any).__workers.live, 1, 'the query ran in a worker');
  await assert.rejects(g.callTool('remember' as any, {}, { cwd: dir }), (e: any) => e instanceof GraphToolError && e.code === 'unknown_tool');
  await assert.rejects(g.callTool('nope' as any, {}, { cwd: dir }), (e: any) => e instanceof GraphToolError && e.code === 'unknown_tool');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('graph workers: an unstartable worker falls back to the inline service instead of failing', async () => {
  const g = withGraphWorkers(createGraphService(), { size: 1, scriptPath: '/nonexistent/graph-worker.js' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-offload-'));
  const st = await g.status(dir);
  assert.equal(st.indexed, false);
  assert.equal((g as any).__workers.disabled, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Windows cannot delete a file a worker holds open, so the "old inode" case does not exist there.
test('graph workers: a store deleted and rebuilt while the daemon runs is read from the NEW file, not the old inode', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-offload-rebuild-'));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.js'), 'function beforeFn() { return 1; }\n'); git('init', '-q'); git('add', '.'); git('commit', '-qm', 'i');
  const kgBin = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');
  const ingest = () => { const r = spawnSync(process.execPath, [kgBin, 'ingest', repo, '--no-hooks'], { env: process.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  ingest();
  const g = withGraphWorkers(createGraphService(), { size: 1 });
  assert.match((await g.callTool('search_code', { query: 'beforeFn' }, { cwd: repo, fresh: false })).text, /beforeFn/);
  // the user deletes the store (or the damaged one is moved aside) and the repo is indexed again, with new code
  const db = process.env.KORAGRAPH_DB as string;
  for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(path.join(repo, 'a.js'), 'function afterFn() { return 2; }\n'); git('commit', '-qam', 'ii');
  ingest();
  const r = await g.callTool('search_code', { query: 'afterFn' }, { cwd: repo, fresh: false });
  assert.match(r.text, /afterFn/, 'answered from the rebuilt store');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('graph workers: a call that times out takes its stuck thread out of rotation; the next call runs on a fresh one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-offload-hang-'));
  const flag = path.join(dir, 'hang');
  const script = path.join(dir, 'w.js');
  fs.writeFileSync(script, `const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', (m) => {
  if (fs.existsSync(${JSON.stringify(flag)})) { for (;;) {} }
  parentPort.postMessage({ id: m.id, ok: true, result: { indexed: true, from: 'worker' } });
});
parentPort.postMessage({ ready: true });
`);
  const g = withGraphWorkers(createGraphService(), { size: 1, scriptPath: script, lightTimeoutMs: 300 });
  assert.equal(((await g.status(dir)) as any).from, 'worker');
  fs.writeFileSync(flag, '1');
  const t0 = Date.now();
  await assert.rejects(g.status(dir), /timed out after 300ms/);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal((g as any).__workers.live, 0, 'the stuck thread is out of rotation');
  fs.rmSync(flag);
  assert.equal(((await g.status(dir)) as any).from, 'worker', 'a fresh thread answers');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Audit 2026-10-15 #8: one failed worker start switched the pool off for good, so every later graph call ran inline
// and its blocking work (SQLite, git) stalled the daemon's event loop. The start is retried after a backoff.
test('graph workers: a failed start is retried after the backoff, and the pool comes back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-offload-retry-'));
  const script = path.join(dir, 'worker.js'); // missing for now
  const g = withGraphWorkers(createGraphService(), { size: 1, scriptPath: script, retryMs: 1500 });
  try {
    await g.status(dir);
    assert.equal((g as any).__workers.disabled, true, 'inline after the failed start');
    fs.symlinkSync(path.join(__dirname, 'worker.js'), script); // the worker is there now
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal((g as any).__workers.disabled, false, 'the backoff ends');
    const st = await g.status(dir);
    assert.equal(st.indexed, false);
    assert.equal((g as any).__workers.live, 1, 'the next call started a worker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

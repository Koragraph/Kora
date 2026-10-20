// Coordinated close of the graph store (store-maintenance.ts). Windows' refusal is simulated: a fake rename throws EBUSY
// while a holder's handle is "open", and the holder closes when it sees the marker (another process) or is called
// (this process). Tiny: no real SQLite, no real Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withStoreMaintenance, maintenanceActive, maintenanceMarker, onStoreMaintenance, watchStoreMaintenance } from './store-maintenance';
import { quarantineStore } from './embedded';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-store-maint-'));
const dbFile = path.join(dir, 'graph.db');
const ebusy = () => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });

/** A fake clock: sleep advances it, and runs `onSleep` (a holder in another process polling the marker). */
function clock(onSleep: () => void = () => {}) {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; onSleep(); } };
}

test('macOS/Linux: the operation runs once, no marker, a refusal is not retried', async () => {
  let calls = 0;
  await assert.rejects(withStoreMaintenance('rename', () => { calls++; throw ebusy(); }, {}, dbFile, { platform: 'darwin' }), /EBUSY/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(maintenanceMarker(dbFile)), false);
  assert.equal(await withStoreMaintenance('rename', () => 'done', {}, dbFile, { platform: 'darwin' }), 'done');
});

test('Windows: a holder in another process sees the marker, closes, and the retried rename succeeds', async () => {
  let open = true;
  let sawMarker = false;
  const c = clock(() => { if (maintenanceActive(dbFile, Date.now())) { sawMarker = true; open = false; } });
  let calls = 0;
  const r = await withStoreMaintenance('quarantine', () => { calls++; if (open) throw ebusy(); return 'moved'; }, {}, dbFile, { platform: 'win32', ...c });
  assert.equal(r, 'moved');
  assert.equal(calls, 2);
  assert.ok(sawMarker, 'the marker was up while the holder had the file open');
  assert.equal(fs.existsSync(maintenanceMarker(dbFile)), false, 'removed afterwards');
});

test('Windows: a holder that never closes fails the operation after the timeout, and the marker is still removed', async () => {
  const c = clock();
  await assert.rejects(withStoreMaintenance('quarantine', () => { throw ebusy(); }, {}, dbFile, { platform: 'win32', timeoutMs: 2000, ...c }), /EBUSY/);
  assert.equal(fs.existsSync(maintenanceMarker(dbFile)), false);
});

test('Windows: a non-holder error (ENOENT) is not retried', async () => {
  let calls = 0;
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  await assert.rejects(withStoreMaintenance('quarantine', () => { calls++; throw enoent; }, {}, dbFile, { platform: 'win32', ...clock() }), /ENOENT/);
  assert.equal(calls, 1);
});

test('Windows: quarantineStore asks this process\'s holders to close, then moves the store and its -wal', async () => {
  let open = true;
  const stop = onStoreMaintenance((f) => { if (f === dbFile) open = false; });
  const moved: Array<[string, string]> = [];
  const rename = (a: string, b: string) => {
    if (a === dbFile && open) throw ebusy();
    if (a.endsWith('-shm')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    moved.push([a, b]);
  };
  try {
    const dest = await quarantineStore(dbFile, { platform: 'win32', rename, ...clock() });
    assert.match(dest, /graph\.db\.damaged-/);
    assert.deepEqual(moved.map(([a]) => path.basename(a)), ['graph.db', 'graph.db-wal']);
  } finally { stop(); }
});

test('the daemon watch is a no-op off Windows', () => {
  let released = 0;
  const stop = watchStoreMaintenance(() => { released++; }, dbFile, 'darwin', 1);
  stop();
  assert.equal(released, 0);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

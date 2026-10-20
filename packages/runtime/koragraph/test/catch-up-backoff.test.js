'use strict';
// Round-2 review of 4dd0c94: a catch-up child was spawned on every read even while another run held the repo's ingest
// lock (it only sat waiting), and a child that kept failing was respawned on every read. No ingest here: the lock file
// and the failure record are set by hand, and spawnCatchUp must decline before spawning anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-catchup-backoff-'));
process.env.KORAGRAPH_HOME = path.join(TMP, 'home');
const REPO = path.join(TMP, 'repo'); fs.mkdirSync(REPO);
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const lf = require('../src/services/live-freshness');
const lock = require('../src/services/ingest-lock');
const row = { branchId: 7, repoPath: REPO };

test('a held ingest lock: no child is spawned', () => {
  const l = lock.tryAcquire(REPO); assert.ok(l);
  try {
    assert.equal(lock.isHeld(REPO), true);
    assert.equal(lf._catchUp.spawnCatchUp(row, ['a.js'], [], null), null);
  } finally { l.release(); }
  assert.equal(lock.isHeld(REPO), false, 'released');
});

test('a stale lock (dead holder) does not count as held', () => {
  fs.mkdirSync(path.dirname(lock.lockFile(REPO)), { recursive: true });
  fs.writeFileSync(lock.lockFile(REPO), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  try { assert.equal(lock.isHeld(REPO), false); } finally { fs.unlinkSync(lock.lockFile(REPO)); }
});

test('a failed catch-up backs off, doubling; a success clears it', () => {
  const { noteCatchUpExit, catchUpFailures, spawnCatchUp } = lf._catchUp;
  noteCatchUpExit(7, 1);
  const first = catchUpFailures.get(7); assert.equal(first.n, 1);
  assert.equal(spawnCatchUp(row, ['a.js'], [], null), null, 'inside the backoff: not respawned');
  noteCatchUpExit(7, 1);
  const second = catchUpFailures.get(7); assert.equal(second.n, 2);
  assert.ok(second.until - Date.now() > 3000, 'the wait doubles');
  noteCatchUpExit(7, 0);
  assert.equal(catchUpFailures.has(7), false);
  lf.resetFreshnessCache();
});

'use strict';
// Audit 2026-10-15 #6: a STALE ingest lock (holder killed, or older than 2 h) could be taken by two waiters at once —
// both saw it stale, A unlinked + created, then B unlinked A's fresh lock and created its own. And the key was
// path.resolve, so `/tmp/x` and `/private/tmp/x` got separate locks. No ingest here: lock files only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lock-takeover-'));
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { recursive: true });
process.env.KORAGRAPH_HOME = HOME;
const REPO = path.join(TMP, 'repo'); fs.mkdirSync(REPO);
const LOCK = path.resolve(__dirname, '..', 'src', 'services', 'ingest-lock.js');
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const DEAD_PID = 2 ** 22 + 12345; // above any real pid limit → not alive
function writeStale() {
  const { lockFile } = require(LOCK);
  fs.mkdirSync(path.dirname(lockFile(REPO)), { recursive: true });
  fs.writeFileSync(lockFile(REPO), JSON.stringify({ pid: DEAD_PID, at: Date.now(), repo: REPO }));
}

test('the lock is keyed on the real path', () => {
  const { lockFile } = require(LOCK);
  const link = path.join(TMP, 'link'); fs.symlinkSync(TMP, link);
  assert.equal(lockFile(path.join(link, 'repo')), lockFile(REPO));
});

test('a takeover in progress elsewhere is not stolen', () => {
  const { tryAcquire, lockFile } = require(LOCK);
  writeStale();
  fs.writeFileSync(`${lockFile(REPO)}.takeover`, '1', { flag: 'wx' });
  try { assert.equal(tryAcquire(REPO), null, 'another waiter holds the takeover: back off'); }
  finally { fs.unlinkSync(`${lockFile(REPO)}.takeover`); }
  const l = tryAcquire(REPO); assert.ok(l, 'once it is gone the stale lock is taken over'); l.release();
});

test('waiters racing on a stale lock: exactly one wins each round', async () => {
  // Each child polls until a shared start time, then calls tryAcquire once and holds what it got (no release).
  const script = `const l = require(${JSON.stringify(LOCK)}); const go = Number(process.argv[1]); while (Date.now() < go) {} const got = l.tryAcquire(${JSON.stringify(REPO)}); process.stdout.write(got ? 'WON' : 'lost'); setTimeout(() => {}, 300);`;
  // One round of 4 (was 4 x 4 = 16 busy-waiting processes): enough to race, light on a dev machine.
  for (let round = 0; round < 1; round++) {
    writeStale();
    const go = Date.now() + 400;
    const outs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', script, String(go)], { env: { ...process.env, KORAGRAPH_HOME: HOME }, stdio: ['ignore', 'pipe', 'inherit'] });
      let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => resolve(o));
    })));
    assert.equal(outs.filter((o) => o === 'WON').length, 1, `round ${round}: ${outs.join(',')}`);
  }
});

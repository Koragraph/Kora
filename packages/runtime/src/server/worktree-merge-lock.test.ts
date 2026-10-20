// withMergeLock on filesystems that refuse hard links (exFAT, some network shares: link() fails with EPERM / ENOTSUP):
// the lock must still be taken (the old open 'wx' way), not silently skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withMergeLock } from './worktree';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-lock-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

test('withMergeLock: a filesystem without hard links still gets the lock (and a held lock is still waited for)', (t) => {
  const dir = repo();
  const lock = path.join(dir, '.git', 'kora-merge.lock');
  const realLink = fs.linkSync;
  (fs as any).linkSync = () => { const e: any = new Error('EPERM: operation not permitted, link'); e.code = 'EPERM'; throw e; };
  t.after(() => { (fs as any).linkSync = realLink; fs.rmSync(dir, { recursive: true, force: true }); });

  let heldDuring = false;
  assert.equal(withMergeLock(dir, () => { heldDuring = fs.existsSync(lock); return 1; }), 1);
  assert.ok(heldDuring, 'the merge ran with no lock file: two merges could run at once');
  assert.ok(!fs.existsSync(lock), 'released afterwards');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.git')).filter((f) => f.startsWith('kora-merge.lock.')), [], 'no private temp files left');

  // a live holder (our parent process) owns the lock: wait and give up, never run alongside it
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  let ran = false;
  assert.equal(withMergeLock(dir, () => { ran = true; return 1; }, 300), null);
  assert.ok(!ran, 'ran alongside a live merge');
});

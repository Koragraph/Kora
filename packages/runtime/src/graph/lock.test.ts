import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryLock, lockHolder } from './lock';

test('ingest lock: second holder is refused while the first lives, stale locks are reclaimed', () => {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-lock-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const a = tryLock(root); assert.ok(a);
  assert.equal(tryLock(root), null);
  assert.equal(lockHolder(root)?.pid, process.pid);
  a!.release();
  assert.equal(lockHolder(root), null);
  // stale: a dead pid
  fs.writeFileSync(a!.path, JSON.stringify({ pid: 999999, root, at: Date.now() }));
  const b = tryLock(root); assert.ok(b, 'stale lock should be reclaimed'); b!.release();
});

test('ingest lock: a just-created empty lock file (holder mid-write) is not reclaimed', () => {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-lock-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const a = tryLock(root); assert.ok(a);
  fs.writeFileSync(a!.path, '');
  assert.equal(tryLock(root), null, 'young empty file belongs to a live writer');
  const old = new Date(Date.now() - 60_000); fs.utimesSync(a!.path, old, old);
  const b = tryLock(root); assert.ok(b, 'an old corrupt file is stale'); b!.release();
});

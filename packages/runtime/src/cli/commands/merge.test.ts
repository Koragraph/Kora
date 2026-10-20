import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeRefsInOrder } from './merge';

// test/fleet 2026-10-14: `kora merge do` ran git merge in the checkout with no lock, beside a daemon's kora_merge into it.
test('kora merge do waits for a Kora merge into the same checkout and runs once it is free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-climerge-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t.co'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'feat'); fs.writeFileSync(path.join(dir, 'b.txt'), '2\n'); git('add', '-A'); git('commit', '-q', '-m', 'feat'); git('checkout', '-q', 'main');
  const lock = path.join(dir, '.git', 'kora-merge.lock');
  const io = { out: () => {}, err: (s: string) => { errs.push(s); } }; const errs: string[] = [];
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() })); // a live merger holds it
  assert.equal(mergeRefsInOrder(dir, ['feat'], new Set(), io, undefined, 300), 1);
  assert.match(errs.join(''), /merging into this checkout right now/);
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false, 'nothing merged while the lock is held');
  fs.rmSync(lock);
  assert.equal(mergeRefsInOrder(dir, ['feat'], new Set(), io), 0);
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.equal(fs.existsSync(lock), false, 'released');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { isSafeToAutoIndex } from './workspace';

test('isSafeToAutoIndex: refuses home, ancestors of home, the fs root, and shallow mounts', () => {
  const home = os.homedir();
  assert.equal(isSafeToAutoIndex(home), false, 'home dir');
  assert.equal(isSafeToAutoIndex(path.dirname(home)), false, 'ancestor of home (/Users)');
  assert.equal(isSafeToAutoIndex('/'), false, 'filesystem root');
  assert.equal(isSafeToAutoIndex('/tmp'), false, 'shallow mount');
  assert.equal(isSafeToAutoIndex('/opt'), false, 'shallow');
  if (process.platform === 'win32') { assert.equal(isSafeToAutoIndex('C:\\Windows\\System32'), false, 'system tree'); return; }
  assert.equal(isSafeToAutoIndex('/private/tmp'), false, 'temp root (two segments deep)');
  assert.equal(isSafeToAutoIndex('/System/Library/Frameworks'), false, 'system tree');
  assert.equal(isSafeToAutoIndex('/Volumes/External'), false, 'a whole external disk');
});

test('isSafeToAutoIndex: allows a real project directory', () => {
  assert.equal(isSafeToAutoIndex(path.join(home(), 'Projects', 'koragraphMCPbeta')), true);
  assert.equal(isSafeToAutoIndex(path.join(home(), 'code', 'app')), true);
  assert.equal(isSafeToAutoIndex('/Volumes/External/some-project'), true, 'deep enough on a mount');
});

function home() { return os.homedir(); }

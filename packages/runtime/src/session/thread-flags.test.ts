import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readThreadFlags, updateThreadFlags } from './thread-flags';

test('thread flags: absent = legacy, set/merge/clear, hostile ids refused', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tf-'));
  assert.deepEqual(readThreadFlags('t1', h), {});
  updateThreadFlags('t1', { safeTools: true, lean: false, noGraphRulebook: true }, h);
  assert.deepEqual(readThreadFlags('t1', h), { safeTools: true, noGraphRulebook: true });
  updateThreadFlags('t1', { noGraphRulebook: null }, h);
  assert.deepEqual(readThreadFlags('t1', h), { safeTools: true });
  updateThreadFlags('t1', { safeTools: null }, h);
  assert.equal(fs.existsSync(path.join(h, 'thread-flags', 't1.json')), false);
  updateThreadFlags('../evil', { lean: true }, h);
  assert.deepEqual(fs.existsSync(path.join(h, 'thread-flags')) ? fs.readdirSync(path.join(h, 'thread-flags')) : [], []);
  fs.mkdirSync(path.join(h, 'thread-flags'), { recursive: true });
  fs.writeFileSync(path.join(h, 'thread-flags', 'bad.json'), '{nope');
  assert.deepEqual(readThreadFlags('bad', h), {});
});

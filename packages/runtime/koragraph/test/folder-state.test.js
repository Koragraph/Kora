'use strict';
// folderState decides whether a repo row's folder is merely moved/deleted ('gone') or unknowable ('unknown').
// A whole deleted tree (parent AND grandparent missing) is gone; relative paths and absent mount points are not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderState } = require('../src/services/repo-name');

test('present, gone one level, and gone several levels deep', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
  try {
    assert.strictEqual(folderState(root), 'present');
    assert.strictEqual(folderState(path.join(root, 'x')), 'gone');
    assert.strictEqual(folderState(path.join(root, 'a', 'b', 'c')), 'gone');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('relative paths and a missing volume stay unknown', () => {
  assert.strictEqual(folderState('relative/path'), 'unknown');
  assert.strictEqual(folderState('/Volumes/definitely-not-mounted-xyz/repo'), 'unknown');
});

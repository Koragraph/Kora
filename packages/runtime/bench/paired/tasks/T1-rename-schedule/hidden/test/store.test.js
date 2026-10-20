import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { Job } from '../src/job.js';

test('memory store saves snapshots', () => {
  const store = createStore('memory');
  const job = new Job({ id: 'a', type: 't' });
  store.save(job);
  job.transition('scheduled');
  assert.equal(store.get('a').state, 'pending');
});

test('file store persists across instances', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-')), 'jobs.json');
  const first = createStore('file', { file });
  first.save(new Job({ id: 'a', type: 't' }));
  const second = createStore('file', { file });
  assert.equal(second.get('a').type, 't');
  second.remove('a');
  assert.equal(createStore('file', { file }).all().length, 0);
});

test('unknown store kinds throw', () => {
  assert.throws(() => createStore('redis'), /unknown store kind/);
});

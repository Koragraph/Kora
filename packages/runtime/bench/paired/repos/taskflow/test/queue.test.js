import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';
import { Job } from '../src/job.js';

test('higher priority pops first', () => {
  const q = new Queue();
  q.push(new Job({ id: 'low', type: 't', priority: 0 }), 0);
  q.push(new Job({ id: 'high', type: 't', priority: 5 }), 0);
  assert.equal(q.pop(0).id, 'high');
});

test('jobs that are not due stay queued', () => {
  const q = new Queue();
  q.push(new Job({ id: 'later', type: 't' }), 100);
  assert.equal(q.pop(50), null);
  assert.equal(q.size(), 1);
  assert.equal(q.pop(100).id, 'later');
});

test('same priority is ordered by run time then insertion', () => {
  const q = new Queue();
  q.push(new Job({ id: 'b', type: 't' }), 10);
  q.push(new Job({ id: 'a', type: 't' }), 5);
  q.push(new Job({ id: 'c', type: 't' }), 10);
  assert.deepEqual([q.pop(10).id, q.pop(10).id, q.pop(10).id], ['a', 'b', 'c']);
});

test('remove and readyCount', () => {
  const q = new Queue();
  q.push(new Job({ id: 'a', type: 't' }), 0);
  q.push(new Job({ id: 'b', type: 't' }), 50);
  assert.equal(q.readyCount(10), 1);
  assert.equal(q.remove('b').id, 'b');
  assert.equal(q.remove('zzz'), null);
});

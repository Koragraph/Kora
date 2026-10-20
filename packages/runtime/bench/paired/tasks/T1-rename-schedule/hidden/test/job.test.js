import test from 'node:test';
import assert from 'node:assert/strict';
import { Job } from '../src/job.js';

test('a new job is pending', () => {
  const job = new Job({ type: 'email' });
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
});

test('legal transitions', () => {
  const job = new Job({ type: 'x' });
  job.transition('scheduled').transition('running').transition('failed').transition('scheduled');
  assert.equal(job.state, 'scheduled');
});

test('illegal transitions throw', () => {
  const job = new Job({ type: 'x' });
  assert.throws(() => job.transition('succeeded'), /illegal job transition/);
});

test('terminal states', () => {
  const job = new Job({ type: 'x' });
  job.transition('cancelled');
  assert.ok(job.isTerminal());
});

test('json round trip keeps state', () => {
  const job = new Job({ type: 'x', payload: { a: 1 }, priority: 3 });
  job.transition('scheduled');
  const copy = Job.fromJSON(JSON.parse(JSON.stringify(job)));
  assert.equal(copy.state, 'scheduled');
  assert.equal(copy.priority, 3);
  assert.deepEqual(copy.payload, { a: 1 });
});

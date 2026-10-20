import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, nextDelay, shouldRetry, describePolicy, DEFAULT_POLICY } from '../src/retry.js';
import { Job } from '../src/job.js';

test('exponential backoff doubles from the base delay', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => computeBackoff(n, { baseDelay: 100, factor: 2 })), [100, 200, 400, 800]);
});

test('fixed and linear strategies', () => {
  assert.equal(computeBackoff(3, { strategy: 'fixed', baseDelay: 50 }), 50);
  assert.equal(computeBackoff(3, { strategy: 'linear', baseDelay: 50 }), 150);
});

test('full jitter stays within [0, delay]', () => {
  assert.equal(computeBackoff(2, { baseDelay: 100, factor: 2, jitter: 'full' }, () => 0.5), 100);
  assert.equal(computeBackoff(2, { baseDelay: 100, factor: 2, jitter: 'full' }, () => 0), 0);
});

test('equal jitter keeps at least half the delay', () => {
  assert.equal(computeBackoff(1, { baseDelay: 100, jitter: 'equal' }, () => 0), 50);
  assert.equal(computeBackoff(1, { baseDelay: 100, jitter: 'equal' }, () => 1), 100);
});

test('shouldRetry honours the job override before the policy', () => {
  const job = new Job({ type: 'a', maxAttempts: 5 });
  job.attempts = 4;
  assert.ok(shouldRetry(job, { maxAttempts: 3 }));
  job.attempts = 5;
  assert.ok(!shouldRetry(job, { maxAttempts: 3 }));
});

test('nextDelay is null once attempts are used up', () => {
  const job = new Job({ type: 'a' });
  job.attempts = 3;
  assert.equal(nextDelay(job, DEFAULT_POLICY), null);
  job.attempts = 1;
  assert.equal(nextDelay(job, DEFAULT_POLICY), 100);
});

test('describePolicy mentions the strategy and the cap', () => {
  assert.match(describePolicy({ maxDelay: 5000 }), /exponential backoff from 100ms/);
  assert.match(describePolicy({ maxDelay: 5000 }), /cap 5000ms/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoff, nextDelay } from '../src/retry.js';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Worker } from '../src/worker.js';
import { Job } from '../src/job.js';
import { FakeClock } from '../src/util/clock.js';

const policy = { baseDelay: 100, factor: 2, maxDelay: 1000 };

test('exponential delays grow until they hit maxDelay, then stay there', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => computeBackoff(n, policy)), [100, 200, 400, 800, 1000, 1000, 1000]);
});

test('linear and fixed strategies are capped too, and never raised to the cap', () => {
  const linear = { strategy: 'linear', baseDelay: 50, maxDelay: 120 };
  assert.deepEqual([1, 2, 3, 4].map((n) => computeBackoff(n, linear)), [50, 100, 120, 120]);
  assert.equal(computeBackoff(2, { strategy: 'fixed', baseDelay: 300, maxDelay: 200 }), 200);
  assert.equal(computeBackoff(2, { strategy: 'fixed', baseDelay: 300, maxDelay: 500 }), 300);
});

test('jitter never pushes a delay past maxDelay', () => {
  for (const jitter of ['full', 'equal']) {
    for (const r of [0, 0.5, 0.999]) {
      for (let n = 1; n <= 8; n++) assert.ok(computeBackoff(n, { ...policy, jitter }, () => r) <= 1000, `${jitter} ${r} attempt ${n}`);
    }
  }
});

test('without maxDelay nothing is capped', () => {
  assert.equal(computeBackoff(10, { baseDelay: 100, factor: 2 }), 51200);
});

test('nextDelay applies the cap for a failing job', () => {
  const job = new Job({ type: 'a', maxAttempts: 10 });
  job.attempts = 8;
  assert.equal(nextDelay(job, policy), 1000);
  job.attempts = 2;
  assert.equal(nextDelay(job, policy), 200);
});

test('a worker retries a job with the capped delays', async () => {
  const clock = new FakeClock(0);
  const queue = new Queue();
  const retryPolicy = { maxAttempts: 7, baseDelay: 100, factor: 2, maxDelay: 1000 };
  const scheduler = new Scheduler({ queue, clock, retryPolicy });
  const worker = new Worker({ queue, scheduler, clock, retryPolicy });
  worker.register('boom', async () => { throw new Error('nope'); });
  const job = scheduler.scheduleJob(new Job({ type: 'boom' }));
  const waits = [];
  while (job.state !== 'dead') {
    await worker.runUntilIdle();
    if (job.state === 'scheduled') {
      waits.push(job.runAt - clock.now());
      clock.advance(job.runAt - clock.now());
    }
  }
  assert.deepEqual(waits, [100, 200, 400, 800, 1000, 1000]);
});

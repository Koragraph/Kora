import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Worker } from '../src/worker.js';
import { Job } from '../src/job.js';
import { FakeClock } from '../src/util/clock.js';

function setup(policy = { maxAttempts: 3, baseDelay: 100, factor: 2 }) {
  const clock = new FakeClock(0);
  const queue = new Queue();
  const scheduler = new Scheduler({ queue, clock, retryPolicy: policy });
  const worker = new Worker({ queue, scheduler, clock, retryPolicy: policy });
  return { clock, queue, scheduler, worker };
}

test('runs a job and marks it succeeded', async () => {
  const { scheduler, worker } = setup();
  const seen = [];
  worker.register('a', async (job) => seen.push(job.payload.n));
  const job = scheduler.scheduleJob(new Job({ type: 'a', payload: { n: 7 } }));
  assert.equal(await worker.runUntilIdle(), 1);
  assert.deepEqual(seen, [7]);
  assert.equal(job.state, 'succeeded');
});

test('a failing job is retried after the backoff delay', async () => {
  const { scheduler, worker, clock } = setup();
  let calls = 0;
  worker.register('a', async () => { calls += 1; if (calls < 2) throw new Error('boom'); });
  const job = scheduler.scheduleJob(new Job({ type: 'a' }));
  await worker.runUntilIdle();
  assert.equal(job.state, 'scheduled');
  assert.equal(job.runAt, 100);
  clock.advance(100);
  await worker.runUntilIdle();
  assert.equal(job.state, 'succeeded');
  assert.equal(calls, 2);
});

test('a job that keeps failing ends up dead with its last error', async () => {
  const { scheduler, worker, clock } = setup({ maxAttempts: 2, baseDelay: 10, factor: 2 });
  worker.register('a', async () => { throw new Error('nope'); });
  const job = scheduler.scheduleJob(new Job({ type: 'a' }));
  await worker.runUntilIdle();
  clock.advance(10);
  await worker.runUntilIdle();
  assert.equal(job.state, 'dead');
  assert.equal(job.lastError, 'nope');
  assert.equal(job.attempts, 2);
});

test('an unknown job type fails the job', async () => {
  const { scheduler, worker } = setup({ maxAttempts: 1 });
  const job = scheduler.scheduleJob(new Job({ type: 'ghost' }));
  await worker.runUntilIdle();
  assert.equal(job.state, 'dead');
  assert.match(job.lastError, /no handler registered/);
});

test('jobs run in priority order', async () => {
  const { scheduler, worker } = setup();
  const order = [];
  worker.register('a', async (job) => order.push(job.id));
  scheduler.scheduleJob(new Job({ id: 'low', type: 'a', priority: 0 }));
  scheduler.scheduleJob(new Job({ id: 'high', type: 'a', priority: 9 }));
  await worker.runUntilIdle();
  assert.deepEqual(order, ['high', 'low']);
});

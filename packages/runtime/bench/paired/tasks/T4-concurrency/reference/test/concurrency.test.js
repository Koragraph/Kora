import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Worker } from '../src/worker.js';
import { Job } from '../src/job.js';

function setup(concurrency) {
  const queue = new Queue({ concurrency });
  const scheduler = new Scheduler({ queue });
  const worker = new Worker({ queue, scheduler, retryPolicy: { maxAttempts: 1 } });
  return { queue, scheduler, worker };
}

test('never runs more jobs at once than the queue allows', async () => {
  const { scheduler, worker } = setup(2);
  let inFlight = 0;
  let max = 0;
  worker.register('a', async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
  });
  for (let i = 0; i < 6; i++) scheduler.scheduleJob(new Job({ type: 'a' }));
  await worker.runUntilIdle();
  assert.equal(max, 2);
});

test('invalid concurrency values throw', () => {
  for (const bad of [0, -1, 1.5, '3', NaN]) assert.throws(() => new Queue({ concurrency: bad }), /concurrency/);
});

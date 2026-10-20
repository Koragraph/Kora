import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Job } from '../src/job.js';
import { FakeClock } from '../src/util/clock.js';
import { createStore } from '../src/store/index.js';

function setup(extra = {}) {
  const clock = new FakeClock(1000);
  const queue = new Queue();
  const scheduler = new Scheduler({ queue, clock, ...extra });
  return { clock, queue, scheduler };
}

test('submitJob stamps runAt and queues the job', () => {
  const { queue, scheduler } = setup();
  const job = scheduler.submitJob(new Job({ type: 'a' }), { delay: 500 });
  assert.equal(job.runAt, 1500);
  assert.equal(job.state, 'scheduled');
  assert.equal(queue.size(), 1);
});

test('submitJob accepts an absolute runAt', () => {
  const { scheduler } = setup();
  assert.equal(scheduler.submitJob(new Job({ type: 'a' }), { runAt: 9999 }).runAt, 9999);
});

test('submitJob refuses a job that is not pending', () => {
  const { scheduler } = setup();
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  assert.throws(() => scheduler.submitJob(job), /only pending jobs can be scheduled/);
});

test('submitJob writes to the store and emits an event', () => {
  const store = createStore('memory');
  const { scheduler } = setup({ store });
  const seen = [];
  scheduler.events.on('job:scheduled', (job) => seen.push(job.id));
  const job = scheduler.submitJob(new Job({ id: 'j1', type: 'a' }));
  assert.deepEqual(seen, ['j1']);
  assert.equal(store.get(job.id).state, 'scheduled');
});

test('rescheduleJob requeues a failed job after a delay', () => {
  const { queue, scheduler, clock } = setup();
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  queue.pop(clock.now());
  job.transition('running').transition('failed');
  scheduler.rescheduleJob(job, 250);
  assert.equal(job.runAt, 1250);
  assert.equal(queue.size(), 1);
});

test('rescheduleAfterFailure retries with backoff, then marks the job dead', () => {
  const { queue, scheduler, clock } = setup({ retryPolicy: { maxAttempts: 2, baseDelay: 100, factor: 2 } });
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  queue.pop(clock.now());
  job.transition('running');
  job.attempts = 1;
  job.transition('failed');
  assert.equal(scheduler.rescheduleAfterFailure(job), 100);
  queue.pop(clock.now() + 100);
  job.transition('running');
  job.attempts = 2;
  job.transition('failed');
  assert.equal(scheduler.rescheduleAfterFailure(job), null);
  assert.equal(job.state, 'dead');
});

test('cancelJob removes a queued job', () => {
  const { queue, scheduler } = setup();
  const job = scheduler.submitJob(new Job({ type: 'a' }));
  assert.ok(scheduler.cancelJob(job.id));
  assert.equal(queue.size(), 0);
  assert.equal(job.state, 'cancelled');
  assert.equal(scheduler.cancelJob('nope'), false);
});

test('recurring entries enqueue on tick', () => {
  const { queue, scheduler, clock } = setup();
  clock.current = Date.UTC(2025, 0, 1, 10, 0, 0);
  scheduler.scheduleRecurring('*/15 * * * *', () => new Job({ type: 'tick' }));
  clock.advance(31 * 60_000);
  assert.equal(scheduler.tick(), 2);
  assert.equal(queue.size(), 2);
});

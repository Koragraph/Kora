import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Job } from '../src/job.js';
import { createStore } from '../src/store/index.js';
import { main } from '../src/cli/index.js';
import { createContext } from '../src/cli/context.js';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Worker } from '../src/worker.js';
import { FakeClock } from '../src/util/clock.js';

test('timeoutMs defaults to null', () => {
  assert.equal(new Job({ type: 'a' }).timeoutMs, null);
  assert.equal(new Job({ type: 'a', timeoutMs: null }).timeoutMs, null);
  assert.equal(new Job({ type: 'a', timeoutMs: 250 }).timeoutMs, 250);
});

test('timeoutMs must be a positive integer (the error mentions timeoutMs)', () => {
  for (const bad of [0, -5, 1.5, NaN, '100', Infinity]) {
    assert.throws(() => new Job({ type: 'a', timeoutMs: bad }), /timeoutMs/, `value ${String(bad)}`);
  }
});

test('timeoutMs survives toJSON, fromJSON and the memory store', () => {
  const job = new Job({ id: 'j1', type: 'a', timeoutMs: 40 });
  assert.equal(job.toJSON().timeoutMs, 40);
  assert.equal(Job.fromJSON(job.toJSON()).timeoutMs, 40);
  assert.equal(Job.fromJSON(new Job({ type: 'a' }).toJSON()).timeoutMs, null);
  const store = createStore('memory');
  store.save(job);
  assert.equal(store.get('j1').timeoutMs, 40);
});

test('timeoutMs survives the file store', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-to-')), 'jobs.json');
  createStore('file', { file }).save(new Job({ id: 'j1', type: 'a', timeoutMs: 75 }));
  const row = createStore('file', { file }).get('j1');
  assert.equal(row.timeoutMs, 75);
  assert.equal(Job.fromJSON(row).timeoutMs, 75);
});

test('submit --timeout MS sets the job timeout and the output line ends with the timeout', async () => {
  const ctx = createContext();
  const lines = [];
  assert.equal(await main(['submit', 'email', '--timeout', '500'], { ctx, out: (l) => lines.push(l) }), 0);
  assert.match(lines[0], /^scheduled job_\w+ \(email\) timeout 500ms$/);
  assert.equal(ctx.queue.items[0].job.timeoutMs, 500);
});

test('submit without --timeout prints the old line', async () => {
  const lines = [];
  await main(['submit', 'email', '--delay', '10'], { ctx: createContext(), out: (l) => lines.push(l) });
  assert.match(lines[0], /^scheduled job_\w+ \(email\)$/);
});

test('submit rejects an invalid --timeout', async () => {
  for (const bad of ['0', '-4', 'abc', '2.5']) {
    await assert.rejects(main(['submit', 'email', '--timeout', bad], { ctx: createContext(), out: () => {} }), /timeoutMs/, bad);
  }
});

function setup() {
  const clock = new FakeClock(0);
  const queue = new Queue();
  const scheduler = new Scheduler({ queue, clock });
  const worker = new Worker({ queue, scheduler, clock, retryPolicy: { maxAttempts: 2, baseDelay: 10 } });
  return { clock, queue, scheduler, worker };
}

test('a handler that outlives the job timeout fails the job with the timeout message and goes through the retry flow', async () => {
  const { queue, scheduler, worker } = setup();
  const failures = [];
  scheduler.events.on('job:failed', (job) => failures.push(job.lastError));
  worker.register('slow', () => new Promise((resolve) => setTimeout(resolve, 300)));
  const job = new Job({ id: 'j1', type: 'slow', timeoutMs: 20 });
  scheduler.scheduleJob(job);
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(failures, ['job j1 timed out after 20ms']);
  assert.equal(job.lastError, 'job j1 timed out after 20ms');
  assert.equal(job.state, 'scheduled', 'first failure is rescheduled, not dropped');
  assert.equal(queue.size(), 1);
});

test('a timed-out job ends up dead once its attempts are used up', async () => {
  const { clock, scheduler, worker } = setup();
  worker.register('slow', () => new Promise((resolve) => setTimeout(resolve, 300)));
  const job = new Job({ id: 'j2', type: 'slow', timeoutMs: 15, maxAttempts: 2 });
  scheduler.scheduleJob(job);
  await worker.runOnce();
  clock.advance(1000);
  await worker.runOnce();
  assert.equal(job.state, 'dead');
  assert.equal(job.attempts, 2);
});

test('a handler that finishes in time is unaffected, and jobs without a timeout are never cut off', async () => {
  const { scheduler, worker } = setup();
  const done = [];
  worker.register('quick', async (job) => { done.push(job.id); return 'ok'; });
  worker.register('plain', async (job) => { await new Promise((r) => setTimeout(r, 60)); done.push(job.id); });
  const quick = new Job({ id: 'q', type: 'quick', timeoutMs: 500 });
  const plain = new Job({ id: 'p', type: 'plain' });
  scheduler.scheduleJob(quick);
  scheduler.scheduleJob(plain);
  await worker.runUntilIdle();
  assert.deepEqual(done.sort(), ['p', 'q']);
  assert.equal(quick.state, 'succeeded');
  assert.equal(plain.state, 'succeeded');
});

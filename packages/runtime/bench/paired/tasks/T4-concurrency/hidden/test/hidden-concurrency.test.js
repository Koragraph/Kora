import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Queue, Scheduler, Worker, Job } from '../src/index.js';
import { parseArgs, main } from '../src/cli/index.js';
import { createContext } from '../src/cli/context.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(concurrency, policy = { maxAttempts: 1 }) {
  const queue = new Queue(concurrency === undefined ? {} : { concurrency });
  const scheduler = new Scheduler({ queue, retryPolicy: policy });
  const worker = new Worker({ queue, scheduler, retryPolicy: policy });
  return { queue, scheduler, worker };
}

test('the default concurrency is 1 and is exposed on the queue', () => {
  assert.equal(new Queue().concurrency, 1);
  assert.equal(new Queue({ concurrency: 4 }).concurrency, 4);
});

test('invalid concurrency values throw', () => {
  for (const bad of [0, -2, 1.5, '3', NaN, null, Infinity]) assert.throws(() => new Queue({ concurrency: bad }), `value ${String(bad)}`);
});

test('a worker never exceeds the limit and does use it', async () => {
  for (const limit of [1, 2, 3]) {
    const { scheduler, worker } = setup(limit);
    let inFlight = 0;
    let max = 0;
    worker.register('a', async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await sleep(12);
      inFlight -= 1;
    });
    const jobs = Array.from({ length: 7 }, () => scheduler.scheduleJob(new Job({ type: 'a' })));
    assert.equal(await worker.runUntilIdle(), 7);
    assert.equal(max, limit, `limit ${limit}`);
    assert.ok(jobs.every((j) => j.state === 'succeeded'));
  }
});

test('runUntilIdle resolves only after every running job has finished', async () => {
  const { scheduler, worker } = setup(3);
  let finished = 0;
  worker.register('a', async () => { await sleep(20); finished += 1; });
  for (let i = 0; i < 3; i++) scheduler.scheduleJob(new Job({ type: 'a' }));
  await worker.runUntilIdle();
  assert.equal(finished, 3);
});

test('jobs still start in priority order', async () => {
  const { scheduler, worker } = setup(2);
  const started = [];
  worker.register('a', async (job) => { started.push(job.id); await sleep(5); });
  scheduler.scheduleJob(new Job({ id: 'low', type: 'a', priority: 0 }));
  scheduler.scheduleJob(new Job({ id: 'mid', type: 'a', priority: 5 }));
  scheduler.scheduleJob(new Job({ id: 'high', type: 'a', priority: 9 }));
  await worker.runUntilIdle();
  assert.deepEqual(started, ['high', 'mid', 'low']);
});

test('a failing job frees its slot', async () => {
  const { scheduler, worker } = setup(1);
  const done = [];
  worker.register('boom', async () => { throw new Error('x'); });
  worker.register('ok', async (job) => { done.push(job.id); });
  const bad = scheduler.scheduleJob(new Job({ id: 'bad', type: 'boom', priority: 5 }));
  scheduler.scheduleJob(new Job({ id: 'good', type: 'ok' }));
  await worker.runUntilIdle();
  assert.equal(bad.state, 'dead');
  assert.deepEqual(done, ['good']);
});

test('the sequential behaviour is unchanged for concurrency 1', async () => {
  const { scheduler, worker } = setup(1);
  const order = [];
  worker.register('a', async (job) => { order.push('start ' + job.id); await sleep(3); order.push('end ' + job.id); });
  scheduler.scheduleJob(new Job({ id: '1', type: 'a', priority: 1 }));
  scheduler.scheduleJob(new Job({ id: '2', type: 'a' }));
  await worker.runUntilIdle();
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('parseArgs reads --concurrency as a number and rejects bad values', () => {
  assert.equal(parseArgs(['worker', '--concurrency', '3']).options.concurrency, 3);
  for (const bad of ['0', '-1', 'abc', '1.5']) assert.throws(() => parseArgs(['worker', '--concurrency', bad]), /concurrency/);
});

test('the worker command applies --concurrency to the queue before running', async () => {
  const ctx = createContext();
  let inFlight = 0;
  let max = 0;
  ctx.worker.register('a', async () => { inFlight += 1; max = Math.max(max, inFlight); await sleep(10); inFlight -= 1; });
  for (let i = 0; i < 5; i++) await main(['submit', 'a'], { ctx, out: () => {} });
  const lines = [];
  assert.equal(await main(['worker', '--concurrency', '2'], { ctx, out: (l) => lines.push(l) }), 0);
  assert.equal(ctx.queue.concurrency, 2);
  assert.equal(max, 2);
  assert.deepEqual(lines, ['ran 5 job(s)']);
});

test('the README documents the option', () => {
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../README.md'), 'utf8');
  assert.match(readme, /--concurrency/);
});

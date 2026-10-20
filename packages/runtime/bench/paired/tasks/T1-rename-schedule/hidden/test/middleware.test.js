import test from 'node:test';
import assert from 'node:assert/strict';
import { compose, withTimeout, withDedupe, withLogging } from '../src/middleware/index.js';
import { timeoutFor } from '../src/middleware/timeout.js';
import { Job } from '../src/job.js';

test('compose wraps outermost first', async () => {
  const order = [];
  const tag = (name) => (next) => async (job) => { order.push(name); return next(job); };
  await compose(tag('a'), tag('b'))(async () => order.push('handler'))(new Job({ type: 't' }));
  assert.deepEqual(order, ['a', 'b', 'handler']);
});

test('withTimeout rejects slow handlers', async () => {
  const slow = withTimeout(() => new Promise((r) => setTimeout(r, 50)), 5);
  await assert.rejects(slow(new Job({ id: 'j', type: 't' })), /timed out after 5ms/);
});

test('withDedupe skips a repeated key', async () => {
  let calls = 0;
  const handler = withDedupe(async () => { calls += 1; });
  await handler(new Job({ type: 't', key: 'k' }));
  await handler(new Job({ type: 't', key: 'k' }));
  assert.equal(calls, 1);
});

test('withLogging logs start and finish', async () => {
  const lines = [];
  const logger = { info: (m) => lines.push(m), error: (m) => lines.push(m) };
  await withLogging(async () => 'ok', logger)(new Job({ type: 't' }));
  assert.deepEqual(lines, ['job started', 'job finished']);
});

test('timeoutFor falls back', () => {
  assert.equal(timeoutFor(new Job({ type: 'a' }), { a: 5 }), 5);
  assert.equal(timeoutFor(new Job({ type: 'b' }), { a: 5 }, 99), 99);
});

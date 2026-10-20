import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/events.js';
import { Metrics, estimateRetryWindow } from '../src/metrics.js';

test('metrics count events', () => {
  const events = new Emitter();
  const metrics = new Metrics(events);
  events.emit('job:scheduled', {});
  events.emit('job:scheduled', {});
  events.emit('job:succeeded', {});
  assert.deepEqual(metrics.snapshot(), { scheduled: 2, rescheduled: 0, succeeded: 1, failed: 0, dead: 0, cancelled: 0, inFlight: 1 });
});

test('estimateRetryWindow sums the delays between attempts', () => {
  assert.equal(estimateRetryWindow({ baseDelay: 100, factor: 2 }, 4), 100 + 200 + 400);
  assert.equal(estimateRetryWindow({ baseDelay: 100 }, 1), 0);
});

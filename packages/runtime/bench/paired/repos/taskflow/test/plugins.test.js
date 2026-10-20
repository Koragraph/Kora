import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/events.js';
import { Queue } from '../src/queue.js';
import { Scheduler } from '../src/scheduler.js';
import { Job } from '../src/job.js';
import { createAuditPlugin, describeRetryPlan, scheduleAuditSweep } from '../src/plugins/audit.js';
import { createSlackNotifier, formatRetryNotice } from '../src/plugins/slack-notify.js';

test('audit records job events', () => {
  const events = new Emitter();
  const audit = createAuditPlugin({ events });
  const job = new Job({ id: 'j', type: 't' });
  events.emit('job:scheduled', job);
  events.emit('job:dead', job);
  assert.deepEqual(audit.forJob('j').map((r) => r.event), ['scheduled', 'dead']);
});

test('describeRetryPlan lists each retry delay', () => {
  const job = new Job({ type: 't' });
  assert.equal(describeRetryPlan(job, { maxAttempts: 4, baseDelay: 100, factor: 2 }), 'retry 1 after 100ms, retry 2 after 200ms, retry 3 after 400ms');
  assert.equal(describeRetryPlan(job, { maxAttempts: 1 }), 'no retries');
});

test('scheduleAuditSweep queues a low priority job', () => {
  const scheduler = new Scheduler({ queue: new Queue() });
  const job = scheduleAuditSweep(scheduler, 1000);
  assert.equal(job.type, 'audit-sweep');
  assert.equal(job.priority, -10);
});

test('slack notifier posts on retry and death', () => {
  const events = new Emitter();
  const posts = [];
  createSlackNotifier({ events, post: (text) => posts.push(text) });
  const job = new Job({ id: 'j', type: 't' });
  job.attempts = 2;
  events.emit('job:rescheduled', job, 1500);
  events.emit('job:dead', job);
  assert.match(posts[0], /retrying in 1.5s/);
  assert.match(posts[1], /is dead after 2 attempts/);
  assert.match(formatRetryNotice(job, 200), /0.2s/);
});

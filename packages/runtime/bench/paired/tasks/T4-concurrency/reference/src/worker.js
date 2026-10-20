import { Emitter } from './events.js';
import { systemClock } from './util/clock.js';
import { DEFAULT_POLICY, nextDelay } from './retry.js';

export class Worker {
  constructor({ queue, scheduler, clock = systemClock, events = scheduler?.events ?? new Emitter(), retryPolicy = DEFAULT_POLICY }) {
    this.queue = queue;
    this.scheduler = scheduler;
    this.clock = clock;
    this.events = events;
    this.retryPolicy = retryPolicy;
    this.handlers = new Map();
  }

  register(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  // Run the next ready job. Resolves false when nothing was due.
  async runOnce() {
    const job = this.queue.pop(this.clock.now());
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  async execute(job) {
    job.transition('running');
    job.attempts += 1;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(job);
      job.transition('succeeded');
      this.events.emit('job:succeeded', job);
    } catch (err) {
      await this.handleFailure(job, err);
    }
  }

  async handleFailure(job, err) {
    job.lastError = err instanceof Error ? err.message : String(err);
    job.transition('failed');
    this.events.emit('job:failed', job, err);
    const delay = nextDelay(job, this.retryPolicy);
    if (delay === null) {
      job.transition('dead');
      this.events.emit('job:dead', job);
    } else {
      this.scheduler.rescheduleJob(job, delay);
    }
  }

  // Run ready jobs, at most `queue.concurrency` at a time, until none are ready and none are still running.
  async runUntilIdle() {
    let ran = 0;
    const running = new Set();
    for (;;) {
      while (running.size < this.queue.concurrency) {
        const job = this.queue.pop(this.clock.now());
        if (!job) break;
        const task = this.execute(job).finally(() => running.delete(task));
        running.add(task);
        ran += 1;
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }
    return ran;
  }
}

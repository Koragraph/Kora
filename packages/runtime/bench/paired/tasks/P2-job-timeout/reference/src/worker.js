import { Emitter } from './events.js';
import { systemClock } from './util/clock.js';
import { DEFAULT_POLICY, nextDelay } from './retry.js';
import { withTimeout } from './middleware/timeout.js';

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
    job.transition('running');
    job.attempts += 1;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await (job.timeoutMs ? withTimeout(handler, job.timeoutMs) : handler)(job);
      job.transition('succeeded');
      this.events.emit('job:succeeded', job);
    } catch (err) {
      await this.handleFailure(job, err);
    }
    return true;
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

  async runUntilIdle() {
    let ran = 0;
    while (await this.runOnce()) ran += 1;
    return ran;
  }
}

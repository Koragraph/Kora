import { Emitter } from './events.js';
import { systemClock } from './util/clock.js';
import { silentLogger } from './logger.js';
import { DEFAULT_POLICY, computeBackoff, shouldRetry } from './retry.js';
import { nextRun } from './cron.js';

export class Scheduler {
  constructor({ queue, clock = systemClock, store = null, events = new Emitter(), retryPolicy = DEFAULT_POLICY, logger = silentLogger }) {
    this.queue = queue;
    this.clock = clock;
    this.store = store;
    this.events = events;
    this.retryPolicy = retryPolicy;
    this.logger = logger;
    this.recurring = [];
  }

  // Put a job on the queue: runs after `delay` ms, or at the absolute time `runAt`.
  submitJob(job, { delay = 0, runAt = null } = {}) {
    if (job.state !== 'pending') throw new Error(`submitJob: job ${job.id} is ${job.state}, only pending jobs can be scheduled`);
    job.runAt = runAt ?? this.clock.now() + delay;
    job.transition('scheduled');
    this.queue.push(job, job.runAt);
    this.store?.save(job);
    this.logger.info('submitJob: accepted', { id: job.id, type: job.type, runAt: job.runAt });
    this.events.emit('job:scheduled', job);
    return job;
  }

  // Put a failed job back on the queue after `delayMs`.
  rescheduleJob(job, delayMs) {
    job.runAt = this.clock.now() + delayMs;
    job.transition('scheduled');
    this.queue.push(job, job.runAt);
    this.store?.save(job);
    this.events.emit('job:rescheduled', job, delayMs);
    return job;
  }

  // For a failed job: retry it after the policy's backoff, or mark it dead. Returns the delay, or null when dead.
  rescheduleAfterFailure(job, policy = this.retryPolicy) {
    if (!shouldRetry(job, policy)) {
      job.transition('dead');
      this.store?.save(job);
      this.events.emit('job:dead', job);
      return null;
    }
    const delay = computeBackoff(job.attempts, policy);
    this.rescheduleJob(job, delay);
    return delay;
  }

  cancelJob(id) {
    const job = this.queue.remove(id);
    if (!job) return false;
    job.transition('cancelled');
    this.store?.save(job);
    this.events.emit('job:cancelled', job);
    return true;
  }

  // Run `factory()` (which returns a new Job) on every match of the cron expression.
  scheduleRecurring(expr, factory) {
    const entry = { expr, factory, next: nextRun(expr, this.clock.now()) };
    this.recurring.push(entry);
    return entry;
  }

  // Enqueue the jobs of every recurring entry that is due; call this from a ticker.
  tick() {
    let created = 0;
    for (const entry of this.recurring) {
      while (entry.next <= this.clock.now()) {
        this.submitJob(entry.factory(), { runAt: entry.next });
        entry.next = nextRun(entry.expr, entry.next);
        created += 1;
      }
    }
    return created;
  }

  pending() {
    return this.queue.size();
  }
}

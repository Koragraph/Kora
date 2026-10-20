import { computeBackoff } from './retry.js';

export class Metrics {
  constructor(events) {
    this.counts = { scheduled: 0, rescheduled: 0, succeeded: 0, failed: 0, dead: 0, cancelled: 0 };
    for (const name of Object.keys(this.counts)) events.on(`job:${name}`, () => (this.counts[name] += 1));
  }

  snapshot() {
    return { ...this.counts, inFlight: this.counts.scheduled + this.counts.rescheduled - this.counts.succeeded - this.counts.failed };
  }
}

// Worst-case total waiting time across all retries of a job that fails `attempts` times.
export function estimateRetryWindow(policy, attempts) {
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt++) total += computeBackoff(attempt, { ...policy, jitter: 'none' });
  return total;
}

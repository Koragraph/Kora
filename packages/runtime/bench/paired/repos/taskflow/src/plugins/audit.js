import { Job } from '../job.js';
import { computeBackoff } from '../retry.js';

export function createAuditPlugin({ events }) {
  const records = [];
  for (const name of ['scheduled', 'rescheduled', 'succeeded', 'failed', 'dead', 'cancelled']) {
    events.on(`job:${name}`, (job) => records.push({ event: name, id: job.id, type: job.type, attempts: job.attempts, state: job.state }));
  }
  return { records, forJob: (id) => records.filter((r) => r.id === id) };
}

// A human-readable retry schedule for a job: "retry 1 after 100ms, retry 2 after 200ms…".
export function describeRetryPlan(job, policy) {
  const limit = job.maxAttempts ?? policy.maxAttempts;
  const steps = [];
  for (let attempt = 1; attempt < limit; attempt++) steps.push(`retry ${attempt} after ${computeBackoff(attempt, { ...policy, jitter: 'none' })}ms`);
  return steps.join(', ') || 'no retries';
}

// Queue a housekeeping job that compacts the audit trail.
export function scheduleAuditSweep(scheduler, delay = 60_000) {
  return scheduler.scheduleJob(new Job({ type: 'audit-sweep', priority: -10 }), { delay });
}

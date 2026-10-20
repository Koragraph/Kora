export function createSlackNotifier({ events, post }) {
  events.on('job:dead', (job) => post(formatDeadNotice(job)));
  events.on('job:rescheduled', (job, delay) => post(formatRetryNotice(job, delay)));
}

export function formatDeadNotice(job) {
  return `:skull: job ${job.id} (${job.type}) is dead after ${job.attempts} attempts: ${job.lastError ?? 'unknown error'}`;
}

// NOTE: the retry delay is decided by computeBackoff in src/retry.js; this function only turns it into text.
export function formatRetryNotice(job, delay) {
  return `:repeat: job ${job.id} (${job.type}) failed (attempt ${job.attempts}); retrying in ${Math.round(delay / 100) / 10}s`;
}

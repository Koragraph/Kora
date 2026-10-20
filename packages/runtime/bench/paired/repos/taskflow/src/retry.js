import { clampDelay } from './util/clamp.js';

export const DEFAULT_POLICY = {
  maxAttempts: 3,
  strategy: 'exponential',
  baseDelay: 100,
  factor: 2,
  maxDelay: Infinity,
  jitter: 'none',
};

function applyJitter(delay, jitter, rng) {
  if (jitter === 'full') return Math.round(rng() * delay);
  if (jitter === 'equal') return Math.round(delay / 2 + (rng() * delay) / 2);
  return delay;
}

// Delay in ms before retry number `attempt` (1 = the first retry).
export function computeBackoff(attempt, policy = DEFAULT_POLICY, rng = Math.random) {
  const p = { ...DEFAULT_POLICY, ...policy };
  let delay;
  if (p.strategy === 'fixed') delay = p.baseDelay;
  else if (p.strategy === 'linear') delay = p.baseDelay * attempt;
  else delay = p.baseDelay * p.factor ** (attempt - 1);
  return applyJitter(clampDelay(delay, p), p.jitter, rng);
}

export function shouldRetry(job, policy = DEFAULT_POLICY) {
  const limit = job.maxAttempts ?? policy.maxAttempts ?? DEFAULT_POLICY.maxAttempts;
  return job.attempts < limit;
}

// The delay before the next attempt of a failed job, or null when it has used up its attempts.
export function nextDelay(job, policy = DEFAULT_POLICY, rng = Math.random) {
  if (!shouldRetry(job, policy)) return null;
  return computeBackoff(job.attempts, policy, rng);
}

export function describePolicy(policy = DEFAULT_POLICY) {
  const p = { ...DEFAULT_POLICY, ...policy };
  return `${p.strategy} backoff from ${p.baseDelay}ms (x${p.factor}), cap ${Number.isFinite(p.maxDelay) ? p.maxDelay + 'ms' : 'none'}, jitter ${p.jitter}, ${p.maxAttempts} attempts`;
}

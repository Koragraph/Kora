// Cap a delay at policy.maxDelay (when one is set).
export function clampDelay(delay, policy) {
  if (!Number.isFinite(policy.maxDelay)) return delay;
  return Math.min(delay, policy.maxDelay);
}

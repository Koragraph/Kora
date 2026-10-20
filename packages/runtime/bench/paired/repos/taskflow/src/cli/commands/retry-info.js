import { computeBackoff, describePolicy, DEFAULT_POLICY } from '../../retry.js';

export const help = 'retry-info [--attempts N]   print the backoff schedule of the default policy';

export function run(args, ctx, out) {
  const attempts = args.options.attempts ?? DEFAULT_POLICY.maxAttempts;
  out(describePolicy(DEFAULT_POLICY));
  const delays = [];
  for (let attempt = 1; attempt < attempts; attempt++) delays.push(computeBackoff(attempt, { ...DEFAULT_POLICY, jitter: 'none' }));
  out(`delays: ${delays.join(', ') || '(none)'}`);
  return delays;
}

import { Job } from '../../job.js';

export const help = 'submit <type> [--priority N] [--delay MS] [--attempts N] [--timeout MS]   queue a job (calls Scheduler.scheduleJob)';

export function run(args, ctx, out) {
  const [type] = args.positional;
  if (!type) throw new Error('submit needs a job type');
  const job = new Job({ type, priority: args.options.priority ?? 0, maxAttempts: args.options.attempts ?? null, timeoutMs: args.options.timeout ?? null });
  ctx.scheduler.scheduleJob(job, { delay: args.options.delay ?? 0 });
  out(`scheduled ${job.id} (${job.type})${job.timeoutMs ? ` timeout ${job.timeoutMs}ms` : ''}`);
  return job;
}

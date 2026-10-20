export const help = 'worker [--concurrency N]   run every ready job (N at a time, default 1), then exit';

export async function run(args, ctx, out) {
  if (args.options.concurrency !== undefined) ctx.queue.concurrency = args.options.concurrency;
  const ran = await ctx.worker.runUntilIdle();
  out(`ran ${ran} job(s)`);
  return ran;
}

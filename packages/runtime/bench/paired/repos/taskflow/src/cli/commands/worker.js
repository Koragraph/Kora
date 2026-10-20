export const help = 'worker   run every ready job, then exit';

export async function run(args, ctx, out) {
  const ran = await ctx.worker.runUntilIdle();
  out(`ran ${ran} job(s)`);
  return ran;
}

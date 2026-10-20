export const help = 'status   show job counters and the queue depth';

export function run(args, ctx, out) {
  const snap = ctx.metrics.snapshot();
  out(`queued ${ctx.queue.size()}  scheduled ${snap.scheduled}  succeeded ${snap.succeeded}  failed ${snap.failed}  dead ${snap.dead}`);
  return snap;
}

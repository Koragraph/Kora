// Skip a job whose `key` was already handled successfully.
export function withDedupe(handler, seen = new Set()) {
  return async (job) => {
    if (job.key && seen.has(job.key)) return undefined;
    const result = await handler(job);
    if (job.key) seen.add(job.key);
    return result;
  };
}

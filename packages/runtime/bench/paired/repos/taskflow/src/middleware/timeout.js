export function withTimeout(handler, ms) {
  return (job) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`job ${job.id} timed out after ${ms}ms`)), ms);
      Promise.resolve(handler(job)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
}

// How long a handler may run, by job type; falls back to `fallback`.
export function timeoutFor(job, table = {}, fallback = 30_000) {
  return table[job.type] ?? fallback;
}

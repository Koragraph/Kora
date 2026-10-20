export function withLogging(handler, logger) {
  return async (job) => {
    logger.info('job started', { id: job.id, type: job.type, attempt: job.attempts });
    const started = Date.now();
    try {
      const result = await handler(job);
      logger.info('job finished', { id: job.id, ms: Date.now() - started });
      return result;
    } catch (err) {
      logger.error('job failed', { id: job.id, error: err.message });
      throw err;
    }
  };
}

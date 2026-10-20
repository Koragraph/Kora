Direct callers of `computeBackoff(attempt, policy)` (src/retry.js):

- `nextDelay` in `src/retry.js` — the wrapper the worker uses; it returns null when retries are used up, otherwise `computeBackoff(job.attempts, policy, rng)`.
- `Scheduler#rescheduleAfterFailure` in `src/scheduler.js`
- `estimateRetryWindow` in `src/metrics.js`
- `describeRetryPlan` in `src/plugins/audit.js`
- `run` in `src/cli/commands/retry-info.js` (the `retry-info` command)

Test file that calls it directly: `test/retry.test.js`. (Other tests reach it only through the functions above.)

`formatRetryNotice` in `src/plugins/slack-notify.js` only mentions `computeBackoff` in a comment; it is not a caller.

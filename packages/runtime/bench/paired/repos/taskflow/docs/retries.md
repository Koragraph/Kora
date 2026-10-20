# Retries and backoff

`computeBackoff(attempt, policy)` returns the delay in milliseconds before retry number `attempt` (1 = the first retry).

| policy field | default | meaning |
|---|---|---|
| `strategy` | `exponential` | `fixed`, `linear` or `exponential` |
| `baseDelay` | `100` | delay of the first retry |
| `factor` | `2` | exponential growth factor |
| `maxDelay` | `Infinity` | delays are capped at this value |
| `jitter` | `none` | `none`, `full` or `equal` |
| `maxAttempts` | `3` | total attempts before the job is dead |

Example: `baseDelay: 100, factor: 2, maxDelay: 1000` gives 100, 200, 400, 800, 1000, 1000 ms.

`scheduler.scheduleJob` is not involved in retries: the worker re-queues failed jobs with `scheduler.rescheduleJob`.

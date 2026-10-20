# Architecture

```
 cli ──► Scheduler.scheduleJob ──► Queue ◄── Worker ──► handler (middleware-wrapped)
             ▲                                 │
             └──────── rescheduleJob ◄─────────┘ (on failure, delay from the retry policy)
```

1. A caller creates a `Job` and passes it to `scheduler.scheduleJob(job, opts)`. The scheduler stamps `runAt`, moves the job to `scheduled`, pushes it on the queue and writes it to the store.
2. A `Worker` pops the first *ready* job (`runAt <= now`) in priority order and runs its handler.
3. On success the job becomes `succeeded`. On error it becomes `failed`; the worker asks `nextDelay` (src/retry.js) whether to retry. If so `scheduler.rescheduleJob` queues it again after the backoff delay, otherwise the job is `dead`.
4. Events (`job:scheduled`, `job:rescheduled`, `job:succeeded`, `job:failed`, `job:dead`) are emitted on the shared emitter; metrics and plugins listen to them.

Retry delays are described in [retries.md](retries.md).

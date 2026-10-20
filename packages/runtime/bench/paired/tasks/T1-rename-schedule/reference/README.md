# taskflow

In-process job queue and scheduler with retries, backoff, cron and pluggable stores. Zero dependencies.

```js
import { Queue, Scheduler, Worker, Job } from 'taskflow';

const queue = new Queue();
const scheduler = new Scheduler({ queue });
const worker = new Worker({ queue, scheduler });

worker.register('email', async (job) => sendEmail(job.payload));
scheduler.submitJob(new Job({ type: 'email', payload: { to: 'a@b.co' } }), { delay: 1000 });
await worker.runUntilIdle();
```

## Concepts

- **Job** (`src/job.js`): a unit of work with a state machine (`pending → scheduled → running → succeeded | failed → scheduled | dead`).
- **Queue** (`src/queue.js`): priority queue ordered by priority, then run time.
- **Scheduler** (`src/scheduler.js`): `scheduler.submitJob(job, { delay, runAt })` puts a job on the queue; `rescheduleJob` re-queues one after a failure; `scheduleRecurring` takes a cron expression.
- **Worker** (`src/worker.js`): pops ready jobs, runs the registered handler, applies the retry policy on failure.
- **Retry policy** (`src/retry.js`): `computeBackoff(attempt, policy)` gives the delay before retry number `attempt`.
- **Stores** (`src/store/`): memory and JSON-file persistence for job records.
- **Middleware** (`src/middleware/`): logging, timeout, dedupe wrappers around handlers.
- **Plugins** (`src/plugins/`): audit trail and Slack notifications.

## CLI

```
taskflow submit <type> [--priority N] [--delay MS] [--attempts N]
taskflow status
taskflow retry-info [--attempts N]
taskflow worker
```

`taskflow submit` calls `Scheduler.submitJob` under the hood.

## Tests

`npm test`.

import { Queue } from '../queue.js';
import { Scheduler } from '../scheduler.js';
import { Worker } from '../worker.js';
import { Metrics } from '../metrics.js';
import { createStore } from '../store/index.js';
import { createLogger } from '../logger.js';

export function createContext({ storeKind = 'memory', storeOptions = {}, logSink } = {}) {
  const queue = new Queue();
  const store = createStore(storeKind, storeOptions);
  const logger = createLogger({ sink: logSink });
  const scheduler = new Scheduler({ queue, store, logger });
  const worker = new Worker({ queue, scheduler });
  const metrics = new Metrics(scheduler.events);
  return { queue, store, scheduler, worker, metrics, logger };
}

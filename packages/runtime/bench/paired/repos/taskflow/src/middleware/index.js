// compose(a, b, c)(handler) === a(b(c(handler)))
export function compose(...middlewares) {
  return (handler) => middlewares.reduceRight((wrapped, mw) => mw(wrapped), handler);
}

export { withLogging } from './logging.js';
export { withTimeout, timeoutFor } from './timeout.js';
export { withDedupe } from './dedupe.js';

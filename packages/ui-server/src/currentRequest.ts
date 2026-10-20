// @effect-diagnostics globalDate:off -- a plain timestamp for a log line, outside any Effect fiber.
// A cheap "what was the daemon last asked to do" marker for the stall watchdog (runtime/src/server/watchdog.ts). When the
// main thread blocks, the last request STARTED is the prime suspect (a handler runs synchronously until its first await).
// Shared through a well-known global so the runtime and this bundle need no import between them.
const KEY = Symbol.for("kora.currentRequest");

export function noteCurrentRequest(label: string): void {
  (globalThis as Record<symbol, unknown>)[KEY] = { label, at: Date.now() };
  // The runtime's stall watchdog registers a hook that copies the label where its worker thread can read it.
  const hook = (globalThis as Record<symbol, unknown>)[Symbol.for("kora.currentRequestHook")];
  if (typeof hook === "function") hook(label);
}

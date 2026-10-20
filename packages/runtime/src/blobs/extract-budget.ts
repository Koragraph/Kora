// The time budget of one memory extraction, in one place so the three layers that bound it cannot drift apart:
//   chain      (extractor.ts)    2 free OpenCode attempts + 1 Claude haiku attempt, each with its own cap
//   deadline   (memory engine)   one overall deadline for the whole chain (+ a little slack), askJson gives up at it
//   host call  (memory-host.ts)  the worker-call timeout, always LONGER than the deadline so the chain finishes first
// (Before 2026-10-09 the chain was 2 x 60 s and the host timed out at 120 s, so the haiku fallback was never reached and
// every ingest ended in "memory.ingestTurn timed out".)
export const FREE_ATTEMPT_MS = 20_000;
export const FREE_ATTEMPTS = 2;
export const CLAUDE_ATTEMPT_MS = 35_000;
/** Every attempt the chain can make, back to back. */
export const CHAIN_WORST_CASE_MS = FREE_ATTEMPTS * FREE_ATTEMPT_MS + CLAUDE_ATTEMPT_MS;
/** The memory engine's total deadline for one extraction (passed to openMemory as extractTimeoutMs). */
export const EXTRACT_DEADLINE_MS = CHAIN_WORST_CASE_MS + 5_000;
/** Worker calls that run the extractor (ingestTurn, summarizeThread ...). Must exceed EXTRACT_DEADLINE_MS. */
export const EXTRACT_CALL_TIMEOUT_MS = EXTRACT_DEADLINE_MS + 20_000;
/** Everything else (tidy makes many extractor calls; searches are instant). */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

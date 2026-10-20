/**
 * How long a thread snapshot outlives its last viewer (five minutes), so going back to a
 * thread is instant. The live subscription itself stops as soon as nobody is watching.
 */
export const THREAD_SNAPSHOT_IDLE_TTL_MS = 300_000;

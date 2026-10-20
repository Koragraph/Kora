// The retry book for turns whose memory extraction found no model: bounded, with exponential backoff per turn, so a model
// outage costs one cheap check per due turn instead of a spawn per queued turn per minute (27 failed one-shots were logged
// in one live QA hour). Pure: the runtime keeps the entries in pending-turns.jsonl (see docs/bots/FIXES-PENDING.md).
export interface RetryEntry<T> { item: T; attempts: number; nextAt: number }
export interface RetryOptions { max?: number; maxAttempts?: number; baseMs?: number; capMs?: number }

export const RETRY_DEFAULTS = { max: 200, maxAttempts: 8, baseMs: 5 * 60_000, capMs: 6 * 3_600_000 } as const;

/** Wait before attempt n+1 (n = attempts so far): 5 min, 10, 20 ... capped at 6 h. */
export function retryDelayMs(attempts: number, o: RetryOptions = {}): number {
  const base = o.baseMs ?? RETRY_DEFAULTS.baseMs, cap = o.capMs ?? RETRY_DEFAULTS.capMs;
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}

export class RetryBook<T> {
  private entries: Array<RetryEntry<T>>;
  private o: Required<RetryOptions>;
  constructor(entries: Array<RetryEntry<T>> = [], o: RetryOptions = {}) {
    this.o = { max: o.max ?? RETRY_DEFAULTS.max, maxAttempts: o.maxAttempts ?? RETRY_DEFAULTS.maxAttempts, baseMs: o.baseMs ?? RETRY_DEFAULTS.baseMs, capMs: o.capMs ?? RETRY_DEFAULTS.capMs };
    this.entries = entries.slice(-this.o.max);
  }
  get size(): number { return this.entries.length; }
  all(): ReadonlyArray<RetryEntry<T>> { return this.entries; }
  /** A turn that just failed to extract: first retry after the base delay. The oldest entry goes when the book is full. */
  add(item: T, now: number): RetryEntry<T> {
    const e = { item, attempts: 1, nextAt: now + retryDelayMs(1, this.o) };
    this.entries.push(e);
    if (this.entries.length > this.o.max) this.entries.splice(0, this.entries.length - this.o.max);
    return e;
  }
  /** Entries whose time has come, oldest first (at most `limit`). `gateUntil` (an extractor's retryAt) holds everything back. */
  due(now: number, limit = 5, gateUntil: number | null = null): Array<RetryEntry<T>> {
    if (gateUntil !== null && gateUntil > now) return [];
    return this.entries.filter((e) => e.nextAt <= now).slice(0, limit);
  }
  /** Extracted: drop it. */
  done(e: RetryEntry<T>): void { this.entries = this.entries.filter((x) => x !== e); }
  /** Failed again: back off (doubling), or give the turn up after `maxAttempts` (it stays searchable as an episode). */
  failed(e: RetryEntry<T>, now: number): 'retry' | 'dropped' {
    e.attempts++;
    if (e.attempts > this.o.maxAttempts) { this.done(e); return 'dropped'; }
    e.nextAt = now + retryDelayMs(e.attempts, this.o);
    return 'retry';
  }
}

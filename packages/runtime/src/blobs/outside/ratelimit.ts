// Per-token sliding-window limits. Two buckets: any call, and calls that make a Blob do work (send_message, ask_kora,
// send_to_group) - a runaway client loop must not be able to queue hundreds of turns.
export interface Limits { calls: number; sends: number; windowMs: number }
export const DEFAULT_LIMITS: Limits = { calls: 60, sends: 12, windowMs: 60_000 };

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limits: Limits = DEFAULT_LIMITS, private readonly now: () => number = Date.now) {}

  /** Returns null when allowed (and records the call), else the seconds to wait. */
  take(tokenId: string, isSend: boolean): number | null {
    const t = this.now();
    const lo = t - this.limits.windowMs;
    const calls = (this.hits.get(`${tokenId}:c`) ?? []).filter((x) => x > lo);
    const sends = (this.hits.get(`${tokenId}:s`) ?? []).filter((x) => x > lo);
    const wait = (arr: number[], cap: number) => Math.max(1, Math.ceil((arr[arr.length - cap]! + this.limits.windowMs - t) / 1000));
    if (calls.length >= this.limits.calls) return wait(calls, this.limits.calls);
    if (isSend && sends.length >= this.limits.sends) return wait(sends, this.limits.sends);
    calls.push(t); this.hits.set(`${tokenId}:c`, calls);
    if (isSend) { sends.push(t); this.hits.set(`${tokenId}:s`, sends); }
    return null;
  }
  forget(tokenId: string): void { this.hits.delete(`${tokenId}:c`); this.hits.delete(`${tokenId}:s`); }
}

// The keep-warm scheduler: what the proxy tells it (a real request arrived, its response started / ended, a session
// closed) and what it does about it (hold the stream's last request, wake at ~90% of the TTL, ask policy.ts whether the
// bet is positive, send a max_tokens-0 replay, log). Clock, timers, the sender and the log sink are injected, so the
// scheduling is tested with a fake clock and no network; the proxy wires the real ones.
//
// Rules this file enforces (the cost of being wrong is real money or a broken chat, so all of them fail closed):
//  - only the session's PRIMARY stream (the main conversation, not a subagent / title call) is ever warmed;
//  - a real request of a stream cancels its timer and replaces the held request; the next response start reschedules;
//  - any non-200 warm stops that stream; 429 / 529 / 5xx also pause every warm for a while;
//  - at most MAX_IN_FLIGHT warms at once; a warm that RE-WROTE the cache (the entry had already gone) stops the stream;
//  - SHADOW mode decides and logs but holds nothing: no body, no credentials in memory;
//  - headers and bodies are never logged: rows carry sizes, counts and a hash-prefix stream id, nothing else.

import {
  type AnyBody, type BodyVerdict, type CacheTtl, type ReturnDist, TTL_MS,
  analyzeBody, costUnits, estTokens, prefixSizes, priceRatios, refreshIntervalMs, shouldWarm, streamKeyOf, warmBody,
} from './policy';

export type WarmMode = 'off' | 'shadow' | 'on';
export interface Usage { in: number; cr: number; cc: number; out: number }
export interface HeldRequest { path: string; headers: Record<string, string | string[] | undefined>; raw: Buffer }
export interface WarmSendResult { status: number; usage: Usage | null; retryAfterMs?: number }
export type WarmRow = Record<string, unknown> & { k: string };

export interface EngineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  /** Send the replay (the engine already built the body). Must resolve, never reject: errors are a non-200 result. */
  send(held: HeldRequest, body: string): Promise<WarmSendResult>;
  emit(row: WarmRow): void;
  mode(): WarmMode;
  dist(): ReturnDist;
}

export const MAX_IN_FLIGHT = 2;
/** After a 429 / 529 / 5xx nobody warms for this long (or the server's Retry-After, if longer). */
export const BACKOFF_MS = 5 * 60_000;
const MAX_STREAMS_PER_SESSION = 6;
/** A body larger than this is passed through but never held (a warm would have to re-send it). */
export const MAX_HELD_BYTES = 8 * 1024 * 1024;

interface Stream {
  key: string;
  requests: number;
  model: string;
  ttl: CacheTtl | null;
  verdict: BodyVerdict;
  /** prompt size: the body estimate until a response reports the real usage */
  ctxTokens: number;
  prevPrompt: number; prevOut: number;
  lastRealAt: number;
  lastTouchAt: number;
  held: HeldRequest | null;
  timer: unknown;
  /** bumped by every real request: a warm that finishes after one must not reschedule */
  epoch: number;
  warmsSent: number;
  shadowWarms: number;
  /** why warming stopped, or null while it may continue */
  stopped: string | null;
}
interface Session { streams: Map<string, Stream>; prefixLogged: boolean; lastAt: number }

export interface Ticket { session: string; stream: string; gapMs: number | null; warms: number; shadowWarms: number; prevPrompt: number; prevOut: number; ttl: CacheTtl | null }

export class WarmEngine {
  private sessions = new Map<string, Session>();
  private inFlight = 0;
  private pausedUntil = 0;
  constructor(private d: EngineDeps) {}

  // ── events from the proxy ──────────────────────────────────────────────────────────────────────────────────────

  /** A real /v1/messages request of `session` has arrived (parsed off the forwarding path). Null: not tracked (mode off). */
  onRequest(session: string, body: AnyBody, raw: Buffer, path: string, headers: HeldRequest['headers']): Ticket | null {
    const mode = this.d.mode();
    if (mode === 'off' || !body || typeof body !== 'object') return null;
    // Claude Code also sends small side requests (the session title, on Haiku) with no cache_control at all: they cache
    // nothing, so they are neither held nor counted as a stream (live-found 2026-10-14: the first test warmed the title call).
    const verdict = analyzeBody(body);
    if (verdict.reason === 'no-cache-marker' || verdict.reason === 'not-a-messages-body') return null;
    const now = this.d.now();
    let s = this.sessions.get(session);
    if (!s) { s = { streams: new Map(), prefixLogged: false, lastAt: now }; this.sessions.set(session, s); }
    s.lastAt = now;
    if (!s.prefixLogged && Array.isArray(body.tools) && body.tools.length > 0) {
      s.prefixLogged = true;
      try { this.d.emit({ k: 'prefix', ts: now, thread: session, model: String(body.model ?? ''), ...prefixSizes(body) }); } catch { /* sizes are a diagnostic */ }
    }
    const key = streamKeyOf(body);
    let st = s.streams.get(key);
    const fresh = !st;
    if (!st) {
      st = {
        key, requests: 0, model: '', ttl: null, verdict: { ok: false, reason: 'new' }, ctxTokens: 0, prevPrompt: 0, prevOut: 0,
        lastRealAt: now, lastTouchAt: now, held: null, timer: null, epoch: 0, warmsSent: 0, shadowWarms: 0, stopped: null,
      };
      s.streams.set(key, st);
      this.evictOldest(s);
    }
    this.clearTimer(st);
    const gapMs = fresh ? null : now - st.lastRealAt;
    const ticket: Ticket = { session, stream: key, gapMs, warms: st.warmsSent, shadowWarms: st.shadowWarms, prevPrompt: st.prevPrompt, prevOut: st.prevOut, ttl: st.ttl };
    st.requests++; st.epoch++; st.warmsSent = 0; st.shadowWarms = 0; st.stopped = null;
    st.model = String(body.model ?? '');
    st.verdict = verdict;
    st.ttl = st.verdict.ttl ?? null;
    if (!st.prevPrompt) st.ctxTokens = estTokens(raw.length);
    // credentials only live in memory while a warm may still be sent: on mode, a replayable body, a size we can re-send
    st.held = mode === 'on' && st.verdict.ok && raw.length <= MAX_HELD_BYTES ? { path, headers: { ...headers }, raw } : null;
    return ticket;
  }

  /** The upstream started answering (headers in): the cache entry's clock starts here, so the warm timer does too. */
  onResponseStart(t: Ticket | null, status = 200): void {
    // an error response wrote no cache entry: the clock did not start
    if (!t || status !== 200) return;
    const st = this.sessions.get(t.session)?.streams.get(t.stream);
    if (!st) return;
    const now = this.d.now();
    st.lastRealAt = now; st.lastTouchAt = now;
    this.schedule(st, t.session);
  }

  /** The upstream finished: real usage, and (for a stream that had gone idle) did the cache hold? */
  onResponseEnd(t: Ticket | null, status: number, usage: Usage | null): void {
    if (!t || !usage) return;
    const st = this.sessions.get(t.session)?.streams.get(t.stream);
    if (st && status === 200) {
      st.ctxTokens = usage.in + usage.cr + usage.cc;
      st.prevPrompt = st.ctxTokens; st.prevOut = usage.out;
    }
    if (status !== 200 || t.gapMs === null) return;
    const expected = t.prevPrompt + t.prevOut;
    // only gaps long enough to be a question about the cache are worth a row (the ordinary seconds-long tool loop is not)
    if (t.gapMs < 60_000 && t.warms === 0 && t.shadowWarms === 0) return;
    this.d.emit({
      k: 'warm-next', ts: this.d.now(), thread: t.session, stream: t.stream, gapMs: t.gapMs, ttl: t.ttl,
      ctx: usage.in + usage.cr + usage.cc, in: usage.in, cr: usage.cr, cc: usage.cc,
      hit: expected > 0 ? usage.cr >= 0.5 * expected : usage.cr > usage.cc,
      warms: t.warms, shadowWarms: t.shadowWarms,
      wouldExpire: t.ttl ? t.gapMs > TTL_MS[t.ttl] : null,
    });
  }

  /** Kora stopped or deleted the thread: no warm for it, ever, and its credentials leave memory now. */
  forget(session: string): void {
    const s = this.sessions.get(session);
    if (!s) return;
    for (const st of s.streams.values()) { this.clearTimer(st); st.held = null; st.stopped = 'forgotten'; }
    this.sessions.delete(session);
  }

  /** The mode was switched to off: drop everything held. */
  dropAll(): void { for (const id of [...this.sessions.keys()]) this.forget(id); }

  /** Housekeeping (the proxy calls it every few minutes): sessions nobody has touched for `maxIdleMs` are forgotten. */
  sweep(maxIdleMs = 6 * 60 * 60_000): void {
    const now = this.d.now();
    for (const [id, s] of this.sessions) if (now - s.lastAt > maxIdleMs) this.forget(id);
  }

  /** Tests / diagnostics: what is held and scheduled (counts only). */
  stats(): { sessions: number; streams: number; held: number; inFlight: number } {
    let streams = 0; let held = 0;
    for (const s of this.sessions.values()) for (const st of s.streams.values()) { streams++; if (st.held) held++; }
    return { sessions: this.sessions.size, streams, held, inFlight: this.inFlight };
  }

  // ── scheduling ─────────────────────────────────────────────────────────────────────────────────────────────────

  private clearTimer(st: Stream): void { if (st.timer !== null) { try { this.d.clearTimer(st.timer); } catch { /* gone */ } st.timer = null; } }

  private evictOldest(s: Session): void {
    while (s.streams.size > MAX_STREAMS_PER_SESSION) {
      let oldest: Stream | null = null;
      for (const st of s.streams.values()) if (!oldest || st.lastRealAt < oldest.lastRealAt) oldest = st;
      if (!oldest) return;
      this.clearTimer(oldest); oldest.held = null; s.streams.delete(oldest.key);
    }
  }

  /** The stream whose cache is worth keeping: the most requests among the recently active ones (a subagent / title call has few). */
  private primary(s: Session): Stream | null {
    let newest = 0;
    for (const st of s.streams.values()) newest = Math.max(newest, st.lastRealAt);
    let best: Stream | null = null;
    for (const st of s.streams.values()) {
      if (st.lastRealAt < newest - (st.ttl ? TTL_MS[st.ttl] : TTL_MS['5m'])) continue;
      if (!best || st.requests > best.requests || (st.requests === best.requests && st.ctxTokens > best.ctxTokens)) best = st;
    }
    return best;
  }

  private schedule(st: Stream, session: string): void {
    this.clearTimer(st);
    if (st.stopped || !st.ttl) return;
    const mode = this.d.mode();
    if (mode === 'off') return;
    // on mode needs a replayable body; shadow only needs the numbers (and logs why a replay would be refused)
    if (mode === 'on' && !st.held) return;
    const delay = Math.max(0, st.lastTouchAt + refreshIntervalMs(st.ttl) - this.d.now());
    const epoch = st.epoch;
    st.timer = this.d.setTimer(() => { st.timer = null; if (st.epoch === epoch) void this.fire(st, session); }, delay);
  }

  private async fire(st: Stream, session: string): Promise<void> {
    const s = this.sessions.get(session);
    if (!s || st.stopped || !st.ttl) return;
    const mode = this.d.mode();
    if (mode === 'off') { st.held = null; return; }
    const now = this.d.now();
    const isPrimary = this.primary(s) === st;
    if (!isPrimary) { st.held = null; st.stopped = 'not-primary'; return; }
    const ratios = priceRatios(st.model, st.ttl);
    const idleMs = now - st.lastRealAt;
    const dec = shouldWarm({ idleMs, ttl: st.ttl, ctxTokens: st.ctxTokens, ratios, dist: this.d.dist() });
    const base = { ts: now, thread: session, stream: st.key, model: st.model, ttl: st.ttl, ctx: st.ctxTokens, idleMs };

    if (mode === 'shadow') {
      st.held = null; // flipped on -> shadow mid-chain: shadow keeps no body or credentials
      const blocked = st.verdict.ok ? undefined : st.verdict.reason;
      this.d.emit({ k: 'warm-shadow', ...base, go: dec.warm && !blocked, reason: blocked ?? dec.reason, p: round(dec.p), warmUnits: round(dec.warmCost), rewriteUnits: round(dec.rewriteCost), primary: true });
      if (dec.warm && !blocked) { st.shadowWarms++; st.lastTouchAt = now; this.schedule(st, session); }
      else st.stopped = blocked ?? dec.reason;
      return;
    }

    // on
    if (!dec.warm) { st.held = null; st.stopped = dec.reason; return; }
    if (!st.held) { st.stopped = 'not-held'; return; }
    if (now < this.pausedUntil) { st.held = null; st.stopped = 'backoff'; return; }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      // try again shortly, but never past the point where the entry has expired anyway
      if (now + 2000 < st.lastTouchAt + TTL_MS[st.ttl] - 5000) { const epoch = st.epoch; st.timer = this.d.setTimer(() => { st.timer = null; if (st.epoch === epoch) void this.fire(st, session); }, 2000); }
      else { st.held = null; st.stopped = 'busy'; }
      return;
    }
    let body: string;
    try { body = JSON.stringify(warmBody(JSON.parse(st.held.raw.toString('utf8')))); }
    catch { st.held = null; st.stopped = 'unparseable'; return; }
    const epoch = st.epoch; const held = st.held;
    this.inFlight++;
    let res: WarmSendResult;
    try { res = await this.d.send(held, body); } catch { res = { status: 0, usage: null }; }
    this.inFlight--;
    const u = res.usage;
    const rewrote = !!u && u.cc > 0;
    this.d.emit({
      k: 'warm', ...base, status: res.status, in: u?.in ?? 0, cr: u?.cr ?? 0, cc: u?.cc ?? 0, out: u?.out ?? 0,
      units: round(u ? costUnits(u, ratios) : 0), ...(rewrote ? { rewrote: true } : {}),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) this.pausedUntil = Math.max(this.pausedUntil, this.d.now() + Math.max(BACKOFF_MS, res.retryAfterMs ?? 0));
    if (st.epoch !== epoch || st.stopped) return; // a real request (or a forget) overtook this warm: it owns the schedule now
    if (res.status !== 200 || !u || rewrote) { st.held = null; st.stopped = res.status !== 200 ? `status-${res.status}` : 'rewrote'; return; }
    st.warmsSent++; st.lastTouchAt = this.d.now();
    this.schedule(st, session);
  }
}

function round(n: number): number { return Math.round(n * 100) / 100; }

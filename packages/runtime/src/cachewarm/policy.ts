// Cache keep-warm policy (token savings; docs/overnight-2026-10-14). PURE: no clock, no I/O, no env - the engine
// (warm-engine.ts) and the proxy feed it numbers and send what it decides.
//
// WHY it exists: Kora's chat lane writes every prompt-cache entry with the 1-hour TTL (written at 2x the input price).
// A user who comes back after more than an hour pays that write AGAIN for the whole context (6.3% of the measured bill).
// A "warm" replays the stream's last request with max_tokens 0: the API bills only a cache READ (0.05x on Opus/Sonnet 5.5,
// 0.1x on the others) and the entry's clock restarts. It is a bet: a warm is wasted if the user never returns, so every
// warm must clear   P(return before the next refresh | silent so far) x (rewrite cost) > (warm cost).
//
// Everything here is conservative on purpose: unknown shapes are never warmed (fail closed), and a warm is only sent
// while the bet is positive AND the stream is inside a hard horizon.

import { createHash } from 'node:crypto';

// ── prices ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CacheTtl = '5m' | '1h';
export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/** Price multipliers relative to the model's base input price (= 1). */
export interface PriceRatios { read: number; write: number; output: number }

/** Fable / Mythos 5.1 bill a cache read at 0.025x, Opus / Sonnet 5.5 at 0.05x, every other model at 0.1x; a write is 1.25x
 *  (5m) or 2x (1h) (Anthropic pricing page, checked 2026-10-14). */
export function priceRatios(model: string | null | undefined, ttl: CacheTtl): PriceRatios {
  const m = model ?? '';
  const read = /(fable|mythos)-5[-.]1/i.test(m) ? 0.025 : /(opus|sonnet)-5[-.]5/i.test(m) ? 0.05 : 0.1;
  return { read, write: ttl === '1h' ? 2 : 1.25, output: 5 };
}

/** Cost of one API call in input-token units (what the `warm` / `warm-next` rows report). */
export function costUnits(u: { in?: number; cr?: number; cc?: number; out?: number }, r: PriceRatios): number {
  return (u.in ?? 0) + (u.cr ?? 0) * r.read + (u.cc ?? 0) * r.write + (u.out ?? 0) * r.output;
}

// ── return-time distribution ─────────────────────────────────────────────────────────────────────────────────────

/** One bin: the user's next request on a stream comes (fromMin, toMin] minutes after the previous one, with probability p. */
export interface ReturnBin { fromMin: number; toMin: number; p: number }
/** Mass is spread evenly inside a bin. Whatever the bins do not add up to is "never comes back" (and the far tail). */
export interface ReturnDist { bins: ReturnBin[]; horizonMin: number; minCtxTokens: number }

/**
 * Shipped default: the gaps between main-thread API calls of Kora's chat lane, 14 days of real transcripts, 2,157 gaps
 * (85.9% under 1 min ... only 10 beyond an hour). It is a gap distribution of the whole lane, not of one user: the lead
 * recomputes it from cost.jsonl and drops the result in <KORA_HOME>/cache-warm.json.
 */
export const DEFAULT_RETURN_DIST: ReturnDist = {
  bins: [
    { fromMin: 0, toMin: 1, p: 0.859 },
    { fromMin: 1, toMin: 5, p: 0.11 },
    { fromMin: 5, toMin: 10, p: 0.014 },
    { fromMin: 10, toMin: 30, p: 0.009 },
    { fromMin: 30, toMin: 55, p: 0.003 },
    { fromMin: 55, toMin: 60, p: 0.0005 },
    { fromMin: 60, toMin: 90, p: 0.001 },
    { fromMin: 90, toMin: 120, p: 0.001 },
    { fromMin: 120, toMin: 360, p: 0.0015 },
    { fromMin: 360, toMin: 1440, p: 0.0005 },
  ],
  // No warm is sent later than this after the stream's last real request (the lead's sim: stop by ~2h).
  horizonMin: 120,
  // Under ~4k tokens there is no cache entry worth keeping (and the API will not cache below its minimum anyway).
  minCtxTokens: 4000,
};

/** Parse a user-supplied distribution file's JSON; anything malformed falls back to the default (never throws). */
export function parseReturnDist(raw: unknown, fallback: ReturnDist = DEFAULT_RETURN_DIST): ReturnDist {
  try {
    const o = raw as { bins?: unknown; horizonMin?: unknown; minCtxTokens?: unknown };
    if (!o || typeof o !== 'object' || !Array.isArray(o.bins) || o.bins.length === 0) return fallback;
    const bins: ReturnBin[] = [];
    let prevTo = 0; let sum = 0;
    for (const b of o.bins as Array<Record<string, unknown>>) {
      const fromMin = Number(b?.fromMin); const toMin = Number(b?.toMin); const p = Number(b?.p);
      if (![fromMin, toMin, p].every(Number.isFinite) || fromMin < prevTo - 1e-9 || toMin <= fromMin || p < 0 || p > 1) return fallback;
      bins.push({ fromMin, toMin, p }); prevTo = toMin; sum += p;
    }
    if (sum > 1 + 1e-6) return fallback;
    const horizonMin = Number(o.horizonMin); const minCtx = Number(o.minCtxTokens);
    return {
      bins,
      horizonMin: Number.isFinite(horizonMin) && horizonMin > 0 ? Math.min(horizonMin, 24 * 60) : fallback.horizonMin,
      minCtxTokens: Number.isFinite(minCtx) && minCtx >= 0 ? minCtx : fallback.minCtxTokens,
    };
  } catch { return fallback; }
}

/** Probability mass of a return in (fromMs, toMs]. */
export function massBetween(dist: ReturnDist, fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  let m = 0;
  for (const b of dist.bins) {
    const lo = b.fromMin * 60_000; const hi = b.toMin * 60_000;
    const ov = Math.min(hi, toMs) - Math.max(lo, fromMs);
    if (ov > 0) m += b.p * (ov / (hi - lo));
  }
  return m;
}

/** P(the user returns inside (idleMs, idleMs + windowMs] | no return through idleMs). */
export function conditionalReturn(dist: ReturnDist, idleMs: number, windowMs: number): number {
  const survival = 1 - massBetween(dist, 0, idleMs);
  if (survival <= 1e-9) return 0;
  return Math.min(1, massBetween(dist, idleMs, idleMs + windowMs) / survival);
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A warm is sent this long before the entry would expire (0.9 of the TTL: 54 min of the hour, 4.5 of the 5). */
export const REFRESH_FRACTION = 0.9;
export function refreshIntervalMs(ttl: CacheTtl): number { return Math.floor(TTL_MS[ttl] * REFRESH_FRACTION); }

export interface WarmInput {
  /** Time since the stream's last REAL request (not since its last warm). */
  idleMs: number;
  ttl: CacheTtl;
  /** Prompt size of the stream's last request (input + cache read + cache write). */
  ctxTokens: number;
  ratios: PriceRatios;
  dist: ReturnDist;
}
export interface WarmDecision {
  warm: boolean;
  reason: 'ok' | 'too-small' | 'past-horizon' | 'unlikely-return';
  /** P(return before the next refresh | silent so far) */
  p: number;
  /** what this warm costs / what a rewrite on return would cost beyond a hit, in input-token units */
  warmCost: number;
  rewriteCost: number;
}

/**
 * Warm only when the bet is positive: P(return in the next refresh window | idle so far) x (write - read) x ctx
 * > read x ctx. With the 1h TTL (write 2x) and a 0.05x read that break-even is P > 2.6% (5.3% at a 0.1x read).
 * `idleMs` is when this warm would be SENT. The decision is myopic by design: warm k is judged only against the window
 * it buys; warm k+1 is judged again when its time comes (a decaying hazard therefore stops the chain by itself).
 */
export function shouldWarm(i: WarmInput): WarmDecision {
  const warmCost = i.ctxTokens * i.ratios.read;
  const rewriteCost = i.ctxTokens * Math.max(0, i.ratios.write - i.ratios.read);
  if (i.ctxTokens < i.dist.minCtxTokens) return { warm: false, reason: 'too-small', p: 0, warmCost, rewriteCost };
  if (i.idleMs > i.dist.horizonMin * 60_000) return { warm: false, reason: 'past-horizon', p: 0, warmCost, rewriteCost };
  const p = conditionalReturn(i.dist, i.idleMs, refreshIntervalMs(i.ttl));
  const warm = p * rewriteCost > warmCost;
  return { warm, reason: warm ? 'ok' : 'unlikely-return', p, warmCost, rewriteCost };
}

// ── what a request looks like (fail closed on anything not verified) ─────────────────────────────────────────

export type AnyBody = Record<string, any>;

/** Every `cache_control` object anywhere in the body (system blocks, tools, message content, nested tool_result blocks). */
export function cacheControlTtls(body: unknown): Array<CacheTtl | 'other'> {
  const out: Array<CacheTtl | 'other'> = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 12) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const cc = o.cache_control;
    if (cc && typeof cc === 'object') {
      const t = (cc as Record<string, unknown>).ttl;
      out.push(t === undefined || t === '5m' ? '5m' : t === '1h' ? '1h' : 'other');
    }
    for (const k of Object.keys(o)) if (k !== 'cache_control') walk(o[k], depth + 1);
  };
  walk(body, 0);
  return out;
}

/**
 * Model + request shapes a max_tokens-0 replay is KNOWN to be accepted for (checked live: docs/overnight-2026-10-14).
 * Key = `<family>|<thinking type or ->`. Anything else is not warmed.
 */
export const VERIFIED_SHAPES: ReadonlySet<string> = new Set<string>([
  'haiku|enabled', 'haiku|disabled', 'haiku|-',
  // live 2026-10-14, Claude Code 2.1.283 main requests (thinking {adaptive, display omitted}, context_management present): max_tokens 0 + stream false -> 200, cache read only
  'sonnet|adaptive', 'opus|adaptive',
  // live 2026-10-15: Haiku 5.5 sends thinking {adaptive}; without this entry it was never warmed. max_tokens 0 + stream false -> 200, cr only, cc 0
  'haiku|adaptive',
]);
export function modelFamily(model: string): string | null {
  const m = model.toLowerCase();
  return m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : m.includes('opus') ? 'opus' : null;
}
export function shapeKey(body: AnyBody): string | null {
  const fam = typeof body.model === 'string' ? modelFamily(body.model) : null;
  if (!fam) return null;
  const t = body.thinking && typeof body.thinking === 'object' ? String(body.thinking.type ?? '-') : '-';
  return `${fam}|${t}`;
}

export interface BodyVerdict {
  /** may a replay of this body be sent at all */
  ok: boolean;
  reason?: string;
  ttl?: CacheTtl;
  model?: string;
}
/** Is this body safe to replay with max_tokens 0 + stream false, and what is its single cache TTL? */
export function analyzeBody(b: AnyBody, verified: ReadonlySet<string> = VERIFIED_SHAPES): BodyVerdict {
  if (!b || typeof b !== 'object' || typeof b.model !== 'string' || !Array.isArray(b.messages) || b.messages.length === 0) return { ok: false, reason: 'not-a-messages-body' };
  const model = b.model;
  const ttls = cacheControlTtls(b);
  if (ttls.length === 0) return { ok: false, reason: 'no-cache-marker', model };
  const first = ttls[0];
  if (first === 'other' || ttls.some((t) => t !== first)) return { ok: false, reason: 'mixed-or-unknown-ttl', model };
  const ttl = first as CacheTtl;
  // A forced tool call or a constrained output format cannot be answered with zero output tokens.
  const tc = b.tool_choice && typeof b.tool_choice === 'object' ? String(b.tool_choice.type ?? '') : '';
  if (tc === 'any' || tc === 'tool') return { ok: false, reason: 'forced-tool-choice', ttl, model };
  if (b.output_config?.format !== undefined || b.output_format !== undefined || b.response_format !== undefined) return { ok: false, reason: 'output-format', ttl, model };
  const sk = shapeKey(b);
  if (!sk || !verified.has(sk)) return { ok: false, reason: `unverified-shape:${sk ?? 'unknown-model'}`, ttl, model };
  return { ok: true, ttl, model };
}

/** The body a warm sends: the held one with zero output and no streaming. */
export function warmBody(b: AnyBody): AnyBody { return { ...b, max_tokens: 0, stream: false }; }

// ── streams and sizes ────────────────────────────────────────────────────────────────────────────────────────────

/** ~3.5 characters per token of JSON-ish prompt text. An estimate for sizes only; real usage replaces it once a response arrives. */
export function estTokens(chars: number): number { return Math.ceil(chars / 3.5); }

/**
 * A "stream" is one conversation inside a Claude Code session: the main loop, a subagent, a title or summary side call.
 * They share the session but not the cache prefix, and only the main loop's cache is worth keeping. Identity = the
 * system prompt (minus the per-request billing line) + the FIRST message: constant for the whole life of a conversation,
 * different for every subagent / side call. The model is deliberately not part of it (a model switch is the same stream).
 */
export function streamKeyOf(b: AnyBody): string {
  const h = createHash('sha256');
  const sys = Array.isArray(b.system) ? b.system : typeof b.system === 'string' ? [{ type: 'text', text: b.system }] : [];
  for (const blk of sys) {
    const t = typeof blk?.text === 'string' ? blk.text : JSON.stringify(blk);
    if (t.startsWith('x-anthropic-billing-header')) continue;
    h.update(t); h.update('\u0000');
  }
  h.update('\u0001'); h.update(JSON.stringify(b.messages?.[0] ?? null));
  return h.digest('hex').slice(0, 16);
}

export interface PrefixSizes {
  system: number;
  tools: number;
  /** estimated tokens per tool group: `builtin` or `mcp__<server>` */
  groups: Record<string, number>;
  toolCount: number;
}
/** Sizes only, never content: estimated tokens of the system prompt and of the tool definitions, per group. */
export function prefixSizes(b: AnyBody): PrefixSizes {
  const sysChars = b.system === undefined ? 0 : JSON.stringify(b.system).length;
  const groups: Record<string, number> = {};
  let toolChars = 0; let count = 0;
  for (const t of Array.isArray(b.tools) ? b.tools : []) {
    const chars = JSON.stringify(t).length; toolChars += chars; count++;
    const name = typeof t?.name === 'string' ? t.name : '';
    const g = name.startsWith('mcp__') ? name.split('__').slice(0, 2).join('__') : 'builtin';
    groups[g] = (groups[g] ?? 0) + chars;
  }
  for (const g of Object.keys(groups)) groups[g] = estTokens(groups[g]);
  return { system: estTokens(sysChars), tools: estTokens(toolChars), groups, toolCount: count };
}

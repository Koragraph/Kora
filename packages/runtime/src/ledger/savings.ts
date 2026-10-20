// Money saved: what each Kora lever kept off the bill, priced at API list prices (transcript.ts priceFor). Shown in the
// context popover ("Kora saved you $X") behind the client pref `showKoraSavings`; Settings > Usage carries the note that
// these are API-price estimates, not a bill.
//
// Every agent's calls are priced at that model's own provider's list price (ledger/prices.ts: Claude at Anthropic's,
// GPT at OpenAI's, Gemini at Google's; a model no price list knows books nothing, never a guess). Cost rows come from
// every lane: Claude (the SDK stream), Codex (its rollout), OpenCode and Antigravity (their step events).
//
// The one idea every lever shares: a token admitted to a session at call k is written to the prompt cache once and
// then re-read on every later call until a compaction drops it (re-written instead of read on a cache miss). So keeping
// one token out at call k is worth   write_k + Σ_{j>k, same segment} (miss_j ? write_j : read_j)   — priced per call at
// that call's model and tier, from the session's REAL call stream (cost.jsonl). A segment ends where the context drops by
// 40% or more (a compaction). A token kept out after the last call is worth nothing: the session never paid for it.
//
// Levers (each one floored at 0 per thread; the sources are the daemon's own logs, nothing is sampled). Only wins are
// booked: an event that cost more than it saved adds nothing, so the number never goes down (user decision 2026-10-15,
// reverting audit #3). Each event lands on the day it happened. The levers:
//   reads  bounded Reads: the tokens of the file that never entered context (read-bound `avoided`). A bound whose file
//          was expanded later in the thread earns nothing: the agent paid for the file anyway.
//   trims  bash output compression (bash-trim `saved`), the elided tool outputs of a cold resume (prune `saved`), and the
//          prompt prefix a thread started without: the safe tool subset (SAFE_TOOLS_TOKENS) and Lean context
//          (LEAN_TOKENS), and on a Claude thread Claude Code's own delegation tools Kora runs without
//          (SUBAGENT_TOOLS_TOKENS), paid on every call (written when the call re-wrote its prefix, else read).
//   graph  a prompt the graph answered with declarations (inject.jsonl `injected`, decls > 0) skips one search round
//          trip: an extra API call at the context of that moment, plus a search result (SEARCH_RESULT_TOKENS) carried for
//          the rest of the session. The injection's own tokens ride along in context, so they are subtracted. A quick
//          answer (the composer answered "who calls X" from the graph, no agent turn) skips QUICK_TURN_CALLS calls and
//          their output; one the user sent to the agent anyway earns nothing.
//   cache  keep-warm: a warmed stream whose next real request found the cache alive after a gap past the TTL read the
//          prefix at the read price instead of re-writing it; the warm pings themselves are subtracted.
//   model  Auto model (session/auto-model.ts): a call Auto ran below the Default (the light model, or the middle tier's
//          Sonnet), priced again at the model the thread would have run without Auto (its Default at the pick, `ceiling` on
//          the auto-model row) minus what it cost, minus the middle tier's advisor calls (`advisor` rows); net per thread.
//          Same tokens both ways: the counterfactual Default might have used fewer or more calls, so this is an estimate like
//          the rest. Calls after the thread moved up to the Default earn nothing.
//   swarm  a task a cheap/free worker did instead of the lead: what the lead would have paid to do it in its own thread
//          (Claude's calls at the lead's context, the task's new content written once and then carried for the rest of
//          the lead's session, Claude's output), each scaled from the worker's own numbers by what Claude measured on the
//          same tasks; minus the worker's cost, the lead's own delegation calls (pick, spawn, wait, merge) and the lead
//          carrying the worker's report.
//   Kora's own prompt (its fleet tool schemas, its rule append, the CLAUDE.md block) is paid on every call and is
//   subtracted: the headline is net of it (`overheadUsd`).
//
// Every constant below was measured on 2026-10-14 (docs/research/SAVINGS-ASSUMPTIONS-2026-10-14.md): real transcripts on
// this Mac, and A/B sessions run for the purpose.
//
// Week / all time: events are attributed to the local day they happened on. Logs rotate (cost.jsonl keeps 16 MB), so
// finished days are folded into <KORA_HOME>/savings-days.json and survive rotation.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { CACHE_TTL_MS, costLogPath, type CostLine } from '../util/cost-log';
import { readInjectLog, injectLogPath, type InjectRecord } from '../graph/prompt-inject';
import { isFree, readOutcomes, readWorkerTokens, REF_PRICE, workerTokensFor, type OutcomeRow, type WorkerTokens } from '../server/swarm-usage';
import { readThreadFlags, type ThreadFlags } from '../session/thread-flags';
import { priceFor, requestCostOf, write5mOf } from './transcript';
import { priceCatalogInfo } from './prices';

export const LEVERS = ['model', 'swarm', 'reads', 'trims', 'graph', 'cache'] as const;
export type Lever = (typeof LEVERS)[number];
/** `savedUsd` is net: the levers' sum minus `overheadUsd` (Kora's own prompt), floored at 0. */
export interface SavingsTotals { savedUsd: number; paidUsd: number; overheadUsd: number; byLever: Record<Lever, number> }
export interface SavingsReport {
  session: SavingsTotals | null;
  week: SavingsTotals;
  all: SavingsTotals;
  /** Where the prices came from: the models.dev snapshot's time (null = built-in table only), and the models in the log
   *  that no price list knows (their calls count $0 both ways: never guessed at another model's price). */
  pricing: { catalogAt: number | null; unpriced: string[] };
  /** The first day all-time covers (YYYY-MM-DD), null when nothing has been recorded. */
  since: string | null;
  generatedAt: number;
}

/** Search round trips a graph injection replaces: the A/B (same question, hook on vs off, Sonnet 5.5) saved one call. */
export const GRAPH_ROUND_TRIPS = 1;
/** One search result (Grep / Glob / graph explore), in tokens: the mean of 29,217 results in 30 days of transcripts. */
export const SEARCH_RESULT_TOKENS = 290;
/** Output tokens of a search tool call (the tool_use block and a line of reasoning). */
const SEARCH_CALL_OUTPUT = 80;
/** The schemas a safe-subset thread never carries (7 tools and the Explore/Plan agents): one-call sessions measured the
 *  prompt at 18,958 tokens with them and 17,371 without. */
export const SAFE_TOOLS_TOKENS = 1587;
/** Lean context (no skills listing, no auto-memory): 1,096 tokens in a folder with no memory, 9,435 in one with a 17 kB
 *  MEMORY.md. The floor is credited: the memory share depends on the project. */
export const LEAN_TOKENS = 1096;
/** A quick answer replaces an agent turn: "who calls" turns in the chat lane took 2.2 calls and ~250 output tokens. */
const QUICK_TURN_CALLS = 2.2;
const QUICK_TURN_OUTPUT = 250;
/** Claude on worker tasks (two tasks a free worker had done in 17 and 8 requests, redone by Sonnet 5.5): calls 2 and 4
 *  (0.12x, 0.5x), output 0.09x and 0.54x, new content 1,624 vs 3,960 tokens (0.41x). */
export const CLAUDE_CALLS_RATIO = 0.3;
export const CLAUDE_OUTPUT_RATIO = 0.3;
export const CLAUDE_GROWTH_RATIO = 0.4;
/** The first prompt of a worker (OpenCode's own system prompt and tools): median of 144 worker sessions. */
const WORKER_FIRST_PROMPT = 17_850;
/** Lead API calls that carry fleet tools, per spawned task (276 spawns in 30 days of chat-lane transcripts). */
export const LEAD_CALLS_PER_TASK = 3.34;
const LEAD_CALL_OUTPUT = 150;
/** Claude Code's own delegation tools (Agent, Task, Workflow), which every Kora Claude session runs without (Kora's
 *  fleet replaces them): measured 2026-10-19, CLI 2.1.302, Haiku 5.5, an empty repo, `claude -p` twice each way: the
 *  first call's prompt was 24,967 tokens with them and 21,020 with `--disallowedTools Agent,Task,Workflow`. Credited on
 *  every call of a Claude thread, beside Kora's own prompt (`KORA_PREFIX_TOKENS`, charged as overhead). */
export const SUBAGENT_TOOLS_TOKENS = 3947;
/** What Kora adds to every call of a code thread: its fleet tool schemas (2,767, the prefix rows), its chat rule append
 *  (256) and the CLAUDE.md rulebook block (620). */
export const KORA_PREFIX_TOKENS = 3643;
const SEGMENT_DROP = 0.6;
const DAY_MS = 24 * 60 * 60 * 1000;

const zero = (): SavingsTotals => ({ savedUsd: 0, paidUsd: 0, overheadUsd: 0, byLever: { model: 0, swarm: 0, reads: 0, trims: 0, graph: 0, cache: 0 } });

type Call = Extract<CostLine, { k: 'call' }>;
interface PricedCall { ts: number; ctx: number; write: number; read: number; out: number; paid: number; rewrote: boolean }
interface Ev { ts: number; lever: Lever; usd: number }
interface Paid { ts: number; usd: number }
interface ThreadLedger { events: Ev[]; paid: Paid[]; overhead: Paid[] }

/** Per-token prices ($) of one call, at that call's model, prompt tier and cache TTL (the share of its writes that were
 *  1-hour writes; a call that wrote nothing is taken as the 1-hour TTL Kora's chat lane uses). */
function priceCall(c: Call): PricedCall {
  const p = priceFor(c.model);
  const r = p.long && c.in + c.cc + c.cr > p.long.above ? p.long : p;
  const share1h = c.cc > 0 && c.cc1h !== undefined ? Math.min(1, c.cc1h / c.cc) : 1;
  return {
    ts: c.ts, ctx: c.ctx, write: (share1h * r.cacheWrite + (1 - share1h) * write5mOf(r)) / 1e6, read: r.cacheRead / 1e6, out: r.out / 1e6,
    paid: requestCostOf({ input: c.in, cacheWrite: c.cc, cacheRead: c.cr, output: c.out, ...(c.cc1h !== undefined ? { cacheWrite1h: c.cc1h } : {}) }, c.model),
    rewrote: c.cc > c.cr,
  };
}

/** What one token kept out of context from `ts` on is worth in this session (see the header). */
export class CarryPricer {
  private readonly calls: PricedCall[];
  private readonly value: number[];
  constructor(calls: Call[]) {
    const sorted = [...calls].sort((a, b) => a.ts - b.ts);
    this.calls = sorted.map(priceCall);
    const n = this.calls.length;
    const suffix = new Array<number>(n + 1).fill(0);
    for (let j = n - 1; j >= 0; j--) {
      const own = sorted[j]!.miss ? this.calls[j]!.write : this.calls[j]!.read;
      const sameSeg = j + 1 < n && this.calls[j + 1]!.ctx >= SEGMENT_DROP * this.calls[j]!.ctx;
      suffix[j] = own + (sameSeg ? suffix[j + 1]! : 0);
    }
    this.value = this.calls.map((c, k) => {
      const sameSeg = k + 1 < n && this.calls[k + 1]!.ctx >= SEGMENT_DROP * c.ctx;
      return c.write + (sameSeg ? suffix[k + 1]! : 0);
    });
  }
  /** Index of the first call at or after `ts` (the call that would have carried a token admitted then), or -1. */
  private at(ts: number): number {
    let lo = 0, hi = this.calls.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.calls[mid]!.ts < ts) lo = mid + 1; else hi = mid; }
    return lo < this.calls.length ? lo : -1;
  }
  perToken(ts: number): number { const k = this.at(ts); return k < 0 ? 0 : this.value[k]!; }
  /** One extra API call at the context of `ts`: the whole prompt read from cache, plus a tool call's output. */
  extraCall(ts: number): number {
    const k = this.at(ts); if (k < 0) return 0;
    const c = this.calls[k]!;
    return c.ctx * c.read + SEARCH_CALL_OUTPUT * c.out;
  }
  /** A token in the prompt prefix of every call, call by call (written on a call that re-wrote its prefix, read on the
   *  rest; each lands on the day of its call). */
  perCall(tokens: number): Paid[] { return this.calls.map((c) => ({ ts: c.ts, usd: tokens * (c.rewrote ? c.write : c.read) })); }
  priceAt(ts: number): PricedCall | null { const k = this.at(ts); return k < 0 ? this.calls[this.calls.length - 1] ?? null : this.calls[k]!; }
  get paid(): Paid[] { return this.calls.map((c) => ({ ts: c.ts, usd: c.paid })); }
}

export interface SavingsInputs {
  cost: CostLine[];
  inject: InjectRecord[];
  outcomes: OutcomeRow[];
  workers: WorkerTokens[];
  /** What each thread started with (session/thread-flags.ts); absent = a legacy thread. */
  flags?: (thread: string) => ThreadFlags;
}



/** Every thread's savings events and paid calls. Pure: tests feed it rows. */
export function buildLedgers(input: SavingsInputs): Map<string, ThreadLedger> {
  const byThread = new Map<string, CostLine[]>();
  for (const l of input.cost) { const t = (l as any).thread; if (typeof t !== 'string') continue; const a = byThread.get(t) ?? []; a.push(l); byThread.set(t, a); }
  const injectBy = new Map<string, InjectRecord[]>();
  for (const r of input.inject) if (r.decision === 'injected' && r.decls > 0 && r.sessionId) { const a = injectBy.get(r.sessionId) ?? []; a.push(r); injectBy.set(r.sessionId, a); }
  const outcomesBy = new Map<string, OutcomeRow[]>();
  for (const o of input.outcomes) { const t = o.thread.replace(/^chat:/, ''); const a = outcomesBy.get(t) ?? []; a.push(o); outcomesBy.set(t, a); }

  const out = new Map<string, ThreadLedger>();
  const threads = new Set([...byThread.keys(), ...injectBy.keys(), ...outcomesBy.keys()]);
  for (const thread of threads) {
    const lines = byThread.get(thread) ?? [];
    const calls = lines.filter((l): l is Call => l.k === 'call');
    if (!calls.length) continue; // a hook-lane pane with no priced session: nothing to carry a token through
    const carry = new CarryPricer(calls);
    const events: Ev[] = [];
    const add = (ts: number, lever: Lever, usd: number) => { if (usd > 0 && Number.isFinite(usd)) events.push({ ts, lever, usd }); }; // wins only: see the header
    const paid = carry.paid;

    const expanded = lines.filter((l): l is Extract<CostLine, { k: 'read-expand' }> => l.k === 'read-expand');
    for (const l of lines) {
      if (l.k === 'read-bound') {
        if (expanded.some((e) => e.file === l.file && e.ts >= l.ts)) continue;
        add(l.ts, 'reads', l.avoided * carry.perToken(l.ts));
      } else if (l.k === 'bash-trim' || l.k === 'prune') {
        add(l.ts, 'trims', l.saved * carry.perToken(l.ts));
      } else if (l.k === 'quick') {
        if (lines.some((d) => d.k === 'quick-discard' && d.ts >= l.ts && d.ts - l.ts < 10 * 60_000)) continue;
        const p = carry.priceAt(l.ts); if (!p) continue;
        add(l.ts, 'graph', QUICK_TURN_CALLS * carry.extraCall(l.ts) + QUICK_TURN_OUTPUT * p.out - Math.ceil(l.chars / 4) * carry.perToken(l.ts));
      }
    }
    // The advisor's tokens (Auto's middle tier) are paid on top of their call.
    const advisors = lines.filter((l): l is Extract<CostLine, { k: 'advisor' }> => l.k === 'advisor');
    const advisorUsd = (a: Extract<CostLine, { k: 'advisor' }>) => requestCostOf({ input: a.in, cacheWrite: a.cc, cacheRead: a.cr, output: a.out }, a.model);
    for (const a of advisors) paid.push({ ts: a.ts, usd: advisorUsd(a) });
    // Auto model: every stretch the thread ran below its Default (light, or the middle tier), from each pick to the next,
    // its calls priced again at the Default minus what they cost, minus the advisor calls in it. A move-up's first call
    // re-writes the context the Default would have read from cache: that call is charged as reads at the Default instead
    // (R6 review: without it the lever over-booked 33-44% on replay). Net per thread, booked once at the first pick when it
    // came out ahead (wins only, the user's 2026-10-15 rule above): a thread where Auto cost more books nothing, so the
    // card never shows Auto's losses (R7 N3; KORA-SAVER.md says so).
    const picks = lines.filter((l): l is Extract<CostLine, { k: 'auto-model' }> => l.k === 'auto-model').sort((a, b) => a.ts - b.ts);
    const first = picks.find((l) => l.model !== 'default' && typeof l.ceiling === 'string');
    if (first) {
      let net = 0;
      const usageOf = (c: Call) => ({ input: c.in, cacheWrite: c.cc, cacheRead: c.cr, output: c.out, ...(c.cc1h !== undefined ? { cacheWrite1h: c.cc1h } : {}) });
      // The Default all along: the context the thread had before the move (its last call on the model it left) is read,
      // only the rest is written. A masked restart writes less than that: then all of it counts as reads (conservative).
      const asReads = (c: Call, had: number) => { const tokens = c.cr + c.cc; const read = Math.min(tokens, had); return { input: c.in, cacheWrite: tokens - read, cacheRead: read, output: c.out }; };
      const moveUpFirst = new Map<Call, number>();
      picks.forEach((seg, i) => {
        if (seg.ts <= first.ts || !seg.escalated || i === 0) return;
        const next = picks[i + 1]?.ts ?? Infinity;
        const c = calls.find((x) => x.ts >= seg.ts && x.ts < next && !!x.model);
        if (!c) return;
        const prev = calls.filter((x) => x.ts < seg.ts && !!x.model).pop();
        // Past the cache's hour the Default would have re-written it too (M follow-up 6: a move-up after 773 min idle).
        const had = prev && c.ts - prev.ts < CACHE_TTL_MS - 60_000 ? prev.ctx : 0;
        moveUpFirst.set(c, had);
        // Up to the Default: no stretch below prices this call, so its re-write is charged here.
        if (seg.model === 'default') net += requestCostOf(asReads(c, had), seg.ceiling ?? first.ceiling!) - requestCostOf(usageOf(c), c.model);
      });
      picks.forEach((seg, i) => {
        if (seg.ts < first.ts || seg.model === 'default' || seg.model === 'manual') return; // 'manual': the user left Auto
        const end = picks[i + 1]?.ts ?? Infinity; const ceiling = seg.ceiling ?? first.ceiling!; const id = seg.model.replace(/^claude-/, '');
        for (const c of calls) {
          if (c.ts < seg.ts || c.ts >= end || !c.model || !c.model.includes(id)) continue;
          const had = moveUpFirst.get(c);
          net += requestCostOf(had !== undefined ? asReads(c, had) : usageOf(c), ceiling) - requestCostOf(usageOf(c), c.model);
        }
        for (const a of advisors) if (a.ts >= seg.ts && a.ts < end) net -= advisorUsd(a);
      });
      add(first.ts, 'model', net);
    }
    const flags = input.flags?.(thread) ?? {};
    // only Claude Code runs without its own delegation tools (an Antigravity or OpenCode lane on a Claude model does not)
    const claudeThread = calls.some((c) => !c.h && priceFor(c.model).provider === 'anthropic');
    const prefixTokens = (flags.safeTools ? SAFE_TOOLS_TOKENS : 0) + (flags.lean ? LEAN_TOKENS : 0) + (claudeThread ? SUBAGENT_TOOLS_TOKENS : 0);
    // per call, like Kora's own prefix (overhead): a thread spanning days books each day's share on that day (audit #9)
    if (prefixTokens > 0) for (const p of carry.perCall(prefixTokens)) add(p.ts, 'trims', p.usd);

    // Keep-warm: the cache survived a gap that would have expired it; the prefix was read, not re-written.
    // Net per thread: the saved re-writes minus the warm pings, booked once if it came out ahead.
    let cacheUsd = 0; let firstCacheTs = 0;
    for (const l of lines) {
      if (l.k === 'warm-next' && Number(l.warms) > 0 && l.hit === true && l.wouldExpire === true) {
        const p = carry.priceAt(l.ts); if (!p) continue;
        cacheUsd += Number(l.cr || 0) * (p.write - p.read); firstCacheTs ||= l.ts;
      } else if (l.k === 'warm' && Number(l.status) === 200) {
        const usage = { input: Number(l.in || 0), cacheWrite: Number(l.cc || 0), cacheRead: Number(l.cr || 0), output: Number(l.out || 0) };
        const usd = requestCostOf(usage, typeof l.model === 'string' ? l.model : null);
        cacheUsd -= usd; paid.push({ ts: l.ts, usd });
      }
    }
    if (firstCacheTs) add(firstCacheTs, 'cache', cacheUsd);

    for (const r of injectBy.get(thread) ?? []) {
      const ts = Date.parse(r.ts); if (!Number.isFinite(ts)) continue;
      const per = carry.perToken(ts);
      add(ts, 'graph', GRAPH_ROUND_TRIPS * (carry.extraCall(ts) + SEARCH_RESULT_TOKENS * per) - Math.ceil(r.chars / 4) * per);
    }

    for (const o of outcomesBy.get(thread) ?? []) {
      const lead = carry.priceAt(o.startedAt); if (!lead) continue;
      const workers = workerTokensFor(o, input.workers);
      if (!workers.length) continue; // no measured worker tokens: nothing to price
      let claude = 0; let workerCost = 0;
      const free = o.attempts.length > 0 && o.attempts.every(isFree);
      const carryAfter = carry.perToken(o.ts);
      for (const w of workers) {
        const prompt = w.input + w.cacheRead + w.cacheWrite;
        const growth = w.maxPrompt !== undefined && w.firstPrompt !== undefined ? w.maxPrompt - w.firstPrompt
          : Math.max(0, (2 * prompt) / Math.max(1, w.requests) - WORKER_FIRST_PROMPT);
        const calls = Math.min(Math.max(2, w.requests * CLAUDE_CALLS_RATIO), Math.max(2, w.requests));
        const g = growth * CLAUDE_GROWTH_RATIO;
        // the task's calls read the lead's context plus (on average) half the task's content; the content is written once
        // and carried for the rest of the lead's session; Claude's output
        claude += calls * (lead.ctx + g / 2) * lead.read + g * carryAfter + w.output * CLAUDE_OUTPUT_RATIO * lead.out;
        if (!free && o.usage?.costUsd === undefined) {
          // the worker's own model at its own provider's price; the reference price only when the model is unknown
          const wp = priceFor(o.attempts[o.attempts.length - 1]?.model ?? null);
          // the task's tokens summed over its requests: base rates (a long-context tier applies per request, not to a sum)
          workerCost += wp.source !== 'unpriced' ? ((w.input + w.cacheWrite) * wp.in + w.cacheRead * wp.cacheRead + w.output * wp.out) / 1e6
            : ((w.input + w.cacheWrite) * REF_PRICE.input + w.cacheRead * REF_PRICE.cacheRead + w.output * REF_PRICE.output) / 1e6;
        }
      }
      if (o.usage?.costUsd !== undefined) workerCost = o.usage.costUsd;
      const delegation = LEAD_CALLS_PER_TASK * (lead.ctx * lead.read + LEAD_CALL_OUTPUT * lead.out);
      const report = Math.ceil((o.reportBytes ?? 0) / 4) * carryAfter;
      add(o.ts, 'swarm', claude - workerCost - delegation - report);
      if (workerCost > 0) paid.push({ ts: o.ts, usd: workerCost });
    }
    // a blob / assistant lane never gets Kora's prompt: nothing to subtract (flag written at its session start)
    out.set(thread, { events, paid, overhead: flags.noKoraPrompt ? [] : carry.perCall(KORA_PREFIX_TOKENS) });
  }
  return out;
}

function totalsOf(ledgers: Iterable<ThreadLedger>, keep: (ts: number) => boolean): SavingsTotals {
  const t = zero();
  for (const l of ledgers) {
    for (const e of l.events) if (keep(e.ts)) t.byLever[e.lever] += e.usd;
    for (const p of l.paid) if (keep(p.ts)) t.paidUsd += p.usd;
    for (const p of l.overhead) if (keep(p.ts)) t.overheadUsd += p.usd;
  }
  return settle(t);
}
/** Floor each lever's signed total at 0 (once, for the window), then the net headline. */
function settle(t: SavingsTotals): SavingsTotals {
  for (const k of LEVERS) t.byLever[k] = Math.max(0, t.byLever[k]);
  t.savedUsd = Math.max(0, LEVERS.reduce((a, k) => a + t.byLever[k], 0) - t.overheadUsd);
  return t;
}

const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type DayRow = { paid: number; overhead?: number; byLever: Partial<Record<Lever, number>> };
/** Fold the log window's days into the persisted day table. A day after the log's first day is fully covered: the fresh
 *  row wins. The first day may have lost its start to rotation: the row with more spend (more data) wins. Older days keep
 *  their stored row. */
export function mergeDays(stored: Record<string, DayRow>, ledgers: Iterable<ThreadLedger>, firstLogTs: number | null): Record<string, DayRow> {
  const fresh: Record<string, DayRow> = {};
  for (const l of ledgers) {
    for (const e of l.events) { const d = (fresh[dayOf(e.ts)] ??= { paid: 0, byLever: zero().byLever }); d.byLever[e.lever] = (d.byLever[e.lever] ?? 0) + e.usd; }
    for (const p of l.paid) { const d = (fresh[dayOf(p.ts)] ??= { paid: 0, byLever: zero().byLever }); d.paid += p.usd; }
    for (const p of l.overhead) { const d = (fresh[dayOf(p.ts)] ??= { paid: 0, byLever: zero().byLever }); d.overhead = (d.overhead ?? 0) + p.usd; }
  }
  const firstDay = firstLogTs === null ? null : dayOf(firstLogTs);
  const merged = { ...stored };
  for (const [day, row] of Object.entries(fresh)) {
    const old = merged[day];
    if (!old || firstDay === null || day > firstDay || (day === firstDay && row.paid >= old.paid)) merged[day] = row;
  }
  return merged;
}

function readLines(file: string): CostLine[] {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: CostLine[] = [];
  for (const l of text.split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j && typeof j.ts === 'number') out.push(j); } catch { /* cut line */ } }
  return out;
}
const stamp = (f: string) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } };

let cache: { key: string; at: number; ledgers: Map<string, ThreadLedger>; days: Record<string, DayRow>; unpriced: string[] } | null = null;

/** The popover's numbers. Cached on the log files' size and mtime (and 60 s, for the OpenCode DB). */
export function savingsReport(opts: { threadId?: string | null; home?: string; now?: number } = {}): SavingsReport {
  const home = opts.home ?? koraHome();
  const now = opts.now ?? Date.now();
  const costFile = costLogPath(home);
  const injectFile = opts.home ? path.join(home, 'inject.jsonl') : injectLogPath();
  const outcomesFile = path.join(home, 'swarm', 'outcomes.jsonl');
  const key = [costFile + '.1', costFile, injectFile, outcomesFile].map(stamp).join('|') + `|${home}`;
  if (!cache || cache.key !== key || now - cache.at > 60_000) {
    const cost = [...readLines(costFile + '.1'), ...readLines(costFile)];
    const outcomes = readOutcomes(0, outcomesFile);
    const since = outcomes.length ? Math.min(...outcomes.map((o) => o.startedAt)) - 60 * 60 * 1000 : 0;
    const ledgers = buildLedgers({ cost, inject: readInjectLog(injectFile), outcomes, workers: outcomes.length ? readWorkerTokens(since) : [], flags: (t) => readThreadFlags(t, home) });
    const daysFile = path.join(home, 'savings-days.json');
    let stored: Record<string, DayRow> = {};
    try { const j = JSON.parse(fs.readFileSync(daysFile, 'utf8')); if (j?.v === 1 && j.days) stored = j.days; } catch { /* first run */ }
    const firstLogTs = cost.length ? Math.min(...cost.map((l) => l.ts)) : null;
    const days = mergeDays(stored, ledgers.values(), firstLogTs);
    try { fs.writeFileSync(daysFile, JSON.stringify({ v: 1, days })); } catch { /* best effort */ }
    const models = new Set<string>(); for (const l of cost) if (l.k === 'call' && l.model) models.add(l.model);
    const unpriced = [...models].filter((m) => priceFor(m).source === 'unpriced').sort();
    cache = { key, at: now, ledgers, days, unpriced };
  }
  const { ledgers, days, unpriced } = cache;
  const thread = opts.threadId ? ledgers.get(opts.threadId) : undefined;
  const all = zero();
  for (const row of Object.values(days)) { all.paidUsd += row.paid; all.overheadUsd += row.overhead ?? 0; for (const k of LEVERS) all.byLever[k] += row.byLever[k] ?? 0; }
  settle(all);
  // The week comes from the same day table as all time (the live log forgets days after a rotation, which made "week"
  // read lower than a "all time" that still held the same days): the 7 local days ending today.
  const week = zero(); const weekFrom = dayOf(now - 6 * DAY_MS);
  for (const [day, row] of Object.entries(days)) if (day >= weekFrom) { week.paidUsd += row.paid; week.overheadUsd += row.overhead ?? 0; for (const k of LEVERS) week.byLever[k] += row.byLever[k] ?? 0; }
  settle(week);
  const dayKeys = Object.keys(days).sort();
  return {
    session: opts.threadId ? (thread ? totalsOf([thread], () => true) : zero()) : null,
    week,
    all,
    since: dayKeys[0] ?? null,
    pricing: { catalogAt: priceCatalogInfo(home)?.fetchedAt ?? null, unpriced },
    generatedAt: now,
  };
}

/** Tests: forget the cached computation. */
export function resetSavingsMemoForTests(): void { cache = null; }

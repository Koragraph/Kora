// Cost from API usage, per call, at list prices. Never from Claude Code's own total_cost_usd (it mis-prices some
// models: see the "Claude pricing truth" note), which is kept only as a diagnostic.
//
// Sources, merged per assistant message id by taking the MAX of every field:
//  - the stream-json `assistant` events (one event per content block of a call; the usage grows across them, and the
//    first event of a session has been seen carrying the previous session's cache state), and
//  - the session transcript (~/.claude/projects/<slug>/<session>.jsonl), the record Claude Code bills from.
// Calls that never appear as an assistant message (title / summary side calls) are recovered from the `result`
// event's per-model usage: whatever it counts beyond the calls we saw is priced as `sideCost`.
import fs from 'node:fs';
import { requestCostOf } from '../../ledger/transcript';
import { classifyTool, countTool, emptyTools } from '../metrics';
import type { CallUsage, ToolMix, UsageTotals } from './types';

export class CallBook {
  readonly calls = new Map<string, CallUsage>();
  readonly tools: ToolMix = emptyTools();
  private anon = 0;

  /** Fold one stream-json event. Returns true when it was an assistant message. */
  foldEvent(o: any): boolean {
    if (!o || o.type !== 'assistant' || !o.message) return false;
    this.foldMessage(o.message);
    return true;
  }

  foldMessage(msg: any): void {
    const u = msg.usage;
    if (u && (u.input_tokens != null || u.output_tokens != null)) {
      const id = msg.id ? String(msg.id) : `anon-${this.anon++}`;
      this.merge({
        id,
        model: msg.model ? String(msg.model) : null,
        input: u.input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheWrite1h: u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens != null ? u.cache_creation.ephemeral_1h_input_tokens : undefined,
        cacheRead: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0,
      });
    }
    for (const block of msg.content || []) if (block && block.type === 'tool_use') countTool(this.tools, classifyTool(block.name, block.input));
  }

  /** Merge one call's usage in: per message id, the max of every field. */
  merge(c: CallUsage): void {
    const prev = this.calls.get(c.id);
    if (!prev) { this.calls.set(c.id, { ...c }); return; }
    prev.model = prev.model || c.model;
    prev.input = Math.max(prev.input, c.input);
    prev.cacheWrite = Math.max(prev.cacheWrite, c.cacheWrite);
    prev.cacheRead = Math.max(prev.cacheRead, c.cacheRead);
    prev.output = Math.max(prev.output, c.output);
    if (c.cacheWrite1h !== undefined) prev.cacheWrite1h = Math.max(prev.cacheWrite1h ?? 0, c.cacheWrite1h);
  }

  /** Fold a session transcript file (JSONL). Tool counts are NOT taken from it (the stream already counted them). */
  foldTranscript(file: string): number {
    let n = 0;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o && (o.type === 'assistant' || o.message?.role === 'assistant') ? o.message : null;
      if (!msg || !msg.usage || !msg.id) continue;
      const u = msg.usage;
      this.merge({
        id: String(msg.id),
        model: msg.model ? String(msg.model) : null,
        input: u.input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheWrite1h: u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens != null ? u.cache_creation.ephemeral_1h_input_tokens : undefined,
        cacheRead: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0,
      });
      n++;
    }
    return n;
  }

  list(): CallUsage[] { return [...this.calls.values()]; }
}

export const zeroTotals = (): UsageTotals => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

export function totalsOf(calls: CallUsage[]): UsageTotals {
  return calls.reduce((t, c) => addTotals(t, c), zeroTotals());
}

export function totalsByModel(calls: CallUsage[]): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const c of calls) { const m = c.model || 'unknown'; out[m] = addTotals(out[m] || zeroTotals(), c); }
  return out;
}

/** List-price cost of one call. Cache writes are 1-hour writes (Claude Code's TTL) unless the call says otherwise. */
export function costOfCall(c: CallUsage): number {
  return requestCostOf({ input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output, cacheWrite1h: c.cacheWrite1h }, c.model);
}

export function costOfCalls(calls: CallUsage[]): number {
  return calls.reduce((s, c) => s + costOfCall(c), 0);
}

/** Same cost, but the first call's whole prompt priced as a cache write instead of a cache read (a cold start).
 *  Both arms get the same treatment, so what one run happened to find already in the prompt cache cannot decide a pair. */
export function coldCostOf(calls: CallUsage[]): number {
  if (!calls.length) return 0;
  const first = calls[0];
  const asCold: CallUsage = { ...first, cacheWrite: first.cacheWrite + first.cacheRead, cacheWrite1h: first.cacheWrite1h === undefined ? undefined : first.cacheWrite1h + first.cacheRead, cacheRead: 0 };
  return costOfCalls(calls.slice(1)) + costOfCall(asCold);
}

/** Per-model usage from a `result` event (`modelUsage`), in our units. */
export function modelUsageOf(result: any): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  const mu = result && result.modelUsage;
  if (!mu || typeof mu !== 'object') return out;
  for (const [model, v] of Object.entries<any>(mu)) {
    out[model] = {
      input: v.inputTokens || 0,
      cacheWrite: v.cacheCreationInputTokens || 0,
      cacheRead: v.cacheReadInputTokens || 0,
      output: v.outputTokens || 0,
    };
  }
  return out;
}

/** One turn's own per-model usage. A `--resume`d session's `result.modelUsage` is CUMULATIVE over the whole
 *  conversation (turn 2 reports turns 1+2; found 2026-10-16, it made 61–90% of every multi-turn task's cost phantom),
 *  so a resumed turn is its result minus the previous turn's. A result that is not >= the previous one in every field
 *  is taken as the turn's own. */
export function turnUsageOf(prev: Record<string, UsageTotals> | null, cur: Record<string, UsageTotals>): Record<string, UsageTotals> {
  if (!prev) return cur;
  const fields: (keyof UsageTotals)[] = ['input', 'cacheWrite', 'cacheRead', 'output'];
  const cumulative = Object.entries(prev).every(([m, p]) => cur[m] && fields.every((f) => cur[m][f] >= p[f]));
  if (!cumulative) return cur;
  const out: Record<string, UsageTotals> = {};
  for (const [m, c] of Object.entries(cur)) {
    const p = prev[m] || zeroTotals();
    out[m] = { input: c.input - p.input, cacheWrite: c.cacheWrite - p.cacheWrite, cacheRead: c.cacheRead - p.cacheRead, output: c.output - p.output };
  }
  return out;
}

/** Cost of the tokens a model was billed for beyond the assistant messages we saw (side calls), priced as one request. */
export function sideCostOf(seen: Record<string, UsageTotals>, billed: Record<string, UsageTotals>): number {
  let cost = 0;
  for (const [model, b] of Object.entries(billed)) {
    const s = seen[model] || zeroTotals();
    const extra: UsageTotals = {
      input: Math.max(0, b.input - s.input),
      cacheWrite: Math.max(0, b.cacheWrite - s.cacheWrite),
      cacheRead: Math.max(0, b.cacheRead - s.cacheRead),
      output: Math.max(0, b.output - s.output),
    };
    if (extra.input + extra.cacheWrite + extra.cacheRead + extra.output === 0) continue;
    cost += requestCostOf(extra, model);
  }
  return cost;
}

/** What a run's `result` events say was billed, turn by turn (a run's stream file holds every turn's events in order;
 *  turns after the first resume the previous session): per-model tokens and Claude Code's own reported $. */
export function billedFromStream(streamText: string): { billed: Record<string, UsageTotals>; reported: number } {
  const billed: Record<string, UsageTotals> = {};
  let prev: Record<string, UsageTotals> | null = null; let prevReported = 0; let reported = 0;
  for (const line of streamText.split('\n')) {
    if (!line.includes('"result"')) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || ev.type !== 'result') continue;
    const mu = modelUsageOf(ev); const rep = Number(ev.total_cost_usd) || 0;
    for (const [m, u] of Object.entries(turnUsageOf(prev, mu))) billed[m] = addTotals(billed[m] || zeroTotals(), u);
    reported += prev && rep >= prevReported ? rep - prevReported : rep;
    prev = mu; prevReported = rep;
  }
  return { billed, reported };
}

/** A recorded run's side cost recomputed from its stream file (fixes records written before turnUsageOf). */
export function repriceRecord(rec: { cost: number; coldCost: number; sideCost: number; reportedCost: number; usageByModel: Record<string, UsageTotals> }, streamText: string): { cost: number; coldCost: number; sideCost: number; reportedCost: number } {
  const { billed, reported } = billedFromStream(streamText);
  const sideCost = sideCostOf(rec.usageByModel, billed);
  return { cost: rec.cost - rec.sideCost + sideCost, coldCost: rec.coldCost - rec.sideCost + sideCost, sideCost, reportedCost: reported };
}

/** Re-price a run's tokens at another model's list prices (for projecting a full run from a calibration run). */
export function repriceTotals(byModel: Record<string, UsageTotals>, model: string): number {
  let cost = 0;
  for (const t of Object.values(byModel)) cost += requestCostOf(t, model);
  return cost;
}

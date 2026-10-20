// Bench metrics v2 — the machine-readable scoreboard. One `RunMetrics` per (task × condition × repeat), built from
// the agent's own stream-json (usage and tool calls are authoritative: they are what Claude billed) plus the
// injection telemetry ($KORA_HOME/inject.jsonl, keyed by session id) and a mechanical success verdict.
//
// Attribution rules (the product has already been burned once by getting this wrong):
//   - cacheRead / cacheWrite / input / output are reported SEPARATELY and never summed into a "graph saving".
//   - injectedTokens is a COST line: every injected token is re-billed on each later API call of the session.
//   - savings are counted only where both arms succeeded, and only as cost deltas on the same task.
import fs from 'node:fs';
import path from 'node:path';
import { readInjectLog, InjectRecord } from '../graph/prompt-inject';
export type InjectRecordLite = Pick<InjectRecord, 'ts' | 'decision' | 'reason' | 'decls' | 'chars' | 'sessionId'>;

export const METRICS_SCHEMA = 2;
export interface ToolCalls { grep: number; glob: number; read: number; wholeFileRead: number; rangeRead: number; graph: number; bashSearch: number; edit: number; subagent: number; other: number; total: number }
export interface RunMetrics {
  schema: typeof METRICS_SCHEMA;
  suite: string; task: string; kind: string; regime: string; condition: string; repeat: number;
  model: string; effort: string; sessionId: string | null; startedAt: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
  /** The first API call's cache write / read. A prefix seen within the cache TTL reads ~all of it; a fresh one writes
   *  it at cache-write price — a ~$0.17 swing per session on Sonnet that has nothing to do with the graph. */
  firstCallCacheWrite: number; firstCallCacheRead: number;
  /** cost minus the first call's cache write (priced with the ledger's fitted rates): what the session cost once
   *  its prefix was in cache. Savings are judged on this; raw cost is reported beside it. */
  steadyCost: number;
  /** API calls (assistant messages with usage) — the re-billing multiplier */
  turns: number;
  toolCalls: ToolCalls;
  wallClock: number;
  injectedTokens: number; injectedDecls: number; injections: number;
  graphHits: number; graphMisses: number; missReasons: Record<string, number>;
  /** user turns where declarations were injected AND the agent still searched (grep / bash-grep / graph) */
  fellBackToGrep: number;
  /** precision@1 proxy per injection: answered without reading / read the injected file / read elsewhere */
  precision?: { noRead: number; match: number; other: number };
  success: boolean; successDetail: string[];
  error: string | null;
}
export const emptyTools = (): ToolCalls => ({ grep: 0, glob: 0, read: 0, wholeFileRead: 0, rangeRead: 0, graph: 0, bashSearch: 0, edit: 0, subagent: 0, other: 0, total: 0 });

const BASH_SEARCH_RE = /(^|[\s;|&(])(grep|rg|ag|ack|find|cat|less|more|head|tail|sed\s+-n)\b/;
const GRAPH_CLI_RE = /kora(\.js)?["']?\s+graph\b|koragraph\s+(explore|search|neighbours|blast)/;
/** Classify one tool_use block. */
export function classifyTool(name: string, input: any): keyof ToolCalls {
  if (name === 'Grep') return 'grep';
  if (name === 'Glob') return 'glob';
  if (name === 'Read') return input && (input.offset != null || input.limit != null) ? 'rangeRead' : 'wholeFileRead';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (name === 'Agent' || name === 'Task') return 'subagent';
  if (/^mcp__(kora|koragraph)__/.test(name)) return 'graph';
  if (name === 'Bash') { const c = String(input?.command || ''); if (GRAPH_CLI_RE.test(c)) return 'graph'; if (BASH_SEARCH_RE.test(c)) return 'bashSearch'; }
  return 'other';
}
export function countTool(t: ToolCalls, cls: keyof ToolCalls): void {
  t[cls]++; t.total++;
  if (cls === 'wholeFileRead' || cls === 'rangeRead') t.read++;
}

/** Accumulate usage + tools from one stream-json `assistant` event into a per-turn bucket. */
export interface TurnBucket { input: number; output: number; cacheRead: number; cacheWrite: number; apiCalls: number; tools: ToolCalls; searched: boolean; seen: Set<string>; perCall: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>; firstCallCacheWrite: number; firstCallCacheRead: number }
export const emptyBucket = (): TurnBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0, tools: emptyTools(), searched: false, seen: new Set(), perCall: new Map(), firstCallCacheWrite: -1, firstCallCacheRead: -1 });
export function foldAssistant(b: TurnBucket, msg: any): void {
  const u = msg?.usage || {};
  // stream-json emits one `assistant` event PER CONTENT BLOCK of an API call, each repeating the call's usage —
  // count a message id once (measured: summing every event doubled the token totals against total_cost_usd).
  // …and the usage GROWS across those events (output_tokens is a running count; the last event has the call's total),
  // so per id the MAX of each field is the call's usage, not the first event's.
  const id = msg?.id ? String(msg.id) : null;
  const fresh = !id || !b.seen.has(id);
  if (id) b.seen.add(id);
  if (u && (u.input_tokens != null || u.output_tokens != null)) {
    const cur = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
    const prev = id ? b.perCall.get(id) : undefined;
    if (!prev) { b.apiCalls++; if (id) b.perCall.set(id, cur); b.input += cur.input; b.output += cur.output; b.cacheRead += cur.cacheRead; b.cacheWrite += cur.cacheWrite; }
    else { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (cur[k] > prev[k]) { b[k] += cur[k] - prev[k]; prev[k] = cur[k]; } }
    if (fresh && b.firstCallCacheWrite < 0) { b.firstCallCacheWrite = cur.cacheWrite; b.firstCallCacheRead = cur.cacheRead; }
  }
  for (const blk of msg?.content || []) if (blk.type === 'tool_use') {
    const cls = classifyTool(blk.name, blk.input); countTool(b.tools, cls);
    if (cls === 'grep' || cls === 'bashSearch' || cls === 'graph') b.searched = true;
  }
}
export function addBucket(a: TurnBucket, b: TurnBucket): void {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.apiCalls += b.apiCalls;
  if (a.firstCallCacheWrite < 0) { a.firstCallCacheWrite = b.firstCallCacheWrite; a.firstCallCacheRead = b.firstCallCacheRead; }
  for (const id of b.seen) a.seen.add(id);
  for (const [id, v] of b.perCall) a.perCall.set(id, v);
  for (const k of Object.keys(b.tools) as (keyof ToolCalls)[]) a.tools[k] += b.tools[k];
  a.searched = a.searched || b.searched;
}

/** Token totals from the TRANSCRIPT (~/.claude/projects/…jsonl), the record Claude Code bills from: stream-json's
 *  first assistant event has been seen reporting the previous session's cache state (cw=0/cr=66k while the transcript
 *  said cw=42k/cr=24k for the same call). When a transcript exists it wins; the stream is the fallback. */
export function usageFromTranscript(file: string | null | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number; apiCalls: number; firstCallCacheWrite: number; firstCallCacheRead: number } | null {
  if (!file) return null;
  try {
    const { parseTranscript } = require('../ledger/transcript') as typeof import('../ledger/transcript');
    const s = parseTranscript(file);
    if (!s.steps.length) return null;
    const first = s.steps[0].usage;
    // totals: the transcript's per-step output is the first streamed event's running count (14 tokens for a paragraph)
    // — only the first call's cache split is taken from here; totals come from Claude's own `result` usage.
    return { input: s.totals.input, output: s.totals.output, cacheRead: s.totals.cacheRead, cacheWrite: s.totals.cacheWrite, apiCalls: s.totals.apiCalls, firstCallCacheWrite: first.cacheWrite, firstCallCacheRead: first.cacheRead };
  } catch { return null; }
}
/** Price the first call's cache write with the ledger's fitted rates and subtract it. */
export function steadyCostOf(cost: number, firstCallCacheWrite: number, model: string): number {
  try { const { priceFor } = require('../ledger/transcript'); const p = priceFor(model); return Math.max(0, cost - Math.max(0, firstCallCacheWrite) * p.cacheWrite / 1e6); } catch { return cost; }
}
/** Injection telemetry for one session: rows whose sessionId matches (hook lane: Claude's session id). */
export function injectionsFor(sessionId: string | null, since: number, log?: string): InjectRecord[] {
  if (!sessionId) return [];
  return readInjectLog(log, { since: since - 5000 }).filter((r) => r.sessionId === sessionId);
}
export function foldInjections(rows: InjectRecordLite[]): Pick<RunMetrics, 'injectedTokens' | 'injectedDecls' | 'injections' | 'graphHits' | 'graphMisses' | 'missReasons'> {
  const out = { injectedTokens: 0, injectedDecls: 0, injections: 0, graphHits: 0, graphMisses: 0, missReasons: {} as Record<string, number> };
  for (const r of rows) {
    if (r.decision === 'injected') { out.injections++; out.graphHits++; out.injectedDecls += r.decls; out.injectedTokens += Math.ceil(r.chars / 4); }
    else if (r.decision === 'miss') { out.graphMisses++; out.missReasons[r.reason] = (out.missReasons[r.reason] || 0) + 1; }
  }
  return out;
}

// ---- aggregation across repeats ----
export function median(xs: number[]): number { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
/** spread = (max − min) / median, as a fraction — a "win" inside this band is noise */
export function spread(xs: number[]): number { const s = xs.filter((x) => Number.isFinite(x)); if (s.length < 2) return 0; const m = median(s); return m ? (Math.max(...s) - Math.min(...s)) / m : 0; }
export interface ArmAggregate { n: number; successes: number; cost: { median: number; spread: number; values: number[] }; rawCost: { median: number; spread: number }; firstCallCacheWrite: { median: number; misses: number }; context: { median: number }; turns: { median: number }; injectedTokens: { median: number }; injectedDecls: { median: number }; graphHits: number; graphMisses: number; fellBackToGrep: number; wholeFileRead: { median: number }; grep: { median: number }; wallClock: { median: number } }
export interface TaskAggregate { task: string; kind: string; regime: string; arms: Record<string, ArmAggregate>; /** cost delta baseline→kora on runs where both arms succeeded; null when either arm never succeeded */ savingsPct: number | null; bothSucceeded: boolean; noise: boolean }
export interface Summary { schema: typeof METRICS_SCHEMA; suite: string; repo: { path: string; sha: string }; model: string; effort: string; generatedAt: string; repeats: number; conditions: string[]; runs: RunMetrics[]; tasks: TaskAggregate[]; totals: Record<string, { costMedianSum: number; successRate: number; injectedTokensMedianSum: number }>; overallSavingsPct: number | null }

export function aggregateArm(rs: RunMetrics[]): ArmAggregate {
  const ok = rs.filter((r) => r.success);
  const costs = ok.map((r) => r.steadyCost ?? r.cost);
  const raw = ok.map((r) => r.cost);
  return {
    n: rs.length, successes: ok.length,
    cost: { median: median(costs), spread: spread(costs), values: costs },
    rawCost: { median: median(raw), spread: spread(raw) },
    firstCallCacheWrite: { median: median(rs.map((r) => r.firstCallCacheWrite ?? 0)), misses: rs.filter((r) => (r.firstCallCacheWrite ?? 0) > 1000).length },
    context: { median: median(ok.map((r) => r.input + r.cacheRead + r.cacheWrite)) },
    turns: { median: median(ok.map((r) => r.turns)) },
    injectedTokens: { median: median(rs.map((r) => r.injectedTokens)) },
    injectedDecls: { median: median(rs.map((r) => r.injectedDecls)) },
    graphHits: rs.reduce((a, r) => a + r.graphHits, 0), graphMisses: rs.reduce((a, r) => a + r.graphMisses, 0), fellBackToGrep: rs.reduce((a, r) => a + r.fellBackToGrep, 0),
    wholeFileRead: { median: median(ok.map((r) => r.toolCalls.wholeFileRead)) }, grep: { median: median(ok.map((r) => r.toolCalls.grep + r.toolCalls.bashSearch)) },
    wallClock: { median: median(ok.map((r) => r.wallClock)) },
  };
}
export function summarize(runs: RunMetrics[], meta: { suite: string; repo: { path: string; sha: string }; model: string; effort: string; repeats: number; conditions: string[] }): Summary {
  const byTask = new Map<string, RunMetrics[]>();
  for (const r of runs) { if (!byTask.has(r.task)) byTask.set(r.task, []); byTask.get(r.task)!.push(r); }
  const tasks: TaskAggregate[] = [];
  for (const [task, rs] of byTask) {
    const arms: Record<string, ArmAggregate> = {};
    for (const c of meta.conditions) arms[c] = aggregateArm(rs.filter((r) => r.condition === c));
    const b = arms.baseline, n = arms.kora;
    const both = !!(b && n && b.successes > 0 && n.successes > 0);
    const savingsPct = both && b.cost.median ? Math.round((1 - n.cost.median / b.cost.median) * 1000) / 10 : null;
    const noise = both ? Math.abs(savingsPct || 0) / 100 <= Math.max(b.cost.spread, n.cost.spread) / 2 : false;
    tasks.push({ task, kind: rs[0].kind, regime: rs[0].regime, arms, savingsPct, bothSucceeded: both, noise });
  }
  const totals: Summary['totals'] = {};
  for (const c of meta.conditions) {
    const armRuns = runs.filter((r) => r.condition === c);
    totals[c] = { costMedianSum: tasks.reduce((a, t) => a + (t.arms[c]?.cost.median || 0), 0), successRate: armRuns.length ? armRuns.filter((r) => r.success).length / armRuns.length : 0, injectedTokensMedianSum: tasks.reduce((a, t) => a + (t.arms[c]?.injectedTokens.median || 0), 0) };
  }
  const comparable = tasks.filter((t) => t.bothSucceeded);
  const bSum = comparable.reduce((a, t) => a + t.arms.baseline.cost.median, 0), nSum = comparable.reduce((a, t) => a + t.arms.kora.cost.median, 0);
  return { schema: METRICS_SCHEMA, suite: meta.suite, repo: meta.repo, model: meta.model, effort: meta.effort, generatedAt: new Date().toISOString(), repeats: meta.repeats, conditions: meta.conditions, runs, tasks, totals, overallSavingsPct: comparable.length && bSum ? Math.round((1 - nSum / bSum) * 1000) / 10 : null };
}

// ---- the ratchet ----
export interface GateThresholds { savingsDropPct: number; injectedTokensGrowPct: number; successDropPct: number }
export const DEFAULT_GATE: GateThresholds = { savingsDropPct: 10, injectedTokensGrowPct: 50, successDropPct: 0 };
export interface GateResult { ok: boolean; lines: string[] }
/** Compare a fresh summary with the committed baseline. Fails when savings regress past the threshold, the injected
 *  token budget inflates, or task success drops. Tasks absent from the baseline are reported, not gated. */
export function gate(baseline: Summary, current: Summary, th: GateThresholds = DEFAULT_GATE): GateResult {
  const lines: string[] = []; let ok = true;
  const fail = (s: string) => { ok = false; lines.push(`FAIL ${s}`); };
  const pass = (s: string) => lines.push(`ok   ${s}`);
  if (baseline.repo.sha !== current.repo.sha) lines.push(`note baseline sha ${baseline.repo.sha.slice(0, 7)} ≠ current ${current.repo.sha.slice(0, 7)} — numbers are not strictly comparable`);
  if (baseline.model !== current.model || baseline.effort !== current.effort) lines.push(`note model/effort differ (${baseline.model}/${baseline.effort} vs ${current.model}/${current.effort})`);
  if (baseline.overallSavingsPct != null && current.overallSavingsPct != null) {
    const d = baseline.overallSavingsPct - current.overallSavingsPct;
    (d > th.savingsDropPct ? fail : pass)(`overall savings ${baseline.overallSavingsPct}% → ${current.overallSavingsPct}% (limit −${th.savingsDropPct} pts)`);
  } else lines.push('note overall savings not comparable (an arm never succeeded)');
  for (const c of current.conditions) {
    const b = baseline.totals[c], n = current.totals[c]; if (!b || !n) continue;
    ((b.successRate - n.successRate) * 100 > th.successDropPct ? fail : pass)(`${c} success rate ${Math.round(b.successRate * 100)}% → ${Math.round(n.successRate * 100)}%`);
    if (c !== 'baseline' && b.injectedTokensMedianSum > 0) {
      const grow = (n.injectedTokensMedianSum / b.injectedTokensMedianSum - 1) * 100;
      (grow > th.injectedTokensGrowPct ? fail : pass)(`${c} injected tokens Σmedian ${b.injectedTokensMedianSum} → ${n.injectedTokensMedianSum} (+${Math.round(grow)}%, limit +${th.injectedTokensGrowPct}%)`);
    }
  }
  for (const t of current.tasks) {
    const bt = baseline.tasks.find((x) => x.task === t.task);
    if (!bt) { lines.push(`note ${t.task}: not in baseline`); continue; }
    if (bt.savingsPct != null && t.savingsPct != null && !t.noise && bt.savingsPct - t.savingsPct > th.savingsDropPct) fail(`${t.task}: savings ${bt.savingsPct}% → ${t.savingsPct}%`);
    for (const c of current.conditions) { const ba = bt.arms[c], ca = t.arms[c]; if (ba && ca && ba.successes > 0 && ca.successes === 0) fail(`${t.task}/${c}: succeeded in baseline, 0/${ca.n} now`); }
    const ni = t.arms.kora, bi = bt.arms.kora;
    // A drop to zero injected declarations is a silent kill ONLY when the task did not get cheaper: an injection that
    // named the wrong declaration (measured: detectRepoType for the incremental prompt) counts as 'injected' too, and
    // replacing it with nothing made the task 66% cheaper — that is a fix, not a kill.
    if (ni && bi && bi.injectedDecls.median > 0 && ni.injectedDecls.median === 0 && t.regime !== 'cold') {
      const improved = t.savingsPct != null && bt.savingsPct != null && t.savingsPct >= bt.savingsPct;
      (improved ? lines.push.bind(lines) : fail)(`${improved ? 'note ' : ''}${t.task}: kora injected ${bi.injectedDecls.median} decls in baseline, 0 now${improved ? ' — but savings held (' + bt.savingsPct + '% → ' + t.savingsPct + '%), not a kill' : ' (silent injection kill)'}`);
    }
  }
  return { ok, lines };
}

export function renderSummary(s: Summary): string {
  const L: string[] = [];
  L.push(`# ${s.suite} — ${s.model}/${s.effort}, ${s.repeats}× each, repo ${s.repo.sha.slice(0, 7)}, ${s.generatedAt}`, '');
  L.push('| task | regime | arm | n ok | steady cost med | spread | raw cost med | cache misses | ctx med | api | reads (whole) | greps | graph hit/miss | inj tok | fell back | Δ steady |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const t of s.tasks) for (const c of s.conditions) {
    const a = t.arms[c]; if (!a) continue;
    const d = c === 'kora' && t.savingsPct != null ? `${t.savingsPct}%${t.noise ? ' (noise)' : ''}` : c === 'kora' ? 'n/a' : '';
    L.push(`| ${t.task} | ${t.regime} | ${c} | ${a.successes}/${a.n} | $${a.cost.median.toFixed(3)} | ${Math.round(a.cost.spread * 100)}% | $${a.rawCost.median.toFixed(3)} | ${a.firstCallCacheWrite.misses}/${a.n} | ${fmtK(a.context.median)} | ${a.turns.median} | ${a.wholeFileRead.median} | ${a.grep.median} | ${a.graphHits}/${a.graphMisses} | ${a.injectedTokens.median} | ${a.fellBackToGrep} | ${d} |`);
  }
  L.push('', `**Overall (tasks where both arms succeeded, medians of STEADY cost = cost minus the first call's cache write):** ${s.overallSavingsPct == null ? 'n/a' : s.overallSavingsPct + '%'}`, '', 'steady cost strips the first API call\'s cache write (a prefix seen within the cache TTL reads it instead — a ~$0.17 swing per session that depends on what ran in the previous hour, not on the graph). Raw cost is beside it; "cache misses" counts sessions whose first call wrote >1k tokens.');
  for (const c of s.conditions) L.push(`- ${c}: Σ cost medians $${s.totals[c].costMedianSum.toFixed(3)}, success ${Math.round(s.totals[c].successRate * 100)}%, injected tokens Σ ${s.totals[c].injectedTokensMedianSum}`);
  return L.join('\n');
}
function fmtK(n: number): string { return !Number.isFinite(n) ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }

export function writeJson(file: string, v: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n'); }

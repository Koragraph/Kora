// Per-call cost telemetry (master cost plan §2, Phase 0). One JSON line per API call / bounded Read in
// <KORA_HOME>/cost.jsonl: cheap (about 200 bytes a call), append-only, rotated at 8 MB, never throws. The daemon buffers and
// flushes asynchronously (nothing sync on the event loop); a short-lived hook process appends synchronously.
// Read by Settings > Diagnostics (server/health.ts "Prompt cache") and by scripts/cost-replay.cjs.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export const COST_LOG_MAX_BYTES = 8 * 1024 * 1024;
export function costLogPath(home: string = koraHome()): string { return path.join(home, 'cost.jsonl'); }

export type CostCause = 'start' | 'resume' | 'idle' | 'model-switch' | 'compaction' | 'unknown';
export type CostLine =
  | { k: 'call'; ts: number; thread: string; model: string | null; ctx: number; in: number; cr: number; cc: number; cc1h?: number; out: number; miss: boolean; cause?: CostCause; gapMs?: number; tools?: number; /** the effort the call ran at, when Kora set one */ eff?: string; /** the harness, when not Claude Code (rows before 2026-10-19 are all Claude Code) */ h?: 'codex' | 'opencode' | 'agy' }
  | { k: 'tool'; ts: number; thread: string; tool: string; bytes: number }
  /** Claude's server-side advisor tool inside one call (usage.iterations `advisor_message`): billed at the advisor's rates on top of the call, and not in its top-level usage. */
  | { k: 'advisor'; ts: number; thread: string; model: string; in: number; cr: number; cc: number; out: number }
  | { k: 'read-bound' | 'read-shadow'; ts: number; thread: string; file: string; offset: number; limit: number; total: number; source: string; avoided: number }
  | { k: 'read-expand'; ts: number; thread: string; file: string }
  /** SAV-D: a Read of a file already in this context segment, unchanged since. `read-dedupe` = the agent was told / refused (action), `-shadow` = it would have been. `tokens` = a rough size of the re-read. */
  | { k: 'read-dedupe' | 'read-dedupe-shadow'; ts: number; thread: string; file: string; action: 'nudge' | 'deny' | 'changed'; tokens: number }
  /** B6: a cold resume continued from a copy with old tool outputs elided. */
  /** B16: a Bash result that a compression would have shrunk (shadow) / did shrink (on): chars, lines, error lines kept, tokens saved, compressor. */
  | { k: 'bash-trim-shadow' | 'bash-trim'; ts: number; thread: string; bytes: number; lines: number; errors: number; saved: number; /** compressor name(s) from output-compress.ts */ c?: string }
  | { k: 'prune'; ts: number; thread: string; stubbed: number; saved: number; ctx: number }
  /** B17: the composer answered a question from the graph with no agent turn (`chars` = the note the next turn carries);
   *  `quick-discard` = the user sent it to the agent anyway. */
  | { k: 'quick'; ts: number; thread: string; chars: number }
  | { k: 'quick-discard'; ts: number; thread: string }
  /** Cache keep-warm (cachewarm/, rows come from the proxy child): `warm` = a replay was sent, `warm-shadow` = one that would have been, `warm-next` = the first real request after a gap (did the cache survive?), `prefix` = the size of a session's system prompt and tool groups. Field lists: cachewarm/warm-engine.ts. */
  /** SAV-A: a cold identifier search was denied WITH the graph's answer (`deny-answer`) / would have been (`deny-answer-shadow`): ident, chars, ms, whether the graph had an exact declaration. */
  | { k: 'deny-answer' | 'deny-answer-shadow'; ts: number; thread: string; ident: string; chars: number; ms: number; hit: boolean }
  | { k: 'warm' | 'warm-shadow' | 'warm-next' | 'prefix'; ts: number; thread: string; [field: string]: unknown }
  /** Auto model (session/auto-model.ts): the pick a thread's first prompt made, or its one escalation. */
  | { k: 'auto-effort'; ts: number; thread: string; effort: string; base: string; reason: string }
  | { k: 'auto-model'; ts: number; thread: string; model: string; reason: string; escalated?: boolean; /** the full id the Default ran at the pick (ledger counterfactual) */ ceiling?: string; /** the middle tier's advisor */ advisor?: string };

let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

async function flushNow(home: string): Promise<void> {
  if (flushing || !buffer.length) return;
  flushing = true;
  const chunk = buffer.join(''); buffer = [];
  try {
    const f = costLogPath(home);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    try { const st = await fs.promises.stat(f); if (st.size > COST_LOG_MAX_BYTES) await fs.promises.rename(f, f + '.1'); } catch { /* new file */ }
    await fs.promises.appendFile(f, chunk);
  } catch { /* telemetry is best effort */ }
  flushing = false;
  if (buffer.length) schedule(home);
}
function schedule(home: string): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushNow(home); }, 1500);
  timer.unref?.();
}

/** Queue a line (daemon). Disabled with KORA_COST_LOG=0. */
export function logCost(line: CostLine, home: string = koraHome()): void {
  if (process.env.KORA_COST_LOG === '0') return;
  try { buffer.push(JSON.stringify(line) + '\n'); if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000); schedule(home); } catch { /* never throws */ }
}
/** Write now and wait (tests; shutdown). */
export async function flushCostLog(home: string = koraHome()): Promise<void> { if (timer) { clearTimeout(timer); timer = null; } await flushNow(home); }
/** Append synchronously (a hook process: it exits right after). */
export function logCostSync(line: CostLine, home: string = koraHome()): void {
  if (process.env.KORA_COST_LOG === '0') return;
  try { const f = costLogPath(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(line) + '\n'); } catch { /* best effort */ }
}

export function readCostLog(opts: { home?: string; sinceMs?: number; maxBytes?: number } = {}): CostLine[] {
  const f = costLogPath(opts.home);
  let text = '';
  try {
    const st = fs.statSync(f); const max = opts.maxBytes ?? COST_LOG_MAX_BYTES;
    const fd = fs.openSync(f, 'r');
    try { const len = Math.min(st.size, max); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out: CostLine[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const j = JSON.parse(l) as CostLine; if (j && typeof j.ts === 'number' && (!opts.sinceMs || j.ts >= opts.sinceMs)) out.push(j); } catch { /* a cut first line or junk */ }
  }
  return out;
}

export interface CostSummary {
  calls: number; threads: number;
  /** cache_read / (cache_read + cache_creation + fresh input), 0..1 */
  cacheHit: number | null;
  tokens: { read: number; written: number; fresh: number; out: number };
  misses: number; missCauses: Partial<Record<CostCause, number>>;
  /** tokens the misses re-wrote (cache_creation on a missed call) - the price of the lost cache */
  missWritten: number;
  reads: { bounded: number; shadow: number; expanded: number; avoidedTokens: number; expandRate: number | null };
  /** cold resumes continued from a copy with old tool outputs elided (session/prune.ts) */
  pruned: { resumes: number; tokens: number };
  /** big Bash results (B16): trimmed for real (`done`) or only counted (`shadow`), with the tokens a trim saves */
  bash: { shadow: number; shadowTokens: number; done: number; doneTokens: number };
  /** the largest tool results by total bytes: [tool, count, bytes] */
  topTools: Array<[string, number, number]>;
}
export function summarizeCostLog(lines: CostLine[]): CostSummary {
  const s: CostSummary = { calls: 0, threads: 0, cacheHit: null, tokens: { read: 0, written: 0, fresh: 0, out: 0 }, misses: 0, missCauses: {}, missWritten: 0, reads: { bounded: 0, shadow: 0, expanded: 0, avoidedTokens: 0, expandRate: null }, pruned: { resumes: 0, tokens: 0 }, bash: { shadow: 0, shadowTokens: 0, done: 0, doneTokens: 0 }, topTools: [] };
  const threads = new Set<string>(); const tools = new Map<string, [number, number]>();
  for (const l of lines) {
    if (l.k === 'call') {
      s.calls++; threads.add(l.thread);
      s.tokens.read += l.cr; s.tokens.written += l.cc; s.tokens.fresh += l.in; s.tokens.out += l.out;
      if (l.miss) { s.misses++; s.missWritten += l.cc; const c = l.cause ?? 'unknown'; s.missCauses[c] = (s.missCauses[c] ?? 0) + 1; }
    } else if (l.k === 'tool') { const t = tools.get(l.tool) ?? [0, 0]; t[0]++; t[1] += l.bytes; tools.set(l.tool, t); }
    else if (l.k === 'read-bound') { s.reads.bounded++; s.reads.avoidedTokens += l.avoided; }
    else if (l.k === 'read-shadow') { s.reads.shadow++; s.reads.avoidedTokens += 0; }
    else if (l.k === 'read-expand') s.reads.expanded++;
    else if (l.k === 'prune') { s.pruned.resumes++; s.pruned.tokens += l.saved; }
    else if (l.k === 'bash-trim-shadow') { s.bash.shadow++; s.bash.shadowTokens += l.saved; }
    else if (l.k === 'bash-trim') { s.bash.done++; s.bash.doneTokens += l.saved; }
  }
  s.threads = threads.size;
  const denom = s.tokens.read + s.tokens.written + s.tokens.fresh;
  s.cacheHit = denom > 0 ? s.tokens.read / denom : null;
  s.reads.expandRate = s.reads.bounded > 0 ? s.reads.expanded / s.reads.bounded : null;
  s.topTools = [...tools.entries()].map(([k, v]): [string, number, number] => [k, v[0], v[1]]).sort((a, b) => b[2] - a[2]).slice(0, 5);
  return s;
}

// ── per-session call classification ───────────────────────────────────────────

export type CallLine = Extract<CostLine, { k: 'call' }>;
export interface AdvisorUsage { model: string; in: number; cr: number; cc: number; out: number }
/** The advisor share of one call's usage (the iterations of type `advisor_message`, summed); null when none ran. */
export function advisorUsageOf(u: any): AdvisorUsage | null {
  const its = Array.isArray(u?.iterations) ? u.iterations.filter((i: any) => i?.type === 'advisor_message') : [];
  if (!its.length) return null;
  const n = (k: string) => its.reduce((a: number, i: any) => a + (Number(i[k]) || 0), 0);
  return { model: String(its.find((i: any) => typeof i.model === 'string')?.model ?? 'unknown'), in: n('input_tokens'), cr: n('cache_read_input_tokens'), cc: n('cache_creation_input_tokens'), out: n('output_tokens') };
}
export interface CallUsage { model: string | null; in: number; cr: number; cc: number; cc1h?: number; out: number }
/** Claude's prompt cache entries live an hour here (Kora's chat lane writes every entry with the 1-hour TTL). */
export const CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * Turns the stream of API calls of ONE session into cost lines with a cache-miss verdict. A call is a miss when it read
 * less than half of what the previous call put in the prompt: the cache did not hold, and the context was re-written
 * (at 2x). The cause is what Kora can name: a compaction or model switch it was told about, an idle gap past the TTL,
 * else unknown. The first call of a session is never a miss (nothing to compare), but says whether it was a cold start.
 */
export class CallTracker {
  private prev: { prompt: number; out: number; model: string | null; at: number } | null = null;
  private pending: CostCause | null = null;
  constructor(private resumed = false) {}
  /** Something happened that explains the next call's cache behaviour (a model switch, a compaction). */
  note(cause: CostCause): void { this.pending = cause; }
  record(u: CallUsage, now: number, thread: string, toolResults?: number): CallLine {
    const prompt = u.in + u.cr + u.cc;
    let miss = false; let cause: CostCause | undefined; let gapMs: number | undefined;
    if (!this.prev) {
      if (u.cc > u.cr) cause = this.resumed ? 'resume' : 'start';
    } else {
      gapMs = now - this.prev.at;
      const expected = this.prev.prompt + this.prev.out;
      miss = expected > 0 && u.cr < 0.5 * expected;
      if (miss) cause = this.pending ?? (u.model !== this.prev.model ? 'model-switch' : gapMs >= CACHE_TTL_MS - 60_000 ? 'idle' : 'unknown');
    }
    this.pending = null;
    this.prev = { prompt, out: u.out, model: u.model, at: now };
    return {
      k: 'call', ts: now, thread, model: u.model, ctx: prompt + u.out, in: u.in, cr: u.cr, cc: u.cc, ...(u.cc1h ? { cc1h: u.cc1h } : {}), out: u.out, miss,
      ...(cause ? { cause } : {}), ...(gapMs !== undefined ? { gapMs } : {}), ...(toolResults ? { tools: toolResults } : {}),
    };
  }
}

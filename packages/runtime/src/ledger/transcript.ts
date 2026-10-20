// Token ledger — reads Claude Code's own transcript (JSONL) so the numbers are REAL usage, not estimates.
//
// Each assistant line carries `message.usage` for one API call: input_tokens (fresh, uncached),
// cache_creation_input_tokens (written to cache, ~1.25x input price), cache_read_input_tokens (served from
// cache, ~0.1x input price) and output_tokens. The context the model actually saw on that call is the sum of
// the three input kinds. Every token admitted at call i is re-sent on every call after it, which is why one
// avoided file read is worth far more than the file's size — that multiplier is the whole thesis.
//
// What the ledger DOES NOT do: guess. The spend side is copied from the transcript. The savings side is a
// counterfactual and is labelled as one everywhere it is shown: a graph call that pointed at files the agent
// then never read is credited those files' size, minus the graph result's own size (it sits in context too),
// times the calls remaining in the session. Conservative caps keep it honest — see creditFor().

import { priceFor } from './prices';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ToolClass = 'read' | 'grep' | 'glob' | 'bash' | 'graph' | 'edit' | 'task' | 'other';
export type GraphVia = 'mcp' | 'cli' | null;

export interface Usage { input: number; cacheWrite: number; cacheRead: number; output: number }
export interface ToolCall {
  id: string; name: string; cls: ToolClass; via: GraphVia; graphTool: string | null;
  input: any; resultTokens: number; resultText: string; filesTouched: string[]; // Read: the file; graph: files referenced
  isError: boolean; stepIndex: number; ts: number;
}
export interface Step { index: number; ts: number; usage: Usage; context: number; model: string | null; tools: ToolCall[]; userPrompt: boolean }
export interface Session {
  path: string; sessionId: string | null; cwd: string | null; model: string | null; steps: Step[];
  totals: Usage & { context: number; contextTurns: number; apiCalls: number; userPrompts: number };
  toolCounts: Record<ToolClass, number>; graphCalls: { via: GraphVia; tool: string | null; resultTokens: number; step: number }[];
  injections: { step: number; text: string; resultTokens: number }[]; // UserPromptSubmit graph injections (hook_additional_context)
  savings: Savings; costUsd: number; costModel: string;
}
// Only MEASURED cache economics, straight from the API usage fields. The old "tokens/$ avoided" figure was a
// counterfactual guess (files the graph named that were never read, priced as if they would have been) — removed
// for good 2026-09-24: a savings number has to come from an A/B (`kora bench`), never from an estimate.
export interface Savings {
  cacheSavedUsd: number;        // what prompt caching itself saved vs paying fresh input price for every token
  cacheHitRate: number;         // cacheRead / (input + cacheWrite + cacheRead)
}

// Prices: ledger/prices.ts (every provider; the user's prices.json, a daily models.dev snapshot, a built-in table).
export { priceFor } from './prices';
export function costOf(u: Usage, model: string | null): number {
  const p = priceFor(model);
  return (u.input * p.in + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.out) / 1e6;
}
/** The 5-minute cache write price ($/M): the provider's own (Anthropic 1.25x input), else 1.25x input. */
export const write5mOf = (r: { in: number; write5m?: number }) => r.write5m ?? r.in * 1.25;
/**
 * The cost of ONE API request: a long prompt (past the model's tier threshold) is billed at the long-prompt rates. Cache
 * writes are 1-hour writes unless `cacheWrite1h` says how many were (the rest are 5-minute writes, 1.25x input).
 */
export function requestCostOf(u: Usage & { cacheWrite1h?: number }, model: string | null): number {
  const p = priceFor(model);
  const r = p.long && u.input + u.cacheWrite + u.cacheRead > p.long.above ? p.long : p;
  const w1h = u.cacheWrite1h === undefined ? u.cacheWrite : Math.min(u.cacheWrite, u.cacheWrite1h);
  return (u.input * r.in + w1h * r.cacheWrite + (u.cacheWrite - w1h) * write5mOf(r) + u.cacheRead * r.cacheRead + u.output * r.out) / 1e6;
}

export const approxTokens = (s: string | null | undefined) => (s ? Math.ceil(s.length / 4) : 0);

function classify(name: string, input: any): { cls: ToolClass; via: GraphVia; graphTool: string | null } {
  if (/^mcp__(kora|koragraph|koraplex)__/.test(name)) return { cls: 'graph', via: 'mcp', graphTool: name.replace(/^mcp__[^_]+__/, '') };
  if (name === 'Read' || name === 'NotebookRead') return { cls: 'read', via: null, graphTool: null };
  if (name === 'Grep') return { cls: 'grep', via: null, graphTool: null };
  if (name === 'Glob') return { cls: 'glob', via: null, graphTool: null };
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return { cls: 'edit', via: null, graphTool: null };
  if (name === 'Task' || name === 'Agent') return { cls: 'task', via: null, graphTool: null };
  if (name === 'Bash') {
    const cmd = String(input?.command || '');
    const m = /(?:^|[\s;&|])(?:kora|koraplex|koragraph)\s+graph\s+([a-z_]+)/.exec(cmd) || /(?:^|[\s;&|])koragraph\s+(explore|search_code|neighbours|blast_radius|recall|file_symbols|overview|changes_with)\b/.exec(cmd);
    if (m) return { cls: 'graph', via: 'cli', graphTool: m[1] };
    if (/(^|[\s;&|])(grep|rg|ag|ack)\s/.test(cmd)) return { cls: 'grep', via: null, graphTool: null };
    if (/(^|[\s;&|])(find|fd|ls)\s/.test(cmd)) return { cls: 'glob', via: null, graphTool: null };
    if (/(^|[\s;&|])(cat|head|tail|sed -n|less)\s/.test(cmd)) return { cls: 'read', via: null, graphTool: null };
    return { cls: 'bash', via: null, graphTool: null };
  }
  return { cls: 'other', via: null, graphTool: null };
}

function resultTextOf(block: any, toolUseResult: any): string {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) return block.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  if (typeof toolUseResult === 'string') return toolUseResult;
  return '';
}

// Files a graph result points at. Koragraph renders `name @ path:line`, `path:line`, `--- source path:a-b ---`,
// `@ path:L12`. Accept anything path-shaped with a source-file extension.
export const PATH_RE = /(?:^|[\s(@←→:,])((?:[\w.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sql|sh|vue|md|json|yaml|yml|toml))(?::L?\d+)?/g;
// The same shape with the :line REQUIRED — a citation (`src/x.ts:42`), as opposed to a bare path mention.
export const CITATION_RE = new RegExp(PATH_RE.source.replace(/\(\?::L\?\\d\+\)\?$/, ':L?\\d+'), 'g');
export function filesReferenced(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) out.add(m[1]);
  return [...out];
}
// The files a result is ABOUT — what a grepping agent would actually have opened — as opposed to every file it
// mentions in a callers/callees list. explore: the ■ hits and their source blocks; blast_radius: the changed
// file(s) and the nearest dependent; neighbours/search_code/file_symbols: the subject's own file. Calibrated
// against a measured A/B: crediting every mention over-estimated 4–7x; crediting focus files lands near it.
export function focusFiles(text: string): string[] {
  const out: string[] = []; const seen = new Set<string>();
  const add = (f?: string) => { if (f && !seen.has(f)) { seen.add(f); out.push(f); } };
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*■\s+\S+\s+\S+\s+@\s+(\S+?):\d+/.exec(line))) add(m[1]);
    else if ((m = /^\s*--- source (\S+):\d+-\d+ ---/.exec(line))) add(m[1]);
    else if ((m = /^Changed:\s+(\S+)/.exec(line))) add(m[1]);
    else if ((m = /Nearest non-test dependent: \S+ @ (\S+?):L?\d+/.exec(line))) add(m[1]);
    else if ((m = /^\s*(?:METHOD|FUNCTION|CLASS|VARIABLE|CONST|TYPE|INTERFACE)\s+\S+\s+@\s+(\S+?):\d+/.exec(line))) add(m[1]);
  }
  return out;
}
export function parseTranscript(file: string): Session {
  // A subagent's transcript is entirely sidechain; the main transcript may carry sidechain echoes that are
  // ALSO in the subagent file. Keep sidechain lines only when parsing a subagent file.
  const isSubagentFile = /[\/]subagents[\/]/.test(file);
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const steps: Step[] = [];
  const pendingTool = new Map<string, ToolCall>();
  let cwd: string | null = null, sessionId: string | null = null, model: string | null = null;
  let userPrompts = 0; let firstPrompt: string | null = null; let cacheOneHour = false;
  const injections: Session['injections'] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain && !isSubagentFile) continue;
    // UserPromptSubmit graph injection: Claude stores the hook's additionalContext as a hook_additional_context
    // attachment (NOT inside the user text). It enters context at the NEXT assistant step and is re-billed after,
    // exactly like a graph result — so the ledger credits the reads it saved.
    if (o.type === 'attachment' && o.attachment?.type === 'hook_additional_context') {
      const c = o.attachment.content;
      const text = Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : x?.text || '')).join('\n') : String(c || '');
      if (/already resolved|■/.test(text)) injections.push({ step: steps.length, text, resultTokens: approxTokens(text) });
      continue;
    }
    cwd = cwd || o.cwd || null; sessionId = sessionId || o.sessionId || null;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (o.type === 'assistant' && o.message) {
      const u = o.message.usage || {};
      model = o.message.model || model;
      if (u.cache_creation && Number(u.cache_creation.ephemeral_1h_input_tokens) > 0) cacheOneHour = true;
      const usage: Usage = { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
      // One API call can be split across several assistant lines (thinking / text / tool_use blocks share a
      // requestId and repeat the same usage). Merge on requestId so usage is counted once.
      let step = steps.length ? steps[steps.length - 1] : null;
      if (!step || step.model !== null && (o.requestId && (step as any).requestId !== o.requestId)) {
        step = { index: steps.length, ts, usage, context: usage.input + usage.cacheWrite + usage.cacheRead, model: o.message.model || model, tools: [], userPrompt: false };
        (step as any).requestId = o.requestId || null;
        steps.push(step);
      }
      for (const c of o.message.content || []) {
        if (c.type === 'tool_use') {
          const k = classify(c.name, c.input);
          const tc: ToolCall = { id: c.id, name: c.name, cls: k.cls, via: k.via, graphTool: k.graphTool, input: c.input, resultTokens: 0, resultText: '', filesTouched: [], isError: false, stepIndex: step.index, ts };
          if (k.cls === 'read' && c.input?.file_path) tc.filesTouched = [String(c.input.file_path)];
          step.tools.push(tc); pendingTool.set(c.id, tc);
        }
      }
    } else if (o.type === 'user' && o.message) {
      const content = o.message.content;
      if (typeof content === 'string' || (Array.isArray(content) && !content.some((c: any) => c?.type === 'tool_result'))) {
        userPrompts++;
        if (firstPrompt === null) { const t = typeof content === 'string' ? content : content.map((c: any) => c?.text || '').join(' '); const clean = t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim(); if (clean) firstPrompt = clean.slice(0, 80); }
        if (steps.length) steps[steps.length - 1].userPrompt = true;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const tc = pendingTool.get(c.tool_use_id); if (!tc) continue;
        pendingTool.delete(c.tool_use_id);
        const text = resultTextOf(c, o.toolUseResult);
        tc.resultText = text; tc.resultTokens = approxTokens(text); tc.isError = Boolean(c.is_error);
        if (tc.cls === 'read' && o.toolUseResult?.file?.filePath) tc.filesTouched = [String(o.toolUseResult.file.filePath)];
        if (tc.cls === 'graph') { const f = focusFiles(text); tc.filesTouched = f.length ? f : filesReferenced(text).slice(0, 1); }
      }
    }
  }
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, context: 0, contextTurns: 0, apiCalls: steps.length, userPrompts };
  const toolCounts: Record<ToolClass, number> = { read: 0, grep: 0, glob: 0, bash: 0, graph: 0, edit: 0, task: 0, other: 0 };
  const graphCalls: Session['graphCalls'] = [];
  for (const s of steps) {
    totals.input += s.usage.input; totals.cacheWrite += s.usage.cacheWrite; totals.cacheRead += s.usage.cacheRead; totals.output += s.usage.output;
    totals.context += s.context;
    for (const t of s.tools) { toolCounts[t.cls]++; if (t.cls === 'graph') graphCalls.push({ via: t.via, tool: t.graphTool, resultTokens: t.resultTokens, step: s.index }); }
  }
  totals.contextTurns = totals.context;
  const session: Session = { path: file, sessionId, cwd, model, steps, totals, toolCounts, graphCalls, injections, savings: null as any, costUsd: steps.reduce((sum, st) => sum + requestCostOf(st.usage, st.model || model), 0), costModel: priceFor(model).key };
  (session as any).firstPrompt = firstPrompt; (session as any).cacheOneHour = cacheOneHour;
  session.savings = computeSavings(session);
  return session;
}

export function computeSavings(s: Session): Savings {
  const p = priceFor(s.model);
  const denom = s.totals.input + s.totals.cacheWrite + s.totals.cacheRead;
  const cacheHitRate = denom ? s.totals.cacheRead / denom : 0;
  const cacheSavedUsd = (s.totals.cacheRead * (p.in - p.cacheRead)) / 1e6;
  return { cacheSavedUsd, cacheHitRate };
}

// The compact shape carried on PaneInfo and the sidebar.
export interface LedgerSummary {
  transcript: string; sessionId: string | null; model: string | null; apiCalls: number; userPrompts: number;
  context: number; input: number; cacheWrite: number; cacheRead: number; output: number; costUsd: number;
  reads: number; greps: number; globs: number; graphCalls: number; graphMcp: number; graphCli: number;
  cacheSavedUsd: number; cacheHitRate: number;
  updatedAt: number;
  // ---- live context economics (the re-billing multiplier, made visible) ----
  lastContext: number;        // input tokens the model saw on the most recent API call
  lastCallAt: number;         // epoch ms of the most recent API call (cache warmth countdown starts here)
  contextWindow: number;      // model's window (Sonnet 5: 1,000,000) for the meter
  costPerTurnUsd: number;     // ≈ lastContext × cacheRead + avg output × out — what the NEXT turn costs before it does anything
  avgOutput: number;          // average output tokens per API call
  cacheTtlMs: number;         // 1h when the transcript shows ephemeral_1h writes, else 5m
  firstPrompt: string | null; // first user prompt, trimmed — the pane's natural name
  compactions: number;        // times context dropped by >50% between consecutive calls (a /compact or /clear)
}
const CONTEXT_WINDOW: Record<string, number> = { 'sonnet-5': 1_000_000, 'opus-5': 1_000_000, 'fable': 1_000_000, 'haiku-5': 1_000_000, 'haiku': 200_000 };
function windowFor(model: string | null): number { const m = (model || '').toLowerCase(); for (const [k, v] of Object.entries(CONTEXT_WINDOW)) if (m.includes(k)) return v; return 200_000; }
export function summarize(s: Session): LedgerSummary {
  const last = s.steps[s.steps.length - 1] || null;
  const p = priceFor(s.model);
  const avgOutput = s.steps.length ? Math.round(s.totals.output / s.steps.length) : 0;
  let compactions = 0; for (let i = 1; i < s.steps.length; i++) if (s.steps[i - 1].context > 20_000 && s.steps[i].context < s.steps[i - 1].context * 0.5) compactions++;
  const oneHour = (s as any).cacheOneHour === true;
  return {
    lastContext: last ? last.context : 0, lastCallAt: last ? last.ts : 0, contextWindow: windowFor(s.model),
    costPerTurnUsd: last ? (last.context * p.cacheRead + avgOutput * p.out) / 1e6 : 0, avgOutput,
    cacheTtlMs: oneHour ? 60 * 60 * 1000 : 5 * 60 * 1000, firstPrompt: (s as any).firstPrompt ?? null, compactions,
    transcript: s.path, sessionId: s.sessionId, model: s.model, apiCalls: s.totals.apiCalls, userPrompts: s.totals.userPrompts,
    context: s.totals.context, input: s.totals.input, cacheWrite: s.totals.cacheWrite, cacheRead: s.totals.cacheRead, output: s.totals.output, costUsd: s.costUsd,
    reads: s.toolCounts.read, greps: s.toolCounts.grep, globs: s.toolCounts.glob, graphCalls: s.toolCounts.graph,
    graphMcp: s.graphCalls.filter((g) => g.via === 'mcp').length, graphCli: s.graphCalls.filter((g) => g.via === 'cli').length,
    cacheSavedUsd: s.savings.cacheSavedUsd, cacheHitRate: s.savings.cacheHitRate, updatedAt: Date.now(),
  };
}

export function fmtTokens(n: number): string {
  const a = Math.abs(n); const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}${a}`;
}
export function fmtUsd(n: number): string { return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(Math.abs(n) < 1 ? 3 : 2); }

/** Main transcript plus every subagent transcript under <dir>/<sessionId>/subagents/. Cost and context add up. */
export function parseSessionTree(file: string): { main: Session; subagents: Session[]; context: number; costUsd: number; toolCounts: Record<ToolClass, number> } {
  const main = parseTranscript(file);
  const subagents: Session[] = [];
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { try { subagents.push(parseTranscript(path.join(dir, f))); } catch { /* skip */ } } } catch { /* none */ }
  const toolCounts: Record<ToolClass, number> = { ...main.toolCounts };
  let context = main.totals.context, costUsd = main.costUsd;
  for (const sub of subagents) { context += sub.totals.context; costUsd += sub.costUsd; for (const k of Object.keys(sub.toolCounts) as ToolClass[]) toolCounts[k] += sub.toolCounts[k]; }
  return { main, subagents, context, costUsd, toolCounts };
}

// ── what the agent actually SAID ───────────────────────────────────────────────────────────────
// The ledger above reads a transcript for tokens; this reads it for prose. A coding-agent TUI runs on
// the alternate screen, so a pane's "scrollback" is only ever the visible rows — a worker's report
// scrolls away the moment it is printed and `pane.read` can never get it back. The transcript is the
// durable copy: it holds every assistant turn in full, including the one the screen has already lost.

/** One assistant turn's prose (tool calls and thinking excluded). */
export interface AssistantTurn { ts: number; text: string }

/**
 * Assistant turns from a Claude Code transcript, oldest → newest. `limit` keeps the LAST n (a report
 * is the tail of the conversation). Sidechain lines (subagent echoes) are skipped: a worker's own
 * voice is what the orchestrator asked for.
 */
export function assistantTurns(file: string, limit = 0): AssistantTurn[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const turns: AssistantTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type !== 'assistant' || !o.message) continue;
    const content = o.message.content;
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
    if (!text) continue; // a tool_use-only step says nothing
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    // One API call can span several assistant lines; fold consecutive blocks of the same turn together.
    const prev = turns[turns.length - 1];
    if (prev && ts && prev.ts === ts) prev.text += '\n' + text;
    else turns.push({ ts, text });
  }
  return limit > 0 ? turns.slice(-limit) : turns;
}

/**
 * Locate a session's transcript under ~/.claude/projects (the per-cwd slug dirs are opaque) — and under each extra
 * Claude config dir: a worker on a named account runs with CLAUDE_CONFIG_DIR, so its transcript is in
 * `<CLAUDE_CONFIG_DIR>/projects`, never in ~/.claude (kora_read said "no transcript yet" for those).
 */
export function findTranscript(sessionId: string, home = os.homedir(), configDirs: string[] = []): string | null {
  for (const root of claudeConfigRoots(home, configDirs)) {
    const projects = path.join(root, 'projects');
    let dirs: string[];
    try { dirs = fs.readdirSync(projects); } catch { continue; }
    for (const d of dirs) {
      const f = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}
function claudeConfigRoots(home: string, configDirs: string[]): string[] {
  return [...new Set([...configDirs.filter(Boolean), path.join(home, '.claude')])];
}

/** Claude Code's project folder name for a cwd: every non-alphanumeric char becomes '-'. */
export function claudeProjectSlug(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }

/**
 * A Claude pane's transcript when its SessionStart hook never reported one (hook timed out, the socket was busy, the
 * pane was restored with only a session id): the one `.jsonl` in its cwd's project folder written since the pane
 * started that no other pane owns. Ambiguous (two candidates — e.g. two workers in one shared checkout) → null:
 * reading another worker's answer would be worse than none.
 */
export function guessClaudeTranscript(o: { cwds: (string | null | undefined)[]; home?: string; configDirs?: string[]; since: number; claimed?: Set<string>; slackMs?: number }): string | null {
  const dirs = new Set<string>();
  for (const root of claudeConfigRoots(o.home ?? os.homedir(), o.configDirs ?? [])) {
    for (const cwd of o.cwds) {
      if (!cwd) continue;
      dirs.add(path.join(root, 'projects', claudeProjectSlug(cwd)));
      try { const real = fs.realpathSync(cwd); if (real !== cwd) dirs.add(path.join(root, 'projects', claudeProjectSlug(real))); } catch { /* gone */ }
    }
  }
  const found = new Set<string>();
  const since = o.since - (o.slackMs ?? 5000);
  for (const d of dirs) {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(d, n);
      if (o.claimed?.has(f)) continue;
      try { if (fs.statSync(f).mtimeMs >= since) found.add(f); } catch { /* raced away */ }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

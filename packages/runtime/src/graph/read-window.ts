// Bounded Read (docs/research/MASTER-COST-PLAN.md §4.1, the biggest cost lever).
//
// A whole-file Read of a long source file is written into the prompt cache at 2x the moment it happens and re-read on
// every later call. Most of the time the agent wanted one declaration. This module decides, BEFORE the Read runs,
// whether to hand it a window instead: the PreToolUse hook adds `offset` / `limit` to the tool input (`updatedInput`,
// verified live on SDK 0.3.286: the model gets only the window, and Edit still works afterwards) and attaches the
// file's outline so the model knows what else is there and can Read another range in one call.
//
// Everything here is PURE or takes its I/O as a parameter (`ReadIO`), so the same decision runs in the daemon's
// in-process SDK hook (chat lane) and in the per-call `kora hook pre-tool` process (panes), and is unit-tested on
// fixtures. Fail-open is the contract: the second Read of a path always passes through whole, and any error, timeout
// or doubt returns "no change". A wrong skip costs nothing; a wrong rewrite costs a round trip.
import path from 'node:path';

/** Source files worth bounding (the same set the big-read nudge in cli/commands/hook.ts has always used). */
export const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sh|sql)$/i;
/** A file at or under this many lines is read whole: the saving is not worth a possible second call. */
export const BOUND_MIN_FILE_LINES = 300;
/** A window is never smaller than this (SWE-agent's ablation: 100 lines beat 30, and both beat the whole file). */
export const WINDOW_MIN_LINES = 100;
/** ...and never larger than this. The default window when nothing points at a declaration is lines 1..HEAD_LINES. */
export const WINDOW_MAX_LINES = 250;
export const HEAD_LINES = 250;
/** A window that covers this share of the file (or more) saves too little to be worth the rewrite. */
export const NO_GAIN_SHARE = 0.75;
/** A Read of a bounded path within this many user turns counts as the agent having needed more ("expand"). */
export const EXPAND_WITHIN_TURNS = 3;
/** Lines of context kept above a declaration. */
const PAD_BEFORE = 12;
/** The outline in additionalContext stays under this (about 150 tokens). */
export const OUTLINE_MAX_CHARS = 600;

export type WindowSource = 'injection' | 'explore' | 'head';
export type BoundSkip =
  | 'disabled' | 'not-read' | 'has-range' | 'not-code' | 'outside-repo' | 'sensitive' | 'seen' | 'prompt-names-file'
  | 'prompt-wants-whole' | 'small' | 'not-indexed' | 'no-gain' | 'unreadable' | 'error';

export interface BoundRecord {
  /** absolute path of the file */
  path: string;
  /** user turn (ReadWindowState.turn) the Read was bounded on */
  turn: number;
  offset: number;
  limit: number;
  total: number;
  source: WindowSource;
  /** set once a later Read of the same path asked for more */
  expanded?: boolean;
}

/** Per-session memory. Plain JSON: the chat lane keeps it in memory, a pane keeps it in a marker file. */
export interface ReadWindowState {
  v: 1;
  /** user turns seen; bumped by `startTurn` */
  turn: number;
  /** the user's last real prompt (a Kora notice is not one) */
  prompt: string;
  /** absolute paths already Read / Edited / Written this session (a bounded Read counts) */
  seen: string[];
  /** repo-relative path -> declaration start lines. `inj` are this turn's injection hits, `exp` the last explore / search_code hits. */
  hints: Record<string, { inj?: number[]; exp?: number[] }>;
  bounded: BoundRecord[];
  counts: { considered: number; bounded: number; shadow: number; expanded: number; skipped: Partial<Record<BoundSkip, number>> };
}

export function newReadWindowState(): ReadWindowState {
  return { v: 1, turn: 0, prompt: '', seen: [], hints: {}, bounded: [], counts: { considered: 0, bounded: 0, shadow: 0, expanded: 0, skipped: {} } };
}

/** Read a persisted state defensively: anything malformed becomes a fresh state. */
export function reviveReadWindowState(raw: unknown): ReadWindowState {
  const s = newReadWindowState();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Partial<ReadWindowState>;
  if (typeof r.turn === 'number' && Number.isFinite(r.turn)) s.turn = r.turn;
  if (typeof r.prompt === 'string') s.prompt = r.prompt.slice(0, 4000);
  if (Array.isArray(r.seen)) s.seen = r.seen.filter((x): x is string => typeof x === 'string').slice(-500);
  if (r.hints && typeof r.hints === 'object') {
    for (const [k, v] of Object.entries(r.hints).slice(-100)) {
      if (!v || typeof v !== 'object') continue;
      const nums = (a: unknown) => (Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 8) : undefined);
      const inj = nums((v as any).inj); const exp = nums((v as any).exp);
      s.hints[k] = { ...(inj ? { inj } : {}), ...(exp ? { exp } : {}) };
    }
  }
  if (Array.isArray(r.bounded)) {
    s.bounded = r.bounded.filter((b): b is BoundRecord => !!b && typeof b.path === 'string' && Number.isInteger(b.offset) && Number.isInteger(b.limit) && Number.isInteger(b.total)).slice(-200);
  }
  if (r.counts && typeof r.counts === 'object') {
    const c = r.counts as ReadWindowState['counts'];
    for (const k of ['considered', 'bounded', 'shadow', 'expanded'] as const) if (typeof c[k] === 'number') s.counts[k] = c[k];
    if (c.skipped && typeof c.skipped === 'object') s.counts.skipped = { ...c.skipped };
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing: where do the hints come from?

/** `■ METHOD name @ src/x.ts:42 — sig` (a hit) or `  METHOD name @ src/x.ts:42` (the ranked tail): file -> start lines, rank order. */
const HIT_AT_RE = /^\s*(?:■\s*)?[A-Z_]+\s+\S+\s+@\s+(\S+?):(\d+)\b/;
export function parseHitLines(text: string): Map<string, number[]> {
  // The `■` hits are the declarations the search resolved; the ranked tail below them is looser (names that merely share a
  // word). Hits win; the tail is used only when there is no `■` line at all.
  const collect = (strong: boolean): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    for (const raw of (text || '').split('\n')) {
      if (strong !== /^\s*■/.test(raw)) continue;
      const m = HIT_AT_RE.exec(raw);
      if (!m) continue;
      const n = parseInt(m[2]!, 10);
      if (!Number.isFinite(n) || n < 1) continue;
      const file = m[1]!.replace(/^\.\//, '');
      const arr = out.get(file) ?? [];
      if (!arr.includes(n)) arr.push(n);
      out.set(file, arr);
    }
    return out;
  };
  const hits = collect(true);
  return hits.size ? hits : collect(false);
}

function setHints(state: ReadWindowState, kind: 'inj' | 'exp', hits: Map<string, number[]>): void {
  for (const [file, lines] of hits) {
    const cur = state.hints[file] ?? {};
    // newest first for explore (the LAST hit is the best one); the injection keeps its rank order
    cur[kind] = kind === 'exp' ? [...lines, ...(cur.exp ?? []).filter((l) => !lines.includes(l))].slice(0, 6) : lines.slice(0, 6);
    state.hints[file] = cur;
  }
  const keys = Object.keys(state.hints);
  if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete state.hints[k];
}

/** A new real user prompt: the turn counter moves, the prompt is remembered and last turn's injection hints are stale. */
export function startTurn(state: ReadWindowState, prompt: string): void {
  state.turn += 1;
  state.prompt = (prompt || '').slice(0, 4000);
  for (const h of Object.values(state.hints)) delete h.inj;
}

/** The declarations the per-prompt injection just handed the agent (its `■` lines). */
export function noteInjection(state: ReadWindowState, injectionText: string | null | undefined): void {
  if (injectionText) setHints(state, 'inj', parseHitLines(injectionText));
}

/** Output of `kora graph explore|search_code` (Bash) or a graph MCP tool: the hits become window hints. */
export function noteExplore(state: ReadWindowState, outputText: string | null | undefined): void {
  if (outputText) setHints(state, 'exp', parseHitLines(outputText));
}

const GRAPH_LOOKUP_CMD_RE = /kora(?:-dev)?(?:\.js)?["']?\s+graph\s+(?:explore|search_code)\b/;
export function isGraphLookupCommand(cmd: unknown): boolean { return typeof cmd === 'string' && GRAPH_LOOKUP_CMD_RE.test(cmd); }

/** The text of a PostToolUse `tool_response` (Bash {stdout}, a string, or MCP content blocks). */
export function toolResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  const r = resp as any;
  if (typeof r.stdout === 'string') return r.stdout;
  if (Array.isArray(r.content)) return r.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  if (typeof r.text === 'string') return r.text;
  return '';
}

export interface OutlineSym { kind: string; name: string; line: number }
/** `N symbol(s) in <path>\n  <path>: KIND name:line, KIND name:line, …` (file_symbols) -> symbols sorted by line. */
export function parseOutline(rel: string, text: string): OutlineSym[] {
  const row = (text || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith(rel + ':'));
  if (!row) return [];
  const out: OutlineSym[] = [];
  for (const item of row.slice(rel.length + 1).split(/,\s+(?=[A-Z_]+ )/)) {
    const m = /^([A-Z_]+)\s+(.+):(\d+)$/.exec(item.trim());
    if (!m) continue;
    const line = parseInt(m[3]!, 10);
    if (Number.isFinite(line) && line > 0) out.push({ kind: m[1]!, name: m[2]!, line });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------------------
// The prompt rules

/** The user asked for the file itself, all of it. */
export const WHOLE_RE = /\b(whole|entire|full|complete|top[- ]to[- ]bottom)\b/i;
export function promptWantsWhole(prompt: string): boolean { return WHOLE_RE.test(prompt || ''); }
/** The prompt names this file (its relative path or its file name): the user pointed at it, so the agent may read it whole. */
export function promptNamesFile(prompt: string, abs: string, cwd: string): boolean {
  const p = (prompt || '').toLowerCase();
  if (!p) return false;
  const base = path.basename(abs).toLowerCase();
  if (base.length >= 3 && p.includes(base)) return true;
  const rel = path.relative(cwd, abs).split(path.sep).join('/').toLowerCase();
  return rel.length > 0 && !rel.startsWith('..') && p.includes(rel);
}

// ---------------------------------------------------------------------------------------------------------------
// The window

function declEnd(outline: OutlineSym[], start: number, total: number): number {
  // the next declaration after `start` ends this one; FIELD rows are members and would cut a class short
  for (const s of outline) if (s.line > start && s.kind !== 'FIELD' && s.kind !== 'FILE') return Math.min(total, s.line - 1);
  return total;
}

/** Choose the lines to read. Returns null when the window would cover nearly the whole file (no point). */
export function chooseWindow(total: number, outline: OutlineSym[], inj: number[] | undefined, exp: number[] | undefined): { offset: number; limit: number; source: WindowSource } | null {
  // a hint past the end (the file shrank since the index) is no hint: fall back to the next source
  const inRange = (xs: number[] | undefined) => (xs ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
  const injT = inRange(inj); const expT = inRange(exp);
  const source: WindowSource = injT.length ? 'injection' : expT.length ? 'explore' : 'head';
  const targets = injT.length ? injT : expT;
  let lo = 1; let hi = Math.min(total, HEAD_LINES);
  if (targets.length) {
    const first = targets[0]!;
    lo = Math.max(1, first - PAD_BEFORE);
    hi = Math.min(total, Math.max(declEnd(outline, first, total), lo + WINDOW_MIN_LINES - 1));
    // further hits in the same file ride along while the whole window stays within the cap
    for (const t of targets.slice(1)) {
      const nlo = Math.min(lo, Math.max(1, t - PAD_BEFORE));
      const nhi = Math.min(total, Math.max(hi, declEnd(outline, t, total), nlo + WINDOW_MIN_LINES - 1));
      if (nhi - nlo + 1 <= WINDOW_MAX_LINES) { lo = nlo; hi = nhi; }
    }
    if (hi - lo + 1 > WINDOW_MAX_LINES) hi = lo + WINDOW_MAX_LINES - 1;
  }
  // a window under the minimum grows (down first, then up) so the agent always gets some surrounding code
  if (hi - lo + 1 < WINDOW_MIN_LINES) { hi = Math.min(total, lo + WINDOW_MIN_LINES - 1); lo = Math.max(1, hi - WINDOW_MIN_LINES + 1); }
  const limit = hi - lo + 1;
  if (limit >= total * NO_GAIN_SHARE) return null;
  return { offset: lo, limit, source };
}

const KIND_SHORT: Record<string, string> = { FUNCTION: 'fn', METHOD: 'fn', CLASS: 'class', INTERFACE: 'iface', TYPE: 'type', ENUM: 'enum', STRUCT: 'struct', CONSTANT: 'const', MODULE: 'mod', TRAIT: 'trait' };
/** The additionalContext text: what was shown, what else is in the file, and how to get it. About 150 tokens. */
export function renderBoundNotice(rel: string, w: { offset: number; limit: number }, total: number, outline: OutlineSym[]): string {
  const end = w.offset + w.limit - 1;
  const head = `kora: this Read was bounded to lines ${w.offset}-${end} of ${total} in ${rel} (a whole-file Read is re-billed on every later turn). Read it again for the whole file, or with offset/limit for another range.`;
  const all: string[] = [];
  for (const s of outline) {
    if (s.kind === 'FIELD' || s.kind === 'FILE') continue;
    const k = KIND_SHORT[s.kind];
    if (!k && s.kind !== 'CONSTANT') continue;
    all.push(`${k && k !== 'fn' ? k + ' ' : ''}${s.name}:${s.line}`);
  }
  if (!all.length) return head;
  // everything when it fits; otherwise an even sample, so the outline still spans the whole file (a list cut off after the
  // first few symbols says nothing about where the rest are)
  const room = OUTLINE_MAX_CHARS - head.length - 24;
  const avg = all.reduce((a, b) => a + b.length + 2, 0) / all.length;
  const fit = Math.max(1, Math.floor(room / avg));
  let items = all;
  if (all.length > fit) { const step = all.length / fit; items = Array.from({ length: fit }, (_, i) => all[Math.min(all.length - 1, Math.floor(i * step))]!); items.push('…'); }
  return `${head} Outline (name:line${all.length > fit ? `, ${fit} of ${all.length}` : ''}): ${items.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The decision

export interface ReadIO {
  /** Number of lines (and bytes) of the file, or null when it cannot be read. Must be cheap and bounded. */
  stat(abs: string): Promise<{ lines: number; bytes: number } | null>;
  /** Is the repository indexed and usable (never starts an index)? */
  indexed(): Promise<boolean>;
  /** file_symbols text for a repo-relative path, or null. */
  outline(rel: string): Promise<string | null>;
  /** true for keys / credentials: those are the sensitive guard's, never ours. */
  sensitive?(toolInput: Record<string, unknown>): boolean;
}
export interface BoundOutcome {
  /** the rewritten tool input + notice, when the Read is to be bounded */
  bound: { updatedInput: Record<string, unknown>; additionalContext: string; record: BoundRecord; avoidedTokens: number } | null;
  /** why not (also set in shadow mode, where `shadowRecord` says what would have happened) */
  skip?: BoundSkip;
  shadowRecord?: BoundRecord & { avoidedTokens: number };
}

function bumpSkip(state: ReadWindowState, why: BoundSkip): void { state.counts.skipped[why] = (state.counts.skipped[why] ?? 0) + 1; }

/** Remember that a file was Read / Edited / Written (so a later whole Read of it passes through). */
export function noteFileTouched(state: ReadWindowState, abs: string): void {
  if (!state.seen.includes(abs)) { state.seen.push(abs); if (state.seen.length > 500) state.seen.splice(0, state.seen.length - 500); }
}

/** A Read that follows a bounded one asked for more: the agent paid for (part of) the file anyway, so the bound earns no
 *  saving (the ledger voids it on the returned record's `read-expand` row) — however many turns later (audit 2026-10-15
 *  #4: a re-read after turn 3 used to keep the full credit). Asking within a few turns is also the quality signal
 *  (`counts.expanded`, expandRate). */
function noteExpand(state: ReadWindowState, abs: string, input: Record<string, unknown>): BoundRecord | null {
  const rec = [...state.bounded].reverse().find((b) => b.path === abs);
  if (!rec || rec.expanded) return null;
  const off = typeof input.offset === 'number' ? input.offset : null;
  const lim = typeof input.limit === 'number' ? input.limit : null;
  // a range wholly inside the window is not "more"
  if (off != null && lim != null && off >= rec.offset && off + lim - 1 <= rec.offset + rec.limit - 1) return null;
  rec.expanded = true;
  if (state.turn - rec.turn <= EXPAND_WITHIN_TURNS) state.counts.expanded += 1;
  return rec;
}

/** Shell commands that print a file's content (a later `cat` / `sed -n` of a bounded file is an expand too). */
const SHELL_READER_RE = /(?:^|[\s;&|(`])(?:cat|sed|head|tail|less|more|awk|nl|bat|rg|grep|cut|tac|xxd|od|strings|perl|python3?|node)(?=\s)/;
/**
 * The agent reached a bounded file another way — a Bash command that prints it, or a Grep with content output over it —
 * so the bound saved nothing. Returns the bounded records it expands (each once). Never throws.
 */
export function noteOtherAccess(state: ReadWindowState, toolName: string, toolInput: Record<string, unknown>, cwd: string): BoundRecord[] {
  try {
    const open = state.bounded.filter((b) => !b.expanded);
    if (!open.length) return [];
    let hit: (b: BoundRecord) => boolean;
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (!cmd || !SHELL_READER_RE.test(cmd)) return [];
      const words = cmd.split(/[\s;&|()<>`'"]+/).filter(Boolean);
      const named = new Set(words.map((w) => path.resolve(cwd, w)));
      hit = (b) => named.has(b.path);
    } else if (toolName === 'Grep') {
      if (toolInput.output_mode !== 'content' || typeof toolInput.path !== 'string') return [];
      const target = path.resolve(cwd, toolInput.path);
      hit = (b) => b.path === target;
    } else return [];
    const out = open.filter(hit);
    for (const b of out) { b.expanded = true; if (state.turn - b.turn <= EXPAND_WITHIN_TURNS) state.counts.expanded += 1; }
    return out;
  } catch { return []; }
}

/**
 * The whole decision for one Read. Mutates `state` (seen set, counts). Never throws: any failure is `skip: 'error'`.
 * `mode` 'shadow' computes the same answer but returns it as `shadowRecord` only (nothing is rewritten).
 */
export async function decideRead(
  state: ReadWindowState, toolInput: Record<string, unknown>, cwd: string, io: ReadIO,
  opts: { mode?: 'on' | 'shadow' } = {},
): Promise<BoundOutcome & { expanded?: BoundRecord }> {
  try {
    const fp = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    if (!fp) return { bound: null, skip: 'not-read' };
    const abs = path.resolve(cwd, fp);
    const wasSeen = state.seen.includes(abs);
    const expanded = noteExpand(state, abs, toolInput) ?? undefined;
    noteFileTouched(state, abs);
    const out = (skip: BoundSkip): BoundOutcome & { expanded?: BoundRecord } => { bumpSkip(state, skip); return { bound: null, skip, ...(expanded ? { expanded } : {}) }; };
    if (toolInput.offset != null || toolInput.limit != null) return out('has-range');
    if (!CODE_FILE_RE.test(abs)) return out('not-code');
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return out('outside-repo');
    if (io.sensitive?.(toolInput)) return out('sensitive');
    if (wasSeen) return out('seen');
    state.counts.considered += 1;
    if (promptWantsWhole(state.prompt)) return out('prompt-wants-whole');
    if (promptNamesFile(state.prompt, abs, cwd)) return out('prompt-names-file');
    const st = await io.stat(abs);
    if (!st) return out('unreadable');
    if (st.lines <= BOUND_MIN_FILE_LINES) return out('small');
    if (!(await io.indexed())) return out('not-indexed');
    const hints = state.hints[rel] ?? {};
    const outlineText = await io.outline(rel).catch(() => null);
    const syms = outlineText ? parseOutline(rel, outlineText) : [];
    const w = chooseWindow(st.lines, syms, hints.inj, hints.exp);
    if (!w) return out('no-gain');
    const record: BoundRecord = { path: abs, turn: state.turn, offset: w.offset, limit: w.limit, total: st.lines, source: w.source };
    const avoidedTokens = Math.max(0, Math.round((st.bytes * (1 - w.limit / st.lines)) / 4));
    if (opts.mode === 'shadow') {
      state.counts.shadow += 1;
      return { bound: null, shadowRecord: { ...record, avoidedTokens }, ...(expanded ? { expanded } : {}) };
    }
    state.bounded.push(record);
    if (state.bounded.length > 200) state.bounded.splice(0, state.bounded.length - 200);
    state.counts.bounded += 1;
    return {
      bound: { updatedInput: { ...toolInput, offset: w.offset, limit: w.limit }, additionalContext: renderBoundNotice(rel, w, st.lines, syms), record, avoidedTokens },
      ...(expanded ? { expanded } : {}),
    };
  } catch {
    bumpSkip(state, 'error');
    return { bound: null, skip: 'error' };
  }
}

/** Fraction of bounded Reads the agent asked more of within EXPAND_WITHIN_TURNS turns (null before any bounded Read). */
export function expandRate(state: ReadWindowState): number | null {
  return state.counts.bounded > 0 ? state.counts.expanded / state.counts.bounded : null;
}

// Cold-resume masking (master cost plan 5.1, overnight B6). A thread that comes back after the prompt cache's hour has
// to re-WRITE its whole context (2x on the 1-hour TTL): on this machine's real transcripts that is 6% of the bill. The
// old tool results (file bodies, command output, searches) are most of that context and are rarely needed again, so a
// cold resume continues from a COPY of the transcript where the tool results older than the last few turns are replaced
// by a one-line stub. Nothing else changes: every assistant message (thinking blocks are signed), tool_use id, edit,
// failure and the recent turns stay as they were, and the original transcript is left in place (undo = resume it).
//
// Why a forked JSONL and not an SDK SessionStore (experiment E proved a store works): a resume through a store makes the
// SDK run the CLI against a temporary CLAUDE_CONFIG_DIR with copies of the credentials/settings (and a keychain read on
// macOS), so the resumed turns would not land in the user's own transcript. A fork is a plain session file in the same
// folder, resumed by its new id, nothing else moves.
//
// This module is PURE for the transcript maths (`pruneEntries`, `pruneText`) plus a file step that runs in a CHILD process
// (`forkPrunedInChild`): a transcript can be 10 MB and the daemon's event loop must never hold it. Everything fails open:
// any error, timeout or doubt means "resume the original unchanged".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { koraHome } from '../protocol/types';
import { minimalEnv } from '../util/win-exec';
import { pathTail } from '../util/os-roots';

export type Entry = Record<string, any>;

/** Turns (user prompts) kept whole at the end of the transcript. */
export const DEFAULT_KEEP_TURNS = 10;
/** A result shorter than this is not worth a stub (the stub itself is ~35 tokens). */
export const MIN_STUB_CHARS = 1200;
/** Less than this saved and the fork is not made at all. */
export const MIN_SAVED_TOKENS = 6000;
/** Claude's cache lives an hour; a resume this long after the transcript was last written is a cold one. */
export const COLD_AFTER_MS = 61 * 60 * 1000;
const IMAGE_TOKENS = 1500;

/** Tools whose results are bulk reads that can be fetched again. Anything else (edits, questions, plans, fleet reports) is kept. */
const STUB_TOOLS = new Set(['Read', 'Bash', 'BashOutput', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function stubbable(tool: string | undefined): boolean {
  if (!tool) return false;
  if (STUB_TOOLS.has(tool)) return true;
  // MCP reads (browser pages and screenshots, the graph tools) - but never Kora's own fleet/control tools (worker reports are decisions).
  if (tool.startsWith('mcp__')) return !/(^|__)kora_[a-z]/.test(tool);
  return false;
}

export interface PruneOptions { keepTurns?: number; minStubChars?: number }
export interface PruneReport {
  /** user prompts after the last compaction */
  turns: number;
  /** tool results replaced by a stub */
  stubbed: number;
  /** estimated tokens the stubs remove (chars / 4, 1500 per image) */
  tokensSaved: number;
  /** estimated tokens of the conversation after the last compaction, before the masking */
  contextBefore: number;
  kept: { recent: number; edits: number; errors: number; referenced: number; small: number; other: number };
  /** per tool: how many results were stubbed */
  byTool: Record<string, number>;
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : (b && (b as any).type === 'image') ? '' : JSON.stringify(b))).join('\n');
  return v == null ? '' : JSON.stringify(v);
}
function resultTokens(content: unknown): number {
  if (Array.isArray(content)) {
    let t = 0;
    for (const b of content) {
      if (b && typeof b === 'object' && (b as any).type === 'image') t += IMAGE_TOKENS;
      else t += Math.ceil(textOf([b]).length / 4);
    }
    return t;
  }
  return Math.ceil(textOf(content).length / 4);
}
function charsOfResult(content: unknown): number {
  if (Array.isArray(content)) return content.reduce((n: number, b: any) => n + (b && b.type === 'image' ? 6000 : textOf([b]).length), 0);
  return textOf(content).length;
}
const fmt = (n: number): string => n.toLocaleString('en-US');

/** A real user prompt (not a tool result, a hook/meta line or a compaction summary). */
function isPrompt(e: Entry): boolean {
  if (e.type !== 'user' || e.isSidechain || e.isMeta || e.isCompactSummary) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) return c.length > 0 && !c.some((b: any) => b && b.type === 'tool_result');
  return false;
}
function isBoundary(e: Entry): boolean { return e.isCompactSummary === true || (e.type === 'system' && e.subtype === 'compact_boundary'); }

/** The recent turns name this file: its full path, or the last two segments the way a person types it (src/foo.ts). */
function mentions(corpus: string, target: string): boolean {
  if (corpus.includes(target)) return true;
  const tail = pathTail(target, 2);
  return tail.length > 5 && corpus.includes(tail);
}

function describe(tool: string, input: any): string {
  const s = (v: unknown, n = 70): string => { const t = typeof v === 'string' ? v : ''; return t.length > n ? `${t.slice(0, n)}...` : t; };
  if (tool === 'Read' || tool === 'NotebookRead') return `Read of ${s(input?.file_path ?? input?.notebook_path ?? input?.path, 100) || 'a file'}`;
  if (tool === 'Bash') return `Bash \`${s(input?.command, 60).replace(/\s+/g, ' ')}\``;
  if (tool === 'BashOutput') return 'Bash output';
  if (tool === 'Grep' || tool === 'Glob') return `${tool} \`${s(input?.pattern, 60)}\``;
  if (tool === 'LS') return `LS of ${s(input?.path, 80)}`;
  if (tool === 'WebFetch') return `WebFetch of ${s(input?.url, 80)}`;
  if (tool === 'WebSearch') return `WebSearch for ${s(input?.query, 60)}`;
  return tool.replace(/^mcp__/, '').replace(/__/g, ' ');
}
export function stubText(tool: string, input: any, tokens: number): string {
  return `[Kora: ${describe(tool, input)}, about ${fmt(tokens)} tokens, elided on resume to save tokens. Your earlier notes on it still stand; run it again only if you need the exact output]`;
}

/**
 * The pure masking pass. Entries are the parsed lines of one transcript. Returns new entries (unchanged ones are the same
 * objects) and what was done. Only entries AFTER the last compaction are considered (earlier ones are not in the context).
 */
export function pruneEntries(entries: Entry[], opts: PruneOptions = {}): { entries: Entry[]; report: PruneReport } {
  const keepTurns = Math.max(1, opts.keepTurns ?? DEFAULT_KEEP_TURNS);
  const minChars = opts.minStubChars ?? MIN_STUB_CHARS;
  const report: PruneReport = { turns: 0, stubbed: 0, tokensSaved: 0, contextBefore: 0, kept: { recent: 0, edits: 0, errors: 0, referenced: 0, small: 0, other: 0 }, byTool: {} };

  let first = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isBoundary(entries[i]!)) { first = i + 1; break; }

  const prompts: number[] = [];
  for (let i = first; i < entries.length; i++) if (isPrompt(entries[i]!)) prompts.push(i);
  report.turns = prompts.length;

  // The size of the live conversation, for the "N of M tokens" line and the decision to bother.
  for (let i = first; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const c = e.message?.content;
    if (typeof c === 'string') { report.contextBefore += Math.ceil(c.length / 4); continue; }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') report.contextBefore += resultTokens(b.content);
      else if (b.type === 'text') report.contextBefore += Math.ceil(String(b.text ?? '').length / 4);
      else if (b.type === 'tool_use') report.contextBefore += Math.ceil(JSON.stringify(b.input ?? {}).length / 4) + 20;
      else if (b.type === 'image') report.contextBefore += IMAGE_TOKENS;
    }
  }

  if (prompts.length <= keepTurns) return { entries, report };
  const windowStart = prompts[prompts.length - keepTurns]!;

  // tool_use id -> what it was (from anywhere in the transcript)
  const uses = new Map<string, { name: string; input: any }>();
  for (const e of entries) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) if (b && b.type === 'tool_use' && typeof b.id === 'string') uses.set(b.id, { name: String(b.name ?? ''), input: b.input });
  }
  // What the recent turns talk about: a result for a file they name stays.
  let corpus = '';
  for (let i = windowStart; i < entries.length; i++) {
    const e = entries[i]!;
    const c = e.message?.content;
    if (typeof c === 'string') { corpus += c + '\n'; continue; }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'text') corpus += String(b.text ?? '') + '\n';
      else if (b.type === 'tool_use') corpus += JSON.stringify(b.input ?? {}) + '\n';
    }
  }

  const out = entries.slice();
  for (let i = first; i < windowStart; i++) {
    const e = entries[i]!;
    if (e.type !== 'user' || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    let changed = false; let allStubbed = true; let anyResult = false;
    const blocks = e.message.content.map((b: any) => {
      if (!b || b.type !== 'tool_result') return b;
      anyResult = true;
      const use = typeof b.tool_use_id === 'string' ? uses.get(b.tool_use_id) : undefined;
      const tool = use?.name;
      const chars = charsOfResult(b.content);
      const keep = (why: keyof PruneReport['kept']): any => { report.kept[why]++; allStubbed = false; return b; };
      if (tool && EDIT_TOOLS.has(tool)) return keep('edits');
      if (b.is_error === true) return keep('errors');
      if (!stubbable(tool)) return keep('other');
      if (chars < minChars) return keep('small');
      const target = use?.input?.file_path ?? use?.input?.notebook_path ?? use?.input?.path;
      if ((tool === 'Read' || tool === 'NotebookRead') && typeof target === 'string' && target.length > 3 && mentions(corpus, target)) return keep('referenced');
      const tokens = resultTokens(b.content);
      const stub = stubText(tool!, use?.input, tokens);
      report.stubbed++; report.byTool[tool!] = (report.byTool[tool!] ?? 0) + 1;
      report.tokensSaved += Math.max(0, tokens - Math.ceil(stub.length / 4));
      changed = true;
      return { type: 'tool_result', tool_use_id: b.tool_use_id, content: stub };
    });
    if (!changed) continue;
    const next: Entry = { ...e, message: { ...e.message, content: blocks } };
    // `toolUseResult` is the UI's structured copy of the (now elided) result; the model never sees it.
    if (anyResult && allStubbed) delete next.toolUseResult;
    out[i] = next;
  }
  report.kept.recent = 0;
  for (let i = windowStart; i < entries.length; i++) {
    const c = entries[i]!.message?.content;
    if (entries[i]!.type === 'user' && Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') report.kept.recent++;
  }
  return { entries: out, report };
}

/** Parse + mask + serialise one transcript. A line that is not JSON is kept as it was. */
export function pruneText(text: string, opts: PruneOptions & { sessionId?: string } = {}): { text: string; report: PruneReport; lines: number } {
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const parsed: Array<Entry | null> = raw.map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' && !Array.isArray(j) ? (j as Entry) : null; } catch { return null; } });
  const idx: number[] = []; const ents: Entry[] = [];
  parsed.forEach((p, i) => { if (p) { idx.push(i); ents.push(p); } });
  const { entries, report } = pruneEntries(ents, opts);
  const outLines = raw.slice();
  idx.forEach((lineNo, k) => {
    let e = entries[k]!;
    const retag = opts.sessionId !== undefined && typeof e.sessionId === 'string' && e.sessionId !== opts.sessionId;
    if (retag) e = { ...e, sessionId: opts.sessionId };
    if (e !== ents[k]) outLines[lineNo] = JSON.stringify(e);
  });
  return { text: outLines.join('\n') + '\n', report, lines: raw.length };
}

// ── the file step ─────────────────────────────────────────────────────────────

/** Claude Code files a session under <config dir>/projects/<cwd with every non-alphanumeric turned into "-">/<id>.jsonl. */
export function claudeSlug(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function realOr(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Where this session's transcript is, or null. Tries the cwd's slug (and its real path), then scans the projects folder. */
export function locateTranscript(sessionId: string, cwd: string, configDir?: string | null): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const base = path.join(configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects');
  for (const c of new Set([cwd, realOr(cwd)])) { const f = path.join(base, claudeSlug(c), `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  try { for (const d of fs.readdirSync(base)) { const f = path.join(base, d, `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; } } catch { /* no projects folder */ }
  return null;
}

export interface ForkArgs { src: string; sessionId: string; opts?: PruneOptions; minSavedTokens?: number }
export type ForkOutcome = { forked: false; reason: string; report?: PruneReport } | { forked: true; file: string; sessionId: string; report: PruneReport; bytesBefore: number; bytesAfter: number };

/** Mask a copy of `src` into a NEW session file beside it. Synchronous: call it in a child process. Writes nothing when it would save too little. */
export function forkPrunedSync(args: ForkArgs): ForkOutcome {
  const text = fs.readFileSync(args.src, 'utf8');
  const newId = randomUUID();
  const r = pruneText(text, { ...(args.opts ?? {}), sessionId: newId });
  if (r.report.stubbed === 0 || r.report.tokensSaved < (args.minSavedTokens ?? MIN_SAVED_TOKENS)) return { forked: false, reason: 'too little to trim', report: r.report };
  // Every line must still be a JSON object (the same count as before): a damaged copy would break the resume.
  const back = r.text.split('\n'); back.pop();
  const before = text.split('\n'); if (before[before.length - 1] === '') before.pop();
  if (back.length !== before.length) return { forked: false, reason: 'line count changed', report: r.report };
  const dest = path.join(path.dirname(args.src), `${newId}.jsonl`);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, r.text, { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return { forked: true, file: dest, sessionId: newId, report: r.report, bytesBefore: Buffer.byteLength(text), bytesAfter: Buffer.byteLength(r.text) };
}

/** A fork child killed on its time budget can leave `<uuid>.jsonl.tmp-<pid>` beside the transcript; Claude ignores it, but it is dead weight. */
export function sweepStaleForkTmp(dir: string, now: number = Date.now(), maxAgeMs = 60 * 60 * 1000): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.jsonl\.tmp-\d+$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); n++; } } catch { /* gone */ }
    }
  } catch { /* no folder */ }
  return n;
}

/** forkPrunedSync in a child process (never on the daemon's event loop). Rejects on any failure or after `timeoutMs`. */
export function forkPrunedInChild(args: ForkArgs, timeoutMs = 20_000): Promise<ForkOutcome> {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  const code = `const w=require(${JSON.stringify(__filename)});try{process.stdout.write(JSON.stringify(w.forkPrunedSync(JSON.parse(process.env.KORA_PRUNE_ARGS))))}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(3)}`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', code], { env: minimalEnv({ KORA_PRUNE_ARGS: JSON.stringify(args) }), windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) return reject(new Error(String(errOut || '').trim() || err.message));
      try { resolve(JSON.parse(String(out)) as ForkOutcome); } catch (e) { reject(e); }
    });
  });
}

// ── the cold-resume decision ──────────────────────────────────────────────────

export interface ColdResumeInput {
  sessionId: string; cwd: string; configDir?: string | null;
  now?: number; coldAfterMs?: number; keepTurns?: number; minSavedTokens?: number; timeoutMs?: number; home?: string;
  /** tests: skip the child process */
  inProcess?: boolean;
}
export type ColdResume =
  | { masked: false; reason: string }
  | { masked: true; sessionId: string; originalId: string; stubbed: number; tokensSaved: number; contextBefore: number; byTool: Record<string, number> };

/** `supersededAt`: a newer fork replaced this one on a later cold resume. It stays for a day (until that session is confirmed started, the
 *  thread's saved resume id may still point at it) and is then removed. */
interface ForkRegistry { [forkId: string]: { original: string; file: string; at: number; supersededAt?: number } }
export const SUPERSEDED_FORK_KEEP_MS = 24 * 60 * 60 * 1000;
function registryPath(home: string): string { return path.join(home, 'prune-forks.json'); }
function readRegistry(home: string): ForkRegistry { try { const j = JSON.parse(fs.readFileSync(registryPath(home), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeRegistry(home: string, r: ForkRegistry): void {
  try { fs.mkdirSync(home, { recursive: true }); const tmp = `${registryPath(home)}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 }); fs.renameSync(tmp, registryPath(home)); } catch { /* advisory */ }
}

/**
 * Should this resume continue from a masked copy? Only when the transcript has sat idle past the cache's hour (the context
 * is going to be re-written anyway) and enough old tool output exists to matter. Never throws; `masked:false` means resume
 * the original. A previous Kora-made fork of the same thread is deleted once its successor exists (the user's own original
 * is never deleted).
 */
export async function prepareColdResume(i: ColdResumeInput): Promise<ColdResume> {
  try {
    const home = i.home ?? koraHome();
    const src = locateTranscript(i.sessionId, i.cwd, i.configDir);
    if (!src) return { masked: false, reason: 'transcript not found' };
    const now = i.now ?? Date.now();
    const idle = now - fs.statSync(src).mtimeMs;
    if (idle < (i.coldAfterMs ?? COLD_AFTER_MS)) return { masked: false, reason: 'cache still warm' };
    sweepStaleForkTmp(path.dirname(src), now);
    const args: ForkArgs = { src, sessionId: i.sessionId, opts: { keepTurns: i.keepTurns ?? DEFAULT_KEEP_TURNS }, minSavedTokens: i.minSavedTokens ?? MIN_SAVED_TOKENS };
    const r = i.inProcess ? forkPrunedSync(args) : await forkPrunedInChild(args, i.timeoutMs ?? 20_000);
    if (!r.forked) return { masked: false, reason: r.reason };
    const reg = readRegistry(home);
    const prev = reg[i.sessionId];
    const original = prev?.original ?? i.sessionId;
    // Every other Kora-made fork of this original is stale now (the thread resumes from `i.sessionId`, and from the new fork next), but
    // none is deleted at once: if the new session fails to start, the thread's saved resume id may still name one of them.
    for (const [id, v] of Object.entries(reg)) if (v.original === original && v.supersededAt === undefined && id !== i.sessionId) v.supersededAt = now;
    if (prev) reg[i.sessionId] = { ...prev, supersededAt: now };
    reg[r.sessionId] = { original, file: r.file, at: now };
    dropSupersededForks(reg, now);
    writeRegistry(home, reg);
    return { masked: true, sessionId: r.sessionId, originalId: reg[r.sessionId]!.original, stubbed: r.report.stubbed, tokensSaved: r.report.tokensSaved, contextBefore: r.report.contextBefore, byTool: r.report.byTool };
  } catch (e: any) {
    return { masked: false, reason: `masking skipped: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * The registry is a plain file: a row is trusted to name only a Kora-made fork (`<uuid>.jsonl` straight under a `projects/<slug>/`
 * folder) before anything is unlinked, so a tampered row can never make the daemon delete another file (S6 2026-10-14).
 */
export function isForkFile(file: unknown): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(path.basename(file)) && path.basename(path.dirname(path.dirname(file))) === 'projects';
}
const unlinkFork = (file: unknown): void => { if (isForkFile(file)) { try { fs.unlinkSync(file); } catch { /* gone */ } } };

/** Remove superseded forks past their keep time and rows whose file is gone (mutates `reg`). */
function dropSupersededForks(reg: ForkRegistry, now: number): void {
  for (const [id, v] of Object.entries(reg)) {
    if (v.supersededAt !== undefined && now - v.supersededAt > SUPERSEDED_FORK_KEEP_MS) { unlinkFork(v.file); delete reg[id]; continue; }
    if (!fs.existsSync(v.file)) delete reg[id];
  }
}
/** Housekeeping: the same sweep without a resume. */
export function sweepForks(home: string = koraHome(), now: number = Date.now()): void {
  try { const reg = readRegistry(home); const before = Object.keys(reg).length; dropSupersededForks(reg, now); if (Object.keys(reg).length !== before) writeRegistry(home, reg); } catch { /* advisory */ }
}

/**
 * A deleted thread's Kora-made fork goes with it (the user's own original transcript is never touched): the fork file, and its
 * registry row. A session id that is not a fork of ours is a no-op. Best effort, never throws.
 */
export function forgetFork(sessionId: string, home: string = koraHome()): boolean {
  try {
    const reg = readRegistry(home);
    const v = reg[sessionId];
    if (!v) return false;
    unlinkFork(v.file);
    delete reg[sessionId];
    writeRegistry(home, reg);
    return true;
  } catch { return false; }
}

/** "Trimmed 14 old tool outputs on resume, about 42k tokens." */
export function maskNote(m: Extract<ColdResume, { masked: true }>): string {
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  return `Trimmed ${m.stubbed} old tool output${m.stubbed === 1 ? '' : 's'} on resume (about ${k(m.tokensSaved)} of ${k(m.contextBefore)} tokens), because the cache had expired. Claude can run any of them again.`;
}

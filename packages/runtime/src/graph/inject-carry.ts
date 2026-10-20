// Injection recall, part 2: what "that function" / "the same file" / "it" points at (docs/overnight-2026-10-14, B14).
//
// The per-prompt injection (prompt-inject.ts) fires only for a prompt that carries its own identifier or a structural
// question. Follow-ups in a code conversation carry neither ("ok, now add a test for that function", "why is that file so
// slow"), so on the chat lanes ~92% of prompts were skipped as not-code-shaped. This module keeps a small per-session
// memory of the entities the conversation is about - the declarations the last injections handed over and the files the
// agent touched (drivers report those through `noteEntities`) - and resolves a deictic prompt against it.
//
// What it does NOT do: re-inject a declaration the session already holds (that is already in the agent's context, and
// re-billing it on every later turn is the cost the injection exists to avoid). A resolved reference yields the FILE's
// declaration list (a name:line outline, about 130 tokens) for a file touched recently and not outlined in the last turns.
// Fail-soft: every read/write is best effort, a damaged state file is a fresh one.
import fs from 'node:fs';
import { injectedMarker } from './prompt-inject';

/** A file or symbol stays a candidate for this many prompts after it was last mentioned. */
export const CARRY_MAX_AGE_TURNS = 4;
/** An outline of a file is not repeated within this many prompts. */
export const CARRY_REPEAT_TURNS = 4;
const MAX_ITEMS = 12;

export interface CarryState {
  v: 1;
  /** prompts seen by the injection for this session */
  turn: number;
  /** monotonic mention counter: breaks ties between entries noted in the same turn */
  seq: number;
  files: { rel: string; turn: number; seq?: number }[];
  symbols: { name: string; file: string | null; turn: number; seq?: number }[];
  /** repo-relative file -> turn its outline was last injected */
  outlined: Record<string, number>;
}
const fresh = (): CarryState => ({ v: 1, turn: 0, seq: 0, files: [], symbols: [], outlined: {} });
export function carryPath(sessionId: string | null | undefined): string { return injectedMarker(sessionId) + '-recent'; }

export function loadCarry(sessionId: string | null | undefined): CarryState {
  try {
    const j = JSON.parse(fs.readFileSync(carryPath(sessionId), 'utf8'));
    if (!j || typeof j !== 'object' || j.v !== 1) return fresh();
    const s = fresh();
    if (Number.isFinite(j.turn)) s.turn = j.turn;
    if (Number.isFinite(j.seq)) s.seq = j.seq;
    if (Array.isArray(j.files)) s.files = j.files.filter((f: any) => f && typeof f.rel === 'string' && Number.isFinite(f.turn)).slice(-MAX_ITEMS);
    if (Array.isArray(j.symbols)) s.symbols = j.symbols.filter((f: any) => f && typeof f.name === 'string' && Number.isFinite(f.turn)).slice(-MAX_ITEMS);
    if (j.outlined && typeof j.outlined === 'object') for (const [k, v] of Object.entries(j.outlined)) if (typeof v === 'number') s.outlined[k] = v;
    return s;
  } catch { return fresh(); }
}
function save(sessionId: string | null | undefined, s: CarryState): void {
  try { fs.writeFileSync(carryPath(sessionId), JSON.stringify(s)); } catch { /* best effort */ }
}

const normRel = (f: string) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '');

/** One more prompt in this session (called once per injectForPrompt). Returns the state AFTER the tick. */
export function tickCarry(sessionId: string | null | undefined): CarryState {
  const s = loadCarry(sessionId); s.turn += 1; save(sessionId, s); return s;
}

/**
 * The entities the conversation just touched: files the agent read / edited (repo-relative), declarations it was handed.
 * Drivers call this from their tool events; the injection calls it for what it injected. Cheap and synchronous.
 */
export function noteEntities(sessionId: string | null | undefined, e: { files?: string[]; symbols?: { name: string; file?: string | null }[] }): void {
  if (!sessionId) return;
  const s = loadCarry(sessionId);
  for (const f of e.files ?? []) {
    const rel = normRel(f); if (!rel || rel.startsWith('..') || rel.startsWith('/') || (process.platform === 'win32' && /^[a-z]:\//i.test(rel))) continue;
    s.files = s.files.filter((x) => x.rel !== rel); s.files.push({ rel, turn: s.turn, seq: ++s.seq });
  }
  for (const y of e.symbols ?? []) {
    if (!y.name) continue;
    s.symbols = s.symbols.filter((x) => x.name !== y.name); s.symbols.push({ name: y.name, file: y.file ? normRel(y.file) : null, turn: s.turn, seq: ++s.seq });
  }
  s.files = s.files.slice(-MAX_ITEMS); s.symbols = s.symbols.slice(-MAX_ITEMS);
  save(sessionId, s);
}

/** `■ KIND name @ path:line` lines of an injection -> noteEntities (called after a successful injection). */
export function noteInjectedText(sessionId: string | null | undefined, text: string | null | undefined): void {
  if (!sessionId || !text) return;
  const symbols: { name: string; file: string | null }[] = [];
  for (const l of text.split('\n')) {
    const m = /^\s*■\s*[A-Z_]+\s+(\S+)\s+@\s+(\S+?):\d+/.exec(l);
    if (m) symbols.push({ name: m[1]!, file: m[2]! });
  }
  const fm = /^File (\S+) — declarations/m.exec(text);
  noteEntities(sessionId, { symbols, files: fm ? [fm[1]!] : [] });
}

/** Mark that a file's outline was handed over this turn (so a deictic follow-up does not repeat it). */
export function markOutlined(sessionId: string | null | undefined, rel: string): void {
  if (!sessionId) return;
  const s = loadCarry(sessionId); s.outlined[normRel(rel)] = s.turn; save(sessionId, s);
}

// A reference to something the conversation already has in hand. Deliberately narrow: "it" alone is in half of all prompts.
const THING = '(?:function|method|class|file|module|helper|handler|component|hook|code|test|tests|type|interface|endpoint|route|script|config|command|struct|query|reducer|store|service|class)';
export const DEICTIC_RE = new RegExp(
  `\\b(?:that|this|the same|those|these|the above|the previous|the last)\\s+(?:\\w+\\s+)?${THING}\\b` // "that function", "this file", "the same helper"
  + `|\\b(?:in|to|from|of|inside|within|for)\\s+(?:it|there|that)\\b`                                    // "add a test for it", "rename the helper there"
  + `|\\bthe\\s+${THING}\\s+(?:above|there|we (?:just )?(?:read|edited|changed|touched|looked at))\\b`,
  'i',
);
/** Short, and acts on something: a deictic phrase in a long design paragraph is not a pointer. */
export function isDeicticFollowUp(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (!p || p.length > 240 || p.startsWith('/')) return false;
  if (p.split(/\s+/).length < 3) return false;
  return DEICTIC_RE.test(p);
}

/**
 * The file a deictic prompt points at: the most recently mentioned file within CARRY_MAX_AGE_TURNS prompts, unless its
 * outline was handed over within CARRY_REPEAT_TURNS. null = nothing to carry.
 */
export function carryFile(state: CarryState, prompt: string): string | null {
  if (!isDeicticFollowUp(prompt)) return null;
  // symbols from the last injections count too (their file), newest first
  const cands: { rel: string; turn: number; seq: number }[] = [...state.files.map((f) => ({ rel: f.rel, turn: f.turn, seq: f.seq ?? 0 })), ...state.symbols.filter((y) => y.file).map((y) => ({ rel: y.file as string, turn: y.turn, seq: y.seq ?? 0 }))];
  cands.sort((a, b) => b.turn - a.turn || b.seq - a.seq);
  for (const c of cands) {
    if (state.turn - c.turn > CARRY_MAX_AGE_TURNS) break;
    const last = state.outlined[c.rel];
    if (last != null && state.turn - last < CARRY_REPEAT_TURNS) return null; // already outlined recently: it is in context
    return c.rel;
  }
  return null;
}

/**
 * Feed the memory from a driver's mapped events: files a tool changed (`tool.result.changedFiles`) and files a read tool
 * opened (`tool.started` input path). Absolute paths inside `cwd` become repo-relative; anything outside is dropped.
 * Best effort and cheap (one small file write per call that found something).
 */
export function noteTouchedFromEvents(sessionId: string | null | undefined, cwd: string, events: ReadonlyArray<any>): void {
  if (!sessionId || !events?.length) return;
  try {
    const files: string[] = [];
    const add = (p: unknown) => {
      if (typeof p !== 'string' || !p) return;
      const rel = require('node:path').isAbsolute(p) ? require('node:path').relative(cwd, p) : p;
      if (rel && !rel.startsWith('..')) files.push(rel);
    };
    for (const e of events) {
      if (e?.type === 'tool.result' && Array.isArray(e.changedFiles)) for (const f of e.changedFiles) add(f?.path);
      else if (e?.type === 'tool.started' && e.toolKind === 'file_read' && e.input && typeof e.input === 'object') add((e.input as any).AbsolutePath ?? (e.input as any).TargetFile ?? (e.input as any).file_path ?? (e.input as any).path);
    }
    if (files.length) noteEntities(sessionId, { files });
  } catch { /* recall memory is best effort */ }
}

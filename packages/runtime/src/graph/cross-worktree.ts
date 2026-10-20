// Cross-worktree semantic pre-merge gate (the "graph-verified merge" keystone). Given N worker worktrees that each
// changed some files, git can tell you whether two diffs touch the SAME lines — a textual conflict. It cannot tell
// you that worker A rewrote a symbol whose callers live in a file worker B also changed: git merges both hunks
// clean, and the composition is broken (wrong argument count, a renamed export, a deleted method still called).
// That is a CROSS-DIFF SEMANTIC conflict, and only the code graph can see it: resolve A's changed symbols to their
// dependents, and if any dependent's file is inside B's diff, the two branches are semantically coupled.
//
// What "A changed a symbol" means here is PRECISE: the declarations whose lines the diff actually touched (hunks
// vs the merge base), plus every symbol the base declared that the branch no longer does (renamed / deleted) —
// never "every symbol the file happens to declare". Two edges are checked per pair, both directions:
//   1. graph edge   — a dependent of a touched symbol (base index, `neighbours --direction in`) lives in a file the
//                     other side changed;
//   2. new reference — a line the other side ADDED mentions a touched symbol by name (a brand-new caller the base
//                     index cannot know about, e.g. B calls A's re-signatured function from a new file).
// This module is pure orchestration over two things it does NOT own: the per-file change detail (`fileChange`,
// from the worktree overlay) and an injected `GraphLike` (koragraph's file_symbols → the symbols a file declares,
// and neighbours → who depends on a symbol). Every graph call is wrapped: a tool that errors never throws out.
// A symbol the graph has never seen (NEW on a branch, or an index older than the base) has no recorded
// dependents; those are name-scanned against the other side's added lines instead of forcing needs-human.
// Deterministic (all inputs sorted) so the gate is reproducible.
import fs from 'node:fs';
import path from 'node:path';
import type { MergePair } from '../protocol/types';
import { changedSinceIndex, changedSinceRef, contentAtRef, declaredInChanged, declaredNamesInFile, declaredNamesInText, fileChange, type AddedLine, type FileChange } from './worktree-overlay';
import { isManaged } from '../server/worktree';

export interface WorktreeInput {
  paneId: string;
  path: string;
  indexedSha: string | null;
  /** The commit this ref is compared against (its merge-base with the target). Preferred over `indexedSha`. */
  base?: string | null;
  // When set (the merge-tool path), these are the files this ref changed vs the base — used verbatim instead
  // of diffing. Otherwise the gate diffs since `base` (or, failing that, `indexedSha`).
  changed?: string[];
  truncated?: boolean;
}

// The subset of GraphService this gate needs, injected so the unit test can hand it canned koragraph responses
// instead of standing up a real store. Shape matches GraphService.callTool exactly.
export interface GraphLike {
  callTool(name: string, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<{ text: string; data: unknown; ms: number }>;
}

type Blame = NonNullable<MergePair['blame']>[number];
interface DepRef { file: string; line: number }
interface SymbolDeps { symbol: string; declaredIn: string; deps: DepRef[]; removed: boolean; signature: Signature | null; sigChanged: boolean }
interface WorkerAnalysis {
  worker: WorktreeInput;
  changed: string[];
  changedSet: Set<string>;
  changes: Map<string, FileChange>;
  symbols: SymbolDeps[];      // touched symbols the base graph knows (with their dependents)
  blastSize: number;          // total dependents across this worker's touched symbols — its "reach"
  hardUncertain: boolean;     // genuinely blind: a diff too big to read, or a source file we cannot read
  blindReasons: string[];     // why (file / symbol), so the verdict can say it
  newSymbols: string[];       // bare names of symbols NEW on this branch (graph has no dependents for them yet)
  unknownSymbols: string[];   // bare names the base declares but the graph has no record of (index predates them)
  added: { file: string; line: number; text: string }[]; // every line this worker added, for the name scans
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bareName = (s: string) => s.replace(/^.*[.:#]/, '').trim();
/** A file whose declarations the graph WOULD index; anything else (docs, data, lockfiles, binaries) cannot make us blind. */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|cxx|h|hpp|hh|m|mm|scala|ex|exs|erl|hs|lua|dart|zig|sh|bash|zsh|sql|vue|svelte)$/i;
const looksLikeSource = (f: string) => SOURCE_EXT.test(f);
const readableSource = (root: string, f: string, maxBytes = 512 * 1024): boolean => {
  try { const st = fs.statSync(path.join(root, f)); return st.isFile() && st.size <= maxBytes; } catch { return false; }
};
const rel = (f: string) => f.replace(/^\.\//, '');
// A name too short/generic to scan for by word: `id`, `on`, `at`… would light up every diff.
const scannable = (bare: string) => /^[A-Za-z_$][\w$]*$/.test(bare) && bare.length >= 3;
/** Declarations at file level (no indentation): the ones another file can call. */
const fileLevelNames = (txt: string) => { const ls = txt.split('\n'); return declaredNamesInText(txt).filter((d) => !/^\s/.test(ls[d.line - 1] ?? '')).map((d) => d.name); };
const isCommentLine = (t: string) => /^\s*(?:\/\/|#|\*|\/\*|<!--)/.test(t);

/** First added line (file, line) in `added` that mentions `bare` as a whole word, or null. */
function findReference(bare: string, added: { file: string; line: number; text: string }[]): { file: string; line: number } | null {
  if (!scannable(bare)) return null;
  const re = new RegExp(`(?<![\\w$])${escapeRe(bare)}(?![\\w$])`);
  for (const a of added) { if (isCommentLine(a.text)) continue; if (re.test(a.text)) return { file: a.file, line: a.line }; }
  return null;
}

// ---- call-site compatibility (the cheap, common case: a signature change) ----
// When A changed a function's SIGNATURE and every call B's file makes matches the NEW parameter list, the coupling is
// almost certainly fine (B already adapted, or A kept it compatible). We cannot know semantics, but arity is
// textual and language-agnostic enough (Python / JS / TS / Go / Rust / Java-ish): count required and total params
// at the declaration in A's tree, count arguments at every `name(` call in B's file.
export interface Signature { required: number; max: number | null } // max null = variadic
/** Top-level (depth-0) comma split of an argument/parameter list. */
function splitTop(list: string): string[] {
  const out: string[] = []; let depth = 0; let cur = ''; let q: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (q) { cur += c; if (c === q && list[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** The balanced `(...)` starting at `open` (index of '('), or null when unbalanced within `limit` chars. */
function balancedParens(txt: string, open: number, limit = 4000): string | null {
  let depth = 0; let q: string | null = null;
  for (let i = open; i < Math.min(txt.length, open + limit); i++) {
    const c = txt[i];
    if (q) { if (c === q && txt[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return txt.slice(open + 1, i); }
  }
  return null;
}
/** The parameter list of `bare`'s declaration in `txt` (function/def/fn/func/method forms), or null. */
export function declaredSignature(txt: string, bare: string): Signature | null {
  const re = new RegExp(`(?:^|[^\\w$.])(?:(?:async\\s+)?(?:function\\*?\\s+|def\\s+|fn\\s+|func\\s+(?:\\([^)]*\\)\\s*)?|(?:public|private|protected|static|export|default|async|\\s)*\\s)?)${escapeRe(bare)}\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const open = m.index + m[0].length - 1;
    const inner = balancedParens(txt, open);
    if (inner === null) continue;
    // must look like a declaration: followed by `{`, `:`, `->`, `=>`, or a return type — not a call in an expression
    const after = txt.slice(open + inner.length + 2, open + inner.length + 80);
    if (!/^\s*(?:->|:|\{|=>|[\w$\[\]<>,.| ]*\s*(?:\{|=>|$))/m.test(after)) continue;
    const params = splitTop(inner).filter((p) => !/^(?:self|cls|this)\b/.test(p));
    let required = 0; let variadic = false;
    for (const p of params) {
      if (/^(?:\*|\.\.\.|\*\*)/.test(p) || /\.\.\.\w/.test(p)) { variadic = true; continue; }
      if (/^\*$/.test(p) || /^\/$/.test(p)) continue; // python bare * and /
      if (/[=]/.test(p) && !/=>/.test(p)) continue; // default value
      if (/\?\s*:/.test(p)) continue; // ts optional
      required++;
    }
    return { required, max: variadic ? null : params.filter((p) => !/^(?:\*$|\/$)/.test(p)).length };
  }
  return null;
}
/** Argument counts of every `bare(` call in `txt` (declarations excluded). */
export function callArities(txt: string, bare: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`(?<![\\w$])${escapeRe(bare)}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const before = txt.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:function\*?|def|fn|func|class|new)\s+$/.test(before)) continue; // a declaration (or `new X(` — a constructor, skip)
    const open = m.index + m[0].length - 1;
    const inner = balancedParens(txt, open);
    if (inner === null) continue;
    out.push(splitTop(inner).length);
  }
  return out;
}
const fitsSignature = (n: number, sig: Signature) => n >= sig.required && (sig.max === null || n <= sig.max);

// ---- parsing koragraph output (text is the ground truth; `data` augments when structured) ----

// Symbol kinds that can be depended on. FILE/DOC rows are containers; FIELD rows are struct members the graph lists
// per file but that have no callers of their own (and `ok`, `out`, `name`… would drown the name scans).
const VAR_KINDS = new Set(['VARIABLE', 'CONST', 'LET', 'VAR']);
const DEP_KINDS = new Set(['METHOD', 'FUNCTION', 'FUNC', 'FN', 'CLASS', 'VARIABLE', 'CONST', 'LET', 'VAR', 'TYPE', 'INTERFACE', 'ENUM', 'STRUCT', 'TRAIT', 'MODULE', 'DEF', 'PROPERTY']);
// A declaration line from file_symbols: "■ METHOD foo @ src/foo.ts:42 — foo(x)" or "FUNCTION foo @ src/foo.ts:1".
const DECL_RE = /^\s*(?:■|d\d+)?\s*(METHOD|FUNCTION|FUNC|FN|CLASS|VARIABLE|CONST|LET|VAR|TYPE|INTERFACE|ENUM|STRUCT|TRAIT|MODULE|DEF|PROPERTY|FIELD)\s+([A-Za-z_$][\w$.:#]*)\s+@\s+\S+?:L?(\d+)/gim;
// The compact form: "  src/x.ts: METHOD foo:12, CLASS Bar:3, FIELD y:4"
const COMPACT_RE = /\b(METHOD|FUNCTION|FUNC|FN|CLASS|VARIABLE|CONST|LET|VAR|TYPE|INTERFACE|ENUM|STRUCT|TRAIT|MODULE|DEF|PROPERTY|FIELD)\s+([A-Za-z_$][\w$.:#]*):(\d+)/g;
export interface DeclInfo { name: string; line: number | null; type: string | null }
export function parseDeclarations(res: { text: string; data: unknown }): DeclInfo[] {
  const out = new Map<string, DeclInfo>();
  const put = (name: string, line: number | null, type: string | null) => {
    if (!/^[A-Za-z_$][\w$.:#]*$/.test(name)) return;
    const prev = out.get(name);
    if (!prev) out.set(name, { name, line, type });
    else { if (prev.line == null && line != null) prev.line = line; if (!prev.type && type) prev.type = type; }
  };
  const fromData = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(fromData); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : typeof o.symbol === 'string' ? o.symbol : null;
      const line = typeof o.line === 'number' ? o.line : Number.isFinite(Number(o.line)) && o.line != null ? Number(o.line) : null;
      const type = typeof o.type === 'string' ? o.type.toUpperCase() : typeof o.kind === 'string' ? o.kind.toUpperCase() : null;
      if (name) put(name, line, type);
      for (const val of Object.values(o)) if (val && typeof val === 'object') fromData(val);
    }
  };
  try { fromData((res.data as any)?.symbols ?? res.data); } catch { /* text only */ }
  let m: RegExpExecArray | null; DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(res.text || '')) !== null) put(m[2], Number(m[3]), m[1].toUpperCase());
  COMPACT_RE.lastIndex = 0;
  while ((m = COMPACT_RE.exec(res.text || '')) !== null) put(m[2], Number(m[3]), m[1].toUpperCase());
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
// A dependent reference: "checkout @ src/cart/checkout.ts:12" or a bare "src/cart/checkout.ts:12".
const NAMED_REF_RE = /[A-Za-z_$][\w$.:#]*\s+@\s+((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z]\w*):L?(\d+)/g;
const BARE_REF_RE = /(?:^|[\s,(])((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z]\w*):L?(\d+)/g;
export function parseDependents(res: { text: string; data: unknown }, excludeFile: string): DepRef[] {
  const byKey = new Map<string, DepRef>();
  const add = (file: string, line: number) => {
    const f = rel(file);
    if (!f || f === rel(excludeFile)) return;
    const key = `${f}:${line}`;
    if (!byKey.has(key)) byKey.set(key, { file: f, line });
  };
  const fromData = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(fromData); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const file = typeof o.file === 'string' ? o.file : typeof o.path === 'string' ? o.path : null;
      // prefer the call site over the declaring line of the caller: that is where the coupling actually is
      const line = typeof o.call_line === 'number' ? o.call_line : typeof o.line === 'number' ? o.line : Number(o.line);
      if (file) add(file, Number.isFinite(line) ? line : 0);
      for (const val of Object.values(o)) if (val && typeof val === 'object') fromData(val);
    }
  };
  // neighbours puts incoming edges (the dependents) in data.neighbours.in[]; prefer that over the whole object so
  // outgoing edges (data.neighbours.out) are never miscounted as dependents. Fall back to older shapes, then text.
  try { const d = res.data as any; fromData(d?.neighbours?.in ?? d?.dependents ?? d?.callers ?? d); } catch { /* text only */ }
  const text = res.text || '';
  let m: RegExpExecArray | null;
  NAMED_REF_RE.lastIndex = 0;
  while ((m = NAMED_REF_RE.exec(text)) !== null) add(m[1], Number(m[2]));
  BARE_REF_RE.lastIndex = 0;
  while ((m = BARE_REF_RE.exec(text)) !== null) add(m[1], Number(m[2]));
  return [...byKey.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// ---- the gate ----

const MAX_SYMBOLS_PER_FILE = 60; // a defensive cap on TOUCHED symbols; the 300-file cap on the diff bounds the outer loop
const MAX_BLAME_PER_PAIR = 40;

/** Which base declarations does a set of old-side hunks touch? Spans run from a declaration's line to the next one. */
function touchedByHunks(decls: { name: string; line: number | null }[], fc: FileChange | undefined): Set<string> {
  const out = new Set<string>();
  if (!fc || fc.opaque || fc.status !== 'modified') { for (const d of decls) out.add(d.name); return out; } // no detail → conservative
  const lined = decls.filter((d) => d.line != null).sort((a, b) => a.line! - b.line!);
  for (const d of decls) if (d.line == null) out.add(d.name); // unknown position → conservative
  for (let i = 0; i < lined.length; i++) {
    const start = lined[i].line!; const end = i + 1 < lined.length ? lined[i + 1].line! - 1 : Number.MAX_SAFE_INTEGER;
    if (fc.hunks.some((h) => h.oldStart <= end && h.oldEnd >= start)) out.add(lined[i].name);
  }
  return out;
}

async function analyzeWorker(w: WorktreeInput, svc: GraphLike): Promise<WorkerAnalysis> {
  const base = w.base ?? w.indexedSha ?? null;
  // Merge-tool path hands us the precomputed diff; otherwise diff since the base (or the indexed commit).
  const div = w.changed ? { changed: w.changed, truncated: !!w.truncated } : w.base ? changedSinceRef(w.path, w.base) : changedSinceIndex(w.path, w.indexedSha);
  // kora's own managed files (AGENTS.md, CLAUDE.md, .gemini/…) are written into EVERY worktree by the enforcer and
  // sit there untracked; they are not the worker's change. Non-code files never make us blind either: only a
  // SOURCE file the graph cannot read is a real blind spot.
  const changed = [...div.changed].map(rel).filter((f) => !isManaged(f)).sort();
  const blindReasons: string[] = [];
  const changedSet = new Set(changed);
  const changes = new Map<string, FileChange>();
  const symbols: SymbolDeps[] = [];
  const newSymbols = new Set<string>();
  const unknownSymbols = new Set<string>();
  const added: WorkerAnalysis['added'] = [];
  let blastSize = 0;
  let hardUncertain = div.truncated; // a diff too big to fully see is a genuine blind spot — a human should look
  if (div.truncated) blindReasons.push(`${w.paneId}: diff too large to read fully`);

  for (const file of changed) {
    const fc = base ? fileChange(w.path, base, file) : undefined;
    // Only SOURCE files can call anything: a symbol named in a README, a changelog or a JSON fixture is prose, not
    // an edge (a docs worker mentioning `fmt` in USAGE.md read as "newly calls it" in a live run).
    if (fc) { changes.set(file, fc); if (looksLikeSource(file)) for (const a of fc.added) added.push({ file, line: a.line, text: a.text }); }
    const onDisk = readableSource(w.path, file) || (() => { try { return fs.statSync(path.join(w.path, file)).isFile(); } catch { return false; } })();
    const baseText = base && fc && fc.status !== 'added' ? contentAtRef(w.path, base, file) : '';
    const baseDecls = baseText ? declaredNamesInText(baseText) : [];
    const newDecls = onDisk ? declaredNamesInFile(w.path, file) : [];
    const newNames = new Set(newDecls);

    if (fc?.status === 'added' || (!fc && !baseText && onDisk && !base)) {
      // ADDED on this branch: every symbol it declares is new-on-branch. Enumerate textually (no graph write — a
      // fresh:true re-ingest would pollute the shared index with this throwaway worktree's nodes). A readable
      // source file that declares nothing (a script, an assert-only test) is not a blind spot; an unreadable one is.
      const addedText = (() => { try { return fs.readFileSync(path.join(w.path, file), 'utf8'); } catch { return ''; } })();
      for (const n of addedText ? fileLevelNames(addedText) : newDecls) newSymbols.add(bareName(n));
      if (!newDecls.length && looksLikeSource(file) && !readableSource(w.path, file)) { hardUncertain = true; blindReasons.push(`${w.paneId}: cannot read new file ${file}`); }
      continue;
    }

    // Symbols the BASE declares in this file: the graph's list (fresh:false = the base index, which resolves method
    // names the textual heuristic misses) ∪ the base text's declarations (exact base-coordinate lines).
    let graphDecls: DeclInfo[] = [];
    try { graphDecls = parseDeclarations(await svc.callTool('file_symbols', { path: file }, { cwd: w.path, fresh: false })); }
    catch { graphDecls = []; /* not in the base index: fall through to the textual declarations */ }
    const known = new Map<string, { name: string; line: number | null }>();
    // A variable declared inside a function body (`const first = …`) has no callers outside it; only file-level ones count.
    const baseLines = baseText ? baseText.split('\n') : [];
    const fileLevel = (line: number | null | undefined) => line == null || !baseLines.length || !/^\s/.test(baseLines[line - 1] ?? '');
    for (const d of graphDecls) {
      if (d.type && !DEP_KINDS.has(d.type)) continue;
      // Keep only what the base (or, failing base text, the worktree) REALLY declares: the index can answer for the
      // wrong copy of a file, returning phantom names that would make every neighbours call fail.
      const bare = bareName(d.name);
      const inBase = baseText ? declaredInText(baseText, bare) : declaredInChanged(w.path, [file], d.name) !== null;
      if (!inBase) continue;
      const exact = baseDecls.find((b) => b.name === bare);
      if (d.type && VAR_KINDS.has(d.type) && !fileLevel(exact?.line ?? d.line)) continue;
      known.set(d.name, { name: d.name, line: exact?.line ?? d.line });
    }
    for (const b of baseDecls) if (fileLevel(b.line) && ![...known.keys()].some((k) => bareName(k) === b.name)) known.set(b.name, { name: b.name, line: b.line });
    if (!known.size && looksLikeSource(file) && fc?.status === 'deleted' && !baseText) { hardUncertain = true; blindReasons.push(`${w.paneId}: cannot read ${file} at the base`); continue; }

    // Touched = declarations whose span a hunk crosses, plus every base declaration this branch no longer has
    // (renamed or deleted — the graph's dependents of the OLD name are exactly the callers now broken).
    const touched = touchedByHunks([...known.values()], fc);
    const removed = new Set<string>();
    const newText = onDisk ? (() => { try { return fs.readFileSync(path.join(w.path, file), 'utf8'); } catch { return ''; } })() : '';
    // Gone = the branch no longer declares it by the SAME test that kept it as a base declaration (declaredInText):
    // the narrower declaredNamesInFile alone read `resolve(…)`, `close`, `onProgress` as removed (live, 2026-10-17).
    for (const k of known.keys()) { const b = bareName(k); if (!newNames.has(b) && !(newText && declaredInText(newText, b)) && (fc?.status === 'deleted' || onDisk)) { touched.add(k); removed.add(k); } }
    // A one- or two-letter name (`v`, `on`, `at`) is a local or a parameter: the graph resolves it to an unrelated namesake.
    for (const k of [...touched]) if (!scannable(bareName(k))) touched.delete(k);
    // New declarations in a modified file (a helper added next to the edit): name-scan material, not graph material.

    // New declarations in a modified file (a helper added next to the edit): name-scan material, not graph material.
    for (const n of newText ? fileLevelNames(newText) : newDecls) if (![...known.keys()].some((k) => bareName(k) === n)) newSymbols.add(n);
    const sigChangedOf = (bare: string) => { const o = baseText ? declaredSignature(baseText, bare) : null; const n = newText ? declaredSignature(newText, bare) : null; return !!o && !!n && (o.required !== n.required || o.max !== n.max); };
    const list = [...touched].sort().slice(0, MAX_SYMBOLS_PER_FILE);
    if (touched.size > MAX_SYMBOLS_PER_FILE) { hardUncertain = true; blindReasons.push(`${w.paneId}: ${file} touches ${touched.size} declarations (only ${MAX_SYMBOLS_PER_FILE} checked)`); }
    for (const symbol of list) {
      let depRes: { text: string; data: unknown; ms: number };
      // Dependents of a SYMBOL come from `neighbours … --direction in` (data.neighbours.in[] = {file,line,…}).
      // (blast_radius is FILE-scoped — a different tool; using it with a symbol arg returns nothing.)
      // `file` pins the lookup to THIS declaration: a bare `driver` or `update` otherwise resolves to every namesake in the repo.
      try { depRes = await svc.callTool('neighbours', { symbol, file, direction: 'in' }, { cwd: w.path, fresh: false }); }
      catch {
        // The graph has no record of this symbol even though the base text declares it: the index predates it
        // (a symbol added on main after the last ingest). Its callers are unknown to the graph, so it is scanned
        // by NAME against the other side's added lines instead of forcing a blanket needs-human.
        if (fileLevel(known.get(symbol)?.line)) unknownSymbols.add(bareName(symbol));
        symbols.push({ symbol, declaredIn: file, deps: [], removed: removed.has(symbol), signature: newText ? declaredSignature(newText, bareName(symbol)) : null, sigChanged: sigChangedOf(bareName(symbol)) });
        continue;
      }
      const deps = parseDependents(depRes, file);
      blastSize += deps.length;
      symbols.push({ symbol, declaredIn: file, deps, removed: removed.has(symbol), signature: newText ? declaredSignature(newText, bareName(symbol)) : null, sigChanged: sigChangedOf(bareName(symbol)) });
    }
  }
  symbols.sort((a, b) => (a.symbol === b.symbol ? (a.declaredIn < b.declaredIn ? -1 : 1) : a.symbol < b.symbol ? -1 : 1));
  added.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  return { worker: w, changed, changedSet, changes, symbols, blastSize, hardUncertain, blindReasons, newSymbols: [...newSymbols].sort(), unknownSymbols: [...unknownSymbols].sort(), added };
}

const DECL_KW = '(?:function|class|def|const|let|var|type|interface|enum|struct|trait|fn|func|module|impl)';
function declaredInText(txt: string, bare: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(bare)) return false;
  const e = escapeRe(bare);
  return new RegExp(`${DECL_KW}\\s+${e}\\b|\\b${e}\\s*[=:]\\s*(?:async\\s*)?(?:function\\b|\\(|\\{)|^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+)*${e}\\s*\\(`, 'm').test(txt);
}

/** Is base-coordinate line `line` of `file` inside one of `dst`'s old-side hunks (i.e. did dst edit that very call site)? */
function inHunks(dst: WorkerAnalysis, file: string, line: number): boolean {
  const fc = dst.changes.get(file);
  if (!fc) return false;
  if (fc.status !== 'modified' || fc.opaque) return true;
  return fc.hunks.some((h) => h.oldStart <= line && h.oldEnd >= line);
}

/**
 * Detect cross-diff semantic conflicts across N worker worktrees and propose a merge order.
 *
 * For every unordered pair {A, B} it checks BOTH directions: does a symbol A touched have a dependent inside B's
 * diff (graph edge), or does a line B added reference a symbol A touched (a new caller the graph cannot know), and
 * vice versa. Any such hit → `semantic`, with a `blame` entry naming the file:line, the symbol, the worker whose
 * change reaches into the other's diff, and whether the other side edited that very line. A pair with no hit is
 * `clean`, unless the gate was genuinely blind on either side (a diff too large, an unreadable source file, a
 * touched-declaration overflow) or a symbol the graph has no record of is mentioned by the other side's added
 * lines → `needs-human`. `order` is a suggested merge sequence: fewest conflicts and smallest blast radius first.
 */
export async function crossWorktreeConflicts(
  workers: WorktreeInput[],
  svc: GraphLike,
): Promise<{ pairs: MergePair[]; order: string[] }> {
  // Deterministic from here: sort workers by paneId so pairs, blame, and order never depend on input order.
  const sorted = [...workers].sort((a, b) => (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
  const analyses: WorkerAnalysis[] = [];
  for (const w of sorted) analyses.push(await analyzeWorker(w, svc));

  const pairs: MergePair[] = [];
  const conflictCount = new Map<string, number>();
  for (const a of sorted) conflictCount.set(a.paneId, 0);

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const A = analyses[i], B = analyses[j]; // A.paneId < B.paneId by the sort above
      const blame: Blame[] = [];
      const seen = new Set<string>();
      // one entry per (worker, symbol, file:line): a graph dependent is pushed before a textual reference to the same line
      const push = (b: Blame) => { const k = `${b.byWorker}|${b.file}:${b.line}|${b.symbol}`; if (!seen.has(k) && blame.length < MAX_BLAME_PER_PAIR) { seen.add(k); blame.push(b); } };
      let status: MergePair['status'] = 'clean';
      let hidden: string | null = null;
      // A coupling is `compatible` when the symbol still exists, A's new signature parsed, and EVERY call the other
      // side's file makes to it fits that signature (B already adapted, or A kept it compatible).
      const fileTextCache = new Map<string, string>();
      const textOf = (dst: WorkerAnalysis, file: string) => {
        const k = `${dst.worker.paneId}|${file}`;
        if (!fileTextCache.has(k)) { try { fileTextCache.set(k, fs.readFileSync(path.join(dst.worker.path, file), 'utf8')); } catch { fileTextCache.set(k, ''); } }
        return fileTextCache.get(k)!;
      };
      const compatible = (sd: SymbolDeps, dst: WorkerAnalysis, file: string): boolean => {
        if (sd.removed || !sd.signature) return false;
        const arities = callArities(textOf(dst, file), bareName(sd.symbol));
        return arities.length > 0 && arities.every((n) => fitsSignature(n, sd.signature!));
      };

      for (const [src, dst] of [[A, B], [B, A]] as [WorkerAnalysis, WorkerAnalysis][]) {
        for (const sd of src.symbols) {
          // 1. graph edge: a known dependent of the touched symbol sits in a file the other side changed
          for (const d of sd.deps) {
            // A body-only edit couples to a caller only where the other side edited that very call site.
            if (dst.changedSet.has(d.file) && (sd.removed || sd.sigChanged || inHunks(dst, d.file, d.line))) {
              status = 'semantic';
              push({ file: d.file, line: d.line, symbol: sd.symbol, byWorker: src.worker.paneId, kind: 'dependent', inHunk: inHunks(dst, d.file, d.line), ...(sd.removed ? { removed: true } : {}), ...(compatible(sd, dst, d.file) ? { compatible: true } : {}) });
            }
          }
          // 2. new reference: the other side ADDED a line that names the touched symbol (a caller the base index
          //    cannot have). Skip the symbol's own declaring file on the other side when it declares it too — both
          //    editing the same declaration is a textual matter git already surfaces.
          //    Only a removed or re-signatured symbol can break a new caller; a body edit cannot, and the name scan
          //    alone cannot tell `run` the function from every other `run`.
          const ref = (sd.removed || sd.sigChanged) && findReference(bareName(sd.symbol), dst.added.filter((a) => a.file !== sd.declaredIn || !dst.changes.get(a.file)?.added.some((l) => declaredInText(l.text, bareName(sd.symbol)))));
          if (ref) {
            status = 'semantic';
            push({ file: ref.file, line: ref.line, symbol: sd.symbol, byWorker: src.worker.paneId, kind: 'reference', inHunk: true, ...(sd.removed ? { removed: true } : {}), ...(compatible(sd, dst, ref.file) ? { compatible: true } : {}) });
          }
        }
        // 3. a symbol the graph cannot see (new on this branch / unknown to the index) named by the other side's
        //    added lines: a possible hidden edge the gate cannot confirm → needs-human, unless already semantic.
        if (!hidden) {
          for (const n of [...src.newSymbols, ...src.unknownSymbols]) {
            // A file that declares the name itself (`const first = …`) is naming its own, not src's new symbol.
            const r = findReference(n, dst.added.filter((a) => !declaredInText(textOf(dst, a.file), n)));
            if (r) { hidden = `${src.worker.paneId} introduces \`${n}\`, which ${dst.worker.paneId}'s new lines mention (${r.file}:${r.line}) — a possible hidden edge`; push({ file: r.file, line: r.line, symbol: n, byWorker: src.worker.paneId, kind: 'reference', inHunk: true }); break; }
          }
        }
      }
      let reason: string | undefined;
      if (status === 'semantic' && blame.length > 0 && blame.every((b) => b.compatible)) {
        // Every coupling is a call that already fits the changed signature: no evidence of breakage. Say so.
        status = 'clean';
        const syms = [...new Set(blame.map((b) => `${bareName(b.symbol)} (changed by ${b.byWorker})`))].slice(0, 3);
        reason = `${blame.length} call site(s) checked — every call of ${syms.join(', ')} matches the new signature`;
      }
      if (status === 'semantic') {
        // In words, per symbol: "A removed limit; B uses it at api.js:2 (a line B edited)". The first three symbols.
        const bySym = new Map<string, Blame[]>();
        for (const b of blame) { const k = `${b.byWorker}|${b.symbol}`; if (!bySym.has(k)) bySym.set(k, []); bySym.get(k)!.push(b); }
        const parts: string[] = [];
        for (const [, bs] of bySym) {
          if (parts.length >= 3) break;
          const b0 = bs[0]; const other = b0.byWorker === A.worker.paneId ? B.worker.paneId : A.worker.paneId;
          const sites = bs.slice(0, 2).map((b) => `${b.file}:${b.line}`).join(', ') + (bs.length > 2 ? ` +${bs.length - 2}` : '');
          const edited = bs.some((b) => b.inHunk); const fresh = bs.every((b) => b.kind === 'reference');
          parts.push(`${b0.byWorker} ${b0.removed ? 'removed' : 'changed'} ${bareName(b0.symbol)}; ${other} ${fresh ? 'newly calls' : 'uses'} it at ${sites}${edited ? ' (on lines it edited)' : ''}`);
        }
        reason = parts.join(' · ') + (bySym.size > 3 ? ` · +${bySym.size - 3} more` : '');
      } else if (A.hardUncertain || B.hardUncertain) {
        status = 'needs-human'; reason = [...A.blindReasons, ...B.blindReasons].slice(0, 3).join('; ') || 'graph blind spot';
      } else if (hidden) { status = 'needs-human'; reason = hidden; }
      if (status === 'clean' && !reason) blame.length = 0;
      if (status !== 'clean') {
        conflictCount.set(A.worker.paneId, (conflictCount.get(A.worker.paneId) || 0) + 1);
        conflictCount.set(B.worker.paneId, (conflictCount.get(B.worker.paneId) || 0) + 1);
      }
      blame.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
      pairs.push({ a: A.worker.paneId, b: B.worker.paneId, status, ...(blame.length ? { blame } : {}), ...(reason ? { reason } : {}) });
    }
  }

  // Merge order: fewest conflicts first, then smallest blast radius, then paneId — a total, deterministic order and
  // always a permutation of the input paneIds.
  const order = [...analyses]
    .sort((a, b) => {
      const ca = conflictCount.get(a.worker.paneId) || 0, cb = conflictCount.get(b.worker.paneId) || 0;
      if (ca !== cb) return ca - cb;
      if (a.blastSize !== b.blastSize) return a.blastSize - b.blastSize;
      return a.worker.paneId < b.worker.paneId ? -1 : a.worker.paneId > b.worker.paneId ? 1 : 0;
    })
    .map((a) => a.worker.paneId);

  return { pairs, order };
}

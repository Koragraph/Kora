// Worktree / working-tree graph overlay (RESEARCH.md option 2). The code graph is ONE index per repo, built at a
// known commit, and koragraph's live-freshness keeps the MAIN checkout current at query time. A worktree,
// though, is on its own branch that freshness cannot reach, so its edits are invisible to the base graph. Rather than
// store a second graph per worktree (which multiplies the single biggest disk consumer by the number of
// worktrees — see the storage measurements), this overlay is computed on the fly from `git diff` each query and
// stores NOTHING:
//   - it knows exactly which files this checkout changed since the index (cheap: `git diff --name-only <sha>`),
//   - it LABELS results whose files changed ("open to confirm — moved since indexing"),
//   - and, critically, it makes `blast_radius` HONEST: a base-graph "who depends on X" is correct for a
//     pre-existing symbol you are about to edit (the callers are the pre-edit callers), but it can silently MISS
//     callers of a symbol you ADDED this branch, or list ones you removed. The overlay detects those cases and
//     says so, pointing at grep, instead of handing back a confident wrong all-clear.
// Scope: applied only in a linked worktree (the freshness gap). The main checkout is left alone — freshness
// handles it there, and a label would be a false alarm.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Divergence { changed: string[]; truncated: boolean }

function git(cwd: string, args: string[]): string {
  // fsmonitor off: these run in the background on every query/merge gate, and a repo's .git/config naming an fsmonitor
  // command must not get it executed by them (git status/diff invoke it for working-tree comparisons).
  try { const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); return r.status === 0 ? String(r.stdout || '') : ''; }
  catch { return ''; }
}

/**
 * Repo-relative files in `cwd`'s checkout that differ from the indexed commit `sha` — committed-on-this-branch +
 * staged + unstaged + untracked. Exactly the set the base graph (built at `sha`) does not know about. Empty when
 * `sha` is unknown (repo not indexed) or nothing diverged (a clean checkout at the indexed commit → no overlay,
 * so a fresh repo gets zero labels and zero noise). Capped so a huge branch cannot blow up a query.
 */
export function changedSinceIndex(cwd: string, sha: string | null, cap = 300): Divergence {
  if (!sha) return { changed: [], truncated: false };
  const set = new Set<string>();
  for (const l of git(cwd, ['diff', '--name-only', sha, '--']).split('\n')) { const f = l.trim(); if (f) set.add(f); }
  for (const l of git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n')) { const f = l.trim(); if (f) set.add(f); }
  const all = [...set];
  return { changed: all.slice(0, cap), truncated: all.length > cap };
}

/**
 * Repo-relative files in `cwd`'s checkout that differ from an ARBITRARY base ref (a branch, tag, or SHA) — the
 * three-dot diff base...HEAD (what this branch changed since it forked from base) plus staged/unstaged/untracked.
 * This is the merge-tool sibling of `changedSinceIndex`: the merge gate diffs each ref against the merge-base of
 * the set, not against whatever commit the graph was indexed at. Empty when `baseRef` is unknown/unresolvable.
 * Capped so a huge branch cannot blow up the gate.
 */
export function changedSinceRef(cwd: string, baseRef: string | null, cap = 300): Divergence {
  if (!baseRef) return { changed: [], truncated: false };
  const set = new Set<string>();
  // base...HEAD = changes on HEAD's side since the common ancestor (ignores commits that landed on base meanwhile).
  for (const l of git(cwd, ['diff', '--name-only', `${baseRef}...HEAD`, '--']).split('\n')) { const f = l.trim(); if (f) set.add(f); }
  // plus anything uncommitted in this working tree (staged + unstaged), and untracked files.
  for (const l of git(cwd, ['diff', '--name-only', 'HEAD', '--']).split('\n')) { const f = l.trim(); if (f) set.add(f); }
  for (const l of git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n')) { const f = l.trim(); if (f) set.add(f); }
  const all = [...set];
  return { changed: all.slice(0, cap), truncated: all.length > cap };
}


// ---- per-file change detail for the merge gate (hunks + added lines) ----
export interface Hunk { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
export interface AddedLine { line: number; text: string }
export interface FileChange {
  file: string;
  status: 'added' | 'deleted' | 'modified';
  /** Changed regions (old = base coordinates, new = this tree's). Empty for a file we could not diff. */
  hunks: Hunk[];
  /** Lines this tree ADDED (new-side `+` lines), with their new-side line numbers — the only place a brand-new
   *  reference to another branch's symbol can live. Bounded. */
  added: AddedLine[];
  /** True when the diff could not be read (binary / too large) — the gate treats every symbol as touched. */
  opaque: boolean;
}
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseUnified(diff: string, maxAdded: number): { hunks: Hunk[]; added: AddedLine[] } {
  const hunks: Hunk[] = []; const added: AddedLine[] = [];
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      const oc = m[2] === undefined ? 1 : Number(m[2]); const nc = m[4] === undefined ? 1 : Number(m[4]);
      const os = Number(m[1]); const ns = Number(m[3]);
      hunks.push({ oldStart: oc === 0 ? os + 1 : os, oldEnd: oc === 0 ? os : os + oc - 1, newStart: nc === 0 ? ns + 1 : ns, newEnd: nc === 0 ? ns : ns + nc - 1 });
      newLine = ns; continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) { if (added.length < maxAdded) added.push({ line: newLine, text: raw.slice(1) }); newLine++; }
    else if (raw.startsWith(' ')) newLine++;
  }
  return { hunks, added };
}
/** Does `baseRef:file` exist? (a file absent at the base was ADDED on this branch) */
export function existsAtRef(cwd: string, baseRef: string, file: string): boolean {
  try { return spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'cat-file', '-e', `${baseRef}:${file}`], { stdio: 'ignore', timeout: 3000 }).status === 0; } catch { return false; }
}
/** The file's content at `baseRef` ('' if absent/unreadable). Bounded. */
export function contentAtRef(cwd: string, baseRef: string, file: string, maxBytes = 512 * 1024): string {
  const t = git(cwd, ['show', `${baseRef}:${file}`]);
  return t.length > maxBytes ? '' : t;
}
/**
 * Exactly WHICH regions of `file` this checkout changed vs `baseRef` (working tree incl. uncommitted, vs the base
 * commit), plus the lines it added. Lets the gate confine "changed symbols" to the declarations the diff actually
 * touched instead of every symbol the file declares — the difference between a precise verdict and a false
 * `semantic` on every shared file. Never throws; an undiffable file comes back `opaque` (treat as fully changed).
 */
/** Largest ADDED file read whole for the gate; anything bigger (or a symlink, which could point anywhere on disk) is opaque. */
export const ADDED_FILE_MAX_BYTES = 4 << 20;
export function fileChange(cwd: string, baseRef: string, file: string, maxAdded = 4000): FileChange {
  const abs = path.join(cwd, file);
  // lstat, not stat: a worker's branch can add `notes.txt -> ~/.ssh/id_rsa`; the gate must not read (and quote) it.
  const st = (() => { try { return fs.lstatSync(abs); } catch { return null; } })();
  const onDisk = !!st && (st.isFile() || st.isSymbolicLink());
  const inBase = existsAtRef(cwd, baseRef, file);
  if (!onDisk && !inBase) return { file, status: 'modified', hunks: [], added: [], opaque: true };
  if (!inBase) {
    // ADDED on this branch: every line is new. Read the file directly (git diff vs base cannot show an untracked file).
    if (!st || !st.isFile() || st.size > ADDED_FILE_MAX_BYTES) return { file, status: 'added', hunks: [], added: [], opaque: true };
    let txt = ''; try { txt = fs.readFileSync(abs, 'utf8'); } catch { return { file, status: 'added', hunks: [], added: [], opaque: true }; }
    const lines = txt.split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { file, status: 'added', hunks: [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: lines.length }], added: lines.slice(0, maxAdded).map((text, i) => ({ line: i + 1, text })), opaque: false };
  }
  if (!onDisk) {
    const n = contentAtRef(cwd, baseRef, file).split('\n').length;
    return { file, status: 'deleted', hunks: [{ oldStart: 1, oldEnd: Math.max(1, n), newStart: 1, newEnd: 0 }], added: [], opaque: false };
  }
  const diff = git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', baseRef, '--', file]);
  if (!diff.trim()) return { file, status: 'modified', hunks: [], added: [], opaque: false }; // identical to base (e.g. changed then reverted)
  if (/^Binary files/m.test(diff)) return { file, status: 'modified', hunks: [], added: [], opaque: true };
  const { hunks, added } = parseUnified(diff, maxAdded);
  return { file, status: 'modified', hunks, added, opaque: hunks.length === 0 };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does a changed file declare `symbol`? A cheap textual check over just the diverged files (bounded bytes), enough
 *  to distinguish "brand-new symbol this branch added" from "typo / not a symbol". Not a parser — deliberately. */
export function declaredInChanged(root: string, changed: string[], symbol: string, maxBytes = 512 * 1024): string | null {
  const bare = symbol.replace(/^.*[.:#]/, '').trim(); // Session.get → get, file.go:readCSV → readCSV
  if (!/^[A-Za-z_$][\w$]*$/.test(bare)) return null;
  const re = new RegExp(
    `(?:function|class|def|const|let|var|type|interface|enum|struct|trait|fn|func|module|impl)\\s+${escapeRe(bare)}\\b`
    + `|\\b${escapeRe(bare)}\\s*[=:]\\s*(?:async\\s*)?(?:function\\b|\\(|\\{)`
    + `|(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class)\\s+${escapeRe(bare)}\\b`,
  );
  let budget = maxBytes;
  for (const rel of changed) {
    if (budget <= 0) break;
    try {
      const st = fs.statSync(path.join(root, rel)); if (!st.isFile() || st.size > budget) { budget -= 0; continue; }
      const txt = fs.readFileSync(path.join(root, rel), 'utf8'); budget -= txt.length;
      if (re.test(txt)) return rel;
    } catch { /* skip */ }
  }
  return null;
}

// Top-level declaration NAMES a source file declares, extracted textually (not from the graph). Used by the merge
// gate when koragraph can't enumerate a file because it is NEW on the branch (not in the base index) — every name
// here is therefore new-on-branch. Deliberately a heuristic, not a parser: bounded read, common declaration forms.
const DECL_NAME_RE = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*(?:function|class|const|let|var|type|interface|enum|struct|trait|impl|fn|func|def|module)\s+([A-Za-z_$][\w$]*)/g;
export function declaredNamesInFile(root: string, file: string, maxBytes = 512 * 1024): string[] {
  let txt = '';
  try { const p = path.join(root, file); const st = fs.statSync(p); if (!st.isFile() || st.size > maxBytes) return []; txt = fs.readFileSync(p, 'utf8'); }
  catch { return []; }
  return declaredNamesInText(txt).map((d) => d.name);
}
/** Same heuristic over text, WITH 1-based line numbers (first declaration of each name wins). */
export function declaredNamesInText(txt: string): { name: string; line: number }[] {
  const out = new Map<string, number>(); let m: RegExpExecArray | null; DECL_NAME_RE.lastIndex = 0;
  while ((m = DECL_NAME_RE.exec(txt)) !== null) {
    if (out.has(m[1])) continue;
    // the match may start at the preceding "\n"; count newlines up to the keyword
    let line = 1; for (let i = 0; i < m.index; i++) if (txt.charCodeAt(i) === 10) line++;
    if (txt[m.index] === '\n') line++;
    out.set(m[1], line);
  }
  return [...out].map(([name, line]) => ({ name, line }));
}

// The subject symbol of a query, if any (blast_radius/neighbours/recall/changes_with use `symbol`; explore/
// search_code use `query` when it is a lone identifier; file_symbols uses `path`).
export function subjectSymbol(name: string, args: Record<string, unknown>): string | null {
  if (typeof args.symbol === 'string' && args.symbol.trim()) return args.symbol.trim();
  if ((name === 'explore' || name === 'search_code') && typeof args.query === 'string') {
    const q = args.query.trim();
    if (/^[A-Za-z_$][\w$.:#]*$/.test(q) && q.length >= 2) return q; // a lone identifier, not a phrase
  }
  return null;
}

// Repo-relative files a result points at (■ hits, `--- source path:a-b ---`, `name @ path:line`, `Changed: path`).
const RESULT_FILE_RE = /(?:@\s+|--- source\s+|^\s*Changed:\s+|■\s+\S+\s+\S+\s+@\s+)?((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z]\w*)(?::L?\d+(?:-\d+)?)?/g;
// Files of the PRIMARY declarations only (the ■ top hits) — what the query is actually about, not the callees/
// imports it happens to reference. Labelling those, not every referenced file, keeps the note about "the thing you
// looked up moved" instead of "something it touches moved" (which would be noisy in a busy worktree).
const PRIMARY_HIT_RE = /^\s*■\s+\S+\s+\S+\s+@\s+((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z]\w*):/gm;
const FILE_PAT = '((?:[\\w.\\-]+\\/)*[\\w.\\-]+\\.[A-Za-z]\\w*)';
// The other tools' answer lines, which `■` never matched — so in a worktree their stale line numbers went out unlabelled
// (measured 2026-10-15: `neighbours graphReady --direction in` from a branch that had moved hook.ts answered 335/517 for
// call sites now at 404/556; 3 of 4 Haiku runs cited them as fact). The callers ARE a neighbours answer, so their files count.
const ANSWER_RE: Record<string, RegExp[]> = {
  // `METHOD graphReady @ path:L289` (headline) and `  in   ← CALLS ←  METHOD preTool @ path:L337 (line 335)` (a relation)
  neighbours: [new RegExp(`^[A-Z_]+\\s+\\S+\\s+@\\s+${FILE_PAT}:L?\\d`, 'gm'), new RegExp(`^\\s+(?:in|out)\\s+[←→]\\s+\\S+\\s+[←→]\\s+(?!FILE\\s|MODULE\\s)[A-Z_]+\\s+\\S+\\s+@\\s+${FILE_PAT}:L?\\d`, 'gm')],
  // `  path: METHOD name:56, METHOD other:62`
  search_code: [new RegExp(`^\\s+${FILE_PAT}:\\s+[A-Z_]+\\s`, 'gm')],
};
export function primaryHitFiles(text: string, tool = 'explore'): string[] {
  const out = new Set<string>(); let m: RegExpExecArray | null;
  for (const re of [PRIMARY_HIT_RE, ...(ANSWER_RE[tool] ?? [])]) { re.lastIndex = 0; while ((m = re.exec(text || '')) !== null) out.add(m[1]!); }
  return [...out];
}

// ---- line re-resolve (neighbours / search_code answers from a changed file) ----
// The label alone did not stop the stale line numbers: measured 2026-10-15, after it shipped one of two Haiku runs still
// cited `hook.ts:335/517` (now 404/556) with a caveat, the other re-searched from scratch (7 calls, ~3x the cost). The
// names in those answers are right — only the lines moved — so the lines are re-read from THIS checkout's file: the
// declaration by name (the candidate nearest the indexed line), a call site as the k-th use of the subject inside its
// caller. An entry that cannot be found is left as it was and keeps the "may have moved" label.
function declLines(lines: string[], name: string): number[] {
  const n = escapeRe(name);
  const re = new RegExp(`(?:\\b(?:function|class|def|const|let|var|type|interface|enum|struct|trait|fn|func|module|impl)\\s+${n}\\b)`
    + `|(?:^|[\\s,{])${n}\\s*[=:]\\s*(?:async\\s*)?(?:function\\b|\\(|\\{|[A-Za-z_$][\\w$]*\\s*=>)`
    + `|^\\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)?\\s*(?:[:{]|$)`);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!) && !/^\s*(?:\/\/|\*|#)/.test(lines[i]!)) out.push(i + 1);
  return out;
}
function nearest(cands: number[], old: number): number | null {
  if (!cands.length) return null;
  return cands.reduce((a, b) => (Math.abs(b - old) < Math.abs(a - old) ? b : a));
}
/** Uses of `sym` (a call or a reference, not its own declaration) from line `from` on, bounded. */
function usesFrom(lines: string[], sym: string, from: number, span = 600): number[] {
  const re = new RegExp(`\\b${escapeRe(sym)}\\b`); const decl = new Set(declLines(lines, sym)); const out: number[] = [];
  // the caller ends at the first column-0 close after it (`}` / `};` / `end`), or at the next column-0 declaration
  let end = Math.min(lines.length, from + span);
  for (let i = from + 1; i <= end; i++) { const l = lines[i - 1]!; if (/^(?:\}|end\b)/.test(l)) { end = i; break; } if (i > from + 1 && /^(?:export\s|async\s|function\s|class\s|def\s|func\s|fn\s|pub\s)/.test(l)) { end = i - 1; break; } }
  for (let i = Math.max(1, from); i <= end; i++) if (!decl.has(i) && re.test(lines[i - 1]!) && !/^\s*(?:\/\/|\*|#)/.test(lines[i - 1]!)) out.push(i);
  return out;
}
export interface Reresolved { text: string; files: string[]; unresolved: string[] }
export function reresolveLines(tool: string, text: string, root: string, changed: Set<string>, subject: string | null): Reresolved {
  const none: Reresolved = { text, files: [], unresolved: [] };
  if (tool === 'explore') return reresolveExplore(text, root, changed);
  if (tool !== 'neighbours' && tool !== 'search_code') return none;
  const cache = new Map<string, string[] | null>();
  const fileLines = (rel: string): string[] | null => {
    if (!cache.has(rel)) { try { const p = path.join(root, rel); const st = fs.statSync(p); cache.set(rel, st.isFile() && st.size <= 1 << 20 ? fs.readFileSync(p, 'utf8').split('\n') : null); } catch { cache.set(rel, null); } }
    return cache.get(rel)!;
  };
  const fixed = new Set<string>(); const missed = new Set<string>();
  const bare = (n: string) => n.replace(/^.*[.:#]/, '');
  const declAt = (rel: string, name: string, old: number): number | null => {
    const lines = fileLines(rel); if (!lines) return null;
    return nearest(declLines(lines, bare(name)), old);
  };
  const sym = subject ? bare(subject) : null;
  const usesTaken = new Map<string, number>(); // `${file}#${caller}` -> call sites already handed out
  const seen = new Set<string>(); let heads = 0; let dropped = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null;
    if (tool === 'neighbours' && (m = /^([A-Z_]+\s+(\S+)\s+@\s+)(\S+?):L(\d+)(.*)$/.exec(line)) && changed.has(m[3]!)) {
      // headline: the subject's own declaration
      const d = declAt(m[3]!, m[2]!, Number(m[4])); if (d == null) { missed.add(m[3]!); out.push(line); continue; }
      fixed.add(m[3]!); const l = `${m[1]}${m[3]}:L${d}${m[5]}`; heads++; if (seen.has(l)) continue; seen.add(l); out.push(l); continue;
    }
    if (tool === 'neighbours' && (m = /^(\s+(?:in|out)\s+[←→].*?(?<!FILE)\s+[A-Z_]+\s+(\S+)\s+@\s+)(\S+?):L(\d+)(?: \(line (\d+)\))?(.*)$/.exec(line)) && changed.has(m[3]!) && !/←\s+(?:FILE|MODULE)\s|[←→]\s+(?:FILE|MODULE)\s+\S+\s+@/.test(line)) {
      const [, head, name, rel, oldDecl, oldSite, tail] = m as unknown as string[];
      const lines = fileLines(rel!); const d = lines ? nearest(declLines(lines, bare(name!)), Number(oldDecl)) : null;
      if (d == null || !lines) { missed.add(rel!); out.push(line); continue; }
      let site = '';
      if (oldSite != null && sym && /←\s*CALLS|→\s*CALLS|CALLS/.test(line) && /^\s+in\b/.test(line)) {
        const key = `${rel}#${name}#${d}`; const k = usesTaken.get(key) ?? 0; const uses = usesFrom(lines, sym, d);
        if (uses[k] == null) { if (k > 0) { dropped++; continue; } missed.add(rel!); out.push(line); continue; } // more relations than uses: a call site gone since the index
        usesTaken.set(key, k + 1); site = ` (line ${uses[k]})`;
      } else if (oldSite != null) site = ` (line ${oldSite})`;
      fixed.add(rel!); const l = `${head}${rel}:L${d}${site}${tail}`; if (seen.has(l)) continue; seen.add(l); out.push(l); continue;
    }
    if (tool === 'search_code' && (m = /^(\s+)(\S+?):\s+(.*)$/.exec(line)) && changed.has(m[2]!)) {
      const rel = m[2]!; let ok = true;
      const ents = Array.from(new Set(m[3]!.split(', ').map((e) => {
        const em = /^([A-Z_]+\s+)(.+):(\d+)$/.exec(e.trim()); if (!em) return e;
        const d = declAt(rel, em[2]!, Number(em[3])); if (d == null) { ok = false; return e; }
        return `${em[1]}${em[2]}:${d}`;
      })));
      (ok ? fixed : missed).add(rel); out.push(`${m[1]}${rel}: ${ents.join(', ')}`); continue;
    }
    out.push(line);
  }
  for (const f of missed) fixed.delete(f);
  if (!fixed.size) return { text, files: [], unresolved: [...missed] };
  let res = out;
  // two stale headlines that re-read to one declaration: the "share this name" union line no longer applies
  if (heads > 1 && res.filter((l) => /^[A-Z_]+\s+\S+\s+@\s+/.test(l)).length === 1) res = res.filter((l) => !/declarations share this name/.test(l));
  if (dropped) res = [...res, `(${dropped} relation(s) dropped: the call site is no longer in this checkout)`];
  return { text: res.join('\n'), files: [...fixed], unresolved: [...missed] };
}

/**
 * `explore` from a changed file: the `■` declaration line, its `--- source a-b ---` excerpt, its `callers:` and the
 * "other matches" rows. The excerpt is the worst of them — koragraph reads it from the checkout's CURRENT file at the
 * INDEXED range, so in a worktree it showed whatever code now sits there (measured 2026-10-15: `explore maxRedirects`
 * printed four unrelated lines of hook.ts as its source). The block is re-read at the re-resolved declaration, same
 * length; a block whose declaration cannot be found is left as it was (the "may have moved" label stays).
 */
export function reresolveExplore(text: string, root: string, changed: Set<string>): Reresolved {
  const cache = new Map<string, string[] | null>();
  const fileLines = (rel: string): string[] | null => {
    if (!cache.has(rel)) { try { const p = path.join(root, rel); const st = fs.statSync(p); cache.set(rel, st.isFile() && st.size <= 1 << 20 ? fs.readFileSync(p, 'utf8').split('\n') : null); } catch { cache.set(rel, null); } }
    return cache.get(rel)!;
  };
  const bare = (n: string) => n.replace(/^.*[.:#]/, '').replace(/\(.*$/, '');
  const declAt = (rel: string, name: string, old: number): number | null => { const l = fileLines(rel); return l ? nearest(declLines(l, bare(name)), old) : null; };
  const fixed = new Set<string>(); const missed = new Set<string>();
  const lines = text.split('\n'); const out: string[] = [];
  const seenHits = new Set<string>(); let skipBlock = false;
  let cur: { rel: string; name: string; d: number | null } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^(\s*■\s+[A-Z_]+\s+(\S+)\s+@\s+)(\S+?):(\d+)(.*)$/.exec(line))) {
      skipBlock = false; cur = null;
      if (!changed.has(m[3]!)) { out.push(line); continue; }
      const d = declAt(m[3]!, m[2]!, Number(m[4]));
      cur = { rel: m[3]!, name: m[2]!, d };
      if (d == null) { missed.add(m[3]!); out.push(line); continue; }
      fixed.add(m[3]!);
      const key = `${m[3]}:${d}`;
      if (seenHits.has(key)) { skipBlock = true; continue; } // a stale duplicate of a hit already shown
      seenHits.add(key); out.push(`${m[1]}${m[3]}:${d}${m[5]}`); continue;
    }
    if (/^other matches:/.test(line)) { skipBlock = false; cur = null; out.push(line); continue; }
    if (skipBlock) continue;
    if (cur && cur.d != null && (m = /^(\s*)--- source (\S+):(\d+)-(\d+) ---\s*$/.exec(line)) && m[2] === cur.rel) {
      const src = fileLines(cur.rel)!; const a = Number(m[3]); const b = Number(m[4]);
      // the shown body: up to the next ■ / source header / "other matches" / blank line before a ■
      let j = i + 1; const body: string[] = [];
      while (j < lines.length && !/^\s*■/.test(lines[j]!) && !/^\s*--- source /.test(lines[j]!) && !/^other matches:/.test(lines[j]!) && !/^\(worktree:/.test(lines[j]!)) { body.push(lines[j]!); j++; }
      while (body.length && body[body.length - 1]!.trim() === '') body.pop();
      const more = body.length && /^\s*… \d+ more lines — Read /.test(body[body.length - 1]!) ? body.pop()! : null;
      const shown = body.length; const span = b - a;
      const na = cur.d; const nb = Math.min(src.length, na + span);
      out.push(`${m[1]}--- source ${cur.rel}:${na}-${nb} ---`);
      out.push(...src.slice(na - 1, Math.min(nb, na - 1 + shown)));
      if (more) { const rest = nb - (na + shown) + 1; if (rest > 0) out.push(`${m[1]}  … ${rest} more lines — Read ${cur.rel} offset=${na + shown} limit=${rest} if you need the rest`); }
      out.push('');
      i = j - 1; continue;
    }
    if (cur && cur.d != null && (m = /^(\s*callers:\s*)(.*)$/.exec(line))) {
      const sym = bare(cur.name); const taken = new Map<string, number>();
      const ents = m[2]!.split(/,\s+/).map((e) => {
        const em = /^(\S+?)@(\S+?):(\d+)(?: \(call at :(\d+)\))?$/.exec(e.trim());
        if (!em || !changed.has(em[2]!)) return e;
        const l = fileLines(em[2]!); const d = l ? nearest(declLines(l, bare(em[1]!)), Number(em[3])) : null;
        if (d == null || !l) { missed.add(em[2]!); return e; }
        let site = '';
        if (em[4] != null) { const key = `${em[2]}#${d}`; const k = taken.get(key) ?? 0; const u = usesFrom(l, sym, d)[k]; if (u == null) { missed.add(em[2]!); return e; } taken.set(key, k + 1); site = ` (call at :${u})`; }
        fixed.add(em[2]!); return `${em[1]}@${em[2]}:${d}${site}`;
      });
      out.push(`${m[1]}${Array.from(new Set(ents)).join(', ')}`); continue;
    }
    if ((m = /^(\s+[A-Z_]+\s+(\S+)\s+@\s+)(\S+?):(\d+)(.*)$/.exec(line)) && changed.has(m[3]!)) {
      const d = declAt(m[3]!, m[2]!, Number(m[4]));
      if (d == null) { missed.add(m[3]!); out.push(line); continue; }
      fixed.add(m[3]!); const key = `${m[3]}:${d}`; if (seenHits.has(key)) continue; seenHits.add(key);
      out.push(`${m[1]}${m[3]}:${d}${m[5]}`); continue;
    }
    out.push(line);
  }
  for (const f of missed) fixed.delete(f);
  if (!fixed.size) return { text, files: [], unresolved: [...missed] };
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), files: [...fixed], unresolved: [...missed] };
}

export interface OverlayInput { name: string; args: Record<string, unknown>; text: string; root: string; div: Divergence; /** files whose lines reresolveLines re-read */ reresolved?: string[] }
/**
 * Pure: given a tool result and the checkout's divergence, return the honesty note(s) to append (or ''). Never
 * rewrites the result — only appends labels, so a correct base answer is never corrupted.
 */
export function overlayNotes(i: OverlayInput): string {
  const { name, args, text, root, div } = i;
  if (!div.changed.length) return '';
  const changed = new Set(div.changed);
  const notes: string[] = [];
  const rel = (f: string) => f.replace(/^\.\//, '');
  const sym = subjectSymbol(name, args);

  if (name === 'blast_radius') {
    // targets: files_changed[] and/or the symbol
    const files: string[] = Array.isArray(args.files_changed) ? (args.files_changed as unknown[]).map(String) : [];
    const hitFiles = files.map(rel).filter((f) => changed.has(f));
    const hasSubjectHit = /■|@\s+\S+:\d+|dependent/i.test(text);
    let symNote = '';
    if (sym) {
      const declFile = declaredInChanged(root, div.changed, sym);
      const inGraph = new RegExp(`\\b${escapeRe(sym.replace(/^.*[.:#]/, ''))}\\b`).test(text) && hasSubjectHit;
      if (declFile && !inGraph) symNote = `${sym} is NEW on this branch (declared in ${declFile}); the graph has no dependents for it yet — grep for callers to be sure.`;
      else if (declFile && changed.has(declFile)) symNote = `${sym} is defined in ${declFile}, which changed on this branch since the index — a caller added or removed since then may be missing; confirm the risky ones with grep.`;
    }
    if (hitFiles.length) notes.push(`the target file(s) ${hitFiles.join(', ')} changed on this branch since the index — dependents are computed from the last full index, so a call site added or removed since is not reflected; confirm with grep before trusting an all-clear.`);
    if (symNote) notes.push(symNote);
    if (!notes.length && (files.some((f) => changed.has(rel(f))) )) notes.push(`this branch has uncommitted changes; blast_radius is computed from the last full index.`);
    return notes.length ? '\n⚠ ' + notes.join('\n⚠ ') : '';
  }

  // explore / search_code / neighbours / file_symbols: label when the PRIMARY hit (the looked-up declaration) or
  // the subject file itself is in a changed file — not merely referenced files, which would be noisy.
  const pathArg = typeof args.path === 'string' ? rel(args.path) : null;
  const primary = primaryHitFiles(text, name).map(rel).filter((f) => changed.has(f));
  const hitFiles = [...new Set([...primary, ...(pathArg && changed.has(pathArg) ? [pathArg] : [])])];
  const reread = new Set(i.reresolved ?? []);
  const moved = hitFiles.filter((f) => !reread.has(f)); const fresh = hitFiles.filter((f) => reread.has(f));
  if (fresh.length) notes.push(`line numbers in ${fresh.slice(0, 5).join(', ')}${fresh.length > 5 ? `, +${fresh.length - 5} more` : ''} were re-read from this checkout (the index predates this branch's edits there; a call site added since may be missing).`);
  if (moved.length) notes.push(`${moved.slice(0, 5).join(', ')}${moved.length > 5 ? `, +${moved.length - 5} more` : ''} changed on this branch since the index — line numbers and signatures may have moved; open the file to confirm.`);
  const resultFiles = hitFiles;
  if (sym && !resultFiles.length) {
    const declFile = declaredInChanged(root, div.changed, sym);
    const inGraph = /■|@\s+\S+:\d+/.test(text);
    if (declFile && !inGraph) notes.push(`${sym} is NEW on this branch (in ${declFile}) — the index predates it; grep or open ${declFile}.`);
  }
  return notes.length ? '\n(worktree: ' + notes.join(' ') + ')' : '';
}

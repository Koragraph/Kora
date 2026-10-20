// Fuzzy symbol finding for VAGUE prompts (RESEARCH.md round 4). A prompt with no code identifier ("how does the
// server decide which repo a tool call is scoped to?") used to go to the graph as two content words, and the graph's
// lexical channel ranked a stranger first. Symbol names are made of words: split every declaration name in the repo
// into parts (camelCase / snake_case), match the prompt's content words against those parts by exact / stem /
// prefix / bigram similarity, and ask the graph about the best-scoring symbols BY NAME — which it resolves exactly.
// The name list is read once per graph generation from the store and cached as JSON; scoring a 50k-symbol repo is a
// few tens of milliseconds, well inside the hook's budget.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { identifierParts } from './prompt-inject';

export interface SymbolEntry { name: string; parts: string[] }
export interface FuzzyHit { name: string; score: number; matched: string[]; /** matched words that are exact/stem matches (≥ .9) on non-generic words — the evidence a multi-hop prompt needs */ strong: string[] }

const SYMBOL_TYPES = ['METHOD', 'FUNCTION', 'CLASS', 'FIELD', 'CONSTANT', 'INTERFACE', 'TYPE', 'ENUM', 'STRUCT'];
// Words that carry no symbol signal even when long enough. (Kept small on purpose: "repository", "value", "server"
// DO match symbol parts and are the whole point.)
const FUZZY_STOP = new Set(['about', 'after', 'again', 'also', 'before', 'being', 'between', 'could', 'decide', 'decides', 'does', 'each', 'every', 'explain', 'file', 'files', 'first', 'from', 'functions', 'function', 'going', 'happen', 'happens', 'have', 'having', 'here', 'inside', 'into', 'involved', 'itself', 'just', 'like', 'line', 'lines', 'might', 'more', 'most', 'need', 'only', 'other', 'please', 'should', 'show', 'since', 'some', 'still', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'thing', 'things', 'think', 'this', 'those', 'through', 'under', 'until', 'using', 'walk', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'words', 'would', 'write', 'your', 'work', 'works', 'working', 'worked', 'briefly', 'anyway', 'roughly', 'directly', 'please', 'code', 'cite', 'summary', 'summarise', 'summarize', 'concise', 'complete', 'exactly', 'minimal', 'today', 'shape', 'change', 'changes', 'changed', 'edit', 'return', 'returns', 'field', 'fields']);

/** Crude English stem: plural / -ing / -ed / -ies, never below 4 chars. */
export function stem(w: string): string {
  const s = w.toLowerCase();
  if (s.length > 5 && s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.length >= 7 && s.endsWith('ing')) return s.slice(0, -3);
  if (s.length >= 6 && s.endsWith('ed')) return s.slice(0, -2);
  if (s.length >= 6 && s.endsWith('es') && /(s|x|z|ch|sh)es$/.test(s)) return s.slice(0, -2); // boxes, matches — not values
  if (s.length >= 5 && s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}
export function bigrams(s: string): string[] { const out: string[] = []; for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2)); return out; }
export function dice(a: string, b: string): number {
  if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a); const B = new Map<string, number>(); for (const g of bigrams(b)) B.set(g, (B.get(g) || 0) + 1);
  let hit = 0; for (const g of A) { const n = B.get(g) || 0; if (n) { hit++; B.set(g, n - 1); } }
  return (2 * hit) / (A.length + b.length - 1);
}
/** How well one prompt word matches one name part: 1 exact, .9 same stem, .85 prefix (≥4), else bigram Dice ≥ .55. */
export function wordSim(word: string, part: string): number {
  const w = word.toLowerCase(), p = part.toLowerCase();
  if (w === p) return 1;
  if (stem(w) === stem(p)) return 0.9;              // values / value, calls / call
  if (Math.min(w.length, p.length) >= 4 && (w.startsWith(p) || p.startsWith(w))) return 0.85; // repository / repo, scoped / scope
  if (Math.min(w.length, p.length) < 5) return 0;   // tool / pool: one letter apart is not a match
  const d = dice(w, p); return d >= 0.7 ? d : 0;
}
/** Does one symbol name explain the prompt's words (fuzzyFind's own qualification rule)? */
export function symbolQualifies(name: string, words: string[]): boolean {
  return fuzzyFind(words, [{ name, parts: identifierParts(name) }], 1).length > 0;
}
/** Prompt → the content words worth matching (≥4 chars, or a 3-letter acronym in caps; stop words out). */
export function fuzzyWords(prompt: string): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of (prompt || '').split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const ok = raw.length >= 4 || (raw.length === 3 && raw === raw.toUpperCase());
    const w = raw.toLowerCase(); if (!ok || FUZZY_STOP.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}
/**
 * Rank symbols by how many prompt words their name parts explain. A symbol needs two matched words, or one
 * near-exact (≥ .9) match on a long (≥ 7) word, so a single common word like "value" cannot pick a winner.
 */
// Words that appear in half the symbols of any repo: matching them is not evidence that THIS symbol is the one the
// prompt is about. Measured on 48 real prompts (scripts/inject-replay.js, meridian): "What test runner does this
// project use?" resolved to test_project_id_mismatch_… on `test` + `project`; "check how logging works" to
// checkPathPolicy on `check`. A hit must be carried by at least one non-generic word.
export const GENERIC_WORDS = new Set(['tool', 'tools', 'call', 'calls', 'test', 'tests', 'testing', 'project', 'projects', 'config', 'server', 'client', 'user', 'users', 'data', 'name', 'names', 'value', 'values', 'type', 'types', 'item', 'items', 'main', 'index', 'app', 'api', 'service', 'services', 'error', 'errors', 'result', 'results', 'request', 'response', 'module', 'util', 'utils', 'helper', 'helpers', 'base', 'default', 'check', 'checks', 'load', 'save', 'read', 'write', 'start', 'stop', 'init', 'setup', 'path', 'paths', 'list', 'lists', 'handle', 'handler', 'handlers', 'create', 'update', 'delete', 'remove', 'process', 'make', 'build', 'state', 'status', 'info', 'message', 'messages', 'options', 'option', 'params', 'args', 'input', 'output', 'root', 'node', 'nodes', 'context', 'time', 'date', 'count', 'total', 'size', 'number', 'string', 'object', 'array', 'entry', 'entries', 'point', 'source', 'target', 'current', 'next', 'last', 'first', 'work', 'works', 'working', 'code', 'system', 'runner', 'task', 'tasks', 'job', 'jobs', 'event', 'events', 'model', 'view', 'page', 'pages', 'form', 'table', 'field', 'record', 'records', 'find', 'filter', 'sort', 'parse', 'format', 'render', 'display', 'send', 'receive', 'open', 'close', 'connect', 'resolve', 'apply', 'applied', 'response', 'summary', 'brief', 'briefly', 'explain', 'describe', 'trace', 'important', 'anyway', 'directly', 'roughly', 'meridian', 'kora', 'koragraph']);
export function fuzzyFind(words: string[], symbols: SymbolEntry[], limit = 3): FuzzyHit[] {
  if (!words.length) return [];
  const hits: FuzzyHit[] = [];
  // This runs on the daemon's event loop for every vague / edit-shaped prompt. Name parts repeat across thousands of symbols
  // (a repo has a few thousand distinct parts, not 4 per symbol), so each (word, part) similarity is computed once per call:
  // 60k symbols took 250-390 ms before, a fraction of that after. Same results.
  const memo: Map<string, number>[] = words.map(() => new Map<string, number>());
  const generic = words.map((w) => GENERIC_WORDS.has(w.toLowerCase()) || GENERIC_WORDS.has(stem(w)));
  const genericRaw = words.map((w) => GENERIC_WORDS.has(w.toLowerCase()));
  for (const s of symbols) {
    if (!s.parts.length) continue;
    let score = 0; const matched: string[] = []; const strong: string[] = [];
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]!; const m = memo[wi]!;
      let best = 0;
      for (const p of s.parts) {
        let v = m.get(p);
        if (v === undefined) { v = wordSim(w, p); m.set(p, v); }
        if (v > best) best = v;
      }
      if (best >= 0.9 && !genericRaw[wi] && !GENERIC_WORDS.has(stem(w))) strong.push(w);
      // A generic word is half a vote: "user" + "authenticates" must not outrank "authenticate" (measured, meridian:
      // revokeMcpOAuthTokensForUser 2.1 vs authenticate 1.4 before this weighting and the coverage change below).
      if (best > 0) { score += generic[wi] ? best * 0.5 : best; matched.push(w); }
    }
    if (!matched.length) continue;
    // Generic-only evidence is not evidence — unless the generic words together explain the WHOLE name (`callTool`
    // for "tool call": two generic words, full coverage, exactly the symbol the prompt is about).
    const genericOnly = !matched.some((w) => !GENERIC_WORDS.has(w.toLowerCase()) && !GENERIC_WORDS.has(stem(w)));
    if (genericOnly && !(matched.length >= 2 && matched.length >= s.parts.length)) continue;
    // One word carries a longer name only when it matches a part exactly (staleness → graphStaleness); a stem match
    // carries only a one-part name (authenticates → authenticate). "where is the worker state confirmed" picked
    // ConfirmCard on confirmed ≈ confirm (2026-10-20).
    const strongSingle = matched.length === 1 && matched[0].length >= 7 && (score >= 1 || (score >= 0.9 && s.parts.length === 1));
    if (matched.length < 2 && !strongSingle) continue;
    score += 1.0 * (matched.length / s.parts.length); // coverage: a name fully explained by the prompt beats a long one partly matched
    hits.push({ name: s.name, score: Math.round(score * 1000) / 1000, matched, strong });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  // de-duplicate names (overloads / same name in several files)
  const out: FuzzyHit[] = []; const seen = new Set<string>();
  for (const h of hits) { if (seen.has(h.name)) continue; seen.add(h.name); out.push(h); if (out.length >= limit) break; }
  return out;
}

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
/** The tracked branch row of the repo whose checkout is `root` (by full path, then by folder name), or null. Shared by the symbol indexes. */
export function repoBranchId(db: { prepare(sql: string): { get(...a: unknown[]): unknown } }, root: string): number | null {
  let real = root; try { real = fs.realpathSync(root); } catch { /* keep */ }
  const row = (db.prepare(`SELECT rb.id FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id WHERE r.full_path IN (?, ?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(root, real)
    || db.prepare(`SELECT rb.id FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id WHERE lower(r.name) = lower(?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(path.basename(root))) as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Every declaration name of the repo containing `root`, with parts, from the graph store (read-only) — cached as
 * JSON per graph generation under ~/.kora/cache. Empty when the store has no row for this repo.
 */
export function symbolIndex(root: string, generation: string, opts: { dbPath?: string; home?: string } = {}): SymbolEntry[] {
  const { koraHome, graphDbPath } = require('./embedded');
  const home = opts.home || koraHome();
  const cacheFile = path.join(home, 'cache', `symbols-${sha(root)}.json`);
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c && c.generation === generation && Array.isArray(c.symbols)) return c.symbols; } catch { /* rebuild */ }
  let symbols: SymbolEntry[] = [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(opts.dbPath || graphDbPath(), { readonly: true, fileMustExist: true });
    try {
      db.pragma('busy_timeout = 200');
      const bid = repoBranchId(db, root);
      if (bid != null) {
        const names = db.prepare(`SELECT DISTINCT name FROM nodes WHERE repository_branch_id = ? AND approval_status != 'ARCHIVED' AND node_type IN (${SYMBOL_TYPES.map(() => '?').join(',')})`).all(bid, ...SYMBOL_TYPES) as { name: string }[];
        symbols = names.map((n) => ({ name: n.name, parts: identifierParts(n.name) })).filter((s) => s.parts.length && /^[A-Za-z_$][\w$.]*$/.test(s.name));
      }
    } finally { db.close(); }
  } catch { symbols = []; }
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ generation, symbols })); } catch { /* best effort */ }
  return symbols;
}

/** The fuzzy candidates for a prompt in a repo (empty when nothing matches with confidence). */
export function fuzzyForPrompt(prompt: string, root: string, generation: string, opts: { dbPath?: string; home?: string } = {}): FuzzyHit[] {
  const words = fuzzyWords(prompt); if (words.length < 1) return [];
  return fuzzyFind(words, symbolIndex(root, generation, opts));
}

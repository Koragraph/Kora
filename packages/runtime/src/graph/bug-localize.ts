// Bug-report localization (SAV-B, 2026-10-15). A bug described in plain English with no identifier — "the retry count is
// off by one somewhere in the http client", "why is the export slow?" — is the largest class of prompt the per-prompt
// injection skips and, measured, the costliest turn (an agent walks the repo with grep and Read to find where the thing
// lives). Agentless / AutoCodeRover / LocAgent: a localize step that hands the agent the likely locations cuts cost per
// SOLVED task. This module is that step, kept to the injection's budget (<= 3 declarations, one short "why" each).
//
// What bug prose needs that fuzzy.ts does not have:
//   - symptom words ("wrong", "off by one", "slow", "crash") are not search terms: they are dropped, the NOUNS are searched;
//   - a symbol can be explained by its NAME, its FILE PATH ("http client" -> http/client.ts) or its DOC COMMENT (the graph's
//     RATIONALE nodes), and a word that matches few symbols is worth more than one that matches many (rarity weight);
//   - precision over recall: nothing is returned unless the top candidate is clearly ahead of every candidate in another file.
// Scoring reuses fuzzy.ts (wordSim / stem / GENERIC_WORDS). Read-only, one cached name index per graph generation, a few
// ms to score; runs in the graph worker thread when the service has one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { wordSim, stem, GENERIC_WORDS, repoBranchId } from './fuzzy';
import { identifierParts, TEXT_HUNT_RE, STATEMENT_RE, STATEMENT_ANYWHERE_RE } from './prompt-inject';

export const BUG_INJECT_TRAILER = '(graph-ranked guess at where this behaviour lives, matched on your words, not verified: Read the range of the first candidate before searching; if it is not there, say so and search)';

// ---------- is this prompt a bug report? ----------
// STRONG cues name a symptom by themselves. WEAK cues ("should", "but") only count beside a situational cue, and
// feature-shaped uses of "should" ("should also log", "should support") never count.
const STRONG_CUE_RE = /\b(wrong(?:ly)?|incorrect(?:ly)?|off[- ]by[- ](?:one|1)|off by (?:one|1)|doesn'?t|does not|don'?t|didn'?t|won'?t|can'?t|cannot|isn'?t|aren'?t|wasn'?t|is not (?:working|right|correct|being|applied|updated|saved)|not working|broken|bug(?:gy)?|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?|throws?|blows? up|slow(?:er|ly)?|painfully|takes? (?:forever|ages|so long|too long)|too (?:slow|many|few|much|little|high|low|big|small|long|short|early|late)|instead of|regression|no longer|never (?:fires?|triggers?|runs?|applies|applied|updates?|shows?|returns?|ends?|stops?|works?)|stuck|hangs?|freez(?:es|ing)|missing|skips?|skipped|ignores?|ignored|twice|double[- ]counts?|duplicat(?:e|es|ed)|negative|unexpected(?:ly)?|weird(?:ly)?|strange(?:ly)?|mismatch(?:es)?|comes? out|comes? back|gets? charged|undercharg\w*|overcharg\w*|miscalculat\w*|rolls? over|drops?|loses?|lost|keeps? (?:\\w+ing|showing|asking|firing|coming)|even though|never the rest|only (?:returns?|shows?|reads?|gets?|works?|applies|applied)|reused|up to date but|(?:less|more|higher|lower|bigger|smaller|longer|shorter|cheaper) than (?:it|they|we|i) (?:should|expect\w*|thought)|than (?:it|they) should|one (?:too (?:many|few)|short|extra|more|less))\b/i;
const WEAK_CUE_RE = /\b(should(?:n'?t)?|expected|actually|but|except|yet|only|exactly)\b/i;
const SITUATIONAL_RE = /\b(when|if|after|before|with|exactly|even|once|every|only|at|over|under|above|below)\b/i;
const FEATURE_SHOULD_RE = /\bshould (?:also|be able to|support|allow|include|have|offer|expose|log|show|display|let|use|go|live|move|become|be (?:moved|renamed|split|extracted|removed|refactored))\b/i;
const META_ASK_RE = /^\s*(?:how (?:do|should|can|would) (?:i|we)|what(?:'s| is) the best way|is it (?:ok|okay|fine|better)|should (?:i|we)\b)/i;

export function bugProseQualifies(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (!p || p.length > 400 || p.startsWith('/')) return false;
  if (TEXT_HUNT_RE.test(p) || STATEMENT_RE.test(p) || STATEMENT_ANYWHERE_RE.test(p) || META_ASK_RE.test(p)) return false;
  if (p.split(/\s+/).filter(Boolean).length < 4) return false;
  if (STRONG_CUE_RE.test(p)) return true;
  if (FEATURE_SHOULD_RE.test(p)) return false;
  return WEAK_CUE_RE.test(p) && SITUATIONAL_RE.test(p) && /\b(should|expected|instead)\b/i.test(p);
}

// Words that describe the SYMPTOM or the speaker, never the code. (fuzzyWords already drops short words and its own stop list.)
const SYMPTOM_WORDS = new Set([
  'wrong', 'wrongly', 'incorrect', 'incorrectly', 'broken', 'bug', 'buggy', 'fail', 'fails', 'failed', 'failing', 'failure', 'crash', 'crashes', 'crashed', 'crashing',
  'throws', 'throw', 'slow', 'slower', 'slowly', 'painfully', 'forever', 'long', 'ages', 'instead', 'regression', 'never', 'always', 'still', 'stuck', 'hangs', 'hang', 'freezes',
  'missing', 'skips', 'skipped', 'ignores', 'ignored', 'twice', 'double', 'duplicate', 'duplicates', 'duplicated', 'negative', 'unexpected', 'unexpectedly', 'weird', 'weirdly',
  'strange', 'strangely', 'mismatch', 'comes', 'come', 'back', 'gets', 'getting', 'got', 'goes', 'going', 'seems', 'seem', 'looks', 'look', 'somewhere', 'somehow', 'something',
  'expected', 'actually', 'except', 'exactly', 'thing', 'things', 'fix', 'fixing', 'fixed', 'find', 'found', 'figure', 'issue', 'issues', 'problem', 'problems', 'broke', 'break',
  'breaks', 'noticed', 'happens', 'happening', 'happened', 'every', 'time', 'times', 'turns', 'turn', 'ends', 'result', 'results', 'right', 'correct', 'sure', 'tried', 'trying',
  'after', 'before', 'because', 'cause', 'caused', 'causes', 'reason', 'whole', 'really', 'very', 'much', 'many', 'enough', 'also', 'even', 'while', 'once', 'when', 'once',
  'make', 'makes', 'made', 'take', 'takes', 'taking', 'took', 'give', 'gives', 'gave', 'show', 'shows', 'shown', 'said', 'says', 'tell', 'tells', 'told', 'users', 'user', 'customer',
  'customers', 'someone', 'anyone', 'people', 'report', 'reports', 'reported', 'complaint', 'complaints', 'charged', 'ordering', 'ordered', 'around', 'ahead', 'next', 'previous',
  'under', 'over', 'above', 'below', 'between', 'inside', 'outside', 'without', 'within', 'than', 'then', 'them', 'they', 'what', 'when', 'where', 'which', 'would', 'could', 'should',
]);
// The sentence minus symptom talk: the words that name the code.
export function bugNouns(prompt: string): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of (prompt || '').split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const w = raw.toLowerCase();
    const ok = w.length >= 4 || (w.length === 3 && raw === raw.toUpperCase() && !/^\d+$/.test(w));
    if (!ok || /^\d+$/.test(w) || seen.has(w) || SYMPTOM_WORDS.has(w) || NOUN_STOP.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out.slice(0, 10);
}
const NOUN_STOP = new Set(['about', 'again', 'been', 'being', 'both', 'could', 'does', 'doesn', 'each', 'from', 'have', 'here', 'into', 'just', 'like', 'more', 'most', 'need', 'only', 'other', 'please', 'same', 'some', 'such', 'than', 'that', 'their', 'there', 'these', 'this', 'those', 'through', 'want', 'were', 'will', 'with', 'your', 'code', 'file', 'files', 'function', 'functions', 'line', 'lines', 'repo', 'project']);

// "...somewhere in the http client": the words after in/inside/within are WHERE to look (a scope), not WHAT is wrong.
// They may raise declarations that live in a matching file but must not make the scope itself (class HttpClient) the answer.
export function bugScopeWords(prompt: string): Set<string> {
  const out = new Set<string>();
  for (const m of (prompt || '').toLowerCase().matchAll(/\b(?:in|inside|within|under)\s+(?:the|our|my|this|that|a)\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){0,2})/g)) {
    for (const w of m[1]!.split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w);
  }
  return out;
}

// ---------- the index ----------
export interface BugSymbol { id: number; name: string; type: string; path: string; line: number; doc: string; /** lines the declaration spans: a tie goes to the bigger body */ span?: number }
interface Indexed extends BugSymbol { parts: string[]; pathParts: string[]; docStems: Set<string>; isTest: boolean }
const CODE_TYPES = ['METHOD', 'FUNCTION', 'CLASS', 'CONSTANT'];
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const SKIP_DIRS = new Set(['src', 'lib', 'libs', 'app', 'apps', 'packages', 'pkg', 'index', 'main', 'mod', 'init', 'test', 'tests', 'spec', 'specs', 'source']);

// The parsed index of the last few (repo, generation) pairs stays in memory: parsing a 7 MB JSON for a 200k-node repo took ~0.4 s per prompt.
const INDEX_MEM = new Map<string, BugSymbol[]>();
export function bugIndex(root: string, generation: string, opts: { dbPath?: string; home?: string } = {}): BugSymbol[] {
  const key = `${root}\0${generation}\0${opts.dbPath ?? ''}`;
  const hit = INDEX_MEM.get(key); if (hit) return hit;
  const built = bugIndexUncached(root, generation, opts);
  if (built.length) { for (const k of INDEX_MEM.keys()) if (k.startsWith(root + '\0')) INDEX_MEM.delete(k); INDEX_MEM.set(key, built); while (INDEX_MEM.size > 4) INDEX_MEM.delete(INDEX_MEM.keys().next().value!); }
  return built;
}
function bugIndexUncached(root: string, generation: string, opts: { dbPath?: string; home?: string } = {}): BugSymbol[] {
  const { koraHome, graphDbPath } = require('./embedded');
  const home = opts.home || koraHome();
  const cacheFile = path.join(home, 'cache', `bugsyms-${sha(root)}.json`);
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c && c.generation === generation && Array.isArray(c.symbols)) return c.symbols; } catch { /* rebuild */ }
  let symbols: BugSymbol[] = [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(opts.dbPath || graphDbPath(), { readonly: true, fileMustExist: true });
    try {
      db.pragma('busy_timeout = 200');
      const bid = repoBranchId(db, root);
      if (bid != null) {
        const rows = db.prepare(`SELECT n.id, n.name, n.node_type AS type, f.path AS path, COALESCE(n.start_line, 0) AS line, MAX(0, COALESCE(n.end_line, 0) - COALESCE(n.start_line, 0)) AS span FROM nodes n JOIN files f ON f.id = n.file_id WHERE +n.repository_branch_id = ? AND n.approval_status != 'ARCHIVED' AND n.node_type IN (${CODE_TYPES.map(() => '?').join(',')})`).all(bid, ...CODE_TYPES) as Omit<BugSymbol, 'doc'>[];
        // The doc comment / docstring of a declaration is a RATIONALE node pointing at it with a REFERENCES edge; its name reads "<symbol> — <text>".
        const docs = new Map<number, string>();
        try {
          for (const d of db.prepare(`SELECT e.to_node_id AS tid, a.name AS text FROM edges e JOIN nodes a ON a.id = e.from_node_id WHERE e.edge_type = 'REFERENCES' AND a.node_type = 'RATIONALE' AND +a.repository_branch_id = ?`).all(bid) as { tid: number; text: string }[]) {
            const t = d.text.includes(' — ') ? d.text.slice(d.text.indexOf(' — ') + 3) : d.text;
            docs.set(d.tid, ((docs.get(d.tid) || '') + ' ' + t).trim().slice(0, 240));
          }
        } catch { /* docs are a bonus channel */ }
        symbols = rows.filter((r) => /^[A-Za-z_$][\w$.]*$/.test(r.name)).map((r) => ({ ...r, doc: docs.get(r.id) || '' }));
      }
    } finally { db.close(); }
  } catch { symbols = []; }
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ generation, symbols })); } catch { /* best effort */ }
  return symbols;
}

const PREPARED = new WeakMap<BugSymbol[], Indexed[]>();
function prepare(symbols: BugSymbol[]): Indexed[] {
  const hit = PREPARED.get(symbols); if (hit) return hit;
  const out = prepareUncached(symbols); PREPARED.set(symbols, out); return out;
}
function prepareUncached(symbols: BugSymbol[]): Indexed[] {
  return symbols.map((s) => {
    const segs = s.path.replace(/\.[A-Za-z0-9]+$/, '').split('/').filter((x) => x && !SKIP_DIRS.has(x.toLowerCase()));
    const pathParts = Array.from(new Set(segs.flatMap((x) => x.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map((p) => p.toLowerCase()).filter((p) => p.length >= 3))));
    const docStems = new Set((s.doc || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map(stem));
    const isTest = /(^|\/)(tests?|specs?|__tests__)\//i.test(s.path) || /\.(test|spec)\.[a-z]+$/i.test(s.path) || /^test_|^Test[A-Z]/.test(s.name);
    return { ...s, parts: identifierParts(s.name), pathParts, docStems, isTest };
  });
}

// ---------- scoring ----------
// retried / retries / retry: fuzzy.ts' crude stem leaves "retried" -> "retri". Fold -ied to -y before comparing.
const fold = (w: string): string => w.replace(/ied$/, 'y').replace(/ier$/, 'y');
const sim = (w: string, part: string): number => { const a = wordSim(w, part); if (a >= 0.9) return a; const fw = fold(w), fp = fold(part); return fw === w && fp === part ? a : Math.max(a, wordSim(fw, fp)); };
export interface BugCandidate { id?: number; span?: number; name: string; type: string; file: string; line: number; score: number; matched: string[]; channels: string[]; why: string; sig?: string; calls?: string[]; calledBy?: string[] }
export interface BugVerdict {
  status: 'lead' | 'unclear' | 'none';
  /** why it is not a lead, for telemetry */
  note?: string;
  nouns: string[];
  candidates: BugCandidate[];
  ms: number;
}
export const LEAD_MIN_SCORE = 1.5;
/** top candidate must beat the best candidate in ANOTHER file by this factor */
export const LEAD_MARGIN = 1.3;
const TYPE_PRIOR: Record<string, number> = { METHOD: 1, FUNCTION: 1, CLASS: 0.8, CONSTANT: 0.6 };

export function scoreBug(nouns: string[], symbols: BugSymbol[], opts: { includeTests?: boolean; scope?: Set<string> } = {}): BugCandidate[] {
  if (!nouns.length) return [];
  const idx = prepare(symbols).filter((s) => opts.includeTests || !s.isTest);
  const scopeW = nouns.map((w) => !!opts.scope?.has(w));
  const gen = nouns.map((w) => GENERIC_WORDS.has(w) || GENERIC_WORDS.has(stem(w)));
  // pass 1: per symbol, per word, the three channel similarities; and per word, how many symbols it explains (rarity)
  // a repo has a few thousand distinct name parts, not four per symbol: each (word, part) similarity is computed once
  const memo = nouns.map(() => new Map<string, number>());
  const simMemo = (wi: number, part: string): number => { const m = memo[wi]!; let v = m.get(part); if (v === undefined) { v = sim(nouns[wi]!, part); m.set(part, v); } return v; };
  const wStem = nouns.map((w) => stem(w)); const wStemFold = nouns.map((w) => stem(fold(w)));
  const sims = idx.map((s) => nouns.map((_, wi) => {
    let n = 0, p = 0, d = 0;
    for (const part of s.parts) { const v = simMemo(wi, part); if (v > n) n = v; }
    for (const part of s.pathParts) { const v = simMemo(wi, part); if (v > p) p = v; }
    if (s.docStems.has(wStem[wi]!) || s.docStems.has(wStemFold[wi]!)) d = 1;
    return [n, p, d] as const;
  }));
  // rarity: a word that explains a handful of declarations is a signal; one that explains a fifth of the repo is a topic.
  // Name/doc matches count declarations; a path match counts FILES (every declaration of one file shares its path).
  const dfName = nouns.map((_, wi) => { let c = 0; for (const row of sims) { const [n, , d] = row[wi]!; if (n >= 0.85 || d) c++; } return c; });
  const dfFile = nouns.map((_, wi) => { const files = new Set<string>(); idx.forEach((s, si) => { if (sims[si]![wi]![1] >= 0.85) files.add(s.path); }); return files.size; });
  const rar = (c: number): number => (c <= 1 ? 1 : Math.max(0.35, 1 / (1 + 0.28 * (c - 1))));
  const rarity = dfName.map(rar); const rarityFile = dfFile.map(rar);
  const out: BugCandidate[] = [];
  idx.forEach((s, si) => {
    let score = 0; const matched: string[] = []; const chans = new Set<string>(); let nameHits = 0; let strongName = false;
    for (let wi = 0; wi < nouns.length; wi++) {
      const [n, p, d] = sims[si]![wi]!;
      // a scope word names where to look: it counts through the file, hardly through a declaration's own name
      let ev = n * rarity[wi]! * (scopeW[wi] ? 0.3 : 1) + 0.4 * p * rarityFile[wi]! + 0.3 * d * rarity[wi]!;
      if (ev > 1.3) ev = 1.3;
      if (n < 0.5 && p < 0.85 && !d) continue; // a path or doc hit needs to be a real one
      if (n >= 0.5) { nameHits++; chans.add('name'); if (n >= 0.9 && nouns[wi]!.length >= 5 && !gen[wi]) strongName = true; }
      if (p >= 0.85) chans.add('file'); if (d) chans.add('doc');
      matched.push(nouns[wi]!);
      score += ev * (gen[wi] ? 0.5 : 1);
    }
    if (!matched.length) return;
    if (matched.every((w) => opts.scope?.has(w))) return; // only the scope matched: that is the file, not the bug
    const genericOnly = matched.every((w) => GENERIC_WORDS.has(w) || GENERIC_WORDS.has(stem(w)));
    if (genericOnly) return;
    if (matched.length < 2 && !(strongName && dfName[nouns.indexOf(matched[0]!)]! <= 3)) return;
    if (s.parts.length) score += 0.6 * (nameHits / s.parts.length); // a name the prompt fully explains beats a long one partly matched
    score *= TYPE_PRIOR[s.type] ?? 0.8;
    out.push({ id: s.id, span: s.span ?? 0, name: s.name, type: s.type, file: s.path, line: s.line, score: Math.round(score * 1000) / 1000, matched, channels: Array.from(chans), why: '' });
  });
  out.sort((a, b) => b.score - a.score || (b.span ?? 0) - (a.span ?? 0) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  const seen = new Set<string>(); const dedup: BugCandidate[] = [];
  for (const c of out) { const k = `${c.name}@${c.file}`; if (seen.has(k)) continue; seen.add(k); dedup.push(c); if (dedup.length >= 12) break; }
  return dedup;
}

// ---------- graph neighbours (calls / called-by), for the few candidates that matter ----------
interface Nb { calls: { id: number; name: string }[]; calledBy: { id: number; name: string }[] }
class Neighbours {
  private db: any = null; private callees: any; private callers: any; private sig: any;
  readonly ok: boolean;
  constructor(root: string, dbPath?: string) {
    try {
      const Database = require('better-sqlite3');
      const { graphDbPath } = require('./embedded');
      this.db = new Database(dbPath || graphDbPath(), { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 200');
      this.callees = this.db.prepare(`SELECT DISTINCT b.id AS id, b.name AS name FROM edges e JOIN nodes b ON b.id = e.to_node_id WHERE e.from_node_id = ? AND e.edge_type IN ('CALLS','HEURISTIC_CALLS') AND b.node_type IN ('METHOD','FUNCTION','CLASS') LIMIT 12`);
      this.callers = this.db.prepare(`SELECT DISTINCT a.id AS id, a.name AS name, f.path AS path FROM edges e JOIN nodes a ON a.id = e.from_node_id JOIN files f ON f.id = a.file_id WHERE e.to_node_id = ? AND e.edge_type IN ('CALLS','HEURISTIC_CALLS') AND a.node_type IN ('METHOD','FUNCTION') LIMIT 16`);
      this.sig = this.db.prepare('SELECT summary FROM nodes WHERE id = ?');
      this.ok = true;
    } catch { this.ok = false; this.close(); }
  }
  of(id: number | undefined, self: string): Nb {
    if (!this.ok || id == null) return { calls: [], calledBy: [] };
    try {
      return {
        calls: (this.callees.all(id) as { id: number; name: string }[]).filter((x) => x.name !== self),
        calledBy: (this.callers.all(id) as { id: number; name: string; path: string }[]).filter((x) => x.name !== self && !/(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\./i.test(x.path)),
      };
    } catch { return { calls: [], calledBy: [] }; }
  }
  signature(id: number | undefined): string | undefined {
    if (!this.ok || id == null) return undefined;
    try { const r = this.sig.get(id) as { summary?: string } | undefined; return r?.summary ? String(r.summary).split('\n')[0]!.slice(0, 110) : undefined; } catch { return undefined; }
  }
  close(): void { try { this.db?.close(); } catch { /* fine */ } this.db = null; }
}

/**
 * Decide whether the ranking has a clear leader, and pick what to show (<= 3). A candidate that merely sits in another file
 * is a coin flip against the top — unless the graph says they are one feature (one calls the other), in which case both are
 * shown. A second or third candidate must either be explained by two of the prompt's words or be a direct caller / callee
 * of the top (a bug is often one hop from the name that matches).
 */
export function decide(cands: BugCandidate[], nb: (c: BugCandidate) => Nb, focused = false): { status: BugVerdict['status']; note?: string; show: BugCandidate[]; topNb?: Nb } {
  if (!cands.length) return { status: 'none', note: 'no-candidates', show: [] };
  const top = cands[0]!;
  if (top.score < LEAD_MIN_SCORE) return { status: 'unclear', note: 'weak-top', show: [] };
  // one matching word is a topic, not a location ("the export step in CI is slow" is not about exportOrdersCsv): a lead needs two
  if (top.matched.length < 2 && !focused) return { status: 'unclear', note: 'one-word', show: [] };
  const topNb = nb(top);
  const linked = new Set<number>([...topNb.calls.map((x) => x.id), ...topNb.calledBy.map((x) => x.id)]);
  const stranger = cands.find((c) => c.file !== top.file && !(c.id != null && linked.has(c.id)));
  if (stranger && top.score < LEAD_MARGIN * stranger.score) return { status: 'unclear', note: `tie:${stranger.name}`, show: [], topNb };
  const rest = cands.slice(1).filter((c) => (c.matched.length >= 2 && c.score >= 0.5 * top.score) || (c.id != null && linked.has(c.id) && c.score >= 0.35 * top.score));
  return { status: 'lead', show: [top, ...rest].slice(0, 3), topNb };
}

function whyOf(c: BugCandidate): string {
  const bits: string[] = [`matches ${c.matched.map((w) => `"${w}"`).join(' ')} (${c.channels.join('+')})`];
  if (c.calls?.length) bits.push(`calls ${c.calls.join(', ')}`);
  if (c.calledBy?.length) bits.push(`called by ${c.calledBy.join(', ')}`);
  return bits.join('; ');
}

export function localizeBug(prompt: string, root: string, generation: string, opts: { dbPath?: string; home?: string } = {}): BugVerdict {
  const t0 = Date.now();
  const nouns = bugNouns(prompt);
  const base = (status: BugVerdict['status'], note: string | undefined, candidates: BugCandidate[]): BugVerdict => ({ status, ...(note ? { note } : {}), nouns, candidates, ms: Date.now() - t0 });
  if (!nouns.length) return base('none', 'no-nouns', []);
  const symbols = bugIndex(root, generation, opts);
  if (!symbols.length) return base('none', 'no-index', []);
  const cands = scoreBug(nouns, symbols, { scope: bugScopeWords(prompt) });
  if (!cands.length) return base('none', 'no-candidates', []);
  const nbs = new Neighbours(root, opts.dbPath);
  try {
    const memo = new Map<string, Nb>();
    const nb = (c: BugCandidate): Nb => { const k = `${c.id}`; let v = memo.get(k); if (!v) { v = nbs.of(c.id, c.name); memo.set(k, v); } return v; };
    // a short prompt with one content noun that names exactly one declaration ("why is the export slow?") is focused enough for a one-word lead
    const focused = nouns.length <= 2 && cands.length === 1 && cands[0]!.matched.length === 1 && cands[0]!.matched[0]!.length >= 6;
    const d = decide(cands, nb, focused);
    if (d.status !== 'lead') return base(d.status, d.note, cands.slice(0, 4));
    for (const c of d.show) { const n = nb(c); c.sig = nbs.signature(c.id); c.calls = n.calls.map((x) => x.name).slice(0, 3); c.calledBy = n.calledBy.map((x) => x.name).slice(0, 3); c.why = whyOf(c); }
    return base('lead', undefined, d.show);
  } finally { nbs.close(); }
}

/** The block the agent sees: header + <= 3 declarations with a one-line why + a trailer that says it is a guess. */
export function renderBugInjection(v: BugVerdict, header: string, maxChars = 1600): string | null {
  if (v.status !== 'lead' || !v.candidates.length) return null;
  const lines: string[] = [];
  for (const c of v.candidates) {
    const decl = `■ ${c.type} ${c.name} @ ${c.file}:${c.line}${c.sig ? ` — ${c.sig}` : ''}`;
    const why = `  why: ${c.why}`;
    lines.push(decl.length > 260 ? decl.slice(0, 259) + '…' : decl, why.length > 260 ? why.slice(0, 259) + '…' : why);
  }
  let out = [header, ...lines, BUG_INJECT_TRAILER].join('\n');
  while (out.length > maxChars && lines.length > 2) { lines.splice(-2, 2); out = [header, ...lines, BUG_INJECT_TRAILER].join('\n'); }
  return out.length <= maxChars ? out : null;
}

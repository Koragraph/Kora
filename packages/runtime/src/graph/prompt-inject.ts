// Prompt-time graph injection (RESEARCH.md item 2). The UserPromptSubmit hook sees the prompt before the
// agent does; for a code-shaped prompt it runs `explore` on the prompt itself and attaches the ranked
// declarations (file:line, no source) as additionalContext. Most "how does X work / where is Y" questions
// then need zero exploration calls. Cost: ≤400 tokens re-billed per injected prompt; skipped for trivial
// prompts, repeated prompts, un-indexed repos, and when config.promptInject is off.
import { koraHome } from '../protocol/types';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INJECT_MAX_CHARS = 1600;   // ≈400 tokens
// Claude Code's UserPromptSubmit hook timeout is 10 s (settings.json). Measured cold, with another session hammering
// the store, an explore took 5–10 s; 2.5 s made the feature silently absent exactly when it mattered.
export const INJECT_TIMEOUT_MS = 7000;
export const OTHER_MATCHES_MAX = 6;    // ranked tail after the ■ hits
// Include the TOP hit's full source body when it fits in this budget — a complete small/medium declaration lets the
// agent answer "what does X do" WITHOUT opening the file (the whole point). A body larger than this is left out
// (signature only) rather than truncated, so the agent reads a range instead of trusting half a function.
export const INJECT_SNIPPET_CHARS = 900;
export const INJECT_HEADER = 'Graph, for this prompt (file:line, already resolved — no need to grep):';
export const INJECT_TRAILER = '(resolved from the graph — answer from what is shown above; only Read a range if you need more than is shown; no further graph calls unless something is missing)';

/**
 * Injection telemetry — one JSONL line per injectForPrompt call, whatever it decided. This is the instrument the
 * savings claim stands on: the two largest savings bugs in this product's history were silent kills of exactly this
 * path (fresh:true on dirty repos; the desktop chat lane never running it). A miss must be COUNTED, with its reason,
 * or it is invisible. File: $KORA_HOME/inject.jsonl (append-only, best effort, never throws). Read by the per-lane
 * canary (scripts/e2e-inject-canary.js), the bench harness (graphHits/graphMisses/injectedDecls per run) and the
 * miss taxonomy. KORA_INJECT_LOG=0 disables; KORA_TRACE=1 mirrors each line to stderr.
 */
export type InjectReason =
  | 'injected'
  | 'config-off' | 'not-code-shaped' | 'text-hunt' | 'already-injected' | 'not-indexed' | 'status-timeout'
  | 'explore-timeout' | 'explore-empty' | 'fuzzy-unqualified' | 'top-hit-irrelevant' | 'no-relevant-hit' | 'symbol-absent' | 'render-empty'
  | 'error';
export interface InjectRecord {
  v: 1; ts: string; lane: string; sessionId: string | null; cwd: string; promptHash: string; promptChars: number;
  decision: 'injected' | 'skipped' | 'miss'; reason: InjectReason; ms: number; statusMs: number | null; exploreMs: number | null;
  query: string | null; idents: number; decls: number; chars: number; topHit: string | null; topFile?: string | null; fresh: boolean | null; error?: string;
  /** ranked ■ names the explore returned (prose path), for the miss taxonomy */
  hits?: string[];
  /** what was injected: symbol declarations (explore), a named file's declaration list (file_symbols), or both */
  mode?: 'symbols' | 'file' | 'both' | 'lean';
  /** recall paths (B14): an edit prompt resolved through the fuzzy channel, or a deictic follow-up resolved against the session's recent files */
  via?: 'edit-prose' | 'carry-file' | 'bug-prose';
  /** bug-report localization (graph/bug-localize.ts): what it decided for a bug-shaped prompt with no identifier. In shadow the text it WOULD have injected is `would`; nothing is injected. */
  bug?: { mode: 'shadow' | 'on'; verdict: 'lead' | 'unclear' | 'none' | 'error' | 'timeout'; note?: string; nouns: string[]; ms: number; cands: { name: string; file: string; line: number; score: number; why?: string }[]; would?: string };
}
export function injectLogPath(): string {
  const home = koraHome();
  return path.join(home, 'inject.jsonl');
}
export function injectLane(explicit?: string, cwd?: string): string {
  if (explicit) return explicit;
  if (process.env.KORA_INJECT_LANE) return process.env.KORA_INJECT_LANE;
  if (process.env.KORA_ORCHESTRATOR_ID) return 'orchestrator';
  if (process.env.KORA_PANE_ID === 'bench') return 'bench';
  // A fleet worker is a pane whose cwd is one of the runtime's linked worktrees ($KORA_HOME/worktrees/<repo>/<name>).
  const wt = path.join(koraHome(), 'worktrees') + path.sep;
  if (process.env.KORA_PANE_ID) return cwd && cwd.startsWith(wt) ? 'fleet-worker' : 'pane';
  return cwd && cwd.startsWith(wt) ? 'fleet-worker' : 'cli';
}
/** The last decision this process made — for callers (tests, the desktop driver) that want the reason, not just the text. */
export let lastInjectRecord: InjectRecord | null = null;
export function recordInject(rec: InjectRecord): void {
  lastInjectRecord = rec;
  if (process.env.KORA_INJECT_LOG === '0') return;
  const line = JSON.stringify(rec);
  if (process.env.KORA_TRACE) { try { process.stderr.write(`[kora inject] ${line}\n`); } catch { /* fine */ } }
  try {
    const f = injectLogPath();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.appendFileSync(f, line + '\n', { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* best effort: an older log was created 0644 */ }
  } catch { /* best effort */ }
}
/** Parse an inject.jsonl (whole file or a tail); malformed lines are skipped. */
export function readInjectLog(file = injectLogPath(), opts: { since?: number } = {}): InjectRecord[] {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: InjectRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as InjectRecord; if (!opts.since || Date.parse(r.ts) >= opts.since) out.push(r); } catch { /* skip */ }
  }
  return out;
}
/** Count the top-level ■ declarations in a rendered injection (what the agent was handed). */
export function countDecls(text: string | null): number { return (text || '').split('\n').filter((l) => /^\s*■/.test(l)).length; }

const QUESTION_WORD_RE = /\b(how|where|why|what|which|explain|callers?|uses?|break|breaks)\b/i;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const YESNO_RE = /^\s*(y|yes|yep|yeah|no|nope|n|ok|okay|sure|continue|go|go ahead|proceed|do it|thanks|thank you|done|next|stop|cancel|fine|good|great)\b[\s.!,]*(please)?[\s.!]*$/i;

/**
 * Worth injecting the graph for? Either:
 *   - the prompt names a code-shaped identifier (camelCase / snake_case / dotted) — a strong signal on its own, so
 *     even a terse "what does mergeWorktree do" qualifies (a very common power-user question that used to miss); or
 *   - it's a ≥6-word question (a question word, no code identifier) — the prose-question fallback.
 * Never slash commands or yes/no/thanks.
 */
// A text hunt — "every place the string X appears", a rename, help text, log lines, docs/comments — is grep's job by
// the rulebook's own routing; the graph indexes structure, not text. Measured in the mixed bench: the dotted
// `practice.db` in such a prompt injected a `practiceCheck()` body that had nothing to do with the question, ~280
// tokens re-billed for the rest of the session, and the agent grepped anyway.
export const TEXT_HUNT_RE = /\b(rename|renaming|renamed|every (?:place|occurrence|mention|spot)|all (?:the )?(?:places|occurrences|mentions|spots)|occurrences? of|the string\b|string literal|help text|usage text|log (?:message|text|line)s?|docs? (?:or|and) comments|comments (?:or|and) docs|typo)\b/i;
export function looksTextHunt(prompt: string): boolean { return TEXT_HUNT_RE.test(prompt || ''); }
// A statement is not a question. Rules, policies, deferrals, meta-instructions and orchestrator boot prompts carry
// code words but ask nothing about structure; measured (replay, meridian): "Important: we do NOT use JWTs anywhere —
// auth is server-side session cookies" injected `SessionSidebar`; "Your response above was cut off mid-stream. Resume
// directly" injected `startStream`. Each was ~300 tokens re-billed on every later turn, for nothing. The corrections
// layer (captureStated) records the rule; the graph has no business here.
export const STATEMENT_RE = /^\s*(important|note|reminder|fyi|heads up|standing rule|rule|policy|decision|from now on|going forward|let'?s (defer|hold off|postpone|park)|hold off|we (do not|don'?t|never|always|should|must)|do not|don'?t|never|always|you are (now )?(the )?orchestrator|your (response|answer|reply) (above )?(was|got) cut off|resume (directly )?from|continue (from )?where)\b/i;
export const STATEMENT_ANYWHERE_RE = /\b(cut off mid-stream|no apology, no recap|note (that|it) for later|for later, not now|you are now the orchestrator)\b/i;
// A PROSE prompt (no identifier) gets the graph only when it asks about code structure or behaviour. Size / count /
// framework / purpose questions carry code-looking words but no declaration answers them — measured (replay, meridian):
// "Roughly how large is the meridian_api codebase?" resolved `auditCodebaseGrounding` on the single strong word
// "codebase"; "What's the difference in purpose between meridian_api and meridian_site?" resolved `DifferenceView`.
/** The time a prompt without an identifier may hold the turn (the full budget is for prompts that name code). */
export const PROSE_BUDGET_MS = 3500;
export const PROSE_CUE_RE = /\b(how (does|do|is|are|did|would|should|can|could)\b|how [a-z][a-z-]* (works?|handles?|decides?|resolves?|flows?|gets?|is|are)\b|where (is|are|does|do|did)\b|what (does|do|happens|calls|invokes|triggers|implements?)\b|who (calls|invokes|uses|implements|owns)\b|which (function|method|class|module|file|code)s?\b|entry ?points?\b|call(ed|s|er|ers|ees)?\b|implement(s|ed|ation|ing)?\b|handle[sd]?\b|dispatch(es|ed)?\b|resolv(e|es|ed|ing|er)\b|trace\b|walk (me )?through\b|explain how\b|flow\b|pipeline\b|defined\b|declared\b|invoked\b|works?\b|triggered\b|initiali[sz]ed\b|constructed\b|validated\b|parsed\b|rendered\b|persisted\b|point me (to|at)\b)/i;
export const PROSE_META_RE = /\b(how (many|much|large|big|long)\b|how (is|are|was) (it|this|that|things|everything|the (product|app|launch|release))\s+(going|looking|doing|coming)\b|how (good|bad) (is|are|was)\b|how old (is|are|was|were)\b|count\b|number of\b|lines of code\b|which (framework|library|language|runtime|test runner|package manager)\b|is [a-z_.-]+ using\b|one word\b|two-line summary\b|in one sentence\b|difference in purpose\b|what is [a-z_.-]+ built with\b|built with\b)/i;
export function proseQualifies(prompt: string): boolean { const p = prompt || ''; return PROSE_CUE_RE.test(p) && !PROSE_META_RE.test(p); }
/** The sentence(s) of a multi-sentence prompt that actually ask the structural question; the whole prompt when none
 *  or all do. "compliance sent this over: '…PII must be redacted…'. anyway, check how logging works" → the last one. */
export function questionClauses(prompt: string): string {
  const parts = (prompt || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return prompt || '';
  const asking = parts.filter((x) => PROSE_CUE_RE.test(x) && !PROSE_META_RE.test(x));
  return asking.length && asking.length < parts.length ? asking.join(' ') : (prompt || '');
}
export const FILE_SECTION_MAX = 520; // chars per file — a declaration list, not a body
/**
 * A prompt that names a FILE ("add a --json flag to src/cli/status.js …") gets that file's declaration list with
 * line numbers, so the agent Reads the range it needs instead of the whole file (a whole-file Read is re-billed on
 * every later turn; measured baseline edit runs: 2–5 whole-file reads per task). Only files that exist under cwd,
 * at most two, ≤ FILE_SECTION_MAX chars each.
 */
export function renderFileSymbols(rel: string, text: string, maxChars = FILE_SECTION_MAX): string | null {
  // file_symbols text: "N symbol(s) in <path>\n  <path>: KIND name:line, KIND name:line, …"
  const line = (text || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith(rel + ':'));
  if (!line) return null;
  const items = line.slice(rel.length + 1).split(',').map((x) => x.trim()).filter((x) => x && !/^FILE /.test(x) && !/^CONSTANT (fs|os|path|crypto|util|http|https|net|child_process|events|stream|url|assert):/.test(x));
  if (!items.length) return null;
  const head = `File ${rel} — declarations (name:line): `;
  let out = head; const kept: string[] = [];
  for (const it of items) { const short = it.replace(/^(METHOD|FUNCTION|CLASS|CONSTANT|FIELD|INTERFACE|TYPE|ENUM|STRUCT) /, (m) => m.trim() === 'METHOD' || m.trim() === 'FUNCTION' ? '' : m.trim().toLowerCase() + ' '); if ((out + short).length + 2 > maxChars) { kept.push('…'); break; } kept.push(short); out += short + ', '; }
  return head + kept.join(', ');
}
/**
 * Which fuzzy candidates to ask the graph about. Two near-tied candidates that explain DIFFERENT words of the prompt
 * are a coin flip, and a wrong declaration in the prompt is worse than none — measured: "how incremental re-indexing
 * works … a changed file is detected … old nodes replaced" scored detectRepoType 2.42 / indexedRepos 2.30 /
 * commitExtractedNodes 2.17 and injected the first two (both wrong). A runner-up that merely extends the winner
 * (authenticate / authenticateJwt) is agreement, not ambiguity. Returns [] when ambiguous — the caller then falls
 * back to a plain lexical explore of the distilled query, whose top hit must still qualify.
 */
export function pickFuzzy(hits: { name: string; score: number; matched?: string[] }[]): string[] {
  if (!hits.length) return [];
  const top = hits[0];
  const rest = hits.slice(1).filter((h) => h.score >= 0.7 * top.score);
  const extendsTop = (h: { name: string }) => h.name.toLowerCase().includes(top.name.toLowerCase()) || top.name.toLowerCase().includes(h.name.toLowerCase());
  const sameWords = (h: { matched?: string[] }) => !!h.matched && !!top.matched && h.matched.slice().sort().join(',') === top.matched.slice().sort().join(',');
  const ambiguous = rest.some((h) => h.score >= 0.8 * top.score && !extendsTop(h) && !sameWords(h));
  if (ambiguous) return [];
  return [top, ...rest.filter((h) => !extendsTop(h))].slice(0, 2).map((h) => h.name);
}
// An EDIT-shaped prompt with no identifier and no question word ("make the window bigger when the hit is a class", "add a
// cooldown so the catalog does not refresh so often", "the lock holder check should also log who holds it") names the code
// by what it does. The prose rule above never admitted these (no cue word), which is most of what a power user types in a
// code thread. They go through the fuzzy symbol channel ONLY, and only a strong match on a real word is injected, as
// declarations without a body (the agent opens the file to edit it anyway).
export const EDIT_START_RE = /^\s*(?:(?:ok|okay|so|now|also|and|then|please|pls|hey|can you|could you|lets|let'?s|i want you to|we should|we need to|you should)[\s,]+)*(add|make|change|fix|update|remove|rename|refactor|implement|extend|support|log|show|hide|move|replace|handle|allow|prevent|reduce|increase|limit|cap|throttle|retry|debounce|cache|validate|sanitize|simplify|split|extract|inline|wire|expose|persist|emit|stop|skip|ignore)\b/i;
export const SHOULD_RE = /\b(should|needs? to|has to|must)\s+(also|always|never|not|log|show|return|handle|retry|skip|use|call|emit|throw|fail|support|only|stop|ignore|check)\b/i;
export function editProseQualifies(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (!p || p.length > 300 || p.startsWith('/') || p.includes(INJECT_HEADER)) return false;
  if (p.split(/\s+/).filter(Boolean).length < 5) return false;
  if (looksTextHunt(p) || YESNO_RE.test(p) || STATEMENT_RE.test(p)) return false;
  return EDIT_START_RE.test(p) || SHOULD_RE.test(p);
}
function bugProseMode(): 'off' | 'shadow' | 'on' { try { return (require('../util/savings-settings') as typeof import('../util/savings-settings')).injectBugProseMode(); } catch { return 'off'; } }
function bugProseCandidate(prompt: string): boolean { try { return (require('./bug-localize') as typeof import('./bug-localize')).bugProseQualifies(prompt); } catch { return false; } }
function recallOn(): boolean { try { return (require('../util/savings-settings') as typeof import('../util/savings-settings')).injectRecallOn(); } catch { return true; } }
export function looksStatement(prompt: string): boolean { const p = (prompt || '').trim(); return STATEMENT_RE.test(p) || STATEMENT_ANYWHERE_RE.test(p); }
// `orchestrator.md`, `audit.js`, `meridian_api/` — a file or directory named in the prompt is a PATH HINT, not a
// symbol: asking the graph for the declaration named `meridian_api` ranked `resolveCheckoutDir` first on 8 of 48 real
// prompts (all correctly rejected afterwards, ~200–1600 ms of explore each, for nothing).
export const FILEISH_RE = /\.(md|txt|js|ts|tsx|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|json|yaml|yml|toml|sql|sh|css|html|xml|csv|lock|cfg|ini|env)$/i;
export function isPathHint(hint: string, cwd?: string): boolean {
  if (FILEISH_RE.test(hint)) return true;
  if (cwd && !hint.includes('.')) { try { return fs.existsSync(path.join(cwd, hint)); } catch { return false; } }
  return false;
}
export function looksCodeShaped(prompt: string): boolean {
  const p = (prompt || '').trim();
  if (!p || p.startsWith('/')) return false;
  if (YESNO_RE.test(p)) return false;
  if (looksTextHunt(p)) return false;
  const words = p.split(/\s+/).filter(Boolean);
  // A code-shaped identifier is enough on its own — terse code questions ("mergeWorktree?", "what does X do")
  // deserve injection too. Lone non-code words fall through to the ≥6-word prose test below and are skipped.
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(p)) !== null) {
    const tok = m[0];
    // camelCase, digits allowed before the capital (s3Client, sha256Hex — audit 2026-10-15 #7); not "2FA"
    if (/[a-z][0-9]*[A-Z]/.test(tok) || tok.includes('_')) return true;
    // dotted: foo.bar, module.method (the identifier followed by .identifier)
    const after = p.slice(m.index + tok.length, m.index + tok.length + 2);
    if (/^\.[A-Za-z_]/.test(after)) return true;
  }
  // No code identifier: fall back to prose questions, but require enough words to be a real one.
  if (words.length < 6) return false;
  return QUESTION_WORD_RE.test(p);
}

// A full sentence as the query makes koragraph's lexical channel give up ("PARTIAL") and graph expansion fills
// the page with noise. Distil: identifiers first (camelCase / snake_case / dotted), then content words ≥5 chars
// minus stopwords, at most 6 tokens. Measured: the sentence form returned unrelated hits; "resolveProjectScope"
// alone returned the right declaration first.
const STOP = new Set(['about', 'after', 'again', 'before', 'being', 'between', 'could', 'decide', 'decides', 'does', 'every', 'explain', 'first', 'going', 'happen', 'happens', 'having', 'inside', 'itself', 'might', 'other', 'please', 'should', 'since', 'still', 'their', 'there', 'these', 'thing', 'things', 'think', 'those', 'through', 'under', 'until', 'using', 'value', 'values', 'walk', 'where', 'which', 'while', 'words', 'would', 'write', 'under', 'cite', 'functions', 'function', 'involved', 'file', 'line', 'lines', 'code', 'repo', 'repository', 'project', 'summary', 'summarise', 'summarize', 'change', 'changed', 'changes', 'minimal', 'exactly', 'complete', 'concise']);
export function distillQuery(prompt: string): { query: string; tokens: string[]; idents: string[] } {
  const p = prompt || '';
  const idents = Array.from(new Set((p.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) || []).filter((t) => t.length >= 4)));
  // Sentence punctuation is not part of a word: "line." and "words." must not become query tokens. A dot survives
  // only INSIDE a token (a.b), which the identifier pass already captured.
  const words = Array.from(new Set(p.toLowerCase().replace(/[^a-z0-9_.\s]/g, ' ').split(/\s+/).map((w) => w.replace(/^[._]+|[._]+$/g, '')).filter((w) => w.length >= 5 && !w.includes('.') && !STOP.has(w) && !idents.some((i) => i.toLowerCase() === w))));
  // Identifiers win outright: "graphStaleness ageMs" finds the declaration; "graphStaleness ageMs return field
  // milliseconds ingest" buries it under lexical noise. Content words are the fallback for prose-only prompts.
  // `Class.method` names the METHOD: asking the graph for the dotted form ranks the class first (measured:
  // "SessionManager.buildDriver" → ■ CLASS SessionManager, then the method). Query by the member; the class stays a
  // relevance token so a stranger named the same cannot win.
  const queryIdents = idents.map((i) => { const m = /^([A-Z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]{2,})$/.exec(i); return m ? m[2] : i; });
  const tokens = idents.length ? queryIdents.slice(0, 3) : words.slice(0, 6);
  return { query: tokens.join(' ') || p.trim().slice(0, 120), tokens: [...idents, ...idents.flatMap((i) => i.includes('.') ? i.split('.') : []), ...words].slice(0, 10).map((t) => t.toLowerCase()), idents: queryIdents };
}
/** Is the TOP ■ hit about the query? (hitRelevant on the first hit line; false when there is none.) */
export function topHitRelevant(text: string, tokens: string[]): boolean {
  const first = (text || '').split('\n').find((l) => /^\s*■/.test(l));
  return !!first && hitRelevant(first, tokens);
}
/** Symbol names of every ■ hit, in ranked order. */
export function hitNames(text: string): string[] {
  const out: string[] = [];
  for (const l of (text || '').split('\n')) { if (!/^\s*■/.test(l)) continue; const m = HIT_NAME_RE.exec(l); if (m && !out.includes(m[1])) out.push(m[1]); }
  return out;
}
/** Symbol name of the top ■ hit, or null. */
export function topHitName(text: string): string | null {
  const first = (text || '').split('\n').find((l) => /^\s*■/.test(l));
  const m = first ? HIT_NAME_RE.exec(first) : null; return m ? m[1] : null;
}
// Relevance floor: at least one ■ hit whose name or path shares a token (≥5 chars, or any identifier) with the query.
export function relevantTo(text: string, tokens: string[]): boolean {
  const hits = text.split('\n').filter((l) => /^\s*■/.test(l)).map((l) => l.toLowerCase());
  if (!hits.length) return false;
  const strong = tokens.filter((t) => t.length >= 5 || /[._]/.test(t));
  if (!strong.length) return false;
  return hits.some((h) => strong.some((t) => h.includes(t)));
}
/** Lowercase parts of an identifier — camelCase / PascalCase / snake_case / dotted split — with parts under 4 chars
 *  dropped (`id`, `get`, `db` are in half the symbols of any repo and mean nothing). */
export function identifierParts(s: string): string[] {
  return (s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).map((p) => p.toLowerCase()).filter((p) => p.length >= 4);
}
// Symbol name out of a hit line: `■ METHOD name @ path:line — sig` or the ranked tail's `  METHOD name @ path:line`.
const HIT_NAME_RE = /^\s*(?:■\s*)?[A-Z_]+\s+(\S+)\s+@/;
/**
 * A secondary ■ hit or an "other matches" row earns its place only when its NAME shares an identifier part with the
 * query (a hit part inside a query token — `worktree` ⊂ `createworktree` — or, for a prose query, a ≥5-char content
 * word either way round). Measured: "what does createWorktree do" carried `■ METHOD call @ src/protocol/client.ts:42`,
 * pure graph-expansion noise that would have been re-billed on every later turn of the session.
 */
export function hitRelevant(line: string, tokens: string[]): boolean {
  const m = HIT_NAME_RE.exec(line); if (!m) return false;
  const parts = identifierParts(m[1]); if (!parts.length) return false;
  const q = Array.from(new Set(tokens.flatMap((t) => [t.toLowerCase(), ...identifierParts(t)]))).filter((t) => t.length >= 4);
  return parts.some((p) => q.some((t) => t.includes(p) || (t.length >= 5 && p.includes(t))));
}
export function normalizePrompt(prompt: string): string {
  return (prompt || '').toLowerCase().replace(/[^a-z0-9_.]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function promptHash(prompt: string): string {
  return crypto.createHash('sha1').update(normalizePrompt(prompt)).digest('hex').slice(0, 16);
}

/** Marker file (one hash per line) recording which prompts were already injected this session. */
export function injectedMarker(sessionId: string | null | undefined): string {
  const key = String(sessionId || 'nosession').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(require('../util/safe-path').privateTmpDir() as string, `kora-inject-${key}`);
}
export function alreadyInjected(sessionId: string | null | undefined, prompt: string): boolean {
  try { return fs.readFileSync(injectedMarker(sessionId), 'utf8').split('\n').includes(promptHash(prompt)); } catch { return false; }
}
export function markInjected(sessionId: string | null | undefined, prompt: string): void {
  try { fs.appendFileSync(injectedMarker(sessionId), promptHash(prompt) + '\n'); } catch { /* best effort */ }
}
function bugTrailer(): string { return (require('./bug-localize') as typeof import('./bug-localize')).BUG_INJECT_TRAILER; }
/** Declaration lines (■ …) already handed to this session, so a later prompt about the same symbol does not re-bill
 *  them: measured on the 10-turn bench, 3 of 18 injected declaration lines were repeats within one session. */
export function shownMarker(sessionId: string | null | undefined): string { return injectedMarker(sessionId) + '-shown'; }
export function shownDecls(sessionId: string | null | undefined): Set<string> {
  try { return new Set(fs.readFileSync(shownMarker(sessionId), 'utf8').split('\n').filter(Boolean)); } catch { return new Set(); }
}
export function markShown(sessionId: string | null | undefined, text: string): void {
  const lines = (text || '').split('\n').filter((l) => /^\s*■/.test(l)).map((l) => l.trim());
  if (lines.length) { try { fs.appendFileSync(shownMarker(sessionId), lines.join('\n') + '\n'); } catch { /* best effort */ } }
}
/** Drop ■ lines (and the source body / callers that belong to a dropped TOP hit) the session already saw. Returns
 *  null when nothing new would be shown. */
export function dropShown(text: string, shown: Set<string>): string | null {
  if (!shown.size) return text;
  const lines = text.split('\n');
  const out: string[] = []; let skipping = false; let kept = 0;
  for (const l of lines) {
    if (/^\s*■/.test(l)) { skipping = shown.has(l.trim()); if (!skipping) { kept++; out.push(l); } continue; }
    if (l === INJECT_HEADER || l === INJECT_TRAILER || l === bugTrailer() || /^File /.test(l)) { skipping = false; out.push(l); continue; }
    if (!skipping) out.push(l);
  }
  const files = out.filter((l) => /^File /.test(l)).length;
  return kept + files > 0 ? out.join('\n') : null;
}

/**
 * Distil an explore result to what's worth putting in the prompt: every `■` hit line, the top hit's `callers:`
 * line, the `other matches:` tail, and — when snippetChars>0 — the TOP hit's COMPLETE source body if it fits
 * (so the agent answers without a Read). Callees, blank lines and every other source block are dropped. Ordered
 * top-decl → top-body → top-callers → other hits → ranked tail, so the cap trims the tail first, never the body.
 * With query `tokens`, secondary hits and tail rows that share no identifier part with the query are dropped
 * (hitRelevant); an empty / "(none…)" callers line is dropped always. Every injected token is re-billed per turn.
 */
// Edit-shaped prompts ("add a flag to …", "now make that change", "implement", "fix", "refactor") get file:line only:
// the agent opens the file to edit it regardless, so an injected body is re-billed on every later turn for nothing.
// Measured (hooks A/B, mixed session): the edit turns cost +40% and +7% WITH injection, the callers turns −79% / −34%.
export const EDIT_RE = /\b(add|make|implement|fix|refactor|rename|change|edit|update|write|create|remove|delete|replace|extend|thread|wire|introduce)\b[^.?!]{0,60}\b(flag|option|field|function|method|test|change|file|param|argument|handler|feature|support|line|note)\b|\bnow make that change\b|\bminimal diff\b|\bdo not run (the )?tests\b/i;
export const WALK_RE = /\b(walk(\s+me)?\s+through|how (does|do|is|are)\b[^.?!]{0,80}\b(work|works|handle|handles|decide|decides|flow|flows)|explain how|trace\b|step[- ]by[- ]step|end[- ]to[- ]end|pipeline|call chain|what (happens|calls)\b)/i;
/**
 * A `callers:` / `callees:` line of an explore result, tidied for the prompt. The raw line carries three kinds of noise a
 * tester found re-billed on every later turn: doc-comment (RATIONALE) nodes listed as if they were callers
 * ("withRetry — Run `fn` until …@file:28"), a class's own members (fields, constructor) listed as its callers, and an
 * empty leading entry ("callers:, baseUrl@…"). Only `name@file:line` entries with an identifier for a name survive (the
 * "(call at :N)" annotation goes), a class loses its same-file entries, at most four stay. Null when nothing is left.
 */
export function tidyRefs(line: string, declLine: string, max = 4): string | null {
  const m = /^\s*(callers|callees):\s*(.*)$/.exec(line); if (!m) return null;
  const isClass = /^■\s+CLASS\b/.test(declLine.trim());
  const declFile = /@\s+(\S+?):\d+/.exec(declLine)?.[1];
  const seen = new Set<string>(); const keep: string[] = [];
  for (const e of m[2]!.matchAll(/(?:^|,\s*)([^,@]*?)@([^\s,@]+?):(\d+)(?:\s*\(call at :\d+\))?/g)) {
    const name = e[1]!.trim(); const file = e[2]!;
    if (!/^[A-Za-z_$][\w$.]*$/.test(name)) continue;
    if (isClass && m[1] === 'callers' && file === declFile) continue;
    const key = `${name}@${file}:${e[3]}`; if (seen.has(key)) continue; seen.add(key); keep.push(key);
    if (keep.length >= max) break;
  }
  return keep.length ? `${m[1]}: ${keep.join(', ')}` : null;
}
export function declarationLines(text: string, maxChars = INJECT_MAX_CHARS, snippetChars = 0, tokens?: string[], opts: { callees?: boolean } = {}): string[] {
  const lines = (text || '').split('\n');
  interface Hit { decl: string; callers: string | null; callees: string | null; source: string[] }
  const hits: Hit[] = []; const others: string[] = [];
  let cur: Hit | null = null, inSource = false, inOther = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*■/.test(line)) {
      inSource = false; inOther = false;
      // the same declaration twice (two explores merged by the prose path) is one: keep the first block, ignore the repeat's lines
      const dup = hits.find((h) => h.decl === line.trim());
      if (dup) { cur = { decl: line.trim(), callers: null, callees: null, source: [] }; continue; }
      cur = { decl: line.trim(), callers: null, callees: null, source: [] }; hits.push(cur); continue;
    }
    if (/^other matches:/i.test(line)) { inSource = false; inOther = true; continue; }
    if (/^\s*--- source /.test(line)) { inSource = true; continue; }
    if (inSource) { if (cur) cur.source.push(raw); continue; } // runs until the next ■ hit / "other matches"
    if (inOther) { if (others.length < OTHER_MATCHES_MAX && /^\s*[A-Z_]+\s+\S+\s+@\s+\S+:\d+/.test(line)) others.push('  ' + line.trim()); continue; }
    if (cur && !cur.callers && /^\s*callers:/.test(line)) cur.callers = tidyRefs(line, cur.decl);
    if (cur && !cur.callees && /^\s*callees:/.test(line)) cur.callees = tidyRefs(line, cur.decl);
  }
  if (!hits.length) return [];
  const out: string[] = [hits[0].decl];
  if (snippetChars > 0 && hits[0].source.length) {
    const body = hits[0].source.join('\n').replace(/\s+$/, '');
    if (body.length > 0 && body.length <= snippetChars) out.push(...hits[0].source); // complete body only, never truncated
  }
  if (hits[0].callers && !/^callers:\s*(?:\(none\b.*)?$/i.test(hits[0].callers)) out.push(hits[0].callers);
  // A "walk me through / how does X work / trace the flow" prompt is a multi-hop question: the top hit's callees are
  // the next hop, and without them the agent explored twice more (measured, bench m1: 3 of 3 runs fell back to
  // explore after an injection that stopped at the declaration). ~40–80 tokens.
  if (opts.callees && hits[0].callees && !/^callees:\s*(?:\(none\b.*)?$/i.test(hits[0].callees)) out.push(hits[0].callees);
  const keep = (l: string) => !tokens || hitRelevant(l, tokens);
  for (let i = 1; i < hits.length; i++) if (keep(hits[i].decl)) out.push(hits[i].decl);
  const shownNames = new Set(hits.map((h) => HIT_NAME_RE.exec(h.decl)?.[1]).filter(Boolean) as string[]);
  out.push(...others.filter((l) => keep(l) && !shownNames.has(HIT_NAME_RE.exec(l)?.[1] ?? '')));
  const kept: string[] = []; let size = 0;
  for (const l of out) { if (size + l.length + 1 > maxChars) break; kept.push(l); size += l.length + 1; }
  return kept;
}

export function renderInjection(text: string, maxChars = INJECT_MAX_CHARS, snippetChars = INJECT_SNIPPET_CHARS, tokens?: string[], exactIdents?: string[], opts: { callees?: boolean } = {}): string | null {
  // Degrade guard: a partial/degraded answer or an explicit miss is noise, and noise in the prompt is re-billed
  // on every later turn. Inject nothing — UNLESS the prompt named an identifier and the top ■ hit IS that
  // declaration. "PARTIAL" only means the lexical (FTS) channel missed its 1.5 s budget, which happens on every
  // cold process (a hook is a fresh process per prompt): the structural channel answered exactly, and dropping
  // an exact hit for it silently killed injection in every headless lane (measured: canary + bench, 0 decls).
  // Only the HEADER line carries these markers. Testing the whole text matched them inside a pasted source body —
  // the canary's own subject (this file) contains both literals — and every lane on this repo went render-empty.
  const header = (text || '').split('\n').find((l) => l.trim().length > 0) || '';
  if (/NO DECLARATION NAMED/.test(header)) return null;
  if (/PARTIAL:/.test(header)) {
    const top = topHitName(text);
    const exact = !!top && (exactIdents || []).some((i) => i.toLowerCase() === top.toLowerCase() || top.toLowerCase().endsWith('.' + i.toLowerCase()));
    if (!exact) return null;
  }
  // Reserve room for BOTH the header and the trailer so header + body + trailer stays within maxChars (with a body
  // snippet the declaration lines now actually reach this budget).
  const lines = declarationLines(text, maxChars - INJECT_HEADER.length - INJECT_TRAILER.length - 2, snippetChars, tokens, opts);
  if (!lines.some((l) => /^\s*■/.test(l))) return null; // every hit was filtered (stale index) — nothing worth paying for
  if (!lines.some((l) => l.startsWith('■') || /@\s+\S+:\d+/.test(l))) return null;
  return [INJECT_HEADER, ...lines, INJECT_TRAILER].join('\n');
}

export interface InjectOpts {
  prompt: string; cwd: string; sessionId: string | null | undefined; timeoutMs?: number;
  /** false: never inject a named file's declaration list (tests) */
  fileHints?: boolean;
  /** Which product surface asked (telemetry): cli | pane | fleet-worker | orchestrator | desktop-chat | codex-chat | bench. Defaults from env (injectLane). */
  lane?: string;
  /** The host's graph service (the runtime's — its queries run in worker threads). Without it a fresh in-process
   *  service is built per call, which in the chat daemon put every turn's graph lookups back on the event loop
   *  (3–10 s stalls at turn start, measured). */
  graph?: { status(cwd: string, opts?: { nocache?: boolean }): Promise<{ indexed: boolean; repoRoot?: string | null; stale?: boolean; incomplete?: boolean }>; callTool(name: any, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<{ text: string }>; fuzzy?(prompt: string, root: string, generation: string): Promise<unknown[]>; bugLocalize?(prompt: string, root: string, generation: string): Promise<unknown> };
}
/**
 * The whole decision + call, never throws. Returns the additionalContext text or null (skipped). Routes through
 * the server (counted as channel 'hook') when inside a pane with a live socket, else runs explore in-process.
 */
export async function injectForPrompt(opts: InjectOpts): Promise<string | null> {
  const { prompt, cwd, sessionId } = opts;
  const t0 = Date.now();
  const rec: InjectRecord = { v: 1, ts: new Date(t0).toISOString(), lane: injectLane(opts.lane, cwd), sessionId: sessionId ?? null, cwd, promptHash: promptHash(prompt), promptChars: (prompt || '').length, decision: 'skipped', reason: 'error', ms: 0, statusMs: null, exploreMs: null, query: null, idents: 0, decls: 0, chars: 0, topHit: null, fresh: null };
  const finish = (text: string | null, reason: InjectReason, extra?: Partial<InjectRecord>): string | null => {
    Object.assign(rec, extra || {});
    rec.ms = Date.now() - t0; rec.reason = reason;
    rec.decision = text ? 'injected' : (reason === 'config-off' || reason === 'not-code-shaped' || reason === 'text-hunt' || reason === 'already-injected' || reason === 'not-indexed') ? 'skipped' : 'miss';
    if (text) { rec.decls = countDecls(text); rec.chars = text.length; rec.topHit = rec.topHit ?? topHitName(text); const m = /■\s+\S+\s+\S+\s+@\s+(\S+?):\d+/.exec(text); rec.topFile = m ? m[1] : null; }
    recordInject(rec);
    return text;
  };
  try { return await injectForPromptInner(opts, rec, finish); }
  catch (e: any) { return finish(null, 'error', { error: String(e?.message || e).slice(0, 200) }); }
}
const KICKED = new Map<string, number>();
const KICK_GAP_MS = 30_000;
/**
 * Start an incremental (or, for a half-built index, full) re-index of an already-indexed repo as a detached child and,
 * for the cheap incremental case, wait a bounded moment for it. Returns true when the child finished in time. Never
 * for an un-indexed folder (index consent lives on the graph chip), never twice within KICK_GAP_MS, never when another
 * process already holds the repo's ingest lock.
 */
async function freshenIndex(root: string, incomplete: boolean, deadline: number): Promise<boolean> {
  if (process.env.KORA_AUTO_INGEST === '0') return false;
  const now = Date.now();
  if (now - (KICKED.get(root) || 0) < KICK_GAP_MS) return false;
  try { if (require('./lock').lockHolder(root)) return false; } catch { /* no lock module */ }
  KICKED.set(root, now);
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const { NODE_BIN, KORA_BIN, withTimeout } = require('./embedded');
  let child: import('node:child_process').ChildProcess;
  try { child = spawn(NODE_BIN, ['--liftoff-only', KORA_BIN, 'ingest', root], { detached: true, windowsHide: true, stdio: 'ignore', env: process.env }); }
  catch { return false; }
  child.unref();
  if (incomplete) return false; // a full rebuild takes minutes: never hold the turn for it
  const done = new Promise<boolean>((res) => { child.once('exit', () => res(true)); child.once('error', () => res(false)); });
  return withTimeout(done, Math.max(0, Math.min(3500, deadline - Date.now() - 3000)), false);
}
async function injectForPromptInner(opts: InjectOpts, rec: InjectRecord, finish: (text: string | null, reason: InjectReason, extra?: Partial<InjectRecord>) => string | null): Promise<string | null> {
  const { prompt, cwd, sessionId } = opts;
  // The hook has a hard 10 s budget in Claude Code; the default 7 s leaves margin. A very large store (a cold explore
  // against millions of nodes) can want more — KORA_INJECT_TIMEOUT_MS raises it for that machine.
  const envMs = Number(process.env.KORA_INJECT_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : INJECT_TIMEOUT_MS);
  try {
    const { loadConfig } = require('../config');
    if (!loadConfig().promptInject) return finish(null, 'config-off');
  } catch { /* defaults on */ }
  // A prompt that already carries an injection (a chat lane persists the prepended declarations as user text, and a
  // replayed / re-sent message would otherwise get a second block on top) is never injected again.
  if ((prompt || '').includes(INJECT_HEADER)) return finish(null, 'already-injected', { query: 'carries-injection' });
  // A prompt that gets no injection still heals a stale / half-built index in the background (the chip promises "re-indexes
  // when you send your next message"; before, only a CODE-shaped prompt did). Not awaited: the turn never waits on it.
  // Recall (B14): an edit-shaped prompt without an identifier still gets the fuzzy symbol channel, and a deictic follow-up
  // ("add a test for that function") the recently touched file's outline. Neither changes a text hunt / statement / yes-no.
  const recall = recallOn();
  const editProse = recall && !looksCodeShaped(prompt) && editProseQualifies(prompt);
  let carry: string | null = null;
  if (recall && sessionId) {
    try {
      const c = require('./inject-carry') as typeof import('./inject-carry');
      const cs = c.tickCarry(sessionId);
      if (!looksTextHunt(prompt) && !looksStatement(prompt) && !distillQuery(prompt).idents.length) carry = c.carryFile(cs, prompt);
    } catch { carry = null; }
  }
  // A bug described in plain words (no identifier) is a candidate for bug localization (graph/bug-localize.ts). off: never;
  // shadow: decide and log what it would inject, change nothing; on: inject when the graph has a clear leader.
  const bugMode = bugProseMode();
  const bugCandidate = bugMode !== 'off' && !looksTextHunt(prompt) && !looksStatement(prompt) && !distillQuery(prompt).idents.length && bugProseCandidate(prompt);
  const skip = looksTextHunt(prompt) ? 'text-hunt' : looksStatement(prompt) ? 'statement' : (!looksCodeShaped(prompt) && !editProse && !carry && !bugCandidate) ? 'not-code-shaped' : null;
  if (skip) {
    const graph = opts.graph ?? (require('./index') as typeof import('./index')).createGraphService();
    void Promise.resolve().then(() => graph.status(opts.cwd)).then((st) => { if (st?.repoRoot && (st.stale || st.incomplete)) return freshenIndex(st.repoRoot, !!st.incomplete, 0); return false; }).catch(() => {});
    return skip === 'text-hunt' ? finish(null, 'text-hunt') : finish(null, 'not-code-shaped', skip === 'statement' ? { query: 'statement' } : undefined);
  }
  if (alreadyInjected(sessionId, prompt)) return finish(null, 'already-injected');
  const { socketReachable, withTimeout } = require('./embedded');
  const graph = opts.graph ?? (require('./index') as typeof import('./index')).createGraphService();
  let deadline = Date.now() + timeoutMs;
  const ts0 = Date.now();
  let st = await withTimeout(graph.status(cwd), Math.min(1000, timeoutMs), null);
  rec.statusMs = Date.now() - ts0;
  if (!st) return finish(null, 'status-timeout');
  // Bug-report localization (graph/bug-localize.ts). Records what it decided in rec.bug; in 'on' mode returns the injected text.
  // In shadow the outcome of the rest of the function is never changed.
  const runBug = async (mayInject: boolean): Promise<string | null> => {
    if (!st || !st.repoRoot) return null;
    const tb = Date.now();
    const bl = require('./bug-localize') as typeof import('./bug-localize');
    const mode = bugMode as 'shadow' | 'on';
    let verdict: import('./bug-localize').BugVerdict | null = null; let vErr = null as 'error' | 'timeout' | null;
    try {
      const gen = String(st.lastIngestAt || 'unknown');
      const root = st.repoRoot;
      const budget = Math.max(300, Math.min(2500, deadline - Date.now() - 1500));
      const call = graph.bugLocalize ? (graph.bugLocalize(prompt, root, gen) as Promise<import('./bug-localize').BugVerdict>) : Promise.resolve().then(() => bl.localizeBug(prompt, root, gen));
      verdict = await withTimeout(call.catch(() => { vErr = 'error'; return null as any; }), budget, null as any);
      if (!verdict && !vErr) vErr = 'timeout';
    } catch { vErr = 'error'; }
    const would = verdict ? bl.renderBugInjection(verdict, INJECT_HEADER, INJECT_MAX_CHARS) : null;
    rec.bug = { mode, verdict: vErr ?? verdict!.status, ...(verdict?.note ? { note: verdict.note } : {}), nouns: verdict?.nouns ?? [], ms: Date.now() - tb, cands: (verdict?.candidates ?? []).slice(0, 4).map((c) => ({ name: c.name, file: c.file, line: c.line, score: c.score, ...(c.why ? { why: c.why } : {}) })), ...(mode === 'shadow' && would ? { would } : {}) };
    if (mode !== 'on' || !mayInject || !would) return null;
    const full = fileSections.length ? would.replace(bl.BUG_INJECT_TRAILER, fileSections.join('\n') + '\n' + bl.BUG_INJECT_TRAILER) : would;
    const text = dropShown(full, shownDecls(sessionId));
    if (!text) return null;
    markInjected(sessionId, prompt); markShown(sessionId, text); noteInjected(text);
    return finish(text, 'injected', { mode: 'lean', via: 'bug-prose', topHit: verdict!.candidates[0]!.name });
  };
  // A prompt that is bug-shaped and nothing else (no identifier, not an edit, not a question the old prose rule takes) used to be
  // skipped before the status call. In shadow it still is: log what the localizer would do, never wait for a re-index, never change the outcome.
  if (bugCandidate && !looksCodeShaped(prompt) && !editProse && !carry && bugMode === 'shadow') {
    if (st.repoRoot && st.indexed && !st.incomplete) await runBug(false);
    else if (st.repoRoot && (st.stale || st.incomplete)) void freshenIndex(st.repoRoot, !!st.incomplete, 0).catch(() => {});
    return finish(null, 'not-code-shaped');
  }
  // An index that already exists but is behind HEAD (a commit, a branch switch, a rename) or died part-way heals HERE, on the
  // turn that needs it. The chip says "re-indexes when you send your next message"; before this nothing did, and every
  // injection for a renamed file missed (`symbol-absent`) until something else happened to re-index.
  if (st.repoRoot && (st.stale || st.incomplete)) {
    const waited = await freshenIndex(st.repoRoot, !!st.incomplete, deadline);
    if (waited) st = (await withTimeout(graph.status(cwd, { nocache: true }), 800, null)) ?? st;
    if (st.incomplete) return finish(null, 'not-indexed', { query: 'index-incomplete-reindexing' });
  }
  if (!st.indexed) return finish(null, 'not-indexed');
  const distilled = distillQuery(prompt);
  // Path hints are not symbols: drop them from the identifier list (and from the query when they were the query).
  const hints = distilled.idents.filter((i) => isPathHint(i, cwd));
  const idents = distilled.idents.filter((i) => !hints.includes(i));
  const tokens = distilled.tokens.filter((t) => !hints.some((h) => h.toLowerCase() === t));
  let query = distilled.query;
  // Files named in the prompt (full relative paths are matched first: `src/cli/status.js`, then bare `status.js`).
  const fileSections: string[] = [];
  if (opts.fileHints !== false) {
    const named = Array.from(new Set([...(prompt.match(/\b[A-Za-z0-9_./-]+\/[A-Za-z0-9_.-]+\.[a-z]{1,5}\b/g) || []), ...hints.filter((h) => FILEISH_RE.test(h)), ...(carry ? [carry] : [])]));
    const files = named.map((n) => n.replace(/^\.\//, '')).filter((n) => { try { return fs.statSync(path.join(cwd, n)).isFile(); } catch { return false; } }).slice(0, 2);
    for (const rel of files) {
      if (Date.now() >= deadline - 300) break;
      try {
        const r = await withTimeout(graph.callTool('file_symbols', { path: rel }, { cwd, fresh: false } as any), Math.max(200, Math.min(1500, deadline - Date.now() - 200)), null as any);
        const sec = r && r.text ? renderFileSymbols(rel, r.text) : null; if (sec) fileSections.push(sec);
      } catch { /* best effort */ }
    }
  }
  // what this injection handed over becomes a candidate for the next deictic follow-up
  const noteInjected = (text: string): void => {
    if (!recall || !sessionId) return;
    try {
      const c = require('./inject-carry') as typeof import('./inject-carry');
      c.noteInjectedText(sessionId, text);
      for (const m of text.matchAll(/^File (\S+) — declarations/gm)) c.markOutlined(sessionId, m[1]!);
    } catch { /* recall memory is best effort */ }
  };
  const fileOnly = (reason: InjectReason, q: string): string | null => {
    if (!fileSections.length) return finish(null, reason, { query: q });
    const text = [INJECT_HEADER, ...fileSections, INJECT_TRAILER].join('\n');
    markInjected(sessionId, prompt); markShown(sessionId, text);
    noteInjected(text);
    return finish(text, 'injected', { query: q, mode: 'file', ...(carry && !idents.length && fileSections.length ? { via: 'carry-file' as const } : {}) });
  };
  if (hints.length) {
    if (!idents.length && !tokens.length) return fileOnly('not-code-shaped', 'path-hint-only');
    query = idents.length ? idents.slice(0, 3).join(' ') : tokens.filter((t) => !/[._]/.test(t)).slice(0, 6).join(' ') || query;
    // a prompt that was code-shaped ONLY because of a path-looking token falls back to the prose rule
    if (!idents.length && !looksCodeShaped(prompt.replace(new RegExp(hints.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), ' '))) return fileOnly('not-code-shaped', 'path-hint-only');
  }
  rec.query = query; rec.idents = idents.length;
  if (bugCandidate && !idents.length) { const t = await runBug(true); if (t) return t; }
  const paneId = process.env.KORA_PANE_ID;
  let exploreMsTotal = 0; let timedOut = false;
  const explore = async (q: string): Promise<{ text: string } | null> => {
    let result: { text: string } | null = null;
    const te = Date.now();
    try { result = await exploreOnce(q); } finally { exploreMsTotal += Date.now() - te; rec.exploreMs = exploreMsTotal; }
    if (!result && Date.now() >= deadline) timedOut = true;
    return result;
  };
  const exploreOnce = async (q: string): Promise<{ text: string } | null> => {
    let result: { text: string } | null = null;
    if (paneId && socketReachable()) {
      try {
        const { callOnce } = require('../protocol/client');
        // fresh:false on purpose. The freshness pass (git status + an incremental re-ingest of the changed files)
        // was assumed to cost ~200 ms, but on a real working repo with a handful of dirty files it is SECONDS
        // (meridian, 23 changed files: explore fresh:false 0.5 s vs fresh:true 5.4 s) — enough to blow the hook
        // deadline so the whole injection silently drops, which is the one outcome worse than a stale line number.
        // The declaration's file:line only needs to be close; the injection trailer already tells the agent to Read
        // a range if it needs more, so a few seconds of staleness costs nothing next to missing the injection.
        rec.fresh = false;
        result = await withTimeout(callOnce('graph.tool', { name: 'explore', args: { query: q }, cwd, paneId, channel: 'hook', fresh: false }, undefined, Math.max(200, deadline - Date.now())), Math.max(200, deadline - Date.now()), null);
      } catch { result = null; }
    }
    if (!result) {
      const left = deadline - Date.now();
      if (left < 200) return null;
      // No freshness pass here: it runs `git status` + an incremental ingest on every prompt, and the graph being a
      // few seconds stale costs nothing next to a hook that misses its deadline.
      rec.fresh = false;
      // In-process = a fresh process per prompt with a cold page cache: the lexical channel's 1.5 s default was
      // blown routinely (measured 1.0–1.6 s cold), degrading every result to PARTIAL. Give it the hook's budget.
      if (!process.env.RETRIEVAL_LEXICAL_TIMEOUT_MS) process.env.RETRIEVAL_LEXICAL_TIMEOUT_MS = String(Math.max(1500, Math.min(left - 500, 5000)));
      result = await withTimeout(graph.callTool('explore', { query: q }, { cwd, fresh: false } as any), left, null);
    }
    return result && result.text ? result : null;
  };
  // Vague prompt (no identifier): fuzzy-match its words against the repo's symbol names first, and ask the graph
  // about the best symbols BY NAME, one explore each, merged — an exact lookup instead of a lexical guess. Measured:
  // "how does the MCP server decide which repository a tool call is scoped to" went from `findKoragraphServerEnv`
  // first to callTool + serverRepoId. Either way a prose top hit must explain two of the prompt's words (or one long
  // one): "how are stale files caught up before a query runs" resolved to the sqlite pool's `query()` on the strength
  // of one five-letter word, and a wrong declaration in the prompt is worse than none.
  let toks = tokens; let result: { text: string } | null = null;
  if (!idents.length) {
    const proseOk = proseQualifies(prompt);
    if (!proseOk && !editProse) return fileOnly('not-code-shaped', 'prose-no-cue');
    // A prompt with no identifier lands a declaration about one time in eight (2026-10-20, 72 real prompts) and its
    // misses held the turn a median 3 s, up to the full budget. It gets a shorter one.
    deadline = Math.min(deadline, ts0 + PROSE_BUDGET_MS);

    const { fuzzyForPrompt, fuzzyWords, symbolQualifies } = require('./fuzzy');
    const asking = questionClauses(prompt);
    const words: string[] = fuzzyWords(asking);
    let chosen: string[] = [];
    if (st.repoRoot) { try {
      const gen = String(st.lastIngestAt || 'unknown');
      // Off the event loop when the service is worker-backed (the symbol index scans every declaration name of the repo).
      const hits: { name: string; score: number; matched?: string[] }[] = graph.fuzzy ? await withTimeout(graph.fuzzy(asking, st.repoRoot, gen), Math.max(200, deadline - Date.now()), [] as unknown[]) as any : fuzzyForPrompt(asking, st.repoRoot, gen);
      chosen = pickFuzzy(hits);
      if (!chosen.length && hits.length) rec.topHit = `ambiguous:${hits.slice(0, 2).map((h) => h.name).join('|')}`;
      // A walk-through ("walk through how the server decides which repository a tool call is scoped to") is a multi-hop
      // question: one injected declaration only pays when it is the SUBJECT, and a shallow match is not that. Measured:
      // callTool ← "tool call" (generic only) and serverRepoId ← "repository"→repo (a prefix match) both lost on every
      // repeat (m1: 6 of 7 sessions worse, +27…+89% on that turn); runPipeline ← "pipeline" (exact) and authenticate ←
      // "authenticates" (stem) answered real prompts correctly. So a walk-through needs a strong (≥ .9) match on a
      // non-generic word; otherwise nothing is injected and the rulebook routes the agent to explore.
      // An edit prompt has no question to anchor it, so a declaration is injected only on strong evidence (the walk-through bar).
      if (editProse && !proseOk) {
        if (!chosen.length) { return fileOnly('fuzzy-unqualified', 'edit-no-fuzzy'); }
        const top = hits.find((h) => h.name === chosen[0]) as { strong?: string[] } | undefined;
        if (!top || !top.strong || !top.strong.length) { rec.topHit = chosen[0]; return fileOnly('fuzzy-unqualified', 'edit-weak-match'); }
      }
      if (chosen.length && WALK_RE.test(prompt)) {
        const top = hits.find((h) => h.name === chosen[0]) as { strong?: string[] } | undefined;
        if (!top || !top.strong || !top.strong.length) { rec.topHit = chosen[0]; return fileOnly('fuzzy-unqualified', 'walk-through-weak-match'); }
      }
    } catch { chosen = []; } }
    if (chosen.length) {
      const texts: string[] = [];
      for (const name of chosen) { const r = await explore(name); if (r && topHitRelevant(r.text, [name.toLowerCase(), ...identifierParts(name)])) texts.push(r.text); }
      if (texts.length) { result = { text: texts.join('\n') }; toks = [...tokens, ...chosen.flatMap((n) => [n.toLowerCase(), ...identifierParts(n)])]; }
    }
    if (!result && editProse && !proseOk) return fileOnly('fuzzy-unqualified', 'edit-no-fuzzy');
    if (!result) result = await explore(query);
    if (result) {
      // The lexical ranking of a prose query is not stable: the same prompt put runIncrementalIngest first in one
      // process and nodeSourceStem (a stranger) first in the next, and only the top hit used to be judged. Take the
      // first RANKED hit that explains the prompt's words and ask the graph for it by name (exact body + callers).
      const names = hitNames(result.text);
      rec.hits = names.slice(0, 6);
      const pick = names.find((n) => symbolQualifies(n, words)) || null;
      // (A retry on the single strongest content word was tried and BACKED OUT: it rescued one bench prompt and, on 48
      // real prompts, added four injections of which three named the wrong declaration — recordTraceResolution for
      // "entry point for edge resolution", verifyFileCitations for a truncated instruction. One word is not evidence.)
      if (!pick) { rec.topHit = names[0] || null; return fileOnly('fuzzy-unqualified', query); }
      rec.topHit = pick;
      // same bar as the fuzzy path: a walk-through needs a strong match on a real word (see above)
      if (WALK_RE.test(prompt)) { const { fuzzyFind } = require('./fuzzy'); const h = fuzzyFind(words, [{ name: pick, parts: identifierParts(pick) }], 1)[0]; if (!h || !h.strong.length) return fileOnly('fuzzy-unqualified', 'walk-through-weak-match'); }
      if (pick !== names[0]) { const r2 = await explore(pick); if (r2 && topHitName(r2.text)?.toLowerCase() === pick.toLowerCase()) result = r2; }
      toks = [...toks, pick.toLowerCase(), ...identifierParts(pick)];
    }
  } else result = await explore(query);
  // A prompt naming a symbol that exists beside one that does not ("add ageMs to graphStaleness()") ranks a stranger
  // first — measured: `query()` from the sqlite pool. When the top hit is not about the query and there is more than
  // one identifier, ask again for the first identifier alone (~200 ms) before giving up.
  if (result && !topHitRelevant(result.text, toks) && idents.length > 1) result = await explore(idents[0]);
  if (!result) return fileOnly(timedOut ? 'explore-timeout' : 'explore-empty', query);
  if (idents.length === 1) { const top = topHitName(result.text); const want = idents[0].toLowerCase(); if (top && top.toLowerCase() !== want && !top.toLowerCase().endsWith('.' + want) && !relevantTo(result.text, toks)) { rec.topHit = top; return fileOnly('symbol-absent', query); } }
  if (!relevantTo(result.text, toks)) { rec.topHit = topHitName(result.text); return fileOnly('no-relevant-hit', query); }
  if (!topHitRelevant(result.text, toks)) { rec.topHit = topHitName(result.text); return fileOnly('top-hit-irrelevant', query); }
  // Prose prompts resolve to a top hit by content words only — a weaker match — so they get declarations without the
  // body: a wrong body is ~200 tokens of confident noise, while the file:line list still saves the search.
  // Lean shapes: an edit prompt gets no body (the file is opened to edit anyway); a walk-through prompt gets the
  // declaration + callers + callees but no body either (measured: the body did not stop the exploration, it only
  // added re-billed tokens — m1 +27% with injection). Exact "what does X do / who calls X" lookups keep the body.
  const lean = EDIT_RE.test(prompt) || WALK_RE.test(prompt) || editProse;
  rec.mode = lean ? 'lean' : undefined;
  const rendered = renderInjection(result.text, INJECT_MAX_CHARS, idents.length && !lean ? INJECT_SNIPPET_CHARS : 0, toks, idents, { callees: WALK_RE.test(prompt) });
  if (!rendered) return fileOnly('render-empty', query);
  // symbol declarations first, then the named file's declaration list (before the trailer)
  const full = fileSections.length ? rendered.replace(INJECT_TRAILER, fileSections.join('\n') + '\n' + INJECT_TRAILER) : rendered;
  const text = dropShown(full, shownDecls(sessionId));
  if (!text) { markInjected(sessionId, prompt); return finish(null, 'already-injected', { query, mode: 'symbols', topHit: topHitName(full) }); }
  markInjected(sessionId, prompt); markShown(sessionId, text);
  noteInjected(text);
  return finish(text, 'injected', { mode: fileSections.length ? 'both' : (lean ? 'lean' : 'symbols'), ...(editProse && !idents.length && !proseQualifies(prompt) ? { via: 'edit-prose' as const } : {}) });
}

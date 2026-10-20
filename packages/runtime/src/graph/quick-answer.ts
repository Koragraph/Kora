// Deterministic graph answers (master cost plan 8, B17): "who calls X", "where is X defined", "what breaks if I change X" are
// questions the code graph answers exactly. Today they cost an agent turn (a 100k+ context re-read, 10-30k tokens); here they
// cost ~0: the composer / command palette calls `answerQuickQuestion`, shows the result as a tool-style card, and adds it to the
// thread as context for the next turn. Pure parsing + one graph call per question; nothing here sends a turn.
//
// Deliberately narrow: only a code-shaped identifier (camelCase, snake_case, dotted, or a Capitalised name) with one of a few
// fixed phrasings. "where is the button" or "who calls the plumber" is a normal prompt and returns null here.
export type QuickKind = 'callers' | 'where' | 'impact';
/** `plain`: a lowercase/Capitalised word with no code shape ("who calls checkout"). It is answered only when the graph holds exactly one declaration of that name. */
export interface QuickQuestion { kind: QuickKind; name: string; plain?: boolean }

const IDENT = '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)';
const PATTERNS: { kind: QuickKind; re: RegExp }[] = [
  { kind: 'callers', re: new RegExp(`^\\s*(?:who|what)\\s+(?:all\\s+)?(?:calls|uses|invokes|references)\\s+(?:the\\s+)?(?:function\\s+|method\\s+)?\`?${IDENT}\`?\\s*(?:\\(\\))?\\s*[?.!]*\\s*$`, 'i') },
  { kind: 'callers', re: new RegExp(`^\\s*callers\\s+of\\s+\`?${IDENT}\`?\\s*[?.!]*\\s*$`, 'i') },
  { kind: 'where', re: new RegExp(`^\\s*where(?:'s|\\s+is|\\s+are)\\s+(?:the\\s+)?(?:function\\s+|method\\s+|class\\s+)?\`?${IDENT}\`?\\s*(?:\\(\\))?(?:\\s+(?:defined|declared|implemented|located))?\\s*[?.!]*\\s*$`, 'i') },
  { kind: 'where', re: new RegExp(`^\\s*(?:find|locate|go to|show me)\\s+(?:the\\s+)?(?:definition\\s+of\\s+)?\`?${IDENT}\`?\\s*[?.!]*\\s*$`, 'i') },
  { kind: 'impact', re: new RegExp(`^\\s*what\\s+(?:would\\s+)?breaks?\\s+if\\s+(?:i|we)\\s+(?:change|changes|rename|renames|delete|deletes|remove|removes)\\s+(?:the\\s+)?\`?${IDENT}\`?\\s*[?.!]*\\s*$`, 'i') },
  { kind: 'impact', re: new RegExp(`^\\s*blast\\s+radius\\s+(?:of|for)\\s+\`?${IDENT}\`?\\s*[?.!]*\\s*$`, 'i') },
];

/** A name worth asking the graph about: code-shaped, never a plain English word. */
export function isCodeName(n: string): boolean {
  if (!n || n.length < 4 || n.length > 80) return false;
  return /[a-z][A-Z]/.test(n) || n.includes('_') || n.includes('.') || /^[A-Z][a-z]+[A-Za-z0-9]*[A-Z]/.test(n);
}

// Words that are prose in these phrasings ("where is the button", "who calls this"): never looked up, even when a declaration of that name exists.
const PLAIN_STOP = new Set(('this that these those there here what which when where whose whom how why them they their then than with from into onto over '
  + 'some any all each every other another thing things stuff code file files line lines bug bugs issue issues problem part parts place '
  + 'function functions method methods class classes module modules name names value values result results item items data info '
  + 'it its is are was were the and but not for you your our out off one two page button').split(/\s+/));

/** A plain word worth ONE graph lookup (the answer then needs exactly one declaration of it): 4-40 letters/digits, not prose. */
export function isPlainName(n: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{3,39}$/.test(n) && !PLAIN_STOP.has(n.toLowerCase());
}

export function parseQuickQuestion(text: string): QuickQuestion | null {
  const t = (text || '').trim();
  if (!t || t.length > 160 || t.startsWith('/') || t.includes('\n')) return null;
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(t);
    if (m && isCodeName(m[1]!)) return { kind, name: m[1]! };
  }
  return null;
}

/**
 * The same fixed phrasings with a PLAIN word ("who calls checkout", "where is render"). Not an answer yet: the caller
 * passes it to answerQuickQuestion, which asks the graph and declines unless exactly one declaration has that name.
 */
export function parseQuickQuestionPlain(text: string): QuickQuestion | null {
  const t = (text || '').trim();
  if (!t || t.length > 160 || t.startsWith('/') || t.includes('\n')) return null;
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(t);
    if (m && !isCodeName(m[1]!) && isPlainName(m[1]!)) return { kind, name: m[1]!, plain: true };
  }
  return null;
}

export interface QuickGraph {
  status(cwd: string): Promise<{ indexed: boolean; incomplete?: boolean }>;
  callTool(name: string, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<{ text: string }>;
}
export interface QuickAnswer { text: string; kind: QuickKind; name: string; /** tokens the answer adds to the next turn, estimated */ approxTokens: number }

/** `  path: KIND name:line, …` rows of search_code -> the file whose row declares `name` (null when none does). */
export function declFile(searchText: string, name: string): string | null {
  const bare = name.split('.').pop()!;
  for (const l of (searchText || '').split('\n')) {
    const m = /^\s+(\S+?):\s+(.+)$/.exec(l);
    if (!m) continue;
    if (new RegExp(`\\b[A-Z_]+\\s+(?:[\\w$.]*\\.)?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`).test(m[2]!)) return m[1]!;
  }
  return null;
}

export interface DeclHit { file: string; kind: string; line: number }
/**
 * Declarations NAMED `name` in search_code rows (`  path: KIND name:line, KIND other:line, DOC x — text:2`): exact name only
 * (a qualified `Class.name` row counts for `name`; a longer name does not), never file or doc rows, one hit per file/line.
 */
export function exactDecls(searchText: string, name: string): DeclHit[] {
  const bare = name.split('.').pop()!;
  const out: DeclHit[] = []; const exact: DeclHit[] = []; const seen = new Set<string>();
  for (const l of (searchText || '').split('\n')) {
    const m = /^\s+(\S+?):\s+(.+)$/.exec(l);
    if (!m) continue;
    for (const e of m[2]!.split(', ')) {
      const d = /^([A-Z_]+)\s+(\S+):(\d+)$/.exec(e.trim());
      if (!d || d[1] === 'FILE' || d[1] === 'DOC') continue;
      const rowName = d[2]!;
      const full = rowName === name || rowName.endsWith('.' + name);
      // `Session.start` wants a `start` inside `Session`; an unqualified `start` row is the fallback. A bare `start` accepts any qualifier.
      if (!full && rowName !== bare && (name.includes('.') || !rowName.endsWith('.' + bare))) continue;
      const key = `${m[1]}:${d[3]}`; if (seen.has(key)) continue; seen.add(key);
      const hit = { file: m[1]!, kind: d[1]!, line: Number(d[3]) };
      out.push(hit); if (full) exact.push(hit);
    }
  }
  return name.includes('.') && exact.length ? exact : out;
}

const MAX_LINES = 14;
const MAX_CHARS = 1400;

/** Keep the first MAX_LINES lines / MAX_CHARS of a graph answer, dropping the engine's own footers. */
export function clipAnswer(text: string): string {
  const lines = (text || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !/^\s*(--- source|\(resolved from)/.test(l));
  const kept: string[] = []; let size = 0;
  for (const l of lines.slice(0, MAX_LINES)) { if (size + l.length + 1 > MAX_CHARS) break; kept.push(l); size += l.length + 1; }
  const more = lines.length - kept.length;
  return kept.join('\n') + (more > 0 ? `\n… ${more} more line(s)` : '');
}

/**
 * Answer a parsed question from the graph, or null (not indexed, no such name, error, timeout). Never starts an index; the
 * caller falls back to a normal agent turn on null.
 */
export async function answerQuickQuestion(q: QuickQuestion, cwd: string, graph: QuickGraph, opts: { timeoutMs?: number } = {}): Promise<QuickAnswer | null> {
  try {
    const budget = opts.timeoutMs ?? 5000;
    const run = <T>(p: Promise<T>): Promise<T | null> => new Promise((res) => { const t = setTimeout(() => res(null), budget); t.unref?.(); p.then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(null); }); });
    const st = await run(graph.status(cwd));
    if (!st || !st.indexed || st.incomplete) return null;
    let raw: { text: string } | null;
    if (q.plain) {
      // A plain word is a symbol only if the graph says so: exactly one declaration of exactly that name, else this is prose.
      const loc = await run(graph.callTool('search_code', { query: q.name }, { cwd, fresh: false }));
      const decls = exactDecls(loc?.text ?? '', q.name);
      if (decls.length !== 1) return null;
      const d = decls[0]!;
      if (q.kind === 'where') raw = { text: `${d.file}: ${d.kind} ${q.name}:${d.line}` };
      else if (q.kind === 'callers') raw = await run(graph.callTool('neighbours', { symbol: q.name, direction: 'in' }, { cwd, fresh: false }));
      else raw = await run(graph.callTool('blast_radius', { files_changed: [d.file] }, { cwd, fresh: false }));
    }
    else if (q.kind === 'callers') raw = await run(graph.callTool('neighbours', { symbol: q.name, direction: 'in' }, { cwd, fresh: false }));
    else if (q.kind === 'where') raw = await run(graph.callTool('search_code', { query: q.name }, { cwd, fresh: false }));
    else {
      // blast_radius takes FILES: find the declaration's file first (one cheap lookup), then ask what depends on it.
      const loc = await run(graph.callTool('search_code', { query: q.name }, { cwd, fresh: false }));
      const file = declFile(loc?.text ?? '', q.name);
      if (!file) return null;
      raw = await run(graph.callTool('blast_radius', { files_changed: [file] }, { cwd, fresh: false }));
    }
    const body = raw?.text ?? '';
    if (!body.trim() || /NO DECLARATION NAMED|not indexed|0 match/i.test(body.split('\n')[0] ?? '')) return null;
    const label = q.kind === 'callers' ? `Callers of ${q.name}` : q.kind === 'where' ? `Where ${q.name} is defined` : `Blast radius of ${q.name}`;
    const text = `Graph answer (no agent turn) — ${label}:\n${clipAnswer(body)}`;
    return { text, kind: q.kind, name: q.name, approxTokens: Math.ceil(text.length / 4) };
  } catch { return null; }
}

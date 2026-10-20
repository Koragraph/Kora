// What a search is ABOUT, from its pattern alone: one code identifier (the graph answers it better) or text (grep is
// right). Shared by the pre-tool redirect (cli/commands/hook.ts: the Grep tool AND a Bash `rg`/`grep`) and the grep/rg
// PATH shim's graph hits (cli/commands/graph.ts under KORA_SHIM_ACTIVE). Pure, apart from one stat per path argument.
import fs from 'node:fs';
import path from 'node:path';

// The graph resolves DECLARATIONS. A search whose pattern is one code identifier (createWorktree, parse_transcript,
// config.grepCap; optionally \b-wrapped or `function\s+`/`def `-prefixed) is the search the graph answers better.
// Anything else — spaces, quotes, alternation, classes, kebab-case, a plain lowercase word (config keys, log text),
// an extension, a path — is a TEXT search, and the rulebook itself says grep is the right tool for those. Measured
// (the bench rename task): denying the text grep added a deny + a retry round-trip and saved nothing.
const IDENT_PATTERN_RE = /^(?:\\b)?(?:(?:function|class|def|const|fn|func)(?:\\s[+*]|\s+))?([A-Za-z_][A-Za-z0-9_.]*)(?:\\b)?$/;

/** The identifier a search pattern names, or null when the pattern is text (see above). */
export function identifierOf(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return null;
  const m = IDENT_PATTERN_RE.exec(pattern.trim().replace(/\\\./g, '.')); // `foo\.bar` is the escaped dotted form
  if (!m) return null;
  const id = m[1];
  if (id.length < 4 || /^[._]|[._]$/.test(id)) return null;
  // camelCase / PascalCase / snake_case / dotted. A plain lowercase or ALLCAPS word is prose, not a symbol.
  return /[a-z][A-Z]/.test(id) || /^[A-Z][a-z]/.test(id) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(id) || /[A-Za-z0-9]\.[A-Za-z0-9]/.test(id) ? id : null;
}
export function isIdentifierPattern(pattern: unknown): boolean { return identifierOf(pattern) !== null; }

// Shell words of one simple command line, quotes honoured; null for anything this does not read with confidence
// (command substitution, heredocs, redirection into a file, several lines).
function shellWords(s: string): { words: string[]; ops: string[] } | null {
  if (/[\n`]|\$\(|<<|<\(/.test(s)) return null;
  const words: string[] = []; const ops: string[] = [];
  let cur = ''; let has = false; let q: '"' | "'" | null = null;
  const push = () => { if (has) words.push(cur); cur = ''; has = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length && '$`"\\'.includes(s[i + 1]!)) cur += s[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(); words.push(two); ops.push(two); i++; continue; }
    if (c === ';' || c === '|' || c === '&') { push(); words.push(c); ops.push(c); continue; }
    if (c === '>' || c === '<') return null;
    cur += c; has = true;
  }
  if (q) return null;
  push();
  return { words, ops };
}

const OPS = new Set(['&&', '||', ';', '|', '&']);
/** Read-only filters a search may be piped through (`| head`, `| wc -l`, `| grep -v node_modules`) and still be just that search. */
const PIPE_OK = new Set(['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'grep', 'rg']);
/** Flags that take the next word as their value, per tool (the `=value` and attached `-A3` forms are one word). */
const RG_VALUE_FLAGS = new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-m', '--max-count', '-M', '--max-columns', '-j', '--threads', '-d', '--max-depth', '--max-filesize', '-E', '--encoding', '--sort', '--sortr', '--type-add', '-r', '--replace']);
const GREP_VALUE_FLAGS = new Set(['-A', '-B', '-C', '-m', '-d', '-D', '--include', '--exclude', '--exclude-dir', '--context', '--max-count']);

/**
 * The pattern of a Bash command that is ONE code search over directories: `rg -n createWorktree src`,
 * `cd pkg && grep -rn "parse_transcript" . | head`. Null for everything else — a compound command (the deny would
 * cost its other parts too), a search in named files only (reading a file the agent already located; the graph
 * saves nothing there), a non-recursive grep, several `-e` patterns, a pattern file.
 */
export function bashSearchPattern(command: unknown, cwd: string): string | null {
  if (typeof command !== 'string' || command.length > 500) return null;
  const sw = shellWords(command.trim()); if (!sw) return null;
  // segments between operators
  const segs: { words: string[]; op: string | null }[] = [{ words: [], op: null }];
  for (const w of sw.words) { if (OPS.has(w)) segs.push({ words: [], op: w }); else segs[segs.length - 1]!.words.push(w); }
  let dir = cwd; let i = 0;
  // leading `cd <dir> &&`
  while (i < segs.length && segs[i]!.words[0] === 'cd' && segs[i]!.words.length === 2 && segs[i + 1]?.op === '&&') { dir = path.resolve(dir, segs[i]!.words[1]!); i++; }
  const search = segs[i]; if (!search || !search.words.length) return null;
  for (let j = i + 1; j < segs.length; j++) if (segs[j]!.op !== '|' || !PIPE_OK.has(segs[j]!.words[0] ?? '')) return null;
  const [cmd, ...args] = search.words;
  const tool = path.basename(cmd!);
  if (tool !== 'rg' && tool !== 'grep' && tool !== 'egrep') return null;
  const valueFlags = tool === 'rg' ? RG_VALUE_FLAGS : GREP_VALUE_FLAGS;
  const pats: string[] = []; const paths: string[] = []; let recursive = tool === 'rg'; let ended = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a.length > 1) {
      if (a === '-e' || a === '--regexp') { const v = args[++k]; if (v == null) return null; pats.push(v); continue; }
      if (a.startsWith('--regexp=')) { pats.push(a.slice(9)); continue; }
      if (a === '-f' || a.startsWith('--file')) return null;
      if (tool !== 'rg' && (a === '-r' || a === '-R' || a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a))) recursive = true;
      if (valueFlags.has(a)) k++;
      continue;
    }
    if (!pats.length) pats.push(a); else paths.push(a);
  }
  if (pats.length !== 1 || !recursive) return null;
  // Only named files: the agent already knows where to look.
  if (paths.length && paths.every((p) => { try { return fs.statSync(path.resolve(dir, p)).isFile(); } catch { return false; } })) return null;
  return pats[0]!;
}

/**
 * The shim's graph hits, cut to the ones that declare the searched identifier. `search_code` ranks by text, so a
 * search for `CLAUDE_CONFIG_DIR` came back as `METHOD write` (a docstring mentioned it): measured on 14 days of
 * transcripts, those lines were 21–24% of a shimmed search's output and named the identifier in none of the samples.
 * Null when nothing is left.
 */
export function shimHits(text: string, symbol: string): string | null {
  const name = (symbol.split('.').pop() || symbol).toLowerCase();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declares = new RegExp(`(^|[\\s.])${esc}:\\d+$`, 'i');
  const lines: string[] = [];
  for (const l of text.split('\n')) {
    const m = /^(\s+\S[^:]*:)\s(.*)$/.exec(l); if (!m) continue;
    const keep = Array.from(new Set(m[2]!.split(', ').filter((e) => declares.test(e.trim()))));
    if (keep.length) lines.push(`${m[1]} ${keep.join(', ')}`);
  }
  if (!lines.length) return null;
  return [`${lines.length} file(s) declare ${symbol}:`, ...lines].join('\n');
}

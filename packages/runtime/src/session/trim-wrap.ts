// Which Bash commands `kora trim-run` may wrap (SAV-D, 2026-10-15). The CLI reports a command that exits non-zero as
// PostToolUseFailure, and that hook cannot replace the output; a failing test run or build is exactly the big output worth
// trimming. So the PreToolUse hook rewrites a recognised test / build runner to run under `kora trim-run`, which runs it
// unchanged and prints the trimmed output itself (session/trim-run.ts).
//
// The rewrite changes as little as possible. The command line is split at its top-level `&&`, and only the segments that are a
// runner get the wrapper put in front of the program word: `cd pkg && pnpm test` becomes `cd pkg && node kora.js trim-run … -- pnpm test`.
// The outer shell therefore still runs `cd`, env assignments, globs and quoting exactly as before, and a `cd` still persists. Nothing
// is re-quoted: the segment text after the wrapper is the model's own text.
//
// Anything the rewrite could change the meaning of is refused (null): a pipe, `;`, `||`, a redirect other than `2>&1`, a subshell,
// a command substitution, a here-doc, a background `&`, a comment, a newline. A runner whose output goes into a file or another
// program must stay byte-exact; `npm test | tail -50` is already short.

export const TRIM_RUN_MARK = 'trim-run';

export interface Word { readonly raw: string; readonly text: string; readonly start: number }

/** Split into top-level `&&` segments; null when the line contains anything the wrapper cannot keep intact. */
export function splitAndAnd(command: string): string[] | null {
  const segs: string[] = [];
  let seg = '';
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    if (c === "'") { const j = command.indexOf("'", i + 1); if (j < 0) return null; seg += command.slice(i, j + 1); i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        const d = command[j]!;
        if (d === '\\') { j++; continue; }
        if (d === '`' || (d === '$' && command[j + 1] === '(')) return null;
        if (d === '"') break;
      }
      if (j >= n) return null;
      seg += command.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\\') { if (i + 1 >= n || command[i + 1] === '\n') return null; seg += command.slice(i, i + 2); i += 2; continue; }
    if (c === '&') {
      if (command[i + 1] === '&') { segs.push(seg); seg = ''; i += 2; continue; }
      return null;
    }
    if (c === '>') {
      // only a literal ` 2>&1` (stderr onto stdout) is allowed; it applies to the wrapper, which prints the program's output.
      if (command.startsWith('>&1', i) && seg.endsWith('2') && /(^|\s)2$/.test(seg) && /^(\s|$)/.test(command.slice(i + 3))) { seg += '>&1'; i += 3; continue; }
      return null;
    }
    if (c === '|' || c === ';' || c === '<' || c === '(' || c === ')' || c === '{' || c === '}' || c === '`' || c === '\n' || c === '\r' || c === '!') return null;
    if (c === '$' && command[i + 1] === '(') return null;
    if (c === '#' && (seg === '' || /\s$/.test(seg))) return null;
    seg += c; i++;
  }
  segs.push(seg);
  return segs;
}

/** The words of one segment, with quotes removed from `text` and the offset of each word's first character. */
export function segmentWords(seg: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  const n = seg.length;
  while (i < n) {
    while (i < n && /\s/.test(seg[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let text = '';
    while (i < n && !/\s/.test(seg[i]!)) {
      const c = seg[i]!;
      if (c === "'") { const j = seg.indexOf("'", i + 1); const e = j < 0 ? n : j; text += seg.slice(i + 1, e); i = e + 1; continue; }
      if (c === '"') { let j = i + 1; let t = ''; for (; j < n && seg[j] !== '"'; j++) { if (seg[j] === '\\' && j + 1 < n) j++; t += seg[j]; } text += t; i = j + 1; continue; }
      if (c === '\\' && i + 1 < n) { text += seg[i + 1]; i += 2; continue; }
      text += c; i++;
    }
    words.push({ raw: seg.slice(start, i), text, start });
  }
  return words;
}

const SCRIPT = /^(?:test|tests|t|build|builds|compile|lint|typecheck|type-check|tsc|check|ci|e2e|verify|qa|canary|test:[\w:.-]+|build:[\w:.-]+|lint:[\w:.-]+|typecheck:[\w:.-]+|check:[\w:.-]+|e2e:[\w:.-]+|ci:[\w:.-]+)$/;
/** Tools that run once and exit whatever their arguments. */
const NODE_TOOLS_ALWAYS = new Set(['vitest', 'jest', 'mocha', 'tsc', 'eslint', 'oxlint', 'biome', 'prettier', 'ava', 'tap', 'knip', 'stylelint', 'tsgo', 'rollup', 'esbuild']);
/** Tools with a dev server / watch default: only these subcommands are a one-shot run. */
const NODE_TOOLS_SUB: Record<string, readonly string[]> = {
  vite: ['build'], next: ['build', 'lint'], nuxt: ['build', 'generate'], astro: ['build', 'check'], ng: ['build', 'test', 'lint'], parcel: ['build'],
  playwright: ['test'], cypress: ['run'], turbo: ['run', 'build', 'test', 'lint', 'typecheck'], nx: ['run', 'build', 'test', 'lint', 'run-many', 'affected'],
  vp: ['test', 'run', 'build', 'check', 'lint', 'fmt'], webpack: ['build'],
};
const nodeToolIsRunner = (tool: string, sub: string[]): boolean => NODE_TOOLS_ALWAYS.has(tool) || (NODE_TOOLS_SUB[tool]?.includes(sub[0] ?? '') ?? false);
/** A watch mode or a dev server never exits: the wrapper would hold its output until the CLI kills it. */
const WATCHY = /^(?:--watch\S*|--serve|--dev|--hot|serve|dev|watch|start)$/;
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--workspaces-filter', '--config', '--registry']);
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function pmIsRunner(args: string[]): boolean {
  const rest: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '--') break;
    if (a.startsWith('-')) { if (PM_VALUE_FLAGS.has(a)) k++; continue; }
    rest.push(a);
  }
  const first = rest[0];
  if (!first) return false;
  if (first === 'run' || first === 'run-script' || first === 'r') return rest[1] !== undefined && SCRIPT.test(rest[1]);
  if (first === 'exec' || first === 'x' || first === 'dlx') return rest[1] !== undefined && nodeToolIsRunner(rest[1].replace(/^.*\//, ''), rest.slice(2));
  return SCRIPT.test(first);
}

/** True for a program word + arguments that is a test / build / typecheck / lint runner. */
export function isRunnerWords(words: string[]): boolean {
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!)) k++; // leading VAR=value
  const prog = (words[k] ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|js)$/i, '');
  const args = words.slice(k + 1);
  if (!prog) return false;
  if (args.some((a) => WATCHY.test(a)) || (!PM.has(prog) && args.includes('-w'))) return false;
  const sub = args.filter((a) => !a.startsWith('-'));
  if (PM.has(prog)) return pmIsRunner(args);
  if (prog === 'npx' || prog === 'bunx') { const tool = sub[0]?.replace(/^.*\//, ''); return tool !== undefined && nodeToolIsRunner(tool, sub.slice(1)); }
  if (nodeToolIsRunner(prog, sub)) return true;
  switch (prog) {
    case 'pytest': case 'py.test': case 'tox': case 'nox': case 'mypy': case 'pyright': case 'ruff': case 'rspec': case 'phpunit': case 'ctest': case 'xcodebuild': return true;
    case 'python': case 'python3': { const m = args.indexOf('-m'); return m >= 0 && ['pytest', 'unittest', 'mypy', 'pyright', 'ruff', 'tox', 'nose2'].includes(args[m + 1] ?? ''); }
    case 'node': return args.includes('--test') || args.some((a) => a.startsWith('--test'));
    case 'cargo': return ['test', 'build', 'check', 'clippy', 'bench', 'nextest'].includes(sub[0] ?? '');
    case 'go': return ['test', 'build', 'vet'].includes(sub[0] ?? '');
    case 'make': case 'gmake': case 'ninja': return true;
    case 'gradle': case 'gradlew': return sub.some((a) => /^(?:test|build|check|assemble|compile\w*|ktlint\w*|lint\w*)$/.test(a)) || sub.length === 0;
    case 'mvn': case 'mvnw': return sub.some((a) => /^(?:test|package|verify|compile|install|clean)$/.test(a));
    case 'dotnet': return ['test', 'build', 'publish'].includes(sub[0] ?? '');
    case 'swift': return ['test', 'build'].includes(sub[0] ?? '');
    case 'bundle': return sub[0] === 'exec' && ['rspec', 'rake'].includes(sub[1] ?? '');
    case 'rake': return true;
    default: return false;
  }
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface WrapSpec { node: string; kora: string; home: string; thread: string }
export const wrapperPrefix = (w: WrapSpec): string => `${shQuote(w.node)} ${shQuote(w.kora)} ${TRIM_RUN_MARK} --home ${shQuote(w.home)} --thread ${shQuote(w.thread)} --`;

/**
 * The command with every runner segment run under the wrapper, or null when nothing should change (no runner, or a shape the
 * rewrite cannot keep intact). Pure.
 */
export function wrapRunnerCommand(command: string, w: WrapSpec): string | null {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) return null;
  const segs = splitAndAnd(command);
  if (!segs) return null;
  const prefix = wrapperPrefix(w);
  let changed = false;
  const out = segs.map((seg) => {
    const words = segmentWords(seg);
    if (!isRunnerWords(words.map((x) => x.text))) return seg;
    // env assignments stay in front of the wrapper (they reach it, and it passes its environment on); the wrapper goes before the program word
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.text)) k++;
    const at = words[k]!.start;
    changed = true;
    return `${seg.slice(0, at)}${prefix} ${seg.slice(at)}`;
  });
  return changed ? out.join('&&') : null;
}

/** The model's own command, for an approval card or a log line: undoes wrapRunnerCommand. */
export function unwrapRunnerCommand(command: string): string {
  if (!command.includes(` ${TRIM_RUN_MARK} --home `)) return command;
  return command.replace(/'[^']*(?:'\\''[^']*)*' '[^']*(?:'\\''[^']*)*' trim-run --home '[^']*(?:'\\''[^']*)*' --thread '[^']*(?:'\\''[^']*)*' -- /g, '');
}

/** True when the tool output is something `kora trim-run` already trimmed (the PostToolUse hook leaves it alone). */
export const alreadyTrimmed = (text: string): boolean => text.includes('[Kora compressed this output (');

// Content-aware compression of Bash tool output (savings lever, overnight 2026-10-14). The 8,000-char head/tail trim in
// bash-trim.ts only reaches ~5% of Bash results, but Bash is the biggest text tool output by far, and every character that
// stays in a result is re-billed on every later call of the thread (one cache write at 2x, then a cache read each call until
// a compaction). So this file looks at the SHAPE of an output and removes only what a reader never needs:
//   - terminal noise: ANSI escapes, and a `\r`-rewritten progress line collapses to its final state
//   - test runners (node:test spec/TAP, vitest/jest/mocha, pytest, go test, cargo test): the passing-test lines go, the summary
//     counts, every failure with its assertion text and the top of its stack stay
//   - package-manager progress (pnpm/npm/yarn/pip/cargo/go/docker): resolution + download lines go, warnings and the summary stay
//   - runs of identical lines (or identical but for digits / timestamps) fold into one line + a count
//   - warning lines that differ only in numbers / paths / quoted names fold into their first occurrence + a count, wherever they sit
//     in the output (a warning-heavy build: every line "matches IMPORTANT" and nothing else could shrink it). A line that mentions
//     error / fail / panic / ... is never folded, and neither is a plain line: rows that differ in an id are content
//   - fallback: the old head / error lines / tail trim, only when no shape matched and the text is over 8,000 chars
//
// Rules the tests pin: nothing under COMPRESS_MIN_CHARS changes; a line matching IMPORTANT (error / fail / warning ...) is never
// dropped by any shape compressor (the head/tail FALLBACK is the old behaviour and keeps its 80-line cap); the result must save
// at least 20% INCLUDING the footer the hook adds; output of file-viewing commands (cat, sed -n, rg, git diff ...) is only
// cleaned of escapes, because the agent asked for exactly those lines. Pure and synchronous; any exception or a blown time
// budget returns null (the caller then passes the original through).
//
// Measured out, not shipped: a compiler-diagnostics folder (tsc / eslint) and a large-JSON skeleton were built and tested, then
// removed because 14 days of real transcripts had no tsc/eslint output they could shrink (Bash runs them without a TTY, so there
// is no --pretty snippet text and every diagnostic line is distinct) and exactly one JSON dump (lossy, 0.01% of the bill).

export const COMPRESS_MIN_CHARS = 2000;
export const COMPRESS_MIN_SAVE = 0.2;
/** What the hook's footer costs, charged against the saving so a tiny win is not taken. */
export const FOOTER_RESERVE = 240;
export const TRIM_MIN_CHARS = 8000;
export const KEEP_HEAD_LINES = 40;
export const KEEP_TAIL_LINES = 60;
export const MAX_INPUT_CHARS = 2_000_000;
const BUDGET_MS = 400;
const MAX_ERROR_LINES = 80;
const MAX_LINE_CHARS = 300;
const KEEP_STACK_FRAMES = 3;

/** Lines worth keeping from anywhere in a log. */
export const IMPORTANT = /\b(error|errors|fail|failed|failure|failing|fatal|panic|exception|traceback|warn|warning|assert(?:ion)?|not ok|denied|cannot|unable)\b|✖|✗|✘|ERR!/i;
/** IMPORTANT minus plain warnings: these lines are never dropped or folded by anything but the old head / tail fallback's own cap. */
export const ERRORISH = /\b(error|errors|fail|failed|failure|failing|fatal|panic|exception|traceback|assert(?:ion)?|not ok|denied|cannot|unable)\b|✖|✗|✘|ERR!/i;
/** A warning that says nothing about an error: the only IMPORTANT lines a repeat fold may shorten. */
export const isWarningOnly = (l: string): boolean => IMPORTANT.test(l) && !ERRORISH.test(l);

export interface CompressResult {
  /** the compressed text, without the footer that names the spill file */
  readonly text: string;
  /** what was applied, in order: clean, test-<runner>, pkg-noise, repeats, head-tail */
  readonly compressor: string;
  /** one sentence for the footer: what was removed and what was kept */
  readonly note: string;
  readonly totalLines: number;
  /** lines in the result that match IMPORTANT */
  readonly keptErrorLines: number;
  readonly savedChars: number;
}

export interface CompressOptions {
  /** the Bash command line, when known: file-viewing commands are only cleaned */
  command?: string;
  /** tests use a lower floor than COMPRESS_MIN_CHARS */
  minChars?: number;
  budgetMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------- helpers

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()][0-9A-Za-z]|${ESC}[=>78]`, 'g');

/** ANSI escapes out; a line rewritten with `\r` (progress bar, spinner) keeps only its final non-empty state. */
export function stripTerminalNoise(s: string): string {
  if (!s.includes(ESC) && !s.includes('\r')) return s;
  let t = s.includes(ESC) ? s.replace(ANSI_RE, '') : s;
  if (t.includes('\r')) {
    t = t.split('\n').map((l) => {
      if (!l.includes('\r')) return l;
      const segs = l.split('\r');
      let last = segs.length - 1;
      while (last >= 0 && !segs[last]!.trim()) last--;
      if (last < 0) return '';
      // an error printed before a redraw is still an error: it keeps its own line
      return [...segs.slice(0, last).filter((x) => IMPORTANT.test(x)), segs[last]!].join('\n');
    }).join('\n');
  }
  return t;
}

class Budget {
  private n = 0;
  constructor(private readonly deadline: number) {}
  tick(): void { if ((++this.n & 255) === 0 && Date.now() > this.deadline) throw new Error('compress budget'); }
  check(): void { if (Date.now() > this.deadline) throw new Error('compress budget'); }
}

interface Stage { readonly name: string; readonly lines: string[]; readonly note: string }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------------------------------------ file-viewing commands

const VIEW_PROGS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'bat', 'nl', 'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'ls', 'tree', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'curl', 'wget', 'echo', 'printf', 'diff', 'xxd', 'strings', 'od', 'stat', 'file', 'du', 'git', 'gh', 'column', 'fd']);
const SKIP_PROGS = new Set(['cd', 'export', 'set', 'source', '.', 'true', 'unset', 'pushd', 'popd', 'mkdir', 'sudo', 'env', 'time', 'nohup', 'then', 'do', 'done', 'fi', 'else', 'if', 'for', 'while']);
// `kora graph explore|search_code|neighbours|...`: the agent asked the graph for exactly these declarations
const KORA_GRAPH_VIEW = /^kora(?:-dev)?(?:\.js)?\s+graph\s/;
const GIT_VIEW = /^git\s+(?:-\S+\s+)*(?:diff|show|log|blame|grep|status|ls-files|ls-tree|cat-file|branch|tag|reflog|shortlog|remote|config)\b/;

/** True when every program on the command line only prints something that already exists (so its output IS the content). */
export function isViewingCommand(command: string | undefined): boolean {
  if (!command) return false;
  const progs: boolean[] = [];
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const toks = seg.trim().split(/\s+/);
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]!)) toks.shift();
    const first = toks[0];
    if (!first) continue;
    const prog = first.replace(/^.*\//, '');
    if (SKIP_PROGS.has(prog)) continue;
    progs.push((VIEW_PROGS.has(prog) && (prog !== 'git' || GIT_VIEW.test(toks.join(' ')))) || KORA_GRAPH_VIEW.test([prog, ...toks.slice(1)].join(' ')));
  }
  return progs.length > 0 && progs.every(Boolean);
}

// ----------------------------------------------------------------------------------------------------------- test runners

const PASS_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'node', re: /^\s*✔ .*\(\d+(?:\.\d+)?ms\)\s*$/ },
  { name: 'tap', re: /^\s*ok \d+ - / },
  { name: 'js', re: /^\s*[✓✔√] / },
  { name: 'pytest', re: /^\S+::\S+ PASSED\b/ },
  { name: 'pytest', re: /^\S+\.py\s+[.s]+\s*(?:\[\s*\d+%\])?\s*$/ },
  { name: 'go', re: /^\s*--- PASS: / },
  { name: 'go', re: /^=== (?:RUN|PAUSE|CONT|NAME)\s/ },
  { name: 'cargo', re: /^test \S+ \.\.\. ok$/ },
];
const TEST_SUMMARY = /(?:^|\s)(?:# (?:pass|tests|fail)\b|ℹ (?:tests|pass|fail)\b|Tests?:?\s+\d|\d+ passed|\d+ passing|test result:|collected \d+ items?|Test Files)|^(?:PASS|FAIL|ok)\s/m;
const TEST_STRUCTURE = /^\s*(?:# Subtest:|▶ )/;
const STACK_FRAME = /^\s+at \S/;
/** a frame inside a dependency or the runtime (the caller's own first frame below them is the one worth reading) */
const LIB_FRAME = /node_modules|\(node:|\bat node:|\(internal\//;

function filterTests(lines: string[], text: string, b: Budget): Stage | null {
  if (!TEST_SUMMARY.test(text)) return null;
  const out: string[] = [];
  const counts: Record<string, number> = {};
  let run = 0, dropped = 0, frames = 0, droppedFrames = 0, ownFrame = false, yamlIndent = -1, yamlNext = false;
  const flushRun = (): void => { if (run) { out.push(`[... ${plural(run, 'passing-test line')} omitted ...]`); run = 0; } };
  const noteFrames = (): void => { if (droppedFrames) { out.push(`      ... (${plural(droppedFrames, 'more stack frame')} omitted)`); droppedFrames = 0; } };
  const flushFrames = (): void => { noteFrames(); frames = 0; ownFrame = false; };
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  for (const l of lines) {
    b.tick();
    // a YAML block ends at its `...`, or at the first line indented less than its `---` (an unclosed block must not swallow the rest)
    if (yamlIndent >= 0 && (!l.trim() || indentOf(l) >= yamlIndent)) { dropped++; if (/^\s+\.\.\.\s*$/.test(l)) yamlIndent = -1; continue; }
    yamlIndent = -1;
    if (yamlNext && /^\s+---\s*$/.test(l)) { yamlIndent = indentOf(l); dropped++; continue; }
    yamlNext = false;
    const important = IMPORTANT.test(l);
    if (!important) {
      const rule = PASS_RULES.find((r) => r.re.test(l));
      if (rule) { flushFrames(); counts[rule.name] = (counts[rule.name] ?? 0) + 1; run++; dropped++; if (rule.name === 'tap') yamlNext = true; continue; }
      if (TEST_STRUCTURE.test(l)) { dropped++; continue; }
      if (STACK_FRAME.test(l)) {
        const own = !LIB_FRAME.test(l);
        if (++frames > KEEP_STACK_FRAMES && (ownFrame || !own)) { droppedFrames++; dropped++; continue; }
        if (own) { ownFrame = true; noteFrames(); }
      } else if (frames) flushFrames();
    } else if (frames && !STACK_FRAME.test(l)) flushFrames();
    flushRun();
    out.push(l);
  }
  flushFrames(); flushRun();
  const passing = Object.values(counts).reduce((a, c) => a + c, 0);
  if (passing < 5) return null;
  const top = Object.entries(counts).sort((a, c) => c[1] - a[1])[0]![0];
  return { name: `test-${top}`, lines: out, note: `dropped ${plural(passing, 'passing-test line')}${dropped > passing ? ' and trailing stack frames' : ''}; summary counts, failures with their assertion text, the top of each stack and every line mentioning error, fail or warning are kept` };
}

// ------------------------------------------------------------------------------------------------- package-manager noise

const PM_NOISE: readonly RegExp[] = [
  /^Progress: resolved \d+/, /^Packages: [+-]\d+/, /^[+-]{3,}\s*$/, /^Lockfile is up to date/, /^Already up to date/, /^Scope: /,
  /^npm (?:http|timing|verb|sill)\b/, /^\[\d+\/\d+\] /, /^info (?:Visiting|Resolving|Fetching|Linking|Direct)/, /^➤ YN0000: [·┌└├]/,
  /^\s*(?:Collecting|Downloading|Using cached|Obtaining|Preparing metadata|Installing build dependencies|Getting requirements|Building wheel|Created wheel|Stored in directory|Requirement already satisfied|Running setup\.py|Attempting uninstall|Found existing|Uninstalling|Successfully uninstalled)\b/,
  /^\s+(?:Compiling|Downloaded|Downloading|Fresh|Blocking|Updating|Locking|Adding|Fetching|Unpacking|Packaging) \S/,
  /^go: (?:downloading|finding|extracting) /,
  /^\s*[━─▪█▓▒░#=]{8,}.*\d+%/,
  /^(?:Get|Hit|Ign|Fetched|Selecting|Preparing to unpack|Unpacking|Setting up|Processing triggers)[: ]/,
  /^==> (?:Downloading|Pouring|Fetching)/,
  /^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists)/,
];

function filterPackageNoise(lines: string[], b: Budget): Stage | null {
  const out: string[] = [];
  let run = 0, total = 0;
  const flush = (): void => { if (run) { out.push(`[... ${plural(run, 'package-manager progress line')} omitted ...]`); run = 0; } };
  for (const l of lines) {
    b.tick();
    if (!IMPORTANT.test(l) && PM_NOISE.some((r) => r.test(l))) { run++; total++; continue; }
    flush();
    out.push(l);
  }
  flush();
  if (total < 6) return null;
  return { name: 'pkg-noise', lines: out, note: `dropped ${plural(total, 'package-manager progress line')} (resolving, downloading, linking); warnings, errors and the install summary are kept` };
}

// ----------------------------------------------------------------------------------------------------------------- repeats

const meaningful = (l: string): boolean => l.replace(/\s+/g, '').length >= 6;
/** Lines identical but for numbers fold only when there is text around the numbers (a log line); a row of numbers is the content. */
const wordy = (l: string): boolean => (l.match(/\p{L}/gu)?.length ?? 0) >= 6; // any script: a Japanese log line folds like an English one
const repeatKey = (l: string, similar: boolean): string => (IMPORTANT.test(l) || !similar || !wordy(l) ? l : l.replace(/\d+/g, '#'));

/** `similar: false` folds exact repeats only (a test run: `✕ divides 3 by zero` is a failing test, not a timestamp). */
function collapseRepeats(lines: string[], b: Budget, similar = true): Stage | null {
  const out: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length;) {
    b.tick();
    const l = lines[i]!;
    if (!meaningful(l)) { out.push(l); i++; continue; }
    const key = repeatKey(l, similar);
    let j = i + 1;
    while (j < lines.length && repeatKey(lines[j]!, similar) === key) j++;
    const n = j - i;
    let identical = true;
    for (let k = i + 1; k < j; k++) if (lines[k] !== l) { identical = false; break; }
    if (identical && n >= 3) { out.push(`${l}  (repeated ${n} times)`); removed += n - 1; }
    else if (!identical && n >= 4) { out.push(l, `[... ${n - 2} similar lines omitted: identical but for numbers / timestamps ...]`, lines[j - 1]!); removed += n - 3; }
    else for (let k = i; k < j; k++) out.push(lines[k]!);
    i = j;
  }
  if (!removed) return null;
  return { name: 'repeats', lines: out, note: `${plural(removed, 'repeated line')} folded (identical, or identical but for numbers / timestamps)` };
}

// ------------------------------------------------------------------------------------------------------- template folding

const TPL_PATH = /\S*[/\\]\S*/g;
const TPL_QUOTED = /(['"`])(?:(?!\1)[^\n]){1,80}\1/g;
const TPL_FILE = /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|css|scss|json|vue|svelte|rb|php)\b/g;
/** The line with its numbers, paths, file names and quoted names blanked: two warnings of one template have the same text. */
export function lineTemplate(l: string): string {
  return l.replace(TPL_QUOTED, '<q>').replace(TPL_PATH, '<p>').replace(TPL_FILE, '<f>').replace(/0x[0-9a-f]+|\d+/gi, '#').replace(/\s+/g, ' ').trim();
}

/** A warning template folds from this many occurrences. */
const WARN_FOLD_MIN = 3;

/**
 * Non-adjacent folding: every warning of a template after its first occurrence goes, and one note after the first says how many.
 * Only warning-only lines are eligible (a line that mentions error / fail / ... never is), and no plain line: a table of rows
 * that differ in an id is content, not a repeat (the adjacent-run fold in collapseRepeats keeps its own rules for those).
 */
function foldWarnings(lines: string[], b: Budget): Stage | null {
  const groups = new Map<string, { first: number; count: number }>();
  const keys: Array<string | null> = new Array(lines.length).fill(null);
  for (let i = 0; i < lines.length; i++) {
    b.tick();
    const l = lines[i]!;
    if (!meaningful(l) || !isWarningOnly(l)) continue;
    const k = lineTemplate(l);
    if ((k.match(/\p{L}/gu)?.length ?? 0) < 6) continue;
    keys[i] = k;
    const g = groups.get(k);
    if (g) g.count++; else groups.set(k, { first: i, count: 1 });
  }
  let removed = 0, folded = 0;
  for (const g of groups.values()) if (g.count >= WARN_FOLD_MIN) { removed += g.count - 1; folded++; }
  if (!removed) return null;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    b.tick();
    const k = keys[i];
    const g = k ? groups.get(k) : undefined;
    if (!g || g.count < WARN_FOLD_MIN) { out.push(lines[i]!); continue; }
    if (g.first !== i) continue;
    out.push(lines[i]!, `[... ${g.count - 1} more lines like the one above (identical but for numbers / paths / names) omitted ...]`);
  }
  return { name: 'warn-fold', lines: out, note: `${plural(removed, 'repeated line')} in ${plural(folded, 'group')} folded into the first line of each (identical but for numbers / paths / names; warnings only, never a line mentioning error or failure)` };
}

// ------------------------------------------------------------------------------------------------------- head / tail fallback

export interface TrimResult {
  readonly text: string;
  readonly totalLines: number;
  readonly omittedLines: number;
  readonly keptErrorLines: number;
  readonly savedChars: number;
}

/** The old trim: first 40 lines, the lines mentioning errors (up to 80), last 60. Null when small or when it saves under a fifth. Pure. */
export function headTailTrim(raw: string): TrimResult | null {
  if (typeof raw !== 'string' || raw.length <= TRIM_MIN_CHARS) return null;
  const lines = raw.split('\n');
  if (lines.length <= KEEP_HEAD_LINES + KEEP_TAIL_LINES + 10) return null; // a few very long lines: nothing to drop by line
  const head = lines.slice(0, KEEP_HEAD_LINES);
  const tail = lines.slice(lines.length - KEEP_TAIL_LINES);
  const middle = lines.slice(KEEP_HEAD_LINES, lines.length - KEEP_TAIL_LINES);
  const important = middle.filter((l) => IMPORTANT.test(l)).slice(0, MAX_ERROR_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}...` : l));
  const omitted = middle.length - important.length;
  const parts = [...head, `[... ${omitted} line${omitted === 1 ? '' : 's'} omitted${important.length ? '; lines with error, fail or warning kept below' : ''} ...]`, ...important, ...(important.length ? ['[... end of kept lines ...]'] : []), ...tail];
  const text = parts.join('\n');
  const savedChars = raw.length - text.length;
  if (savedChars < raw.length * 0.2) return null;
  return { text, totalLines: lines.length, omittedLines: omitted, keptErrorLines: important.length, savedChars };
}

// ---------------------------------------------------------------------------------------------------------------- entry

/** Null when the output is small, is left alone by design, or compressing it would not save a fifth (footer included). Never throws. */
export function compressBashOutput(raw: string, opts: CompressOptions = {}): CompressResult | null {
  try {
    if (typeof raw !== 'string') return null;
    const min = opts.minChars ?? COMPRESS_MIN_CHARS;
    if (raw.length < min || raw.length > MAX_INPUT_CHARS) return null;
    const b = new Budget(Date.now() + (opts.budgetMs ?? BUDGET_MS));
    const viewing = isViewingCommand(opts.command);
    const steps: string[] = [];
    const notes: string[] = [];

    let text = stripTerminalNoise(raw);
    if (text !== raw) { steps.push('clean'); notes.push('terminal escape codes and progress-bar redraws removed'); }
    let lines: string[] | null = null;
    let shaped = false;
    const rawLines = text.split('\n').length; // the footer's "Original: N lines" is the input, not what was kept

    if (!viewing) {
      lines = text.split('\n');
      b.check();
      const s = filterTests(lines, text, b) ?? filterPackageNoise(lines, b);
      if (s) { lines = s.lines; steps.push(s.name); notes.push(s.note); shaped = true; }
      const r = collapseRepeats(lines, b, !s?.name.startsWith('test-'));
      if (r) { lines = r.lines; steps.push(r.name); notes.push(r.note); }
      const w = foldWarnings(lines, b);
      if (w) { lines = w.lines; steps.push(w.name); notes.push(w.note); }
      text = lines.join('\n');
    }

    let totalLines = rawLines;
    if (!shaped) {
      const ht = headTailTrim(text);
      if (ht) { text = ht.text; steps.push('head-tail'); notes.push(`kept the first ${KEEP_HEAD_LINES} lines, the lines mentioning errors, failures or warnings, and the last ${KEEP_TAIL_LINES}`); totalLines = ht.totalLines; }
    }
    if (!steps.length) return null;
    if (raw.length - text.length - FOOTER_RESERVE < raw.length * COMPRESS_MIN_SAVE) return null;
    const keptErrorLines = text.split('\n').reduce((n, l) => n + (IMPORTANT.test(l) ? 1 : 0), 0);
    return { text, compressor: steps.join('+'), note: notes.join('; '), totalLines, keptErrorLines, savedChars: raw.length - text.length };
  } catch { return null; }
}

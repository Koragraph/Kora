// The one piece of prose every channel repeats: how to reach the graph from inside a pane. Used by
// the session brief, the managed instruction block, --append-system-prompt and the hook nudges.
// Keep it short — it is paid on every turn in the instruction-file channel.

export const GRAPH_COMMANDS: Array<[string, string]> = [
  ['kora graph explore "<symbol or plain english>"', 'start here — ranked declarations + source, callers, callees in one call'],
  ['kora graph blast_radius --file <path>', 'BEFORE editing a file: what depends on it, what is untested'],
  ['kora graph neighbours X', 'exact callers/callees of one symbol (--direction in|out|both)'],
  ['kora graph search_code X', 'locate a declaration by name/path/description'],
  ['kora graph changes_with X', 'what tends to change in the same commit (git-mined)'],
  ['kora graph file_symbols <path>', 'everything in one file, with line ranges'],
  ['kora graph overview', 'orient: hubs, co-change hotspots, cycles'],
];

// Output is 5x input (RESEARCH.md item 6): one terse-output line in the system prompt is worth five input-side
// rules of the same size. config.concise (default on).
export const CONCISE_LINE = 'Be terse: no preamble, no restating the question, no closing summary unless asked; output tokens cost 5x input.';
// …and scope it in the instruction-file channel only. Without this an ORCHESTRATOR reads "be terse"
// as "ask fewer questions" and skips the discovery interview — the one place in this product where
// asking more IS the work. The per-turn brief stays lean; orchestrators get the same rule in full
// from chatOrchestratorPrompt().
export const CONCISE_SCOPE_LINE = 'That terseness rule is about ANSWERS. It never applies to an orchestrator\'s discovery questions or the plan it puts to the human — ask those in full.';
function concise(): boolean { try { return require('../config').loadConfig().concise !== false; } catch { return true; } }
/**
 * The minimal-change ladder (config `minimalCode`, on by default). The one third-party rule set with a paired, billed saving
 * (JetBrains on SkillsBench, 80 pairs, Sonnet 5: -10.3% cost, -15% code, quality unchanged) - and only when it is always in
 * context, never as an optional skill (it self-activated 0 of 10 times). Less code is fewer output tokens AND fewer turns
 * testing and fixing code nobody needed. docs/research/LANDSCAPE-2026-10-16.md §1.14.
 */
export const MINIMAL_CODE_LINE = 'Write the least code that works: before adding code, check whether it needs to exist at all, whether this codebase, the standard library, the platform or an installed dependency already does it, and whether it can be one line; then write the minimum. Never cut validation, error handling the task needs, security or accessibility.';
function minimalCode(): boolean { try { return require('../config').loadConfig().minimalCode !== false; } catch { return true; } }

export const MCP_TOOL_NAMES = ['explore', 'search_code', 'neighbours', 'changes_with', 'blast_radius', 'file_symbols', 'overview'];

export function commandList(): string {
  const w = Math.max(...GRAPH_COMMANDS.map(([c]) => c.length));
  return GRAPH_COMMANDS.map(([c, d]) => `  ${c.padEnd(w)}  — ${d}`).join('\n');
}

/** Rulebook for the managed instruction block / system prompt. Imperative, ~900 chars + commands. */
export function rulebook(): string {
  return [
    'THIS REPOSITORY HAS A CODE GRAPH (kora). Route by what you need:',
    '- HOW does X work / where is the logic → `kora graph explore "<symbol or plain english>"` — ranked declarations + callers/callees + a source excerpt, one call, instead of grep→Read→Read.',
    '- WHO calls X / what would break → `kora graph neighbours X --direction in` or `kora graph blast_radius --file <path>` (run blast_radius before editing).',
    '- WHERE is a declaration by name → `kora graph search_code X` (locations only, tiny result — prefer it over explore when you just need file:line).',
    '- STRING references — renames, config keys, log messages, docs, comments, tests referring to a name → grep IS the right tool; the graph indexes code structure, not text. Use search_code/neighbours for the code side, grep for the rest, and do not run explore for a rename.',
    '- Reading source: the graph gives you the exact line range; Read with offset/limit, not the whole file (in Bash too: no `cat` of a source file). A whole-file read is re-billed on every later turn.',
    '- Fast, local. If the graph answers, trust it; do not re-verify by grepping. A cold search for a code identifier (a search tool, or `rg`/`grep` in Bash) is denied once (text searches and Glob always pass); after any graph call everything is allowed.',
    '- One explore is usually enough. Make at most two graph calls before answering or reading a range; do not chain explore → search_code → neighbours for the same symbol.',
    // "Do NOT spawn a subagent" reads to an orchestrator as "do not spawn workers" — the exact
    // behaviour the fleet exists for. Scope it: this bans a second context for EXPLORING, not the fleet.
    '- Do NOT spawn a subagent to explore the codebase: a second context costs more than the whole answer. One explore call does it. (About exploring only — an orchestrator\'s fleet workers are the product, not a shortcut around the graph.)',
    ...(concise() ? ['- ' + CONCISE_LINE, '- ' + CONCISE_SCOPE_LINE] : []),
    ...(minimalCode() ? ['- ' + MINIMAL_CODE_LINE] : []),
    ...(process.env.KORA_MCP === '1' || process.env.KORA_MCP === 'on' ? ['- Also available as MCP tools: ' + MCP_TOOL_NAMES.map((t) => `mcp__kora__${t}`).join(', ') + '.'] : []),
    '',
    COMPACT_INSTRUCTIONS,
  ].join('\n');
}

/**
 * The rulebook for a repo that has no code graph yet. The graph block would send the agent to `kora graph …` calls that
 * fail, so until the index lands (the chip beside the project name, or `kora ingest .`) it is told to use grep and Read;
 * the next session start rewrites the block with the full rulebook (enforce/adapters/types.ts `blockBody`).
 */
export function rulebookNoGraph(): string {
  return [
    'THIS REPOSITORY IS NOT INDEXED BY THE KORA CODE GRAPH YET. Until it is, grep, glob and Read are the right tools: do not call `kora graph …` (it would find nothing).',
    'Read source by line range (offset/limit), never whole files: a whole-file Read is re-billed on every later turn.',
    'Only the user starts the index (the graph chip beside the project name); do not index it yourself. Once it lands this note is replaced by the graph rulebook.',
    ...(concise() ? ['- ' + CONCISE_LINE] : []),
    ...(minimalCode() ? ['- ' + MINIMAL_CODE_LINE] : []),
    '',
    COMPACT_INSTRUCTIONS,
  ].join('\n');
}

/** Short form for `--append-system-prompt` of a repo with no graph yet. */
export function rulebookShortNoGraph(opts: { compact?: boolean } = {}): string {
  return `kora: this repo is not indexed yet, so there is no code graph to query — use grep, glob and Read (by line range), and do not call \`kora graph\` until it is indexed.${concise() ? ` ${CONCISE_LINE}` : ''}${opts.compact ? ` ${COMPACT_INSTRUCTIONS.replace('\n', ' ')}` : ''}`;
}

/**
 * The user-message notice for a thread that started before its repo was indexed: its system prompt (frozen by the
 * session snapshot) still says "no code graph - do not call kora graph". Sent once when the index lands.
 */
export function graphReadyNotice(): string {
  return [
    'kora: the code graph for this repository is ready now, so ignore the earlier note that it is not indexed. From here:',
    'HOW does X work → `kora graph explore "<symbol or phrase>"`; WHO calls X → `kora graph neighbours X --direction in`;',
    'WHERE is a name → `kora graph search_code X`; read source by the line range the graph gives (offset/limit). Text greps still pass.',
  ].join(' ');
}

/**
 * Compaction guidance (master cost plan 5.4, B4). Claude Code's summarizer is told to follow "additional summarization
 * instructions provided in the included context" under a heading like this one (the compact prompt in the bundled binary names
 * `## Compact Instructions` and `# Summary instructions`), so it rides in the CLAUDE.md block and, for a folder where no
 * block is written, in the system prompt. It says what to keep and what is cheap to fetch again.
 */
export const COMPACT_INSTRUCTIONS = [
  '# Compact instructions',
  'When summarizing: keep the user\'s decisions, preferences and constraints; every file changed and why; failing tests or errors with the command that showed them; open TODOs and the next step. Drop file bodies, grep/search/explore output and long command output: they can be fetched again.',
].join('\n');

/** Short form for `--append-system-prompt` (≈600 chars). */
export function rulebookShort(opts: { compact?: boolean } = {}): string {
  return [
    'kora: this repo has a resolved code graph. Route by need: HOW does X work → `kora graph explore "<symbol or phrase>"`;',
    'WHO calls X / what breaks → `kora graph neighbours X --direction in`, `kora graph blast_radius --file <path>` before editing;',
    'WHERE is a name → `kora graph search_code X` (locations only, cheap).',
    'STRING references (renames, config keys, docs, log text) → grep is right; the graph indexes structure, not text — do not run explore for a rename.',
    'Read source by the line range the graph gives you (offset/limit), never whole files (no `cat`). If the graph answers, trust it; do not re-grep.',
    'A cold search for a code identifier (a search tool, or rg/grep in Bash) is denied once; text searches and Glob pass; after a graph call all pass. One explore is usually enough — at most two graph calls before answering. No subagents for exploring.',
    ...(concise() ? [CONCISE_LINE] : []),
    ...(opts.compact ? [COMPACT_INSTRUCTIONS.replace('\n', ' ')] : []),
  ].join(' ');
}

export function howToSection(): string {
  return `HOW TO USE THE GRAPH HERE (shell, fast, local):\n${commandList()}\n  MCP (when connected): ${MCP_TOOL_NAMES.map((t) => `mcp__kora__${t}`).join(', ')}`;
}

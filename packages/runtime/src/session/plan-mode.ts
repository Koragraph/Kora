// Plan mode (the composer's Plan toggle). Each harness plans in its own native mode: Claude's permission mode `plan`,
// OpenCode's `plan` agent, Antigravity's `--mode=plan`, and Codex's read-only sandbox (`codex exec` has no plan mode).
// Kora adds one thing: the first plan turn carries this notice, so the plan is made with the code graph.

export const PLAN_MODE_GRAPH_NOTICE = [
  `[kora] Plan mode. This repo has a Kora code graph: plan with it. It is the fastest, most accurate way to know where a`,
  `change goes and what it breaks.`,
  `- \`kora graph explore "<symbol or plain english>"\`: where the logic lives (declarations, callers, callees, source).`,
  `- \`kora graph neighbours <Symbol> --direction in\`: every caller of anything whose contract changes.`,
  `- \`kora graph blast_radius --file <path>\`: what an edit to that file touches.`,
  `Read only the line ranges the graph points to. For each step, the plan names the edit sites (file:line), the callers`,
  `to update, and the command that proves it is done.`,
].join('\n');

/** The `kora graph` subcommands that only read (plan mode may run these without asking). `prune`, `ingest` and the rest write. */
export const GRAPH_READ_SUBCOMMANDS = ['explore', 'search_code', 'neighbours', 'blast_radius', 'file_symbols', 'overview', 'changes_with', 'recall'] as const;

/** OpenCode `bash` permission patterns for the read-only graph queries (a plan turn's only allowed shell). */
export const OPENCODE_GRAPH_READ_ALLOW: readonly string[] = ['kora', 'kora-dev'].flatMap((bin) => GRAPH_READ_SUBCOMMANDS.flatMap((s) => [`${bin} graph ${s}`, `${bin} graph ${s} *`]));

const GRAPH_QUERY = new RegExp(`^\\s*kora(?:-dev)?\\s+graph\\s+(?:${GRAPH_READ_SUBCOMMANDS.join('|')})(?:\\s[^;&|<>\`$\\n]*)?(?:\\s2>&1)?(?:\\s*\\|\\s*(?:head|tail)(?:\\s+-n?\\s*\\d+)?)?\\s*$`);

/** A bare read-only graph query (`kora graph explore "x" 2>&1 | head -80`): a read subcommand, no chaining, redirects or substitutions. */
export function isGraphQueryCommand(command: string): boolean {
  return GRAPH_QUERY.test(command);
}

/** Codex runs plan turns in its read-only sandbox; this tells it why. */
export const CODEX_PLAN_NOTE =
  `[kora] Plan mode: do not change any file. Investigate, then end your reply with the plan, in markdown.`;

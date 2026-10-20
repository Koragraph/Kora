// What a Claude worker pane loads on every call that the worker never uses. Measured 2026-10-16 on the first call of 65
// Kora worker panes (~/.claude/projects transcripts, `cli` lane): a 44k-token prompt before any work, of which the skill
// listing was ~23.6k chars (51 skills: docx/pptx/xlsx, browsers, morning briefings…), re-read on every call of every worker.
// R's audit (LANDSCAPE §8): the fixed prefix is ~18% of pane spend; over 14 days panes called Skill once and Artifact never.
// The user's auto memory (~6.3k tokens) stays: it carries their safety rules (never pattern-kill, env isolation…).
//
// - Skill listing at 8,000 chars: what Claude Code gives every 200k-window session (1% of the window); on the 1M-window
//   models it is 40k. Over the budget every skill keeps its name and the most used keep their descriptions, so a skill a
//   brief names still runs.
// - Prompt suggestions off: the ghost text after the prompt that nobody reads in a worker pane is a model call per turn.
// - Artifact tool off: its definition rides in every call; panes never used it.
//
// Panes only: the chat lane (KORA_INJECT_OWNER=driver) is the user's own thread and keeps all of it. A value the user set
// wins. KORA_LEAN_PANES=0 turns it off.

export const LEAN_SKILL_BUDGET_CHARS = 8000;

/** The env to add to a Claude worker pane (empty for the chat lane, or when switched off). `env` is what it would inherit. */
export function leanPaneEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const off = (env.KORA_LEAN_PANES ?? '').trim().toLowerCase();
  if (off === '0' || off === 'off' || off === 'false') return {};
  if (env.KORA_INJECT_OWNER === 'driver') return {};
  const out: Record<string, string> = {};
  if (env.SLASH_COMMAND_TOOL_CHAR_BUDGET === undefined) out.SLASH_COMMAND_TOOL_CHAR_BUDGET = String(LEAN_SKILL_BUDGET_CHARS);
  if (env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === undefined) out.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false';
  if (env.CLAUDE_CODE_DISABLE_ARTIFACT === undefined) out.CLAUDE_CODE_DISABLE_ARTIFACT = '1';
  return out;
}

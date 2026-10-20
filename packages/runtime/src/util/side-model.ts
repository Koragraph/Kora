// Claude Code's own background calls (thread titles, summaries, command-prefix checks, compact helpers) run on its "haiku"
// alias, which this CLI resolves to Haiku 4.5 ($1 in / $5 out per M). Haiku 5.5 is $0.10 / $0.50 for prompts up to 100k:
// the same calls for a tenth of the price. The paired bench measured side calls at 6.1% of a run's cost (2026-10-15), and a
// live check (2026-10-16, SDK 0.3.286) showed ANTHROPIC_DEFAULT_HAIKU_MODEL moves them: the run's modelUsage listed only
// claude-haiku-5-5. Every Claude process Kora starts gets it, unless the user chose their own small model or routes Claude
// somewhere the first-party id may not exist (Bedrock, Vertex, Foundry, a custom gateway). KORA_SIDE_MODEL=0 turns it off.

import { userClaudeSettingsEnv } from './claude-default-model';

export const SIDE_MODEL = 'claude-haiku-5-5';

/** The env to add to a Claude process (empty = leave Claude Code's default). `env` is what the process would inherit. */
export function sideModelEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const off = (env.KORA_SIDE_MODEL ?? '').trim().toLowerCase();
  if (off === '0' || off === 'off' || off === 'false') return {};
  const own = userClaudeSettingsEnv(env.CLAUDE_CONFIG_DIR || undefined);
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL || own.ANTHROPIC_DEFAULT_HAIKU_MODEL || own.ANTHROPIC_SMALL_FAST_MODEL) return {};
  if (!firstPartyRoute(env)) return {};
  return { ANTHROPIC_DEFAULT_HAIKU_MODEL: SIDE_MODEL };
}

/**
 * Claude goes straight to Anthropic's API (not Bedrock, Vertex, Foundry or a custom gateway), counting the user's Claude
 * settings `env`, which Claude Code applies over the process env (R7 N1).
 */
export function firstPartyRoute(env: NodeJS.ProcessEnv = process.env): boolean {
  const e = { ...env, ...userClaudeSettingsEnv(env.CLAUDE_CONFIG_DIR || undefined) };
  if (e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY) return false;
  return !(e.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(e.ANTHROPIC_BASE_URL));
}

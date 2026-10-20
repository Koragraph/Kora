// What Kora's "Default" Claude model runs. The SDK's own "default" resolves to Opus 5.5, five times a Sonnet turn
// (aud3 S1-1: 83% of a week's Kora-lane Claude cost was Opus while the user's own ~/.claude/settings.json said sonnet).
// Default now follows the user's own Claude setting ("model" in settings.json), and falls back to Sonnet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FALLBACK_CLAUDE_DEFAULT = 'sonnet';

/** The `model` of the user's Claude Code settings (CLAUDE_CONFIG_DIR or ~/.claude), or null. */
export function userClaudeModelSetting(configDir: string = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))?.model;
    return typeof m === 'string' && m.trim() && m.trim().toLowerCase() !== 'default' ? m.trim() : null;
  } catch { return null; }
}

/**
 * The `env` block of the user's Claude Code settings (string values only), or {}. Claude Code applies it over the process
 * env (R7 N1), so a route set there (Bedrock, Vertex, a gateway) is the route Kora's Claude processes really take.
 */
export function userClaudeSettingsEnv(configDir: string = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): Record<string, string> {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))?.env;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
    return Object.fromEntries(Object.entries(e).filter((kv): kv is [string, string] => typeof kv[1] === 'string'));
  } catch { return {}; }
}

/** The model string a thread on the "default" slug really starts with. */
export function effectiveClaudeDefault(configDir?: string): string {
  return userClaudeModelSetting(configDir) ?? FALLBACK_CLAUDE_DEFAULT;
}

/** Map a picker slug to what the SDK/CLI is given: only "default" is rewritten; every explicit pick passes through. */
export function claudeModelForLaunch(slug: string | undefined, configDir?: string): string | undefined {
  if (!slug) return slug;
  return slug === 'default' ? effectiveClaudeDefault(configDir) : slug;
}

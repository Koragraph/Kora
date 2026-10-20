// Settings > Defaults > "Compact long conversations at": 200k (default), 400k or the model's full window.
// Claude Code on Opus/Sonnet 5.5 has a 1M-token window and auto-compacts at 967k, so a long thread re-reads up to a
// million tokens on every message (aud3 S1-2: 45% of one week's Opus messages ran above 400k). Every `claude` Kora starts
// (the chat lane and Claude worker panes) gets CLAUDE_CODE_AUTO_COMPACT_WINDOW = the chosen size; "full" sets nothing.
// Read from <KORA_HOME>/settings.json (`claudeCompactAt`), so a change applies to the next session that starts.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export type ClaudeCompactAt = '200k' | '400k' | 'full';
export const DEFAULT_CLAUDE_COMPACT_AT: ClaudeCompactAt = '200k';
/** Claude Code compacts this many tokens before the window's end (measured: window 200000 -> threshold 167000). */
export const COMPACT_HEADROOM_TOKENS = 33_000;

export function claudeCompactAt(home: string = koraHome()): ClaudeCompactAt {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))?.claudeCompactAt;
    return v === '400k' || v === 'full' || v === '200k' ? v : DEFAULT_CLAUDE_COMPACT_AT;
  } catch { return DEFAULT_CLAUDE_COMPACT_AT; }
}

/**
 * Haiku 5.5 bills a prompt over 100k tokens (cache reads and writes included) at 5x every price, so at the default setting a
 * Haiku 5.5 session compacts at 100k (window 133k minus Claude Code's 33k headroom) and stays in the cheap tier. A user who
 * picked 400k or the full window keeps it.
 */
export const HAIKU55_COMPACT_WINDOW = 100_000 + COMPACT_HEADROOM_TOKENS;

/** The window to cap at, in tokens; null = the model's own. An explicit `[1m]` pick is the user opting into 1M: never capped. */
export function claudeCompactWindow(model?: string | null, home?: string): number | null {
  if (model && /\[1m\]/i.test(model)) return null;
  const at = claudeCompactAt(home);
  if (at === '200k' && model && /haiku-5/i.test(model)) return HAIKU55_COMPACT_WINDOW;
  return at === '200k' ? 200_000 : at === '400k' ? 400_000 : null;
}

/** The extra env for a Kora-started `claude` process: empty for "full" and for an explicit 1M model. */
export function claudeCompactEnv(model?: string | null, home?: string): Record<string, string> {
  const w = claudeCompactWindow(model, home);
  return w ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(w) } : {};
}

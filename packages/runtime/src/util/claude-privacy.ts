// Settings > Privacy > "Limit Claude's background traffic". One tiny turn of Claude Code opens a second host besides the
// API (telemetry / feature-flag service, aud1 S3-1). Off by default: the switch also turns off Claude Code's own
// auto-update check, error reporting and survey traffic, which some people rely on. On, every `claude` process Kora
// starts (the chat lane and Claude worker panes) gets DISABLE_TELEMETRY and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; the
// user's own terminal `claude` is untouched. Read from <KORA_HOME>/settings.json (`limitClaudeTelemetry`), so a change
// applies to the next session that starts.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export const CLAUDE_PRIVACY_ENV = { DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } as const;

export function limitClaudeTelemetry(home: string = koraHome()): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))?.limitClaudeTelemetry === true; }
  catch { return false; }
}

/** The extra env for a Kora-started `claude` process: empty unless the user turned the switch on. */
export function claudePrivacyEnv(home?: string): Record<string, string> {
  return limitClaudeTelemetry(home) ? { ...CLAUDE_PRIVACY_ENV } : {};
}

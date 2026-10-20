// "Is this session already going somewhere else?" The proxy forwards to api.anthropic.com only. A user who points Claude at
// their own gateway (ANTHROPIC_BASE_URL), at Bedrock / Vertex / Foundry, or through a corporate HTTP proxy must never be
// rerouted: the session simply does not get our base URL. Checked on the env the session would run with AND on the
// `env` blocks of the Claude settings files it will load (user, project, project-local), because Claude applies those
// over the process env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATEWAY_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_UNIX_SOCKET'];
const PROVIDER_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
// ANTHROPIC_BASE_URL set to Anthropic's own endpoint (some shells and wrappers export it) is not a gateway: it is the default.
const isOfficial = (v: string) => { try { return new URL(v.trim()).hostname === 'api.anthropic.com'; } catch { return false; } };
const truthy = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/^(0|false|off|no)$/i.test(v.trim());

/** A reason the session must not be rerouted through our proxy, or null when it talks to Anthropic directly. */
export function ownGatewayReason(env: Record<string, string | undefined>): string | null {
  for (const k of GATEWAY_KEYS) if (typeof env[k] === 'string' && env[k]!.trim() !== '' && !(k === 'ANTHROPIC_BASE_URL' && isOfficial(env[k]!))) return k;
  for (const k of PROVIDER_FLAGS) if (truthy(env[k])) return k;
  for (const k of PROXY_KEYS) if (typeof env[k] === 'string' && env[k]!.trim() !== '') return k;
  return null;
}

/** The `env` blocks of Claude's settings files (user config dir, <cwd>/.claude/settings.json, settings.local.json). */
export function settingsGatewayReason(cwd: string, configDir: string = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): string | null {
  const files = [path.join(configDir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  for (const f of files) {
    try {
      const env = JSON.parse(fs.readFileSync(f, 'utf8'))?.env;
      if (env && typeof env === 'object') { const r = ownGatewayReason(env as Record<string, string>); if (r) return `${r} (settings)`; }
    } catch { /* absent or unreadable: nothing to honour */ }
  }
  return null;
}

/**
 * The session env with our base URL on it - unless the env already points somewhere (then it is returned untouched).
 * Any non-Anthropic base URL makes Claude Code (2.1.286, measured 2026-10-14) treat the session as a third-party gateway:
 * it stops deferring tools (every tool schema inline: 28 tools / 106 KB instead of 12 / 56 KB, ~+12k prompt tokens a
 * call) and asks for full thinking text instead of `display: "omitted"`. The proxy forwards to api.anthropic.com, which
 * supports tool search, so turn it back on - unless the user set ENABLE_TOOL_SEARCH themselves.
 */
export function withWarmProxy(env: NodeJS.ProcessEnv, baseUrl: string | undefined | null): NodeJS.ProcessEnv {
  if (!baseUrl || ownGatewayReason(env)) return env;
  return { ...env, ANTHROPIC_BASE_URL: baseUrl, ...(env.ENABLE_TOOL_SEARCH === undefined ? { ENABLE_TOOL_SEARCH: 'true' } : {}) };
}

/**
 * CLI args for a session routed through our proxy: `--thinking-display omitted`, so it asks for thinking the way a direct
 * session does (signature only, no thinking text billed into the stream). Claude Code's own flag, not a body rewrite: it
 * sets only `thinking.display` and leaves the budget / adaptive type alone (stub-verified on the SDK's CLI 2.1.286, Haiku
 * 4.5 + Sonnet 5.5). Only for the SDK's bundled CLI: an older user-chosen `claude` may not know the flag and would refuse
 * to start.
 */
export function warmProxyArgs(env: NodeJS.ProcessEnv, baseUrl: string | undefined | null, binaryOverride: boolean): Record<string, string> {
  if (!baseUrl || binaryOverride || env.ANTHROPIC_BASE_URL !== baseUrl) return {};
  return { 'thinking-display': 'omitted' };
}

// Agent identity: from a command line, a process name, or an OSC title.
import path from 'node:path';
import type { AgentId } from '../protocol/types';
import { userShell } from '../util/win-exec';

export const KNOWN_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'koragent', 'cursor', 'copilot', 'amp', 'droid', 'grok', 'kimi', 'qwen', 'aider'];
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'nu', 'nushell', 'pwsh', 'powershell', 'ksh', 'dash', 'tcsh', 'csh', 'elvish', 'xonsh']);
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'npx', 'pnpx', 'bunx', 'uv', 'uvx', 'tsx', 'ts-node']);

const NAME_MAP: Record<string, AgentId> = {
  claude: 'claude', 'claude-code': 'claude', codex: 'codex', gemini: 'gemini', 'gemini-cli': 'gemini',
  antigravity: 'antigravity', agy: 'antigravity',
  opencode: 'opencode', opencode2: 'opencode', 'open-code': 'opencode', koragent: 'koragent', cursor: 'cursor', 'cursor-agent': 'cursor',
  copilot: 'copilot', 'github-copilot': 'copilot', ghcs: 'copilot', amp: 'amp', 'amp-local': 'amp', droid: 'droid',
  grok: 'grok', 'grok-build': 'grok', kimi: 'kimi', 'kimi-code': 'kimi', qwen: 'qwen', 'qwen-code': 'qwen', aider: 'aider',
};
const PACKAGE_PATHS: [RegExp, AgentId][] = [
  [/@anthropic-ai\/claude-code/, 'claude'], [/@openai\/codex/, 'codex'], [/@google\/gemini-cli|gemini-cli/, 'gemini'],
  [/opencode-ai|\/opencode\//, 'opencode'], [/@github\/copilot/, 'copilot'], [/@sourcegraph\/amp/, 'amp'], [/aider/, 'aider'],
];

function stripExt(name: string): string { return name.replace(/\.(m?js|cjs|ts|py|exe|cmd|sh)$/i, ''); }
export function agentFromName(name: string): AgentId | null {
  const base = stripExt(path.basename(name.trim())).toLowerCase();
  if (NAME_MAP[base]) return NAME_MAP[base];
  for (const [re, id] of PACKAGE_PATHS) if (re.test(name)) return id;
  return null;
}
export function isShellName(name: string): boolean { return SHELLS.has(path.basename(name).toLowerCase()); }
export function isRuntimeName(name: string): boolean { return RUNTIMES.has(stripExt(path.basename(name)).toLowerCase()); }

/** Identify the agent from an argv (command + args). Shells → 'shell'; unrecognised → 'unknown'. */
export function agentFromArgv(command: string, args: string[] = []): AgentId {
  const direct = agentFromName(command);
  if (direct) return direct;
  if (isShellName(command)) {
    // `bash -lc "claude --resume x"` style
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (ci >= 0 && args[ci + 1]) { const tok = args[ci + 1].trim().split(/\s+/)[0]; const a = tok && agentFromName(tok); if (a) return a; }
    return 'shell';
  }
  if (isRuntimeName(command)) {
    for (const a of args) { if (a.startsWith('-')) continue; const id = agentFromName(a); if (id) return id; break; }
  }
  return 'unknown';
}

/** Identify an agent from a `ps` args line (argv joined by spaces). */
export function agentFromPsArgs(argsLine: string): AgentId | null {
  return agentFromArgvTokens(argsLine.trim().split(/\s+/));
}
/** Identify an agent from an argv already split into tokens (Windows: `splitWindowsCommandLine` of a CommandLine). */
export function agentFromArgvTokens(toks: readonly string[]): AgentId | null {
  if (!toks.length || !toks[0]) return null;
  const a = agentFromName(toks[0]); if (a) return a;
  if (isRuntimeName(toks[0])) return agentFromArgv(toks[0], toks.slice(1)) as AgentId | null;
  return null;
}

export function agentFromTitle(title: string): AgentId | null {
  const t = title.toLowerCase();
  if (/claude/.test(t)) return 'claude';
  if (/\bcodex\b/.test(t)) return 'codex';
  if (/\bgemini\b/.test(t)) return 'gemini';
  if (/antigravity|\bagy\b/.test(t)) return 'antigravity';
  if (/\bkoragent\b/.test(t)) return 'koragent';
  if (/\bopencode\b/.test(t)) return 'opencode';
  if (/\baider\b/.test(t)) return 'aider';
  if (/\bcopilot\b/.test(t)) return 'copilot';
  return null;
}

/** Default executable for `agent spawn`. */
export function agentCommand(agent: AgentId): string {
  switch (agent) {
    case 'cursor': return 'cursor-agent';
    case 'antigravity': return 'agy';
    case 'shell': case 'unknown': return userShell();
    default: return agent;
  }
}
export function isKnownAgent(agent: string): agent is AgentId { return (KNOWN_AGENTS as string[]).includes(agent); }

// What "not trusted" means in each lane Kora drives. One place, so the lanes cannot drift apart:
//
//   lane                        trusted (unchanged)                         untrusted (restricted)
//   Claude SDK chat lane        settingSources user+project+local           settingSources ['user'] + Kora's own hooks
//                                                                           passed as flag settings; strict MCP
//   Claude / Codex panes        Kora answers the agent's trust dialog       the dialog is left to the human
//   Codex panes                 project pre-trusted in ~/.codex/config      never pre-trusted
//   OpenCode panes / workers    project .opencode config, plugins, tools    OPENCODE_DISABLE_PROJECT_CONFIG=1
//   Koragent panes / workers    project .koragent/.opencode config          KORAGENT_DISABLE_PROJECT_CONFIG=1
//                               (+ KORAGENT_TRUST_PROJECT=1)                (swarm workers: + KORAGENT_PURE=1, always)
import type { AgentId } from '../protocol/types';
import { isFolderTrusted } from './store';

export { isFolderTrusted } from './store';

interface AutoAnswerPolicy { trustFolder: boolean; mcpFound: boolean; readOutsideWorktree: boolean }

/**
 * The auto-answer scope for a pane at `cwd`. `trustedRoots` (config, default ~/Projects + Kora's worktrees) no longer
 * implies trust: the trust-folder and new-MCP-server answers need the folder to be trusted in the trust store, and a
 * trusted folder is answered wherever it lives. Read-outside-worktree keeps its configured roots (it never runs code).
 */
export function autoAnswerScope(cfg: { trustedRoots: string[]; autoAnswer: AutoAnswerPolicy }, cwd: string): { trustedRoots: string[]; policy: AutoAnswerPolicy } {
  if (isFolderTrusted(cwd)) return { trustedRoots: [...cfg.trustedRoots, cwd], policy: cfg.autoAnswer };
  return { trustedRoots: cfg.trustedRoots, policy: { ...cfg.autoAnswer, trustFolder: false, mcpFound: false } };
}

/** Env that switches off a repository's own executable configuration for an OpenCode- or Koragent-based agent. */
export const OPENCODE_UNTRUSTED_ENV: Readonly<Record<string, string>> = Object.freeze({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
// Project dirs off is enough: KORAGENT_PURE would also drop the user's OWN global plugins (swarm workers set it anyway).
export const KORAGENT_UNTRUSTED_ENV: Readonly<Record<string, string>> = Object.freeze({ KORAGENT_DISABLE_PROJECT_CONFIG: '1' });

/**
 * Extra env for an agent pane / worker launched in `cwd`. Untrusted: the project-config kill switches. Trusted: nothing
 * for OpenCode (as before); for Koragent, KORAGENT_TRUST_PROJECT=1 — Kora made the decision, so Koragent's own
 * standalone trust prompt (koragent core/project/trust.ts) does not ask a second time.
 */
export function untrustedAgentEnv(agent: AgentId | string, cwd: string): Record<string, string> {
  if (agent !== 'opencode' && agent !== 'koragent') return {};
  if (isFolderTrusted(cwd)) return agent === 'koragent' ? { KORAGENT_TRUST_PROJECT: '1' } : {};
  return agent === 'opencode' ? { ...OPENCODE_UNTRUSTED_ENV } : { ...KORAGENT_UNTRUSTED_ENV };
}

/** Claude Code setting sources for the SDK chat lane. Without 'project' and 'local' no repo-shipped hooks,
 *  MCP approvals, plugins, statusLine/apiKeyHelper commands or permission rules load. */
export function claudeSettingSources(trusted: boolean): Array<'user' | 'project' | 'local'> {
  return trusted ? ['user', 'project', 'local'] : ['user'];
}

// A PLAIN OpenCode worker (kora_spawn agent:"opencode", `kora agent spawn opencode`), as opposed to a swarm worker.
//
// Found live: the plain path launched a bare `opencode` from the daemon's PATH with no model. Kora's managed install
// (<KORA_HOME>/tools/opencode/current/opencode) is usually NOT on that PATH, so the pane exited with code 1 at once
// and the leader got "initial prompt failed: pane has exited" and nothing to merge. Swarm workers never hit it: they
// pass the resolved binary as `command` and a live free model as `-m`.
//
// prepareOpencodeSpawn gives the plain path the same three things, before any worktree or pane exists:
//   • command = resolveOpencodeBinary() (then the async login-shell refresh); nothing found → a clear error the leader
//     reads as the kora_spawn result, no pane, no worktree;
//   • `-m <model>` when the caller gave none: the swarm picker over the live Zen free list (ensureFresh, bounded),
//     restricted to Zen's free models (no key, no env a plain pane lacks). No model → OpenCode's own default;
//   • OPENCODE_DISABLE_AUTOUPDATE=1, so no update dialog blocks the pane before the task starts.
// A caller that already passes `command` (SwarmService) is left alone.

import type { Methods } from '../protocol/types';
import { adapterFor } from '../detect/agent-adapter';
import { log } from './log';

type SpawnParams = Methods['agent.spawn']['params'];

export const OPENCODE_NOT_INSTALLED = 'OpenCode is not installed — run `kora swarm install` or Settings → Swarm, then spawn again.';

export interface OpencodeSpawnDeps {
  /** The OpenCode executable, or null when none is found anywhere. */
  resolveBinary(): Promise<string | null>;
  /** A default model id for a plain worker (task text for routing), or null to keep OpenCode's own default. */
  pickModel(task?: string): Promise<string | null>;
}

const hasModelArg = (args: readonly string[]): boolean => args.some((a) => a === '-m' || a === '--model' || a.startsWith('--model='));

/** params unchanged unless this is an OpenCode spawn with no explicit command. Throws OPENCODE_NOT_INSTALLED. */
export async function prepareOpencodeSpawn(params: SpawnParams, deps: OpencodeSpawnDeps = defaultOpencodeSpawnDeps()): Promise<SpawnParams> {
  if (params.agent !== 'opencode' || params.command) return params;
  let command: string | null = null;
  try { command = await deps.resolveBinary(); } catch { command = null; }
  if (!command) throw new Error(OPENCODE_NOT_INSTALLED);
  const args = [...(params.args ?? [])];
  if (!hasModelArg(args)) {
    let model: string | null = null;
    try { model = await deps.pickModel(params.prompt); } catch { model = null; } // a failed pick is not a verdict
    if (model) args.unshift(...adapterFor('opencode').modelArgs(model));
    log(`agent opencode: plain worker → ${command}${model ? ` -m ${model}` : ' (OpenCode default model)'}`);
  }
  // OpenCode's TUI opens an "Update Available … Skip / Confirm" dialog when a newer release exists (found live
  // 2026-10-19: a plain worker sat on it and never started its task). Swarm workers already run with this off.
  return { ...params, command, args, env: { ...(params.env ?? {}), OPENCODE_DISABLE_AUTOUPDATE: '1' } };
}

/** The real deps: swarm-install's resolver and the daemon's SwarmService/SwarmSetup picker (lazy requires). */
export function defaultOpencodeSpawnDeps(rt?: { swarm?: unknown; swarmSetup?: unknown }): OpencodeSpawnDeps {
  return {
    resolveBinary: async () => {
      const inst = require('./swarm-install') as typeof import('./swarm-install');
      const hit = inst.resolveOpencodeBinary().path;
      if (hit) return hit;
      // The fixed search found nothing: search again uncached, then ask the login shell (async, 5 s cap).
      return (await inst.refreshOpencodeBinary()).path;
    },
    pickModel: async (task) => {
      const swarm = rt?.swarm as import('./swarm').SwarmService | undefined;
      const setup = rt?.swarmSetup as import('./swarm-setup').SwarmSetup | undefined;
      if (!swarm || !setup) return null;
      await setup.ensureFresh?.(5_000); // the providers' LIVE free lists, bounded
      const { modelTier } = require('./swarm-health') as typeof import('./swarm-health');
      const notZenFree = setup.pickableModels().filter((m) => m.provider !== 'zen' || modelTier(m.id) === 'paid').map((m) => m.id);
      return swarm.pickModel(notZenFree, task ? { task } : {})?.id ?? null;
    },
  };
}

// The Swarm lead's delegate-first gate (a PreToolUse hook on the lead's SDK session).
//
// Measured (bench5x, 2026-09-27, Sonnet 5 lead on a 117k-line repo): with the playbook alone the lead still explored
// and built the change itself — 32 calls, 10 file reads, ~$0.76, zero workers — because every read "feels" small. Each
// file the lead reads stays in its context and is re-billed on every later call; a worker reads the same code for a
// few percent of the price. So the lane enforces what the playbook asks: a couple of orienting calls, then delegate.
//
// Rules (per lead session):
//   - kora tools always pass; spawning a worker opens the post-delegation phase.
//   - Check-shaped commands (tests, typecheck, build, git status/diff/log) always pass — verifying is the lead's job.
//   - Exploring (Read/Grep/Glob/LS, other Bash) and editing (Edit/Write/MultiEdit/NotebookEdit): FREE_BEFORE calls before
//     the first spawn, FREE_AFTER more after it; beyond that the call is denied with the reason to delegate instead.
// KORA_SWARM_LEAD_GATE=0 turns it off.

import { delegatePlanOn } from './orchestrator-skill';

export const LEAD_GATE_FREE_BEFORE = 5; // matches the playbook: a small task (a few reads/edits) is done directly
export const LEAD_GATE_FREE_AFTER = 4;

const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CHECK_RE = /(^|[\s;&|(])(npx\s+)?(vitest|jest|mocha|ava|pytest|tox|nox|tsc|eslint|oxlint|ruff|mypy|go\s+(test|vet|build)|cargo\s+(test|check|build)|node\s+--test|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check)\b|make(\s|$)|git\s+(status|diff|log|show|rev-parse|branch))/;

export function isCheckCommand(command: string): boolean {
  return CHECK_RE.test(command);
}

export type GateVerdict = { allow: true } | { allow: false; reason: string };

export interface LeadGate {
  decide(toolName: string, toolInput: unknown): GateVerdict;
  readonly spawned: boolean;
}

const DELEGATE_NOW =
  'Kora Swarm: this lead has explored enough. Every file you read or edit here stays in your context and is re-billed ' +
  'on every later call; a worker does it for a few percent of the price. Delegate now: kora_spawn one worker per ' +
  "independent part, paste the user's requirements into its prompt verbatim (it finds the files and conventions " +
  "itself) and give the repo's test command as check. After the reports come back and you merge, run the check.";
// plan-on-delegate (orchestrator-skill.ts): the lead hands out slices it planned from the graph, not the raw request.
const DELEGATE_NOW_PLANNED =
  'Kora Swarm: this lead has explored enough. Every file you read or edit here stays in your context and is re-billed ' +
  'on every later call; a worker does it for a few percent of the price. Delegate now: plan from the graph (`kora graph ' +
  'explore|neighbours|blast_radius` calls are never counted here), then kora_spawn one worker per slice with its edit ' +
  'sites (file:line), the callers to update and the check. After the reports come back and you merge, run the check.';
const SEND_BACK =
  'Kora Swarm: fix-ups go back to a worker too. Put the failing output (or what is missing) into kora_prompt for ' +
  'the same worker, or a new kora_spawn task, and merge again; the lead verifies, it does not rework.';

export function createLeadGate(env: NodeJS.ProcessEnv = process.env): LeadGate {
  const off = env.KORA_SWARM_LEAD_GATE === '0';
  const delegateNow = delegatePlanOn(env) ? DELEGATE_NOW_PLANNED : DELEGATE_NOW;
  let spawned = false;
  let before = 0;
  let after = 0;
  return {
    get spawned() { return spawned; },
    decide(toolName: string, toolInput: unknown): GateVerdict {
      if (/kora_spawn$/.test(toolName)) { spawned = true; return { allow: true }; }
      if (off || /^mcp__kora__|kora_/.test(toolName)) return { allow: true };
      const input = (toolInput ?? {}) as Record<string, unknown>;
      let counted = EXPLORE.has(toolName) || EDIT.has(toolName);
      // The code graph is how a lead aims workers without reading code: never counted (use kora_locate for batches).
      if (toolName === 'Bash') counted = !isCheckCommand(String(input.command ?? '')) && !/(^|[\s;&|(])(kora\s+graph|\.kora\/bin\/graph)\b/.test(String(input.command ?? ''));
      if (!counted) return { allow: true };
      if (!spawned) {
        if (before < LEAD_GATE_FREE_BEFORE) { before++; return { allow: true }; }
        return { allow: false, reason: delegateNow };
      }
      if (after < LEAD_GATE_FREE_AFTER) { after++; return { allow: true }; }
      return { allow: false, reason: SEND_BACK };
    },
  };
}

/** The SDK `hooks` option for a Swarm lead session: one PreToolUse callback backed by a fresh gate. */
export function leadGateHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const gate = createLeadGate(env);
  const hook = async (input: any) => {
    const v = gate.decide(String(input?.tool_name ?? ''), input?.tool_input);
    if (v.allow) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason } };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}

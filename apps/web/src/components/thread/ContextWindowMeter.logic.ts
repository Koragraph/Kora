import { getTriggerDisplayModelName, type ModelEsque } from "./agentIconUtils";
import { resolveSelectableAgentProfileEntry, type AgentProfileEntry } from "../../agentProfiles";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@kora/shared/claudeResumeCompaction";
import type { AgentProfileId, ModelPick, AgentId } from "@kora/contracts";

const RESUME_COMPACTION_MIN_TOKENS = 100_000;
const RESUME_COMPACTION_MIN_IDLE_MS = 70 * 60 * 1000;

/** Blob threads only show the context ring once it is at least this full. */
export const BLOB_CONTEXT_RING_MIN_PERCENT = 60;

export function agentSupportsManualCompaction(
  provider: AgentProfileEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionAgent(input: {
  providers: ReadonlyArray<AgentProfileEntry>;
  driverKind: AgentId;
  instanceId: AgentProfileId | null;
  lockedInstanceId: AgentProfileId | null;
}): boolean {
  let candidates = input.providers.filter((entry) => entry.driverKind === input.driverKind);

  if (input.lockedInstanceId) {
    const locked = candidates.find((entry) => entry.instanceId === input.lockedInstanceId);
    const groupKey = locked?.continuationGroupKey;
    if (groupKey) {
      candidates = candidates.filter((entry) => entry.continuationGroupKey === groupKey);
    }
  }

  const entry = resolveSelectableAgentProfileEntry(candidates, input.instanceId ?? undefined);
  return agentSupportsManualCompaction(entry);
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ kind: string; payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") {
      return false;
    }
    const { payload } = activity;
    if (typeof payload !== "object" || payload === null) return false;
    const answers = (payload as { answers?: unknown }).answers;
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return false;
    return Object.entries(answers).some(
      ([question, answer]) =>
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER &&
        isClaudeResumeCompactionQuestion(question),
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  provider: string | null | undefined;
  usedTokens: number | null | undefined;
  updatedAt: string | null | undefined;
  now: string;
}): boolean {
  if (input.provider !== "claude") return false;
  if (input.usedTokens == null || input.usedTokens < RESUME_COMPACTION_MIN_TOKENS) return false;
  if (!input.updatedAt) return false;
  const updated = Date.parse(input.updatedAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(updated) || Number.isNaN(now)) return false;
  return now - updated >= RESUME_COMPACTION_MIN_IDLE_MS;
}

export function resolveContextWindowModelDisplayName(
  selection: ModelPick | null | undefined,
  modelOptionsByInstance: ReadonlyMap<AgentProfileId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) return null;
  const option = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((candidate) => candidate.slug === selection.model);
  return option ? getTriggerDisplayModelName(option) : selection.model;
}

export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactAt?: number | null,
): string {
  const threshold = typeof autoCompactAt === "number" ? autoCompactAt : 0;
  if (threshold > 0) {
    return `Compacts automatically at ${threshold.toLocaleString("en-US")} tokens.`;
  }
  if (!modelDisplayName) {
    return "Context compacts automatically when needed.";
  }
  return `Context for ${modelDisplayName} compacts automatically when needed.`;
}

/** Hold the meter's slot while activities load so the attach button does not jump. */
export function shouldReserveContextWindowMeter(input: {
  threadStarted: boolean;
  meterEnabled: boolean;
  detailLoading: boolean;
  providerReportsContextWindow: boolean | null;
}): boolean {
  if (input.providerReportsContextWindow === false) return false;
  return input.meterEnabled && input.detailLoading && input.threadStarted;
}

export function contextWindowForComposer<T extends { usedPercentage: number | null }>(
  usage: T | null,
  blobThread: boolean,
): T | null {
  if (!blobThread) return usage;
  if (!usage) return null;
  return (usage.usedPercentage ?? 0) >= BLOB_CONTEXT_RING_MIN_PERCENT ? usage : null;
}

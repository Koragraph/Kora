import type { ChatThreadActivity } from "@kora/contracts";

type Count = number | null;

export type ContextUsageSnapshot = {
  usedTokens: number;
  totalProcessedTokens: Count;
  maxTokens: Count;
  inputTokens: Count;
  cachedInputTokens: Count;
  outputTokens: Count;
  reasoningOutputTokens: Count;
  lastUsedTokens: Count;
  lastInputTokens: Count;
  lastCachedInputTokens: Count;
  lastOutputTokens: Count;
  lastReasoningOutputTokens: Count;
  toolUses: Count;
  durationMs: Count;
  autoCompactThreshold: Count;
  compactsAutomatically: boolean;
  /** The provider's own running cost estimate; never a bill. */
  costUsd?: number | null;
  source?: "provider" | "estimate" | null;
  remainingTokens: Count;
  usedPercentage: Count;
  remainingPercentage: Count;
  updatedAt: string;
};

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function snapshotFrom(activity: ChatThreadActivity): ContextUsageSnapshot | null {
  const p = activity.payload;
  if (typeof p !== "object" || p === null) return null;
  const raw = p as Record<string, unknown>;
  const used = finite(raw.usedTokens);
  if (used === null || used < 0) return null;

  const max = finite(raw.maxTokens);
  const usedPercentage = max !== null && max > 0 ? Math.min(100, (used / max) * 100) : null;

  return {
    usedTokens: used,
    totalProcessedTokens: finite(raw.totalProcessedTokens),
    maxTokens: max,
    inputTokens: finite(raw.inputTokens),
    cachedInputTokens: finite(raw.cachedInputTokens),
    outputTokens: finite(raw.outputTokens),
    reasoningOutputTokens: finite(raw.reasoningOutputTokens),
    lastUsedTokens: finite(raw.lastUsedTokens),
    lastInputTokens: finite(raw.lastInputTokens),
    lastCachedInputTokens: finite(raw.lastCachedInputTokens),
    lastOutputTokens: finite(raw.lastOutputTokens),
    lastReasoningOutputTokens: finite(raw.lastReasoningOutputTokens),
    toolUses: finite(raw.toolUses),
    durationMs: finite(raw.durationMs),
    autoCompactThreshold: finite(raw.autoCompactThreshold),
    compactsAutomatically: raw.compactsAutomatically === true,
    costUsd: finite(raw.costUsd),
    source: raw.source === "provider" || raw.source === "estimate" ? raw.source : null,
    remainingTokens: max !== null ? Math.max(0, Math.round(max - used)) : null,
    usedPercentage,
    remainingPercentage: usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null,
    updatedAt: activity.createdAt,
  };
}

export function latestContextWindowSnapshot(
  activities: ReadonlyArray<ChatThreadActivity>,
): ContextUsageSnapshot | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!;
    if (activity.kind !== "context-window.updated") continue;
    const snapshot = snapshotFrom(activity);
    if (snapshot) return snapshot;
  }
  return null;
}

const trimZero = (n: string) => n.replace(/\.0$/, "");

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${trimZero((value / 1000).toFixed(1))}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

export function formatUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return "<$0.01";
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

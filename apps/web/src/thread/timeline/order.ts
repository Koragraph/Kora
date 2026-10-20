import type { ChatThreadActivity } from "@kora/contracts";

/** Where a lifecycle kind falls among events at the same instant: starts, then updates, then ends. */
function lifecycleStage(kind: string): number {
  if (kind.endsWith(".started")) return 0;
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) return 2;
  return 1;
}

/**
 * Activities in the order they happened: by the daemon's sequence number when both have one (one without sorts
 * first), then by time, lifecycle stage, and id.
 */
export function byActivityOrder(a: ChatThreadActivity, b: ChatThreadActivity): number {
  const [sa, sb] = [a.sequence, b.sequence];
  if (sa !== undefined || sb !== undefined) {
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa !== sb) return sa - sb;
  }
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    lifecycleStage(a.kind) - lifecycleStage(b.kind) ||
    a.id.localeCompare(b.id)
  );
}

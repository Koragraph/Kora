import type { WebSessionSnapshot } from "@kora/contracts";

export function shouldShowWebEmptyState(snapshot: WebSessionSnapshot | null): boolean {
  return snapshot === null || snapshot.navStatus._tag === "Idle";
}

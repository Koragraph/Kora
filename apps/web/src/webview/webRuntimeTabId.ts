import type { HostThreadRef } from "@kora/contracts";

/**
 * The server only guarantees preview tab ids are unique within one process.
 * Desktop resources live across every connected environment, so they need a
 * stronger identity that also changes when a server process restarts.
 */
export function webRuntimeTabId(
  threadHandle: HostThreadRef,
  serverEpoch: string | null,
  tabKey: string,
): string {
  return JSON.stringify([threadHandle.hostId, threadHandle.threadId, serverEpoch, tabKey]);
}

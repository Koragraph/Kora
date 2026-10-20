import type { AtomActionResult } from "@kora/client-runtime/store/runtime";
import type { HostId, WebCloseInput, WebSessionSnapshot, HostThreadRef } from "@kora/contracts";

import { beginWebSessionClose, cancelWebSessionClose } from "~/stores/webStateStore";

interface CloseWebSessionInput<E> {
  readonly closePreview: (input: {
    readonly hostId: HostId;
    readonly input: WebCloseInput;
  }) => Promise<AtomActionResult<void, E>>;
  readonly snapshot: WebSessionSnapshot | null;
  readonly tabId: string;
  readonly threadRef: HostThreadRef;
}

/**
 * Optimistically closes a preview while suppressing stale list responses for
 * the same tab. A failed close restores the last known snapshot.
 */
export async function closeWebSession<E>(
  input: CloseWebSessionInput<E>,
): Promise<AtomActionResult<void, E>> {
  beginWebSessionClose(input.threadRef, input.tabId);
  const result = await input.closePreview({
    hostId: input.threadRef.hostId,
    input: { threadId: input.threadRef.threadId, tabId: input.tabId },
  });
  if (result._tag === "Failure") {
    cancelWebSessionClose(input.threadRef, input.snapshot, input.tabId);
  }
  return result;
}

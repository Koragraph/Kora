/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */

import type { BrowserPrefsReadError, OpenWebMutation } from "~/webview/openFileInWeb";
import { useDockStore } from "~/stores/dockStore";
import { openWebSession } from "./openWebSession";
import type { HostThreadRef } from "@kora/contracts";
import { mapAtomActionResult, type AtomActionResult } from "@kora/client-runtime/store/runtime";

export async function addBrowserSurface<E>(input: {
  readonly threadRef: HostThreadRef;
  readonly openPreview: OpenWebMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
}): Promise<AtomActionResult<void, E | BrowserPrefsReadError>> {
  const { openPreview, threadRef, profileId } = input;
  const result = await openWebSession({
    threadRef,
    openPreview,
    ...(profileId === undefined ? {} : { profileId }),
  });
  return mapAtomActionResult(result, (snapshot) => {
    useDockStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

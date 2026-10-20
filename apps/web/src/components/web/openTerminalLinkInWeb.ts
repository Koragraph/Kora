import type { OpenWebMutation } from "~/webview/openFileInWeb";
import { resolveBrowserLinkTargetPreference, isWebUrl } from "~/webview/browserLinkTarget";
import {
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
  browserDefaultOpenProfileId,
} from "~/webview/browserDefaults";
import { isWebSupportedInRuntime, applyWebDaemonSnapshot } from "~/stores/webStateStore";
import { rememberThreadVisit } from "~/stores/webHistoryStore";
import { useDockStore } from "~/stores/dockStore";
import type { HostThreadRef } from "@kora/contracts";
import { isAtomActionInterrupted } from "@kora/client-runtime/store/runtime";
import * as Schema from "effect/Schema";

const terminalLinkErrorContext = {
  cause: Schema.Defect(),
  targetOrigin: Schema.String,
  threadId: Schema.String,
  hostId: Schema.String,
};

export class TerminalLinkWebOpenError extends Schema.TaggedError<TerminalLinkWebOpenError>()(
  "TerminalLinkWebOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    const { targetOrigin, threadId } = this;
    return `Failed to open terminal link ${targetOrigin} in preview for thread ${threadId}.`;
  }
}

interface OpenTerminalLinkInWebInput<E> {
  readonly url: string;
  readonly threadRef: HostThreadRef;
  readonly openPreview: OpenWebMutation<E>;
  readonly fallbackToBrowser: () => void;
  /** Cmd/Ctrl-click bypasses the preference and opens in the system browser. */
  readonly forceBrowser: boolean;
}

/**
 * Opens a terminal hyperlink where the "Open links in" setting says, unless a
 * Cmd/Ctrl-click explicitly requests the system browser.
 */
export async function openTerminalLinkInWeb<E>(
  input: OpenTerminalLinkInWebInput<E>,
): Promise<void> {
  const { threadRef, url } = input;
  let supportsPreview = !input.forceBrowser && isWebUrl(url) && isWebSupportedInRuntime();
  if (supportsPreview && threadRef.threadId.length > 0) {
    supportsPreview = (await resolveBrowserLinkTargetPreference()) === "app";
  } else {
    supportsPreview = false;
  }

  if (supportsPreview === false) {
    return input.fallbackToBrowser();
  }

  const errorContext = {
    hostId: threadRef.hostId,
    threadId: threadRef.threadId,
    targetOrigin: new URL(url).origin,
  };

  const defaults = await resolveBrowserDefaults();
  const opened = await input.openPreview({
    hostId: threadRef.hostId,
    input: {
      // Same reason as `openUrlInWeb`: this path handles its own result
      // mapping, so the configured defaults are applied explicitly.
      profileId: browserDefaultOpenProfileId(defaults),
      viewport: browserDefaultOpenViewport(defaults),
      url,
      threadId: threadRef.threadId,
    },
  });
  if (opened._tag === "Failure") {
    if (!isAtomActionInterrupted(opened)) {
      console.error(new TerminalLinkWebOpenError({ cause: opened.cause, ...errorContext }));
      input.fallbackToBrowser();
    }
    return;
  }
  rememberThreadVisit(threadRef, url);
  applyWebDaemonSnapshot(threadRef, opened.value);
  useDockStore.getState().openBrowser(threadRef, opened.value.tabId);
}

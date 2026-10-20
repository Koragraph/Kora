import { BrowserPrefsReadError } from "~/webview/openFileInWeb";
import {
  browserDefaultOpenViewport,
  browserDefaultOpenProfileId,
  resolveBrowserDefaults,
} from "~/webview/browserDefaults";
import { applyWebDaemonSnapshot, rememberWebUrl } from "~/stores/webStateStore";
import type {
  WebSessionSnapshot,
  WebViewportSetting,
  HostThreadRef,
  WebOpenInput,
  HostId,
} from "@kora/contracts";
import type { AtomActionResult } from "@kora/client-runtime/store/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

interface OpenWebSessionInput<E> {
  openPreview: (input: {
    readonly hostId: HostId;
    readonly input: WebOpenInput;
  }) => Promise<AtomActionResult<WebSessionSnapshot, E>>;
  threadRef: HostThreadRef;
  url?: string;
  /** Overrides the configured default; automation passes an explicit size. */
  viewport?: WebViewportSetting;
  /** Overrides the configured default profile. */
  profileId?: string;
}

export async function openWebSession<E>(
  input: OpenWebSessionInput<E>,
): Promise<AtomActionResult<WebSessionSnapshot, E | BrowserPrefsReadError>> {
  // Resolved once: a tab opened before client settings hydrate would otherwise
  // be born at the schema defaults and never corrected.
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserPrefsReadError({ cause }),
  );
  if (defaults instanceof BrowserPrefsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const { threadRef, url } = input;
  const opened = await input.openPreview({
    hostId: threadRef.hostId,
    input: {
      profileId: input.profileId ?? browserDefaultOpenProfileId(defaults),
      viewport: input.viewport ?? browserDefaultOpenViewport(defaults),
      ...(url === undefined ? {} : { url }),
      threadId: threadRef.threadId,
    },
  });
  if (opened._tag !== "Failure") {
    const snapshot = opened.value;
    applyWebDaemonSnapshot(threadRef, snapshot);
    if (url !== undefined) {
      rememberWebUrl(threadRef, snapshot.navStatus._tag === "Idle" ? url : snapshot.navStatus.url);
    }
  }
  return opened;
}

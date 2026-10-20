import { AsyncResult } from "effect/unstable/reactivity";
import * as Data from "effect/Data";
import * as Cause from "effect/Cause";
import type { HostId, WebOpenInput, WebSessionSnapshot, HostThreadRef } from "@kora/contracts";
import { type AtomActionResult, mapAtomActionResult } from "@kora/client-runtime/store/runtime";

import { applyWebDaemonSnapshot, rememberWebUrl } from "~/stores/webStateStore";
import { useDockStore } from "~/stores/dockStore";
import {
  resolveBrowserDefaults,
  browserDefaultOpenViewport,
  browserDefaultOpenProfileId,
} from "./browserDefaults";

export class BrowserWebUnavailableError extends Data.TaggedError("BrowserWebUnavailableError")<{
  readonly message: string;
}> {}

export class BrowserPrefsReadError extends Data.TaggedError("BrowserPrefsReadError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenWebMutation<E = unknown> = (request: {
  readonly hostId: HostId;
  readonly input: WebOpenInput;
}) => Promise<AtomActionResult<WebSessionSnapshot, E>>;

export async function openUrlInWeb<E>(args: {
  readonly threadRef: HostThreadRef;
  readonly url: string;
  readonly openPreview: OpenWebMutation<E>;
}): Promise<AtomActionResult<void, E | BrowserPrefsReadError>> {
  const baseline = await resolveBrowserDefaults().catch(
    (reason: unknown) => new BrowserPrefsReadError({ cause: reason }),
  );
  if (baseline instanceof BrowserPrefsReadError) {
    return AsyncResult.failure(Cause.fail(baseline));
  }
  const result = await args.openPreview({
    hostId: args.threadRef.hostId,
    input: {
      threadId: args.threadRef.threadId,
      url: args.url,
      // Built here rather than via `openWebSession` because this path
      // maps the result differently, so the configured defaults have to be
      // applied explicitly or file/link opens would ignore them.
      viewport: browserDefaultOpenViewport(baseline),
      profileId: browserDefaultOpenProfileId(baseline),
    },
  });
  return mapAtomActionResult(result, (frameSnap) => {
    applyWebDaemonSnapshot(args.threadRef, frameSnap);
    rememberWebUrl(args.threadRef, args.url);
    useDockStore.getState().openBrowser(args.threadRef, frameSnap.tabId);
  });
}

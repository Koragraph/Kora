import { closeWebSession } from "./closeWebSession";

import {
  resetWebStateForTests,
  readThreadWebState,
  applyWebDaemonSnapshot,
} from "~/stores/webStateStore";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import type { WebCloseInput, WebSessionSnapshot, HostThreadRef } from "@kora/contracts";

const threadRef = {
  threadId: "thread-1" as HostThreadRef["threadId"],
  hostId: "local" as HostThreadRef["hostId"],
};

const snapshot: WebSessionSnapshot = {
  updatedAt: "2026-06-18T19:00:00.000Z",
  canGoForward: false,
  canGoBack: false,
  navStatus: {
    title: "Local app",
    url: "http://localhost:3000/",
    _tag: "Success",
  },
  tabId: "tab-1",
  threadId: threadRef.threadId,
};

beforeEach(resetWebStateForTests);

describe("closeWebSession", () => {
  it("restores the last snapshot when the server close fails", async () => {
    applyWebDaemonSnapshot(threadRef, snapshot);

    const result = await closeWebSession({
      threadRef,
      tabId: snapshot.tabId,
      snapshot,
      closePreview: async () => AsyncResult.failure(Cause.fail(new Error("close failed"))),
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadWebState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadWebState(threadRef).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });
  it("suppresses stale server snapshots while the close is in flight", async () => {
    applyWebDaemonSnapshot(threadRef, snapshot);
    let finishClose: (() => void) | undefined;
    const closePreview = vi.fn(
      (_input: WebCloseInput) =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
    );

    const closing = closeWebSession({
      threadRef,
      tabId: snapshot.tabId,
      snapshot,
      closePreview: ({ input }) => closePreview(input),
    });

    expect(readThreadWebState(threadRef).sessions).toEqual({});
    applyWebDaemonSnapshot(threadRef, snapshot);
    expect(readThreadWebState(threadRef).sessions).toEqual({});

    finishClose?.();
    await closing;
    expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
  });
});

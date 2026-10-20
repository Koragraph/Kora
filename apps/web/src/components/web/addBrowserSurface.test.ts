import { addBrowserSurface } from "./addBrowserSurface";
import { __setClientPrefsForTests } from "~/hooks/usePrefs";
import { selectThreadDockState, useDockStore } from "~/stores/dockStore";

import {
  resetWebStateForTests,
  readThreadWebState,
  applyWebDaemonSnapshot,
} from "~/stores/webStateStore";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  type HostThreadRef,
  type WebSessionSnapshot,
  type WebOpenInput,
  FILL_WEB_VIEWPORT,
  DEFAULT_CLIENT_PREFS,
  DEFAULT_WEB_PROFILE_ID,
} from "@kora/contracts";

const threadRef = {
  threadId: "thread-1" as HostThreadRef["threadId"],
  hostId: "local" as HostThreadRef["hostId"],
};

const snapshot = (tabId: string): WebSessionSnapshot => ({
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
  canGoForward: false,
  canGoBack: false,
  navStatus: { _tag: "Idle" },
  tabId,
  threadId: threadRef.threadId,
});

beforeEach(() => {
  __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
  resetWebStateForTests();
  useDockStore.setState({ byThreadKey: {} });
});

describe("addBrowserSurface", () => {
  it("creates another preview session when a browser tab is already active", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyWebDaemonSnapshot(threadRef, first);
    useDockStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: WebOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({
      profileId: DEFAULT_WEB_PROFILE_ID,
      viewport: FILL_WEB_VIEWPORT,
      threadId: "thread-1",
    });
    expect(Object.keys(readThreadWebState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    expect(
      selectThreadDockState(useDockStore.getState().byThreadKey, threadRef).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["browser:tab-1", "browser:tab-2"]);
  });
  it("opens under the requested profile", async () => {
    const openPreview = vi.fn(async (_input: WebOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    await addBrowserSurface({
      profileId: "profile-work",
      openPreview: ({ input }) => openPreview(input),
      threadRef,
    });

    expect(openPreview).toHaveBeenCalledWith({
      profileId: "profile-work",
      viewport: FILL_WEB_VIEWPORT,
      threadId: "thread-1",
    });
  });
});

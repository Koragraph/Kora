import {
  DEFAULT_CLIENT_PREFS,
  DEFAULT_WEB_PROFILE_ID,
  FILL_WEB_VIEWPORT,
  type HostThreadRef,
  type WebOpenInput,
  type WebSessionSnapshot,
} from "@kora/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { __setClientPrefsForTests } from "~/hooks/usePrefs";
import { readThreadWebState, resetWebStateForTests } from "~/stores/webStateStore";
import * as browserDefaults from "~/webview/browserDefaults";
import { BrowserPrefsReadError, openUrlInWeb } from "~/webview/openFileInWeb";

import { openWebSession } from "./openWebSession";

const THREAD: HostThreadRef = { hostId: "local" as never, threadId: "thread-1" as never };

const session = (over: Partial<WebSessionSnapshot> = {}): WebSessionSnapshot => ({
  tabId: "tab-1",
  threadId: THREAD.threadId,
  updatedAt: "2026-06-11T23:00:00.000Z",
  canGoBack: false,
  canGoForward: false,
  navStatus: { _tag: "Loading", title: "", url: "https://kora.dev/" },
  ...over,
});

const webState = () => readThreadWebState(THREAD);

beforeEach(() => {
  resetWebStateForTests();
  __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
});
afterEach(() => vi.restoreAllMocks());

describe("opening a web session", () => {
  test("the RPC reply is applied straight away and the URL is remembered", async () => {
    const reply = session();
    const send = vi.fn(async (_: WebOpenInput) => AsyncResult.success(reply));

    await openWebSession({
      threadRef: THREAD,
      url: "kora.dev",
      openPreview: ({ input }) => send(input),
    });

    expect(send).toHaveBeenCalledWith({
      threadId: "thread-1",
      url: "kora.dev",
      profileId: DEFAULT_WEB_PROFILE_ID,
      viewport: FILL_WEB_VIEWPORT,
    });
    expect(webState().snapshot).toEqual(reply);
    expect(webState().recentlySeenUrls).toEqual(["https://kora.dev/"]);
  });

  test("a blank tab is applied but leaves the recent URLs empty", async () => {
    const blank = session({ tabId: "tab-blank", navStatus: { _tag: "Idle" } });
    const send = vi.fn(async (_: WebOpenInput) => AsyncResult.success(blank));

    await openWebSession({ threadRef: THREAD, openPreview: ({ input }) => send(input) });

    expect(send).toHaveBeenCalledWith({
      threadId: "thread-1",
      profileId: DEFAULT_WEB_PROFILE_ID,
      viewport: FILL_WEB_VIEWPORT,
    });
    expect(webState().snapshot).toEqual(blank);
    expect(webState().recentlySeenUrls).toEqual([]);
  });

  test("an RPC failure is returned and changes nothing", async () => {
    const result = await openWebSession({
      threadRef: THREAD,
      url: "kora.dev",
      openPreview: async () => AsyncResult.failure(Cause.fail(new Error("preview unavailable"))),
    });

    expect(result._tag).toBe("Failure");
    expect(webState().snapshot).toBeNull();
    expect(webState().recentlySeenUrls).toEqual([]);
  });

  test.each([
    ["openWebSession", openWebSession],
    ["openUrlInWeb", openUrlInWeb],
  ] as const)(
    "%s refuses to open while the settings are unreadable, then uses the saved profile on retry",
    async (_name, open) => {
      const unreadable = new Error("settings unreadable");
      vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(unreadable);
      const viewport = { _tag: "freeform", width: 1280, height: 720 } as const;
      __setClientPrefsForTests({
        ...DEFAULT_CLIENT_PREFS,
        browserDefaultViewport: viewport,
        browserDefaultProfileId: "work",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
      });
      const openPreview = vi.fn(async () => AsyncResult.success(session()));
      const args = { openPreview, threadRef: THREAD, url: "https://kora.dev/" };

      const first = await open(args);
      expect(first._tag).toBe("Failure");
      if (first._tag === "Failure") {
        const error = Cause.squash(first.cause);
        expect(error).toBeInstanceOf(BrowserPrefsReadError);
        expect(error).toMatchObject({ cause: unreadable });
      }
      expect(openPreview).not.toHaveBeenCalled();
      expect(webState().snapshot).toBeNull();

      await expect(open(args)).resolves.toMatchObject({ _tag: "Success" });
      expect(openPreview).toHaveBeenCalledExactlyOnceWith({
        hostId: THREAD.hostId,
        input: { threadId: THREAD.threadId, url: args.url, profileId: "work", viewport },
      });
    },
  );
});

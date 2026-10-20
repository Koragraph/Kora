import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { act } from "react";
import {
  type ShellWebBridge,
  type ClientPrefs,
  ThreadId,
  FILL_WEB_VIEWPORT,
  HostId,
  DEFAULT_CLIENT_PREFS,
} from "@kora/contracts";

const mocks = vi.hoisted(() => ({
  activeRecordings: new Set<string>(),
  getWebConfig: vi.fn<ShellWebBridge["getWebConfig"]>(),
  registerWebview: vi.fn<ShellWebBridge["registerWebview"]>(),
  closeTab: vi.fn<ShellWebBridge["closeTab"]>(),
  createTab: vi.fn<ShellWebBridge["createTab"]>(),
  setClientPrefs: vi.fn<(settings: ClientPrefs) => Promise<void>>(),
  getClientPrefs: vi.fn<() => Promise<ClientPrefs | null>>(),
}));

vi.mock("~/localApi", () => ({
  localApiOrThrow: () => ({ persistence: mocks }),
}));

vi.mock("~/components/web/webBridge", () => ({
  webBridge: {
    getWebConfig: mocks.getWebConfig,
    registerWebview: mocks.registerWebview,
    closeTab: mocks.closeTab,
    createTab: mocks.createTab,
  },
}));

vi.mock("~/components/web/useWebBridge", () => ({
  useWebBridge: () => undefined,
}));

vi.mock("./browserScreencast", () => ({
  stopBrowserScreencast: async () => null,
  useActiveBrowserScreencastTabIds: () => mocks.activeRecordings,
}));

import { HostedBrowserWebview } from "./HostedBrowserWebview";
import * as shellTabLifetime from "./shellTabLifetime";
import { usePreviewDockStore } from "./browserSurfaceStore";

import { __resetClientPrefsPersistenceForTests, ensureClientPrefsHydrated } from "~/hooks/usePrefs";

let mounted: ReactTestRenderer | undefined;

function pending<T>() {
  const handlers = {} as { ok: (v: T) => void; fail: (e: unknown) => void };
  const promise = new Promise<T>((ok, fail) => Object.assign(handlers, { ok, fail }));
  return { promise, ...handlers };
}

const resetSurfaces = () => usePreviewDockStore.setState({ activityByTabId: {}, byTabId: {} });

function installBridgeDefaults() {
  mocks.getClientPrefs.mockReset();
  for (const fn of [mocks.setClientPrefs, mocks.createTab, mocks.closeTab, mocks.registerWebview]) {
    fn.mockReset().mockResolvedValue(undefined);
  }
  mocks.getWebConfig.mockResolvedValue({
    preloadUrl: null,
    webPreferences: "contextIsolation=yes",
    partition: "persist:kora-preview-work",
  });
}

beforeEach(() => {
  __resetClientPrefsPersistenceForTests();
  resetSurfaces();
  installBridgeDefaults();
  const stubs: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: globalThis,
    navigator: { platform: "Linux" },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  };
  for (const [name, value] of Object.entries(stubs)) vi.stubGlobal(name, value);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  const view = mounted;
  mounted = undefined;
  vi.useFakeTimers();
  await act(() => view?.unmount());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientPrefsPersistenceForTests();
  resetSurfaces();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview before settings are known", () => {
  test("a kept-alive background tab stays dormant until a settings read succeeds", async () => {
    const creating = pending<void>();
    const second = pending<ClientPrefs | null>();
    const first = pending<ClientPrefs | null>();
    mocks.getClientPrefs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const thread = { hostId: HostId.make("host-retry"), threadId: ThreadId.make("thread-retry") };
    const guestNode = Object.assign(new EventTarget(), { getWebContentsId: () => 41 });
    const makeGuest = vi.fn((_props: unknown) => guestNode);
    const acquireSpy = vi.spyOn(shellTabLifetime, "acquireShellTab");
    mocks.createTab.mockReturnValueOnce(creating.promise);
    const tab = "retained-bg";
    usePreviewDockStore.getState().acquireActivity(tab);

    const nothingStarted = () => {
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(makeGuest).not.toHaveBeenCalled();
      expect(mocks.createTab).not.toHaveBeenCalled();
    };

    await act(() => {
      mounted = create(
        <HostedBrowserWebview
          threadRef={thread}
          tabId="server-tab"
          runtimeTabId={tab}
          initialUrl="https://example.com"
          viewport={FILL_WEB_VIEWPORT}
          zoomFactor={1.5}
          profileId="work"
          pictureInPicture={false}
        />,
        {
          createNodeMock: (el) =>
            el.type === "webview"
              ? makeGuest(el.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    expect(mocks.getClientPrefs).toHaveBeenCalledOnce();
    nothingStarted();

    const readError = new Error("prefs unavailable");
    await act(async () => {
      const attempt = ensureClientPrefsHydrated();
      first.fail(readError);
      await expect(attempt).rejects.toBe(readError);
    });
    nothingStarted();

    let secondAttempt!: Promise<void>;
    await act(() => {
      secondAttempt = ensureClientPrefsHydrated();
    });
    expect(mocks.getClientPrefs).toHaveBeenCalledTimes(2);
    nothingStarted();

    await act(async () => {
      second.ok({
        ...DEFAULT_CLIENT_PREFS,
        browserDefaultZoomFactor: 1.5,
        browserDefaultAppearance: "light",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await secondAttempt;
    });

    expect(acquireSpy).toHaveBeenCalledExactlyOnceWith(tab);
    expect(mocks.getWebConfig).toHaveBeenCalledExactlyOnceWith(thread.hostId, "work");
    expect(makeGuest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        src: "https://example.com",
        partition: "persist:kora-preview-work",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(tab, {
      colorScheme: "light",
      zoomFactor: 1.5,
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      creating.ok();
      await creating.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(tab, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientPrefs).not.toHaveBeenCalled();
  });
});

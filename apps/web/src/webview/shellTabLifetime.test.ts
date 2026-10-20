import {
  DEFAULT_CLIENT_PREFS,
  DEFAULT_WEB_APPEARANCE,
  DEFAULT_WEB_ZOOM_FACTOR,
  HostId,
  ThreadId,
} from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({
  stopRecording: vi.fn(async () => null),
  createTab: vi.fn<() => Promise<void>>(),
  closeTab: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
}));

vi.mock("~/components/web/webBridge", () => ({
  webBridge: { closeTab: bridge.closeTab, createTab: bridge.createTab },
}));
vi.mock("./browserScreencast", () => ({ stopBrowserScreencast: bridge.stopRecording }));

import { __setClientPrefsForTests } from "~/hooks/usePrefs";

import * as browserDefaults from "./browserDefaults";
import { acquireShellTab } from "./shellTabLifetime";
import { webRuntimeTabId } from "./webRuntimeTabId";

const FACTORY_STATE = { colorScheme: DEFAULT_WEB_APPEARANCE, zoomFactor: DEFAULT_WEB_ZOOM_FACTOR };

/** Returns a promise plus the function that settles it. */
function deferred<T = void>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeEach(() => {
  __setClientPrefsForTests(DEFAULT_CLIENT_PREFS);
  bridge.closeTab.mockClear();
  bridge.createTab.mockClear();
  bridge.stopRecording.mockClear();
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireShellTab", () => {
  test("concurrent leases on one tab share a single creation", async () => {
    const creation = deferred();
    bridge.createTab.mockReturnValueOnce(creation.promise);

    const a = acquireShellTab("shared");
    const b = acquireShellTab("shared");
    expect(a.ready).toBe(b.ready);

    let done = false;
    void a.ready.then(() => {
      done = true;
    });
    // Creation waits on client prefs so the guest is born at the user's zoom/appearance.
    await vi.waitFor(() => expect(bridge.createTab).toHaveBeenCalledOnce());
    expect(done).toBe(false);

    creation.settle();
    await a.ready;
    expect(done).toBe(true);
  });

  test("the same server tab id in two hosts gets two desktop tabs", async () => {
    vi.useFakeTimers();
    bridge.createTab.mockResolvedValue(undefined);
    const idFor = (letter: string) =>
      webRuntimeTabId(
        { threadId: ThreadId.make(`thread-${letter}`), hostId: HostId.make(`host-${letter}`) },
        `epoch-${letter}`,
        "tab_1",
      );
    const [idA, idB] = [idFor("a"), idFor("b")];

    const leases = [acquireShellTab(idA), acquireShellTab(idB)];
    await Promise.all(leases.map((l) => l.ready));

    expect(bridge.createTab.mock.calls).toEqual([
      [idA, FACTORY_STATE],
      [idB, FACTORY_STATE],
    ]);
    leases.forEach((l) => l.release());
    await vi.advanceTimersByTimeAsync(0);
  });

  test("a recording is stopped first, and only then is the last lease's tab closed", async () => {
    vi.useFakeTimers();
    const recordingStopped = deferred<null>();
    bridge.stopRecording.mockReturnValueOnce(recordingStopped.promise);
    bridge.createTab.mockResolvedValueOnce(undefined);

    const lease = acquireShellTab("rec-tab");
    await lease.ready;
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.stopRecording).toHaveBeenCalledWith("rec-tab");
    expect(bridge.closeTab).not.toHaveBeenCalled();

    recordingStopped.settle(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.closeTab).toHaveBeenCalledWith("rec-tab");
  });

  test("re-acquiring while a close is in flight recreates the tab only after the close ends", async () => {
    vi.useFakeTimers();
    const closing = deferred();
    bridge.createTab.mockResolvedValue(undefined);
    bridge.closeTab.mockReturnValueOnce(closing.promise);

    const first = acquireShellTab("flip");
    await first.ready;
    first.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.closeTab).toHaveBeenCalledWith("flip");

    const second = acquireShellTab("flip");
    expect(bridge.createTab).toHaveBeenCalledTimes(1);

    closing.settle();
    await second.ready;
    expect(bridge.createTab).toHaveBeenCalledTimes(2);
  });

  test("a lease taken again before the close timer fires cancels the close", async () => {
    vi.useFakeTimers();
    bridge.createTab.mockResolvedValue(undefined);

    const first = acquireShellTab("kept");
    await first.ready;
    first.release();
    const second = acquireShellTab("kept");
    await vi.advanceTimersByTimeAsync(10);

    expect(bridge.closeTab).not.toHaveBeenCalled();
    expect(bridge.createTab).toHaveBeenCalledTimes(1);
    second.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.closeTab).toHaveBeenCalledTimes(1);
  });

  test("failing to read settings creates nothing, and a later acquire retries with fresh prefs", async () => {
    vi.useFakeTimers();
    const boom = new Error("settings unreadable");
    vi.spyOn(browserDefaults, "resolveBrowserDefaults").mockRejectedValueOnce(boom);

    const failed = acquireShellTab("retry-tab");
    await expect(failed.ready).rejects.toBe(boom);
    expect(bridge.createTab).not.toHaveBeenCalled();
    failed.release();
    await vi.advanceTimersByTimeAsync(0);

    __setClientPrefsForTests({
      ...DEFAULT_CLIENT_PREFS,
      browserDefaultZoomFactor: 1.25,
      browserDefaultAppearance: "dark",
    });
    bridge.createTab.mockResolvedValueOnce(undefined);
    const again = acquireShellTab("retry-tab");
    await again.ready;

    expect(bridge.createTab).toHaveBeenCalledExactlyOnceWith("retry-tab", {
      colorScheme: "dark",
      zoomFactor: 1.25,
    });
    again.release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

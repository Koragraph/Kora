import type { WebViewportSetting } from "@kora/contracts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS,
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "./browserViewportActions";

const free = (width: number, height: number): WebViewportSetting => ({
  _tag: "freeform",
  width,
  height,
});

function latch<T = void>() {
  const hooks = {} as { resolve: (v: T) => void };
  const promise = new Promise<T>((resolve) => Object.assign(hooks, { resolve }));
  return { promise, resolve: hooks.resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("viewport commit queue", () => {
  test("commits for one tab run strictly one after another", async () => {
    const seen: number[] = [];
    let unblockFirst!: () => void;
    const firstStarted = latch();
    const firstGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    const off = subscribeBrowserViewportChange("serial", async (setting) => {
      if (setting._tag === "fill") return;
      seen.push(setting.width);
      if (setting.width === 640) {
        firstStarted.resolve();
        await firstGate;
      }
    });

    const a = commitBrowserViewportChange("serial", free(640, 480));
    const b = commitBrowserViewportChange("serial", free(1024, 768));
    await firstStarted.promise;
    expect(seen).toEqual([640]);

    unblockFirst();
    await Promise.all([a, b]);
    expect(seen).toEqual([640, 1024]);
    off();
  });

  test("a commit that times out still blocks the next one until the handler really finishes", async () => {
    vi.useFakeTimers();
    const slow = latch();
    const handler = vi.fn(async (_s: WebViewportSetting): Promise<void> => undefined);
    handler.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(undefined);
    const off = subscribeBrowserViewportChange("slow", handler);

    const first = commitBrowserViewportChange("slow", free(640, 480));
    const firstFails = expect(first).rejects.toThrow(
      "Timed out committing the browser viewport for tab slow",
    );
    const second = commitBrowserViewportChange("slow", free(1024, 768));

    await vi.advanceTimersByTimeAsync(BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS);
    await firstFails;
    expect(handler).toHaveBeenCalledTimes(1);

    slow.resolve();
    await second;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0]).toMatchObject({ width: 1024, height: 768 });
    off();
  });

  test("a handler failure rejects its caller but does not poison the queue", async () => {
    const handler = vi.fn(async (_s: WebViewportSetting): Promise<void> => undefined);
    handler.mockRejectedValueOnce(new Error("guest refused"));
    const off = subscribeBrowserViewportChange("flaky", handler);

    await expect(commitBrowserViewportChange("flaky", free(300, 300))).rejects.toThrow(
      "guest refused",
    );
    await expect(commitBrowserViewportChange("flaky", free(400, 400))).resolves.toBeUndefined();
    off();
  });

  test("queues are per tab", async () => {
    const gate = latch();
    const slowTab = vi.fn(() => gate.promise);
    const fastTab = vi.fn(async () => undefined);
    const offA = subscribeBrowserViewportChange("tab-slow", slowTab);
    const offB = subscribeBrowserViewportChange("tab-fast", fastTab);

    const pending = commitBrowserViewportChange("tab-slow", free(300, 300));
    await commitBrowserViewportChange("tab-fast", free(300, 300));
    expect(fastTab).toHaveBeenCalledOnce();

    gate.resolve();
    await pending;
    offA();
    offB();
  });
});

describe("subscription", () => {
  test("the latest handler wins, and unsubscribing a replaced handler is a no-op", async () => {
    const older = vi.fn(async () => undefined);
    const newer = vi.fn(async () => undefined);
    const offOlder = subscribeBrowserViewportChange("swap", older);
    const offNewer = subscribeBrowserViewportChange("swap", newer);

    offOlder();
    await commitBrowserViewportChange("swap", free(900, 700));
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledWith(free(900, 700));

    offNewer();
    await expect(commitBrowserViewportChange("swap", free(800, 600))).rejects.toThrow(
      "No visible browser viewport handler",
    );
  });
});

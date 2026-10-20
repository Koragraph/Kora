import type { HostThreadRef, WebSessionSnapshot } from "@kora/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const doubles = vi.hoisted(() => ({
  loadDefaults: vi.fn(),
  linkTarget: vi.fn<() => "system" | "app">(),
}));

vi.mock("~/stores/webStateStore", () => ({
  isWebSupportedInRuntime: () => true,
  applyWebDaemonSnapshot: vi.fn(),
}));
vi.mock("~/stores/dockStore", () => ({
  useDockStore: { getState: () => ({ openBrowser: vi.fn() }) },
}));
vi.mock("~/webview/browserDefaults", () => ({
  browserDefaultOpenProfileId: (d: { profileId: string }) => d.profileId,
  browserDefaultOpenViewport: (d: { viewport: unknown }) => d.viewport,
  resolveBrowserDefaults: doubles.loadDefaults,
}));
vi.mock("~/webview/browserLinkTarget", () => ({
  isWebUrl: (url: string) => /^https?:/u.test(url),
  resolveBrowserLinkTargetPreference: async () => doubles.linkTarget(),
}));

import { openTerminalLinkInWeb, TerminalLinkWebOpenError } from "./openTerminalLinkInWeb";

const DEFAULTS = {
  profileId: "work",
  viewport: { _tag: "fixed", width: 1280, height: 720 } as const,
};
const THREAD: HostThreadRef = { hostId: "local" as never, threadId: "thread-1" as never };
const SNAPSHOT: WebSessionSnapshot = {
  tabId: "tab-1",
  threadId: THREAD.threadId,
  updatedAt: "2026-06-20T00:00:00.000Z",
  canGoBack: false,
  canGoForward: false,
  navStatus: { _tag: "Idle" },
};

/** One call of the function under test, with spies for both outcomes. */
function attempt(
  over: { url?: string; forceBrowser?: boolean; openPreview?: () => Promise<unknown> } = {},
) {
  const fallbackToBrowser = vi.fn();
  const openPreview = vi.fn(over.openPreview ?? (async () => AsyncResult.success(SNAPSHOT)));
  const done = openTerminalLinkInWeb({
    forceBrowser: over.forceBrowser ?? false,
    fallbackToBrowser,
    openPreview: openPreview as never,
    threadRef: THREAD,
    url: over.url ?? "http://localhost:3000/",
  });
  return { done, fallbackToBrowser, openPreview };
}

beforeEach(() => {
  doubles.loadDefaults.mockReset().mockResolvedValue(DEFAULTS);
  doubles.linkTarget.mockReturnValue("app");
});
afterEach(() => vi.restoreAllMocks());

describe("openTerminalLinkInWeb", () => {
  test("a held modifier (forceBrowser) goes straight to the system browser", async () => {
    const run = attempt({ forceBrowser: true, url: "https://example.com/docs" });
    await run.done;
    expect(run.fallbackToBrowser).toHaveBeenCalledOnce();
    expect(run.openPreview).not.toHaveBeenCalled();
  });

  test("the system-browser preference does the same", async () => {
    doubles.linkTarget.mockReturnValue("system");
    const run = attempt();
    await run.done;
    expect(run.fallbackToBrowser).toHaveBeenCalledOnce();
    expect(run.openPreview).not.toHaveBeenCalled();
  });

  test("public URLs open in-app as well as local servers", async () => {
    const run = attempt({ url: "https://example.com/docs" });
    await run.done;
    expect(run.openPreview).toHaveBeenCalledOnce();
    expect(run.fallbackToBrowser).not.toHaveBeenCalled();
  });

  test("it waits for the hydrated defaults, then opens with their profile and viewport", async () => {
    let hydrate!: (d: typeof DEFAULTS) => void;
    doubles.loadDefaults.mockImplementationOnce(
      () => new Promise((resolve) => (hydrate = resolve)),
    );
    const run = attempt();

    await vi.waitFor(() => expect(doubles.loadDefaults).toHaveBeenCalledOnce());
    expect(run.openPreview).not.toHaveBeenCalled();

    hydrate(DEFAULTS);
    await run.done;
    expect(run.openPreview).toHaveBeenCalledWith({
      hostId: "local",
      input: {
        threadId: "thread-1",
        url: "http://localhost:3000/",
        profileId: "work",
        viewport: DEFAULTS.viewport,
      },
    });
  });

  test("an interrupted open is neither logged nor retried in the system browser", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = attempt({ openPreview: async () => AsyncResult.failure(Cause.interrupt()) });
    await run.done;
    expect(log).not.toHaveBeenCalled();
    expect(run.fallbackToBrowser).not.toHaveBeenCalled();
  });

  test("a failed open falls back, and logs an error that keeps the whole cause but not its text", async () => {
    const rpc = new Error("preview unavailable");
    const cause = Cause.combine(Cause.fail(rpc), Cause.die("defect"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const run = attempt({
      url: "http://127.0.0.1:5173/",
      openPreview: async () => AsyncResult.failure(cause),
    });
    await run.done;

    expect(run.fallbackToBrowser).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const logged = log.mock.calls[0]![0];
    expect(logged).toBeInstanceOf(TerminalLinkWebOpenError);
    expect(logged).toMatchObject({
      cause,
      targetOrigin: "http://127.0.0.1:5173",
      threadId: "thread-1",
      hostId: "local",
    });
    expect(logged.message).not.toContain("preview unavailable");
  });

  test.each(["link-target preference", "browser defaults"] as const)(
    "if reading the %s fails, neither browser is opened",
    async (which) => {
      const failure = new Error("settings read failed");
      if (which === "link-target preference") {
        doubles.linkTarget.mockImplementationOnce(() => {
          throw failure;
        });
      } else doubles.loadDefaults.mockRejectedValueOnce(failure);

      const run = attempt({ url: "https://example.com/docs" });
      await expect(run.done).rejects.toBe(failure);
      expect(run.fallbackToBrowser).not.toHaveBeenCalled();
      expect(run.openPreview).not.toHaveBeenCalled();
    },
  );
});

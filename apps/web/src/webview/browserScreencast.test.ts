import { SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const rig = vi.hoisted(() => {
  const log: string[] = [];
  return {
    log,
    prefs: { browserRecordingFrameRate: 30 as 30 | 60 },
    nativeStop: vi.fn(async () => undefined),
    nativeStart: vi.fn(async (_tab: string) => {
      log.push("native-start");
    }),
    saveFile: vi.fn(async (tab: string) => ({
      createdAt: "2026-06-26T00:00:00.000Z",
      sizeBytes: 0,
      mimeType: "video/webm" as const,
      path: "/tmp/clip.webm",
      tabId: tab,
      id: "clip",
    })),
    armCapture: vi.fn((_tab: string) => undefined),
    getDisplayMedia: vi.fn(),
    publishTabs: vi.fn((_atom: unknown, v: { readonly tabIds: ReadonlySet<string> }) => {
      log.push(v.tabIds.size === 0 ? "clear" : `publish:${[...v.tabIds].join(",")}`);
    }),
  };
});

vi.mock("~/components/web/webBridge", () => ({
  webBridge: {
    recording: {
      stopScreencast: rig.nativeStop,
      save: rig.saveFile,
      onFrame: vi.fn(),
      startScreencast: async (tab: string) => {
        await rig.nativeStart(tab);
        rig.armCapture(tab);
      },
    },
  },
}));
vi.mock("~/wire/atomRegistry", () => ({ koraAtomRegistry: { set: rig.publishTabs } }));
vi.mock("~/hooks/usePrefs", () => ({
  getClientPrefs: () => rig.prefs,
  ensureClientPrefsHydrated: vi.fn(async () => undefined),
}));

import {
  BROWSER_SCREENCAST_PAINT_SETTLE_TIMEOUT_MS,
  BROWSER_SCREENCAST_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserScreencastConflictError,
  startBrowserScreencast,
  stopBrowserScreencast,
} from "./browserScreencast";
import { usePreviewDockStore } from "./browserSurfaceStore";

class StubRecorder {
  static made: StubRecorder[] = [];
  static supported = new Set<string>();
  static reportedType: string | undefined;
  static failStopWith: unknown;
  static isTypeSupported = (type: string) => StubRecorder.supported.has(type);

  state: RecordingState = "inactive";
  readonly mimeType: string;
  private stopListeners: Array<() => void> = [];

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    this.mimeType = StubRecorder.reportedType ?? options?.mimeType ?? "video/browser-default";
    StubRecorder.made.push(this);
  }
  addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    if (type === "stop")
      this.stopListeners.push(() =>
        typeof fn === "function" ? fn(new Event("stop")) : fn.handleEvent(new Event("stop")),
      );
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (StubRecorder.failStopWith !== undefined) throw StubRecorder.failStopWith;
    this.state = "inactive";
    this.stopListeners.forEach((fn) => fn());
  }
}

/** A promise-backed latch so a test decides exactly when an async step finishes. */
function latch() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

const fakeStream = (track = { stop: vi.fn() }, video: unknown[] = []) =>
  ({ getTracks: () => [track], getVideoTracks: () => video }) as unknown as MediaStream;

const surface = () => usePreviewDockStore.getState().activityByTabId;
const TAB = "tab-a";

let frames = 0;

beforeEach(() => {
  rig.log.length = 0;
  vi.clearAllMocks();
  StubRecorder.made = [];
  StubRecorder.supported = new Set(["video/webm;codecs=vp9"]);
  StubRecorder.reportedType = undefined;
  StubRecorder.failStopWith = undefined;
  rig.prefs.browserRecordingFrameRate = 30;
  frames = 0;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(++frames);
    return frames;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("MediaRecorder", StubRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: rig.getDisplayMedia } });
  rig.getDisplayMedia.mockResolvedValue(fakeStream());
  rig.armCapture.mockImplementation((tab: string) => {
    const fire = Reflect.get(globalThis, SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER);
    if (typeof fire !== "function" || fire(tab) !== true)
      throw new Error(`nothing armed for ${tab}`);
  });
  usePreviewDockStore.setState({ activityByTabId: {}, byTabId: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Make the native start hang until the returned latch opens. */
function holdNativeStart() {
  const gate = latch();
  rig.nativeStart.mockImplementationOnce(async () => {
    rig.log.push("native-start");
    await gate.closed;
  });
  return gate.open;
}

const untilNativeStartCalled = () =>
  vi.waitFor(() => expect(rig.nativeStart).toHaveBeenCalledOnce());

describe("start/stop lifecycle", () => {
  test("a visible tab publishes itself, then asks native to start", async () => {
    await startBrowserScreencast(TAB);
    const seen = [...rig.log];
    await stopBrowserScreencast(TAB);
    expect(seen).toEqual([`publish:${TAB}`, "native-start"]);
  });

  test("stop waits for a start in flight and then yields the artifact", async () => {
    const release = holdNativeStart();
    const starting = startBrowserScreencast(TAB);
    await untilNativeStartCalled();

    const stopping = stopBrowserScreencast(TAB);
    expect(rig.nativeStop).not.toHaveBeenCalled();
    release();

    await starting;
    await expect(stopping).resolves.toMatchObject({ tabId: TAB });
    expect(rig.nativeStop).toHaveBeenCalledOnce();
    expect(rig.saveFile).toHaveBeenCalledOnce();
    expect(rig.log.at(-1)).toBe("clear");
  });

  test("a stop that outwaits startup fails but keeps the slot until startup ends", async () => {
    vi.useFakeTimers();
    const release = holdNativeStart();
    const starting = startBrowserScreencast(TAB);
    await untilNativeStartCalled();

    const stopping = stopBrowserScreencast(TAB);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.nativeStop).not.toHaveBeenCalled();

    const failed = expect(stopping).rejects.toMatchObject({
      tabId: TAB,
      operation: "wait-startup",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_SCREENCAST_STARTUP_SETTLE_TIMEOUT_MS);
    await failed;
    expect(rig.saveFile).not.toHaveBeenCalled();
    await expect(startBrowserScreencast(TAB)).rejects.toBeInstanceOf(
      BrowserScreencastConflictError,
    );

    release();
    await vi.advanceTimersByTimeAsync(32);
    await starting;
    await expect(stopBrowserScreencast(TAB)).resolves.toBeNull();
    expect(rig.nativeStop).toHaveBeenCalledOnce();
    expect(rig.saveFile).not.toHaveBeenCalled();
    expect(rig.log.at(-1)).toBe("clear");
  });

  test("a stop whose native call fails also keeps the slot until startup ends", async () => {
    const release = holdNativeStart();
    rig.nativeStop.mockRejectedValueOnce(new Error("native stop refused"));

    const starting = startBrowserScreencast(TAB);
    await untilNativeStartCalled();
    const failed = expect(stopBrowserScreencast(TAB)).rejects.toMatchObject({
      tabId: TAB,
      operation: "stop-screencast",
    });
    expect(rig.nativeStop).not.toHaveBeenCalled();
    await expect(startBrowserScreencast(TAB)).rejects.toBeInstanceOf(
      BrowserScreencastConflictError,
    );

    release();
    await starting;
    await failed;
    expect(rig.nativeStop).toHaveBeenCalledOnce();

    await startBrowserScreencast(TAB);
    await stopBrowserScreencast(TAB);
  });

  test("a restart queued behind a cancelled start does not begin before the first start settles", async () => {
    const release = holdNativeStart();
    const first = startBrowserScreencast(TAB);
    await untilNativeStartCalled();

    const stopping = stopBrowserScreencast(TAB);
    const restarted = stopping.then(() => startBrowserScreencast(TAB));
    await new Promise((r) => setTimeout(r, 0));
    const nativeStartsWhileBlocked = rig.nativeStart.mock.calls.length;

    release();
    await first;
    await stopping;
    await restarted;
    await stopBrowserScreencast(TAB);
    expect(nativeStartsWhileBlocked).toBe(1);
  });

  test("concurrent stops share one run", async () => {
    const release = latch();
    rig.nativeStop.mockImplementationOnce(async () => {
      await release.closed;
      return undefined;
    });
    await startBrowserScreencast(TAB);
    const a = stopBrowserScreencast(TAB);
    await vi.waitFor(() => expect(rig.nativeStop).toHaveBeenCalledOnce());
    const b = stopBrowserScreencast(TAB);
    release.open();
    const [x, y] = await Promise.all([a, b]);
    expect(y).toEqual(x);
    expect(rig.nativeStop).toHaveBeenCalledOnce();
    expect(rig.saveFile).toHaveBeenCalledOnce();
  });

  test("starting during a stop is a conflict, not a success", async () => {
    const release = latch();
    rig.nativeStop.mockImplementationOnce(async () => {
      await release.closed;
      return undefined;
    });
    await startBrowserScreencast(TAB);
    const stopping = stopBrowserScreencast(TAB);
    await vi.waitFor(() => expect(rig.nativeStop).toHaveBeenCalledOnce());
    await expect(startBrowserScreencast(TAB)).rejects.toBeInstanceOf(
      BrowserScreencastConflictError,
    );
    release.open();
    await stopping;
  });

  test("a second start while the first is still starting is a conflict", async () => {
    const release = holdNativeStart();
    const first = startBrowserScreencast(TAB);
    await untilNativeStartCalled();
    await expect(startBrowserScreencast(TAB)).rejects.toBeInstanceOf(
      BrowserScreencastConflictError,
    );
    release();
    await first;
    await stopBrowserScreencast(TAB);
  });

  test("stopping a tab that is not recording is a no-op", async () => {
    await expect(stopBrowserScreencast("never-started")).resolves.toBeNull();
    expect(rig.nativeStop).not.toHaveBeenCalled();
  });
});

describe("capture failures", () => {
  test("a rejected display capture releases the native lease and the slot", async () => {
    rig.getDisplayMedia.mockRejectedValueOnce(new Error("denied"));
    await expect(startBrowserScreencast(TAB)).rejects.toMatchObject({
      tabId: TAB,
      operation: "capture-media-stream",
    });
    expect(rig.nativeStop).toHaveBeenCalledWith(TAB);
    expect(rig.log.at(-1)).toBe("clear");
  });

  test("a recorder that will not stop still releases the tracks and reports a cleanup error", async () => {
    const track = { stop: vi.fn() };
    rig.getDisplayMedia.mockResolvedValueOnce(fakeStream(track));
    await startBrowserScreencast(TAB);
    StubRecorder.failStopWith = new Error("recorder stuck");
    await expect(stopBrowserScreencast(TAB)).rejects.toMatchObject({
      tabId: TAB,
      operation: "cleanup",
    });
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

describe("encoder and quality choices", () => {
  test("with no preferred type supported the browser picks the format", async () => {
    StubRecorder.supported = new Set();
    StubRecorder.reportedType = "video/platform-default";
    await startBrowserScreencast(TAB);
    await stopBrowserScreencast(TAB);
    expect(StubRecorder.made[0]?.options).toEqual({ videoBitsPerSecond: 3_110_400 });
    expect(rig.saveFile).toHaveBeenCalledWith(
      TAB,
      "video/platform-default",
      expect.any(Uint8Array),
    );
  });

  test("the first supported type in preference order is requested; the recorder's own type is saved", async () => {
    StubRecorder.supported = new Set([
      "video/webm;codecs=av1",
      "video/webm;codecs=vp9",
      "video/mp4;codecs=avc1.42e01e",
      "video/mp4;codecs=avc1",
    ]);
    StubRecorder.reportedType = "video/webm;codecs=av01";
    await startBrowserScreencast(TAB);
    await stopBrowserScreencast(TAB);
    expect(StubRecorder.made[0]?.options).toEqual({
      videoBitsPerSecond: 3_110_400,
      mimeType: "video/mp4;codecs=avc1",
    });
    expect(rig.saveFile).toHaveBeenCalledWith(
      TAB,
      "video/webm;codecs=av01",
      expect.any(Uint8Array),
    );
  });

  test("the configured frame rate is asked of getDisplayMedia", async () => {
    rig.prefs.browserRecordingFrameRate = 60;
    await startBrowserScreencast(TAB);
    expect(rig.getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: false,
    });
    await stopBrowserScreencast(TAB);
  });

  test.each([
    [7680, 4320, 60, 50_000_000],
    [3840, 2160, 60, 24_883_200],
    [1280, 720, 60, 2_764_800],
    [320, 240, 30, 2_500_000],
  ])(
    "a %ix%i@%i stream is recorded at %i bps (clamped to 2.5–50 Mbps)",
    async (width, height, frameRate, bps) => {
      const track = { stop: vi.fn() };
      const stream = fakeStream(track, [{ getSettings: () => ({ width, height, frameRate }) }]);
      rig.getDisplayMedia.mockResolvedValueOnce(stream);

      await startBrowserScreencast(TAB);
      expect(StubRecorder.made[0]?.stream).toBe(stream);
      expect(StubRecorder.made[0]?.options?.videoBitsPerSecond).toBe(bps);

      await stopBrowserScreencast(TAB);
      expect(track.stop).toHaveBeenCalledOnce();
      expect(track.stop.mock.invocationCallOrder[0]!).toBeLessThan(
        rig.saveFile.mock.invocationCallOrder[0]!,
      );
    },
  );
});

describe("compositor and desktop trigger", () => {
  test("warm-up gives up on paused animation frames after the settle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 42),
    );
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const starting = startBrowserScreencast("hidden");
    await vi.advanceTimersByTimeAsync(BROWSER_SCREENCAST_PAINT_SETTLE_TIMEOUT_MS);
    await starting;
    expect(cancel).toHaveBeenCalledWith(42);
    await stopBrowserScreencast("hidden");
  });

  test("a background surface is painted first and held active for the whole recording", async () => {
    rig.nativeStart.mockImplementationOnce(async (tab: string) => {
      expect(frames).toBe(2);
      expect(surface()[tab]).toBe(1);
    });
    rig.getDisplayMedia.mockImplementationOnce(async () => {
      expect(frames).toBe(2);
      expect(surface()["bg"]).toBe(1);
      return fakeStream();
    });

    await startBrowserScreencast("bg");
    expect(surface()["bg"]).toBe(1);
    await stopBrowserScreencast("bg");
    expect(surface()["bg"]).toBeUndefined();
  });

  test("without a user gesture, capture is armed through the desktop trigger", async () => {
    await startBrowserScreencast("auto-tab");
    expect(rig.armCapture).toHaveBeenCalledWith("auto-tab");
    expect(rig.getDisplayMedia).toHaveBeenCalledOnce();
    await stopBrowserScreencast("auto-tab");
  });
});

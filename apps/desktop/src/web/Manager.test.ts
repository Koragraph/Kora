import { it as effectIt } from "@effect/vitest";
import { SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER } from "@kora/contracts";
import type { ShellWebScreencastFrame } from "@kora/contracts";
import { MachinePlatform } from "@kora/shared/hostMachine";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  type Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ShellContext from "../app/ShellContext.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import * as WebManager from "./Manager.ts";
import * as WebPartitions from "./WebPartitions.ts";
import { popupOriginTitle } from "./WebNavigationPolicy.ts";

describe("fitPopoutContentSize", () => {
  it("keeps the PiP content area when the aspect ratio flips", () => {
    const landscapeFit = WebManager.fitPopoutContentSize([480, 320], 16 / 9);
    const portraitFit = WebManager.fitPopoutContentSize([480, 320], 9 / 16);
    expect(landscapeFit).toEqual([523, 294]);
    expect(portraitFit).toEqual([294, 523]);
  });

  it("does not shrink toward the minimum while orientation keeps toggling", () => {
    const toPortrait = WebManager.fitPopoutContentSize([523, 294], 9 / 16);
    const backToLandscape = WebManager.fitPopoutContentSize(toPortrait, 16 / 9);

    expect([toPortrait, backToLandscape]).toEqual([
      [294, 523],
      [523, 294],
    ]);
  });
});

describe("screencastFileExtension", () => {
  it.each([
    ["video/mp4;codecs=avc1.640028", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/x-matroska", "matroska"],
  ])("maps the recorder mime type %s to the .%s extension", (mime, extension) => {
    expect(WebManager.screencastFileExtension(mime)).toBe(extension);
  });
});

describe("isWebEditingShortcut", () => {
  /** `key` with the platform's command modifier (Cmd on macOS, Ctrl elsewhere) held, unless `extra` says otherwise. */
  const press = (platform: NodeJS.Platform, key: string, extra: Partial<Electron.Input> = {}) => {
    const mac = platform === "darwin";
    const input = { type: "keyDown", key, alt: false, shift: false, meta: mac, control: !mac };
    return { ...input, ...extra } as Electron.Input;
  };
  const accepts = (platform: NodeJS.Platform, key: string, extra?: Partial<Electron.Input>) =>
    WebManager.isWebEditingShortcut(press(platform, key, extra), platform);

  describe.each(["darwin", "linux", "win32"] as const)("on %s", (platform) => {
    it("lets the native editing chords through", () => {
      const editingKeys = ["a", "c", "v", "x", "z", "V"];
      expect(editingKeys.map((key) => accepts(platform, key))).toEqual(editingKeys.map(() => true));
    });

    it("accepts the platform's redo chord and paste-and-match-style", () => {
      expect(
        platform === "win32" ? accepts(platform, "y") : accepts(platform, "z", { shift: true }),
      ).toBe(true);
      expect(accepts(platform, "v", { shift: true, alt: platform === "darwin" })).toBe(true);
    });

    it("keeps host shortcuts away from the page", () => {
      const hostKeys = ["k", ",", "w", "j", "q", "+", "=", "-", "0", "r", "F12"];
      expect(hostKeys.filter((key) => accepts(platform, key))).toEqual([]);
    });

    it("rejects an editing key carried by the wrong modifiers", () => {
      const mac = platform === "darwin";
      const wrongModifiers: Array<Partial<Electron.Input>> = [
        { alt: true }, // Cmd/Ctrl+Alt+V is not paste
        { control: mac, meta: !mac }, // the other platform's modifier
        { control: true, meta: true }, // both
        { control: false, meta: false }, // neither
        { alt: !mac, shift: true }, // paste-and-match-style with the wrong extra
      ];
      for (const extra of wrongModifiers) {
        expect(accepts(platform, "v", extra)).toBe(false);
      }
      expect(accepts(platform, "a", { shift: true })).toBe(false);
    });
  });

  it("treats Option+Shift+V on macOS as paste-and-match-style even though the key reads as a symbol", () => {
    const symbolKey = press("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(WebManager.isWebEditingShortcut(symbolKey, "darwin")).toBe(true);

    // Any one thing different and it is not that chord.
    const variants: Array<Partial<Electron.Input>> = [
      { shift: false },
      { alt: false },
      { control: true },
      { code: "KeyC" },
    ];
    expect(
      variants.map((patch) =>
        WebManager.isWebEditingShortcut({ ...symbolKey, ...patch }, "darwin"),
      ),
    ).toEqual([false, false, false, false]);
  });
});

describe("webWindowOpenAction", () => {
  type Disposition = Electron.HandlerDetails["disposition"];
  /** A `window.open` from a preview: by default a sign-in popup. */
  const opened = ({
    url = "https://accounts.google.com/o/oauth2/auth",
    disposition = "new-window",
  }: {
    url?: string;
    disposition?: Disposition;
  }) => ({ disposition, url });

  it("gives scripted popups a real window so the opener stays alive", () => {
    // A null `window.open()` reads as a blocked popup to OAuth SDKs, which also
    // need the opener around to hand the credential back.
    const results = [opened({}), opened({ url: "http://localhost:5173/auth" })].map((details) =>
      WebManager.webWindowOpenAction(details),
    );
    expect(results).toEqual(["popup", "popup"]);
  });

  it.each(["foreground-tab", "background-tab"] as const)(
    "navigates the preview tab itself for a %s link",
    (disposition) => {
      expect(WebManager.webWindowOpenAction(opened({ disposition }))).toBe("navigate");
    },
  );

  it.each([
    "not a url",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "about:blank",
    "vscode://vscode-remote/ssh-remote+box/tmp",
  ])("refuses a window for the unhardenable target %s", (url) => {
    // A popup bypasses the `will-attach-webview` hardening, so a window is only
    // allowed when its preferences can be overridden; Chromium clones the
    // guest's preferences for `about:blank` and forbids overriding them.
    expect(WebManager.webWindowOpenAction(opened({ url }))).toBe("navigate");
  });
});

const electronSpies = vi.hoisted(() => ({
  writeClipboard: vi.fn(async () => undefined),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  webviewSend: vi.fn(),
  showItemInFolder: vi.fn(),
  mkdir: vi.fn((_path: string) => undefined),
  getFocusedWebContents: vi.fn(() => null),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>(() => null),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    toPNG: () => Buffer.from("png"),
    isEmpty: () => false,
  })),
  clipboardItemConstructor: vi.fn(),
  browserWindowConstructor: vi.fn(),
}));
const {
  writeClipboard,
  writeFile,
  webviewSend,
  showItemInFolder,
  mkdir,
  getFocusedWebContents,
  fromId,
  createFromPath,
  clipboardItemConstructor,
  browserWindowConstructor,
} = electronSpies;

vi.mock("electron", () => ({
  webContents: {
    getFocusedWebContents: electronSpies.getFocusedWebContents,
    fromId: electronSpies.fromId,
  },
  session: { fromPartition: vi.fn() },
  shell: { showItemInFolder: electronSpies.showItemInFolder },
  nativeImage: { createFromPath: electronSpies.createFromPath },
  clipboard: { write: electronSpies.writeClipboard },
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      electronSpies.clipboardItemConstructor(data);
    }
  },
  BrowserWindow: electronSpies.browserWindowConstructor,
}));

const ARTIFACTS_DIR = "/tmp/kora/dev/browser-artifacts";
const SCREENSHOT_PATH = `${ARTIFACTS_DIR}/browser-screenshot-test.png`;
const OUTSIDE_PATH = "/tmp/kora/dev/settings.json";

// Every preview shares one partition here; opening a real session would be a bug in the test.
const partitionStub = WebPartitions.WebPartitions.of({
  clearCache: () => Effect.void,
  clearCookies: () => Effect.void,
  getSession: () => Effect.die("no Electron session in these tests"),
  isPartition: (name) => name.startsWith("persist:kora-preview-"),
  getPartition: () => Effect.succeed("persist:kora-preview-test"),
});

const shellContextStub = ShellContext.ShellContext.of({
  browserArtifactsDir: ARTIFACTS_DIR,
  dirname: "/tmp/kora/desktop",
  path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
} as ShellContext.ShellContext["Service"]);

/** Symlinks the fake file system resolves (realPath); every other path is its own real path. */
const realPaths = new Map<string, string>();
const recordingFileSystem = FileSystem.layerNoop({
  realPath: (p) => Effect.succeed(realPaths.get(p) ?? p),
  makeDirectory: (dir) => Effect.sync(() => void mkdir(dir)),
  writeFile: (file, bytes) => Effect.sync(() => void writeFile(file, bytes)),
});

const managerLayer = WebManager.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(WebPartitions.WebPartitions, partitionStub),
      Layer.succeed(ShellContext.ShellContext, shellContextStub),
      recordingFileSystem,
      Path.layer,
      Layer.succeed(MachinePlatform, "darwin"),
    ),
  ),
);

const withManager = <A>(
  body: (
    manager: WebManager.WebManager["Service"],
  ) => Effect.Effect<A, WebManager.WebManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* WebManager.WebManager;
    return yield* body(manager);
  }).pipe(Effect.provide(managerLayer), Effect.scoped);

type Manager = WebManager.WebManager["Service"];

const tick = Effect.yieldNow;
const latest = <T>(items: ReadonlyArray<T>): T | undefined => items.at(-1);

const managerTest = <A>(
  name: string,
  run: (manager: Manager) => Effect.Effect<A, WebManager.WebManagerError, Scope.Scope>,
) => effectIt.effect(name, () => withManager(run));
type AnyListener = (...args: never[]) => void;
type LooseListener = (...args: unknown[]) => void;

type CapturedImage = Pick<Electron.NativeImage, "toJPEG" | "getSize">;

type DisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

/** The app window's webContents that previews live in (its session answers screen-recording requests). */
type HostContents = ReturnType<typeof makeHost>;

type ThrottledContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

function makeHost() {
  const slot: { handler?: DisplayMediaHandler } = {};
  const HOST_ID = 7;
  return {
    id: HOST_ID,
    isDestroyed: () => false,
    mainFrame: { frameTreeNodeId: HOST_ID },
    executeJavaScript: vi.fn(async () => true),
    session: {
      setDisplayMediaRequestHandler: vi.fn((h: DisplayMediaHandler) => void (slot.handler = h)),
    },
    displayMediaHandler: () => slot.handler,
  };
}

const idleDebugger = () => ({
  sendCommand: vi.fn(async () => undefined),
  isAttached: () => false,
  attach: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
});

const noHistory = () => ({ canGoForward: () => false, canGoBack: () => false });

/** Base webview double: every method the manager touches, all inert. Callers override what matters. */
const stubGuest = (id: number, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    getTitle: () => "Example",
    getType: () => "webview",
    getURL: () => "https://example.com",
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    getZoomFactor: () => 1,
    send: webviewSend,
    ipc: { on: vi.fn(), off: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
    ...Object.fromEntries(
      ["setZoomFactor", "setAudioMuted", "setIgnoreMenuShortcuts", "setWindowOpenHandler"].map(
        (name) => [name, vi.fn()],
      ),
    ),
    navigationHistory: noHistory(),
    debugger: idleDebugger(),
    ...overrides,
  }) as never;

/** `on` double that files each listener under its event name. */
const listenerRegistry = <L extends (...args: never[]) => unknown>() => {
  const byEvent = new Map<string, L>();
  return {
    byEvent,
    on: vi.fn((event: string, listener: L) => {
      byEvent.set(event, listener);
    }),
  };
};

const FRAME_SIZE = { width: 1280, height: 720 } as const;
const DESKTOP_VIEW = { width: 800, height: 600 };
const PHONE_VIEW = { width: 390, height: 844 };
/** What the display-media handler answers when it has nothing to hand out. */
const NO_STREAM = {};

const jpegImage = (label: string, size: { width: number; height: number } = FRAME_SIZE) => ({
  toJPEG: () => Buffer.from(label),
  getSize: () => size,
});

const capturerOf = (label: string) => vi.fn(async () => jpegImage(label));

/** A 100x80 capture whose PNG and JPEG bytes both say `label`. */
const smallShot = (label: string) => ({
  ...jpegImage(`${label} jpeg`, { width: 100, height: 80 }),
  toPNG: () => Buffer.from(`${label} png`),
});

/** How long a submitted pick waits for its screenshot crop before giving up on it. */
const CROP_DEADLINE = "6 seconds";

const makeThrottledContents = (
  capturePage: () => Promise<CapturedImage>,
  id = 42,
  host: HostContents = makeHost(),
) =>
  stubGuest(id, {
    mainFrame: { routingId: id },
    hostWebContents: host,
    executeJavaScript: vi.fn(async () => ({ ...FRAME_SIZE })),
    setBackgroundThrottling: vi.fn(),
    capturePage,
  }) as unknown as ThrottledContents;

/** Two ready tabs (41, 42) sharing one window, so they contend for the single display-media slot. */
const setupRaceTabs = (manager: Manager) =>
  Effect.gen(function* () {
    const capturePage = capturerOf("unused-recording-frame");
    const host = makeHost();
    const destroyedIds = new Set<number>();
    const guests = new Map(
      [41, 42].map((id) => [
        id,
        Object.assign(makeThrottledContents(capturePage, id, host), {
          isDestroyed: () => destroyedIds.has(id),
        }),
      ]),
    );
    serveGuests(guests);
    for (const [tab, id] of [
      ["pv-race_a", 41],
      ["pv-race_b", 42],
    ] as const) {
      yield* manager.createTab(tab);
      yield* manager.registerWebview(tab, id);
    }
    const handedOut: Array<{ video?: unknown }> = [];
    /** What the app window's next getDisplayMedia() call would be handed. */
    const requestScreen = (frame = host.mainFrame) =>
      host.displayMediaHandler()?.({ frame }, (granted) => void handedOut.push(granted));
    return { host, handedOut, requestScreen, destroy: (id: number) => destroyedIds.add(id) };
  });

const TEST_FAVICON = "data:image/png;base64,cG5n";
const FAVICON_URL = "http://localhost:3200/favicon.png";

/** Just enough of a PNG for a size sniff: the signature, then IHDR's width and height at bytes 16 and 20. */
const makeSourcePng = (width = 1, height = 1): Buffer => {
  const header = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([header, size]);
};

const pngResponse = () =>
  new Response(new Uint8Array(makeSourcePng()), { headers: { "content-type": "image/png" } });

/**
 * A preview page on a dev server, with what favicon capture needs: its session's fetch, an isolated world that
 * rasterizes, and events. `page` is the page's live state; tests flip it to simulate navigation or closing.
 */
const makeFaviconGuest = (
  options: {
    readonly id?: number;
    readonly url?: string;
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly rasterize?: (code: string) => Promise<unknown>;
  } = {},
) => {
  const page = { url: options.url ?? "http://localhost:3200/", closed: false, loading: false };
  const events = listenerRegistry<AnyListener>();
  const spies = {
    fetch: vi.fn(options.fetch ?? (async () => pngResponse())),
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (_world: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
        options.rasterize === undefined ? TEST_FAVICON : options.rasterize(scripts[0]?.code ?? ""),
    ),
    loadURL: vi.fn(async (next: string) => void (page.url = next)),
    reload: vi.fn(),
    off: vi.fn(),
    debuggerOff: vi.fn(),
  };
  const webContents = stubGuest(options.id ?? 42, {
    getTitle: () => "Preview",
    getURL: () => page.url,
    isLoading: () => page.loading,
    isDestroyed: () => page.closed,
    on: events.on,
    off: spies.off,
    reload: spies.reload,
    loadURL: spies.loadURL,
    reloadIgnoringCache: vi.fn(),
    session: { fetch: spies.fetch },
    executeJavaScriptInIsolatedWorld: spies.executeJavaScriptInIsolatedWorld,
    debugger: { ...idleDebugger(), off: spies.debuggerOff },
  });
  return {
    ...spies,
    webContents,
    listeners: events.byEvent,
    setUrl: (url: string) => void (page.url = url),
    setLoading: (loading: boolean) => void (page.loading = loading),
    setDestroyed: (closed: boolean) => void (page.closed = closed),
    /** The page's <link rel=icon> changed (Electron reports the candidate URLs). */
    announceFavicon: (url = FAVICON_URL) =>
      events.byEvent.get("page-favicon-updated")?.({} as never, [url] as never),
  };
};

/** Runs microtasks until `done()` holds, giving up after a bounded number of turns. */
const settle = function* (done: () => boolean) {
  let turns = 30;
  while (!done() && turns-- > 0) yield* Effect.promise(() => Promise.resolve());
};

/** Opens each tab and attaches its webview: `[tabId, webContentsId]` pairs, in order. */
const addTabs = (manager: Manager, ...tabs: ReadonlyArray<readonly [string, number]>) =>
  Effect.forEach(
    tabs,
    ([tab, id]) => manager.createTab(tab).pipe(Effect.andThen(manager.registerWebview(tab, id))),
    {
      discard: true,
    },
  );

/** Electron's `webContents.fromId` answers from `guests`. */
const serveGuests = (guests: ReadonlyMap<number, unknown>) =>
  fromId.mockImplementation(
    (id) => ((id === undefined ? undefined : guests.get(id)) ?? null) as never,
  );

/** Subscribes to tab-state publications and returns the live, growing list. */
const recordStates = (manager: Manager) =>
  Effect.gen(function* () {
    const seen: WebManager.WebTabState[] = [];
    yield* manager.subscribeStateChanges((_tabId, state) =>
      Effect.sync(() => {
        seen.push(state);
      }),
    );
    return seen;
  });

/** Registers a tab with a webview and returns its state recorder (subscribed first). */
const openTab = (manager: Manager, tabId: string, webContentsId = 42) =>
  Effect.gen(function* () {
    const seen = yield* recordStates(manager);
    yield* manager.createTab(tabId);
    yield* manager.registerWebview(tabId, webContentsId);
    return seen;
  });

const failureOf = <A>(exit: Exit.Exit<A, WebManager.WebManagerError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the effect to fail");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

const mainWindowWith = (
  webContents: unknown,
  once: (event: string, listener: () => void) => void = () => {},
) => ({ isDestroyed: () => false, once: vi.fn(once), webContents }) as never;

/** A picture-in-picture BrowserWindow. Once closed, touching its webContents or showing it throws, as in Electron. */
const makePopoutWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const closedError = () => new Error("Picture-in-picture window is closed.");
  const state = { closed: false };
  const onWindow = new Map<string, () => void>();
  const contentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  const contents = {
    send,
    on: vi.fn((name: string, fn: () => void) => void contentsListeners.set(name, fn)),
    off: vi.fn((name: string) => void contentsListeners.delete(name)),
  };
  const popout = {
    loadURL: vi.fn(loadURL),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    setAspectRatio: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    isDestroyed: vi.fn(() => state.closed),
    once: vi.fn((name: string, fn: () => void) => void onWindow.set(name, fn)),
    showInactive: vi.fn(() => {
      if (state.closed) throw closedError();
    }),
    close: vi.fn(() => {
      if (state.closed) return;
      state.closed = true;
      onWindow.get("closed")?.();
    }),
    get webContents() {
      if (state.closed) throw closedError();
      return contents;
    },
  };
  return { popout, send, contentsListeners };
};

const useAsPopoutWindow = (popout: unknown) => {
  browserWindowConstructor.mockImplementation(function () {
    return popout;
  });
};

/** A Cmd+`key` press on macOS (the platform these manager tests run as). */
const keyEvent = (key: string, patch: Record<string, unknown> = {}): never =>
  Object.assign(
    { key, type: "keyDown", alt: false, shift: false, control: false, meta: true },
    patch,
  ) as never;

describe("WebManager", () => {
  beforeEach(() => {
    for (const spy of [
      fromId,
      mkdir,
      writeFile,
      showItemInFolder,
      clipboardItemConstructor,
      writeClipboard,
      createFromPath,
      webviewSend,
    ]) {
      spy.mockClear();
    }
    browserWindowConstructor.mockReset();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
  });

  describe("keyboard handling inside previews", () => {
    managerTest(
      "never lets preview chords reach the host window",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        const sendInputEvent = vi.fn();
        const host = { sendInputEvent };
        Object.assign(preview.webContents, { hostWebContents: host });
        fromId.mockReturnValue(preview.webContents);
        getFocusedWebContents.mockReturnValue(preview.webContents as never);
        yield* manager.setMainWindow(mainWindowWith(host));
        yield* addTabs(manager, ["pv-keys", 42]);

        const ignoreShortcuts = (preview.webContents as Electron.WebContents)
          .setIgnoreMenuShortcuts;
        expect(ignoreShortcuts).toHaveBeenCalledWith(true);
        const beforeInput = preview.listeners.get("before-input-event")!;

        const chords = [false, true].flatMap((control) =>
          ["k", ",", "w", "j", "q", "+"].flatMap((key) =>
            ["keyDown", "keyUp"].map((type) => ({ control, key, type })),
          ),
        );
        for (const { control, key, type } of chords) {
          const press = keyEvent(key, { type, control, meta: !control, shift: key === "j" });
          let blocked = 0;
          beforeInput({ preventDefault: () => void blocked++ } as never, press);
          yield* tick;
          expect(blocked).toBe(0);
          expect(ignoreShortcuts).toHaveBeenLastCalledWith(true);
        }
        expect(sendInputEvent.mock.calls).toEqual([]);

        // No preview refresh shortcut exists: Cmd+R is the page's.
        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, keyEvent("r"));
        yield* tick;
        expect(preventDefault.mock.calls).toEqual([]);
        expect(preview.reload.mock.calls).toEqual([]);
      }),
    );

    managerTest(
      "keeps native editing alive in the tab and in its sign-in popup",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        yield* addTabs(manager, ["pv-editing", 42]);

        const popup = makeFaviconGuest({ id: 43 });
        const setTitle = vi.fn();
        preview.listeners.get("did-create-window")!({
          webContents: popup.webContents,
          isDestroyed: () => false,
          setTitle,
        } as never);
        // No address bar: the window title is the origin it is on (2026-10-15 audit desktop #8), not the page's <title>.
        expect(setTitle).toHaveBeenCalledWith(
          popupOriginTitle((popup.webContents as Electron.WebContents).getURL()),
        );
        const titleEvt = { preventDefault: vi.fn() };
        popup.listeners.get("page-title-updated")!(titleEvt as never, "Sign in - Google" as never);
        expect(titleEvt.preventDefault.mock.calls.length).toBeGreaterThan(0);
        const popupContents = popup.webContents as Electron.WebContents;
        expect(vi.mocked(popupContents.setIgnoreMenuShortcuts).mock.lastCall).toEqual([true]);

        for (const guest of [preview, popup]) {
          const preventDefault = vi.fn();
          const beforeInput = guest.listeners.get("before-input-event")!;
          const target = guest.webContents as Electron.WebContents;
          const fire = (event: unknown) => beforeInput({ preventDefault } as never, event as never);
          const paste = keyEvent("v");
          getFocusedWebContents.mockReturnValue(guest.webContents as never);

          fire(paste);
          expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
          // Letting go of Command must not switch the pending paste back to a host shortcut.
          fire({ ...(paste as object), type: "keyUp", key: "Meta", meta: false });
          expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);

          fire({ ...(paste as object), key: "w" });
          expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);

          // A paste injected into a guest that is not focused cannot edit the active renderer.
          getFocusedWebContents.mockReturnValue(null);
          fire(paste);
          expect(target.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
          expect(preventDefault.mock.calls).toEqual([]);
        }
      }),
    );
  });

  describe("registration and listeners", () => {
    managerTest(
      "refuses to register a webview that is already destroyed",
      Effect.fnUntraced(function* (manager: Manager) {
        const getType = vi.fn(() => "webview" as const);
        fromId.mockReturnValue({ id: 42, isDestroyed: () => true, getType } as never);
        yield* manager.createTab("pv-destroyed_registration");

        const exit = yield* Effect.exit(manager.registerWebview("pv-destroyed_registration", 42));

        expect(failureOf(exit)).toMatchObject({
          _tag: "WebContentsNotFoundError",
          tabId: "pv-destroyed_registration",
          webContentsId: 42,
        });
        expect(getType.mock.calls).toEqual([]);
      }),
    );

    effectIt.effect("logs a throwing state subscriber and still notifies the others", () => {
      const logged: Array<unknown> = [];
      const captureLogger = Logger.make(({ message }) => {
        for (const part of Array.isArray(message) ? message : [message]) {
          if (typeof part === "object" && part !== null && "cause" in part) {
            logged.push(Cause.squash(part.cause as Cause.Cause<never>));
          }
        }
      });
      const where = {
        windowId: 42,
        channel: "preview:state-change",
        operation: "send-window-message",
      } as const;
      const sendFailure = new NativeWindow.NativeWindowOperationError({
        ...where,
        cause: new Error("renderer unavailable"),
        platform: "darwin",
      });
      const received = vi.fn();

      return withManager((manager) =>
        Effect.gen(function* () {
          yield* manager.subscribeStateChanges(() => Effect.die(sendFailure));
          yield* manager.subscribeStateChanges((tabId, state) =>
            Effect.sync(() => {
              received(tabId, state);
            }),
          );

          const created = yield* manager.createTab("pv-listener_failure");

          expect(received.mock.calls).toHaveLength(1);
          expect(received).toHaveBeenCalledWith("pv-listener_failure", created);
          expect(logged).toHaveLength(1);
          expect(logged[0]).toBeInstanceOf(NativeWindow.NativeWindowOperationError);
          expect(logged[0]).toMatchObject(where);
        }),
      ).pipe(Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: false })));
    });

    managerTest(
      "lets an interrupting state subscriber interrupt the caller",
      Effect.fnUntraced(function* (manager: Manager) {
        const exit = yield* manager
          .subscribeStateChanges(() => Effect.interrupt)
          .pipe(
            Effect.andThen(Effect.exit(manager.createTab("pv-interrupted_listener"))),
            Effect.scoped,
          );

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      }),
    );

    managerTest(
      "holds a navigation back until its webview registers",
      Effect.fnUntraced(function* (manager: Manager) {
        const loadURL = vi.fn(async () => undefined);
        fromId.mockReturnValue(
          stubGuest(42, { getURL: () => "about:blank", getTitle: () => "", loadURL }),
        );

        yield* manager.navigate("pv-pending", "localhost:3200");
        yield* manager.registerWebview("pv-pending", 42);
        yield* tick;

        expect(loadURL.mock.calls).toEqual([["http://localhost:3200/"]]);
      }),
    );

    managerTest(
      "detaches a webview that died instead of navigating it",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-destroyed_navigation");
        yield* manager.setColorScheme("pv-destroyed_navigation", "dark");
        preview.setDestroyed(true);

        yield* manager.navigate("pv-destroyed_navigation", "https://example.com/");

        expect(preview.loadURL.mock.calls).toEqual([]);
        expect(preview.reload.mock.calls).toEqual([]);
        expect(preview.off.mock.calls.length).toBeGreaterThan(0);
        expect(preview.debuggerOff.mock.calls.length).toBeGreaterThan(0);
        expect(latest(states)).toMatchObject({
          webContentsId: null,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    );

    managerTest(
      "cleans up through the debugger captured at attach time",
      Effect.fnUntraced(function* (manager: Manager) {
        // Real Electron throws on any `wc.debugger` access after the WebContents is
        // destroyed, so teardown has to use the reference taken when attaching
        // (electron/electron#53376).
        let gone = false;
        const link = { attached: false };
        const detach = vi.fn(() => void (link.attached = false));
        const off = vi.fn();
        const pinned = {
          detach,
          attach: vi.fn(() => void (link.attached = true)),
          isAttached: () => link.attached,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off,
        };
        fromId.mockReturnValue(
          stubGuest(42, {
            isDestroyed: () => gone,
            getURL: () => "http://localhost:3200/",
            getTitle: () => "Preview",
            reload: vi.fn(),
            loadURL: vi.fn(async () => undefined),
            get debugger() {
              if (gone) throw new Error("Object has been destroyed");
              return pinned;
            },
          }),
        );
        yield* addTabs(manager, ["pv-pinned_debugger", 42]);
        yield* manager.setColorScheme("pv-pinned_debugger", "dark");
        expect(link.attached).toBe(true);
        gone = true;

        yield* manager.navigate("pv-pinned_debugger", "https://example.com/");

        expect(off).toHaveBeenCalledWith("message", expect.any(Function));
        expect(detach.mock.calls).toHaveLength(1);
      }),
    );

    managerTest(
      "does not let cleanup of a dead webview detach a replacement with the same id",
      Effect.fnUntraced(function* (manager: Manager) {
        const previous = makeFaviconGuest();
        const replacement = makeFaviconGuest({ url: "https://example.com/" });
        let current = previous.webContents;
        let releaseReplacement: () => void = () => void 0;
        const replacementGate = new Promise<void>((resolve) => {
          releaseReplacement = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* addTabs(manager, ["pv-destroyed_replacement_race", 42]);
        yield* manager.setColorScheme("pv-destroyed_replacement_race", "dark");
        // The renderer re-registers id 42 as soon as Electron has the replacement ready.
        const lateRegistration = yield* Effect.forkChild(
          Effect.andThen(
            Effect.promise(() => replacementGate),
            manager.registerWebview("pv-destroyed_replacement_race", 42),
          ),
          { startImmediately: true },
        );
        previous.setDestroyed(true);
        // The old guest's teardown is the moment Electron hands out the replacement for the same id.
        previous.debuggerOff.mockImplementationOnce(() => {
          releaseReplacement();
          current = replacement.webContents;
        });
        const states = yield* recordStates(manager);

        yield* manager.navigate("pv-destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(lateRegistration);

        expect(registrationExit._tag).toBe("Success");
        expect(previous.off.mock.calls.length).toBeGreaterThan(0);
        expect(replacement.off.mock.calls).toEqual([]);
        expect(latest(states)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    );
  });

  describe("favicons", () => {
    managerTest(
      "publishes the page origin as favicon context while still loading",
      Effect.fnUntraced(function* (manager: Manager) {
        const longPath = "x".repeat(3_000);
        const preview = makeFaviconGuest({ url: `http://localhost:3200/${longPath}` });
        fromId.mockReturnValue(preview.webContents);
        preview.setLoading(true);
        const states = yield* openTab(manager, "pv-favicon_loading");

        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        const published = latest(states)?.favicon;
        expect(published).toMatchObject({
          dataUrl: TEST_FAVICON,
          pageUrl: "http://localhost:3200",
        });
        expect(published?.capturedAt).toEqual(expect.any(Number));
      }),
    );

    managerTest(
      "dedupes an identical in-flight request but lets a different one win",
      Effect.fnUntraced(function* (manager: Manager) {
        let finishFirst!: (response: Response) => void;
        const firstFetch = new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
        const preview = makeFaviconGuest({
          fetch: (url) => (url.endsWith("first.png") ? firstFetch : Promise.resolve(pngResponse())),
        });
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_latest");

        preview.announceFavicon("http://localhost:3200/first.png");
        preview.announceFavicon("http://localhost:3200/first.png");
        yield* settle(() => preview.fetch.mock.calls.length === 1);
        preview.announceFavicon("http://localhost:3200/second.png");
        yield* settle(() => latest(states)?.favicon !== undefined);
        finishFirst(pngResponse());
        yield* settle(() => false);

        expect(preview.fetch.mock.calls).toHaveLength(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    );

    managerTest(
      "retries the same icon after a capture that could not be decoded",
      Effect.fnUntraced(function* (manager: Manager) {
        let attempts = 0;
        const preview = makeFaviconGuest({
          rasterize: async () => (++attempts === 1 ? null : TEST_FAVICON),
        });
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_retry");

        preview.announceFavicon();
        yield* settle(() => attempts === 1);
        yield* settle(() => false);
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        expect(attempts).toBe(2);
        expect(latest(states)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    );

    managerTest(
      "discards a capture that a navigation invalidated",
      Effect.fnUntraced(function* (manager: Manager) {
        let finishFetch!: (response: Response) => void;
        const preview = makeFaviconGuest({
          fetch: () =>
            new Promise<Response>((resolve) => {
              finishFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_navigation");
        preview.announceFavicon();
        yield* settle(() => preview.fetch.mock.calls.length === 1);
        // The user goes somewhere else before the icon download finishes.
        const leaving = { isSameDocument: false, isMainFrame: true };
        preview.setUrl("https://example.com/");
        preview.listeners.get("did-start-navigation")?.(leaving as never);
        finishFetch(pngResponse());
        yield* settle(() => false);

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    );

    managerTest(
      "keeps the icon when the same URL is reloaded without a new favicon event",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_reload");
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        yield* manager.navigate("pv-favicon_reload", "http://localhost:3200/");

        expect(preview.reload.mock.calls).toHaveLength(1);
        expect(latest(states)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    );

    managerTest(
      "drops the icon once a navigation to another origin is confirmed",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_origin");
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        preview.setUrl("https://example.com/");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => latest(states)?.navStatus.kind === "Success");

        expect(latest(states)?.favicon).toBeUndefined();
      }),
    );

    managerTest(
      "holds on to the old icon when a cross-origin navigation fails",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_failed_origin");
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        const failLoad = preview.listeners.get("did-fail-load") as LooseListener;
        failLoad(
          {},
          -105,
          "Name not resolved",
          "https://unreachable.example/",
          /* main frame */ true,
        );
        yield* settle(() => latest(states)?.navStatus.kind === "LoadFailed");
        expect(latest(states)?.favicon?.dataUrl).toBe(TEST_FAVICON);

        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => latest(states)?.navStatus.kind === "Success");
        expect(latest(states)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    );

    managerTest(
      "does not bring an icon back after a confirmed about:blank page",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_blank");
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        for (const [url, settledKind] of [
          ["about:blank", "Idle"],
          ["http://localhost:3200/", "Success"],
        ] as const) {
          preview.setUrl(url);
          preview.listeners.get("did-navigate")?.({} as never);
          yield* settle(() => latest(states)?.navStatus.kind === settledKind);
          expect(latest(states)?.favicon).toBeUndefined();
        }
      }),
    );

    managerTest(
      "clears the icon when another webview takes over the tab",
      Effect.fnUntraced(function* (manager: Manager) {
        const initial = makeFaviconGuest({ id: 42 });
        const replacement = makeFaviconGuest({ id: 43 });
        serveGuests(
          new Map([
            [42, initial.webContents],
            [43, replacement.webContents],
          ]),
        );
        const states = yield* openTab(manager, "pv-favicon_replace");
        initial.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        yield* manager.registerWebview("pv-favicon_replace", 43);

        expect(latest(states)?.webContentsId).toBe(43);
        expect(latest(states)?.favicon).toBeUndefined();
      }),
    );

    managerTest(
      "ignores a capture that finishes after its webview was swapped out",
      Effect.fnUntraced(function* (manager: Manager) {
        let finishFetch!: (response: Response) => void;
        const initial = makeFaviconGuest({
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              finishFetch = resolve;
            }),
        });
        const replacement = makeFaviconGuest({ id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states = yield* openTab(manager, "pv-favicon_late_replace");
        initial.announceFavicon();
        yield* settle(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("pv-favicon_late_replace", 43);
        finishFetch(pngResponse());
        yield* settle(() => false);

        expect(latest(states)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    );

    managerTest(
      "counts a recycled WebContents id as a fresh attachment",
      Effect.fnUntraced(function* (manager: Manager) {
        const initial = makeFaviconGuest({ id: 42 });
        const replacement = makeFaviconGuest({ id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states = yield* openTab(manager, "pv-favicon_reused_id");
        initial.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("pv-favicon_reused_id", 42);

        expect(latest(states)?.favicon).toBeUndefined();
        expect(initial.off.mock.calls.length).toBeGreaterThan(0);
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    );

    managerTest(
      "keeps the icon when the attached webview registers a second time",
      Effect.fnUntraced(function* (manager: Manager) {
        const preview = makeFaviconGuest();
        fromId.mockReturnValue(preview.webContents);
        const states = yield* openTab(manager, "pv-favicon_reregister");
        preview.announceFavicon();
        yield* settle(() => latest(states)?.favicon !== undefined);

        yield* manager.registerWebview("pv-favicon_reregister", 42);

        expect(latest(states)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    );
  });

  describe("zoom", () => {
    // Chromium hands the guest whatever zoom the app window has, so the tab's own
    // zoom is authoritative both ways: pushed onto each guest, never read from one.
    managerTest(
      "trusts the tab's zoom over whatever the guest reports",
      Effect.fnUntraced(function* (manager: Manager) {
        let reportedZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const registry = listenerRegistry<LooseListener>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue(
          stubGuest(42, {
            getURL: () => url,
            getZoomFactor: () => {
              if (!zoomReadable) throw new Error("zoom unavailable");
              return reportedZoom;
            },
            setZoomFactor,
            on: registry.on,
          }),
        );
        const states = yield* openTab(manager, "pv-zoom");

        expect(latest(states)?.zoomFactor).toBe(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1);

        // The app zoomed, so the guest now reports an inherited level; a navigation
        // must not adopt it as the preview's zoom.
        reportedZoom = 0.8;
        url = "https://example.com/after-app-zoom";
        registry.byEvent.get("did-navigate")?.();
        yield* tick;

        expect(latest(states)?.navStatus).toEqual({ kind: "Success", url, title: "Example" });
        expect(latest(states)?.zoomFactor).toBe(1);

        // Only the preview's own controls change it.
        yield* manager.zoomIn("pv-zoom");
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(latest(states)?.zoomFactor).toBe(1.1);

        zoomReadable = false;
        registry.byEvent.get("did-navigate")?.();
        yield* tick;
        expect(latest(states)?.zoomFactor).toBe(1.1);

        const setReplacementZoom = vi.fn();
        fromId.mockReturnValue(
          stubGuest(43, { getURL: () => url, setZoomFactor: setReplacementZoom }),
        );
        yield* manager.registerWebview("pv-zoom", 43);

        expect(setReplacementZoom).toHaveBeenCalledWith(1.1);
        expect(latest(states)?.zoomFactor).toBe(1.1);
      }),
    );

    // Zooming the app UI pushes the window's level onto every guest; the preview
    // has to be restored to the zoom the user chose for it.
    managerTest(
      "restores each tab's own zoom after the app window zooms",
      Effect.fnUntraced(function* (manager: Manager) {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue(stubGuest(42, { setZoomFactor }));

        yield* addTabs(manager, ["pv-reapply", 42]);
        yield* manager.zoomIn("pv-reapply");
        setZoomFactor.mockClear();

        yield* manager.reapplyZoom();

        expect(setZoomFactor.mock.calls).toEqual([[1.1]]);
      }),
    );

    // did-attach and dom-ready both re-register the guest that is already attached;
    // one that just inherited the window's zoom needs its own back, without that
    // round trip republishing tab state.
    managerTest(
      "re-applies the tab zoom on a repeat registration without republishing",
      Effect.fnUntraced(function* (manager: Manager) {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue(stubGuest(42, { setZoomFactor }));
        const states = yield* openTab(manager, "pv-reregister_zoom");
        yield* manager.zoomIn("pv-reregister_zoom");
        setZoomFactor.mockClear();
        const publishedBefore = states.length;

        yield* manager.registerWebview("pv-reregister_zoom", 42);

        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states).toHaveLength(publishedBefore);
        expect(latest(states)?.zoomFactor).toBe(1.1);
      }),
    );
  });

  describe("color scheme", () => {
    managerTest(
      "emulates prefers-color-scheme and carries it to a replacement webview",
      Effect.fnUntraced(function* (manager: Manager) {
        const makeGuest = (id: number) => {
          const sendCommand = vi.fn(async () => undefined);
          return {
            sendCommand,
            wc: stubGuest(id, {
              debugger: { ...idleDebugger(), sendCommand },
            }),
          };
        };
        const emulation = (value: string) => [
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value }] },
        ];
        const first = makeGuest(42);
        fromId.mockReturnValue(first.wc);
        const states = yield* openTab(manager, "pv-scheme");
        yield* tick;

        yield* manager.setColorScheme("pv-scheme", "dark");
        expect(first.sendCommand).toHaveBeenCalledWith(...emulation("dark"));
        expect(latest(states)?.colorScheme).toBe("dark");

        const second = makeGuest(43);
        fromId.mockReturnValue(second.wc);
        yield* manager.registerWebview("pv-scheme", 43);
        yield* tick;
        expect(second.sendCommand).toHaveBeenCalledWith(...emulation("dark"));
        expect(latest(states)?.colorScheme).toBe("dark");

        yield* manager.setColorScheme("pv-scheme", "system");
        expect(second.sendCommand).toHaveBeenCalledWith(...emulation(""));
        expect(latest(states)?.colorScheme).toBe("system");
      }),
    );
  });

  describe("audio", () => {
    const makeAudioGuest = (id: number) => {
      const registry = listenerRegistry<AnyListener>();
      const setAudioMuted = vi.fn();
      let [audible, playsAfterFirstRead, reads] = [false, false, 0];
      return {
        setAudioMuted,
        /** The page starts or stops making sound, and Electron says so. */
        emitAudioState: (playing: boolean) => {
          registry.byEvent.get("audio-state-changed")?.({ audible: (audible = playing) } as never);
        },
        /**
         * Starts playing between the attach-time read and the post-attach
         * reconcile, with no delivered event: the window in which
         * audio-state-changed fires against a guest the tab does not own yet.
         */
        startPlayingAfterFirstRead: () => {
          playsAfterFirstRead = true;
        },
        wc: stubGuest(id, {
          setAudioMuted,
          isCurrentlyAudible: () => {
            reads += 1;
            return playsAfterFirstRead && reads > 1 ? true : audible;
          },
          loadURL: vi.fn(async () => undefined),
          on: registry.on,
          off: vi.fn((event: string) => {
            registry.byEvent.delete(event);
          }),
        }),
      };
    };

    managerTest(
      "applies the mute to the guest and again to a replacement",
      Effect.fnUntraced(function* (manager: Manager) {
        const first = makeAudioGuest(42);
        fromId.mockReturnValue(first.wc);
        const states = yield* openTab(manager, "pv-audio");
        yield* tick;
        expect(latest(states)?.audioMuted).toBe(false);

        yield* manager.setAudioMuted("pv-audio", true);
        expect(first.setAudioMuted).toHaveBeenCalledWith(true);
        expect(latest(states)?.audioMuted).toBe(true);

        const second = makeAudioGuest(43);
        fromId.mockReturnValue(second.wc);
        yield* manager.registerWebview("pv-audio", 43);
        yield* tick;
        expect(second.setAudioMuted).toHaveBeenCalledWith(true);
        expect(latest(states)?.audioMuted).toBe(true);

        yield* manager.setAudioMuted("pv-audio", false);
        expect(second.setAudioMuted).toHaveBeenLastCalledWith(false);
        expect(latest(states)?.audioMuted).toBe(false);
      }),
    );

    managerTest(
      "fails and leaves the state unmuted when the guest rejects the mute",
      Effect.fnUntraced(function* (manager: Manager) {
        const guest = makeAudioGuest(42);
        fromId.mockReturnValue(guest.wc);
        const states = yield* openTab(manager, "pv-audio_fail");
        yield* tick;

        guest.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest refused");
        });
        const exit = yield* Effect.exit(manager.setAudioMuted("pv-audio_fail", true));

        // Reporting success would show the tab muted while it keeps playing.
        expect(exit._tag).toBe("Failure");
        expect(latest(states)?.audioMuted).toBe(false);
      }),
    );

    managerTest(
      "still registers a guest that rejects the mute re-application",
      Effect.fnUntraced(function* (manager: Manager) {
        const first = makeAudioGuest(42);
        fromId.mockReturnValue(first.wc);
        yield* addTabs(manager, ["pv-audio_attach_fail", 42]);
        yield* tick;
        yield* manager.setAudioMuted("pv-audio_attach_fail", true);

        const second = makeAudioGuest(43);
        // Only the post-attach settle fails, not the pre-publish apply.
        second.setAudioMuted.mockImplementationOnce(() => undefined);
        second.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest went away");
        });
        fromId.mockReturnValue(second.wc);

        // Reconciling is best effort: a guest dying mid-attach must not fail
        // the registration it was attaching for.
        const exit = yield* Effect.exit(manager.registerWebview("pv-audio_attach_fail", 43));
        expect(exit._tag).toBe("Success");
      }),
    );

    managerTest(
      "picks up audibility that flipped while the guest was attaching",
      Effect.fnUntraced(function* (manager: Manager) {
        const guest = makeAudioGuest(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states = yield* openTab(manager, "pv-audio_window");
        yield* tick;

        // That transition's audio-state-changed was lost (it fired before the tab
        // owned the guest). Without a post-attach reconcile the icon stays wrong
        // until a later transition, which may never arrive.
        expect(latest(states)?.audible).toBe(true);
      }),
    );

    managerTest(
      "publishes real audibility transitions only",
      Effect.fnUntraced(function* (manager: Manager) {
        const guest = makeAudioGuest(42);
        fromId.mockReturnValue(guest.wc);
        const states = yield* openTab(manager, "pv-audible");
        yield* tick;
        expect(latest(states)?.audible).toBe(false);

        guest.emitAudioState(true);
        yield* tick;
        expect(latest(states)?.audible).toBe(true);

        // Chromium repeats the event per media element; a repeat publishes nothing.
        const afterFirst = states.length;
        guest.emitAudioState(true);
        yield* tick;
        expect(states).toHaveLength(afterFirst);

        guest.emitAudioState(false);
        yield* tick;
        expect(latest(states)?.audible).toBe(false);
        expect(states.length).toBeGreaterThan(afterFirst);
      }),
    );

    managerTest(
      "disregards audio events from a guest that was replaced",
      Effect.fnUntraced(function* (manager: Manager) {
        const first = makeAudioGuest(42);
        fromId.mockReturnValue(first.wc);
        const states = yield* openTab(manager, "pv-audio_stale");
        yield* tick;

        fromId.mockReturnValue(makeAudioGuest(43).wc);
        yield* manager.registerWebview("pv-audio_stale", 43);
        yield* tick;

        const before = states.length;
        first.emitAudioState(true);
        yield* tick;

        expect(states).toHaveLength(before);
        expect(latest(states)?.audible).toBe(false);
      }),
    );

    managerTest(
      "keeps mute and audibility through a navigation",
      Effect.fnUntraced(function* (manager: Manager) {
        const guest = makeAudioGuest(42);
        fromId.mockReturnValue(guest.wc);
        const states = yield* openTab(manager, "pv-audio_nav");
        yield* tick;

        yield* manager.setAudioMuted("pv-audio_nav", true);
        guest.emitAudioState(true);
        yield* tick;
        expect(latest(states)?.audible).toBe(true);

        yield* manager.navigate("pv-audio_nav", "https://example.com/next");
        yield* tick;

        // navigate runs before loadURL swaps the document, so the old page may
        // still be playing. Clearing audibility now would lose the speaker with
        // no transition left to restore it.
        expect(latest(states)).toMatchObject({ audioMuted: true, audible: true });

        // Chromium reports the real stop once the new document takes over.
        guest.emitAudioState(false);
        yield* tick;
        expect(latest(states)?.audible).toBe(false);
      }),
    );
  });

  describe("tab lifecycle", () => {
    managerTest(
      "rejects webview and capture starts that land while a tab is closing",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = capturerOf("close-race-frame");
        const firstContents = makeThrottledContents(capturePage, 42);
        const lateContents = makeThrottledContents(capturePage, 43);
        type Spy = ReturnType<typeof vi.fn>;
        const lateSpies = lateContents as unknown as { on: Spy; off: Spy; ipc: { off: Spy } };
        serveGuests(
          new Map([
            [42, firstContents],
            [43, lateContents],
          ]),
        );
        const { popout } = makePopoutWindow();
        useAsPopoutWindow(popout);

        yield* addTabs(manager, ["pv-close_register_race", 42]);
        yield* manager.openPopout("pv-close_register_race");

        const cleanupPaused = yield* Deferred.make<void>();
        const resumeCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(cleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(resumeCleanup)),
              )
            : Effect.void,
        );

        const spawn = <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.forkChild({ startImmediately: true }));
        const closing = yield* spawn(manager.closeTab("pv-close_register_race"));
        yield* Deferred.await(cleanupPaused);
        const recreating = yield* spawn(manager.createTab("pv-close_register_race"));
        const registering = yield* spawn(manager.registerWebview("pv-close_register_race", 43));
        yield* tick;
        expect(lateSpies.on.mock.calls).toEqual([]);
        yield* manager.closeTab("pv-close_register_race");
        const screencastExit = yield* Effect.exit(
          manager.beginScreencast("pv-close_register_race"),
        );
        yield* Deferred.succeed(resumeCleanup, undefined);
        yield* Fiber.join(closing);
        const recreated = yield* Fiber.join(recreating);
        const registrationExit = yield* Fiber.await(registering);

        for (const exit of [registrationExit, screencastExit] as ReadonlyArray<
          Exit.Exit<unknown, WebManager.WebManagerError>
        >) {
          expect(failureOf(exit)).toMatchObject({
            _tag: "WebTabNotFoundError",
            tabId: "pv-close_register_race",
          });
        }
        expect(lateSpies.on.mock.calls).toEqual([]);
        expect(lateSpies.off.mock.calls).toEqual([]);
        expect(lateSpies.ipc.off.mock.calls).toEqual([]);
        expect(capturePage.mock.calls).toHaveLength(1);
        expect(recreated.webContentsId).toBeNull();
      }),
    );

    managerTest(
      "shows a main-frame load failure until the next load begins",
      Effect.fnUntraced(function* (manager: Manager) {
        const url = "http://localhost:5733/";
        let loading = false;
        const registry = listenerRegistry<LooseListener>();
        fromId.mockReturnValue(
          stubGuest(42, {
            on: registry.on,
            isLoading: () => loading,
            getTitle: () => "localhost:5733",
            getURL: () => url,
          }),
        );
        const statuses: WebManager.WebNavStatus[] = [];
        const onState = (_tab: string, { navStatus }: WebManager.WebTabState) =>
          Effect.sync(() => void statuses.push(navStatus));
        yield* manager.subscribeStateChanges(onState);
        yield* addTabs(manager, ["pv-failed", 42]);
        const emit = (event: string, ...args: unknown[]) => registry.byEvent.get(event)?.(...args);
        const startLoading = function* () {
          loading = true;
          emit("did-start-loading");
          yield* tick;
        };

        // A failing subframe is not the page failing.
        emit(
          "did-fail-load",
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* tick;
        expect(latest(statuses)?.kind).toBe("Success");

        yield* startLoading();
        expect(latest(statuses)?.kind).toBe("Loading");

        loading = false;
        emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", url, true);
        emit("did-stop-loading");
        emit("page-title-updated");
        yield* tick;
        const refused = { code: -102, description: "ERR_CONNECTION_REFUSED" };
        expect(latest(statuses)).toEqual({
          kind: "LoadFailed",
          title: "localhost:5733",
          url,
          ...refused,
        });

        yield* startLoading();
        expect(latest(statuses)?.kind).toBe("Loading");

        loading = false;
        emit("did-stop-loading");
        yield* tick;
        expect(latest(statuses)?.kind).toBe("Success");

        emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* tick;
        expect(latest(statuses)?.kind).toBe("LoadFailed");

        emit("did-navigate");
        yield* tick;
        expect(latest(statuses)?.kind).toBe("Success");
      }),
    );
  });

  describe("screenshots", () => {
    managerTest(
      "saves a PNG screenshot into the browser artifacts folder",
      Effect.fnUntraced(function* (manager: Manager) {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        fromId.mockReturnValue(
          stubGuest(42, {
            getURL: () => "https://example.com:8443/path?query=value",
            capturePage,
          }),
        );

        yield* addTabs(manager, ["pv-1", 42]);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({ colorScheme: "light", primary: "oklch(0.488 0.217 264)" }),
        );

        const artifact = yield* manager.captureScreenshot("pv-1");

        expect(capturePage.mock.calls).toHaveLength(1);
        expect(mkdir).toHaveBeenCalledWith(ARTIFACTS_DIR);
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect([artifact.tabId, artifact.mimeType, artifact.sizeBytes]).toEqual([
          "pv-1",
          "image/png",
          png.byteLength,
        ]);
        // Named after the page's host, kept in the artifacts folder.
        expect(artifact.path.startsWith(`${ARTIFACTS_DIR}/browser-screenshot-example-com-`)).toBe(
          true,
        );
        expect(artifact.path.endsWith(".png")).toBe(true);

        // Chromium raises UnknownVizError while a hidden guest warms up its first
        // compositor frame, so transient failures are retried.
        const runCapture = () =>
          Effect.exit(manager.captureScreenshot("pv-1")).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
        capturePage.mockClear();
        for (const _ of [1, 2]) capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        const recovering = yield* runCapture();
        yield* TestClock.adjust(1_000);
        expect(Exit.isSuccess(yield* Fiber.join(recovering))).toBe(true);
        expect(capturePage.mock.calls).toHaveLength(3);

        // Once the retries run out, a lasting failure is reported.
        capturePage.mockClear();
        const lastingCause = new Error("capture failed");
        capturePage.mockRejectedValue(lastingCause);
        const failing = yield* runCapture();
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.join(failing);
        expect(capturePage.mock.calls).toHaveLength(3);
        expect(failureOf(exit)).toMatchObject({
          _tag: "WebOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "pv-1",
          webContentsId: 42,
          cause: lastingCause,
        });
      }),
    );

    managerTest(
      "abandons screenshot retries when the guest is swapped mid-delay",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = vi.fn(async () => smallShot("fresh"));
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        fromId.mockReturnValue(makeThrottledContents(capturePage, 42));
        yield* addTabs(manager, ["pv-1", 42]);
        const pending = yield* Effect.forkChild(Effect.exit(manager.captureScreenshot("pv-1")), {
          startImmediately: true,
        });
        // Give the rejection time to schedule its retry before the guest changes.
        yield* TestClock.adjust(60);
        expect(capturePage.mock.calls).toHaveLength(1);
        fromId.mockReturnValue(makeThrottledContents(capturePage, 43));
        yield* manager.registerWebview("pv-1", 43);
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.join(pending);

        expect(exit._tag).toBe("Failure");
        expect(capturePage.mock.calls).toHaveLength(1);
        expect(writeFile.mock.calls).toEqual([]);
      }),
    );

    managerTest(
      "throws away a screenshot that lands after its guest was replaced",
      Effect.fnUntraced(function* (manager: Manager) {
        const staleImage = smallShot("stale");
        const slow = Promise.withResolvers<typeof staleImage>();
        const capturePage = vi.fn(() => slow.promise);
        fromId.mockReturnValue(makeThrottledContents(capturePage, 42));
        yield* addTabs(manager, ["pv-1", 42]);
        const pending = yield* Effect.forkChild(Effect.exit(manager.captureScreenshot("pv-1")), {
          startImmediately: true,
        });
        yield* TestClock.adjust(0);
        expect(capturePage.mock.calls).toHaveLength(1);
        fromId.mockReturnValue(makeThrottledContents(capturePage, 43));
        yield* manager.registerWebview("pv-1", 43);
        slow.resolve(staleImage);
        const exit = yield* Fiber.join(pending);

        expect(exit._tag).toBe("Failure");
        expect(capturePage.mock.calls).toHaveLength(1);
        expect(writeFile.mock.calls).toEqual([]);
      }),
    );
  });

  describe("background throttling while capturing", () => {
    managerTest(
      "leaves each recorded guest unthrottled until its own capture ends",
      Effect.fnUntraced(function* (manager: Manager) {
        const windowThrottling = vi.fn();
        const host = makeHost();
        const capturePage = capturerOf("recording-frame");
        const one = makeThrottledContents(capturePage, 41, host);
        const two = makeThrottledContents(capturePage, 42, host);
        const byId = new Map([
          [41, one],
          [42, two],
        ]);
        serveGuests(byId);

        yield* addTabs(manager, ["pv-capture_throttling_1", 41], ["pv-capture_throttling_2", 42]);
        yield* manager.setMainWindow(mainWindowWith({ setBackgroundThrottling: windowThrottling }));

        yield* manager.beginScreencast("pv-capture_throttling_1");
        // The first renderer redeems its grant, which frees the arm slot for the second tab.
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.beginScreencast("pv-capture_throttling_2");
        expect(windowThrottling.mock.calls).toEqual([[false]]);
        expect(one.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(two.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.endScreencast("pv-capture_throttling_1");
        expect(windowThrottling.mock.calls).toEqual([[false]]);
        expect(one.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(two.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.endScreencast("pv-capture_throttling_2");
        expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
        expect(two.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    );

    managerTest(
      "retries throttle restoration and never commits a failed start",
      Effect.fnUntraced(function* (manager: Manager) {
        const windowThrottling = vi.fn<(enabled: boolean) => void>();
        fromId.mockReturnValue(makeThrottledContents(capturerOf("recording-frame")));
        const tab = "pv-capture_throttling_failure";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.setMainWindow(mainWindowWith({ setBackgroundThrottling: windowThrottling }));

        windowThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        expect(Exit.isFailure(yield* Effect.exit(manager.beginScreencast(tab)))).toBe(true);

        yield* manager.beginScreencast(tab);
        expect(windowThrottling.mock.calls).toEqual([[false], [false]]);

        windowThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.endScreencast(tab);
        expect(windowThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.beginScreencast(tab);
        yield* manager.endScreencast(tab);
        expect(windowThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    );

    managerTest(
      "hands window throttling back when a recorded guest will not unthrottle",
      Effect.fnUntraced(function* (manager: Manager) {
        const windowThrottling = vi.fn();
        const guest = makeThrottledContents(capturerOf("recording-frame"));
        fromId.mockReturnValue(guest);
        const tab = "pv-guest_throttling_failure";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.setMainWindow(mainWindowWith({ setBackgroundThrottling: windowThrottling }));

        guest.setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("guest throttling update failed");
        });
        expect(Exit.isFailure(yield* Effect.exit(manager.beginScreencast(tab)))).toBe(true);
        expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.beginScreencast(tab);
        yield* manager.endScreencast(tab);
        expect(windowThrottling.mock.calls).toEqual([[false], [true], [false], [true]]);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true]]);
      }),
    );

    managerTest(
      "refuses a replacement window whose capture reconciliation throws",
      Effect.fnUntraced(function* (manager: Manager) {
        const brokenThrottling = vi.fn(() => {
          throw new Error("replacement throttling update failed");
        });
        fromId.mockReturnValue(makeThrottledContents(capturerOf("recording-frame")));
        const tab = "pv-capture_replacement_failure";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.beginScreencast(tab);

        const swap = yield* Effect.exit(
          manager.setMainWindow(mainWindowWith({ setBackgroundThrottling: brokenThrottling })),
        );
        expect(swap._tag).toBe("Failure");

        yield* manager.endScreencast(tab);
        expect(brokenThrottling.mock.calls).toEqual([[false]]);
      }),
    );
  });

  describe("main window ownership", () => {
    managerTest(
      "ignores the close event of a main window that was replaced",
      Effect.fnUntraced(function* (manager: Manager) {
        let closeOriginal: (() => void) | undefined;
        const originalThrottling = vi.fn();
        const currentThrottling = vi.fn();
        fromId.mockReturnValue(makeThrottledContents(capturerOf("recording-frame")));
        const tab = "pv-replaced_window_close";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.setMainWindow(
          mainWindowWith({ setBackgroundThrottling: originalThrottling }, (event, listener) => {
            if (event === "closed") closeOriginal = listener;
          }),
        );
        yield* manager.setMainWindow(
          mainWindowWith({ setBackgroundThrottling: currentThrottling }),
        );

        closeOriginal?.();
        yield* manager.beginScreencast(tab);
        expect(originalThrottling.mock.calls).toEqual([]);
        expect(currentThrottling.mock.calls).toEqual([[false]]);
        yield* manager.endScreencast(tab);
        expect(currentThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    );

    managerTest(
      "stops frame capture once the main window closes",
      Effect.fnUntraced(function* (manager: Manager) {
        let closeWindow: (() => void) | undefined;
        const closedWindowThrottling = vi.fn();
        const nextWindowThrottling = vi.fn();
        const host = makeHost();
        const capturePage = capturerOf("recording-frame");
        const byId = new Map([
          [42, makeThrottledContents(capturePage, 42, host)],
          [43, makeThrottledContents(capturePage, 43, host)],
        ]);
        serveGuests(byId);

        yield* addTabs(manager, ["pv-window_close_recording", 42], ["pv-window_close_race", 43]);
        yield* manager.setMainWindow(
          mainWindowWith({ setBackgroundThrottling: closedWindowThrottling }, (event, listener) => {
            if (event === "closed") closeWindow = listener;
          }),
        );
        yield* manager.beginScreencast("pv-window_close_recording");
        expect(closedWindowThrottling.mock.calls).toEqual([[false]]);

        closeWindow?.();
        const lateStart = yield* Effect.exit(manager.beginScreencast("pv-window_close_race"));
        expect(failureOf(lateStart)).toMatchObject({
          _tag: "WebMainWindowClosedError",
          tabId: "pv-window_close_race",
        });
        yield* tick;
        yield* tick;

        // The app window asks for the screen: it gets nothing, since no recording is armed any more.
        const answers: unknown[] = [];
        host.displayMediaHandler()?.(
          { frame: host.mainFrame },
          (answer) => void answers.push(answer),
        );
        expect(answers).toEqual([NO_STREAM]);

        yield* manager.setMainWindow(
          mainWindowWith({ setBackgroundThrottling: nextWindowThrottling }),
        );
        expect(nextWindowThrottling.mock.calls).toEqual([]);
      }),
    );

    managerTest(
      "does not arm a recording whose window closed during warmup",
      Effect.fnUntraced(function* (manager: Manager) {
        let closeWindow: (() => void) | undefined;
        let completeWarmup!: (image: CapturedImage) => void;
        let signalWarmup!: () => void;
        const warmupBegan = new Promise<void>((resolve) => {
          signalWarmup = resolve;
        });
        const capturePage = vi.fn(
          () =>
            new Promise<CapturedImage>((resolve) => {
              signalWarmup();
              completeWarmup = resolve;
            }),
        );
        const host = makeHost();
        fromId.mockReturnValue(makeThrottledContents(capturePage, 42, host));
        const tab = "pv-window_close_warmup";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.setMainWindow(
          mainWindowWith({ setBackgroundThrottling: vi.fn() }, (event, listener) => {
            if (event === "closed") closeWindow = listener;
          }),
        );

        const starting = yield* manager
          .beginScreencast(tab)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupBegan);
        closeWindow?.();
        completeWarmup(jpegImage("recording-frame"));

        const exit = yield* Fiber.await(starting);
        expect(failureOf(exit)).toMatchObject({ _tag: "WebMainWindowClosedError", tabId: tab });
        expect(host.session.setDisplayMediaRequestHandler.mock.calls).toEqual([]);
      }),
    );
  });

  describe("recording handedOut", () => {
    managerTest(
      "hands each concurrent recording the frame of its own tab",
      Effect.fnUntraced(function* (manager: Manager) {
        const host = makeHost();
        const sendCommands = {
          41: vi.fn(async () => undefined),
          42: vi.fn(async () => undefined),
        };
        const capturers = {
          41: vi.fn(async () => jpegImage("first-recording-frame", { width: 800, height: 600 })),
          42: vi.fn(async () => jpegImage("second-recording-frame", { width: 390, height: 844 })),
        };
        // Both webviews sit in one window, so they share a single display-media handler.
        const makeGuest = (id: 41 | 42) =>
          stubGuest(id, {
            hostWebContents: host,
            mainFrame: { routingId: id },
            // 41 is a desktop-sized page, 42 a phone-sized one.
            executeJavaScript: vi.fn(async () => (id === 41 ? DESKTOP_VIEW : PHONE_VIEW)),
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            setBackgroundThrottling: vi.fn(),
            debugger: { ...idleDebugger(), sendCommand: sendCommands[id] },
            capturePage: capturers[id],
          });
        const byId = new Map([
          [41, makeGuest(41)],
          [42, makeGuest(42)],
        ]);
        serveGuests(byId);
        yield* addTabs(manager, ["pv-1", 41], ["pv-2", 42]);

        const handedOut: Array<{ video?: unknown }> = [];
        const redeem = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            handedOut.push(value);
          });

        yield* manager.beginScreencast("pv-1");
        redeem();
        yield* manager.beginScreencast("pv-2");
        redeem();
        expect(handedOut).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(capturers[41]).toHaveBeenCalledOnce();
        expect(capturers[42]).toHaveBeenCalledOnce();
        for (const sendCommand of Object.values(sendCommands)) {
          expect(sendCommand).not.toHaveBeenCalledWith("Page.startScreencast", expect.anything());
        }

        yield* Effect.all([manager.endScreencast("pv-1"), manager.endScreencast("pv-2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    );

    managerTest(
      "asks the host renderer for display media with a fresh gesture",
      Effect.fnUntraced(function* (manager: Manager) {
        const { host, requestScreen } = yield* setupRaceTabs(manager);

        yield* manager.beginScreencast("pv-race_a");

        for (const needle of [SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER, "pv-race_a"]) {
          expect(host.executeJavaScript).toHaveBeenCalledWith(
            expect.stringContaining(needle),
            true,
          );
        }
        requestScreen();
        yield* manager.endScreencast("pv-race_a");
      }),
    );

    // Real clock on purpose: an earlier queueing design only settled under TestClock and
    // left the losing start hanging forever in the desktop app.
    effectIt.live("resolves both starts when two tabs compete for the capture stream", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const { host, handedOut, requestScreen } = yield* setupRaceTabs(manager);

          // Both tabs press record at once.
          const start = (tab: string) => Effect.exit(manager.beginScreencast(tab));
          const [exitA, exitB] = yield* Effect.all([start("pv-race_a"), start("pv-race_b")], {
            concurrency: "unbounded",
          });
          // One start owns the stream; the other fails at once rather than hang.
          expect([exitA, exitB].filter(Exit.isSuccess).length).toBe(1);
          const loser = Exit.isSuccess(exitA) ? exitB : exitA;
          if (Exit.isSuccess(loser)) return;
          expect(failureOf(loser)).toMatchObject({ _tag: "WebScreencastArmConflictError" });

          // The lone grant belongs to the tab that really won the slot.
          requestScreen();
          expect(handedOut).toEqual([{ video: { routingId: Exit.isSuccess(exitA) ? 41 : 42 } }]);
          expect(host.session.setDisplayMediaRequestHandler.mock.calls).toHaveLength(1);
        }),
      ),
    );

    managerTest(
      "frees an armed slot that no renderer ever redeemed",
      Effect.fnUntraced(function* (manager: Manager) {
        const { handedOut, requestScreen } = yield* setupRaceTabs(manager);

        yield* manager.beginScreencast("pv-race_a");
        const refused = yield* Effect.exit(manager.beginScreencast("pv-race_b"));
        expect(failureOf(refused)).toMatchObject({
          _tag: "WebScreencastArmConflictError",
          tabId: "pv-race_b",
          armedTabId: "pv-race_a",
        });

        // Nothing captured the armed tab, so its slot goes stale and stops blocking others.
        yield* TestClock.adjust(10_000);
        yield* manager.beginScreencast("pv-race_b");
        requestScreen();
        expect(handedOut).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.endScreencast("pv-race_a");
        yield* manager.endScreencast("pv-race_b");
      }),
    );

    managerTest(
      "denies a display-media request that shows up after the arm expired",
      Effect.fnUntraced(function* (manager: Manager) {
        const { handedOut, requestScreen } = yield* setupRaceTabs(manager);

        yield* manager.beginScreencast("pv-race_a");
        // Ten seconds on, the arm has lapsed: the handler keeps no clock, so the expiry fiber must have cleared it.
        yield* TestClock.adjust("10 seconds");
        requestScreen();
        expect(handedOut).toEqual([NO_STREAM]);

        yield* manager.endScreencast("pv-race_a");
      }),
    );

    managerTest(
      "handedOut the stream only to the host frame that armed it",
      Effect.fnUntraced(function* (manager: Manager) {
        const { handedOut, requestScreen } = yield* setupRaceTabs(manager);

        yield* manager.beginScreencast("pv-race_a");
        const someOtherFrame = { frameTreeNodeId: 999 };
        requestScreen(someOtherFrame);
        requestScreen();
        expect(handedOut).toEqual([NO_STREAM, { video: { routingId: 41 } }]);
        yield* manager.endScreencast("pv-race_a");
      }),
    );

    managerTest(
      "takes the arm slot back from a destroyed webContents",
      Effect.fnUntraced(function* (manager: Manager) {
        const { handedOut, requestScreen, destroy } = yield* setupRaceTabs(manager);

        yield* manager.beginScreencast("pv-race_a");
        destroy(41);
        yield* manager.beginScreencast("pv-race_b");
        requestScreen();
        expect(handedOut).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.endScreencast("pv-race_b");
      }),
    );

    managerTest(
      "records natively even if the source warmup fails",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeHost();
        fromId.mockReturnValue(makeThrottledContents(capturePage, 42, host));
        const tab = "pv-recording_warmup_failure";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);

        yield* manager.beginScreencast(tab);
        expect(capturePage.mock.calls).toHaveLength(2);

        // The armed tab gets exactly one display-media answer; later requests are denied.
        const answers: Array<{ video?: unknown }> = [];
        for (let request = 0; request < 2; request++) {
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => answers.push(value));
        }
        expect(answers).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.endScreencast(tab);
      }),
    );

    managerTest(
      "orders source acquisition for a recording before a webview swap",
      Effect.fnUntraced(function* (manager: Manager) {
        const warmedImage = jpegImage("unused-recording-frame");
        let signalWarmup!: () => void;
        const warmupBegan = new Promise<void>((resolve) => {
          signalWarmup = resolve;
        });
        let completeWarmup!: (image: CapturedImage) => void;
        const capturePage = vi
          .fn<() => Promise<CapturedImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<CapturedImage>((resolve) => {
                signalWarmup();
                completeWarmup = resolve;
              }),
          )
          .mockResolvedValue(warmedImage);
        const original = makeThrottledContents(capturePage, 42);
        const swappedOn = vi.fn();
        const swapped = Object.assign(makeThrottledContents(capturePage, 43), { on: swappedOn });
        fromId.mockImplementation((id) => {
          if (id === 42) return original;
          if (id === 43) return swapped;
          return null;
        });
        const tab = "pv-recording_replacement_race";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        const starting = yield* manager
          .beginScreencast(tab)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupBegan);
        const swapping = yield* manager
          .registerWebview(tab, 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* tick;
        expect(swappedOn.mock.calls).toEqual([]);

        completeWarmup(warmedImage);
        yield* Fiber.join(starting);
        yield* Fiber.join(swapping);
        expect(swappedOn.mock.calls.length).toBeGreaterThan(0);
        expect(original.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(swapped.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.endScreencast(tab);
        expect(original.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(swapped.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    );
  });

  describe("picture-in-picture", () => {
    managerTest(
      "shares background frame capture between recording and the PiP window",
      Effect.fnUntraced(function* (manager: Manager) {
        const windowThrottling = vi.fn();
        const mainContents = Object.assign(makeHost(), {
          setBackgroundThrottling: windowThrottling,
        });
        const frame = jpegImage("one frame for both consumers");
        const jpeg = frame.toJPEG();
        const capturePage = vi.fn(async () => frame);
        fromId.mockReturnValue(
          stubGuest(42, {
            mainFrame: { routingId: 42 },
            hostWebContents: mainContents,
            executeJavaScript: vi.fn(async () => ({ ...FRAME_SIZE })),
            setBackgroundThrottling: vi.fn(),
            capturePage,
          }),
        );

        const { popout, send: popoutSend } = makePopoutWindow();
        useAsPopoutWindow(popout);
        const screencastFrames: ShellWebScreencastFrame[] = [];

        yield* manager.setMainWindow(mainWindowWith(mainContents));
        const states = yield* recordStates(manager);
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            screencastFrames.push(frame);
          }),
        );
        yield* addTabs(manager, ["pv-pip", 42]);
        yield* manager.openPopout("pv-pip");

        expect(windowThrottling.mock.calls).toEqual([[false]]);
        // A floating, hidden-until-ready window outside the taskbar that keeps rendering in the background.
        const [pipOptions] = browserWindowConstructor.mock.lastCall as [
          Electron.BrowserWindowConstructorOptions,
        ];
        expect([pipOptions.show, pipOptions.alwaysOnTop, pipOptions.skipTaskbar]).toEqual([
          false,
          true,
          true,
        ]);
        expect(pipOptions.webPreferences).toMatchObject({
          backgroundThrottling: false,
          preload: "/tmp/kora/desktop/web-pip-preload.cjs",
        });
        expect(popout.showInactive.mock.calls).toHaveLength(1);
        expect(popout.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        expect(popout.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(popout.setContentSize).toHaveBeenCalledWith(523, 294, false);
        const [resetOrder, applyOrder] = popout.setAspectRatio.mock.invocationCallOrder;
        const [resizeOrder] = popout.setContentSize.mock.invocationCallOrder;
        expect(resetOrder).toBeLessThan(resizeOrder ?? 0);
        expect(resizeOrder).toBeLessThan(applyOrder ?? 0);
        expect(popoutSend).toHaveBeenCalledWith(
          "shell:web-popout-frame",
          expect.objectContaining({
            ...FRAME_SIZE,
            tabId: "pv-pip",
            data: jpeg.toString("base64"),
          }),
        );
        expect(latest(states)?.pictureInPicture).toBe(true);
        expect(capturePage.mock.calls).toHaveLength(1);
        const popoutFramesBefore = popoutSend.mock.calls.length;

        yield* manager.beginScreencast("pv-pip");
        expect(capturePage.mock.calls).toHaveLength(2);
        expect(screencastFrames).toHaveLength(0);

        yield* TestClock.adjust(100);
        expect(capturePage.mock.calls).toHaveLength(3);
        expect(popoutSend.mock.calls).toHaveLength(popoutFramesBefore);
        expect(screencastFrames).toHaveLength(0);

        yield* manager.endScreencast("pv-pip");
        expect(windowThrottling.mock.calls).toEqual([[false]]);
        const popoutOnlyBaseline = popoutSend.mock.calls.length;
        yield* TestClock.adjust(100);
        expect(capturePage.mock.calls).toHaveLength(4);
        expect(popoutSend.mock.calls.length).toBe(popoutOnlyBaseline);
        expect(screencastFrames).toHaveLength(0);

        windowThrottling.mockImplementationOnce(() => {
          throw new Error("picture-in-picture throttling restore failed");
        });
        yield* manager.closePopout("pv-pip");
        expect(windowThrottling.mock.calls).toEqual([[false], [true], [true]]);
        expect(popout.close.mock.calls).toHaveLength(1);
        expect(latest(states)?.pictureInPicture).toBe(false);
        const capturesAtClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage.mock.calls).toHaveLength(capturesAtClose);
      }),
    );

    managerTest(
      "keeps PiP frame capture independent of the recording warmup",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = capturerOf("shared-preview-frame");
        fromId.mockReturnValue(makeThrottledContents(capturePage));
        const { popout, send } = makePopoutWindow();
        useAsPopoutWindow(popout);
        const screencastFrames: ShellWebScreencastFrame[] = [];
        const tab = "pv-recording_then_pip";

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            screencastFrames.push(frame);
          }),
        );
        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.beginScreencast(tab);

        expect(screencastFrames).toHaveLength(0);
        expect(capturePage.mock.calls).toHaveLength(1);
        yield* manager.openPopout(tab);
        expect(capturePage.mock.calls).toHaveLength(2);
        expect(send.mock.calls).toHaveLength(1);

        yield* TestClock.adjust(100);

        expect(capturePage.mock.calls).toHaveLength(3);
        expect(screencastFrames).toHaveLength(0);
        expect(send.mock.calls).toHaveLength(1);
        yield* manager.closePopout(tab);
        yield* manager.endScreencast(tab);
      }),
    );

    managerTest(
      "stops capturing when the user closes the PiP window natively",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = capturerOf("native-close-preview-frame");
        fromId.mockReturnValue(makeThrottledContents(capturePage));
        const { popout } = makePopoutWindow();
        useAsPopoutWindow(popout);
        const states = yield* openTab(manager, "pv-native_pip_close");
        yield* manager.openPopout("pv-native_pip_close");

        popout.close();
        yield* settle(() => latest(states)?.pictureInPicture === false);

        expect(latest(states)?.pictureInPicture).toBe(false);
        const capturesAtClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage.mock.calls).toHaveLength(capturesAtClose);
      }),
    );

    managerTest(
      "resends an unchanged PiP frame whose first delivery failed",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = capturerOf("retry-preview-frame");
        fromId.mockReturnValue(makeThrottledContents(capturePage));
        const { popout, send } = makePopoutWindow();
        send.mockImplementationOnce(() => {
          throw new Error("picture-in-picture delivery failed");
        });
        useAsPopoutWindow(popout);
        const tab = "pv-pip_delivery_retry";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.openPopout(tab);
        expect(send.mock.calls).toHaveLength(1);

        yield* TestClock.adjust(100);

        expect(capturePage.mock.calls).toHaveLength(2);
        expect(send.mock.calls).toHaveLength(2);
        yield* manager.closePopout(tab);
      }),
    );

    managerTest(
      "replays an unchanged PiP frame after the popout renderer reloads",
      Effect.fnUntraced(function* (manager: Manager) {
        fromId.mockReturnValue(makeThrottledContents(capturerOf("reloaded-preview-frame")));
        const { popout, send, contentsListeners } = makePopoutWindow();
        useAsPopoutWindow(popout);
        const tab = "pv-pip_reload";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.openPopout(tab);
        expect(send.mock.calls).toHaveLength(1);

        contentsListeners.get("did-finish-load")?.();
        yield* TestClock.adjust(100);

        expect(send.mock.calls).toHaveLength(2);
        yield* manager.closePopout(tab);
      }),
    );

    managerTest(
      "skips empty frames and sizes the PiP window from the first real one",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = vi.fn(async () => jpegImage("valid-preview-frame"));
        capturePage.mockResolvedValueOnce(
          jpegImage("empty-preview-frame", { width: 0, height: 0 }),
        );
        fromId.mockReturnValue(makeThrottledContents(capturePage));
        const { popout, send } = makePopoutWindow();
        useAsPopoutWindow(popout);
        const tab = "pv-empty_frame";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        yield* manager.openPopout(tab);

        expect(capturePage.mock.calls).toHaveLength(1);
        expect(popout.setAspectRatio.mock.calls).toEqual([]);
        expect(send.mock.calls).toEqual([]);

        yield* TestClock.adjust(100);

        expect(popout.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(send.mock.calls).toHaveLength(1);
        yield* manager.closePopout(tab);
      }),
    );

    managerTest(
      "never announces PiP as ready once its window is torn down",
      Effect.fnUntraced(function* (manager: Manager) {
        fromId.mockReturnValue(makeThrottledContents(capturerOf("closing-preview-frame")));
        const { popout } = makePopoutWindow();
        popout.showInactive.mockImplementationOnce(() => {
          popout.close();
        });
        useAsPopoutWindow(popout);
        const states = yield* openTab(manager, "pv-pip_teardown");

        const openExit = yield* Effect.exit(manager.openPopout("pv-pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(popout.close.mock.calls).toHaveLength(1);
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(latest(states)?.pictureInPicture).toBe(false);
      }),
    );

    managerTest(
      "closes a still-initializing PiP and lets a later open succeed",
      Effect.fnUntraced(function* (manager: Manager) {
        const capturePage = capturerOf("serialized-preview-frame");
        fromId.mockReturnValue(makeThrottledContents(capturePage));
        const { popout: stuck } = makePopoutWindow(
          () =>
            new Promise<void>(() => {
              // The renderer load never settles.
            }),
        );
        const { popout: reopened } = makePopoutWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return stuck;
          })
          .mockImplementationOnce(function () {
            return reopened;
          });
        const tab = "pv-concurrent_pip";
        const states = yield* openTab(manager, tab);

        const firstOpen = yield* Effect.forkChild(manager.openPopout(tab));
        yield* tick;
        const secondOpen = yield* Effect.forkChild(manager.openPopout(tab));
        yield* tick;
        const closing = yield* Effect.forkChild(manager.closePopout(tab));
        yield* tick;

        expect(browserWindowConstructor.mock.calls).toHaveLength(1);
        expect(stuck.loadURL.mock.calls).toHaveLength(1);
        expect(stuck.close.mock.calls).toHaveLength(1);
        const openExits = yield* Effect.all([Fiber.await(firstOpen), Fiber.await(secondOpen)]);
        yield* Fiber.join(closing);

        expect(openExits.map((exit) => Exit.hasInterrupts(exit))).toEqual([true, true]);
        expect(stuck.showInactive.mock.calls).toEqual([]);
        expect(capturePage.mock.calls).toEqual([]);
        expect(latest(states)?.pictureInPicture).toBe(false);

        yield* manager.openPopout(tab);

        expect(browserWindowConstructor.mock.calls).toHaveLength(2);
        expect(reopened.showInactive.mock.calls).toHaveLength(1);
        expect(capturePage.mock.calls).toHaveLength(1);
        expect(latest(states)?.pictureInPicture).toBe(true);

        yield* manager.closePopout(tab);

        expect(browserWindowConstructor.mock.calls).toHaveLength(2);
        expect(reopened.close.mock.calls).toHaveLength(1);
        expect(latest(states)?.pictureInPicture).toBe(false);
        const capturesAtClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage.mock.calls).toHaveLength(capturesAtClose);
      }),
    );

    managerTest(
      "rejects a PiP whose webview changed while it initialized",
      Effect.fnUntraced(function* (manager: Manager) {
        const staleCapture = capturerOf("stale-preview-frame");
        const freshCapture = capturerOf("replacement-preview-frame");
        const staleContents = makeThrottledContents(staleCapture, 42);
        const freshContents = makeThrottledContents(freshCapture, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return staleContents;
          if (webContentsId === 43) return freshContents;
          return null;
        });
        let finishLoad: (() => void) | undefined;
        const { popout } = makePopoutWindow(
          () =>
            new Promise<void>((resolve) => {
              finishLoad = resolve;
            }),
        );
        useAsPopoutWindow(popout);
        const tab = "pv-replaced_webview";

        yield* manager.createTab(tab);
        yield* manager.registerWebview(tab, 42);
        const firstOpen = yield* manager
          .openPopout(tab)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* tick;
        expect(popout.loadURL.mock.calls).toHaveLength(1);
        expect(finishLoad).toBeDefined();
        const overlappingOpen = yield* manager
          .openPopout(tab)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* tick;

        yield* manager.registerWebview(tab, 43);
        finishLoad?.();

        const openExits = yield* Effect.all([Fiber.await(firstOpen), Fiber.await(overlappingOpen)]);
        for (const exit of openExits) {
          expect(failureOf(exit)).toMatchObject({
            _tag: "WebOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: tab,
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor.mock.calls).toHaveLength(1);
        expect(popout.close.mock.calls).toHaveLength(1);
        expect(popout.showInactive.mock.calls).toEqual([]);
        expect(staleCapture.mock.calls).toEqual([]);
        expect(freshCapture.mock.calls).toEqual([]);
      }),
    );
  });

  describe("element picking", () => {
    const sampleAnnotation = {
      createdAt: "2026-06-11T00:00:00.000Z",
      screenshot: null,
      comment: "Add more breathing room here",
      pageTitle: "Example",
      pageUrl: "https://example.com",
      id: "annotation_1",
      regions: [{ rect: { x: 5, y: 6, width: 20, height: 30 }, id: "region_1" }],
      elements: [],
      strokes: [],
      styleChanges: [],
    };

    type PickedListener = (event: unknown, ...args: unknown[]) => void;

    /** A focused guest whose crop capture never completes, exposing the element-picked channel. */
    const makeWedgedPickGuest = () => {
      let picked: PickedListener | undefined;
      const wc = stubGuest(42, {
        isFocused: () => true,
        once: vi.fn(),
        capturePage: vi.fn(() => new Promise(() => {})),
        ipc: {
          on: vi.fn((channel: string, listener: PickedListener) => {
            if (channel === "preview:element-picked") picked = listener;
          }),
          off: vi.fn(),
          removeListener: vi.fn(),
        },
      });
      return { wc, submit: (...args: unknown[]) => picked?.({}, ...args) };
    };

    managerTest(
      "stays in pick mode across a subframe navigation",
      Effect.fnUntraced(function* (manager: Manager) {
        const registry = listenerRegistry<LooseListener>();
        fromId.mockReturnValue(
          stubGuest(42, {
            isFocused: () => true,
            on: registry.on,
            once: registry.on,
            ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          }),
        );

        yield* addTabs(manager, ["pv-1", 42]);
        const pick = yield* manager.pickElement("pv-1").pipe(Effect.forkChild);
        yield* tick;

        registry.byEvent.get("did-start-navigation")?.({}, "about:blank", false, false);
        yield* tick;
        expect(pick.pollUnsafe()).toBeUndefined();

        registry.byEvent.get("did-start-navigation")?.({}, "https://example.com/next", false, true);
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    );

    managerTest(
      "finishes the pick without a crop when the annotation screenshot hangs",
      Effect.fnUntraced(function* (manager: Manager) {
        const { wc, submit } = makeWedgedPickGuest();
        fromId.mockReturnValue(wc);

        yield* addTabs(manager, ["pv-1", 42]);
        const pick = yield* manager.pickElement("pv-1").pipe(Effect.forkChild);
        yield* tick;

        submit(sampleAnnotation, null, "send");
        yield* tick;
        expect(pick.pollUnsafe()).toBeUndefined();

        // Past the crop deadline the pick gives up on the screenshot rather than leave the composer on
        // "Capturing…" for good.
        yield* TestClock.adjust(CROP_DEADLINE);
        const result = yield* Fiber.join(pick);
        expect(
          result && [result.annotation.screenshot, result.screenshotFailed, result.submission],
        ).toEqual([null, true, "send"]);
        expect(webviewSend.mock.calls).toContainEqual(["preview:annotation-captured"]);
      }),
    );

    managerTest(
      "lets a superseded pick's late crop timeout leave the live pick alone",
      Effect.fnUntraced(function* (manager: Manager) {
        const { wc, submit } = makeWedgedPickGuest();
        fromId.mockReturnValue(wc);

        yield* addTabs(manager, ["pv-1", 42]);
        const firstPick = yield* manager.pickElement("pv-1").pipe(Effect.forkChild);
        yield* tick;
        // The first pick submits and its crop hangs.
        submit(sampleAnnotation, null, "send");
        yield* tick;

        // A second pick on the tab supersedes the first, which resumes with null.
        const secondPick = yield* manager.pickElement("pv-1").pipe(Effect.forkChild);
        yield* tick;
        expect(yield* Fiber.join(firstPick)).toBeNull();

        // The first crop's deadline passes during the second pick: telling the overlay would end the live pick.
        webviewSend.mockClear();
        yield* TestClock.adjust(CROP_DEADLINE);
        yield* tick;
        expect(webviewSend).not.toHaveBeenCalledWith("preview:annotation-captured");
        expect(secondPick.pollUnsafe()).toBeUndefined();

        submit({ ...sampleAnnotation, id: "annotation_2" }, null, "attach");
        yield* TestClock.adjust(CROP_DEADLINE);
        const { annotation, submission } = (yield* Fiber.join(secondPick))!;
        expect([annotation.id, submission]).toEqual(["annotation_2", "attach"]);
      }),
    );
  });

  describe("history navigation", () => {
    managerTest(
      "walks the guest history from the thumb-button IPC",
      Effect.fnUntraced(function* (manager: Manager) {
        type NavigateListener = (event: unknown, payload: unknown) => void;
        let onMouseNavigate: NavigateListener | undefined;
        const goBack = vi.fn();
        const goForward = vi.fn();
        let backAvailable = true;
        fromId.mockReturnValue(
          stubGuest(42, {
            ipc: {
              on: vi.fn((channel: string, listener: NavigateListener) => {
                if (channel === "preview:mouse-navigate") onMouseNavigate = listener;
              }),
              off: vi.fn(),
            },
            navigationHistory: {
              canGoBack: () => backAvailable,
              canGoForward: () => true,
              goBack,
              goForward,
            },
          }),
        );

        yield* addTabs(manager, ["pv-nav", 42]);
        expect(onMouseNavigate).toBeDefined();
        const press = function* (direction: string) {
          onMouseNavigate?.({}, { direction });
          yield* tick;
        };

        yield* press("back");
        expect(goBack.mock.calls).toHaveLength(1);

        yield* press("forward");
        expect(goForward.mock.calls).toHaveLength(1);

        // Unknown payloads are ignored, and an exhausted history never navigates.
        yield* press("sideways");
        backAvailable = false;
        yield* press("back");
        expect(goBack.mock.calls).toHaveLength(1);
      }),
    );
  });

  describe("browser artifacts", () => {
    const expectOutsideDirectory = (exit: Exit.Exit<unknown, WebManager.WebManagerError>) => {
      const error = failureOf(exit);
      expect(error).toMatchObject({
        _tag: "WebArtifactPathOutsideDirectoryError",
        artifactPath: OUTSIDE_PATH,
        artifactDirectory: ARTIFACTS_DIR,
      });
      expect("cause" in error).toBe(false);
    };

    managerTest(
      "only reveals files that live in the artifacts folder",
      Effect.fnUntraced(function* (manager: Manager) {
        yield* manager.revealArtifact(SCREENSHOT_PATH);
        expect(showItemInFolder).toHaveBeenCalledWith(SCREENSHOT_PATH);

        expectOutsideDirectory(yield* Effect.exit(manager.revealArtifact(OUTSIDE_PATH)));
      }),
    );

    managerTest(
      "refuses a link in the artifacts folder that points outside it (2026-10-15 audit desktop #10)",
      Effect.fnUntraced(function* (manager: Manager) {
        const link = `${ARTIFACTS_DIR}/innocent.png`;
        realPaths.set(link, OUTSIDE_PATH);
        try {
          const error = failureOf(yield* Effect.exit(manager.revealArtifact(link)));
          expect(error).toMatchObject({
            _tag: "WebArtifactPathOutsideDirectoryError",
            artifactPath: link,
          });
          expect(showItemInFolder).not.toHaveBeenCalledWith(link);
        } finally {
          realPaths.delete(link);
        }
      }),
    );

    managerTest(
      "copies a screenshot artifact to the clipboard and reports each way it can fail",
      Effect.fnUntraced(function* (manager: Manager) {
        yield* manager.copyArtifactToClipboard(SCREENSHOT_PATH);

        expect(createFromPath).toHaveBeenCalledWith(SCREENSHOT_PATH);
        expect(clipboardItemConstructor).toHaveBeenCalledWith({
          "image/png": expect.any(Blob),
        });
        expect(writeClipboard.mock.calls).toHaveLength(1);
        expectOutsideDirectory(yield* Effect.exit(manager.copyArtifactToClipboard(OUTSIDE_PATH)));

        const undecodable = { toPNG: () => Buffer.alloc(0), isEmpty: () => true };
        createFromPath.mockReturnValueOnce(undecodable);
        const unreadable = yield* Effect.exit(manager.copyArtifactToClipboard(SCREENSHOT_PATH));
        expect(failureOf(unreadable)).toMatchObject({
          _tag: "WebArtifactImageLoadError",
          artifactPath: SCREENSHOT_PATH,
        });

        const clipboardFailure = new Error("clipboard write failed");
        writeClipboard.mockRejectedValueOnce(clipboardFailure);
        const unwritable = yield* Effect.exit(manager.copyArtifactToClipboard(SCREENSHOT_PATH));
        expect(failureOf(unwritable)).toMatchObject({
          _tag: "WebOperationError",
          operation: "copyArtifactToClipboard.write",
          artifactPath: SCREENSHOT_PATH,
          cause: clipboardFailure,
        });
      }),
    );
  });
});

describe("WebOperationError", () => {
  it("exposes the underlying detail for the timeline but not in its message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new WebManager.WebOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "pv-1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(WebManager.WebOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

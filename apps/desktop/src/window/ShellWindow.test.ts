import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Electron from "electron";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  References,
  Schema,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import { expect, vi } from "vite-plus/test";

// Only what the shell window touches at runtime: no Electron binary needed.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/kora-test-user-data" },
  screen: {
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 kora/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
}));

import * as ShellAssets from "../app/ShellAssets.ts";
import * as ShellConfig from "../app/ShellConfig.ts";
import * as ShellContext from "../app/ShellContext.ts";
import * as ShellState from "../app/ShellState.ts";
import { IPC_MENU_ACTION, IPC_WINDOW_FULLSCREEN_STATE } from "../ipc/channelNames.ts";
import * as NativeApp from "../native/NativeApp.ts";
import * as NativeMenu from "../native/NativeMenu.ts";
import * as NativeShell from "../native/NativeShell.ts";
import * as NativeTheme from "../native/NativeTheme.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import * as ShellAppPrefs from "../prefs/ShellAppPrefs.ts";
import * as ShellClientPrefs from "../prefs/ShellClientPrefs.ts";
import * as WebManager from "../web/Manager.ts";
import * as ShellWindow from "./ShellWindow.ts";

const BACKEND_URL = new URL("http://127.0.0.1:3773");
const DEV_APP_URL = "kora-dev://app/";

const hostInput = {
  platform: "darwin",
  processArch: "arm64",
  runningUnderArm64Translation: false,
  isPackaged: false,
  appVersion: "1.2.3",
  appPath: "/repo",
  resourcesPath: "/repo/resources",
  homeDirectory: "/Users/alice",
  dirname: "/repo/apps/desktop/dist-electron",
} satisfies ShellContext.MakeShellContextInput;

type Listener = (...args: readonly unknown[]) => void;
type Rect = { x: number; y: number; width: number; height: number };
type Bounds = ShellAppPrefs.ShellWindowBounds;
type MainSlot = Ref.Ref<Option.Option<Electron.BrowserWindow>>;

const DEFAULT_RECT: Rect = { x: 0, y: 0, width: 1100, height: 780 };

/** A listener registry that stores whatever a fake `.on` / `.once` is handed. */
const listenerBook = () => {
  const book = new Map<string, Listener>();
  const register = (eventName: string, listener: Listener) => {
    book.set(eventName, listener);
  };
  return { book, register };
};

/** One bare spy per name. */
const bareSpies = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<K, ReturnType<typeof vi.fn>>;

/** A spy that answers with a constant. */
const constant = <T>(value: T) => vi.fn(() => value);

function makeFakeBrowserWindow() {
  const windowEvents = listenerBook();
  const contentsEvents = listenerBook();
  let zoomLevel = 0;

  const webContents = {
    ...bareSpies(
      "copyImageAt",
      "focus",
      "openDevTools",
      "reload",
      "replaceMisspelling",
      "send",
      "setBackgroundThrottling",
      "setWindowOpenHandler",
    ),
    isDestroyed: constant(false),
    getURL: constant(DEV_APP_URL),
    isLoadingMainFrame: constant(false),
    // Chromium zooms in steps of 1.2x per level.
    setZoomLevel: vi.fn((level: number) => void (zoomLevel = level)),
    getZoomFactor: vi.fn(() => Math.pow(1.2, zoomLevel)),
    getZoomLevel: vi.fn(() => zoomLevel),
    on: vi.fn(contentsEvents.register),
    once: vi.fn<(eventName: string, listener: Listener) => void>(),
  };

  const browserWindow = {
    ...bareSpies(
      "close",
      "focus",
      "maximize",
      "restore",
      "show",
      "setAutoHideCursor",
      "setBackgroundColor",
      "setFullScreen",
      "setOpacity",
      "setTitle",
      "setTitleBarOverlay",
      "setWindowButtonPosition",
    ),
    webContents,
    isDestroyed: constant(false),
    isFullScreen: constant(false),
    isMaximized: constant(false),
    isMinimized: constant(false),
    isVisible: constant(true),
    loadURL: vi.fn(() => Promise.resolve()),
    getBounds: vi.fn(() => ({ ...DEFAULT_RECT })),
    getNormalBounds: vi.fn(() => ({ ...DEFAULT_RECT })),
    on: vi.fn(windowEvents.register),
    once: vi.fn(windowEvents.register),
  };

  return {
    window: browserWindow as unknown as Electron.BrowserWindow,
    windowListeners: windowEvents.book,
    webContentsListeners: contentsEvents.book,
    webContentsOnce: webContents.once,
    getBounds: browserWindow.getBounds,
    getNormalBounds: browserWindow.getNormalBounds,
    isDestroyed: browserWindow.isDestroyed,
    isFullScreen: browserWindow.isFullScreen,
    isMaximized: browserWindow.isMaximized,
    isMinimized: browserWindow.isMinimized,
    loadURL: browserWindow.loadURL,
    maximize: browserWindow.maximize,
    setAutoHideCursor: browserWindow.setAutoHideCursor,
    setFullScreen: browserWindow.setFullScreen,
    setOpacity: browserWindow.setOpacity,
    setWindowButtonPosition: browserWindow.setWindowButtonPosition,
    // and the webContents spies a test reads most
    send: webContents.send,
    reload: webContents.reload,
    setZoomLevel: webContents.setZoomLevel,
    setBackgroundThrottling: webContents.setBackgroundThrottling,
    openDevTools: webContents.openDevTools,
  };
}

type FakeWindow = ReturnType<typeof makeFakeBrowserWindow>;

const sharedLayers = {
  clientPrefs: Layer.mock(ShellClientPrefs.ShellClientPrefs)({
    get: Effect.succeed(Option.none()),
  }),
  app: Layer.mock(NativeApp.NativeApp)({ quit: Effect.void }),
  assets: Layer.succeed(ShellAssets.ShellAssets, {
    resolveResourcePath: () => Effect.succeed(Option.none<string>()),
    iconPaths: Effect.succeed({
      png: Option.none<string>(),
      icns: Option.none<string>(),
      ico: Option.none<string>(),
    }),
  } satisfies ShellAssets.ShellAssets["Service"]),
  menu: Layer.succeed(NativeMenu.NativeMenu, {
    showContextMenu: () => Effect.succeed(Option.none()),
    popupTemplate: () => Effect.void,
    setApplicationMenu: () => Effect.void,
  } satisfies NativeMenu.NativeMenu["Service"]),
  theme: Layer.succeed(NativeTheme.NativeTheme, {
    shouldUseDarkColors: Effect.succeed(false),
    onUpdated: () => Effect.void,
    setSource: () => Effect.void,
  } satisfies NativeTheme.NativeTheme["Service"]),
  // A dev run (the renderer comes from Vite) with the daemon on its usual port.
  context: Layer.provide(
    ShellContext.layer(hostInput),
    Layer.merge(
      ShellConfig.layerTest({ KORA_PORT: "3773", VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" }),
      NodeServices.layer,
    ),
  ),
};

/** WebManager stand-in: only the preview-partition surface the shell window touches. */
const webManagerStub = (extra: Partial<WebManager.WebManager["Service"]> = {}) =>
  Layer.mock(WebManager.WebManager)({
    getBrowserSession: () => Effect.succeed({} as Electron.Session),
    getBrowserPartition: () => Effect.succeed("persist:kora-preview-test"),
    isBrowserPartition: (partition) => partition.startsWith("persist:kora-preview-"),
    setMainWindow: () => Effect.void,
    ...extra,
  });

const boundsEqual = Schema.toEquivalence(ShellAppPrefs.ShellWindowBoundsSchema);

/** The one window every `create` returns, plus optional recorders: each array collects what the shell did. */
interface HarnessOptions {
  readonly window: Electron.BrowserWindow;
  readonly mainWindow: MainSlot;
  readonly createCount: Ref.Ref<number>;
  readonly desktopSettings?: ShellAppPrefs.ShellPrefs;
  // recorders
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly copiedTexts?: string[];
  readonly openedExternalUrls?: unknown[];
  readonly previewZoomReapplies?: number[];
  readonly mainWindowBoundsUpdates?: Bounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  // hooks
  readonly onReveal?: (window: Electron.BrowserWindow) => void;
  readonly onPopupTemplate?: (input: NativeMenu.NativeMenuTemplateInput) => Effect.Effect<void>;
  readonly beforeMainWindowBoundsUpdate?: (bounds: Bounds) => Effect.Effect<void>;
}

function makeTestLayer(opts: HarnessOptions) {
  let prefs = opts.desktopSettings ?? ShellAppPrefs.DEFAULT_SHELL_PREFS;
  const appPrefs = Layer.succeed(ShellAppPrefs.ShellAppPrefs, {
    get: Effect.sync(() => prefs),
    load: Effect.sync(() => prefs),
    setLocalHostEnabled: () => Effect.die("unexpected local environment toggle"),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        yield* opts.beforeMainWindowBoundsUpdate?.(bounds) ?? Effect.void;
        const unchanged =
          prefs.mainWindowBounds !== null &&
          boundsEqual(prefs.mainWindowBounds, bounds) &&
          prefs.mainWindowMaximized === isMaximized;
        if (!unchanged) {
          prefs = { ...prefs, mainWindowBounds: bounds, mainWindowMaximized: isMaximized };
          opts.mainWindowBoundsUpdates?.push(bounds);
          opts.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: prefs, changed: !unchanged };
      }),
  } satisfies ShellAppPrefs.ShellAppPrefs["Service"]);

  const nativeWindow = Layer.succeed(NativeWindow.NativeWindow, {
    create: (createOptions) =>
      Effect.sync(() => {
        opts.createdWindowOptions?.push(createOptions);
      }).pipe(Effect.andThen(Ref.update(opts.createCount, (n) => n + 1)), Effect.as(opts.window)),
    reveal: (window) => Effect.sync(() => opts.onReveal?.(window)),
    syncAllAppearance: (sync) => sync(opts.window),
    setMain: (window) => Ref.set(opts.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(opts.mainWindow, Option.none()),
    // With one window there is no "first other window": all three lookups are the main slot.
    main: Ref.get(opts.mainWindow),
    mainOrAnyWindow: Ref.get(opts.mainWindow),
    focusedOrMainWindow: Ref.get(opts.mainWindow),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
  } satisfies NativeWindow.NativeWindow["Service"]);

  const menu = Layer.succeed(NativeMenu.NativeMenu, {
    setApplicationMenu: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
    popupTemplate: opts.onPopupTemplate ?? (() => Effect.void),
  });

  const shell = Layer.succeed(NativeShell.NativeShell, {
    openExternal: (url) =>
      Effect.sync(() => {
        opts.openedExternalUrls?.push(url);
        return true;
      }),
    copyText: (text) =>
      Effect.sync(() => {
        opts.copiedTexts?.push(text);
      }),
  } satisfies NativeShell.NativeShell["Service"]);

  const webManager = webManagerStub({
    reapplyZoom: () =>
      Effect.sync(() => {
        opts.previewZoomReapplies?.push(opts.window.webContents.getZoomLevel());
      }),
  });

  return ShellWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        sharedLayers.assets,
        sharedLayers.context,
        appPrefs,
        sharedLayers.clientPrefs,
        ShellState.layer,
        sharedLayers.app,
        menu,
        shell,
        sharedLayers.theme,
        nativeWindow,
        webManager,
      ),
    ),
  );
}

type Service = ShellWindow.ShellWindow["Service"];

interface Rig {
  readonly fake: FakeWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: MainSlot;
}

type RigOptions = Partial<Omit<HarnessOptions, "window" | "createCount" | "mainWindow">> & {
  /** Runs against the fake window before the layer is built. */
  readonly arrange?: (fake: FakeWindow) => void;
};

/**
 * Builds a fake window plus the layered ShellWindow around it and runs `body`
 * with the service. Everything a test records through `options` arrays is the
 * caller's to inspect afterwards.
 */
const inShellWindow = <A, E>(
  options: RigOptions,
  body: (shellWindow: Service, rig: Rig) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fake = makeFakeBrowserWindow();
    options.arrange?.(fake);
    const createCount = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const { arrange: _arrange, ...harness } = options;
    const layer = makeTestLayer({ ...harness, window: fake.window, createCount, mainWindow });
    return yield* Effect.gen(function* () {
      const shellWindow = yield* ShellWindow.ShellWindow;
      return yield* body(shellWindow, { fake, createCount, mainWindow });
    }).pipe(Effect.provide(layer));
  });

/** Same as `inShellWindow`, after the backend announced itself. */
const afterBackendReady = <A, E>(
  options: RigOptions,
  body: (shellWindow: Service, rig: Rig) => Effect.Effect<A, E>,
) =>
  inShellWindow(options, (shellWindow, rig) =>
    shellWindow.handleBackendReady(BACKEND_URL).pipe(Effect.andThen(body(shellWindow, rig))),
  );

const listenerNamed = (book: ReadonlyMap<string, Listener>, label: string, ...names: string[]) =>
  Effect.gen(function* () {
    const found = names.map((name) => book.get(name));
    if (found.some((listener) => listener === undefined)) {
      return yield* Effect.die(`${label} were not registered`);
    }
    return found as Listener[];
  });

const flushMicrotasks = Effect.promise(() => Promise.resolve());

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

/** What a splash run did: every create attempt, the windows that opened, the registered main, what was revealed. */
interface SplashLog {
  attempts: number;
  opened: Electron.BrowserWindow[];
  main: Electron.BrowserWindow | undefined;
  revealed: Electron.BrowserWindow[];
}

/**
 * A shell window whose NativeWindow opens `plan` in order, `null` being an open that fails. Until a main window is
 * registered, "the current window" is the first one that opened (the splash), as in the real window pool.
 */
const withSplashPlan = <A, E>(
  plan: readonly (Electron.BrowserWindow | null)[],
  body: (shellWindow: Service, log: SplashLog) => Effect.Effect<A, E>,
) => {
  const log: SplashLog = { attempts: 0, opened: [], main: undefined, revealed: [] };
  const current = Effect.sync(() => Option.fromNullishOr(log.main ?? log.opened[0]));
  const nativeWindow: NativeWindow.NativeWindow["Service"] = {
    create: (options) =>
      Effect.suspend(() => {
        const next = plan[log.attempts++] ?? null;
        if (next === null) {
          const cause = new Error("the window could not be opened");
          return Effect.fail(
            new NativeWindow.NativeWindowCreateError({
              options: NativeWindow.snapshotOptions(options),
              cause,
            }),
          );
        }
        log.opened.push(next);
        return Effect.succeed(next);
      }),
    setMain: (win) => Effect.sync(() => void (log.main = win)),
    clearMain: () => Effect.sync(() => void (log.main = undefined)),
    main: Effect.sync(() => Option.fromNullishOr(log.main)),
    mainOrAnyWindow: current,
    focusedOrMainWindow: current,
    reveal: (win) => Effect.sync(() => void log.revealed.push(win)),
    syncAllAppearance: (sync) =>
      Effect.suspend(() => (log.opened[0] ? sync(log.opened[0]) : Effect.void)),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
  };
  const deps = Layer.mergeAll(
    Layer.succeed(NativeWindow.NativeWindow, nativeWindow),
    Layer.succeed(NativeShell.NativeShell, {
      copyText: () => Effect.void,
      openExternal: () => Effect.succeed(true),
    }),
    ShellAppPrefs.layerTest(),
    webManagerStub(),
    sharedLayers.context,
    sharedLayers.assets,
    sharedLayers.theme,
    sharedLayers.menu,
    sharedLayers.clientPrefs,
    sharedLayers.app,
  );
  return Effect.flatMap(ShellWindow.ShellWindow, (shellWindow) => body(shellWindow, log)).pipe(
    Effect.provide(ShellWindow.layer.pipe(Layer.provide(deps))),
  );
};

/** A preview's (or its popup's) webContents: just the calls a right-click makes, plus a switch to "close" it. */
function fakeGuest(onFocus: (guest: unknown) => void) {
  const calls = { replaced: [] as string[], imagesCopiedAt: [] as [number, number][] };
  const guest = Object.assign(new NodeEvents.EventEmitter(), {
    closed: false,
    isDestroyed: () => guest.closed,
    focus: () => onFocus(guest),
    replaceMisspelling: (word: string) => void calls.replaced.push(word),
    copyImageAt: (x: number, y: number) => void calls.imagesCopiedAt.push([x, y]),
  });
  return { guest, calls };
}

/** Right-click parameters over plain text; `over` changes what was under the pointer. */
const rightClick = (over: Partial<Electron.ContextMenuParams> = {}) =>
  ({
    x: 40,
    y: 8,
    frame: null,
    linkURL: "",
    mediaType: "none",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: { canCut: true, canCopy: true, canPaste: false, canSelectAll: true },
    ...over,
  }) as unknown as Electron.ContextMenuParams;

type ShownMenu = { readonly menu: NativeMenu.NativeMenuTemplateInput; readonly focused: unknown };

/**
 * The shell window with a preview attached (twice, as Electron may) and a sign-in popup it opened (twice too).
 * Every menu the shell pops up lands in `shown`, with whatever had focus when it did.
 */
const withPreview = <A, E>(
  body: (r: {
    host: FakeWindow;
    preview: ReturnType<typeof fakeGuest>;
    popup: ReturnType<typeof fakeGuest> & { window: Electron.BrowserWindow };
    shown: Queue.Queue<ShownMenu>;
    copied: string[];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const host = makeFakeBrowserWindow();
    let focused: unknown = host.window.webContents;
    const preview = fakeGuest((g) => (focused = g));
    const popupGuest = fakeGuest((g) => (focused = g));
    const popup = {
      ...popupGuest,
      window: {
        ...makeFakeBrowserWindow().window,
        webContents: popupGuest.guest,
      } as unknown as Electron.BrowserWindow,
    };
    const shown = yield* Queue.unbounded<ShownMenu>();
    const copied: string[] = [];
    const noMainYet = yield* Ref.make(Option.none<Electron.BrowserWindow>());
    const layer = makeTestLayer({
      copiedTexts: copied,
      window: host.window,
      mainWindow: noMainYet,
      createCount: yield* Ref.make(0),
      onPopupTemplate: (menu) => {
        const entry = { menu, focused };
        focused = host.window.webContents;
        return Queue.offer(shown, entry).pipe(Effect.asVoid);
      },
    });
    return yield* Effect.gen(function* () {
      yield* (yield* ShellWindow.ShellWindow).handleBackendReady(BACKEND_URL);
      const [attached] = yield* listenerNamed(
        host.webContentsListeners,
        "the preview hook",
        "did-attach-webview",
      );
      for (const _ of [1, 2]) attached!({}, preview.guest);
      for (const _ of [1, 2]) preview.guest.emit("did-create-window", popup.window);
      return yield* body({ host, preview, popup, shown, copied });
    }).pipe(Effect.provide(layer));
  });

const clickItem = (menu: NativeMenu.NativeMenuTemplateInput, label: string) => {
  const item = menu.template.find((entry) => entry.label === label);
  if (typeof item?.click !== "function") throw new Error(`no clickable "${label}"`);
  item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
};

describe("ShellWindow", () => {
  describe("right-click inside a preview or a popup it opened", () => {
    it.effect.each(["preview", "popup"] as const)(
      "the %s gets one native menu, aimed at itself, with a working spelling fix",
      (where) =>
        withPreview((r) =>
          Effect.gen(function* () {
            const target = where === "preview" ? r.preview : r.popup;
            const frame = { routingId: 3 } as Electron.WebFrameMain;
            let defaultPrevented = 0;
            target.guest.emit(
              "context-menu",
              { preventDefault: () => defaultPrevented++ },
              rightClick({ frame, misspelledWord: "recieve", dictionarySuggestions: ["receive"] }),
            );
            const { menu, focused } = yield* Queue.take(r.shown);
            assert.equal(yield* Queue.size(r.shown), 0, "hooked once, however often attached");
            assert.equal(defaultPrevented, 1);
            assert.strictEqual(focused, target.guest);
            assert.strictEqual(menu.window, where === "preview" ? r.host.window : r.popup.window);
            assert.strictEqual(menu.frame, frame);
            assert.deepEqual(
              menu.template.map(
                (entry) => entry.label ?? entry.type ?? `${entry.role}:${entry.enabled}`,
              ),
              ["receive", "separator", "cut:true", "copy:true", "paste:false", "selectAll:true"],
            );
            clickItem(menu, "receive");
            assert.deepEqual(target.calls.replaced, ["receive"]);
          }),
        ),
    );

    it.effect(
      "an image link offers Copy Image and Copy Link, and nothing fires once the page is gone",
      () =>
        withPreview((r) =>
          Effect.gen(function* () {
            r.preview.guest.emit(
              "context-menu",
              { preventDefault: () => undefined },
              rightClick({ mediaType: "image", linkURL: "https://example.com/cat.png" }),
            );
            const { menu } = yield* Queue.take(r.shown);
            assert.notProperty(menu, "frame");
            clickItem(menu, "Copy Link");
            clickItem(menu, "Copy Image");
            assert.deepEqual(r.copied, ["https://example.com/cat.png"]);
            assert.deepEqual(r.preview.calls.imagesCopiedAt, [[40, 8]]);

            r.preview.guest.closed = true;
            clickItem(menu, "Copy Image");
            assert.deepEqual(r.preview.calls.imagesCopiedAt, [[40, 8]]);
            r.preview.guest.emit("context-menu", { preventDefault: () => undefined }, rightClick());
            assert.equal(yield* Queue.size(r.shown), 0, "no menu for a closed page");
          }),
        ),
    );
  });

  describe("pure helpers", () => {
    it("restores saved bounds only if the window fits on a connected display", () => {
      const saved = rect(2040, 80, 1320, 880);
      const primary = rect(0, 0, 1920, 1080);
      const secondary = rect(1920, 0, 2560, 1440);

      assert.deepEqual(
        ShellWindow.resolveInitialMainWindowBounds(saved, [primary, secondary]),
        saved,
      );
      assert.deepEqual(
        ShellWindow.resolveInitialMainWindowBounds(saved, [primary]),
        ShellAppPrefs.DEFAULT_MAIN_WINDOW_SIZE,
      );
    });

    it("accepts a renderer navigation only inside the application's origin", () => {
      const sameOrigin = (navigationUrl: string, applicationUrl = "kora://app/") =>
        ShellWindow.isSameOriginRendererNavigation({ applicationUrl, navigationUrl });

      assert.isTrue(sameOrigin("kora://app/settings/connections"));
      assert.isFalse(sameOrigin("https://accounts.microsoft.com/oauth"));
      assert.isFalse(sameOrigin("not a url"));
    });

    it("never equates another opaque-origin scheme with the app", () => {
      const sameOrigin = (navigationUrl: string, applicationUrl: string) =>
        ShellWindow.isSameOriginRendererNavigation({ applicationUrl, navigationUrl });

      // URL.origin is "null" for every non-special scheme, the app's own included.
      const lookalikes = [
        "smb://evil.example/share",
        "file:///Applications/Calculator.app",
        "ms-msdt:/id PCWDiagnostic /skip force",
        "search-ms:query=x",
        "vscode://vscode-remote/ssh-remote+evil/x",
        "data:text/html,<script>alert(1)</script>",
        "kora://evil/",
        "kora-dev://app/",
        "kora://user:pass@app/",
      ];
      for (const url of lookalikes) assert.isFalse(sameOrigin(url, "kora://app/"), url);

      assert.isTrue(sameOrigin("kora-dev://app/thread/abc#x", "kora-dev://app/"));
      assert.isTrue(sameOrigin("http://localhost:5173/settings", "http://localhost:5173/"));
      assert.isFalse(sameOrigin("http://localhost:5174/", "http://localhost:5173/"));
    });

    it("treats only transient main-frame errors on the app URL as retryable", () => {
      const retryable = (patch: { errorCode?: number; validatedUrl?: string }) =>
        ShellWindow.isRetryableDevelopmentRendererLoadFailure({
          applicationUrl: DEV_APP_URL,
          errorCode: -102,
          isMainFrame: true,
          validatedUrl: DEV_APP_URL,
          ...patch,
        });

      assert.isTrue(retryable({}));
      assert.isFalse(retryable({ errorCode: -3 }));
      assert.isFalse(retryable({ validatedUrl: "https://example.com/" }));
    });
  });

  describe("opening the main window", () => {
    it.effect("waits for the backend before opening a development window", () => {
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      return inShellWindow({ createdWindowOptions }, (shellWindow, { fake, createCount }) =>
        Effect.gen(function* () {
          yield* shellWindow.activate;
          assert.equal(yield* Ref.get(createCount), 0);

          yield* shellWindow.handleBackendReady(BACKEND_URL);
          assert.equal(yield* Ref.get(createCount), 1);
          const [created] = createdWindowOptions;
          assert.equal(created?.width, 1100);
          assert.equal(created?.height, 780);
          assert.isUndefined(created?.x);
          assert.isUndefined(created?.y);
          assert.isTrue(created?.disableAutoHideCursor);
          assert.isFalse(created?.webPreferences?.backgroundThrottling);
          assert.deepEqual(fake.setAutoHideCursor.mock.calls, [[false]]);
          assert.deepEqual(fake.loadURL.mock.calls[0], [DEV_APP_URL]);
          assert.equal(fake.openDevTools.mock.calls.length, 1);
        }),
      );
    });

    it.effect("reopens without backend readiness when local execution is switched off", () =>
      inShellWindow(
        {
          createdWindowOptions: [],
          desktopSettings: { ...ShellAppPrefs.DEFAULT_SHELL_PREFS, localHostEnabled: false },
        },
        (shellWindow, { createCount, mainWindow }) =>
          Effect.gen(function* () {
            // Each way in, with the window closed before it, opens a new one without a daemon.
            const waysIn = [
              shellWindow.openMainWhenDaemonReady,
              shellWindow.activate,
              shellWindow.sendMenuAction("new-thread"),
            ];
            for (const open of waysIn) {
              yield* Ref.set(mainWindow, Option.none());
              yield* open;
            }
            assert.equal(yield* Ref.get(createCount), waysIn.length);
          }),
      ),
    );

    it.effect("opens at the saved window position and size", () => {
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      return afterBackendReady(
        {
          createdWindowOptions,
          desktopSettings: {
            ...ShellAppPrefs.DEFAULT_SHELL_PREFS,
            mainWindowBounds: rect(120, 80, 1320, 880),
          },
        },
        () =>
          Effect.sync(() => {
            const [created] = createdWindowOptions;
            assert.deepEqual(
              [created?.x, created?.y, created?.width, created?.height],
              [120, 80, 1320, 880],
            );
          }),
      );
    });

    it.effect("maximizes on first show when the saved state was maximized", () =>
      afterBackendReady(
        {
          desktopSettings: {
            ...ShellAppPrefs.DEFAULT_SHELL_PREFS,
            mainWindowBounds: rect(120, 80, 1320, 880),
            mainWindowMaximized: true,
          },
        },
        (_shellWindow, { fake }) =>
          Effect.gen(function* () {
            assert.equal(fake.maximize.mock.calls.length, 0);
            const [readyToShow] = yield* listenerNamed(
              fake.windowListeners,
              "window ready-to-show listener",
              "ready-to-show",
            );
            readyToShow!();
            assert.equal(fake.maximize.mock.calls.length, 1);
          }),
      ),
    );

    // The window boots hidden with throttling disabled so first paint runs at
    // full speed; the first reveal must hand it back to normal hidden-window
    // throttling or a minimized window stays expensive forever.
    it.effect("returns the window to normal throttling at its first reveal", () =>
      afterBackendReady({}, (_shellWindow, { fake }) =>
        Effect.gen(function* () {
          assert.equal(fake.setBackgroundThrottling.mock.calls.length, 0);
          const [readyToShow] = yield* listenerNamed(
            fake.windowListeners,
            "window ready-to-show listener",
            "ready-to-show",
          );
          readyToShow!();
          assert.deepEqual(fake.setBackgroundThrottling.mock.calls, [[true]]);
        }),
      ),
    );

    it.effect("reports a failed display lookup and opens at the default size", () =>
      Effect.gen(function* () {
        const lookupFailure = new Error("screen API unavailable");
        vi.mocked(Electron.screen.getAllDisplays).mockImplementationOnce(() => {
          throw lookupFailure;
        });
        const warnings = new Map<unknown, unknown>(); // first message part -> its `cause` annotation
        const recorder = Logger.make(({ fiber, message }) => {
          const first = Array.isArray(message) ? message[0] : message;
          warnings.set(first, fiber.getRef(References.CurrentLogAnnotations).cause);
        });
        const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];

        yield* inShellWindow({ createdWindowOptions }, (shellWindow) =>
          shellWindow.handleBackendReady(BACKEND_URL),
        ).pipe(Effect.provide(Logger.layer([recorder], { mergeWithExisting: false })));

        assert.strictEqual(
          warnings.get("failed to read connected displays; using defaults"),
          lookupFailure,
        );
        const [created] = createdWindowOptions;
        assert.deepEqual([created?.width, created?.height], [1100, 780]);
        assert.isUndefined(created?.x);
        assert.isUndefined(created?.y);
      }),
    );
  });

  describe("zoom and chrome", () => {
    it.effect("puts the preview browser back at its own zoom after each app zoom step", () => {
      const previewZoomReapplies: number[] = [];
      return afterBackendReady({ previewZoomReapplies }, (shellWindow, { fake }) =>
        Effect.gen(function* () {
          for (const direction of ["out", "out", "in", "reset"] as const) {
            yield* shellWindow.zoomMain(direction);
          }

          assert.deepEqual(
            fake.setZoomLevel.mock.calls.map(([level]) => level),
            [-0.5, -1, -0.5, 0],
          );
          // Recorded after the window level moved, so the preview is restored to
          // its own zoom at every step instead of keeping the inherited one.
          assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
        }),
      );
    });

    it.effect(
      "the traffic lights stay centred on the zoomed top bar, and are left alone in fullscreen",
      () =>
        afterBackendReady({}, (shellWindow, { fake }) =>
          Effect.gen(function* () {
            const lights = fake.setWindowButtonPosition;
            const lastPosition = () => lights.mock.lastCall?.[0] as { x: number; y: number };
            // The 52px bar scales with zoom; the 14pt buttons do not, so their top moves to keep them centred.
            const centredTop = () => 26 * fake.window.webContents.getZoomFactor() - 7;
            for (const step of ["in", "in", "out", "reset", "out"] as const) {
              yield* shellWindow.zoomMain(step);
              expect(lastPosition().x).toBe(16);
              expect(lastPosition().y).toBeCloseTo(centredTop(), 0);
            }

            fake.isFullScreen.mockReturnValue(true);
            const before = lights.mock.calls.length;
            yield* shellWindow.zoomMain("reset");
            expect(lights.mock.calls.length).toBe(before);

            fake.isFullScreen.mockReturnValue(false);
            fake.windowListeners.get("leave-full-screen")?.();
            expect(lastPosition()).toEqual({ x: 16, y: 19 });
          }),
        ),
    );

    it.effect("tells the renderer about native fullscreen transitions", () =>
      afterBackendReady({}, (_shellWindow, { fake }) =>
        Effect.gen(function* () {
          const [enter, leave] = yield* listenerNamed(
            fake.windowListeners,
            "fullscreen listeners",
            "enter-full-screen",
            "leave-full-screen",
          );
          enter!();
          leave!();
          assert.deepEqual(fake.send.mock.calls, [
            [IPC_WINDOW_FULLSCREEN_STATE, true],
            [IPC_WINDOW_FULLSCREEN_STATE, false],
          ]);
        }),
      ),
    );
  });

  describe("persisting window bounds", () => {
    it.effect("coalesces move and resize events into one trailing update", () => {
      const mainWindowBoundsUpdates: Bounds[] = [];
      return afterBackendReady({ mainWindowBoundsUpdates }, (_shellWindow, { fake }) =>
        Effect.gen(function* () {
          const [move, resize] = yield* listenerNamed(
            fake.windowListeners,
            "window bounds listeners",
            "move",
            "resize",
          );

          fake.getBounds.mockReturnValue(rect(120, 80, 1280, 840));
          move!();
          yield* TestClock.adjust(250);

          fake.getBounds.mockReturnValue(rect(160, 100, 1360, 900));
          resize!();
          // Saved half a second after the LAST change, not the first.
          for (const step of [400, 99]) yield* TestClock.adjust(step);
          assert.lengthOf(mainWindowBoundsUpdates, 0);
          yield* TestClock.adjust(1).pipe(Effect.andThen(flushMicrotasks));
          assert.deepEqual(mainWindowBoundsUpdates, [rect(160, 100, 1360, 900)]);
        }),
      );
    });

    it.effect("stores the normal bounds when a maximized window closes", () => {
      const mainWindowBoundsUpdates: Bounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      return afterBackendReady(
        {
          mainWindowBoundsUpdates,
          mainWindowMaximizedUpdates,
          arrange: (fake) => {
            fake.isMaximized.mockReturnValue(true);
            fake.getBounds.mockReturnValue(rect(0, 0, 1920, 1080));
            fake.getNormalBounds.mockReturnValue(rect(220, 140, 1380, 920));
          },
        },
        (_shellWindow, { fake }) =>
          Effect.gen(function* () {
            const [close] = yield* listenerNamed(
              fake.windowListeners,
              "window close listener",
              "close",
            );
            close!();
            yield* flushMicrotasks;

            assert.deepEqual(mainWindowBoundsUpdates, [rect(220, 140, 1380, 920)]);
            assert.deepEqual(mainWindowMaximizedUpdates, [true]);
            assert.equal(fake.getNormalBounds.mock.calls.length, 1);
            assert.equal(fake.getBounds.mock.calls.length, 0);
          }),
      );
    });

    it.effect("stores the normal bounds from the native maximize event", () => {
      const mainWindowBoundsUpdates: Bounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      return afterBackendReady(
        { mainWindowBoundsUpdates, mainWindowMaximizedUpdates },
        (_shellWindow, { fake }) =>
          Effect.gen(function* () {
            const [maximize] = yield* listenerNamed(
              fake.windowListeners,
              "window maximize listener",
              "maximize",
            );

            fake.isMaximized.mockReturnValue(true);
            fake.getBounds.mockReturnValue(rect(0, 0, 1920, 1080));
            fake.getNormalBounds.mockReturnValue(rect(220, 140, 1380, 920));
            maximize!();
            yield* TestClock.adjust(500);
            yield* flushMicrotasks;

            assert.deepEqual(mainWindowBoundsUpdates, [rect(220, 140, 1380, 920)]);
            assert.deepEqual(mainWindowMaximizedUpdates, [true]);
          }),
      );
    });

    it.effect("skips bounds that the schema rejects", () => {
      const mainWindowBoundsUpdates: Bounds[] = [];
      return afterBackendReady(
        {
          mainWindowBoundsUpdates,
          arrange: (fake) => {
            fake.getBounds.mockReturnValue(rect(100.4, 80.2, 839.4, 619.4));
          },
        },
        (_shellWindow, { fake }) =>
          Effect.gen(function* () {
            const [resize] = yield* listenerNamed(
              fake.windowListeners,
              "window resize listener",
              "resize",
            );
            resize!();
            yield* TestClock.adjust(500);
            yield* flushMicrotasks;

            assert.deepEqual(mainWindowBoundsUpdates, []);
          }),
      );
    });

    it.effect("leaves unrestorable saved bounds alone until the user moves the window", () => {
      const mainWindowBoundsUpdates: Bounds[] = [];
      return afterBackendReady(
        {
          mainWindowBoundsUpdates,
          desktopSettings: {
            ...ShellAppPrefs.DEFAULT_SHELL_PREFS,
            mainWindowBounds: rect(2040, 80, 1320, 880),
          },
        },
        (_shellWindow, { fake }) =>
          Effect.gen(function* () {
            const [close, move] = yield* listenerNamed(
              fake.windowListeners,
              "window lifecycle listeners",
              "close",
              "move",
            );

            close!();
            yield* flushMicrotasks;
            assert.deepEqual(mainWindowBoundsUpdates, []);

            fake.getBounds.mockReturnValue(rect(80, 60, 1280, 840));
            move!();
            yield* TestClock.adjust(500);
            yield* flushMicrotasks;
            assert.deepEqual(mainWindowBoundsUpdates, [rect(80, 60, 1280, 840)]);
          }),
      );
    });

    describe.each([
      {
        state: "fullscreen",
        arrange: (fake: FakeWindow) => {
          fake.getBounds.mockReturnValue(rect(0, 0, 1920, 1080));
          fake.getNormalBounds.mockReturnValue(rect(200, 130, 1400, 940));
        },
        enter: (fake: FakeWindow) => fake.isFullScreen.mockReturnValue(true),
        expected: rect(200, 130, 1400, 940),
      },
      {
        state: "minimized",
        arrange: (fake: FakeWindow) => {
          fake.getBounds.mockReturnValue(rect(-32_000, -32_000, 160, 28));
          fake.getNormalBounds.mockReturnValue(rect(180, 120, 1440, 960));
        },
        enter: (fake: FakeWindow) => fake.isMinimized.mockReturnValue(true),
        expected: rect(180, 120, 1440, 960),
      },
    ])("while $state", ({ arrange, enter, expected }) => {
      it.effect("flushes the normal bounds before the debounce elapses", () => {
        const mainWindowBoundsUpdates: Bounds[] = [];
        return afterBackendReady({ mainWindowBoundsUpdates, arrange }, (shellWindow, { fake }) =>
          Effect.gen(function* () {
            const [resize] = yield* listenerNamed(
              fake.windowListeners,
              "window resize listener",
              "resize",
            );
            resize!();
            yield* TestClock.adjust(250);
            enter(fake);

            yield* shellWindow.saveMainWindowPlace;

            assert.deepEqual(mainWindowBoundsUpdates, [expected]);
            assert.equal(fake.getBounds.mock.calls.length, 0);
            assert.equal(fake.getNormalBounds.mock.calls.length, 1);
          }),
        );
      });
    });

    it.effect("a flush at quit waits for the save the close already started", () => {
      const saved: Bounds[] = [];
      const lastPlace = rect(240, 160, 1410, 930);
      return Effect.gen(function* () {
        const saving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* afterBackendReady(
          {
            mainWindowBoundsUpdates: saved,
            arrange: (fake) => void fake.getBounds.mockReturnValue(lastPlace),
            // The save stalls on disk until the test lets it through.
            beforeMainWindowBoundsUpdate: () =>
              Effect.andThen(Deferred.succeed(saving, undefined), Deferred.await(release)),
          },
          (shellWindow, { fake }) =>
            Effect.gen(function* () {
              const [onClose] = yield* listenerNamed(fake.windowListeners, "close", "close");
              onClose!();
              yield* Deferred.await(saving);
              fake.isDestroyed.mockReturnValue(true);

              const flush = yield* Effect.forkChild(shellWindow.saveMainWindowPlace, {
                startImmediately: true,
              });
              yield* Effect.yieldNow;
              assert.isUndefined(flush.pollUnsafe(), "still waiting on the stalled save");

              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(flush);
              assert.deepEqual(saved, [lastPlace], "saved once, by the close");
            }),
        );
      });
    });
  });

  describe("renderer loading and navigation", () => {
    it.effect("reloads the app URL when the development renderer is briefly unreachable", () =>
      afterBackendReady({}, (_shellWindow, { fake }) =>
        Effect.gen(function* () {
          const [didFailLoad, didFinishLoad] = yield* listenerNamed(
            fake.webContentsListeners,
            "renderer load listeners",
            "did-fail-load",
            "did-finish-load",
          );
          const failMainFrame = () => didFailLoad!({}, -9, "ERR_UNEXPECTED", DEV_APP_URL, true);

          failMainFrame();
          assert.equal(fake.loadURL.mock.calls.length, 1);

          yield* TestClock.adjust(100);
          assert.deepEqual(fake.loadURL.mock.calls, [[DEV_APP_URL], [DEV_APP_URL]]);
          assert.equal(fake.reload.mock.calls.length, 0);

          failMainFrame();
          didFinishLoad!();
          yield* TestClock.adjust(250);
          assert.equal(fake.loadURL.mock.calls.length, 2);
          assert.equal(fake.reload.mock.calls.length, 0);
        }),
      ),
    );

    it.effect("sends safe off-origin navigations to the system browser", () => {
      const openedExternalUrls: unknown[] = [];
      return afterBackendReady({ openedExternalUrls }, (_shellWindow, { fake }) =>
        Effect.gen(function* () {
          const [willNavigate] = yield* listenerNamed(
            fake.webContentsListeners,
            "will-navigate listener",
            "will-navigate",
          );
          const kept = vi.fn();
          willNavigate!({ preventDefault: kept }, "https://accounts.microsoft.com/oauth");
          yield* flushMicrotasks;
          assert.equal(kept.mock.calls.length, 1, "the app window itself stays put");
          assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
        }),
      );
    });
  });

  describe("while the daemon is still starting (the connecting splash)", () => {
    it.effect(
      "if the main window fails to open once ready, activating opens it rather than settling for the splash",
      () => {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        return withSplashPlan([splash.window, null, main.window], (shellWindow, log) =>
          Effect.gen(function* () {
            yield* shellWindow.showStartupSplash;
            const ready = yield* Effect.exit(shellWindow.handleBackendReady(BACKEND_URL));
            assert.isTrue(ready._tag === "Failure" && log.attempts === 2 && log.main === undefined);

            yield* shellWindow.activate;
            assert.equal(log.attempts, 3, "a fresh open, not the splash");
            assert.strictEqual(log.main, main.window);
          }),
        );
      },
    );

    it.effect("activating brings the splash back to the front and opens nothing new", () => {
      const splash = makeFakeBrowserWindow();
      return withSplashPlan([splash.window], (shellWindow, log) =>
        Effect.gen(function* () {
          yield* shellWindow.showStartupSplash;
          yield* shellWindow.activate;
          assert.deepEqual(
            { attempts: log.attempts, revealed: log.revealed },
            { attempts: 1, revealed: [splash.window] },
          );
        }),
      );
    });

    it.effect("a menu action is dropped, never sent to the splash", () => {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      return withSplashPlan([splash.window, main.window], (shellWindow, log) =>
        Effect.gen(function* () {
          yield* shellWindow.showStartupSplash;
          yield* shellWindow.sendMenuAction("open-settings");
          assert.deepEqual(
            [log.attempts, splash.send.mock.calls, main.send.mock.calls],
            [1, [], []],
          );
        }),
      );
    });

    it.effect("once a main window opens after readiness, menu actions reach it", () => {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      return withSplashPlan([splash.window, null, main.window], (shellWindow, log) =>
        Effect.gen(function* () {
          yield* shellWindow.showStartupSplash;
          yield* Effect.ignore(shellWindow.handleBackendReady(BACKEND_URL));
          yield* shellWindow.sendMenuAction("open-settings");
          assert.equal(log.attempts, 3);
          assert.deepEqual(main.send.mock.calls, [[IPC_MENU_ACTION, "open-settings"]]);
        }),
      );
    });
  });
});

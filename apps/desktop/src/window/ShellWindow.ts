// @effect-diagnostics globalDate:off -- the crash-recovery window is measured in a synchronous Electron callback.
import * as Electron from "electron";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";

import { installAppSessionPermissionPolicy } from "./AppSessionPermissions.ts";
import { hardenWebviewAttach } from "../web/WebNavigationPolicy.ts";
import * as WebManager from "../web/Manager.ts";
import * as ShellAppPrefs from "../prefs/ShellAppPrefs.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import * as NativeTheme from "../native/NativeTheme.ts";
import { parseSafeExternalUrl } from "../native/NativeShell.ts";
import * as NativeShell from "../native/NativeShell.ts";
import { getShellUrl } from "../native/NativeProtocol.ts";
import * as NativeMenu from "../native/NativeMenu.ts";
import { IPC_MENU_ACTION, IPC_WINDOW_FULLSCREEN_STATE } from "../ipc/channelNames.ts";
import * as ShellTracing from "../app/ShellTracing.ts";
import * as ShellContext from "../app/ShellContext.ts";
import { LAUNCH_RECORD_FILE, clearLaunchRecord } from "../app/CrashLoopGuard.ts";
import {
  TOPBAR_HEIGHT,
  TRAFFIC_LIGHT_SIZE,
  TRAFFIC_LIGHT_X,
  mainWindowChrome,
} from "./platformChrome.ts";

const { logInfo, logWarning } = ShellTracing.makeScopedLogger("desktop-window");

export type ShellWindowError = NativeWindow.NativeWindowCreateError | WebManager.WebManagerError;
export type MainWindowZoomDirection = "in" | "out" | "reset";

// ---------------------------------------------------------------------------------------------------------------
// Constants

const MIN_WIDTH = 840;
const MIN_HEIGHT = 620;
const BACKGROUND = { dark: "#000000", light: "#efeff1" } as const;
const SPLASH_LABEL_COLOR = { dark: "#8b8d95", light: "#63666d" } as const;
const BOUNDS_DEBOUNCE = Duration.millis(500);
const LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const CRASH_RELOAD_DELAY = Duration.millis(500);
const CRASH_RECOVERIES_PER_WINDOW = 3;
const CRASH_RECOVERY_WINDOW_MS = 60_000;
const ZOOM_STEP = 0.5;
const SPELLING_SUGGESTION_LIMIT = 5;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

type Rect = Readonly<Electron.Rectangle>;

/** The saved bounds when they sit entirely inside one connected display; otherwise let the OS centre a default. */
export function resolveInitialMainWindowBounds(
  saved: ShellAppPrefs.ShellWindowBounds | null,
  displays: readonly Rect[],
): ShellAppPrefs.ShellWindowBounds | typeof ShellAppPrefs.DEFAULT_MAIN_WINDOW_SIZE {
  if (saved !== null) {
    const fits = displays.some(
      (display) =>
        saved.x >= display.x &&
        saved.y >= display.y &&
        saved.x + saved.width <= display.x + display.width &&
        saved.y + saved.height <= display.y + display.height,
    );
    if (fits) return saved;
  }
  return ShellAppPrefs.DEFAULT_MAIN_WINDOW_SIZE;
}

/**
 * `URL.origin` is the string "null" for every non-special scheme, the app's own `kora://app` included, so
 * comparing origins would wave through smb:, file:, ms-msdt: and friends. For those the scheme and host are
 * compared instead.
 */
export function isSameOriginRendererNavigation(args: {
  readonly navigationUrl: string;
  readonly applicationUrl: string;
}): boolean {
  try {
    const application = new URL(args.applicationUrl);
    const dest = new URL(args.navigationUrl);
    if (application.origin !== "null") return application.origin === dest.origin;
    return (
      dest.origin === "null" &&
      application.host !== "" &&
      dest.protocol === application.protocol &&
      dest.host === application.host &&
      dest.username === "" &&
      dest.password === ""
    );
  } catch {
    return false;
  }
}

// ERR_FAILED, ERR_TIMED_OUT, ERR_UNEXPECTED (the protocol handler refused), ERR_CONNECTION_REFUSED,
// ERR_NAME_NOT_RESOLVED, ERR_INTERNET_DISCONNECTED, ERR_CONNECTION_TIMED_OUT.
const RETRYABLE_LOAD_ERRORS = new Set([-2, -7, -9, -102, -105, -106, -118]);

export function isRetryableDevelopmentRendererLoadFailure(args: {
  readonly validatedUrl: string;
  readonly isMainFrame: boolean;
  readonly errorCode: number;
  readonly applicationUrl: string;
}): boolean {
  return (
    args.isMainFrame &&
    RETRYABLE_LOAD_ERRORS.has(args.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: args.applicationUrl,
      navigationUrl: args.validatedUrl,
    })
  );
}

const SPLASH_SPRITE = [
  "....WWWW....",
  "...WWWWWS...",
  "..WWWWWWWS..",
  "..WKWWWKWS..",
  "..WKWWWKWS..",
  "..WWWWWWWS..",
  "...WWWWWS...",
  "...WS..WS...",
] as const;

function splashDocument(dark: boolean, heading: string): string {
  // The caption is the one <div>; setSplashMessage rewrites it ("Restarting Kora's background service…").
  const fills = dark
    ? { W: "#ededf0", S: "#a9abb3", K: "#0a0a0b" }
    : { W: "#18191c", S: "#4a4c52", K: "#ffffff" };
  const background = dark ? BACKGROUND.dark : BACKGROUND.light;
  const caption = dark ? SPLASH_LABEL_COLOR.dark : SPLASH_LABEL_COLOR.light;
  const pixels = SPLASH_SPRITE.flatMap((lineNo, py) =>
    [...lineNo].flatMap((slot, px) =>
      slot === "."
        ? []
        : [
            `<rect x="${px}" y="${py}" width="1" height="1" fill="${fills[slot as "W" | "S" | "K"]}"/>`,
          ],
    ),
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:${background};color:${caption};font:13px system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;-webkit-app-region:drag}
svg{width:72px;height:48px;shape-rendering:crispEdges;animation:hop 1.2s steps(1) infinite}
@keyframes hop{0%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){svg{animation:none}}
</style></head><body>
<svg viewBox="0 0 12 8" aria-hidden="true">${pixels}</svg>
<div>Starting Kora…</div>
</body></html>`;
}

function renderCrashRecoveryHtml(
  background: string,
  foreground: string,
  caption: string,
  applicationUrl: string,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kora</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:${background};color:${foreground};font:13px system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;-webkit-app-region:drag}
.title{font-size:16px;font-weight:600}
.caption{color:${caption};max-width:320px;text-align:center;line-height:1.4}
button{appearance:none;background:#27272a;color:#f2f2f4;border:1px solid rgba(255,255,255,0.15);padding:8px 16px;border-radius:6px;font:inherit;cursor:pointer;-webkit-app-region:no-drag}
button:hover{background:#3f3f46}
button:active{background:#18181b}
</style></head><body>
<div class="title">Kora stopped unexpectedly</div>
<div class="caption">The window encountered an error and could not automatically recover.</div>
<button onclick="window.location.href='${applicationUrl}'">Reload Kora</button>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Service

export class ShellWindow extends Context.Service<
  ShellWindow,
  {
    // The daemon's state, as the shell learns it.
    readonly showStartupSplash: Effect.Effect<void>;
    /** Change the splash's caption while it is up (no-op when there is no splash). */
    readonly setSplashMessage: (message: string) => Effect.Effect<void>;
    readonly handleBackendReady: (httpOrigin: URL) => Effect.Effect<void, ShellWindowError>;
    readonly handleBackendNotReady: Effect.Effect<void>;

    // The main window.
    readonly createMain: Effect.Effect<Electron.BrowserWindow, ShellWindowError>;
    readonly openMainWhenDaemonReady: Effect.Effect<void, ShellWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, ShellWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, ShellWindowError>;
    /** Dock click / app re-opened: bring a window forward, opening one if needed. */
    readonly activate: Effect.Effect<void, ShellWindowError>;
    /** Save where the window is now (at quit); waits for a save already under way. */
    readonly saveMainWindowPlace: Effect.Effect<void>;

    // What the menu and the OS ask of it.
    readonly sendMenuAction: (
      actionName: string,
      opts?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, ShellWindowError>;
    readonly zoomMain: (dir: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@kora/desktop/window/ShellWindow") {}

type RuntimeServices =
  | ShellContext.ShellContext
  | ShellAppPrefs.ShellAppPrefs
  | NativeMenu.NativeMenu
  | NativeShell.NativeShell
  | NativeTheme.NativeTheme
  | NativeWindow.NativeWindow
  | WebManager.WebManager;

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const appPrefs = yield* ShellAppPrefs.ShellAppPrefs;
  const nativeMenu = yield* NativeMenu.NativeMenu;
  const nativeShell = yield* NativeShell.NativeShell;
  const nativeTheme = yield* NativeTheme.NativeTheme;
  const nativeWindow = yield* NativeWindow.NativeWindow;
  const webManager = yield* WebManager.WebManager;
  const services = yield* Effect.context<RuntimeServices>();
  const runFork = Effect.runForkWith(services);
  const runSync = Effect.runSyncWith(services);

  const applicationUrl = getShellUrl(envVars.isDevelopment);
  const pickPreloadPath = envVars.path.join(envVars.dirname, "web-pick-preload.cjs");

  // Event handlers are synchronous Electron callbacks; each hands its work to a fiber and never throws.
  const fire = <Err>(effect: Effect.Effect<unknown, Err>) => {
    runFork(
      effect.pipe(
        Effect.catchCause((cause) => logWarning("window event handler failed", { cause })),
      ),
    );
  };
  const later = <Err>(delay: Duration.Duration, effect: Effect.Effect<unknown, Err>) =>
    runFork(
      Effect.sleep(delay).pipe(
        Effect.andThen(effect),
        Effect.catchCause((cause) => logWarning("delayed window task failed", { cause })),
      ),
    );

  const backgroundColor = Effect.map(nativeTheme.shouldUseDarkColors, (dark) =>
    dark ? BACKGROUND.dark : BACKGROUND.light,
  );

  let backendReady = false;
  let windowLoaded = false;
  let startupCleared = false;
  let splash: Electron.BrowserWindow | undefined;

  const checkStartupSucceeded = () => {
    if (windowLoaded && backendReady && !startupCleared) {
      startupCleared = true;
      try {
        const userData =
          typeof Electron.app?.getPath === "function" ? Electron.app.getPath("userData") : "";
        if (userData) {
          const recordPath = envVars.path.join(userData, LAUNCH_RECORD_FILE);
          clearLaunchRecord(recordPath).catch(() => undefined);
        }
      } catch {
        // best effort (e.g. in unit tests where Electron is stubbed)
      }
    }
  };

  const waitingForBackend = Effect.map(
    appPrefs.get,
    (prefsObj) => !backendReady && prefsObj.localHostEnabled,
  );

  // The splash is never the main window; lookups that fall back to "first window" must skip it.
  const notSplash = (located: Option.Option<Electron.BrowserWindow>) =>
    Option.filter(located, (win) => win !== splash);
  const realMain = Effect.map(nativeWindow.main, notSplash);
  const currentMain = Effect.map(nativeWindow.focusedOrMainWindow, notSplash);

  // --- traffic lights ------------------------------------------------------------------------------------------

  // The native buttons are 14pt tall and do not scale with page zoom, so they are re-centred in the (scaled) top bar.
  // macOS only: `setWindowButtonPosition` does not exist on Windows (its caption buttons are the title bar overlay).
  const placeTrafficLights = (win: Electron.BrowserWindow) => {
    if (envVars.platform !== "darwin" || win.isDestroyed() || win.isFullScreen()) return;
    const zoomLevel = win.webContents.getZoomFactor();
    win.setWindowButtonPosition({
      x: TRAFFIC_LIGHT_X,
      y: Math.round((TOPBAR_HEIGHT * zoomLevel) / 2 - TRAFFIC_LIGHT_SIZE / 2),
    });
  };

  // --- persisted geometry ----------------------------------------------------------------------------------------

  const writeLock = Semaphore.makeUnsafe(1);
  let boundsTimer: Fiber.Fiber<unknown, unknown> | undefined;
  const saves = new Set<Fiber.Fiber<unknown, unknown>>();
  let boundsWindow: Electron.BrowserWindow | undefined;
  let boundsWritable = true;

  const readBounds = (win: Electron.BrowserWindow) => {
    if (win.isDestroyed()) return null;
    const maximized = win.isMaximized();
    // Only a plain window reports its own rectangle; the others report where it would return to.
    const unparsed =
      maximized || win.isFullScreen() || win.isMinimized()
        ? win.getNormalBounds()
        : win.getBounds();
    const edges = ShellAppPrefs.normalizeMainWindowBounds({
      x: Math.round(unparsed.x),
      y: Math.round(unparsed.y),
      width: Math.round(unparsed.width),
      height: Math.round(unparsed.height),
    });
    return edges === null ? null : { bounds: edges, maximized };
  };

  const startSave = (win: Electron.BrowserWindow) => {
    if (!boundsWritable) return;
    const frameSnap = readBounds(win);
    if (frameSnap === null) return;
    const fiber: Fiber.Fiber<unknown, unknown> = runFork(
      writeLock
        .withPermits(1)(appPrefs.setMainWindowBounds(frameSnap.bounds, frameSnap.maximized))
        .pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to persist main window bounds", { cause }),
          ),
          Effect.ensuring(Effect.sync(() => saves.delete(fiber))),
        ),
    );
    saves.add(fiber);
  };

  const cancelBoundsTimer = () => {
    if (boundsTimer) runFork(Fiber.interrupt(boundsTimer));
    boundsTimer = undefined;
  };

  // The user changed the window: allow saving again and (re)start the quiet period.
  const scheduleBoundsSave = (win: Electron.BrowserWindow) => {
    boundsWritable = true;
    cancelBoundsTimer();
    boundsTimer = later(
      BOUNDS_DEBOUNCE,
      Effect.sync(() => {
        boundsTimer = undefined;
        startSave(win);
      }),
    );
  };

  const saveMainWindowPlace = Effect.gen(function* () {
    if (boundsTimer) {
      yield* Fiber.interrupt(boundsTimer);
      boundsTimer = undefined;
      if (boundsWindow) startSave(boundsWindow);
    }
    for (const fiber of [...saves]) yield* Fiber.await(fiber);
  });

  // --- context menus ---------------------------------------------------------------------------------------------

  const menuTemplate = (
    inner: Electron.WebContents,
    menuParams: Electron.ContextMenuParams,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    const separator = () => {
      if (template.length > 0 && template.at(-1)?.type !== "separator")
        template.push({ type: "separator" });
    };
    const ifAlive = (use: () => void) => () => {
      if (!inner.isDestroyed()) use();
    };

    if (menuParams.misspelledWord) {
      const suggestions = menuParams.dictionarySuggestions.slice(0, SPELLING_SUGGESTION_LIMIT);
      if (suggestions.length === 0) template.push({ label: "No suggestions", enabled: false });
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: ifAlive(() => inner.replaceMisspelling(suggestion)),
        });
      }
      separator();
    }
    if (Option.isSome(parseSafeExternalUrl(menuParams.linkURL))) {
      template.push({
        label: "Copy Link",
        click: () => fire(nativeShell.copyText(menuParams.linkURL)),
      });
      separator();
    }
    if (menuParams.mediaType === "image") {
      template.push({
        label: "Copy Image",
        click: ifAlive(() => inner.copyImageAt(menuParams.x, menuParams.y)),
      });
      separator();
    }
    const flags = menuParams.editFlags;
    template.push(
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { role: "selectAll", enabled: flags.canSelectAll },
    );
    return template;
  };

  const menuHooked = new WeakSet<object>();
  const hookContextMenu = (inner: Electron.WebContents, holder: Electron.BrowserWindow) => {
    if (menuHooked.has(inner)) return;
    menuHooked.add(inner);
    inner.on("context-menu", (evt, menuParams) => {
      evt.preventDefault();
      if (inner.isDestroyed()) return;
      inner.focus();
      fire(
        nativeMenu.popupTemplate({
          window: holder,
          template: menuTemplate(inner, menuParams),
          ...(menuParams.frame ? { frame: menuParams.frame } : {}),
        }),
      );
    });
  };

  // --- the main window -------------------------------------------------------------------------------------------

  const dismissConnectingSplash = Effect.sync(() => {
    const live = splash;
    splash = undefined;
    if (live && !live.isDestroyed()) live.close();
  });

  const createWindow = Effect.gen(function* () {
    // The default session has to exist before the first window uses it.
    yield* webManager.getBrowserSession();

    const prefsObj = yield* appPrefs.get;
    const lookup = yield* Effect.sync(() => {
      try {
        return { displays: Electron.screen.getAllDisplays().map((display) => display.bounds) };
      } catch (cause) {
        return { cause };
      }
    });
    if ("cause" in lookup) {
      yield* logWarning("failed to read connected displays; using defaults").pipe(
        Effect.annotateLogs({ cause: lookup.cause }),
      );
    }
    const displays: Rect[] = "displays" in lookup ? lookup.displays : [];
    const initial = resolveInitialMainWindowBounds(prefsObj.mainWindowBounds, displays);
    const restored = prefsObj.mainWindowBounds !== null && initial === prefsObj.mainWindowBounds;
    if (prefsObj.mainWindowBounds !== null && !restored) {
      yield* logWarning("saved main window bounds could not be restored; using defaults");
    }

    const background = yield* backgroundColor;
    const win = yield* nativeWindow.create({
      ...initial,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      autoHideMenuBar: true,
      disableAutoHideCursor: true,
      backgroundColor: background,
      title: envVars.displayName,
      ...mainWindowChrome(envVars.platform, background === BACKGROUND.dark),
      webPreferences: {
        webviewTag: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        // A hidden renderer is throttled and its first paint would stall; handed back after the first reveal.
        backgroundThrottling: false,
        preload: envVars.preloadPath,
      },
    });
    win.setAutoHideCursor(false);

    const inner = win.webContents;
    boundsWindow = win;
    // Saved bounds that could not be restored stay on disk until the user actually moves the window.
    boundsWritable = prefsObj.mainWindowBounds === null || restored;

    const sess = (inner as { session?: Electron.Session }).session;
    if (sess) installAppSessionPermissionPolicy(sess);

    yield* webManager.setMainWindow(win);
    inner.on("will-attach-webview", (evt, webPreferences, attachParams) => {
      const allowed = hardenWebviewAttach({
        webPreferences,
        params: attachParams,
        isBrowserPartition: (partName) => webManager.isBrowserPartition(partName),
        pickPreloadPath,
      });
      if (!allowed) evt.preventDefault();
    });

    hookContextMenu(inner, win);
    inner.on("did-attach-webview", (_evt, guest) => {
      hookContextMenu(guest, win);
      guest.on("did-create-window", (popup) => hookContextMenu(popup.webContents, popup));
    });

    inner.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(parseSafeExternalUrl(url))) fire(nativeShell.openExternal(url));
      return { action: "deny" };
    });
    inner.on("will-navigate", (evt, address) => {
      if (isSameOriginRendererNavigation({ applicationUrl, navigationUrl: address })) return;
      evt.preventDefault();
      if (Option.isSome(parseSafeExternalUrl(address))) fire(nativeShell.openExternal(address));
    });
    win.on("page-title-updated", (evt) => {
      evt.preventDefault();
      win.setTitle(envVars.displayName);
    });

    // Fullscreen: the web client hides its traffic-light gutter, and the buttons need re-placing on the way out.
    win.on("enter-full-screen", () => {
      inner.send(IPC_WINDOW_FULLSCREEN_STATE, true);
    });
    win.on("leave-full-screen", () => {
      placeTrafficLights(win);
      inner.send(IPC_WINDOW_FULLSCREEN_STATE, false);
    });

    // Geometry persistence.
    for (const evtName of ["resize", "move", "maximize", "unmaximize"] as const) {
      win.on(evtName as "resize", () => scheduleBoundsSave(win));
    }
    win.on("close", () => {
      cancelBoundsTimer();
      startSave(win);
    });

    // Loading, with retries for the failures a cold dev server or a racing protocol handler can cause.
    let retryIndex = 0;
    let retryFiber: Fiber.Fiber<unknown, unknown> | undefined;
    const load = () => {
      win.loadURL(applicationUrl).catch(() => undefined);
    };
    load();
    inner.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (
        !isRetryableDevelopmentRendererLoadFailure({
          validatedUrl: validatedURL,
          isMainFrame,
          errorCode,
          applicationUrl,
        })
      ) {
        return;
      }
      if (retryFiber) return; // one retry at a time
      const delayMs = LOAD_RETRY_DELAYS_MS[Math.min(retryIndex, LOAD_RETRY_DELAYS_MS.length - 1)]!;
      retryIndex += 1;
      fire(
        logWarning("main window failed to load", {
          errorCode,
          errorDescription,
          url: validatedURL,
          retryInMs: delayMs,
        }),
      );
      retryFiber = later(
        Duration.millis(delayMs),
        Effect.sync(() => {
          retryFiber = undefined;
          if (!win.isDestroyed()) load();
        }),
      );
    });
    inner.on("did-finish-load", () => {
      // The dev server may finish loading its own error page; only a load of the app itself counts.
      if (!isSameOriginRendererNavigation({ applicationUrl, navigationUrl: inner.getURL() }))
        return;
      retryIndex = 0;
      if (retryFiber) {
        runFork(Fiber.interrupt(retryFiber));
        retryFiber = undefined;
      }
      win.setTitle(envVars.displayName);
      placeTrafficLights(win);
      windowLoaded = true;
      checkStartupSucceeded();
    });

    inner.on("console-message", (detailInfo) => {
      fire(
        logInfo("renderer console message", {
          level: detailInfo.level,
          message: detailInfo.message,
          sourceId: detailInfo.sourceId,
          line: detailInfo.lineNumber,
        }),
      );
    });

    // A renderer that dies (crash, out of memory) is reloaded, but never in a tight loop.
    const recoveries: number[] = [];
    inner.on("render-process-gone", (_evt, detailInfo) => {
      if (!["crashed", "oom", "abnormal-exit"].includes(detailInfo.reason)) return;
      const clock = Date.now();
      while (recoveries.length > 0 && clock - recoveries[0]! > CRASH_RECOVERY_WINDOW_MS)
        recoveries.shift();
      const recovering = recoveries.length < CRASH_RECOVERIES_PER_WINDOW;
      if (recovering) recoveries.push(clock);
      fire(
        logWarning("main window render process gone", {
          reason: detailInfo.reason,
          exitCode: detailInfo.exitCode,
          recovering,
        }),
      );
      if (recovering) {
        later(
          CRASH_RELOAD_DELAY,
          Effect.sync(() => {
            if (!win.isDestroyed()) load();
          }),
        );
      } else {
        if (!win.isDestroyed()) {
          const isDark = runSync(nativeTheme.shouldUseDarkColors);
          const bg = isDark ? BACKGROUND.dark : BACKGROUND.light;
          const fg = isDark ? "#f2f2f4" : "#111113";
          const muted = isDark ? SPLASH_LABEL_COLOR.dark : SPLASH_LABEL_COLOR.light;
          win
            .loadURL(
              `data:text/html;charset=utf-8,${encodeURIComponent(
                renderCrashRecoveryHtml(bg, fg, muted, applicationUrl),
              )}`,
            )
            .catch(() => undefined);
        }
      }
    });

    // First reveal: back to normal throttling, restore maximize, show, then retire the splash.
    let revealed = false;
    win.once("ready-to-show", () => {
      if (revealed) return;
      revealed = true;
      inner.setBackgroundThrottling(true);
      if (prefsObj.mainWindowMaximized) win.maximize();
      fire(nativeWindow.reveal(win).pipe(Effect.andThen(dismissConnectingSplash)));
    });

    if (envVars.isDevelopment) inner.openDevTools({ mode: "detach" });

    win.on("closed", () => {
      cancelBoundsTimer();
      if (retryFiber) runFork(Fiber.interrupt(retryFiber));
      retryFiber = undefined;
      if (boundsWindow === win) boundsWindow = undefined;
      fire(nativeWindow.clearMain(Option.some(win)));
    });

    return win;
  }).pipe(Effect.withSpan("shell.window.createMain"));

  const createMain = Effect.gen(function* () {
    const win = yield* createWindow;
    yield* nativeWindow.setMain(win);
    yield* logInfo("main window created");
    return win;
  });

  const ensureMain = Effect.gen(function* () {
    const mainWindow = yield* realMain;
    return Option.isSome(mainWindow) ? mainWindow.value : yield* createMain;
  });

  const revealOrCreateMain = Effect.gen(function* () {
    const win = yield* ensureMain;
    yield* nativeWindow.reveal(win);
    return win;
  });

  const openMainWhenDaemonReady = Effect.gen(function* () {
    if (yield* waitingForBackend) return;
    if (Option.isSome(yield* realMain)) return;
    yield* createMain;
  });

  const activate = Effect.gen(function* () {
    const mainWindow = yield* realMain;
    if (Option.isSome(mainWindow)) {
      yield* nativeWindow.reveal(mainWindow.value);
    } else if (!backendReady && splash && !splash.isDestroyed()) {
      yield* nativeWindow.reveal(splash);
    } else {
      yield* openMainWhenDaemonReady;
    }
  });

  const showStartupSplash = Effect.gen(function* () {
    if (splash || Option.isSome(yield* nativeWindow.mainOrAnyWindow)) return;
    const dark = yield* nativeTheme.shouldUseDarkColors;
    const created = yield* nativeWindow.create({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      title: envVars.displayName,
      backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
      show: false,
      center: true,
      frame: false,
      maximizable: false,
      fullscreenable: false,
      resizable: false,
      minimizable: false,
      width: 360,
      height: 220,
    });
    splash = created;
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      if (splash === created) splash = undefined;
    });
    created
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(splashDocument(dark, envVars.displayName))}`,
      )
      .catch(() => undefined);
    yield* logInfo("connecting splash shown");
  }).pipe(Effect.catchCause((cause) => logWarning("failed to show connecting splash", { cause })));

  const setSplashMessage = (message: string) =>
    Effect.promise(async () => {
      const w = splash;
      if (!w || w.isDestroyed()) return;
      await w.webContents
        .executeJavaScript(
          `(() => { const d = document.querySelector("body > div"); if (d) d.textContent = decodeURIComponent("${encodeURIComponent(message)}"); })()`,
        )
        .catch(() => undefined);
    }).pipe(Effect.catchCause(() => Effect.void));

  const sendMenuAction = (actionName: string, opts?: { readonly reveal?: boolean }) =>
    Effect.gen(function* () {
      const reveal = opts?.reveal ?? true;
      let dest: Option.Option<Electron.BrowserWindow>;
      if (reveal) {
        dest = yield* currentMain;
        if (Option.isNone(dest)) {
          if (yield* waitingForBackend) return;
          dest = Option.some(yield* ensureMain);
        }
      } else {
        dest = yield* realMain;
      }
      if (Option.isNone(dest)) return;
      const win = dest.value;
      const send = () => {
        if (!win.isDestroyed()) win.webContents.send(IPC_MENU_ACTION, actionName);
      };
      if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", send);
      else send();
      // Sent first: even if the OS refuses to give up the foreground, the renderer still hears about it.
      if (reveal) yield* nativeWindow.reveal(win).pipe(Effect.catchCause(() => Effect.void));
    });

  const zoomMain = (dir: MainWindowZoomDirection) =>
    Effect.gen(function* () {
      const dest = yield* currentMain;
      if (Option.isNone(dest) || dest.value.isDestroyed()) return;
      const win = dest.value;
      const level =
        dir === "reset"
          ? 0
          : win.webContents.getZoomLevel() + (dir === "in" ? ZOOM_STEP : -ZOOM_STEP);
      win.webContents.setZoomLevel(level);
      placeTrafficLights(win);
      // Chromium pushes the new level into embedded guests; the preview browser keeps its own zoom.
      yield* webManager.reapplyZoom();
    });

  const syncAppearance = Effect.gen(function* () {
    const hue = yield* backgroundColor;
    yield* nativeWindow.syncAllAppearance((win) =>
      Effect.sync(() => {
        if (!win.isDestroyed()) win.setBackgroundColor(hue);
      }),
    );
  });

  return ShellWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    activate,
    openMainWhenDaemonReady,
    showStartupSplash,
    setSplashMessage,
    handleBackendReady: (httpOrigin) =>
      Effect.gen(function* () {
        backendReady = true;
        yield* logInfo("backend ready", { source: "http", url: httpOrigin.href });
        yield* openMainWhenDaemonReady;
        checkStartupSucceeded();
      }),
    handleBackendNotReady: Effect.sync(() => {
      backendReady = false;
    }),
    saveMainWindowPlace,
    sendMenuAction,
    zoomMain,
    syncAppearance,
  });
});

export const layer = Layer.effect(ShellWindow, make);

// @effect-diagnostics globalDate:off globalDateInEffect:off -- timestamps are stamped inside synchronous Electron callbacks.
// The desktop side of the in-app browser. The <webview> elements live in the renderer; this module keeps one state
// record per preview tab, listens to each tab's guest WebContents, and implements navigation, zoom, mute, colour
// scheme emulation, devtools, element picking, screenshots, the picture-in-picture popout, tab recording and
// favicons. Browser sessions come from WebPartitions.
import * as Electron from "electron";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import { normalizeWebUrl } from "@kora/shared/webUrl";
import { MachinePlatform } from "@kora/shared/hostMachine";
import {
  type WebMarkupSubmissionResult,
  type WebMarkupSubmission,
  type ShellWebTabState,
  type ShellWebTabDefaults,
  type ShellWebScreenshotArtifact,
  type ShellWebScreencastFrame,
  type ShellWebScreencastArtifact,
  type ShellWebPointerEvent,
  type ShellWebNavStatus,
  type ShellWebMarkupTheme,
  type ShellWebFavicon,
  type ShellWebColorScheme,
  SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER,
} from "@kora/contracts";

import * as WebPartitions from "./WebPartitions.ts";
import { isWebTabNavigationUrl, popupOriginTitle } from "./WebNavigationPolicy.ts";
import { isWebMarkupPayload } from "./PickedNodePayload.ts";
import {
  IPC_START_PICK,
  IPC_MOUSE_NAVIGATE,
  IPC_MARKUP_THEME,
  IPC_MARKUP_CAPTURED,
  IPC_HUMAN_INPUT,
  IPC_ELEMENT_PICKED,
  IPC_CANCEL_PICK,
} from "./GuestProtocol.ts";
import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from "./FaviconCapture.ts";
import { IPC_WEB_POPOUT_FRAME } from "../ipc/channelNames.ts";
import * as ShellTracing from "../app/ShellTracing.ts";
import * as ShellContext from "../app/ShellContext.ts";

const { logWarning } = ShellTracing.makeScopedLogger("desktop-web");

// ---------------------------------------------------------------------------------------------------------------
// Public types

export type WebNavStatus = ShellWebNavStatus;

export interface WebTabState {
  readonly tabId: string;
  readonly webContentsId: number | null;
  readonly navStatus: WebNavStatus;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** The tab's own zoom. Never read back from the guest, which reports the app window's inherited zoom. */
  readonly zoomFactor: number;
  readonly pictureInPicture: boolean;
  readonly colorScheme: ShellWebColorScheme;
  /** What the user asked for; re-applied to every guest that attaches. */
  readonly audioMuted: boolean;
  /** What Chromium reports; stays true while a muted tab plays. */
  readonly audible: boolean;
  readonly controller: "human" | "agent" | "none";
  readonly favicon?: ShellWebFavicon;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

export class WebTabNotFoundError extends Schema.TaggedError<WebTabNotFoundError>()(
  "WebTabNotFoundError",
  { tabId: Schema.String },
) {
  override get message() {
    return `Preview tab not found: ${this.tabId}`;
  }
}

export class WebContentsNotFoundError extends Schema.TaggedError<WebContentsNotFoundError>()(
  "WebContentsNotFoundError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message() {
    return `WebContents ${this.webContentsId} not found for preview tab ${this.tabId}`;
  }
}

export class WebviewNotInitializedError extends Schema.TaggedError<WebviewNotInitializedError>()(
  "WebviewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message() {
    return `Preview tab "${this.tabId}" has no webview registered`;
  }
}

export class WebMainWindowClosedError extends Schema.TaggedError<WebMainWindowClosedError>()(
  "WebMainWindowClosedError",
  { tabId: Schema.String },
) {
  override get message() {
    return `Cannot start preview frame capture while the main window is closed: ${this.tabId}`;
  }
}

export class WebScreencastArmConflictError extends Schema.TaggedError<WebScreencastArmConflictError>()(
  "WebScreencastArmConflictError",
  { tabId: Schema.String, webContentsId: Schema.Number, armedTabId: Schema.String },
) {
  override get message() {
    return `Preview tab ${this.armedTabId} is still claiming the capture stream, so recording could not start for tab ${this.tabId}`;
  }
}

export class WebScreencastCaptureUnavailableError extends Schema.TaggedError<WebScreencastCaptureUnavailableError>()(
  "WebScreencastCaptureUnavailableError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message() {
    return `Preview recording capture is unavailable for tab ${this.tabId} in WebContents ${this.webContentsId}`;
  }
}

export class WebOperationError extends Schema.TaggedError<WebOperationError>()(
  "WebOperationError",
  {
    operation: Schema.String,
    tabId: Schema.optionalKey(Schema.String),
    webContentsId: Schema.optionalKey(Schema.Number),
    artifactPath: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const detailInfo = [
      this.tabId === undefined ? null : `tab ${this.tabId}`,
      this.webContentsId === undefined ? null : `WebContents ${this.webContentsId}`,
      this.artifactPath === undefined ? null : `artifact ${this.artifactPath}`,
    ].filter((fragment) => fragment !== null);
    return `Desktop preview operation failed: ${this.operation}${detailInfo.length === 0 ? "" : ` (${detailInfo.join(", ")})`}`;
  }

  /** The underlying failure's own words, kept out of `message` on purpose. */
  static toTimelineMessage(err: WebOperationError): string {
    return err.cause instanceof Error ? err.cause.message : String(err.cause);
  }
}

export class WebArtifactPathOutsideDirectoryError extends Schema.TaggedError<WebArtifactPathOutsideDirectoryError>()(
  "WebArtifactPathOutsideDirectoryError",
  { artifactPath: Schema.String, artifactDirectory: Schema.String },
) {
  override get message() {
    return `Preview artifact path ${this.artifactPath} is outside ${this.artifactDirectory}`;
  }
}

export class WebArtifactImageLoadError extends Schema.TaggedError<WebArtifactImageLoadError>()(
  "WebArtifactImageLoadError",
  { artifactPath: Schema.String },
) {
  override get message() {
    return `Preview artifact could not be loaded as an image: ${this.artifactPath}`;
  }
}

export const WebManagerError = Schema.Union([
  WebTabNotFoundError,
  WebContentsNotFoundError,
  WebviewNotInitializedError,
  WebMainWindowClosedError,
  WebScreencastArmConflictError,
  WebScreencastCaptureUnavailableError,
  WebOperationError,
  WebArtifactPathOutsideDirectoryError,
  WebArtifactImageLoadError,
]);
export type WebManagerError = typeof WebManagerError.Type;

// ---------------------------------------------------------------------------------------------------------------
// Constants

const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
] as const;
const DEFAULT_ZOOM = 1.0;
const ZOOM_EPSILON = 0.001;

const POPOUT_DEFAULT_SIZE = [480, 320] as const;
const POPOUT_MIN_SIZE = [240, 160] as const;
const POPOUT_FRAME_INTERVAL = Duration.millis(Math.ceil(1000 / 12));
const POPOUT_JPEG_QUALITY = 80;
const POPOUT_RATIO_EPSILON = 0.002;

const ARM_GRACE = Duration.seconds(10);
const CAPTURE_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY = Duration.millis(120);
const CAPTURE_ATTEMPT_TIMEOUT = Duration.seconds(1);
const MARKUP_SCREENSHOT_TIMEOUT = Duration.seconds(5);
const HUMAN_CONTROL_HOLD = Duration.millis(750);
const SITE_SLUG_MAX = 80;

const DEFAULT_MARKUP_THEME: ShellWebMarkupTheme = {
  fontMono: "ui-monospace, monospace",
  fontSans: "system-ui, sans-serif",
  ring: "oklch(0.488 0.217 264)",
  input: "rgb(0 0 0 / 10%)",
  border: "rgb(0 0 0 / 8%)",
  accentForeground: "oklch(0.269 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  muted: "rgb(0 0 0 / 4%)",
  primaryForeground: "white",
  primary: "oklch(0.488 0.217 264)",
  popoverForeground: "oklch(0.269 0 0)",
  popover: "white",
  foreground: "oklch(0.269 0 0)",
  background: "white",
  radius: "0.625rem",
  colorScheme: "light",
};

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

/** Keep the popout's visible area when only its aspect ratio changes, but never below the minimum size. */
export const fitPopoutContentSize = (
  live: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const wd = Math.max(1, live[0] ?? POPOUT_DEFAULT_SIZE[0]);
  const ht = Math.max(1, live[1] ?? POPOUT_DEFAULT_SIZE[1]);
  let nextWidth = Math.sqrt(wd * ht * aspectRatio);
  let nextHeight = nextWidth / aspectRatio;
  const grow = Math.max(1, POPOUT_MIN_SIZE[0] / nextWidth, POPOUT_MIN_SIZE[1] / nextHeight);
  nextWidth *= grow;
  nextHeight *= grow;
  return [Math.round(nextWidth), Math.round(nextHeight)];
};

/** File extension for a recorder's mime type, from its real subtype (`video/x-matroska;codecs=…` -> `matroska`). */
export const screencastFileExtension = (mediaType: string): string => {
  const subtype = (mediaType.split(";")[0] ?? "").trim().toLowerCase().split("/")[1] ?? "";
  const cleaned = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return cleaned === "" ? "video" : cleaned;
};

/**
 * A scripted popup (an OAuth window) gets a real window so `window.open()` returns something and the opener stays
 * alive to receive the result. Everything else loads in the preview tab itself.
 */
export const webWindowOpenAction = (detailInfo: {
  readonly url: string;
  readonly disposition: Electron.HandlerDetails["disposition"];
}): "popup" | "navigate" => {
  if (detailInfo.disposition !== "new-window") return "navigate";
  try {
    const { protocol } = new URL(detailInfo.url);
    return protocol === "http:" || protocol === "https:" ? "popup" : "navigate";
  } catch {
    return "navigate";
  }
};

/** Native editing chords (undo, redo, cut, copy, paste, select all) with the platform's primary modifier alone. */
export const isWebEditingShortcut = (
  keyEvent: Electron.Input,
  hostOs: NodeJS.Platform,
): boolean => {
  const mac = hostOs === "darwin";
  const primary = mac ? keyEvent.meta && !keyEvent.control : keyEvent.control && !keyEvent.meta;
  if (!primary) return false;
  const keyName = keyEvent.key.toLowerCase();
  if (keyEvent.alt) {
    // Paste and Match Style on macOS: Option turns the key into a symbol, so the physical key is used as well.
    return mac && keyEvent.shift && (keyName === "v" || keyEvent.code === "KeyV");
  }
  if (keyEvent.shift) {
    if (keyName === "v") return !mac; // elsewhere shift+v is paste-and-match; on macOS it needs Option
    if (keyName === "z") return hostOs !== "win32"; // redo, except on Windows where it is ctrl+y
    return false;
  }
  if (keyName === "y") return hostOs === "win32";
  return (
    keyName === "a" || keyName === "c" || keyName === "v" || keyName === "x" || keyName === "z"
  );
};

const nearestZoomStep = (val: number | undefined): number => {
  if (val === undefined || !Number.isFinite(val)) return DEFAULT_ZOOM;
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - val) < Math.abs(best - val) ? step : best,
  );
};

/** Index of the largest ladder step that is not above `zoom`. */
const zoomStepIndex = (zoomLevel: number): number => {
  let pos = 0;
  for (let idx = 0; idx < ZOOM_STEPS.length; idx += 1)
    if (ZOOM_STEPS[idx]! <= zoomLevel + ZOOM_EPSILON) pos = idx;
  return pos;
};

const siteSlug = (address: string): string => {
  try {
    const lowered = new URL(address).hostname.toLowerCase();
    const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
    const idSlug = dashed.replace(/^-+|-+$/g, "").slice(0, SITE_SLUG_MAX);
    return idSlug === "" ? "site" : idSlug;
  } catch {
    return "site";
  }
};

const isoNow = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------------
// Service

type StateListener = (tabKey: string, tabState: WebTabState) => Effect.Effect<void>;
type PointerListener = (evt: ShellWebPointerEvent) => Effect.Effect<void>;
type FrameListener = (fr: ShellWebScreencastFrame) => Effect.Effect<void>;

export class WebManager extends Context.Service<
  WebManager,
  {
    readonly setMainWindow: (win: Electron.BrowserWindow) => Effect.Effect<void, WebManagerError>;
    readonly getBrowserSession: (
      scope?: string,
      durable?: boolean,
      nsName?: WebPartitions.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Electron.Session, WebManagerError>;
    readonly isBrowserPartition: (partName: string) => boolean;
    readonly getBrowserPartition: (
      scope?: string,
      durable?: boolean,
      nsName?: WebPartitions.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, WebManagerError>;
    readonly createTab: (
      tabKey: string,
      baseline?: ShellWebTabDefaults,
    ) => Effect.Effect<WebTabState, WebManagerError>;
    readonly closeTab: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly registerWebview: (
      tabKey: string,
      webContentsId: number,
    ) => Effect.Effect<void, WebManagerError>;
    readonly navigate: (tabKey: string, address: string) => Effect.Effect<void, WebManagerError>;
    readonly goBack: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly goForward: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly refresh: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly hardReload: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly zoomIn: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly zoomOut: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly resetZoom: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    /** Put every tab back at its own zoom after the app window's zoom was pushed onto the guests. */
    readonly reapplyZoom: () => Effect.Effect<void>;
    readonly setColorScheme: (
      tabKey: string,
      colorScheme: ShellWebColorScheme,
    ) => Effect.Effect<void, WebManagerError>;
    readonly setAudioMuted: (
      tabKey: string,
      audioMuted: boolean,
    ) => Effect.Effect<void, WebManagerError>;
    readonly openDevTools: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly clearCookies: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, WebManagerError>;
    readonly clearCache: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, WebManagerError>;
    readonly setMarkupTheme: (palette: ShellWebMarkupTheme) => Effect.Effect<void, WebManagerError>;
    readonly pickElement: (
      tabKey: string,
    ) => Effect.Effect<WebMarkupSubmissionResult | null, WebManagerError>;
    readonly cancelPickElement: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly captureScreenshot: (
      tabKey: string,
    ) => Effect.Effect<ShellWebScreenshotArtifact, WebManagerError>;
    readonly revealArtifact: (loc: string) => Effect.Effect<void, WebManagerError>;
    readonly copyArtifactToClipboard: (loc: string) => Effect.Effect<void, WebManagerError>;
    readonly openPopout: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly closePopout: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly beginScreencast: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly endScreencast: (tabKey: string) => Effect.Effect<void, WebManagerError>;
    readonly saveScreencast: (
      tabKey: string,
      mediaType: string,
      blob: Uint8Array,
    ) => Effect.Effect<ShellWebScreencastArtifact, WebManagerError>;
    readonly subscribeStateChanges: (
      subscriber: StateListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      subscriber: PointerListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingFrames: (
      subscriber: FrameListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/web/Manager/WebManager") {}

// ---------------------------------------------------------------------------------------------------------------
// Internal records

type Consumer = "picture-in-picture" | "recording";

interface Attachment {
  readonly contents: Electron.WebContents;
  readonly cleanups: Array<() => void>;
  /** Bumped by each main-frame document change, so late favicon captures can tell they are stale. */
  documentGeneration: number;
  favicon: {
    key: string | null;
    requestId: number;
    abort: AbortController | null;
    settled: "pending" | "published" | "failed";
  };
  control: { readonly debuggerRef: Electron.Debugger } | null;
}

interface PickSession {
  readonly id: number;
  readonly settle: (result: WebMarkupSubmissionResult | null) => void;
  settled: boolean;
  cleanup: () => void;
}

interface Popout {
  readonly window: Electron.BrowserWindow;
  readonly attachment: Attachment;
  readonly ready: Deferred.Deferred<void, WebManagerError>;
  readonly closed: Deferred.Deferred<void>;
  status: "initializing" | "ready" | "closed";
  windowGone: boolean;
  closeRequested: boolean;
  ratio: number | null;
  lastFrame: Buffer | null;
  loop: Fiber.Fiber<unknown, unknown> | null;
  detach: () => void;
}

interface Tab {
  readonly id: string;
  readonly generation: number;
  state: WebTabState;
  closing: boolean;
  attachment: Attachment | null;
  /** The URL of a navigation requested before (or while) the guest was attached. */
  pendingUrl: string | null;
  controlEpoch: number;
  pick: PickSession | null;
  popout: Popout | null;
  consumers: Set<Consumer>;
  /** Guests whose background throttling this tab turned off. */
  unthrottled: Set<Electron.WebContents>;
}

interface MainWindowRecord {
  readonly window: Electron.BrowserWindow;
  closed: boolean;
}

interface Arm {
  readonly tabId: string;
  readonly contents: Electron.WebContents;
  readonly hostFrameTreeNodeId: number | undefined;
  expiry: Fiber.Fiber<unknown, unknown> | null;
}

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const partitions = yield* WebPartitions.WebPartitions;
  const fsys = yield* FileSystem.FileSystem;
  const loc = yield* Path.Path;
  const hostOs = yield* MachinePlatform;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);

  const tabs = new Map<string, Tab>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const closingTabs = new Set<string>();
  const generations = new Map<string, number>();
  const background = new Set<Fiber.Fiber<unknown, unknown>>();

  const stateListeners = new Set<StateListener>();
  const pointerListeners = new Set<PointerListener>();
  const frameListeners = new Set<FrameListener>();

  let markupTheme: ShellWebMarkupTheme = DEFAULT_MARKUP_THEME;
  let mainWindow: MainWindowRecord | null = null;
  let arm: Arm | null = null;
  const displayMediaHosts = new WeakSet<object>();
  /** Tabs with any frame-capture consumer; the main window stays unthrottled while this is not empty. */
  const captureTabs = new Set<string>();

  // --- plumbing --------------------------------------------------------------------------------------------------

  const lockFor = (tabKey: string) => {
    let lock = locks.get(tabKey);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(tabKey, lock);
    }
    return lock;
  };

  /** Run an effect on its own fiber that is interrupted with the layer. */
  const spawn = <Ok, Err>(effect: Effect.Effect<Ok, Err>) => {
    const fiber: Fiber.Fiber<unknown, unknown> = runFork(
      effect.pipe(
        Effect.catchCause((reason) =>
          Cause.hasInterrupts(reason)
            ? Effect.void
            : logWarning("preview background task failed", { cause: reason }),
        ),
        Effect.ensuring(Effect.sync(() => background.delete(fiber))),
      ),
    );
    background.add(fiber);
    return fiber;
  };

  const fire = <Err>(effect: Effect.Effect<unknown, Err>) => {
    spawn(effect);
  };

  const attempt = <Ok>(
    operation1: string,
    exec: () => Ok,
    more: { tabId?: string; webContentsId?: number; artifactPath?: string } = {},
  ): Effect.Effect<Ok, WebOperationError> =>
    Effect.try({
      try: exec,
      catch: (reason) => new WebOperationError({ operation: operation1, ...more, cause: reason }),
    });

  const attemptPromise = <Ok>(
    operation1: string,
    exec: () => Promise<Ok>,
    more: { tabId?: string; webContentsId?: number; artifactPath?: string } = {},
  ): Effect.Effect<Ok, WebOperationError> =>
    Effect.tryPromise({
      try: exec,
      catch: (reason) => new WebOperationError({ operation: operation1, ...more, cause: reason }),
    });

  /** Deliver to listeners one by one; a failing listener is logged and skipped, an interruption propagates. */
  const deliver = <L>(
    bag: Set<L>,
    invocation: (subscriber: L) => Effect.Effect<void>,
    stillWanted: () => boolean = () => true,
  ) =>
    Effect.forEach(
      [...bag],
      (subscriber) =>
        Effect.suspend(() => (stillWanted() ? invocation(subscriber) : Effect.void)).pipe(
          Effect.catchCause((reason) =>
            Cause.hasInterrupts(reason)
              ? Effect.failCause(reason)
              : Effect.logWarning("Desktop preview event listener failed.", { cause: reason }).pipe(
                  Effect.annotateLogs({ component: "desktop-web" }),
                ),
          ),
        ),
      { discard: true },
    );

  const emit = (pane: Tab, frameSnap: WebTabState = pane.state) =>
    deliver(
      stateListeners,
      (subscriber) => subscriber(pane.id, frameSnap),
      // A newer commit has superseded this snapshot: stop delivering stale state.
      () => pane.state === frameSnap,
    );

  /** Replace the tab's state with a patched copy and tell subscribers. */
  const delta = (
    pane: Tab,
    changes: Partial<Omit<WebTabState, "favicon">> & { favicon?: ShellWebFavicon | null },
  ) => {
    const { favicon: nextFavicon, ...rest } = changes;
    const { favicon: currentFavicon, ...base } = pane.state;
    const combined = { ...base, ...rest, updatedAt: isoNow() } as WebTabState;
    const favImage = nextFavicon === undefined ? currentFavicon : nextFavicon;
    pane.state =
      favImage === undefined || favImage === null ? combined : { ...combined, favicon: favImage };
    return emit(pane, pane.state);
  };

  const newState = (tabKey: string, baseline?: ShellWebTabDefaults): WebTabState => ({
    controller: "none",
    audible: false,
    audioMuted: false,
    updatedAt: isoNow(),
    colorScheme: baseline?.colorScheme ?? "system",
    pictureInPicture: false,
    zoomFactor: nearestZoomStep(baseline?.zoomFactor),
    canGoForward: false,
    canGoBack: false,
    navStatus: { kind: "Idle" },
    webContentsId: null,
    tabId: tabKey,
  });

  const makeTab = (tabKey: string, baseline?: ShellWebTabDefaults): Tab => {
    const generation = (generations.get(tabKey) ?? 0) + 1;
    generations.set(tabKey, generation);
    const pane: Tab = {
      id: tabKey,
      generation,
      state: newState(tabKey, baseline),
      closing: false,
      attachment: null,
      pendingUrl: null,
      controlEpoch: 0,
      pick: null,
      popout: null,
      consumers: new Set(),
      unthrottled: new Set(),
    };
    tabs.set(tabKey, pane);
    return pane;
  };

  const requireTab = (tabKey: string): Effect.Effect<Tab, WebTabNotFoundError> =>
    Effect.suspend(() => {
      const pane = tabs.get(tabKey);
      return pane && !pane.closing && !closingTabs.has(tabKey)
        ? Effect.succeed(pane)
        : Effect.fail(new WebTabNotFoundError({ tabId: tabKey }));
    });

  const requireAttached = (tabKey: string) =>
    Effect.gen(function* () {
      const pane = yield* requireTab(tabKey);
      if (!pane.attachment) return yield* new WebviewNotInitializedError({ tabId: tabKey });
      if (pane.attachment.contents.isDestroyed()) {
        return yield* new WebContentsNotFoundError({
          tabId: tabKey,
          webContentsId: pane.attachment.contents.id,
        });
      }
      return { tab: pane, attachment: pane.attachment, contents: pane.attachment.contents };
    });

  const sendToGuest = (inner: Electron.WebContents, chan: string, ...argv: unknown[]) => {
    try {
      inner.send(chan, ...argv);
    } catch {
      // A dying guest is not an error here.
    }
  };

  // --- guest attachment ------------------------------------------------------------------------------------------

  const runCleanups = (attachedItem: Attachment) => {
    for (const cleanup of attachedItem.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // The guest may already be destroyed.
      }
    }
  };

  const syncNav = (pane: Tab, attachedItem: Attachment, opts: { keepFailure: boolean }) => {
    if (pane.attachment !== attachedItem) return Effect.void;
    const { contents } = attachedItem;
    if (contents.isDestroyed()) return Effect.void;
    let navStatus: WebNavStatus;
    if (opts.keepFailure && pane.state.navStatus.kind === "LoadFailed") {
      navStatus = pane.state.navStatus;
    } else {
      const address = contents.getURL();
      if (address === "" || address === "about:blank") navStatus = { kind: "Idle" };
      else if (contents.isLoading())
        navStatus = { kind: "Loading", url: address, title: contents.getTitle() };
      else navStatus = { kind: "Success", url: address, title: contents.getTitle() };
    }
    if (navStatus.kind === "Success" || navStatus.kind === "Idle") {
      if (!opts.keepFailure || navStatus.kind !== "Idle") pane.pendingUrl = null;
    }
    const canGoBack = contents.navigationHistory.canGoBack();
    const canGoForward = contents.navigationHistory.canGoForward();
    const live = pane.state;
    if (
      JSON.stringify(live.navStatus) === JSON.stringify(navStatus) &&
      live.canGoBack === canGoBack &&
      live.canGoForward === canGoForward
    ) {
      return Effect.void;
    }
    return delta(pane, { navStatus, canGoBack, canGoForward });
  };

  const clearFaviconIfOriginChanged = (pane: Tab, attachedItem: Attachment) => {
    const favImage = pane.state.favicon;
    if (!favImage || pane.attachment !== attachedItem) return Effect.void;
    const originUrl = safeHttpOrigin(attachedItem.contents.getURL());
    return originUrl === favImage.pageUrl ? Effect.void : delta(pane, { favicon: null });
  };

  const cancelFavicon = (attachedItem: Attachment) => {
    attachedItem.favicon.abort?.abort();
    attachedItem.favicon.abort = null;
    attachedItem.favicon.requestId += 1;
    attachedItem.favicon.key = null;
    attachedItem.favicon.settled = "failed";
  };

  const handleFaviconUpdate = (pane: Tab, attachedItem: Attachment, rawCandidates: unknown) => {
    const { contents } = attachedItem;
    if (pane.attachment !== attachedItem || contents.isDestroyed()) return;
    const pageUrl = contents.getURL();
    const pageOrigin = safeHttpOrigin(pageUrl);
    if (pageOrigin === null || !Array.isArray(rawCandidates)) return;
    const candidates = selectFaviconCandidates(
      rawCandidates.filter((ch): ch is string => typeof ch === "string"),
    );
    if (candidates.length === 0) return;
    const keyName = `${pageUrl}\n${candidates.join("\n")}`;
    const capture = attachedItem.favicon;
    // The same event again is the same request (still running, or already done); a failed one may be retried.
    if (capture.key === keyName && capture.settled !== "failed") return;

    capture.abort?.abort();
    const controller = new AbortController();
    capture.abort = controller;
    capture.key = keyName;
    capture.settled = "pending";
    capture.requestId += 1;
    const reqKey = capture.requestId;
    const generation = attachedItem.documentGeneration;

    fire(
      Effect.promise(() =>
        captureFavicon({ webContents: contents, pageUrl, candidates, signal: controller.signal }),
      ).pipe(
        Effect.flatMap((outcome) => {
          const live =
            pane.attachment === attachedItem &&
            attachedItem.favicon.requestId === reqKey &&
            attachedItem.documentGeneration === generation;
          if (!live) return Effect.void;
          if (outcome.kind !== "captured") {
            attachedItem.favicon.settled = "failed";
            return Effect.void;
          }
          if (contents.isDestroyed() || safeHttpOrigin(contents.getURL()) !== pageOrigin) {
            attachedItem.favicon.settled = "failed";
            return Effect.void;
          }
          attachedItem.favicon.settled = "published";
          return delta(pane, {
            favicon: { dataUrl: outcome.dataUrl, pageUrl: pageOrigin, capturedAt: Date.now() },
          });
        }),
      ),
    );
  };

  // Human input: shown as the controller for a moment, then released.
  const markHumanControl = (pane: Tab) => {
    pane.controlEpoch += 1;
    const epoch = pane.controlEpoch;
    fire(
      delta(pane, { controller: "human" }).pipe(
        Effect.andThen(Effect.sleep(HUMAN_CONTROL_HOLD)),
        Effect.andThen(
          Effect.suspend(() =>
            pane.controlEpoch === epoch &&
            pane.state.controller === "human" &&
            tabs.get(pane.id) === pane
              ? delta(pane, { controller: "none" })
              : Effect.void,
          ),
        ),
      ),
    );
  };

  const navigateHistory = (pane: Tab, attachedItem: Attachment, dir: unknown) => {
    if (pane.attachment !== attachedItem || attachedItem.contents.isDestroyed()) return;
    const history = attachedItem.contents.navigationHistory;
    if (dir === "back" && history.canGoBack()) history.goBack();
    else if (dir === "forward" && history.canGoForward()) history.goForward();
  };

  const hardenPopup = (popup: Electron.WebContents) => {
    popup.setIgnoreMenuShortcuts(true);
    // One popup is all a sign-in flow needs: anything it opens is refused.
    popup.setWindowOpenHandler(() => ({ action: "deny" }));
    popup.on("before-input-event", (_evt, keyEvent) => {
      if (keyEvent.type !== "keyDown") return;
      popup.setIgnoreMenuShortcuts(
        !(
          isWebEditingShortcut(keyEvent, hostOs) &&
          Electron.webContents.getFocusedWebContents() === popup
        ),
      );
    });
  };

  /**
   * A popup has no address bar, so a page could open one that looks like a Google or GitHub sign-in with nothing to say
   * where it really is (2026-10-15 audit desktop #8). Its title is always the origin it shows, kept current as it
   * navigates; the page's own <title> never replaces it.
   */
  const showPopupOrigin = (popup: Electron.BrowserWindow) => {
    const contents = popup.webContents;
    const update = () => {
      if (!popup.isDestroyed()) popup.setTitle(popupOriginTitle(contents.getURL()));
    };
    contents.on("page-title-updated", (evt) => {
      evt.preventDefault();
      update();
    });
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    update();
  };

  const installGuestListeners = (pane: Tab, attachedItem: Attachment) => {
    const { contents } = attachedItem;
    const live = () => pane.attachment === attachedItem;

    const on = (evt: string, cb: (...argv: any[]) => void) => {
      contents.on(evt as never, cb as never);
      attachedItem.cleanups.push(() => contents.off(evt as never, cb as never));
    };
    const onIpc = (chan: string, cb: (...argv: any[]) => void) => {
      contents.ipc.on(chan, cb as never);
      attachedItem.cleanups.push(() => contents.ipc.off(chan, cb as never));
    };

    // The event shape differs between Electron versions: a details object, or positional (url, inPlace, mainFrame).
    on("did-start-navigation", (...argv: unknown[]) => {
      const head = argv[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
      const mainFrame =
        typeof head?.isMainFrame === "boolean" ? head.isMainFrame : argv[3] === true;
      const sameDocument =
        typeof head?.isMainFrame === "boolean" ? head.isSameDocument === true : argv[2] === true;
      if (!mainFrame || sameDocument || !live()) return;
      attachedItem.documentGeneration += 1;
      cancelFavicon(attachedItem);
      pane.pick?.settle(null);
    });
    on("did-navigate", () => {
      if (!live()) return;
      fire(
        Effect.gen(function* () {
          yield* syncNav(pane, attachedItem, { keepFailure: false });
          yield* clearFaviconIfOriginChanged(pane, attachedItem);
        }),
      );
    });
    on("did-navigate-in-page", () => fire(syncNav(pane, attachedItem, { keepFailure: true })));
    on("page-title-updated", () => fire(syncNav(pane, attachedItem, { keepFailure: true })));
    on("did-start-loading", () => fire(syncNav(pane, attachedItem, { keepFailure: false })));
    // Electron emits did-stop-loading after did-fail-load; the failure has to stay visible until a new load starts.
    on("did-stop-loading", () => fire(syncNav(pane, attachedItem, { keepFailure: true })));
    on(
      "did-fail-load",
      (
        _evt: unknown,
        errorCode: number,
        failureText: string,
        failedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!live() || !isMainFrame || errorCode === -3) return;
        const address = failedUrl || contents.getURL();
        fire(
          delta(pane, {
            navStatus: {
              kind: "LoadFailed",
              url: address,
              title: contents.getTitle(),
              code: errorCode,
              description: failureText,
            },
          }),
        );
      },
    );
    on("audio-state-changed", (evt?: { audible?: boolean }) => {
      if (!live() || contents.isDestroyed()) return;
      const audible =
        typeof evt?.audible === "boolean" ? evt.audible : contents.isCurrentlyAudible();
      if (pane.state.audible !== audible) fire(delta(pane, { audible }));
    });
    on("page-favicon-updated", (_evt: unknown, favicons: unknown) =>
      handleFaviconUpdate(pane, attachedItem, favicons),
    );

    // Only a focused native editing chord may reach the app menu; background automation must not edit the app.
    contents.setIgnoreMenuShortcuts(true);
    on("before-input-event", (_evt: unknown, keyEvent: Electron.Input) => {
      if (keyEvent.type !== "keyDown") return;
      contents.setIgnoreMenuShortcuts(
        !(
          isWebEditingShortcut(keyEvent, hostOs) &&
          Electron.webContents.getFocusedWebContents() === contents
        ),
      );
    });

    contents.setWindowOpenHandler((detailInfo) => {
      if (webWindowOpenAction(detailInfo) === "popup") {
        return {
          action: "allow",
          // A popup skips will-attach-webview, so its safe preferences are forced here.
          overrideBrowserWindowOptions: {
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      // loadURL is browser-initiated and would bypass Chromium's ban on file:/data: targets, so web URLs only.
      if (isWebTabNavigationUrl(detailInfo.url)) {
        fire(
          Effect.sync(() => {
            if (live() && !contents.isDestroyed())
              void contents.loadURL(detailInfo.url).catch(() => undefined);
          }),
        );
      }
      return { action: "deny" };
    });
    on("did-create-window", (popup: Electron.BrowserWindow) => {
      hardenPopup(popup.webContents);
      showPopupOrigin(popup);
    });

    onIpc(IPC_HUMAN_INPUT, () => {
      if (live()) markHumanControl(pane);
    });
    onIpc(IPC_MOUSE_NAVIGATE, (_evt: unknown, payload: { direction?: unknown } | undefined) =>
      navigateHistory(pane, attachedItem, payload?.direction),
    );
  };

  // --- control session (DevTools protocol) -----------------------------------------------------------------------

  const frameCaptureActive = (pane: Tab) => pane.consumers.has("recording");

  const ensureControl = (pane: Tab, attachedItem: Attachment): boolean => {
    if (attachedItem.control) return true;
    const { contents } = attachedItem;
    if (contents.isDestroyed()) return false;
    try {
      if (contents.isDevToolsOpened?.()) return false; // DevTools and the protocol client cannot share a guest
      // Pinned: touching `contents.debugger` throws once the contents are destroyed, and an unreleased debugger
      // that is garbage collected while attached crashes the browser process (electron/electron#53376).
      const pinned = contents.debugger;
      if (pinned.isAttached()) return false; // another client owns it
      pinned.attach("1.3");
      const onMessage = (
        _evt: unknown,
        verb: string,
        params: {
          data?: string;
          sessionId?: number;
          metadata?: { deviceWidth?: number; deviceHeight?: number };
        },
      ) => {
        if (verb !== "Page.screencastFrame") return;
        void pinned
          .sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId })
          .catch(() => undefined);
        if (!frameCaptureActive(pane) || typeof params.data !== "string") return;
        const fr: ShellWebScreencastFrame = {
          tabId: pane.id,
          data: params.data,
          width: params.metadata?.deviceWidth ?? 0,
          height: params.metadata?.deviceHeight ?? 0,
          receivedAt: isoNow(),
        };
        fire(deliver(frameListeners, (subscriber) => subscriber(fr)));
      };
      pinned.on("message", onMessage as never);
      attachedItem.control = { debuggerRef: pinned };
      attachedItem.cleanups.push(() => {
        pinned.off("message", onMessage as never);
        if (pinned.isAttached()) pinned.detach();
        else (pinned as { detach?: () => void }).detach?.();
      });
      return true;
    } catch {
      return false;
    }
  };

  const dropControl = (attachedItem: Attachment) => {
    // Control cleanups live among the attachment's other cleanups; run only the control one by re-registering.
    const control = attachedItem.control;
    if (!control) return;
    attachedItem.control = null;
    try {
      if (control.debuggerRef.isAttached()) control.debuggerRef.detach();
    } catch {
      // already gone
    }
  };

  const applyColorScheme = (pane: Tab, attachedItem: Attachment) =>
    Effect.gen(function* () {
      if (!ensureControl(pane, attachedItem) || !attachedItem.control) return;
      const { debuggerRef } = attachedItem.control;
      const scheme = pane.state.colorScheme;
      yield* Effect.promise(() =>
        Promise.resolve(
          debuggerRef.sendCommand("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: scheme === "system" ? "" : scheme }],
          }),
        ).catch(() => undefined),
      );
    });

  const restoreControl = (pane: Tab, attachedItem: Attachment) =>
    Effect.suspend(() =>
      pane.attachment === attachedItem && pane.state.colorScheme !== "system"
        ? applyColorScheme(pane, attachedItem)
        : Effect.void,
    );

  // --- background throttling (frame capture) ---------------------------------------------------------------------

  const setThrottling = (
    dest: { setBackgroundThrottling?: (enabled: boolean) => void },
    enabled: boolean,
  ) => attempt("setBackgroundThrottling", () => dest.setBackgroundThrottling?.(enabled));

  const restoreThrottling = (dest: { setBackgroundThrottling?: (enabled: boolean) => void }) =>
    setThrottling(dest, true).pipe(
      Effect.catch(() => setThrottling(dest, true)),
      Effect.catch((err) => logWarning("Background preview frame capture failed.", { error: err })),
    );

  const liveMainWindow = () => (mainWindow && !mainWindow.closed ? mainWindow.window : null);

  const startConsumer = (pane: Tab, consumer: Consumer): Effect.Effect<void, WebManagerError> =>
    Effect.gen(function* () {
      if (pane.consumers.has(consumer)) return;
      if (pane.consumers.size === 0) {
        const windowWasQuiet = captureTabs.size === 0;
        const win = liveMainWindow();
        if (windowWasQuiet && win) yield* setThrottling(win.webContents, false);
        const guest = pane.attachment?.contents;
        if (guest && !guest.isDestroyed()) {
          const unthrottled = yield* Effect.exit(setThrottling(guest, false));
          if (unthrottled._tag === "Failure") {
            if (windowWasQuiet && win) yield* restoreThrottling(win.webContents);
            return yield* Effect.failCause(unthrottled.cause);
          }
          pane.unthrottled.add(guest);
        }
        captureTabs.add(pane.id);
      }
      pane.consumers.add(consumer);
    });

  const stopConsumer = (pane: Tab, consumer: Consumer) =>
    Effect.gen(function* () {
      if (!pane.consumers.delete(consumer)) return;
      if (pane.consumers.size > 0) return;
      for (const guest of pane.unthrottled) {
        if (!guest.isDestroyed()) yield* restoreThrottling(guest);
      }
      pane.unthrottled.clear();
      captureTabs.delete(pane.id);
      const win = liveMainWindow();
      if (captureTabs.size === 0 && win) yield* restoreThrottling(win.webContents);
    });

  // --- screenshots -----------------------------------------------------------------------------------------------

  const capturePageOnce = (inner: Electron.WebContents, region?: Electron.Rectangle) =>
    Effect.tryPromise({
      try: () => inner.capturePage(region),
      catch: (reason) => new WebOperationError({ operation: "capturePage", cause: reason }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CAPTURE_ATTEMPT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new WebOperationError({
              operation: "capturePage",
              cause: new Error("Timed out waiting for the preview to render a frame"),
            }),
          ),
      }),
    );

  // A guest that is still warming its first compositor frame fails transiently, so a few attempts are made. The
  // tab must still own the same guest before and after every attempt.
  const capturePageWithRetry = (pane: Tab, attachedItem: Attachment, operation1: string) =>
    Effect.gen(function* () {
      const more = { tabId: pane.id, webContentsId: attachedItem.contents.id };
      const stillOwned = Effect.suspend(() =>
        pane.attachment === attachedItem && !attachedItem.contents.isDestroyed() && !pane.closing
          ? Effect.void
          : Effect.fail(
              new WebOperationError({
                operation: `${operation1}.validateWebContents`,
                ...more,
                cause: new Error("The preview tab's webview changed during capture"),
              }),
            ),
      );
      let lastError: unknown;
      for (let pos = 0; pos < CAPTURE_ATTEMPTS; pos += 1) {
        yield* stillOwned;
        const verdict = yield* Effect.result(capturePageOnce(attachedItem.contents));
        if (verdict._tag === "Success") {
          yield* stillOwned;
          return verdict.success;
        }
        lastError = verdict.failure.cause;
        if (pos < CAPTURE_ATTEMPTS - 1) yield* Effect.sleep(CAPTURE_RETRY_DELAY);
      }
      return yield* new WebOperationError({
        operation: `${operation1}.capturePage`,
        ...more,
        cause: lastError,
      });
    });

  const writeArtifact = (baseName: string, blob: Uint8Array, more: { tabId: string }) =>
    Effect.gen(function* () {
      yield* fsys.makeDirectory(envVars.browserArtifactsDir, { recursive: true }).pipe(
        Effect.mapError(
          (reason) =>
            new WebOperationError({
              operation: "artifact.createDirectory",
              ...more,
              cause: reason,
            }),
        ),
      );
      const artifactFile = envVars.path.join(envVars.browserArtifactsDir, baseName);
      yield* fsys.writeFile(artifactFile, blob).pipe(
        Effect.mapError(
          (reason) =>
            new WebOperationError({
              operation: "artifact.write",
              ...more,
              artifactPath: artifactFile,
              cause: reason,
            }),
        ),
      );
      return artifactFile;
    });

  // Lexical AND real (2026-10-15 audit desktop #10): a symlink planted in the artifacts folder must not let reveal/copy
  // reach a file outside it. A path that does not exist (yet) keeps the lexical answer.
  const insideArtifacts = (artifactFile: string) =>
    Effect.gen(function* () {
      const fail = new WebArtifactPathOutsideDirectoryError({
        artifactPath: artifactFile,
        artifactDirectory: envVars.browserArtifactsDir,
      });
      const outside = (dir: string, file: string) => {
        const relative = loc.relative(dir, file);
        return relative === "" || relative.startsWith("..") || loc.isAbsolute(relative);
      };
      const directory = loc.resolve(envVars.browserArtifactsDir);
      if (outside(directory, loc.resolve(artifactFile))) return yield* fail;
      const realDir = yield* fsys.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
      const realFile = yield* fsys.realPath(artifactFile).pipe(Effect.orElseSucceed(() => null));
      if (realFile !== null && outside(realDir, realFile)) return yield* fail;
    });

  // --- element picking -------------------------------------------------------------------------------------------

  const normalizeCrop = (val: unknown): Electron.Rectangle | null => {
    if (typeof val !== "object" || val === null) return null;
    const candidate = val as Record<string, unknown>;
    const { x, y, width, height } = candidate;
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)))
      return null;
    if ((width as number) <= 0 || (height as number) <= 0) return null;
    return {
      x: Math.max(0, Math.floor(x as number)),
      y: Math.max(0, Math.floor(y as number)),
      width: Math.max(1, Math.ceil(width as number)),
      height: Math.max(1, Math.ceil(height as number)),
    };
  };

  const cancelPick = (pane: Tab, notifyGuest: boolean) => {
    const choice = pane.pick;
    if (!choice) return;
    if (notifyGuest && pane.attachment) sendToGuest(pane.attachment.contents, IPC_CANCEL_PICK);
    choice.settle(null);
  };

  const completePick = (
    pane: Tab,
    attachedItem: Attachment,
    choice: PickSession,
    payload: unknown,
    cropRect: unknown,
    variant: unknown,
  ): Effect.Effect<WebMarkupSubmissionResult | null> =>
    Effect.gen(function* () {
      if (!isWebMarkupPayload(payload)) return null;
      const submission: WebMarkupSubmission = variant === "send" ? "send" : "attach";
      const crop = normalizeCrop(cropRect);
      const shot = yield* capturePageOnce(attachedItem.contents, crop ?? undefined).pipe(
        Effect.timeoutOrElse({
          duration: MARKUP_SCREENSHOT_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new WebOperationError({
                operation: "pickElement.screenshot",
                cause: "Timed out capturing the annotation screenshot",
              }),
            ),
        }),
        Effect.option,
      );
      // A pick that was replaced or cancelled meanwhile must not touch the overlay of the next one.
      if (choice.settled || pane.pick !== choice) return null;
      sendToGuest(attachedItem.contents, IPC_MARKUP_CAPTURED);
      if (Option.isNone(shot)) {
        return { annotation: payload, submission, screenshotFailed: true };
      }
      const extent = shot.value.getSize();
      return {
        annotation: {
          ...payload,
          screenshot: {
            dataUrl: `data:image/png;base64,${shot.value.toPNG().toString("base64")}`,
            width: extent.width,
            height: extent.height,
            cropRect: crop ?? { x: 0, y: 0, width: extent.width, height: extent.height },
          },
        },
        submission,
      };
    });

  // --- display-media recording -----------------------------------------------------------------------------------

  const clearArm = (only?: string) => {
    const live = arm;
    if (!live || (only !== undefined && live.tabId !== only)) return;
    arm = null;
    if (live.expiry) runFork(Fiber.interrupt(live.expiry));
  };

  const installDisplayMediaHandler = (hostInfo: Electron.WebContents) => {
    if (displayMediaHosts.has(hostInfo)) return;
    displayMediaHosts.add(hostInfo);
    hostInfo.session.setDisplayMediaRequestHandler(((
      req: { frame?: { frameTreeNodeId: number } | null },
      callback: (streams: { video?: unknown }) => void,
    ) => {
      const claim = arm;
      if (
        claim &&
        !claim.contents.isDestroyed() &&
        req.frame?.frameTreeNodeId === claim.hostFrameTreeNodeId
      ) {
        clearArm();
        callback({ video: claim.contents.mainFrame });
      } else {
        callback({});
      }
    }) as never);
  };

  const triggerScript = (tabKey: string) =>
    `(async () => { const trigger = globalThis[${JSON.stringify(SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER)}]; return typeof trigger === "function" ? (await trigger(${JSON.stringify(tabKey)})) === true : false; })()`;

  // --- picture-in-picture ----------------------------------------------------------------------------------------

  const popoutPage = `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Browser preview</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>:root{color-scheme:dark}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}img{display:block;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}</style></head>
<body><img id="frame" alt="Live browser preview"><script>window.webPopout.onFrame((frame)=>{document.getElementById("frame").src="data:image/jpeg;base64,"+frame.data})</script></body></html>`,
  )}`;

  const isClosed = (detached: Popout): boolean => detached.status === "closed";

  const deliverPopoutFrame = (pane: Tab, detached: Popout) =>
    Effect.gen(function* () {
      if (isClosed(detached) || detached.window.isDestroyed()) return;
      const img = yield* capturePageOnce(detached.attachment.contents);
      if (isClosed(detached) || detached.window.isDestroyed()) return;
      const extent = img.getSize();
      if (
        !(
          Number.isFinite(extent.width) &&
          Number.isFinite(extent.height) &&
          extent.width > 0 &&
          extent.height > 0
        )
      )
        return;
      const ratio = extent.width / extent.height;
      if (detached.ratio === null || Math.abs(ratio - detached.ratio) > POPOUT_RATIO_EPSILON) {
        detached.window.setAspectRatio(0);
        const [width, height] = fitPopoutContentSize(detached.window.getContentSize(), ratio);
        detached.window.setContentSize(width, height, false);
        detached.window.setAspectRatio(ratio);
        detached.ratio = ratio;
      }
      const jpeg = img.toJPEG(POPOUT_JPEG_QUALITY);
      if (detached.lastFrame?.equals(jpeg)) return;
      const fr: ShellWebScreencastFrame = {
        tabId: pane.id,
        data: jpeg.toString("base64"),
        width: extent.width,
        height: extent.height,
        receivedAt: isoNow(),
      };
      detached.window.webContents.send(IPC_WEB_POPOUT_FRAME, fr);
      detached.lastFrame = jpeg;
    });

  const releasePopout = (pane: Tab, detached: Popout): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (detached.status === "closed") return;
      detached.status = "closed";
      if (pane.popout === detached) pane.popout = null;
      if (detached.loop) runFork(Fiber.interrupt(detached.loop));
      detached.loop = null;
      detached.detach();
      Deferred.doneUnsafe(detached.closed, Effect.void);
      yield* stopConsumer(pane, "picture-in-picture");
      yield* delta(pane, { pictureInPicture: false });
    });

  const closePopoutWindow = (detached: Popout) => {
    if (detached.closeRequested || detached.windowGone) return;
    detached.closeRequested = true;
    try {
      if (!detached.window.isDestroyed()) detached.window.close();
    } catch {
      // already closing
    }
  };

  const closePopoutFor = (pane: Tab): Effect.Effect<void> =>
    Effect.gen(function* () {
      const detached = pane.popout;
      if (!detached) {
        yield* stopConsumer(pane, "picture-in-picture");
        if (pane.state.pictureInPicture) yield* delta(pane, { pictureInPicture: false });
        return;
      }
      closePopoutWindow(detached);
      yield* releasePopout(pane, detached);
    });

  const openPopoutFor = (pane: Tab): Effect.Effect<void, WebManagerError> =>
    Effect.gen(function* () {
      const existing = pane.popout;
      if (existing) {
        if (existing.status === "initializing") return yield* Deferred.await(existing.ready);
        if (existing.status === "ready") {
          yield* attempt("pictureInPicture.show", () => existing.window.showInactive(), {
            tabId: pane.id,
          });
          return;
        }
      }
      const attachedItem = pane.attachment;
      if (!attachedItem) return yield* new WebviewNotInitializedError({ tabId: pane.id });
      const guestId = attachedItem.contents.id;
      const heading = pane.state.navStatus.kind === "Idle" ? "" : pane.state.navStatus.title;

      const win = yield* attempt(
        "pictureInPicture.createWindow",
        () =>
          new Electron.BrowserWindow({
            width: POPOUT_DEFAULT_SIZE[0],
            height: POPOUT_DEFAULT_SIZE[1],
            minWidth: POPOUT_MIN_SIZE[0],
            minHeight: POPOUT_MIN_SIZE[1],
            title: heading === "" ? "Browser preview" : `Preview · ${heading}`,
            skipTaskbar: true,
            resizable: true,
            fullscreenable: false,
            alwaysOnTop: true,
            minimizable: false,
            autoHideMenuBar: true,
            maximizable: false,
            show: false,
            backgroundColor: "#000000",
            ...(hostOs === "darwin" ? { type: "panel" as const } : {}),
            webPreferences: {
              preload: envVars.path.join(envVars.dirname, "web-pip-preload.cjs"),
              sandbox: true,
              nodeIntegration: false,
              contextIsolation: true,
              backgroundThrottling: false,
            },
          }),
        { tabId: pane.id, webContentsId: guestId },
      );

      const detached: Popout = {
        window: win,
        attachment: attachedItem,
        ready: Deferred.makeUnsafe<void, WebManagerError>(),
        closed: Deferred.makeUnsafe<void>(),
        status: "initializing",
        windowGone: false,
        closeRequested: false,
        ratio: null,
        lastFrame: null,
        loop: null,
        detach: () => undefined,
      };
      pane.popout = detached;
      win.once("closed", () => {
        detached.windowGone = true;
        // When we asked for the close, the caller releases (and waits) itself.
        if (!detached.closeRequested) fire(releasePopout(pane, detached));
      });

      const fail = <Ok>(fault: Effect.Effect<Ok, WebManagerError>) =>
        fault.pipe(
          Effect.onError((reason) =>
            Effect.gen(function* () {
              closePopoutWindow(detached);
              yield* releasePopout(pane, detached);
              yield* Deferred.failCause(detached.ready, reason as Cause.Cause<WebManagerError>);
            }),
          ),
        );

      const abandoned = Deferred.await(detached.closed).pipe(Effect.andThen(Effect.interrupt));
      const opening = Effect.gen(function* () {
        if (hostOs === "darwin") {
          win.setAlwaysOnTop(true, "floating");
          // Without transforming the process type, which would drop the app from the Dock.
          win.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
          });
        }
        yield* Effect.raceFirst(
          attemptPromise("pictureInPicture.load", () => win.loadURL(popoutPage), {
            tabId: pane.id,
            webContentsId: guestId,
          }),
          abandoned,
        );
        if (isClosed(detached)) return yield* Effect.interrupt;
        if (pane.attachment !== attachedItem || attachedItem.contents.isDestroyed()) {
          return yield* new WebOperationError({
            operation: "pictureInPicture.validateWebContents",
            tabId: pane.id,
            webContentsId: guestId,
            cause: new Error("The preview tab's webview changed while the popout opened"),
          });
        }
        yield* startConsumer(pane, "picture-in-picture");
        detached.detach = (() => {
          const reset = () => {
            detached.lastFrame = null;
          };
          try {
            win.webContents.on("did-finish-load", reset);
          } catch {
            return () => undefined;
          }
          return () => {
            try {
              win.webContents.off("did-finish-load", reset);
            } catch {
              // window already gone
            }
          };
        })();
        yield* deliverPopoutFrame(pane, detached).pipe(
          Effect.catchCause((reason) =>
            Cause.hasInterrupts(reason)
              ? Effect.failCause(reason)
              : logWarning("Picture-in-picture frame delivery failed.", { cause: reason }),
          ),
        );
        if (isClosed(detached)) return yield* Effect.interrupt;
        yield* attempt("pictureInPicture.show", () => win.showInactive(), {
          tabId: pane.id,
          webContentsId: guestId,
        });
        if (isClosed(detached) || win.isDestroyed()) return yield* Effect.interrupt;
        detached.status = "ready";
        yield* delta(pane, { pictureInPicture: true });
        detached.loop = spawn(
          Effect.forever(
            Effect.sleep(POPOUT_FRAME_INTERVAL).pipe(
              Effect.andThen(
                deliverPopoutFrame(pane, detached).pipe(
                  Effect.catchCause((reason) =>
                    Cause.hasInterrupts(reason)
                      ? Effect.failCause(reason)
                      : logWarning("Picture-in-picture frame delivery failed.", { cause: reason }),
                  ),
                ),
              ),
            ),
          ),
        );
        yield* Deferred.succeed(detached.ready, undefined);
      });
      yield* fail(opening);
    });

  // --- tab lifecycle ---------------------------------------------------------------------------------------------

  const detachGuest = (pane: Tab, attachedItem: Attachment) => {
    cancelFavicon(attachedItem);
    runCleanups(attachedItem);
    if (pane.attachment === attachedItem) pane.attachment = null;
  };

  const closeTabLocked = (pane: Tab) =>
    Effect.gen(function* () {
      clearArm(pane.id);
      cancelPick(pane, true);
      yield* closePopoutFor(pane);
      yield* stopConsumer(pane, "recording");
      tabs.delete(pane.id);
      const attachedItem = pane.attachment;
      if (attachedItem) detachGuest(pane, attachedItem);
      const closed: WebTabState = { ...newState(pane.id), colorScheme: "system" };
      yield* deliver(stateListeners, (subscriber) => subscriber(pane.id, closed));
    });

  const closeTab = (tabKey: string) =>
    Effect.suspend(() => {
      const pane = tabs.get(tabKey);
      if (!pane || closingTabs.has(tabKey)) return Effect.void;
      closingTabs.add(tabKey);
      pane.closing = true;
      return lockFor(tabKey)
        .withPermits(1)(closeTabLocked(pane))
        .pipe(Effect.ensuring(Effect.sync(() => closingTabs.delete(tabKey))));
    });

  const createTab = (tabKey: string, baseline?: ShellWebTabDefaults) =>
    lockFor(tabKey).withPermits(1)(
      Effect.gen(function* () {
        const existing = tabs.get(tabKey);
        if (existing && !existing.closing) {
          yield* emit(existing);
          return existing.state;
        }
        const pane = makeTab(tabKey, baseline);
        yield* emit(pane);
        return pane.state;
      }),
    );

  const markupThemeToGuest = (inner: Electron.WebContents) =>
    sendToGuest(inner, IPC_MARKUP_THEME, markupTheme);

  const reassertGuest = (pane: Tab, inner: Electron.WebContents) => {
    try {
      inner.setZoomFactor(pane.state.zoomFactor);
    } catch {
      // best effort
    }
  };

  const registerWebview = (tabKey: string, webContentsId: number) =>
    Effect.gen(function* () {
      const initial = yield* requireTab(tabKey);
      const generation = initial.generation;
      yield* lockFor(tabKey).withPermits(1)(
        Effect.gen(function* () {
          const pane = tabs.get(tabKey);
          if (!pane || pane.closing || closingTabs.has(tabKey) || pane.generation !== generation) {
            return yield* new WebTabNotFoundError({ tabId: tabKey });
          }
          const located = Electron.webContents.fromId(webContentsId) ?? null;
          if (!located || located.isDestroyed())
            return yield* new WebContentsNotFoundError({ tabId: tabKey, webContentsId });
          if (located.getType() !== "webview")
            return yield* new WebContentsNotFoundError({ tabId: tabKey, webContentsId });
          const hostInfo = liveMainWindow();
          if (
            hostInfo &&
            (located as { hostWebContents?: unknown }).hostWebContents !== hostInfo.webContents
          ) {
            return yield* new WebContentsNotFoundError({ tabId: tabKey, webContentsId });
          }
          const inner = located;

          const existing = pane.attachment;
          if (existing && existing.contents === inner) {
            reassertGuest(pane, inner);
            markupThemeToGuest(inner);
            return;
          }
          if (existing) {
            clearArm(pane.id);
            detachGuest(pane, existing);
            cancelPick(pane, false);
          }

          if (frameCaptureActive(pane) || pane.consumers.size > 0) {
            yield* setThrottling(inner, false);
            pane.unthrottled.add(inner);
          }
          // Zoom first, so the guest never paints at the app window's inherited zoom.
          yield* attempt("registerWebview.zoom", () => inner.setZoomFactor(pane.state.zoomFactor), {
            tabId: tabKey,
            webContentsId,
          });
          yield* attempt("registerWebview.mute", () => inner.setAudioMuted(pane.state.audioMuted), {
            tabId: tabKey,
            webContentsId,
          });

          const attachedItem: Attachment = {
            contents: inner,
            cleanups: [],
            documentGeneration: 0,
            favicon: { key: null, requestId: 0, abort: null, settled: "failed" },
            control: null,
          };
          installGuestListeners(pane, attachedItem);
          const audible = inner.isCurrentlyAudible();

          if (pane.closing || closingTabs.has(tabKey) || tabs.get(tabKey) !== pane) {
            detachGuest(pane, attachedItem);
            return yield* new WebTabNotFoundError({ tabId: tabKey });
          }

          // Commit.
          pane.attachment = attachedItem;
          const queued = pane.pendingUrl;
          const guestUrl = inner.getURL();
          let navStatus: WebNavStatus;
          if (queued !== null) {
            navStatus = {
              kind: "Loading",
              url: queued,
              title: pane.state.navStatus.kind === "Idle" ? "" : pane.state.navStatus.title,
            };
          } else if (guestUrl === "" || guestUrl === "about:blank") {
            navStatus = { kind: "Idle" };
          } else if (inner.isLoading()) {
            navStatus = { kind: "Loading", url: guestUrl, title: inner.getTitle() };
          } else {
            navStatus = { kind: "Success", url: guestUrl, title: inner.getTitle() };
          }
          if (navStatus.kind === "Success") pane.pendingUrl = null;
          const committed = delta(pane, {
            webContentsId: inner.id,
            navStatus,
            canGoBack: inner.navigationHistory.canGoBack(),
            canGoForward: inner.navigationHistory.canGoForward(),
            audible,
            favicon: null,
          });

          // After the commit: re-assert zoom and mute (a dying guest must not fail the registration).
          reassertGuest(pane, inner);
          try {
            inner.setAudioMuted(pane.state.audioMuted);
          } catch {
            // best effort
          }
          fire(restoreControl(pane, attachedItem));
          yield* committed;
          // audio-state-changed for a transition before the tab owned the guest was dropped: read it again.
          const reconciled = (() => {
            try {
              return inner.isCurrentlyAudible();
            } catch {
              return audible;
            }
          })();
          if (pane.attachment === attachedItem && reconciled !== pane.state.audible) {
            yield* delta(pane, { audible: reconciled });
          }
          markupThemeToGuest(inner);
          if (queued !== null && inner.getURL() !== queued) {
            void Promise.resolve(inner.loadURL(queued)).catch(() => undefined);
          }
        }),
      );
    });

  // --- navigation and the rest of the service --------------------------------------------------------------------

  const withGuest = <Ok>(
    tabKey: string,
    exec: (cx: { tab: Tab; attachment: Attachment; contents: Electron.WebContents }) => Ok,
  ) =>
    Effect.flatMap(requireAttached(tabKey), (cx) =>
      attempt("webContents", () => exec(cx), { tabId: tabKey, webContentsId: cx.contents.id }),
    );

  const navigate = (tabKey: string, urlText: string) =>
    Effect.gen(function* () {
      const address = normalizeWebUrl(urlText);
      if (closingTabs.has(tabKey)) return yield* new WebTabNotFoundError({ tabId: tabKey });
      const pane = tabs.get(tabKey) ?? makeTab(tabKey);
      pane.pendingUrl = address;
      const heading = pane.state.navStatus.kind === "Idle" ? "" : pane.state.navStatus.title;
      yield* delta(pane, { navStatus: { kind: "Loading", url: address, title: heading } });
      const attachedItem = pane.attachment;
      if (!attachedItem) return; // registration will load it
      const { contents } = attachedItem;
      if (contents.isDestroyed()) {
        // The guest died under us: let go of it, but only if nothing replaced it in the meantime.
        detachGuest(pane, attachedItem);
        if (pane.attachment === null && tabs.get(tabKey) === pane) {
          yield* delta(pane, { webContentsId: null, favicon: null });
        }
        return;
      }
      if (contents.getURL() === address) {
        yield* attempt("navigate.reload", () => contents.reload(), {
          tabId: tabKey,
          webContentsId: contents.id,
        });
      } else {
        yield* attemptPromise(
          "navigate.loadURL",
          () => Promise.resolve(contents.loadURL(address)),
          {
            tabId: tabKey,
            webContentsId: contents.id,
          },
        ).pipe(Effect.catch(() => Effect.void));
      }
    });

  const applyZoom = (pane: Tab, inner: Electron.WebContents, upcoming: number) =>
    Effect.gen(function* () {
      if (Math.abs(upcoming - pane.state.zoomFactor) < ZOOM_EPSILON) return;
      yield* attempt("setZoomFactor", () => inner.setZoomFactor(upcoming), {
        tabId: pane.id,
        webContentsId: inner.id,
      });
      yield* delta(pane, { zoomFactor: upcoming });
    });

  const zoomBy = (tabKey: string, dir: "in" | "out" | "reset") =>
    Effect.gen(function* () {
      const { tab, contents } = yield* requireAttached(tabKey);
      const pos = zoomStepIndex(tab.state.zoomFactor);
      const onStep = Math.abs(ZOOM_STEPS[pos]! - tab.state.zoomFactor) < ZOOM_EPSILON;
      const upcoming =
        dir === "reset"
          ? DEFAULT_ZOOM
          : dir === "in"
            ? ZOOM_STEPS[Math.min(pos + 1, ZOOM_STEPS.length - 1)]!
            : ZOOM_STEPS[onStep ? Math.max(pos - 1, 0) : pos]!;
      yield* applyZoom(tab, contents, upcoming);
    });

  const setColorScheme = (tabKey: string, colorScheme: ShellWebColorScheme) =>
    Effect.gen(function* () {
      const pane = yield* requireTab(tabKey);
      // The choice is stored even when it cannot be applied yet; it is re-applied whenever a guest attaches.
      yield* delta(pane, { colorScheme });
      const attachedItem = pane.attachment;
      if (attachedItem && !attachedItem.contents.isDestroyed())
        yield* applyColorScheme(pane, attachedItem);
    });

  const setAudioMuted = (tabKey: string, audioMuted: boolean) =>
    Effect.gen(function* () {
      yield* requireTab(tabKey);
      yield* lockFor(tabKey).withPermits(1)(
        Effect.gen(function* () {
          const pane = yield* requireTab(tabKey);
          const changed = pane.state.audioMuted !== audioMuted;
          const prior = pane.state.audioMuted;
          if (changed) yield* delta(pane, { audioMuted });
          const attachedItem = pane.attachment;
          if (!attachedItem || attachedItem.contents.isDestroyed()) return;
          const verdict = yield* Effect.result(
            attempt(
              "setAudioMuted",
              () => attachedItem.contents.setAudioMuted(pane.state.audioMuted),
              {
                tabId: tabKey,
                webContentsId: attachedItem.contents.id,
              },
            ),
          );
          if (verdict._tag === "Failure") {
            // Showing "muted" while the guest keeps playing would be a lie.
            if (changed) yield* delta(pane, { audioMuted: prior });
            return yield* verdict.failure;
          }
        }),
      );
    });

  const openDevTools = (tabKey: string) =>
    Effect.gen(function* () {
      const { tab, attachment, contents } = yield* requireAttached(tabKey);
      yield* attempt(
        "openDevTools",
        () => {
          if (contents.isDevToolsOpened()) {
            contents.devToolsWebContents?.focus();
            return;
          }
          dropControl(attachment);
          contents.once("devtools-closed", () => {
            fire(restoreControl(tab, attachment));
          });
          contents.openDevTools({ mode: "detach" });
        },
        { tabId: tabKey, webContentsId: contents.id },
      );
    });

  const pickElement = (tabKey: string) =>
    Effect.gen(function* () {
      const { tab, attachment, contents } = yield* requireAttached(tabKey);
      cancelPick(tab, false);
      return yield* Effect.callback<WebMarkupSubmissionResult | null, WebManagerError>((resume) => {
        let finish!: (outcome: WebMarkupSubmissionResult | null) => void;
        const sess: PickSession = {
          id: Date.now(),
          settled: false,
          settle: (outcome) => finish(outcome),
          cleanup: () => undefined,
        };
        finish = (outcome) => {
          if (sess.settled) return;
          sess.settled = true;
          sess.cleanup();
          if (tab.pick === sess) tab.pick = null;
          resume(Effect.succeed(outcome));
        };
        const onPicked = (_evt: unknown, payload: unknown, cropRect: unknown, variant: unknown) => {
          if (sess.settled) return;
          if (payload === null || payload === undefined) return finish(null);
          // The capture may outlive the pick; completePick re-checks before touching the overlay.
          runFork(
            completePick(tab, attachment, sess, payload, cropRect, variant).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
              Effect.tap((outcome) => Effect.sync(() => finish(outcome))),
            ),
          );
        };
        const ipc = contents.ipc;
        ipc.on(IPC_ELEMENT_PICKED, onPicked as never);
        sess.cleanup = () => {
          try {
            ipc.off(IPC_ELEMENT_PICKED, onPicked as never);
          } catch {
            // guest gone
          }
        };
        tab.pick = sess;
        sendToGuest(contents, IPC_START_PICK, markupTheme);
        try {
          if (!contents.isFocused()) contents.focus();
        } catch {
          // best effort
        }
        return Effect.sync(() => sess.settle(null));
      });
    });

  const captureScreenshot = (tabKey: string) =>
    Effect.gen(function* () {
      const { tab, attachment, contents } = yield* requireAttached(tabKey);
      const img = yield* capturePageWithRetry(tab, attachment, "captureScreenshot");
      const png = img.toPNG();
      const baseName = `browser-screenshot-${siteSlug(contents.getURL())}-${Date.now().toString(36)}`;
      const artifactFile = yield* writeArtifact(`${baseName}.png`, png, { tabId: tabKey });
      return {
        id: baseName,
        tabId: tabKey,
        path: artifactFile,
        mimeType: "image/png" as const,
        sizeBytes: png.byteLength,
        createdAt: isoNow(),
      } satisfies ShellWebScreenshotArtifact;
    });

  const beginScreencast = (tabKey: string) =>
    Effect.gen(function* () {
      yield* requireTab(tabKey);
      yield* lockFor(tabKey).withPermits(1)(
        Effect.gen(function* () {
          const { tab, attachment, contents } = yield* requireAttached(tabKey);
          if (mainWindow?.closed) return yield* new WebMainWindowClosedError({ tabId: tabKey });
          yield* startConsumer(tab, "recording");
          const undo = Effect.sync(() => clearArm(tabKey)).pipe(
            Effect.andThen(stopConsumer(tab, "recording")),
          );
          yield* Effect.gen(function* () {
            // Warm the capture source; a source that is not ready yet must not stop native recording.
            for (let pos = 0; pos < 2; pos += 1) {
              const warmed = yield* Effect.result(capturePageOnce(contents));
              if (warmed._tag === "Success") break;
            }
            if (mainWindow?.closed) return yield* new WebMainWindowClosedError({ tabId: tabKey });
            const hostInfo = (contents as { hostWebContents?: Electron.WebContents })
              .hostWebContents;
            if (!hostInfo) {
              return yield* new WebScreencastCaptureUnavailableError({
                tabId: tabKey,
                webContentsId: contents.id,
              });
            }
            installDisplayMediaHandler(hostInfo);

            const armed = arm;
            if (armed && armed.tabId !== tabKey) {
              if (armed.contents.isDestroyed()) clearArm();
              else {
                return yield* new WebScreencastArmConflictError({
                  tabId: tabKey,
                  webContentsId: contents.id,
                  armedTabId: armed.tabId,
                });
              }
            }
            clearArm(tabKey);
            const claim: Arm = {
              tabId: tabKey,
              contents,
              hostFrameTreeNodeId: hostInfo.mainFrame?.frameTreeNodeId,
              expiry: null,
            };
            arm = claim;
            claim.expiry = spawn(
              Effect.sleep(ARM_GRACE).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (arm === claim) arm = null;
                  }),
                ),
              ),
            );

            const triggered = yield* attemptPromise(
              "beginScreencast.trigger",
              () => hostInfo.executeJavaScript(triggerScript(tabKey), true) as Promise<unknown>,
              { tabId: tabKey, webContentsId: contents.id },
            );
            if (triggered !== true) {
              return yield* new WebScreencastCaptureUnavailableError({
                tabId: tabKey,
                webContentsId: contents.id,
              });
            }
          }).pipe(Effect.onError(() => undo));
          void attachment;
        }),
      );
    });

  const endScreencast = (tabKey: string) =>
    Effect.suspend(() => {
      const pane = tabs.get(tabKey);
      if (!pane) return Effect.void;
      return lockFor(tabKey).withPermits(1)(
        Effect.sync(() => clearArm(tabKey)).pipe(Effect.andThen(stopConsumer(pane, "recording"))),
      );
    });

  const saveScreencast = (tabKey: string, mediaType: string, blob: Uint8Array) =>
    Effect.gen(function* () {
      yield* requireTab(tabKey);
      const baseName = `browser-recording-${Date.now().toString(36)}`;
      const artifactFile = yield* writeArtifact(
        `${baseName}.${screencastFileExtension(mediaType)}`,
        blob,
        { tabId: tabKey },
      );
      return {
        id: baseName,
        tabId: tabKey,
        path: artifactFile,
        mimeType: mediaType,
        sizeBytes: blob.byteLength,
        createdAt: isoNow(),
      } satisfies ShellWebScreencastArtifact;
    });

  const copyArtifactToClipboard = (artifactFile: string) =>
    Effect.gen(function* () {
      yield* insideArtifacts(artifactFile);
      const img = Electron.nativeImage.createFromPath(artifactFile);
      if (img.isEmpty())
        return yield* new WebArtifactImageLoadError({ artifactPath: artifactFile });
      const clipboardItem = new (
        Electron as unknown as { ClipboardItem: new (blob: Record<string, Blob>) => unknown }
      ).ClipboardItem({
        "image/png": new Blob([new Uint8Array(img.toPNG())], { type: "image/png" }),
      });
      yield* attemptPromise(
        "copyArtifactToClipboard.write",
        async () => {
          await (
            Electron.clipboard as unknown as { write: (item: unknown) => Promise<void> }
          ).write(clipboardItem);
        },
        { artifactPath: artifactFile },
      );
    });

  // --- main window -----------------------------------------------------------------------------------------------

  let pendingWindowCleanup: Promise<unknown> = Promise.resolve();

  const releaseForClosedWindow = Effect.gen(function* () {
    clearArm();
    for (const pane of [...tabs.values()]) {
      yield* closePopoutFor(pane);
      yield* stopConsumer(pane, "recording");
    }
  });

  const setMainWindow = (win: Electron.BrowserWindow) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => pendingWindowCleanup);
      // Frame capture already running needs the new window unthrottled too, or it is not published at all.
      if (captureTabs.size > 0) yield* setThrottling(win.webContents, false);
      const record: MainWindowRecord = { window: win, closed: false };
      mainWindow = record;
      win.once("closed", () => {
        if (mainWindow !== record) return; // a replaced window's close is not ours to act on
        record.closed = true;
        pendingWindowCleanup = Effect.runPromiseWith(services)(
          releaseForClosedWindow.pipe(Effect.catchCause(() => Effect.void)),
        );
      });
    });

  // --- layer -----------------------------------------------------------------------------------------------------

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const pane of [...tabs.values()])
        yield* closeTab(pane.id).pipe(Effect.catchCause(() => Effect.void));
      for (const fiber of [...background]) yield* Fiber.interrupt(fiber);
      stateListeners.clear();
      pointerListeners.clear();
      frameListeners.clear();
    }),
  );

  const subscribe =
    <L>(bag: Set<L>) =>
    (subscriber: L) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          bag.add(subscriber);
        }),
        () =>
          Effect.sync(() => {
            bag.delete(subscriber);
          }),
      ).pipe(Effect.asVoid);

  const mapPartitions = <Ok, Err>(operation1: string, effect: Effect.Effect<Ok, Err>) =>
    effect.pipe(
      Effect.mapError((reason) => new WebOperationError({ operation: operation1, cause: reason })),
    );

  return WebManager.of({
    setMainWindow,
    getBrowserSession: (scope, durable, nsName) =>
      mapPartitions("getBrowserSession", partitions.getSession(scope, durable, nsName)),
    isBrowserPartition: (partName) => partitions.isPartition(partName),
    getBrowserPartition: (scope, durable, nsName) =>
      mapPartitions("getBrowserPartition", partitions.getPartition(scope, durable, nsName)),
    createTab,
    closeTab,
    registerWebview,
    navigate,
    goBack: (tabKey) =>
      withGuest(tabKey, ({ contents }) => {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      }),
    goForward: (tabKey) =>
      withGuest(tabKey, ({ contents }) => {
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      }),
    refresh: (tabKey) => withGuest(tabKey, ({ contents }) => contents.reload()),
    hardReload: (tabKey) => withGuest(tabKey, ({ contents }) => contents.reloadIgnoringCache()),
    zoomIn: (tabKey) => zoomBy(tabKey, "in"),
    zoomOut: (tabKey) => zoomBy(tabKey, "out"),
    resetZoom: (tabKey) => zoomBy(tabKey, "reset"),
    reapplyZoom: () =>
      Effect.sync(() => {
        for (const pane of tabs.values()) {
          const inner = pane.attachment?.contents;
          if (inner && !inner.isDestroyed()) reassertGuest(pane, inner);
        }
      }),
    setColorScheme,
    setAudioMuted,
    openDevTools,
    clearCookies: (selected) =>
      partitions
        .clearCookies(selected)
        .pipe(
          Effect.mapError(
            (reason) => new WebOperationError({ operation: "clearCookies", cause: reason }),
          ),
        ),
    clearCache: (selected) =>
      partitions
        .clearCache(selected)
        .pipe(
          Effect.mapError(
            (reason) => new WebOperationError({ operation: "clearCache", cause: reason }),
          ),
        ),
    setMarkupTheme: (palette) =>
      Effect.sync(() => {
        markupTheme = palette;
        for (const pane of tabs.values()) {
          if (pane.attachment) sendToGuest(pane.attachment.contents, IPC_MARKUP_THEME, palette);
        }
      }),
    pickElement,
    cancelPickElement: (tabKey) =>
      Effect.gen(function* () {
        const pane = yield* requireTab(tabKey);
        cancelPick(pane, true);
      }),
    captureScreenshot,
    revealArtifact: (artifactFile) =>
      insideArtifacts(artifactFile).pipe(
        Effect.andThen(
          attempt("revealArtifact", () => Electron.shell.showItemInFolder(artifactFile), {
            artifactPath: artifactFile,
          }),
        ),
      ),
    copyArtifactToClipboard,
    openPopout: (tabKey) =>
      Effect.gen(function* () {
        const pane = yield* requireTab(tabKey);
        yield* openPopoutFor(pane);
      }),
    closePopout: (tabKey) =>
      Effect.gen(function* () {
        const pane = yield* requireTab(tabKey);
        yield* closePopoutFor(pane);
      }),
    beginScreencast,
    endScreencast,
    saveScreencast,
    subscribeStateChanges: subscribe(stateListeners),
    subscribePointerEvents: subscribe(pointerListeners),
    subscribeRecordingFrames: subscribe(frameListeners),
  });
});

export const layer = Layer.effect(WebManager, make);

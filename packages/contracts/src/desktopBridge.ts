import * as Schema from "effect/Schema";

import { HostId } from "./primitives.ts";
import { WebProfileId as WebProfileIdSchema, type WebProfileId } from "./webProfile.ts";
import type { ExternalEditorId } from "./externalEditors.ts";
import type { ClientPrefs } from "./clientPrefs.ts";
import type { ShellLaunchRequest, ShellLaunchResponse } from "./shellLaunch.ts";

// The contract between the Electron shell (main + preload) and the web client:
// `window.shellBridge`, the preview-browser bridge, update state, context menus
// and the renderer-local `LocalApi`.

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface ContextMenuItem<T extends string = string> {
  readonly children?: ReadonlyArray<ContextMenuItem<T>>;
  /** A divider immediately before this item. */
  readonly separatorBefore?: boolean;
  /** Icon keyword for the web fallback; stripped on native menus. */
  readonly icon?: string;
  /** Non-interactive section header; used by the web fallback only, stripped on native menus. */
  readonly header?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly label: string;
  readonly id: T;
}

// ---------------------------------------------------------------------------
// Update and runtime types
// ---------------------------------------------------------------------------

export const ShellUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  ...(["checking", "up-to-date", "available"] as const),
  ...(["downloading", "downloaded"] as const),
  "error",
]);
export type ShellUpdateStatus = typeof ShellUpdateStatusSchema.Type;

export const ShellRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export type ShellRuntimeArch = typeof ShellRuntimeArchSchema.Type;

export const ShellThemeSchema = Schema.Literals(["light", "dark", "system"]);
export type ShellTheme = typeof ShellThemeSchema.Type;

export const ShellUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export type ShellUpdateChannel = typeof ShellUpdateChannelSchema.Type;

export const ShellAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);
export type ShellAppStageLabel = typeof ShellAppStageLabelSchema.Type;

export interface ShellAppBranding {
  readonly baseName: string;
  readonly stageLabel: ShellAppStageLabel;
  readonly displayName: string;
}

export interface ShellRuntimeInfo {
  readonly hostArch: ShellRuntimeArch;
  readonly appArch: ShellRuntimeArch;
  readonly runningUnderArm64Translation: boolean;
}

export interface ShellUpdateReleaseNote {
  readonly version: string;
  readonly items: ReadonlyArray<string>;
  readonly totalItems: number;
}

export const ShellUpdateReleaseNoteSchema = Schema.Struct({
  totalItems: Schema.Number,
  items: Schema.Array(Schema.String),
  version: Schema.String,
});

export interface ShellUpdateState {
  readonly enabled: boolean;
  readonly status: ShellUpdateStatus;
  readonly channel: ShellUpdateChannel;
  readonly currentVersion: string;
  readonly hostArch: ShellRuntimeArch;
  readonly appArch: ShellRuntimeArch;
  readonly runningUnderArm64Translation: boolean;
  readonly availableVersion: string | null;
  readonly downloadedVersion: string | null;
  readonly releaseNotes: ReadonlyArray<ShellUpdateReleaseNote>;
  readonly omittedReleaseCount: number;
  readonly downloadPercent: number | null;
  readonly checkedAt: string | null;
  readonly message: string | null;
  readonly errorContext: "check" | "download" | "install" | null;
  readonly canRetry: boolean;
}

export const ShellUpdateStateSchema: Schema.Codec<ShellUpdateState> = Schema.Struct({
  enabled: Schema.Boolean,
  status: ShellUpdateStatusSchema,
  channel: ShellUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: ShellRuntimeArchSchema,
  appArch: ShellRuntimeArchSchema,
  canRetry: Schema.Boolean,
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  message: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  omittedReleaseCount: Schema.Number,
  releaseNotes: Schema.Array(ShellUpdateReleaseNoteSchema),
  downloadedVersion: Schema.NullOr(Schema.String),
  availableVersion: Schema.NullOr(Schema.String),
  runningUnderArm64Translation: Schema.Boolean,
});

export interface ShellUpdateActionResult {
  readonly accepted: boolean;
  readonly completed: boolean;
  readonly state: ShellUpdateState;
}

export const ShellUpdateActionResultSchema: Schema.Codec<ShellUpdateActionResult> = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: ShellUpdateStateSchema,
});

export interface ShellUpdateCheckResult {
  readonly checked: boolean;
  readonly state: ShellUpdateState;
}

export const ShellUpdateCheckResultSchema: Schema.Codec<ShellUpdateCheckResult> = Schema.Struct({
  checked: Schema.Boolean,
  state: ShellUpdateStateSchema,
});

export interface ShellUpdatesBridge {
  getState(): Promise<ShellUpdateState>;
  /** Check now; a newer release is downloaded in the background. */
  check(): Promise<ShellUpdateCheckResult>;
  /** Quit, install the downloaded update, relaunch. */
  install(): Promise<ShellUpdateActionResult>;
  onState(listener: (state: ShellUpdateState) => void): () => void;
}

// ---------------------------------------------------------------------------
// Host bootstrap
// ---------------------------------------------------------------------------

/** Stable id of the local daemon's bootstrap entry. */
export const PRIMARY_LOCAL_HOST_ID = "primary";

/** Where one local backend listens (null when that transport is not served) and how to authenticate. */
export type ShellHostBootstrap = Readonly<
  Record<"httpBaseUrl" | "wsBaseUrl", string | null> & {
    label: string;
    id: string;
    bootstrapToken?: string;
  }
>;

type Unsubscribe = () => void;

export interface PickFolderOptions {
  readonly initialPath?: string | null;
}

// ---------------------------------------------------------------------------
// Preview browser (desktop only)
// ---------------------------------------------------------------------------

type NavPage = { readonly url: string; readonly title: string };

export type ShellWebNavStatus =
  | { readonly kind: "Idle" }
  | ({ readonly kind: "Loading" | "Success" } & NavPage)
  | ({
      readonly kind: "LoadFailed";
      readonly code: number;
      readonly description: string;
    } & NavPage);

/** Emulated prefers-color-scheme; "system" clears the override. */
export type ShellWebColorScheme = "system" | "light" | "dark";

export const SITE_ICON_DATA_URL_MAX = 8192;
export const FAVICON_CAPTURED_AT_MAX = 8_640_000_000_000_000;

export interface ShellWebFavicon {
  readonly dataUrl: string;
  readonly pageUrl: string;
  readonly capturedAt: number;
}

/** A captured favicon: a small PNG data URL, the page it came from, and a sane timestamp. */
export const ShellWebFaviconSchema: Schema.Codec<ShellWebFavicon> = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isMaxLength(SITE_ICON_DATA_URL_MAX),
    Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/i),
  ),
  pageUrl: Schema.String.check(Schema.isMaxLength(2048)),
  capturedAt: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(FAVICON_CAPTURED_AT_MAX),
  ),
});

export interface ShellWebTabState {
  readonly tabId: string;
  readonly webContentsId: number | null;
  readonly navStatus: ShellWebNavStatus;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** 1.0 is 100%. */
  readonly zoomFactor: number;
  readonly pictureInPicture: boolean;
  readonly colorScheme: ShellWebColorScheme;
  /** Per tab, not per origin; survives navigation and webview swaps, dropped when the tab closes. */
  readonly audioMuted: boolean;
  /** Observed from Chromium, independent of `audioMuted`. */
  readonly audible: boolean;
  readonly controller: "human" | "agent" | "none";
  readonly favicon?: ShellWebFavicon;
  readonly updatedAt: string;
}

export interface ShellWebPointerEvent {
  readonly tabId: string;
  readonly sequence: number;
  readonly y: number;
  readonly x: number;
  readonly phase: "move" | "click";
  readonly createdAt: string;
}

export interface ShellWebviewConfig {
  /** e.g. `persist:kora-preview`. */
  readonly partition: string;
  /** Canonical webview `webpreferences`: sandboxed, contextIsolation off so the picker preload can read the React DevTools hook. */
  readonly webPreferences: string;
  /** Null means the renderer must disable element picking. */
  readonly preloadUrl: string | null;
}

export interface ShellWebMarkupTheme {
  readonly colorScheme: "light" | "dark";
  readonly radius: string;
  readonly background: string;
  readonly foreground: string;
  readonly popover: string;
  readonly popoverForeground: string;
  readonly primary: string;
  readonly primaryForeground: string;
  readonly muted: string;
  readonly mutedForeground: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly border: string;
  readonly input: string;
  readonly ring: string;
  readonly fontSans: string;
  readonly fontMono: string;
}

export interface ShellWebScreencastFrame {
  readonly tabId: string;
  readonly receivedAt: string;
  readonly height: number;
  readonly width: number;
  readonly data: string;
}

export interface ShellWebScreencastArtifact {
  readonly id: string;
  readonly tabId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

/** A PNG screenshot saved to disk for one tab. */
export type ShellWebScreenshotArtifact = Readonly<{
  mimeType: "image/png";
  path: string;
  sizeBytes: number;
  createdAt: string;
  tabId: string;
  id: string;
}>;

// Element-pick and annotation payloads.

export interface PickedElementStackFrame {
  readonly functionName: string | null;
  readonly fileName: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}

export interface PickedNodePayload {
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  /** Lowercase. */
  readonly tagName: string;
  readonly selector: string | null;
  /** Truncated outer HTML. */
  readonly htmlPreview: string;
  readonly componentName: string | null;
  readonly source: PickedElementStackFrame | null;
  readonly stack: ReadonlyArray<PickedElementStackFrame>;
  /** Author CSS only. */
  readonly styles: string;
  /** ISO timestamp. */
  readonly pickedAt: string;
}

export interface WebMarkupRect {
  readonly height: number;
  readonly width: number;
  readonly y: number;
  readonly x: number;
}

export type WebMarkupPoint = Readonly<Record<"x" | "y", number>>;

/** Every markup target has an id; the rest depends on what was marked. */
type MarkupTarget<Extra> = Readonly<{ id: string } & Extra>;

export type WebMarkupElementTarget = MarkupTarget<{
  element: PickedNodePayload;
  rect: WebMarkupRect;
}>;
export type WebMarkupRegionTarget = MarkupTarget<{ rect: WebMarkupRect }>;
export type WebMarkupStrokeTarget = MarkupTarget<{
  points: ReadonlyArray<WebMarkupPoint>;
  bounds: WebMarkupRect;
  color: string;
  width: number;
}>;

/** One CSS property edit: the old and new value on the targeted node. */
export type WebMarkupStyleChange = Readonly<
  { targetId: string; selector: string | null; property: string } & Record<
    "previousValue" | "value",
    string
  >
>;

export interface WebMarkupScreenshot {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly cropRect: WebMarkupRect;
}

export interface WebMarkupPayload {
  readonly id: string;
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly comment: string;
  readonly elements: ReadonlyArray<WebMarkupElementTarget>;
  readonly regions: ReadonlyArray<WebMarkupRegionTarget>;
  readonly strokes: ReadonlyArray<WebMarkupStrokeTarget>;
  readonly styleChanges: ReadonlyArray<WebMarkupStyleChange>;
  /** Added by the main process after the guest preload submits the draft. */
  readonly screenshot: WebMarkupScreenshot | null;
  readonly createdAt: string;
}

export type WebMarkupSubmission = "attach" | "send";

export interface WebMarkupSubmissionResult {
  readonly annotation: WebMarkupPayload;
  readonly submission: WebMarkupSubmission;
  /** A crop was requested but failed or timed out, so `annotation.screenshot` is null. */
  readonly screenshotFailed?: boolean;
}

export interface ShellWebTabDefaults {
  readonly zoomFactor?: number;
  readonly colorScheme?: ShellWebColorScheme;
}

/** The renderer never supplies a webview partition; main derives it from the profile. */
export interface ShellWebBridge {
  createTab(tabId: string, defaults?: ShellWebTabDefaults): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  registerWebview(tabId: string, webContentsId: number): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  goBack(tabId: string): Promise<void>;
  goForward(tabId: string): Promise<void>;
  refresh(tabId: string): Promise<void>;
  zoomIn(tabId: string): Promise<void>;
  zoomOut(tabId: string): Promise<void>;
  resetZoom(tabId: string): Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload(tabId: string): Promise<void>;
  /** Persists per tab and is re-applied across webview swaps. */
  setColorScheme(tabId: string, scheme: ShellWebColorScheme): Promise<void>;
  /** Muting a silent tab is allowed. */
  setAudioMuted(tabId: string, audioMuted: boolean): Promise<void>;
  /** Opens detached DevTools. */
  openDevTools(tabId: string): Promise<void>;
  /** Cookies and storage of the preview partition. */
  clearCookies(hostId: HostId, profileId?: WebProfileId): Promise<void>;
  clearCache(hostId: HostId, profileId?: WebProfileId): Promise<void>;
  getWebConfig(hostId: HostId, profileId?: WebProfileId): Promise<ShellWebviewConfig>;
  setMarkupTheme(theme: ShellWebMarkupTheme): Promise<void>;
  /** Null when cancelled (Escape or navigation); rejects when the picker cannot activate. */
  pickElement(tabId: string): Promise<WebMarkupSubmissionResult | null>;
  cancelPickElement(tabId: string): Promise<void>;
  captureScreenshot(tabId: string): Promise<ShellWebScreenshotArtifact>;
  revealArtifact(path: string): Promise<void>;
  copyArtifactToClipboard(path: string): Promise<void>;
  pictureInPicture: {
    open(tabId: string): Promise<void>;
    close(tabId: string): Promise<void>;
  };
  recording: {
    startScreencast(tabId: string): Promise<void>;
    stopScreencast(tabId: string): Promise<void>;
    save(tabId: string, mimeType: string, data: Uint8Array): Promise<ShellWebScreencastArtifact>;
    onFrame(listener: (frame: ShellWebScreencastFrame) => void): () => void;
  };
  onStateChange(listener: (tabId: string, state: ShellWebTabState) => void): () => void;
  onPointerEvent(listener: (event: ShellWebPointerEvent) => void): () => void;
}

/** Name of the renderer callback Electron invokes with a fresh user gesture before display-media capture. */
export const SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER = "__koraDesktopPreviewRecordingCapture";

// ---------------------------------------------------------------------------
// ShellBridge (window.shellBridge)
// ---------------------------------------------------------------------------

export interface ShellBridge {
  getAppBranding: () => ShellAppBranding | null;
  getClientPlatform?: () => string;
  setNotificationBadge?: (input: { count: number; image: string | null }) => Promise<void>;
  onNotificationBadgeClear?: (listener: () => void) => () => void;
  /** The OS locale (BCP-47); the packaged app ships only en-US so `navigator.language` is pinned. */
  getSystemLocale?: () => string | null;
  /** One entry per registered backend; the primary one has id "primary". */
  getLocalHostBootstraps: () => ReadonlyArray<ShellHostBootstrap>;
  getLocalHostBearerToken: () => Promise<string>;
  getClientPrefs: () => Promise<ClientPrefs | null>;
  setClientPrefs: (prefs: ClientPrefs) => Promise<void>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  setTheme: (theme: ShellTheme) => Promise<void>;
  showContextMenu: <T extends string = string>(
    entries: ReadonlyArray<ContextMenuItem<T>>,
    at?: WebMarkupPoint,
  ) => Promise<T | null>;
  openExternal: (href: string) => Promise<boolean>;
  /** Absent in older builds; callers fall back to VS Code only. */
  probeRemoteEditors?: () => Promise<ReadonlyArray<ExternalEditorId>>;
  /** Ordered plain-text paste. */
  pasteAsText?: () => Promise<void>;
  /** The bytes of a public http(s) media URL, fetched by the main process (the window's connect-src is loopback-only). */
  fetchRemoteMedia?: (
    url: string,
  ) => Promise<{ bytes?: Uint8Array; mime?: string; error?: string }>;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (handler: (isFullscreen: boolean) => void) => Unsubscribe;
  onMenuAction: (handler: (menuAction: string) => void) => Unsubscribe;
  /** Accepts `kora app` activation requests. */
  appActivation?: {
    setReady: (ready: boolean) => Promise<void>;
    complete: (response: ShellLaunchResponse) => Promise<void>;
    onRequest: (listener: (request: ShellLaunchRequest) => void) => () => void;
  };
  /** Present in the desktop app; `getState()` reports `enabled: false` for builds without an update feed. */
  updates?: ShellUpdatesBridge;
  /** Opens a prefilled issue on the public tracker with version, macOS and chip. */
  reportBug?: () => Promise<void>;
  /** Shows server.log in Finder. */
  revealLogs?: () => Promise<void>;
  /** Present only in Electron. */
  preview?: ShellWebBridge;
}

// ---------------------------------------------------------------------------
// Renderer-local API
// ---------------------------------------------------------------------------

export type ConfirmDialogVariant = "destructive" | "default";

export interface ConfirmDialogOptions {
  /** What the dialog is for, when the message has no question to title it. */
  readonly description?: string;
  /** Defaults to "Confirm". */
  readonly confirmLabel?: string;
  readonly variant?: ConfirmDialogVariant;
}

interface LocalDialogsApi {
  confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
}

interface LocalContextMenuApi {
  close: () => Promise<void>;
  show: <T extends string = string>(
    items: ReadonlyArray<ContextMenuItem<T>>,
    position?: { x: number; y: number },
  ) => Promise<T | null>;
}

/** Bound to the local shell, not to any backend host. */
export interface LocalApi {
  persistence: {
    setClientPrefs: (prefs: ClientPrefs) => Promise<void>;
    getClientPrefs: () => Promise<ClientPrefs | null>;
  };
  contextMenu: LocalContextMenuApi;
  shell: { openExternal: (url: string) => Promise<void> };
  dialogs: LocalDialogsApi;
}

// ---------------------------------------------------------------------------
// Schemas for values that cross the IPC boundary
// ---------------------------------------------------------------------------

const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);
const TrimmedNonEmpty = Schema.Trim.check(Schema.isNonEmpty());

export interface ContextMenuItemSchemaType {
  readonly children?: ReadonlyArray<ContextMenuItemSchemaType>;
  readonly separatorBefore?: boolean;
  readonly icon?: string;
  readonly header?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly label: string;
  readonly id: string;
}

const optionalFlagField = Schema.optionalKey(Schema.Boolean);
const nestedMenuItems = (): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema;

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  children: Schema.optionalKey(Schema.Array(Schema.suspend(nestedMenuItems))),
  separatorBefore: optionalFlagField,
  icon: Schema.optionalKey(Text),
  header: optionalFlagField,
  disabled: optionalFlagField,
  destructive: optionalFlagField,
  label: Text,
  id: Text,
});

export const ShellAppBrandingSchema: Schema.Codec<ShellAppBranding> = Schema.Struct({
  baseName: Text,
  stageLabel: ShellAppStageLabelSchema,
  displayName: Text,
});

export const ShellHostBootstrapSchema: Schema.Codec<ShellHostBootstrap> = Schema.Struct({
  id: Text,
  label: Text,
  httpBaseUrl: NullableText,
  wsBaseUrl: NullableText,
  bootstrapToken: Schema.optionalKey(Text),
});

export const PickFolderOptionsSchema: Schema.Codec<PickFolderOptions> = Schema.Struct({
  initialPath: Schema.optionalKey(NullableText),
});

export const ShellWebTabIdSchema = TrimmedNonEmpty;

export const ShellWebNavStatusSchema: Schema.Codec<ShellWebNavStatus> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle") }),
  Schema.Struct({ kind: Schema.Literal("Loading"), url: Text, title: Text }),
  Schema.Struct({ kind: Schema.Literal("Success"), url: Text, title: Text }),
  Schema.Struct({
    kind: Schema.Literal("LoadFailed"),
    url: Text,
    title: Text,
    code: Schema.Number,
    description: Text,
  }),
]);

export const ShellWebColorSchemeSchema = Schema.Literals(["system", "light", "dark"]);

export const ShellWebviewConfigSchema: Schema.Codec<ShellWebviewConfig> = Schema.Struct({
  partition: Text,
  webPreferences: Text,
  preloadUrl: NullableText,
});

export const ShellWebMarkupThemeSchema: Schema.Codec<ShellWebMarkupTheme> = Schema.Struct({
  colorScheme: Schema.Literals(["light", "dark"]),
  radius: Text,
  background: Text,
  foreground: Text,
  popover: Text,
  popoverForeground: Text,
  primary: Text,
  primaryForeground: Text,
  muted: Text,
  mutedForeground: Text,
  accent: Text,
  accentForeground: Text,
  border: Text,
  input: Text,
  ring: Text,
  fontSans: Text,
  fontMono: Text,
});

export const ShellWebScreencastArtifactSchema: Schema.Codec<ShellWebScreencastArtifact> =
  Schema.Struct({
    id: Text,
    tabId: ShellWebTabIdSchema,
    path: Text,
    mimeType: Text,
    sizeBytes: Schema.Int,
    createdAt: Text,
  });

export const ShellWebScreenshotArtifactSchema: Schema.Codec<ShellWebScreenshotArtifact> =
  Schema.Struct({
    id: Text,
    tabId: ShellWebTabIdSchema,
    path: Text,
    mimeType: Schema.Literal("image/png"),
    sizeBytes: Schema.Int,
    createdAt: Text,
  });

export const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
  functionName: NullableText,
  fileName: NullableText,
  lineNumber: NullableNumber,
  columnNumber: NullableNumber,
});

export const PickedElementPayloadSchema: Schema.Codec<PickedNodePayload> = Schema.Struct({
  pageUrl: Text,
  pageTitle: NullableText,
  tagName: Text,
  selector: NullableText,
  htmlPreview: Text,
  componentName: NullableText,
  source: Schema.NullOr(PickedElementStackFrameSchema),
  stack: Schema.Array(PickedElementStackFrameSchema),
  styles: Text,
  pickedAt: Text,
});

export const WebMarkupRectSchema: Schema.Codec<WebMarkupRect> = Schema.Struct({
  height: Schema.Number,
  width: Schema.Number,
  y: Schema.Number,
  x: Schema.Number,
});

export const WebMarkupPointSchema: Schema.Codec<WebMarkupPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export const WebMarkupElementTargetSchema: Schema.Codec<WebMarkupElementTarget> = Schema.Struct({
  id: Text,
  element: PickedElementPayloadSchema,
  rect: WebMarkupRectSchema,
});

export const WebMarkupRegionTargetSchema: Schema.Codec<WebMarkupRegionTarget> = Schema.Struct({
  id: Text,
  rect: WebMarkupRectSchema,
});

export const WebMarkupStrokeTargetSchema: Schema.Codec<WebMarkupStrokeTarget> = Schema.Struct({
  id: Text,
  color: Text,
  width: Schema.Number,
  points: Schema.Array(WebMarkupPointSchema),
  bounds: WebMarkupRectSchema,
});

export const WebMarkupStyleChangeSchema: Schema.Codec<WebMarkupStyleChange> = Schema.Struct({
  targetId: Text,
  selector: NullableText,
  property: Text,
  previousValue: Text,
  value: Text,
});

export const WebMarkupScreenshotSchema: Schema.Codec<WebMarkupScreenshot> = Schema.Struct({
  dataUrl: Text,
  width: Schema.Number,
  height: Schema.Number,
  cropRect: WebMarkupRectSchema,
});

export const WebMarkupPayloadSchema: Schema.Codec<WebMarkupPayload> = Schema.Struct({
  id: Text,
  pageUrl: Text,
  pageTitle: NullableText,
  comment: Text,
  elements: Schema.Array(WebMarkupElementTargetSchema),
  regions: Schema.Array(WebMarkupRegionTargetSchema),
  strokes: Schema.Array(WebMarkupStrokeTargetSchema),
  styleChanges: Schema.Array(WebMarkupStyleChangeSchema),
  screenshot: Schema.NullOr(WebMarkupScreenshotSchema),
  createdAt: Text,
});

export const WebMarkupSubmissionSchema = Schema.Literals(["attach", "send"]);

export const WebMarkupSubmissionResultSchema: Schema.Codec<WebMarkupSubmissionResult> =
  Schema.Struct({
    annotation: WebMarkupPayloadSchema,
    submission: WebMarkupSubmissionSchema,
    screenshotFailed: Schema.optionalKey(Schema.Boolean),
  });

export const ShellWebTabInputSchema = Schema.Struct({ tabId: ShellWebTabIdSchema });

export const ShellWebCreateTabInputSchema = Schema.Struct({
  tabId: ShellWebTabIdSchema,
  zoomFactor: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  colorScheme: Schema.optionalKey(ShellWebColorSchemeSchema),
});

export const ShellWebRegisterWebviewInputSchema = Schema.Struct({
  tabId: ShellWebTabIdSchema,
  webContentsId: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const ShellWebNavigateInputSchema = Schema.Struct({ tabId: ShellWebTabIdSchema, url: Text });

// The renderer never names a partition; main derives it from the profile.
export const ShellWebConfigInputSchema = Schema.Struct({
  hostId: HostId,
  profileId: Schema.optionalKey(WebProfileIdSchema),
});

export const ShellWebClearDataInputSchema = Schema.Struct({
  hostId: HostId,
  profileId: Schema.optionalKey(WebProfileIdSchema),
});

export const ShellWebSetColorSchemeInputSchema = Schema.Struct({
  tabId: ShellWebTabIdSchema,
  colorScheme: ShellWebColorSchemeSchema,
});

export const ShellWebSetAudioMutedInputSchema = Schema.Struct({
  tabId: ShellWebTabIdSchema,
  audioMuted: Schema.Boolean,
});

export const ShellWebMarkupThemeInputSchema = Schema.Struct({ theme: ShellWebMarkupThemeSchema });

export const ShellWebArtifactInputSchema = Schema.Struct({ path: TrimmedNonEmpty });

export const ShellWebScreencastSaveInputSchema = Schema.Struct({
  tabId: ShellWebTabIdSchema,
  mimeType: TrimmedNonEmpty,
  data: Schema.Uint8Array,
});

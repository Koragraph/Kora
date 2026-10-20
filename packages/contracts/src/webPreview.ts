import * as Schema from "effect/Schema";

import { CountingNumber, NonblankString, ThreadId, WholeNumber } from "./primitives.ts";
import { WebProfileId } from "./webProfile.ts";

const Url = NonblankString.check(Schema.isMaxLength(2048));
const Title = Schema.String.check(Schema.isMaxLength(512));

/** Picks the mini-player's device frame. */
export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = Schema.Schema.Type<typeof DevicePlatform>;

export const WebTabId = NonblankString.check(Schema.isMaxLength(128));
export type WebTabId = Schema.Schema.Type<typeof WebTabId>;

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export const WEB_VIEWPORT_MIN_DIMENSION = 240;
export const WEB_VIEWPORT_MAX_DIMENSION = 3840;
export const WEB_VIEWPORT_MAX_AREA = 3840 * 2160;

const viewportDimension = Schema.Int.check(
  Schema.isBetween({ minimum: WEB_VIEWPORT_MIN_DIMENSION, maximum: WEB_VIEWPORT_MAX_DIMENSION }),
);
const withinMaxArea = Schema.makeFilter<{ readonly width: number; readonly height: number }>(
  (size) =>
    size.width * size.height <= WEB_VIEWPORT_MAX_AREA
      ? undefined
      : `Viewport area must not exceed ${WEB_VIEWPORT_MAX_AREA} pixels.`,
);

export const WebViewportSize = Schema.Struct({
  width: viewportDimension,
  height: viewportDimension,
}).check(withinMaxArea);
export type WebViewportSize = Schema.Schema.Type<typeof WebViewportSize>;

/** What was measured; may sit below the selectable minimum when fill mode follows a narrow panel. */
export const WebRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type WebRenderedViewportSize = Schema.Schema.Type<typeof WebRenderedViewportSize>;

const PHONE_PRESET_IDS = ["iphone-se", "iphone-xr", "iphone-12-pro", "iphone-14-pro-max"] as const;
const ANDROID_PRESET_IDS = ["samsung-galaxy-s8-plus", "samsung-galaxy-s20-ultra"] as const;
const FOLDABLE_PRESET_IDS = ["surface-pro-7", "surface-duo", "galaxy-z-fold-5"] as const;
export const WEB_VIEWPORT_PRESET_IDS = [
  ...PHONE_PRESET_IDS,
  "pixel-7",
  ...ANDROID_PRESET_IDS,
  ...(["ipad-mini", "ipad-air", "ipad-pro"] as const),
  ...FOLDABLE_PRESET_IDS,
  ...(["asus-zenbook-fold", "samsung-galaxy-a51-71"] as const),
  "nest-hub",
  "nest-hub-max",
] as const;

// Still decodable from stored settings, no longer offered for new resizes.
const LEGACY_VIEWPORT_PRESET_IDS = [
  ...(["desktop-1920x1080", "desktop-1440x900"] as const),
  ...(["laptop-1366x768", "laptop-1280x800"] as const),
  ...(["ipad-pro-11", "iphone-15-pro"] as const),
  "pixel-8",
  "galaxy-s24",
] as const;

export const WebViewportPresetId = Schema.Literals(WEB_VIEWPORT_PRESET_IDS);
export type WebViewportPresetId = Schema.Schema.Type<typeof WebViewportPresetId>;

export const WebViewportSetting = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("fill") }),
  Schema.Struct({
    _tag: Schema.Literal("freeform"),
    width: viewportDimension,
    height: viewportDimension,
  }).check(withinMaxArea),
  Schema.Struct({
    _tag: Schema.Literal("preset"),
    width: viewportDimension,
    height: viewportDimension,
    presetId: Schema.Literals([...WEB_VIEWPORT_PRESET_IDS, ...LEGACY_VIEWPORT_PRESET_IDS]),
  }).check(withinMaxArea),
]);
export type WebViewportSetting = Schema.Schema.Type<typeof WebViewportSetting>;

export const FILL_WEB_VIEWPORT: WebViewportSetting = { _tag: "fill" };

/** Chrome's zoom ladder; the desktop main process applies it. */
export const WebZoomFactor = Schema.Literals([
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
]);
export type WebZoomFactor = Schema.Schema.Type<typeof WebZoomFactor>;
export const DEFAULT_WEB_ZOOM_FACTOR: WebZoomFactor = 1.0;

export const WebAppearancePreference = Schema.Literals(["system", "light", "dark"]);
export type WebAppearancePreference = Schema.Schema.Type<typeof WebAppearancePreference>;
export const DEFAULT_WEB_APPEARANCE: WebAppearancePreference = "system";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const WebNavStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({ _tag: Schema.Literal("Loading"), url: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Success"), url: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("LoadFailed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type WebNavStatus = Schema.Schema.Type<typeof WebNavStatus>;

export const WebSessionSnapshot = Schema.Struct({
  threadId: NonblankString,
  tabId: WebTabId,
  navStatus: WebNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  // Absent from older servers: treat as fill-panel.
  viewport: Schema.optionalKey(WebViewportSetting),
  // Fixed when the tab opens: Electron only honours a webview's partition before attach.
  profileId: Schema.optionalKey(WebProfileId),
  updatedAt: Schema.String,
});
export type WebSessionSnapshot = Schema.Schema.Type<typeof WebSessionSnapshot>;

export const WebOpenInput = Schema.Struct({
  threadId: ThreadId,
  // Omitted: an empty Idle tab.
  url: Schema.optionalKey(Url),
  // Omitted: fill. Clients with a default send it so the tab is born at the right size.
  viewport: Schema.optionalKey(WebViewportSetting),
  profileId: Schema.optionalKey(WebProfileId),
});
export type WebOpenInput = Schema.Schema.Type<typeof WebOpenInput>;

export const WebReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: WebTabId,
  navStatus: WebNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type WebReportStatusInput = Schema.Schema.Type<typeof WebReportStatusInput>;

export const WebResizeInput = Schema.Struct({
  threadId: ThreadId,
  tabId: WebTabId,
  viewport: WebViewportSetting,
});
export type WebResizeInput = Schema.Schema.Type<typeof WebResizeInput>;

export const WebCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optionalKey(WebTabId),
});
export type WebCloseInput = Schema.Schema.Type<typeof WebCloseInput>;

export const WebListInput = Schema.Struct({ threadId: ThreadId });
export type WebListInput = Schema.Schema.Type<typeof WebListInput>;

export const WebListResult = Schema.Struct({
  sessions: Schema.Array(WebSessionSnapshot),
  // Identifies the server process, so a revision reset is recognisable.
  serverEpoch: NonblankString,
  // Shared with events; lets clients drop stale list responses.
  revision: WholeNumber,
});
export type WebListResult = Schema.Schema.Type<typeof WebListResult>;

const eventBase = {
  threadId: NonblankString,
  tabId: WebTabId,
  createdAt: Schema.String,
  serverEpoch: NonblankString,
  revision: CountingNumber,
};

export const WebEvent = Schema.Union([
  Schema.Struct({ ...eventBase, type: Schema.Literal("opened"), snapshot: WebSessionSnapshot }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("navigated"), snapshot: WebSessionSnapshot }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("resized"), snapshot: WebSessionSnapshot }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("failed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Int,
    description: Schema.String,
  }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("closed") }),
]);
export type WebEvent = Schema.Schema.Type<typeof WebEvent>;

export const DiscoveredDevSite = Schema.Struct({
  host: NonblankString,
  port: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(65536)),
  url: Url,
  processName: Schema.NullOr(NonblankString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(Schema.Struct({ threadId: ThreadId, terminalId: NonblankString })),
});
export type DiscoveredDevSite = Schema.Schema.Type<typeof DiscoveredDevSite>;

export const DiscoveredDevSiteList = Schema.Struct({
  servers: Schema.Array(DiscoveredDevSite),
  scannedAt: Schema.String,
  configuredUrlProbing: Schema.optionalKey(Schema.Literal(true)),
});
export type DiscoveredDevSiteList = Schema.Schema.Type<typeof DiscoveredDevSiteList>;

export class WebSessionLookupError extends Schema.TaggedError<WebSessionLookupError>()(
  "WebSessionLookupError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class WebInvalidUrlError extends Schema.TaggedError<WebInvalidUrlError>()(
  "WebInvalidUrlError",
  {
    cause: Schema.Defect(),
    protocol: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    inputLength: Schema.Number,
  },
) {
  override get message() {
    const suffix = this.protocol === undefined ? "" : ": " + this.protocol;
    return (
      "Invalid preview URL (" + this.reason + suffix + "; input length " + this.inputLength + ")."
    );
  }
}

export const WebError = Schema.Union([WebSessionLookupError, WebInvalidUrlError]);
export type WebError = Schema.Schema.Type<typeof WebError>;

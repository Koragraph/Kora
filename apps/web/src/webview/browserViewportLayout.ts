import {
  type WebViewportSize,
  type WebViewportSetting,
  WEB_VIEWPORT_MIN_DIMENSION,
  WEB_VIEWPORT_MAX_DIMENSION,
  WEB_VIEWPORT_MAX_AREA,
} from "@kora/contracts";

export interface BrowserViewportLayout {
  readonly fillsPanel: boolean;
  /** Presentation-only: the guest keeps its CSS viewport. */
  readonly viewportScale: number;
  readonly viewportHeight: number;
  /** Visible footprint after fit-to-panel scaling. */
  readonly viewportWidth: number;
  readonly viewportY: number;
  /** Top-left of the visible viewport inside the container. */
  readonly viewportX: number;
  readonly canvasHeight: number;
  /** The whole container. */
  readonly canvasWidth: number;
}

export const BROWSER_DEVICE_TOOLBAR_HEIGHT = 32;
export const BROWSER_VIEWPORT_RESIZE_RAIL_SIZE: number = 10;

export type BrowserViewportResizeDirection =
  | "northwest"
  | "west"
  | "southwest"
  | "south"
  | "southeast"
  | "east"
  | "northeast"
  | "north";

type Size = { readonly width: number; readonly height: number };
type FixedSetting = Exclude<WebViewportSetting, { _tag: "fill" }>;

const MIN = WEB_VIEWPORT_MIN_DIMENSION;
const MAX = WEB_VIEWPORT_MAX_DIMENSION;
const MAX_AREA = WEB_VIEWPORT_MAX_AREA;
const FALLBACK_FILL_SIZE = { width: 1280, height: 800 } as const;

const zoomOf = (zoomLevel: number | undefined) =>
  zoomLevel !== undefined && Number.isFinite(zoomLevel) && zoomLevel > 0 ? zoomLevel : 1;
const clampDimension = (val: number) => Math.min(MAX, Math.max(MIN, Math.round(val)));
const atLeastOne = (val: number) => Math.max(1, Math.round(val));

export const browserViewportSettingKey = (preference: WebViewportSetting): string =>
  preference._tag === "fill"
    ? "fill"
    : `${preference._tag}:${preference.width}:${preference.height}:${preference._tag === "preset" ? preference.presetId : ""}`;

export function resolveFittedBrowserViewport(
  preference: WebViewportSetting,
  sourceContent: { width: number; height: number; scale: number } | null,
  zoomFactor?: number,
): FixedSetting {
  if (preference._tag !== "fill") return preference;
  if (!sourceContent) return { _tag: "freeform", ...FALLBACK_FILL_SIZE };
  const zoomLevel = zoomOf(zoomFactor);
  return {
    _tag: "freeform",
    width: Math.max(1, Math.round(sourceContent.width / sourceContent.scale / zoomLevel)),
    height: Math.max(1, Math.round(sourceContent.height / sourceContent.scale / zoomLevel)),
  };
}

export function resolveBrowserDeviceViewportArea(container: Size): WebViewportSize {
  return {
    width: Math.max(1, container.width - 2 * BROWSER_VIEWPORT_RESIZE_RAIL_SIZE),
    height: Math.max(
      1,
      container.height - BROWSER_DEVICE_TOOLBAR_HEIGHT - BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
    ),
  } as WebViewportSize;
}

export function resolveBrowserViewportLayout(
  container: Size,
  preference: WebViewportSetting,
  zoomFactor?: number,
): BrowserViewportLayout {
  const canvasWidth = atLeastOne(container.width);
  const canvasHeight = atLeastOne(container.height);
  if (preference._tag === "fill") {
    return {
      canvasWidth,
      canvasHeight,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: canvasWidth,
      viewportHeight: canvasHeight,
      viewportScale: 1,
      fillsPanel: true,
    };
  }
  const zoomLevel = zoomOf(zoomFactor);
  const renderedWidth = preference.width * zoomLevel;
  const renderedHeight = preference.height * zoomLevel;
  // Fixed viewports only ever shrink to fit; a small one is centred, never enlarged.
  const viewportScale = Math.min(1, canvasWidth / renderedWidth, canvasHeight / renderedHeight);
  const viewportWidth = renderedWidth * viewportScale;
  const viewportHeight = renderedHeight * viewportScale;
  return {
    canvasWidth,
    canvasHeight,
    viewportX: Math.max(0, Math.round((canvasWidth - viewportWidth) / 2)),
    viewportY: Math.max(0, Math.round((canvasHeight - viewportHeight) / 2)),
    viewportWidth: Math.round(viewportWidth),
    viewportHeight: Math.round(viewportHeight),
    fillsPanel: false,
    viewportScale,
  };
}

export function resolveBrowserDeviceViewportLayout(
  container: Size,
  preference: FixedSetting,
  zoomFactor?: number,
): BrowserViewportLayout {
  const inner = resolveBrowserViewportLayout(
    resolveBrowserDeviceViewportArea(container),
    preference,
    zoomFactor,
  );
  return {
    ...inner,
    canvasWidth: atLeastOne(container.width),
    canvasHeight: atLeastOne(container.height),
    viewportX: inner.viewportX + BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
    viewportY: inner.viewportY + BROWSER_DEVICE_TOOLBAR_HEIGHT,
  };
}

// ---------- resizing ----------

const controlsX = (direction: BrowserViewportResizeDirection) =>
  direction.includes("east") || direction.includes("west");
const controlsY = (direction: BrowserViewportResizeDirection) =>
  direction.includes("north") || direction.includes("south");

/** Largest width in [min, max] at this ratio that keeps the area within the limit. */
function solveAtAspectRatio(
  primary: "width" | "height",
  desired: number,
  ratio: number,
): WebViewportSize {
  const widthPrimary = primary === "width";
  // `scale` converts the primary dimension to the other one.
  const toOther = (val: number) => Math.round(widthPrimary ? val / ratio : val * ratio);
  const lo = Math.ceil(Math.max(MIN, widthPrimary ? MIN * ratio : MIN / ratio));
  const hi = Math.floor(
    Math.min(
      MAX,
      widthPrimary ? MAX * ratio : MAX / ratio,
      Math.sqrt(widthPrimary ? MAX_AREA * ratio : MAX_AREA / ratio),
    ),
  );
  let val = Math.min(hi, Math.max(lo, Math.round(desired)));
  let other = toOther(val);
  while (val * other > MAX_AREA && val > lo) {
    val -= 1;
    other = toOther(val);
  }
  return (
    widthPrimary ? { width: val, height: other } : { width: other, height: val }
  ) as WebViewportSize;
}

export function resizeFreeformViewport(
  begin: Size,
  delta: { x: number; y: number },
  zoomFactor?: number,
  dir: BrowserViewportResizeDirection = "southeast",
  aspectRatio?: number,
): WebViewportSize {
  const zoomLevel = zoomOf(zoomFactor);
  const dx = dir.includes("east") ? delta.x : dir.includes("west") ? -delta.x : 0;
  const dy = dir.includes("south") ? delta.y : dir.includes("north") ? -delta.y : 0;
  const desiredWidth = begin.width + dx / zoomLevel;
  const desiredHeight = begin.height + dy / zoomLevel;

  const ratio =
    aspectRatio !== undefined && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? aspectRatio
      : null;
  if (ratio === null) {
    let wd = clampDimension(desiredWidth);
    let ht = clampDimension(desiredHeight);
    if (wd * ht > MAX_AREA) {
      // Give back area on the axis the user pushed harder.
      if (Math.abs(dx) >= Math.abs(dy)) wd = Math.max(MIN, Math.floor(MAX_AREA / ht));
      else ht = Math.max(MIN, Math.floor(MAX_AREA / wd));
    }
    return { width: wd, height: ht } as WebViewportSize;
  }

  let primary: "width" | "height";
  if (controlsX(dir) && !controlsY(dir)) primary = "width";
  else if (controlsY(dir) && !controlsX(dir)) primary = "height";
  else {
    const widthChange = Math.abs(desiredWidth - begin.width) / begin.width;
    const heightChange = Math.abs(desiredHeight - begin.height) / begin.height;
    primary = heightChange > widthChange ? "height" : "width";
  }
  return solveAtAspectRatio(primary, primary === "width" ? desiredWidth : desiredHeight, ratio);
}

/** One axis of a rail drag: the new rendered size when the pointer moved `pointer` px. */
function railRenderedSize(
  rendered: number,
  available: number,
  ptr: number,
  startRail: boolean,
): number {
  if (!startRail) {
    const startEdge = rendered < available ? (available + rendered) / 2 : rendered;
    const dest = startEdge + ptr;
    return dest <= available ? dest * 2 - available : dest;
  }
  if (rendered > available) {
    const excess = rendered - available;
    return ptr <= excess ? rendered - ptr : available - 2 * (ptr - excess);
  }
  const dest = (available - rendered) / 2 + ptr;
  return dest >= 0 ? available - 2 * dest : available - dest;
}

export function resizeBrowserViewportFromRail(
  begin: Size,
  pointerDelta: { x: number; y: number },
  available: Size,
  zoomFactor?: number,
  dir: BrowserViewportResizeDirection = "southeast",
  aspectRatio?: number,
): WebViewportSize {
  const zoomLevel = zoomOf(zoomFactor);
  const axis = (startSize: number, avail: number, ptr: number, startRail: boolean) => {
    const rendered = startSize * zoomLevel;
    const upcoming = railRenderedSize(rendered, avail, ptr, startRail);
    // resizeFreeformViewport flips the sign itself for west/north.
    return startRail ? rendered - upcoming : upcoming - rendered;
  };
  const px = controlsX(dir)
    ? axis(begin.width, available.width, pointerDelta.x, dir.includes("west"))
    : 0;
  const py = controlsY(dir)
    ? axis(begin.height, available.height, pointerDelta.y, dir.includes("north"))
    : 0;
  return resizeFreeformViewport(begin, { x: px, y: py }, zoomLevel, dir, aspectRatio);
}

export function resolveResponsiveBrowserViewportSize(
  container: Size,
  zoomFactor?: number,
): WebViewportSize {
  const zoomLevel = zoomOf(zoomFactor);
  const area = resolveBrowserDeviceViewportArea(container);
  return resizeFreeformViewport(
    { width: area.width / zoomLevel, height: area.height / zoomLevel },
    { x: 0, y: 0 },
    zoomLevel,
  );
}

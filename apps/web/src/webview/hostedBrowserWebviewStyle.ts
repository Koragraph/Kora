import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly height: number;
  readonly width: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly pointerEvents: "auto" | "none";
  readonly visibility?: "hidden" | "visible";
  readonly zIndex: number;
  readonly borderRadius?: number;
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET: number = -100_000;

/** Pixel box of the wrapper; the hidden and capture states differ only in where it sits. */
const boxAt = (
  size: HostedBrowserWebviewSize,
  left: number,
  top: number,
): Pick<HostedBrowserWebviewWrapperStyle, "left" | "top" | "width" | "height"> => ({
  left,
  top,
  width: size.width,
  height: size.height,
});

export function resolveHostedBrowserWebviewWrapperStyle(args: {
  readonly hiddenSize: HostedBrowserWebviewSize;
  readonly rect: BrowserSurfaceRect | null;
  readonly active: boolean;
  readonly renderingActive: boolean;
  readonly zIndex?: number;
  readonly cornerRadius?: number;
  readonly keepPaintableWhenInactive?: boolean;
}): HostedBrowserWebviewWrapperStyle {
  const { active, rect, renderingActive, hiddenSize } = args;
  const zIndex = args.zIndex ?? 30;
  const cornerRadius = args.cornerRadius ?? 0;
  const keepPaintableWhenInactive = args.keepPaintableWhenInactive ?? false;

  if (active && rect) {
    const visible: HostedBrowserWebviewWrapperStyle = {
      ...boxAt(rect, rect.x, rect.y),
      zIndex,
      pointerEvents: "auto",
    };
    return cornerRadius > 0 ? { ...visible, borderRadius: cornerRadius } : visible;
  }

  if (renderingActive) {
    // Electron stops compositing a guest that is fully outside the window, even
    // when background throttling is disabled. Keep capture-active guests inside
    // the viewport but behind the app so recordings receive complete frames.
    return {
      ...boxAt(hiddenSize, 0, 0),
      visibility: "visible",
      pointerEvents: "none",
      zIndex: -1,
    };
  }

  const offscreen = HIDDEN_BROWSER_WEBVIEW_OFFSET;
  return {
    ...boxAt(hiddenSize, offscreen, offscreen),
    visibility: keepPaintableWhenInactive ? "visible" : "hidden",
    pointerEvents: "none",
    zIndex: -1,
  };
}

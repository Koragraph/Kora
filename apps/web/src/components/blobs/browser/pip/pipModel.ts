// The floating browser mini-window's pure logic: where it sits (one of four corners of the main content area, never over
// the composer), which corner a drag lands in, and the remembered corner. No React; unit-tested.

export const PIP_CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;
export type PipCorner = (typeof PIP_CORNERS)[number];

export const PIP_DEFAULT_CORNER: PipCorner = "bottom-right";
export const PIP_WIDTH = 360;
const PIP_MIN_WIDTH = 220;
/** Gap to the anchor's edges. */
export const PIP_MARGIN = 16;
/** Gap above the composer. */
export const PIP_COMPOSER_GAP = 12;
/** A top corner clears the page header. */
export const PIP_TOP_INSET = 64;
/** A shown window idle this long (nothing working, nobody needed) ends the browsing session. */
export const PIP_LINGER_MS = 20_000;

export interface PipRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PipInsets {
  readonly left?: number;
  readonly right?: number;
  readonly top?: number;
  readonly bottom?: number;
}

/** 360 px, smaller when the content area is narrow (never wider than the area minus its margins). */
export function pipWidthFor(anchorWidth: number): number {
  return Math.max(PIP_MIN_WIDTH, Math.min(PIP_WIDTH, Math.floor(anchorWidth - 2 * PIP_MARGIN)));
}

const overlapsX = (a: PipRect, b: PipRect) => a.left < b.right && b.left < a.right;

/**
 * CSS insets (for `position: fixed`) that put the box in `corner` of `anchor`. A bottom corner stands on whichever is
 * higher: the anchor's bottom or the top of the composer (`avoid`), so the box never covers the composer or Send.
 */
export function pipInsets(input: {
  readonly anchor: PipRect;
  readonly avoid: PipRect | null;
  readonly corner: PipCorner;
  readonly viewport: { readonly width: number; readonly height: number };
}): PipInsets {
  const { anchor, avoid, corner, viewport } = input;
  const horizontal = corner.endsWith("left")
    ? { left: Math.round(anchor.left + PIP_MARGIN) }
    : { right: Math.round(viewport.width - anchor.right + PIP_MARGIN) };
  if (corner.startsWith("top"))
    return { ...horizontal, top: Math.round(anchor.top + PIP_TOP_INSET) };
  let floor = anchor.bottom - PIP_MARGIN;
  if (avoid && overlapsX(anchor, avoid) && avoid.top - PIP_COMPOSER_GAP < floor)
    floor = avoid.top - PIP_COMPOSER_GAP;
  return { ...horizontal, bottom: Math.round(viewport.height - floor) };
}

/** The corner of `anchor` closest to a point (the dragged box's centre). */
export function nearestCorner(x: number, y: number, anchor: PipRect): PipCorner {
  const midX = (anchor.left + anchor.right) / 2;
  const midY = (anchor.top + anchor.bottom) / 2;
  return `${y < midY ? "top" : "bottom"}-${x < midX ? "left" : "right"}` as PipCorner;
}

export const PIP_CORNER_KEY = "kora.browserPip.corner.v1";

const isCorner = (v: unknown): v is PipCorner =>
  typeof v === "string" && (PIP_CORNERS as ReadonlyArray<string>).includes(v);

/** The remembered corner; the default when storage is empty, blocked or holds junk. */
export function readPipCorner(): PipCorner {
  try {
    const v = globalThis.localStorage?.getItem(PIP_CORNER_KEY);
    return isCorner(v) ? v : PIP_DEFAULT_CORNER;
  } catch {
    return PIP_DEFAULT_CORNER;
  }
}

export function writePipCorner(corner: PipCorner): void {
  try {
    globalThis.localStorage?.setItem(PIP_CORNER_KEY, corner);
  } catch {
    /* private window / blocked storage: the corner just isn't remembered */
  }
}

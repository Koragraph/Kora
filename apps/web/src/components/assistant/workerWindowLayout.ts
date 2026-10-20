/**
 * Pure geometry for the worker floating window (WorkerFloatingWindow.tsx): default placement,
 * the maximized frame, and clamping a dragged position inside the viewport. No React, no DOM —
 * trivial to unit test and reuse from the window's pointer-move handler.
 */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface WindowPosition {
  readonly x: number;
  readonly y: number;
}

export type WindowFrame = WindowPosition & WindowSize;

const EDGE_GAP = 16;
const TOP_INSET = 64;
const BOTTOM_INSET = 120;
const MAXIMIZED_INSET = 24;
/** The app's title bar (Electron drag strip + native traffic lights) lives in the top ~52px;
 *  a maximized window stays below it so neither it nor the window's own controls get covered. */
const MAXIMIZED_TOP_INSET = 56;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

/** The sprite column on the right edge (SwarmBlobDock's gutter): the window opens left of it, so the other sprites
 *  stay clickable while one window is open. */
const DOCK_CLEARANCE = 64;

/** Right side of the viewport, left of the sprites, below the header, above the composer — the opening spot. */
export function defaultWorkerWindowFrame(viewport: WindowSize): WindowFrame {
  const width = Math.max(MIN_WIDTH, Math.min(620, viewport.width * 0.46));
  const height = Math.max(MIN_HEIGHT, viewport.height - TOP_INSET - BOTTOM_INSET);
  const x = Math.max(EDGE_GAP, viewport.width - width - DOCK_CLEARANCE - EDGE_GAP);
  return { x, y: TOP_INSET, width, height };
}

/** Green traffic light: inset evenly on all sides instead of the default right-docked spot. */
export function maximizedWorkerWindowFrame(viewport: WindowSize): WindowFrame {
  return {
    x: MAXIMIZED_INSET,
    y: MAXIMIZED_TOP_INSET,
    width: Math.max(MIN_WIDTH, viewport.width - MAXIMIZED_INSET * 2),
    height: Math.max(MIN_HEIGHT, viewport.height - MAXIMIZED_TOP_INSET - MAXIMIZED_INSET),
  };
}

/** Keeps a dragged position fully on screen, with a small margin off every edge. */
export function clampWorkerWindowPosition(
  position: WindowPosition,
  size: WindowSize,
  viewport: WindowSize,
  margin = 8,
): WindowPosition {
  return {
    x: Math.min(
      Math.max(position.x, margin),
      Math.max(margin, viewport.width - size.width - margin),
    ),
    y: Math.min(
      Math.max(position.y, margin),
      Math.max(margin, viewport.height - size.height - margin),
    ),
  };
}

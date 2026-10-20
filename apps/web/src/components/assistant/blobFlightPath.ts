/**
 * Pure geometry for the "carrying the result" flight (CarryFlightLayer.tsx): a quadratic bezier
 * arc from a done worker's blob to the transcript, so the folded-page glyph has a gentle curve
 * rather than a straight line. No React, no DOM.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** How far above the straight line between start/end the arc's control point sits. */
const ARC_LIFT_PX = 60;

/** Point along the arc at `t` (0 = start, 1 = end), inclusive at both ends. */
export function flightPoint(start: Point, end: Point, t: number): Point {
  const clamped = Math.min(1, Math.max(0, t));
  const controlX = (start.x + end.x) / 2;
  const controlY = Math.min(start.y, end.y) - ARC_LIFT_PX;
  const u = 1 - clamped;
  return {
    x: u * u * start.x + 2 * u * clamped * controlX + clamped * clamped * end.x,
    y: u * u * start.y + 2 * u * clamped * controlY + clamped * clamped * end.y,
  };
}

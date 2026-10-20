import type { SVGAttributes } from "react";

import { BODY_BOX, MONO, composeRows, pixels } from "./sprite";
import { cn } from "../util/utils";

const MARK_PIXELS = pixels(composeRows("idle", null)).filter(
  (p) => p.y >= BODY_BOX.y && p.y < BODY_BOX.y + BODY_BOX.h,
);

/**
 * The kora logo: the plain pixel sprite (classic body, no accessory), cropped to its 8x8 body so it
 * fills whatever box it is given. Inline SVG, so it needs no bitmap and stays crisp; size it in
 * multiples of 8 px (size-6 / size-8 / size-10) to keep every sprite pixel square.
 */
export function KoraMark({ className, ...props }: Omit<SVGAttributes<SVGSVGElement>, "viewBox">) {
  return (
    <svg
      {...props}
      role="img"
      aria-label="kora"
      viewBox={`${BODY_BOX.x} ${BODY_BOX.y} ${BODY_BOX.w} ${BODY_BOX.h}`}
      shapeRendering="crispEdges"
      className={cn("select-none object-contain", className)}
    >
      {MARK_PIXELS.map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width="1" height="1" fill={MONO[p.c]} />
      ))}
    </svg>
  );
}

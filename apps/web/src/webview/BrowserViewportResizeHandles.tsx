import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "~/util/utils";
import {
  type BrowserViewportResizeDirection,
  type BrowserViewportLayout,
  BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
} from "./browserViewportLayout";

type HandleKind = "vertical" | "horizontal" | "corner" | "corner-mirrored";

interface Handle {
  readonly direction: BrowserViewportResizeDirection;
  readonly kind: HandleKind;
  readonly cursor: string;
  readonly label: string;
}

const HANDLES: ReadonlyArray<Handle> = [
  { direction: "west", kind: "vertical", cursor: "ew-resize", label: "left edge" },
  { direction: "east", kind: "vertical", cursor: "ew-resize", label: "right edge" },
  { direction: "south", kind: "horizontal", cursor: "ns-resize", label: "bottom edge" },
  {
    direction: "southwest",
    kind: "corner-mirrored",
    cursor: "nesw-resize",
    label: "bottom-left corner",
  },
  { direction: "southeast", kind: "corner", cursor: "nwse-resize", label: "bottom-right corner" },
];

const bar = "rounded-full bg-current";

function Grip({ kind }: { kind: HandleKind }) {
  if (kind === "vertical") {
    return (
      <span className="flex h-8 w-1.5 items-center justify-center gap-px">
        <span className={cn(bar, "h-6 w-px")} />
        <span className={cn(bar, "h-6 w-px")} />
      </span>
    );
  }
  if (kind === "horizontal") {
    return (
      <span className="flex h-1.5 w-8 flex-col items-center justify-center gap-px">
        <span className={cn(bar, "h-px w-6")} />
        <span className={cn(bar, "h-px w-6")} />
      </span>
    );
  }
  return (
    <span className={cn("relative block size-3", kind === "corner-mirrored" && "-scale-x-100")}>
      <span className={cn(bar, "absolute bottom-[3px] left-0 h-px w-3 -rotate-45")} />
      <span className={cn(bar, "absolute bottom-0 left-[5px] h-px w-2 -rotate-45")} />
    </span>
  );
}

export function BrowserViewportResizeHandles({
  layout,
  activeDirection,
  onPointerDown,
  onKeyDown,
}: {
  readonly onKeyDown: (
    dir: BrowserViewportResizeDirection,
    evt: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly onPointerDown: (
    dir: BrowserViewportResizeDirection,
    evt: PointerEvent<HTMLButtonElement>,
  ) => void;
  readonly activeDirection: BrowserViewportResizeDirection | null;
  readonly layout: BrowserViewportLayout;
}) {
  const R = BROWSER_VIEWPORT_RESIZE_RAIL_SIZE;
  const leftSide = layout.viewportX;
  const upper = layout.viewportY;
  const rightSide = leftSide + layout.viewportWidth;
  const bottom = upper + layout.viewportHeight;

  const placement: Record<string, { left: number; top: number; width: number; height: number }> = {
    west: { left: leftSide - R, top: upper, width: R, height: layout.viewportHeight },
    east: { left: rightSide, top: upper, width: R, height: layout.viewportHeight },
    south: { left: leftSide, top: bottom, width: layout.viewportWidth, height: R },
    southwest: { left: leftSide - R, top: bottom, width: R, height: R },
    southeast: { left: rightSide, top: bottom, width: R, height: R },
  };

  return (
    <>
      {HANDLES.map((handle) => {
        const engaged = activeDirection === handle.direction;
        const isCorner = handle.kind === "corner" || handle.kind === "corner-mirrored";
        return (
          <button
            key={handle.direction}
            type="button"
            aria-label={`Resize browser viewport from ${handle.label}. Use arrow keys to resize.`}
            className={cn(
              "group absolute border-0 bg-transparent p-0 outline-none touch-none",
              "before:absolute before:-inset-1 before:content-['']",
              "focus-visible:bg-foreground/4",
              isCorner ? "z-30" : "z-20",
            )}
            style={{ ...placement[handle.direction], cursor: handle.cursor }}
            onPointerDown={(evt) => onPointerDown(handle.direction, evt)}
            onKeyDown={(evt) => onKeyDown(handle.direction, evt)}
          >
            <span
              className={cn(
                "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center",
                "text-muted-foreground/55 transition-colors duration-150",
                "group-hover:text-foreground/85 group-focus-visible:text-foreground group-active:text-foreground",
                engaged && "text-foreground",
              )}
            >
              <Grip kind={handle.kind} />
            </span>
          </button>
        );
      })}
    </>
  );
}

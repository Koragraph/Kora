import { cn } from "~/util/utils";
import { useResizableWidth } from "~/hooks/useDragWidth";
import { isNative } from "~/env";
import { DockResizeHandle } from "./DockResizeHandle";
import {
  useState,
  type RefObject,
  useEffect,
  type ReactNode,
  useRef,
  useLayoutEffect,
} from "react";

export type WebPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

const VIEWPORT_FRACTION = 0.7;
const DEFAULT_PANEL_MIN = 360;
const DEFAULT_SIBLING_MIN = 360;

export function getWebPanelMaxWidth(
  viewportWidth: number,
  containerWidth?: number,
  limits: { panelMin?: number; siblingMin?: number } = {},
): number {
  const panelMin = limits.panelMin ?? DEFAULT_PANEL_MIN;
  const siblingMin = limits.siblingMin ?? DEFAULT_SIBLING_MIN;
  const fractionCap = Math.floor(VIEWPORT_FRACTION * viewportWidth);
  // The app sidebar sits outside the row, so a viewport fraction alone can crowd out the sibling column.
  const cap =
    containerWidth === undefined
      ? fractionCap
      : Math.min(fractionCap, Math.floor(containerWidth) - siblingMin);
  // Never below the panel minimum: an inverted clamp would persist the minimum over the user's width.
  return Math.max(panelMin, cap);
}

const viewportWidthNow = () => (typeof window === "undefined" ? 1280 : window.innerWidth);

/** Viewport width (one update per frame) and, for inline panels, the width of the row they sit in. */
function useClampedMaxWidth(args: {
  rootRef: RefObject<HTMLElement | null>;
  trackRow: boolean;
  panelMin: number;
  siblingMin: number;
}): number {
  const { rootRef, trackRow, panelMin, siblingMin } = args;
  const [viewport, setViewport] = useState(viewportWidthNow);
  const [row, setRow] = useState<number | undefined>(undefined);

  useEffect(() => {
    let frame: number | null = null;
    const onResize = () => {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        setViewport(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // Measured before the first paint so a stored width is clamped on the very first render.
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!trackRow || !parent) {
      setRow(undefined);
      return;
    }
    const measure = () => setRow(Math.floor(parent.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [rootRef, trackRow]);

  return getWebPanelMaxWidth(viewport, row, { panelMin, siblingMin });
}

export function WebPanelShell({
  mode,
  maximized = false,
  open,
  widthStorageKey = "kora:web-panel-width",
  defaultWidth = 500,
  minWidth = 360,
  siblingMinWidth = 360,
  children,
}: {
  widthStorageKey?: string;
  siblingMinWidth?: number;
  defaultWidth?: number;
  maximized?: boolean;
  children: ReactNode;
  mode: WebPanelMode;
  minWidth?: number;
  open?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inline = mode === "inline";
  const collapsible = inline && open !== undefined;

  const maxWidth = useClampedMaxWidth({
    rootRef,
    trackRow: inline && !maximized,
    panelMin: minWidth,
    siblingMin: siblingMinWidth,
  });
  const { width, handlers } = useResizableWidth({
    storageKey: widthStorageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    edge: "left",
  });

  // Dragging or maximizing must not animate; opening and closing must.
  const [seen, setSeen] = useState({ width, maximized, open });
  const sizeOnlyChange =
    collapsible && seen.open === open && (seen.width !== width || seen.maximized !== maximized);
  if (seen.width !== width || seen.maximized !== maximized || seen.open !== open) {
    setSeen({ width, maximized, open });
  }
  const [holdInstant, setHoldInstant] = useState(false);
  useEffect(() => {
    if (!sizeOnlyChange) return;
    setHoldInstant(true);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setHoldInstant(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [sizeOnlyChange, width, maximized]);
  const instant = sizeOnlyChange || holdInstant;

  const collapsed = collapsible && open === false;
  const style = inline
    ? {
        width: maximized ? "100%" : collapsed ? 0 : width,
        ...(instant ? { transitionDuration: "0ms" } : {}),
        ...(collapsed ? { pointerEvents: "none" as const } : {}),
      }
    : undefined;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        inline ? (maximized ? "flex-1 border-l" : "shrink-0 border-l") : "w-full",
        collapsible &&
          "starting:w-0 in-[[data-panel-animations=true]]:transition-[width] in-[[data-panel-animations=true]]:duration-(--panel-animation-duration) in-[[data-panel-animations=true]]:ease-out",
      )}
      data-web-panel-maximized={maximized ? "true" : "false"}
      data-web-panel-mode={mode}
      ref={rootRef}
      style={style}
    >
      {inline && !maximized ? <DockResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-hidden")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={collapsible && !maximized ? { width: width - 1 } : undefined}
        >
          {isNative && mode !== "sheet" && mode !== "embedded" ? (
            <div aria-hidden="true" className="electron-drag-region h-0" />
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

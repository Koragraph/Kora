// Hosts the slash / mention command menu above the composer. The menu is portalled to <body> so no ancestor
// clips it, then placed from the composer's own geometry (it sits over the drawer inset, on the main surface).
import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Placement {
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

const MIN_MENU_HEIGHT_PX = 96;
const VIEWPORT_MARGIN_PX = 24;

export function PromptCommandMenuLayer(props: {
  readonly anchor: HTMLElement | null;
  readonly children: ReactNode;
}) {
  const { anchor } = props;
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const form = anchor.closest<HTMLElement>("[data-prompt-form]");
    const place = () => {
      const surface =
        form?.querySelector<HTMLElement>("[data-prompt-main-surface]") ?? form ?? anchor;
      const rect = surface.getBoundingClientRect();
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const insetRem =
        Number.parseFloat(
          getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
        ) || 0;
      const inset = insetRem * rootSize;
      // Mirrors --chat-composer-attachment-overlap (1rem + 1px); the extra pixel hides canvas seams.
      const overlap = rootSize + 1;
      const next: Placement = {
        bottom: window.innerHeight - rect.top - overlap,
        left: rect.left + inset,
        width: rect.width - 2 * inset,
        maxHeight: Math.max(MIN_MENU_HEIGHT_PX, rect.top - VIEWPORT_MARGIN_PX + overlap),
      };
      setPlacement((current) =>
        current &&
        current.bottom === next.bottom &&
        current.left === next.left &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The composer is centred and width-capped: a side panel opening moves it without resizing it, so every
    // ancestor is observed, not just the anchor.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (observer) {
      for (let node: Element | null = anchor; node; node = node.parentElement)
        observer.observe(node);
    }
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchor]);

  if (!placement) return null;
  return createPortal(
    <div
      data-prompt-drawer-layer="true"
      className="pointer-events-auto fixed z-40 flex flex-col"
      style={{
        bottom: placement.bottom,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

import { useLayoutEffect, useRef } from "react";

import { acquireBrowserSurface, type BrowserSurfaceLease } from "./browserSurfaceStore";

/**
 * An empty box that reserves layout space for a natively hosted browser surface and keeps
 * telling the surface store where it is on screen.
 */
export function BrowserSurfaceSlot({
  fitSourceContent = false,
  className,
  layoutVersion,
  zIndex = 30,
  cornerRadius = 0,
  visible,
  tabId,
}: {
  readonly fitSourceContent?: boolean;
  readonly className?: string;
  readonly layoutVersion?: string | number;
  readonly zIndex?: number;
  readonly cornerRadius?: number;
  readonly visible: boolean;
  readonly tabId: string;
}) {
  const elem = useRef<HTMLDivElement | null>(null);
  // Props the measuring loop reads without re-acquiring the lease whenever they change.
  const wanted = useRef({ visible, cornerRadius, zIndex });
  const change = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const host = elem.current;
    if (!host) return;
    let lease: BrowserSurfaceLease = acquireBrowserSurface(tabId, fitSourceContent);

    const measure = () => {
      const rectangle = host.getBoundingClientRect();
      const rect = {
        x: Math.round(rectangle.x),
        y: Math.round(rectangle.y),
        width: Math.max(1, Math.round(rectangle.width)),
        height: Math.max(1, Math.round(rectangle.height)),
      };
      const hasArea = rectangle.width > 0 && rectangle.height > 0;
      const { visible: show, cornerRadius: radius, zIndex: z } = wanted.current;
      if (!lease.present(rect, show && hasArea, radius, z) && show) {
        // The lease was taken over: get a fresh one.
        lease.release();
        lease = acquireBrowserSurface(tabId, fitSourceContent);
        lease.present(rect, hasArea, radius, z);
      }
    };
    change.current = measure;
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    window.addEventListener("resize", measure);
    // Capture, so a scroll in any ancestor counts; otherwise the native view drifts.
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      change.current = () => undefined;
      lease.release();
    };
  }, [fitSourceContent, tabId]);

  useLayoutEffect(() => {
    wanted.current = { visible, cornerRadius, zIndex };
    change.current();
  }, [cornerRadius, layoutVersion, visible, zIndex]);

  return <div ref={elem} className={className} data-browser-surface-slot={tabId} />;
}

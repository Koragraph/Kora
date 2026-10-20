import { cn } from "~/util/utils";
import { useEffect, useState, useRef } from "react";

type Props = {
  /** Current zoom factor (1.0 = 100%); changes drive the transient indicator. */
  zoomFactor: number;
};

const ZOOM_EPSILON = 0.001;
const HIDE_AFTER_MS = 1500;

const zoomIndicatorCls1 =
  "pointer-events-none absolute top-3 right-3 z-20 select-none rounded-full border border-border/70 bg-popover/95 px-2.5 py-1 text-xs font-medium text-foreground shadow-md/10 backdrop-blur transition-all duration-200 ease-out";

/**
 * Floating "X%" pill that surfaces in the top-right of the webview area
 * whenever the zoom factor changes, then fades out after a short pause.
 *
 * Suppressed for the first render's value so we don't flash 100% on mount.
 */
export function ZoomIndicator({ zoomFactor }: Props) {
  const timerRef = useRef<number | null>(null);
  const lastFactorRef = useRef(zoomFactor);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const drop = () => {
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    if (Math.abs(lastFactorRef.current - zoomFactor) < ZOOM_EPSILON) {
      return;
    }
    lastFactorRef.current = zoomFactor;
    setVisible(true);
    drop();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setVisible(false);
    }, HIDE_AFTER_MS);
    return drop;
  }, [zoomFactor]);

  const percent = Math.round(zoomFactor * 100) + "%";

  return (
    <div
      className={cn(
        zoomIndicatorCls1,
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1",
      )}
      aria-hidden={!visible}
    >
      {percent}
    </div>
  );
}

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PanelAnimationDurationMs } from "@kora/contracts/clientPrefs";

import { useClientPrefs } from "../hooks/usePrefs";
import { useMediaQuery } from "../hooks/useMediaQuery";

const SuppressionContext = createContext(false);
export const PanelAnimationSuppressionProvider = SuppressionContext.Provider;

/**
 * True until the given key has actually painted (two animation frames), so state a route
 * restores shows instantly and only later user actions animate.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedKey, setPaintedKey] = useState<string | null>(null);
  const suppressed = paintedKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let second = 0;
    const head = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setPaintedKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(head);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

const MAX_FADE_MS = 100;

export function observeResponsiveBreakpointFade(opts: {
  target: HTMLElement;
  container: HTMLElement;
  active: boolean;
  durationMs: PanelAnimationDurationMs;
  breakpoint: { value: number; unit: "px" | "rem" };
}): () => void {
  const { target, container, active, durationMs, breakpoint } = opts;
  if (!active || typeof ResizeObserver === "undefined") return () => {};

  let thresholdPx = breakpoint.value;
  if (breakpoint.unit === "rem") {
    const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    thresholdPx = breakpoint.value * (Number.isFinite(rootSize) ? rootSize : 16);
  }

  let openFlag = container.getBoundingClientRect().width >= thresholdPx;
  let running: Animation | null = null;

  const observer = new ResizeObserver((records) => {
    const rec = records[records.length - 1];
    if (!rec) return;
    const nowExpanded = rec.contentRect.width >= thresholdPx;
    if (nowExpanded === openFlag) return;
    openFlag = nowExpanded;
    running?.cancel();
    running = target.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: Math.min(MAX_FADE_MS, durationMs),
      easing: "ease-out",
    });
  });
  observer.observe(container);

  return () => {
    observer.disconnect();
    running?.cancel();
  };
}

export function usePanelAnimationPrefs(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
} {
  const exitMs = useClientPrefs((sel) => sel.panelAnimationDurationMs);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const suppressed = useContext(SuppressionContext);
  return { active: exitMs > 0 && !reducedMotion && !suppressed, durationMs: exitMs };
}

/** Keeps closing content mounted for `durationMs` so an opt-in exit transition can play. */
export function usePanelPresence<Item>(
  open: boolean,
  val: Item | null,
  withExit: boolean,
  scopeKey: string | null,
  exitMs: PanelAnimationDurationMs,
): { present: boolean; value: Item | null } {
  // `present` trails `open` while an exit transition is allowed to finish.
  const [present, setPresent] = useState(open);
  const retained = useRef<{ scopeKey: string | null; value: Item | null } | null>(
    open ? { scopeKey, value: val } : null,
  );

  // Callers pass fresh objects every render; remember the latest while open without re-running the effect.
  if (open) retained.current = { scopeKey, value: val };

  useEffect(() => {
    if (open || !withExit) {
      setPresent(open);
      return;
    }
    const tmr = setTimeout(() => setPresent(false), exitMs);
    return () => clearTimeout(tmr);
  }, [open, scopeKey, withExit, exitMs]);

  const keep = retained.current;
  const shown = open || (withExit && present && keep !== null && keep.scopeKey === scopeKey);
  return {
    present: shown,
    value: open ? val : shown ? (keep?.value ?? null) : null,
  };
}

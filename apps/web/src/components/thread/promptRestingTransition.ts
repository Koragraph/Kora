// The composer's collapse / expand tween. When the resting flag flips the box animates between its two heights
// instead of jumping; everything it touches while doing so is restored when the tween ends. (The composer
// currently never rests on scroll, so this stays dormant, but the layout contract is kept intact.)

import { useLayoutEffect, type RefObject, useRef } from "react";

const DURATION_MS = 280;
const CLEANUP_BUFFER_MS = 50;
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const CONTROLS_DRIFT_PX = 4;
const MIN_HEIGHT_DELTA_PX = 0.5;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function offsetFromBottom(element: Element | null, bottom: number): number | null {
  return element ? bottom - element.getBoundingClientRect().bottom : null;
}

export function usePromptRestingTransition(
  isCollapsed: boolean,
  isResting: boolean,
  restingControlsRef: RefObject<HTMLElement | null>,
  onOverlayHeightChange: () => void,
): RefObject<HTMLDivElement | null> {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<{
    collapsed: boolean;
    resting: boolean;
    height: number;
    bottom: number;
  } | null>(null);
  const runningRef = useRef<{ cancel: () => void } | null>(null);
  const publishRef = useRef(onOverlayHeightChange);
  publishRef.current = onOverlayHeightChange;

  // Keep the last settled geometry current while nothing animates.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (runningRef.current) return;
      const rect = element.getBoundingClientRect();
      const last = lastRef.current;
      if (last) lastRef.current = { ...last, height: rect.height, bottom: rect.bottom };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const previous = lastRef.current;
    lastRef.current = {
      collapsed: isCollapsed,
      resting: isResting,
      height: rect.height,
      bottom: rect.bottom,
    };
    if (!previous) return;

    if (previous.collapsed === isCollapsed) {
      if (previous.resting !== isResting) publishRef.current();
      return;
    }
    const delta = Math.abs(previous.height - rect.height);
    if (
      delta < MIN_HEIGHT_DELTA_PX ||
      prefersReducedMotion() ||
      typeof element.animate !== "function"
    ) {
      publishRef.current();
      return;
    }

    runningRef.current?.cancel();
    const expanding = !isCollapsed;
    const overlay = element.closest<HTMLElement>("[data-prompt-overlay]");
    const footer = element.querySelector<HTMLElement>("[data-prompt-footer]");
    const prompt = element.querySelector<HTMLElement>(
      '[data-testid="composer-editor"], [data-prompt-transition-prompt]',
    );
    const actions = element.querySelector<HTMLElement>("[data-prompt-transition-actions]");
    const arriving = expanding
      ? element.querySelector<HTMLElement>('[data-prompt-controls="left"]')
      : restingControlsRef.current;

    const saved = new Map<HTMLElement, string>();
    const pin = (target: HTMLElement | null, css: Partial<CSSStyleDeclaration>) => {
      if (!target) return;
      saved.set(target, target.style.cssText);
      Object.assign(target.style, css);
    };
    const promptShift = offsetFromBottom(prompt, previous.bottom);
    const actionsShift = offsetFromBottom(actions, previous.bottom);

    pin(overlay, {
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      height: `${Math.max(previous.height, rect.height)}px`,
    });
    pin(element, { overflow: "clip" });
    if (footer) {
      pin(footer, {
        position: "absolute",
        bottom: "1px",
        height: "3rem",
        ...(expanding ? { left: "1px", right: "1px" } : { right: "1px" }),
      });
    }

    const animations: Animation[] = [];
    animations.push(
      element.animate([{ height: `${previous.height}px` }, { height: `${rect.height}px` }], {
        duration: DURATION_MS,
        easing: EASING,
      }),
    );
    const slide = (target: HTMLElement | null, from: number | null, now: number | null) => {
      if (!target || from === null || now === null) return;
      const offset = from - now;
      if (Math.abs(offset) < MIN_HEIGHT_DELTA_PX) return;
      animations.push(
        target.animate([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }], {
          duration: DURATION_MS,
          easing: EASING,
        }),
      );
    };
    slide(prompt, promptShift, offsetFromBottom(prompt, rect.bottom));
    slide(actions, actionsShift, offsetFromBottom(actions, rect.bottom));
    if (arriving) {
      const drift = expanding ? CONTROLS_DRIFT_PX : -CONTROLS_DRIFT_PX;
      animations.push(
        arriving.animate(
          [
            { opacity: 0, transform: `translateY(${drift}px)` },
            { opacity: 1, transform: "translateY(0)" },
          ],
          {
            duration: expanding ? DURATION_MS / 2 : DURATION_MS,
            delay: expanding ? DURATION_MS / 2 : 0,
            easing: EASING,
            fill: "backwards",
          },
        ),
      );
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const animation of animations) animation.cancel();
      for (const [target, css] of saved) target.style.cssText = css;
      runningRef.current = null;
      publishRef.current();
    };
    // The document timeline can be suspended (hidden window); a wall-clock timeout still restores the layout.
    const timer = setTimeout(finish, DURATION_MS + CLEANUP_BUFFER_MS);
    animations[0]!.addEventListener("finish", finish, { once: true });
    runningRef.current = { cancel: finish };
  }, [isCollapsed, isResting, restingControlsRef]);

  useLayoutEffect(() => () => runningRef.current?.cancel(), []);

  return elementRef;
}

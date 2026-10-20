"use client";

import { useLayoutEffect, type ReactNode, useEffect, useState, useRef } from "react";

interface HeightState {
  readonly height: number | null;
  readonly clipping: boolean;
}

// Clipping is released by transitionend; this covers transitions that never fire (reduced motion, no change).
const CLIP_FALLBACK_MS = 250;

/**
 * Wraps content and eases its box between heights. Overflow is only clipped while a resize is in flight so
 * popovers and focus rings are never cut off at rest. `holdHeight` freezes the last measured height.
 */
export function AnimatedHeight({
  holdHeight = false,
  children,
}: {
  readonly holdHeight?: boolean;
  readonly children: ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HeightState>({ height: null, clipping: false });

  useLayoutEffect(() => {
    if (holdHeight) return;
    const content = contentRef.current;
    if (!content) return;

    const frames: number[] = [];
    const cancelFrames = () => {
      while (frames.length > 0) cancelAnimationFrame(frames.pop()!);
    };

    const measure = () => {
      const measured = content.scrollHeight || content.getBoundingClientRect().height;
      const next = Math.ceil(measured);
      setState((prev) =>
        prev.height === next
          ? prev
          : { height: next, clipping: prev.height !== null ? true : prev.clipping },
      );
    };

    // Measure now, then on the next two frames to catch layout that settles late.
    const schedule = () => {
      cancelFrames();
      measure();
      frames.push(
        requestAnimationFrame(() => {
          measure();
          frames.push(requestAnimationFrame(measure));
        }),
      );
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelFrames();
    };
  }, [holdHeight]);

  useEffect(() => {
    if (!state.clipping) return;
    const timer = window.setTimeout(
      () => setState((prev) => (prev.clipping ? { ...prev, clipping: false } : prev)),
      CLIP_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.height, state.clipping]);

  return (
    <div
      ref={outerRef}
      data-slot="animated-height"
      className="transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={
        state.height === null
          ? undefined
          : { height: state.height, overflow: state.clipping ? "hidden" : "visible" }
      }
      onTransitionEnd={(event) => {
        if (event.target === outerRef.current && event.propertyName === "height") {
          setState((prev) => (prev.clipping ? { ...prev, clipping: false } : prev));
        }
      }}
    >
      <div ref={contentRef} style={holdHeight ? { height: "100%" } : undefined}>
        {children}
      </div>
    </div>
  );
}

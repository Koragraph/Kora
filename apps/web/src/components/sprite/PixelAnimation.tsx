/**
 * PixelAnimation: plays one of the gallery's frame animations (pixelFrames.ts) like a game sprite - whole 12x12
 * frames swapped on per-frame durations, crisp SVG rects at a whole-pixel scale, no CSS transforms. Every mounted
 * animation shares one timer (frameClock.ts) and pauses while scrolled off screen (util/visibleAnimation, fail-open).
 * Under prefers-reduced-motion it shows frame 0 only.
 */
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { watchVisibleAnimation } from "~/util/visibleAnimation";

import { playFrames } from "./frameClock";
import { ANIMATIONS, type AnimFrame, type AnimationName, type FrameRows } from "./pixelFrames";
import { GRID, MONO, spriteScale } from "./spriteData";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function reducedSnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}
/** Whether the user prefers reduced motion (false on the server). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, reducedSnapshot, () => false);
}

/** One <path> per palette colour, horizontal runs merged. `palette` defaults to MONO. */
export function FramePaths({
  rows,
  palette = MONO,
}: {
  rows: FrameRows;
  palette?: Readonly<Record<string, string>>;
}) {
  const byColour = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x]!;
      if (c === ".") {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w] === c) w++;
      byColour.set(c, `${byColour.get(c) ?? ""}M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  });
  return (
    <>
      {[...byColour].map(([c, d]) => (
        <path key={c} d={d} fill={palette[c]} />
      ))}
    </>
  );
}

export interface PixelAnimationProps {
  readonly name: AnimationName;
  /** Nominal box in px; snapped to a whole multiple of 12. */
  readonly size?: number;
  /** Force reduced motion (frame 0 only); default follows prefers-reduced-motion. */
  readonly reducedMotion?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
}

export function PixelAnimation({
  name,
  size = 24,
  reducedMotion,
  className,
  style,
}: PixelAnimationProps) {
  const frames: readonly AnimFrame[] = ANIMATIONS[name];
  const systemReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (reduced || frames.length < 2) return;
    const player = playFrames(
      frames.map((f) => f.ms),
      setIdx,
      true,
    );
    const stopObserving = watchVisibleAnimation(ref.current, (running) =>
      player.setRunning(running),
    );
    return () => {
      stopObserving?.();
      player.dispose();
    };
  }, [frames, reduced]);

  const scale = spriteScale(size);
  const box = scale * GRID;
  const shownIdx = reduced ? 0 : idx % frames.length;
  const rows = frames[shownIdx]!.rows;
  const paths = useMemo(() => <FramePaths rows={rows} />, [rows]);
  return (
    <span
      ref={ref}
      className={["px-anim inline-block", className].filter(Boolean).join(" ")}
      data-anim={name}
      data-frame={shownIdx}
      style={{ width: box, height: box, ...style }}
      aria-hidden
    >
      <svg
        width={box}
        height={box}
        viewBox={`0 0 ${GRID} ${GRID}`}
        shapeRendering="crispEdges"
        focusable="false"
        aria-hidden
        style={{ display: "block" }}
      >
        {paths}
      </svg>
    </span>
  );
}

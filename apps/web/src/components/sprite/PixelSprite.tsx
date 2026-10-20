/**
 * PixelSprite: Kora's 12x12 pixel creature as crisp SVG. Integer-scaled (every sprite pixel is a
 * whole number of CSS px), mono palette, one optional accessory, state frames and whole-pixel
 * motion (sprite.css, `steps()` timing only). Under prefers-reduced-motion (or `still`) it shows a
 * static frame and the state stays readable from the pixels alone (?, z, ^^, xx).
 */
import {
  type CSSProperties,
  type PointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import "./sprite.css";
import { type SpriteMotion, useSpriteMotion } from "./spriteMotion";
import {
  GRID,
  MONO,
  type Px,
  type SpriteAccessory,
  type SpriteState,
  eyesMovable,
  layersFor,
  spriteScale,
} from "./spriteData";

export type SpriteReaction = "wave" | "celebrate" | "nod" | "hop" | "shake" | "press";

/** How long the press reaction plays (keep in step with px-press in sprite.css). */
export const PRESS_REACTION_MS = 1000;

export interface PixelSpriteProps {
  accessory?: SpriteAccessory | null;
  state?: SpriteState;
  /** Nominal box in px; snapped to a whole multiple of 12 (12/24/36/48/60/72/96...). */
  size?: number;
  /** The Chief wears the crown unless it was given an accessory. */
  chief?: boolean;
  /** Force the static look (default: follows prefers-reduced-motion via CSS). */
  reducedMotion?: boolean;
  /** Inert: no ambient motion AND no press reaction (picker thumbnails, dialogs). */
  still?: boolean;
  /**
   * "ambient" animates (sidebar nav); "still" shows one frame and plays a ~1 s reaction when pressed.
   * Default: the SpriteMotion context, which is "still" everywhere except inside the nav.
   */
  motion?: SpriteMotion;
  /** Declarative transient reaction; ignored while the sprite is still (BlobAvatar drives its own through the root's data-reaction). */
  reaction?: SpriteReaction | null;
  /** Mouth pixel that opens and closes (the avatar's "talking"). */
  talking?: boolean;
  /** Static eye offset in whole pixels (thinking: glance up-left). */
  look?: { x: -1 | 0 | 1; y: -1 | 0 | 1 } | undefined;
  /** Phase seed in [0, 1): offsets hop/blink so a crowd does not move in lockstep. */
  phase?: number;
  /** Accessible name; decorative (aria-hidden) when omitted. */
  label?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  ref?: Ref<HTMLSpanElement>;
}

/** One <path> per palette colour: a rect per pixel run, merged horizontally. */
function pathsFor(pxs: readonly Px[]) {
  const byColour = new Map<string, Px[]>();
  for (const p of pxs) {
    const list = byColour.get(p.c) ?? [];
    list.push(p);
    byColour.set(p.c, list);
  }
  return [...byColour.entries()].map(([c, list]) => {
    let d = "";
    const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < sorted.length;) {
      const start = sorted[i]!;
      let w = 1;
      while (sorted[i + w] && sorted[i + w]!.y === start.y && sorted[i + w]!.x === start.x + w) w++;
      d += `M${start.x} ${start.y}h${w}v1h-${w}z`;
      i += w;
    }
    return <path key={c} d={d} fill={MONO[c]} />;
  });
}

export function PixelSprite({
  accessory = null,
  state = "idle",
  size = 24,
  chief = false,
  reducedMotion = false,
  still = false,
  motion,
  reaction = null,
  phase = 0,
  talking = false,
  look,
  label,
  className,
  style,
  ref,
}: PixelSpriteProps) {
  const ctxMotion = useSpriteMotion();
  const holdStill = still || (motion ?? ctxMotion) === "still";
  const pressable = !still && holdStill && !reducedMotion;
  const [pressing, setPressing] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPress = useCallback((e: PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || pressTimer.current) return;
    setPressing(true);
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      setPressing(false);
    }, PRESS_REACTION_MS);
  }, []);
  useEffect(
    () => () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );
  const shownReaction = holdStill ? (pressable && pressing ? "press" : null) : reaction;

  const acc = accessory ?? (chief ? "crown" : null);
  const scale = spriteScale(size);
  const box = scale * GRID;
  const layers = useMemo(() => layersFor(state, acc), [state, acc]);

  const rootStyle = {
    width: box,
    height: box,
    "--px-u": `${scale}px`,
    "--px-delay": `${(-phase * 3.6).toFixed(2)}s`,
    "--px-blink": `${(4.6 + phase * 3).toFixed(2)}s`,
    ...(look && eyesMovable(state, acc) ? { "--ex": look.x, "--ey": look.y } : null),
    ...style,
  } as CSSProperties;

  const classes = [
    "px-sprite",
    holdStill && "px-sprite--still",
    reducedMotion && "px-sprite--reduced",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      ref={ref}
      className={classes}
      data-state={state}
      data-chief={chief || undefined}
      data-accessory={acc ?? undefined}
      data-reaction={shownReaction ?? undefined}
      data-motion={holdStill ? "still" : "ambient"}
      onPointerDown={pressable ? onPress : undefined}
      data-scale={scale}
      style={rootStyle}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        className="px-sprite__svg"
        viewBox={`0 0 ${GRID} ${GRID}`}
        shapeRendering="crispEdges"
        focusable="false"
        aria-hidden
      >
        <g className="px-st">
          <g className="px-body">{pathsFor(layers.body)}</g>
          <g className="px-legs px-legs--rest">{pathsFor(layers.legs.rest)}</g>
          <g className="px-legs px-legs--a">{pathsFor(layers.legs.a)}</g>
          <g className="px-legs px-legs--b">{pathsFor(layers.legs.b)}</g>
          <g className="px-look">
            <g className="px-eyes">{pathsFor(layers.eyes)}</g>
            {layers.happyEyes.length > 0 && layers.eyesMovable ? (
              <g className="px-eyes-happy">{pathsFor(layers.happyEyes)}</g>
            ) : null}
            {layers.eyesMovable ? (
              <g className="px-lid">
                <path d="M3 6h1v1h-1zM7 6h1v1h-1z" fill={MONO.W} />
              </g>
            ) : null}
          </g>
          <g className="px-acc">{pathsFor(layers.accessory)}</g>
          {talking ? (
            <g className="px-mouth">
              <path d="M5 8h1v1h-1z" fill={MONO.K} />
            </g>
          ) : null}
          {layers.mark.length > 0 ? <g className="px-mark">{pathsFor(layers.mark)}</g> : null}
        </g>
      </svg>
    </span>
  );
}

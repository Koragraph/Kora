/**
 * The Blobs avatar: Kora's pixel sprite (components/sprite) wearing at most one accessory. This file
 * keeps the avatar API the rest of the app uses (states, reactions, sizes, chief, eye-follow) and
 * maps it onto PixelSprite frames; all art and motion live in the shared sprite module.
 * See ./index.ts for the public surface.
 */
import {
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import {
  PixelSprite,
  type SpriteMotion,
  type SpriteState,
  eyesMovable,
  useSpriteMotion,
} from "~/components/sprite";
import "./blobAvatar.css";
import { followPointer } from "./eyeFollow";
import { type BlobOutfit, hashString } from "./outfit";
import { spriteAccessoryFor } from "./spriteMap";

/** Nominal sizes; the sprite snaps each to a whole multiple of 12 px so its pixels stay square. */
export const BLOB_SIZES = [12, 24, 36, 48, 60, 96, 144] as const;
export type BlobSize = (typeof BLOB_SIZES)[number];

export type BlobVisualState =
  | "idle"
  | "thinking"
  | "working"
  | "talking"
  | "streaming"
  | "waiting"
  | "done"
  | "failed"
  | "offline"
  | "archived"
  | "sleeping";

export const BLOB_STATES: readonly BlobVisualState[] = [
  "idle",
  "thinking",
  "working",
  "talking",
  "streaming",
  "waiting",
  "done",
  "failed",
  "offline",
  "archived",
  "sleeping",
];

export type BlobReaction = "wave" | "celebrate" | "nod";
export const BLOB_REACTIONS: readonly BlobReaction[] = ["wave", "celebrate", "nod"];

const REACTION_MS: Record<BlobReaction, number> = { wave: 1650, celebrate: 1450, nod: 750 };

/** How much larger the Chief renders than the same `size` of any other blob. */
const CHIEF_SCALE = 1.2;

export interface BlobAvatarHandle {
  /** Play a transient reaction now (restarts it if one is already running). */
  play: (reaction: BlobReaction) => void;
}

export interface BlobAvatarProps {
  outfit?: BlobOutfit;
  state?: BlobVisualState;
  /** Nominal size in px. The Chief is drawn CHIEF_SCALE times larger (see `chiefScale`). */
  size?: BlobSize | number;
  chief?: boolean;
  /** Show the small "Chief" badge under a chief (only drawn from 40px up). */
  badge?: boolean;
  /** Override the Chief's size multiplier (1 = same box as everyone). */
  chiefScale?: number;
  /** Eyes track the pointer, a whole pixel at a time. Default: on for sizes >= 24. */
  eyesFollowCursor?: boolean;
  /** Declarative reaction: plays on mount and whenever `reaction` or `reactionKey` changes. */
  reaction?: BlobReaction | null;
  reactionKey?: string | number;
  /** Inert: no motion and no press reaction (picker thumbnails, print). Reactions no-op. */
  still?: boolean;
  /**
   * "ambient" animates (the sidebar nav provides it through SpriteMotionProvider); "still" is one frame that
   * plays a ~1 s reaction when pressed. Default: the context, "still" outside the nav. While still, the
   * declarative `reaction`, `play()` and eye-follow are off.
   */
  motion?: SpriteMotion;
  /** Force the reduced-motion look (default: follows prefers-reduced-motion). */
  reducedMotion?: boolean;
  /** Stable seed for the hop/blink phase (default: derived from the instance). */
  seed?: string | number;
  /** Accessible name. When omitted the avatar is decorative (aria-hidden). */
  label?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<BlobAvatarHandle>;
}

interface SpriteLook {
  readonly state: SpriteState;
  readonly talking: boolean;
  readonly glance: boolean;
}

function spriteLookFor(state: BlobVisualState): SpriteLook {
  switch (state) {
    case "thinking":
      return { state: "idle", talking: false, glance: true };
    case "working":
      return { state: "walk", talking: false, glance: false };
    case "talking":
    case "streaming":
      return { state: "idle", talking: true, glance: false };
    case "waiting":
      return { state: "wait", talking: false, glance: false };
    case "done":
      return { state: "done", talking: false, glance: false };
    case "failed":
      return { state: "fail", talking: false, glance: false };
    case "offline":
    case "archived":
      return { state: "off", talking: false, glance: false };
    case "sleeping":
      return { state: "sleep", talking: false, glance: false };
    default:
      return { state: "idle", talking: false, glance: false };
  }
}

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

export function BlobAvatar({
  outfit,
  state = "idle",
  size = 56,
  chief = false,
  badge = false,
  chiefScale = CHIEF_SCALE,
  eyesFollowCursor,
  reaction = null,
  reactionKey,
  still = false,
  motion,
  reducedMotion,
  seed,
  label,
  className,
  style,
  ref,
}: BlobAvatarProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const instanceId = useId();
  const systemReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const ctxMotion = useSpriteMotion();
  const ambient = !still && (motion ?? ctxMotion) === "ambient";

  const look = spriteLookFor(state);
  const px = chief ? size * chiefScale : size;
  // One accessory per blob (head, else face). The Chief is the plain sprite plus a crown unless it was
  // given an accessory of its own.
  const accessory = spriteAccessoryFor(outfit, chief);
  const movable = eyesMovable(look.state, accessory);
  const follow = (eyesFollowCursor ?? size >= 24) && !reduced && ambient && movable && !look.glance;

  const phase = useMemo(
    () => (hashString(String(seed ?? instanceId)) % 1000) / 1000,
    [seed, instanceId],
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!follow || !el) return;
    return followPointer(el);
  }, [follow]);

  const play = useCallback(
    (kind: BlobReaction) => {
      const el = rootRef.current;
      if (!el || !ambient) return;
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
      el.removeAttribute("data-reaction");
      // Force a style flush so re-playing the same reaction restarts its animation.
      void el.getBoundingClientRect();
      el.setAttribute("data-reaction", kind);
      reactionTimer.current = setTimeout(() => {
        el.removeAttribute("data-reaction");
        reactionTimer.current = null;
      }, REACTION_MS[kind]);
    },
    [ambient],
  );

  useImperativeHandle(ref, () => ({ play }), [play]);

  useEffect(() => {
    if (reaction && ambient) play(reaction);
  }, [reaction, reactionKey, ambient, play]);

  useEffect(
    () => () => {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
    },
    [],
  );

  return (
    <span
      className={["blob-av", className].filter(Boolean).join(" ")}
      style={{ ...style }}
      data-chief={chief || undefined}
      data-visual-state={state}
    >
      <PixelSprite
        ref={rootRef}
        state={look.state}
        accessory={accessory}
        size={px}
        chief={chief}
        talking={look.talking}
        look={look.glance ? { x: -1, y: -1 } : undefined}
        still={still}
        motion={ambient ? "ambient" : "still"}
        reducedMotion={reduced}
        phase={phase}
        label={label}
      />
      {chief && badge && px >= 40 ? <span className="blob-av__badge">Chief</span> : null}
    </span>
  );
}

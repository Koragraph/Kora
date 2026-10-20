/**
 * The lead agent's tiny pixel sprite in the transcript, sitting inline with the live activity
 * rows. Mood only, never text: `working` while the turn runs - it stands in for the live tool row's icon and plays
 * one frame animation from the working set (sprite/pixelFrames.ts), picked per turn from `seed` - `attentive`
 * once the reply is done, `asleep` after the thread has been quiet a while, `still` (dimmed) under older replies.
 * The resting moods are still frames (sprite/spriteMotion.tsx); the working animation is the frame engine's, which
 * holds frame 0 under reduced motion.
 */
import { useState } from "react";

import {
  PixelAnimation,
  PixelSprite,
  pickWorkingAnimation,
  type SpriteState,
} from "~/components/sprite";

export type LeadBlobMood = "working" | "attentive" | "asleep" | "still";

const STATE: Record<Exclude<LeadBlobMood, "working">, SpriteState> = {
  attentive: "idle",
  asleep: "sleep",
  still: "idle",
};

/** The turn's working animation: stable for one seed, different on the next turn. */
function WorkingSprite({ seed }: { seed: string | null | undefined }) {
  // No turn id / start time yet: a per-mount seed keeps it stable across re-renders.
  const [fallback] = useState(() => `mount:${Math.random()}`);
  return <PixelAnimation name={pickWorkingAnimation(seed || fallback)} size={24} />;
}

export function LeadBlob({ mood, seed }: { mood: LeadBlobMood; seed?: string | null }) {
  return (
    // The 24px sprite box is mostly air (the body is 16px); negative margins keep the row height.
    <span
      className="lead-blob inline-grid shrink-0 -my-1 -mx-0.5"
      data-mood={mood}
      style={mood === "still" ? { opacity: 0.45 } : undefined}
      aria-hidden
    >
      {mood === "working" ? (
        <WorkingSprite seed={seed} />
      ) : (
        <PixelSprite state={STATE[mood]} size={24} />
      )}
    </span>
  );
}

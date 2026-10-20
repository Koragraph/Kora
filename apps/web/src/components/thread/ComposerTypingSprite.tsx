/**
 * The "Code screen" typing sprite on the Code composer's top edge (typingSpriteMachine.ts): it climbs over the edge on
 * the first keystroke that leaves text in the draft, types at a little monitor while keys keep coming, thinks with a
 * bubble after TYPING_TO_THINK_MS, looks around once after THINK_TO_LOOK_MS more and then sits idle. It never sinks
 * while the draft has text; it goes back down only when the draft empties (deleted, or sent).
 *
 * Cheap and inert: it listens (capture phase) to `beforeinput` / `input` events inside the composer itself, and ChatPrompt passes only
 * a boolean `hasText` (this memo'd component re-renders when it flips, not per keystroke). It is `pointer-events: none`,
 * takes no layout space and never takes focus. Reduced motion skips it entirely.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import {
  CODE_H,
  CODE_IDLE,
  CODE_LOOK,
  CODE_RISE,
  CODE_SINK,
  CODE_THINK,
  CODE_TYPE,
  CODE_W,
  FramePaths,
  type AnimFrame,
  usePrefersReducedMotion,
} from "~/components/sprite";
import { playFrames } from "~/components/sprite/frameClock";

import { TypingSpriteMachine, type TypingView } from "./typingSpriteMachine";

const SCALE = 2; // 40x28: the 20x14 scene at 2x; its bottom row (the keyboard's shadow) sits on the edge
const WIDTH = CODE_W * SCALE;
const HEIGHT = CODE_H * SCALE;

/** Whether an input event came from the prompt editor (not the attach file input, a picker search, ...). */
function fromEditor(event: Event): boolean {
  const t = event.target;
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "TEXTAREA");
}

export type TypingSpriteShows =
  | { readonly loop: readonly AnimFrame[] }
  | { readonly still: readonly string[] }
  | null;

/** What the sprite shows for a machine view: nothing, one still frame, or a looping animation. */
export function typingSpriteShows(view: TypingView, reduced: boolean): TypingSpriteShows {
  if (reduced) return null;
  switch (view.phase) {
    case "hidden":
      return null;
    case "rising":
      return still(CODE_RISE[view.frame]);
    case "settling":
      return still(CODE_SINK[view.frame]);
    case "lookaround":
      return still(CODE_LOOK[view.frame]);
    case "typing":
      return { loop: CODE_TYPE };
    case "thinking":
      return { loop: CODE_THINK };
    case "idle":
      return { loop: CODE_IDLE };
  }
}
const still = (f: AnimFrame | undefined): TypingSpriteShows => (f ? { still: f.rows } : null);

function Scene({ rows }: { rows: readonly string[] }) {
  const paths = useMemo(() => <FramePaths rows={rows} />, [rows]);
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${CODE_W} ${CODE_H}`}
      shapeRendering="crispEdges"
      focusable="false"
      aria-hidden
      style={{ display: "block" }}
    >
      {paths}
    </svg>
  );
}

/** Loops frames on the shared frame clock (one timer for every pixel animation). */
function Loop({ frames }: { frames: readonly AnimFrame[] }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const player = playFrames(
      frames.map((f) => f.ms),
      setIdx,
    );
    return () => player.dispose();
  }, [frames]);
  const shown = idx % frames.length;
  return (
    <span data-frame={shown} style={{ display: "contents" }}>
      <Scene rows={frames[shown]!.rows} />
    </span>
  );
}

export const ComposerTypingSprite = memo(function ComposerTypingSprite({
  enabled,
  hasText,
  hidden = false,
  reducedMotion,
}: {
  /** The composer takes input; when it stops with text in the draft the sprite sits idle. */
  readonly enabled: boolean;
  /** The draft has text; it only ever sinks when this turns false. */
  readonly hasText: boolean;
  /** Something else owns the edge (a banner, a drawer, a blob lane): show nothing, no animation. */
  readonly hidden?: boolean;
  /** Force reduced motion (tests); default follows prefers-reduced-motion. */
  readonly reducedMotion?: boolean;
}) {
  const systemReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const machineRef = useRef<TypingSpriteMachine | null>(null);
  const enabledRef = useRef(enabled);
  const hasTextRef = useRef(hasText);
  const [view, setView] = useState<TypingView>({ phase: "hidden", frame: 0 });

  useEffect(() => {
    if (reduced) return;
    // The listener sits on the composer wrapper this sprite is rendered into.
    const host = anchorRef.current?.parentElement;
    if (!host) return;
    const machine = new TypingSpriteMachine(setView);
    machine.setEnabled(enabledRef.current);
    machine.setHasText(hasTextRef.current);
    machineRef.current = machine;
    const onInput = (event: Event) => {
      if (fromEditor(event)) machine.input();
    };
    // Capture phase: the prompt editor stops its input events from bubbling. `beforeinput` too: the editor cancels it
    // and edits the DOM itself in some cases (the first character in an empty box, Backspace), so no `input` follows.
    host.addEventListener("beforeinput", onInput, true);
    host.addEventListener("input", onInput, true);
    return () => {
      host.removeEventListener("beforeinput", onInput, true);
      host.removeEventListener("input", onInput, true);
      machine.dispose();
      machineRef.current = null;
      setView({ phase: "hidden", frame: 0 });
    };
  }, [reduced]);

  useEffect(() => {
    enabledRef.current = enabled;
    machineRef.current?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    hasTextRef.current = hasText;
    machineRef.current?.setHasText(hasText);
  }, [hasText]);

  const shows = hidden ? null : typingSpriteShows(view, reduced);
  return (
    <span
      ref={anchorRef}
      data-composer-typing-sprite={hidden ? "hidden" : view.phase}
      data-composer-typing-frame={view.frame}
      aria-hidden
      className="pointer-events-none absolute bottom-full left-7 z-0 overflow-hidden select-none"
      style={{ width: WIDTH, height: HEIGHT }}
    >
      {shows === null ? null : "loop" in shows ? (
        <Loop key={view.phase} frames={shows.loop} />
      ) : (
        <Scene rows={shows.still} />
      )}
    </span>
  );
});

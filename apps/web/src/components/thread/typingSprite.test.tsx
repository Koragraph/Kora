import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CODE_IDLE,
  CODE_LOOK,
  CODE_RISE,
  CODE_SINK,
  CODE_THINK,
  CODE_TYPE,
  PixelAnimation,
} from "~/components/sprite";

import { ComposerTypingSprite, typingSpriteShows } from "./ComposerTypingSprite";
import {
  THINK_TO_LOOK_MS,
  TYPING_TO_THINK_MS,
  TypingSpriteMachine,
  type TypingPhase,
  type TypingView,
} from "./typingSpriteMachine";

const sum = (frames: readonly { ms: number }[]) => frames.reduce((t, f) => t + f.ms, 0);
const riseMs = sum(CODE_RISE);
const sinkMs = sum(CODE_SINK);
const lookMs = sum(CODE_LOOK);
const LONG = 60_000;

function machine() {
  const seen: TypingView[] = [];
  const m = new TypingSpriteMachine((v) => seen.push(v));
  const phases = () => seen.map((v) => v.phase).filter((p, i, a) => p !== a[i - 1]);
  /** One keystroke that leaves text in the draft (the input event first, then the draft update). */
  const key = () => {
    m.input();
    m.setHasText(true);
  };
  return { m, seen, phases, key, phase: (): TypingPhase => m.current.phase };
}

/** A machine already up and typing. */
function typing() {
  const t = machine();
  t.key();
  vi.advanceTimersByTime(riseMs);
  expect(t.phase()).toBe("typing");
  return t;
}

describe("typing sprite state machine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hidden -> rising -> typing -> 500 ms -> thinking -> 5 s -> lookaround -> idle, and stays idle", () => {
    expect(TYPING_TO_THINK_MS).toBe(500);
    expect(TYPING_TO_THINK_MS + THINK_TO_LOOK_MS).toBe(5000);
    const { seen, phases, phase, key } = machine();
    expect(phase()).toBe("hidden");
    key();
    expect(phase()).toBe("rising");
    vi.advanceTimersByTime(riseMs);
    expect(phase()).toBe("typing");
    expect(seen.filter((v) => v.phase === "rising").map((v) => v.frame)).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(TYPING_TO_THINK_MS - 1);
    expect(phase()).toBe("typing");
    vi.advanceTimersByTime(1);
    expect(phase()).toBe("thinking");
    vi.advanceTimersByTime(THINK_TO_LOOK_MS - 1);
    expect(phase()).toBe("thinking");
    vi.advanceTimersByTime(1);
    expect(phase()).toBe("lookaround");
    vi.advanceTimersByTime(lookMs);
    expect(phase()).toBe("idle");
    expect(seen.filter((v) => v.phase === "lookaround").map((v) => v.frame)).toEqual(
      CODE_LOOK.map((_, i) => i),
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(LONG);
    expect(phases()).toEqual(["rising", "typing", "thinking", "lookaround", "idle"]);
  });

  it("keeps typing while keys keep coming (each key restarts the 500 ms wait)", () => {
    const { m, phase } = typing();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(TYPING_TO_THINK_MS - 50);
      m.input();
      expect(phase()).toBe("typing");
    }
    vi.advanceTimersByTime(TYPING_TO_THINK_MS);
    expect(phase()).toBe("thinking");
  });

  it("input from thinking, lookaround and idle goes straight back to typing, with no rise", () => {
    for (const [wait, from] of [
      [TYPING_TO_THINK_MS, "thinking"],
      [TYPING_TO_THINK_MS + THINK_TO_LOOK_MS + CODE_LOOK[0]!.ms, "lookaround"],
      [TYPING_TO_THINK_MS + THINK_TO_LOOK_MS + lookMs, "idle"],
    ] as const) {
      const { m, phases, phase } = typing();
      vi.advanceTimersByTime(wait);
      expect(phase()).toBe(from);
      m.input();
      expect(phase()).toBe("typing");
      expect(phases().filter((p) => p === "rising")).toHaveLength(1);
      // and the timers start over from that key
      vi.advanceTimersByTime(TYPING_TO_THINK_MS);
      expect(phase()).toBe("thinking");
      m.dispose();
    }
  });

  it("never sinks while the draft has text", () => {
    const { m, phases } = typing();
    vi.advanceTimersByTime(LONG);
    m.input();
    vi.advanceTimersByTime(LONG);
    expect(phases()).not.toContain("settling");
    expect(m.current.phase).toBe("idle");
  });

  it("sinks from any visible phase when the draft empties (deleted or sent), then hides", () => {
    const waits: Record<string, number> = {
      rising: 0,
      typing: riseMs,
      thinking: riseMs + TYPING_TO_THINK_MS,
      lookaround: riseMs + TYPING_TO_THINK_MS + THINK_TO_LOOK_MS,
      idle: riseMs + TYPING_TO_THINK_MS + THINK_TO_LOOK_MS + lookMs,
    };
    for (const [from, wait] of Object.entries(waits)) {
      const { m, key, phase } = machine();
      key();
      vi.advanceTimersByTime(wait);
      expect(phase()).toBe(from);
      m.setHasText(false);
      expect(phase()).toBe("settling");
      vi.advanceTimersByTime(sinkMs);
      expect(phase()).toBe("hidden");
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("deleting everything with the keyboard (input, then an empty draft) sinks it", () => {
    const { m, phase } = typing();
    m.input();
    m.setHasText(false);
    expect(phase()).toBe("settling");
    // the draft update can land before the input event too
    vi.advanceTimersByTime(sinkMs);
    const t = typing();
    t.m.setHasText(false);
    t.m.input();
    expect(t.phase()).toBe("settling");
  });

  it("typing again while settling climbs back up from the height it sank to", () => {
    const { m, key, phase } = typing();
    m.setHasText(false);
    vi.advanceTimersByTime(CODE_SINK[0]!.ms);
    expect(m.current).toEqual({ phase: "settling", frame: 1 });
    key();
    expect(m.current).toEqual({ phase: "rising", frame: 1 });
    vi.advanceTimersByTime(CODE_RISE[1]!.ms + CODE_RISE[2]!.ms);
    expect(phase()).toBe("typing");
  });

  it("a draft that appears without typing (a restored draft) does not raise it; the next key does", () => {
    const { m, phase } = machine();
    m.setHasText(true);
    vi.advanceTimersByTime(LONG);
    expect(phase()).toBe("hidden");
    m.input();
    expect(phase()).toBe("rising");
  });

  it("a stale input on an empty draft does not raise it when a draft is restored later", () => {
    const { m, phase } = machine();
    m.input();
    m.setHasText(true);
    expect(phase()).toBe("rising"); // the usual case: the text that key typed
    m.setHasText(false);
    vi.advanceTimersByTime(LONG);
    m.setHasText(true); // a later restore without input
    expect(phase()).toBe("hidden");
  });

  it("disabled with text: it sits idle (no sink), ignores keys, and types again once re-enabled", () => {
    const { m, phase, phases } = typing();
    m.setEnabled(false);
    expect(phase()).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    m.input();
    vi.advanceTimersByTime(LONG);
    expect(phase()).toBe("idle");
    expect(phases()).not.toContain("settling");
    m.setEnabled(true);
    expect(phase()).toBe("idle");
    m.input();
    expect(phase()).toBe("typing");
  });

  it("disabled mid-rise: the rise finishes and lands on idle; disabled and emptied: it sinks", () => {
    const { m, key, phase } = machine();
    key();
    m.setEnabled(false);
    expect(phase()).toBe("rising");
    vi.advanceTimersByTime(riseMs);
    expect(phase()).toBe("idle");
    m.setHasText(false);
    expect(phase()).toBe("settling");
    vi.advanceTimersByTime(sinkMs);
    expect(phase()).toBe("hidden");
    m.setHasText(true);
    m.input();
    expect(phase()).toBe("hidden");
  });

  it("dispose leaves no timers", () => {
    const { m } = typing();
    m.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what the sprite shows", () => {
  it("each phase maps to its code-screen frames", () => {
    const at = (phase: TypingPhase, frame = 0) => typingSpriteShows({ phase, frame }, false);
    expect(at("hidden")).toBeNull();
    expect(at("rising", 1)).toEqual({ still: CODE_RISE[1]!.rows });
    expect(at("settling", 2)).toEqual({ still: CODE_SINK[2]!.rows });
    expect(at("lookaround", 3)).toEqual({ still: CODE_LOOK[3]!.rows });
    expect(at("typing")).toEqual({ loop: CODE_TYPE });
    expect(at("thinking")).toEqual({ loop: CODE_THINK });
    expect(at("idle")).toEqual({ loop: CODE_IDLE });
  });

  it("renders a 40x28 inert box on the edge", () => {
    const html = renderToStaticMarkup(<ComposerTypingSprite enabled hasText />);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("width:40px;height:28px");
    expect(html).toContain('data-composer-typing-sprite="hidden"');
  });
});

describe("reduced motion", () => {
  it("the typing sprite shows nothing in any phase", () => {
    for (const phase of [
      "hidden",
      "rising",
      "typing",
      "thinking",
      "lookaround",
      "idle",
      "settling",
    ] as const) {
      expect(typingSpriteShows({ phase, frame: 0 }, true)).toBeNull();
    }
  });

  it("the composer sprite renders an empty, inert box", () => {
    const html = renderToStaticMarkup(<ComposerTypingSprite enabled hasText reducedMotion />);
    expect(html).toContain("pointer-events-none");
    expect(html).not.toContain("<svg");
  });

  it("a frame animation holds frame 0", () => {
    const html = renderToStaticMarkup(<PixelAnimation name="hop" reducedMotion />);
    expect(html).toContain('data-frame="0"');
    expect(html).toContain('shape-rendering="crispEdges"');
  });
});

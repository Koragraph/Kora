import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { activePlayersForTests, playFrames } from "./frameClock";
import {
  ANIMATIONS,
  WORKING_SET,
  frame,
  pickWorkingAnimation,
  resetWorkingPicksForTests,
} from "./pixelFrames";
import { BASE, GRID, MONO } from "./spriteData";

// Frame counts straight from docs/ui/sprite-motion-gallery.html's ANIMS.
const GALLERY_FRAMES: Record<keyof typeof ANIMATIONS, number> = {
  hop: 6,
  bob: 2,
  breathe: 2,
  look: 7,
  scan: 4,
  shuffle: 4,
  think: 4,
  hover: 2,
  peek: 7,
  spin: 5,
  nod: 5,
  sparkle: 5,
  tap: 5,
};

describe("pixel animation generator", () => {
  it("keeps only the picked animations, with the gallery's frame counts", () => {
    expect(Object.keys(ANIMATIONS).sort()).toEqual(Object.keys(GALLERY_FRAMES).sort());
    for (const [name, frames] of Object.entries(ANIMATIONS)) {
      expect(frames.length, name).toBe(GALLERY_FRAMES[name as keyof typeof ANIMATIONS]);
    }
    expect([...WORKING_SET].sort()).toEqual(Object.keys(GALLERY_FRAMES).sort());
  });

  it("every frame is a whole 12x12 grid of known palette keys with a positive duration", () => {
    const all = Object.values(ANIMATIONS).flat();
    for (const f of all) {
      expect(f.ms).toBeGreaterThan(0);
      expect(f.rows).toHaveLength(GRID);
      for (const row of f.rows) {
        expect(row).toHaveLength(GRID);
        for (const ch of row) if (ch !== ".") expect(MONO[ch], ch).toBeDefined();
      }
    }
  });

  it("the plain normal frame is spriteData's BASE, pixel for pixel", () => {
    expect(frame({})).toEqual([...BASE]);
  });

  it("D (shadows, idle dots) stays a neutral grey, like the rest of MONO", () => {
    for (const [key, hex] of Object.entries(MONO)) {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(Math.max(...ch) - Math.min(...ch), key).toBeLessThanOrEqual(10);
    }
    expect(MONO.D).toBe("#3a3b40");
  });

  it("moves whole pixels: bob lifts the body exactly one row", () => {
    const [a, b] = ANIMATIONS.bob;
    expect(b!.rows.slice(0, 11)).toEqual([...a!.rows.slice(1, 11), "............"]);
  });
});

describe("per-turn working pick", () => {
  beforeEach(() => resetWorkingPicksForTests());

  it("is stable for one turn and comes from the working set", () => {
    const a = pickWorkingAnimation("2026-10-12T10:00:00.000Z");
    expect(WORKING_SET).toContain(a);
    expect(pickWorkingAnimation("2026-10-12T10:00:00.000Z")).toBe(a);
  });

  it("the next turn never repeats the previous turn's pick", () => {
    let prev = pickWorkingAnimation("turn-0");
    const seen = new Set([prev]);
    for (let i = 1; i < 60; i++) {
      const next = pickWorkingAnimation(`turn-${i}`);
      expect(next).not.toBe(prev);
      seen.add(next);
      prev = next;
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("shared frame clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drives every player from one timer and advances on per-frame durations", () => {
    const a: number[] = [];
    const b: number[] = [];
    const pa = playFrames([100, 50], (i) => a.push(i));
    const pb = playFrames([300, 300], (i) => b.push(i));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(a).toEqual([1]);
    vi.advanceTimersByTime(50);
    expect(a).toEqual([1, 0]);
    expect(b).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(b).toEqual([1]);
    expect(vi.getTimerCount()).toBe(1);
    pa.dispose();
    pb.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a paused (off-screen) player stops ticking and no timer runs for it", () => {
    const seen: number[] = [];
    const p = playFrames([100, 100], (i) => seen.push(i));
    p.setRunning(false);
    expect(activePlayersForTests()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    p.setRunning(true);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1]);
    p.dispose();
  });
});

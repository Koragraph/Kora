// @effect-diagnostics nodeBuiltinImport:off - reads the gallery spec to check pixel parity with it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import type { AnimFrame } from "./pixelFrames";
import {
  CODE_H,
  CODE_IDLE,
  CODE_LOOK,
  CODE_RISE,
  CODE_SINK,
  CODE_THINK,
  CODE_TYPE,
  CODE_W,
  RISE_DY,
  SINK_DY,
} from "./codeScreenFrames";
import { MONO } from "./spriteData";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const GALLERY = NodePath.join(here, "../../../../../docs/ui/typing-sprite-gallery.html");

type GalleryFrames = { g: string[][]; ms: number }[];
type GalleryEntry = [id: string, name: string, desc: string, frames: GalleryFrames];

/** Run the gallery's own generator (everything before its DOM code) and return its variations and state cards. */
function gallery(): { V: GalleryEntry[]; STATES: GalleryEntry[]; PAL: Record<string, string> } {
  const html = NodeFS.readFileSync(GALLERY, "utf8");
  const src = html.slice(html.indexOf("const PAL"), html.indexOf("// ── render ──"));
  // Evaluating the spec's own frame generator is the point of the parity test.
  return new Function(`${src}; return { V, STATES, PAL };`)();
}
const asRows = (frames: GalleryFrames) =>
  frames.map((f) => ({ rows: f.g.map((r) => r.join("")), ms: f.ms }));
const plain = (frames: readonly AnimFrame[]) =>
  frames.map((f) => ({ rows: [...f.rows], ms: f.ms }));

describe("code screen frames", () => {
  const { V, STATES, PAL } = gallery();
  const card = (list: GalleryEntry[], id: string) => list.find((e) => e[0] === id)![3];

  it("typing is the gallery's #4 Code screen, pixel for pixel and frame for frame", () => {
    expect(CODE_TYPE).toHaveLength(8);
    expect(plain(CODE_TYPE)).toEqual(asRows(card(V, "code")));
  });

  it("thinking, lookaround and idle match the gallery's state cards", () => {
    expect(plain(CODE_TYPE)).toEqual(asRows(card(STATES, "typing")));
    expect(plain(CODE_THINK)).toEqual(asRows(card(STATES, "thinking")));
    expect(plain(CODE_LOOK)).toEqual(asRows(card(STATES, "lookaround")));
    expect(plain(CODE_IDLE)).toEqual(asRows(card(STATES, "idle")));
  });

  it("uses the gallery's palette letters mapped to the Kora mono greys", () => {
    for (const [key, hex] of Object.entries(PAL)) expect(MONO[key], key).toBe(hex);
  });

  it("every frame is a whole 20x14 grid of known palette keys with a positive duration", () => {
    for (const f of [CODE_TYPE, CODE_THINK, CODE_LOOK, CODE_IDLE, CODE_RISE, CODE_SINK].flat()) {
      expect(f.ms).toBeGreaterThan(0);
      expect(f.rows).toHaveLength(CODE_H);
      for (const row of f.rows) {
        expect(row).toHaveLength(CODE_W);
        for (const ch of row) if (ch !== ".") expect(MONO[ch], ch).toBeDefined();
      }
    }
  });

  it("thinking: eyes up, paws resting, the bubble fills one dot at a time and stays off the screen", () => {
    const dots = CODE_THINK.map((f) => f.rows[1]!.slice(4, 10).split("Q").length - 1);
    expect(dots).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    for (const f of CODE_THINK) {
      expect(f.rows[0]!.slice(4, 10)).toBe("DDDDDD"); // the bubble
      expect(f.rows[3]![7]).toBe("D"); // its tail
      for (const r of f.rows.slice(0, 9)) expect(r.slice(10, 19)).not.toContain("D"); // clear of the monitor
      expect(f.rows[11]).not.toContain("Q"); // no key pressed
    }
    // the cursor blinks after the last code line
    expect(CODE_THINK.map((f) => f.rows[6]![17]).join("")).toBe("QKQKQKQK");
  });

  it("lookaround: left, front, right, front, a blink, front", () => {
    // eye pixels on the body's eye row (y 6): left eyes at x 1/5, front 2/6, right 3/7
    const eyeCols = CODE_LOOK.map((f) =>
      Array.from(f.rows[6]!.slice(0, 9))
        .flatMap((c, x) => (c === "K" ? [x] : []))
        .join(","),
    );
    expect(eyeCols).toEqual(["2,6", "1,5", "2,6", "3,7", "2,6", "", "2,6"]);
    expect(CODE_LOOK[5]!.rows[7]!.slice(0, 9)).toBe(".WKWWWKWS"); // closed: one line of eye
  });

  it("idle blinks once a loop and keeps the cursor blinking", () => {
    expect(CODE_IDLE.filter((f) => !f.rows[6]!.slice(0, 9).includes("K"))).toHaveLength(1);
    expect(new Set(CODE_IDLE.map((f) => f.rows[6]![17]))).toEqual(new Set(["Q", "K"]));
  });

  it("the rise climbs over the bottom edge and ends seated; the sink goes back below it", () => {
    const filled = (rows: readonly string[]) => rows.filter((r) => /[^.]/.test(r)).length;
    expect(CODE_RISE.map((f) => filled(f.rows))).toEqual([5, 9, 13]);
    expect(CODE_RISE[CODE_RISE.length - 1]!.rows).toEqual(CODE_TYPE[0]!.rows);
    expect(CODE_SINK.map((f) => filled(f.rows))).toEqual([9, 5, 1]);
    expect(RISE_DY).toEqual([8, 4, 0]);
    expect(SINK_DY).toEqual([4, 8, 12]);
  });
});

/**
 * Frame-by-frame pixel animations for Kora's 12x12 sprite: a faithful port of the frame generator in
 * docs/ui/sprite-motion-gallery.html (the approved design). Every frame is a whole 12x12 grid of palette keys,
 * played like a game sprite with per-frame durations; no smooth transforms. Pure data, no React.
 *
 * Palette keys are MONO's (spriteData.ts) plus D, the dim neutral grey of shadows and idle dots.
 * The generator's plain `normal` frame is spriteData's BASE, pixel for pixel (pixelFrames.test.ts).
 */
import { GRID } from "./spriteData";

const N = GRID;

/** One frame: 12 rows of 12 palette keys ('.' = empty). */
export type FrameRows = readonly string[];

export interface AnimFrame {
  readonly rows: FrameRows;
  readonly ms: number;
}

type BodyName = "normal" | "squash" | "wide" | "stretch" | "side" | "back";
type LegName = "rest" | "a" | "b" | "tuck" | "wide";
type Eyes = "open" | "left" | "right" | "closed" | "happy" | "down" | "x";

/** Body shapes (W body, S shade); e marks eye pixels (drawn K). */
const BODIES: Readonly<Record<BodyName, readonly string[]>> = {
  normal: ["..WWWW..", ".WWWWWS.", "WWWWWWWS", "WeWWWeWS", "WeWWWeWS", "WWWWWWWS", ".WWWWWS."],
  // A stepped dome (4 → 6 → 8 → 10) and full-height eyes: the old flat 4 → 8 top read as the sprite's head clipped off.
  squash: ["...WWWW...", "..WWWWWS..", ".WWWWWWWS.", "WWeWWWWeWS", "WWeWWWWeWS", ".WWWWWWWS."],
  wide: ["...WWWW...", ".WWWWWWWS.", "WWeWWWWeWS", "WWeWWWWeWS", "WWWWWWWWWS", ".WWWWWWWS."],
  stretch: ["..WW..", ".WWWS.", "WWWWWS", "WeWeWS", "WeWeWS", "WWWWWS", "WWWWWS", ".WWWS."],
  side: ["..WWW.", ".WWWWS", "WWWWWS", "WWWWeS", "WWWWeS", "WWWWWS", ".WWWS."],
  back: ["..WWWW..", ".WWWWWS.", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", ".WWWWWS."],
};
const LEGS: Readonly<Record<LegName, string>> = {
  rest: ".WS..WS.",
  a: "WS....WS",
  b: "..WSWS..",
  tuck: "........",
  wide: "WS......WS",
};

export type Fx = readonly [x: number, y: number, c?: string];

export interface FrameOptions {
  readonly body?: BodyName;
  readonly dx?: number;
  readonly dy?: number;
  readonly eyes?: Eyes;
  readonly legs?: LegName;
  readonly tilt?: number;
  readonly fx?: readonly Fx[];
  /** Rows below this index are not drawn (the sprite sinks behind a line). */
  readonly clipBelow?: number;
  /** Shadow span [x0, x1] on row 11. */
  readonly shadow?: readonly [number, number] | null;
}

/** Compose one 12x12 frame. Ground (feet) is row 10; dy<0 lifts, dx shifts, tilt shears the top half by a pixel. */
export function frame(o: FrameOptions = {}): string[] {
  const {
    body = "normal",
    dx = 0,
    dy = 0,
    eyes = "open",
    legs = "rest",
    tilt = 0,
    fx = [],
    clipBelow = 11,
    shadow = null,
  } = o;
  const g: string[][] = Array.from({ length: N }, () => Array<string>(N).fill("."));
  const put = (x: number, y: number, c: string) => {
    if (x >= 0 && x < N && y >= 0 && y < N && y <= clipBelow) g[y]![x] = c;
  };
  if (shadow) for (let x = shadow[0]; x <= shadow[1]; x++) put(x, 11, "D");
  const b = BODIES[body];
  const w = b[0]!.length;
  const h = b.length;
  const legRow = LEGS[legs];
  const bottom = 9 + dy; // last body row
  const top = bottom - h + 1;
  const left = Math.floor((N - w) / 2) + dx;
  const at = (r: number, c: number) => b[r]?.[c];
  b.forEach((row, r) => {
    const shear = tilt && r < Math.ceil(h / 2) ? tilt : 0;
    [...row].forEach((ch, c) => {
      if (ch === ".") return;
      let col = ch === "e" ? "K" : ch;
      if (ch === "e") {
        const topEye = at(r - 1, c) !== "e";
        const botEye = at(r + 1, c) !== "e";
        if (eyes === "closed") col = botEye && !topEye ? "K" : topEye && botEye ? "K" : "W";
        if (eyes === "happy") col = topEye ? "K" : "W";
        if (eyes === "down") col = botEye ? "K" : "W";
      }
      put(left + c + shear, top + r, col);
    });
  });
  const eyeCells: [number, number][] = [];
  b.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === "e") eyeCells.push([r, c]);
    }),
  );
  // Eye variants that move pixels.
  if (eyes === "left" || eyes === "right") {
    const s = eyes === "left" ? -1 : 1;
    for (const [r, c] of eyeCells) put(left + c, top + r, "W");
    for (const [r, c] of eyeCells) put(left + c + s, top + r, "K");
  }
  if ((eyes === "happy" || eyes === "closed") && eyeCells.length > 0) {
    // happy: eyes raised to one pixel plus a smile under them; closed: a line at the eye's bottom.
    const cols = eyeCells.map(([, c]) => c);
    const lc = Math.min(...cols);
    const rc = Math.max(...cols);
    const lastEye = Math.max(...eyeCells.map(([r]) => r));
    if (eyes === "happy") {
      for (let c = lc + 1; c <= rc - 1; c++) {
        if (c !== lc + 1 || rc - lc > 2) {
          put(left + c, top + lastEye + 1, c === lc + 1 || c === rc - 1 ? "W" : "K");
        }
      }
      put(left + lc + 1, top + lastEye, "W");
      put(left + rc - 1, top + lastEye, "W");
    }
    if (eyes === "closed") put(left + lc, top + lastEye, "K");
  }
  if (eyes === "x") {
    for (const [r, c] of eyeCells) put(left + c, top + r, (r + c) % 2 ? "K" : "W");
  }
  const ll = Math.floor((N - legRow.length) / 2) + dx;
  [...legRow].forEach((ch, c) => {
    if (ch !== ".") put(ll + c, bottom + 1, ch);
  });
  for (const [x, y, c] of fx) put(x, y, c ?? "W");
  return g.map((row) => row.join(""));
}

const F = (o: FrameOptions, ms = 120): AnimFrame => ({ rows: frame(o), ms });

const SH = [3, 8] as const;
const SHs = [4, 7] as const;
/** The animations the user picked from the gallery (ids and gallery numbers kept). */
export const ANIMATIONS = {
  // #02
  hop: [
    F({ shadow: SH }, 400),
    F({ body: "squash", legs: "wide", shadow: SH }, 100),
    F({ dy: -2, legs: "tuck", shadow: SHs }, 110),
    F({ dy: -3, legs: "tuck", shadow: SHs }, 140),
    F({ dy: -1, legs: "tuck", shadow: SHs }, 100),
    F({ body: "squash", legs: "wide", shadow: SH }, 100),
  ],
  // #03
  bob: [F({}, 420), F({ dy: -1 }, 420)],
  // #04
  breathe: [F({}, 600), F({ body: "wide" }, 600)],
  // #05
  look: [
    F({}, 700),
    F({ eyes: "left" }, 500),
    F({}, 300),
    F({ eyes: "right" }, 500),
    F({}, 400),
    F({ eyes: "closed" }, 110),
    F({}, 400),
  ],
  // #06
  scan: [F({ eyes: "left" }, 220), F({}, 180), F({ eyes: "right" }, 220), F({}, 180)],
  // #08
  shuffle: [
    F({ dx: -1, legs: "a" }, 180),
    F({ legs: "rest" }, 140),
    F({ dx: 1, legs: "b" }, 180),
    F({ legs: "rest" }, 140),
  ],
  // #11
  think: [
    F(
      {
        fx: [
          [3, 0, "D"],
          [6, 0, "D"],
          [9, 0, "D"],
        ],
      },
      260,
    ),
    F(
      {
        dy: -1,
        fx: [
          [3, 0, "Q"],
          [6, 0, "D"],
          [9, 0, "D"],
        ],
      },
      260,
    ),
    F(
      {
        fx: [
          [3, 0, "Q"],
          [6, 0, "Q"],
          [9, 0, "D"],
        ],
      },
      260,
    ),
    F(
      {
        dy: -1,
        fx: [
          [3, 0, "Q"],
          [6, 0, "Q"],
          [9, 0, "Q"],
        ],
      },
      360,
    ),
  ],
  // #15
  hover: [
    F({ dy: -2, legs: "tuck", shadow: SHs }, 380),
    F({ dy: -3, legs: "tuck", shadow: [5, 6] }, 380),
  ],
  // #16
  peek: [
    F({}, 700),
    F({ dy: 2, clipBelow: 10 }, 120),
    F({ dy: 4, clipBelow: 10 }, 120),
    F({ dy: 6, clipBelow: 10 }, 300),
    F({ dy: 3, clipBelow: 10 }, 100),
    F({ dy: 0, clipBelow: 10, eyes: "left" }, 260),
    F({ eyes: "right" }, 260),
  ],
  // #17
  spin: [
    F({}, 260),
    F({ body: "side" }, 110),
    F({ body: "back" }, 140),
    F({ body: "side", dx: 0 }, 110),
    F({}, 260),
  ],
  // #18
  nod: [
    F({}, 500),
    F({ dy: 1, legs: "tuck", eyes: "down" }, 180),
    F({}, 180),
    F({ dy: 1, legs: "tuck", eyes: "down" }, 180),
    F({}, 400),
  ],
  // #19
  sparkle: [
    F({ fx: [[1, 2, "Q"]] }, 160),
    F(
      {
        fx: [
          [1, 2, "L"],
          [10, 4, "Q"],
        ],
      },
      160,
    ),
    F(
      {
        fx: [
          [10, 4, "L"],
          [0, 7, "Q"],
        ],
      },
      160,
    ),
    F(
      {
        fx: [
          [0, 7, "L"],
          [11, 1, "Q"],
        ],
      },
      160,
    ),
    F({ fx: [[11, 1, "L"]] }, 160),
  ],
  // #25
  tap: [F({}, 200), F({ legs: "a" }, 120), F({}, 200), F({ legs: "a" }, 120), F({}, 500)],
} satisfies Record<string, readonly AnimFrame[]>;

export type AnimationName = keyof typeof ANIMATIONS;

/** What the lead plays while a turn runs (gallery #2 3 4 5 6 8 11 15 16 17 18 19 25). */
export const WORKING_SET: readonly AnimationName[] = [
  "hop",
  "bob",
  "breathe",
  "look",
  "scan",
  "shuffle",
  "think",
  "hover",
  "peek",
  "spin",
  "nod",
  "sparkle",
  "tap",
];

/** FNV-1a: a small stable string hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pickedBySeed = new Map<string, AnimationName>();
let lastPick: AnimationName | null = null;

/**
 * The working animation for a turn: stable for one seed (the turn's id / start time), and a new seed never repeats
 * the previous turn's pick.
 */
export function pickWorkingAnimation(seed: string): AnimationName {
  const known = pickedBySeed.get(seed);
  if (known) return known;
  let i = hash(seed) % WORKING_SET.length;
  if (WORKING_SET[i] === lastPick) i = (i + 1) % WORKING_SET.length;
  const pick = WORKING_SET[i]!;
  lastPick = pick;
  pickedBySeed.set(seed, pick);
  if (pickedBySeed.size > 64) pickedBySeed.delete(pickedBySeed.keys().next().value!);
  return pick;
}

export function resetWorkingPicksForTests(): void {
  pickedBySeed.clear();
  lastPick = null;
}

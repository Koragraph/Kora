/**
 * The composer's typing sprite, "Code screen" (variation #4 of docs/ui/typing-sprite-gallery.html, the user's pick):
 * a 20x14 scene - Kora at (1,3) looking right at a little monitor whose code lines change, a stand, a 10-wide
 * keyboard whose keys light and sink, paws tapping. A faithful port of the gallery's generator: same painter, same
 * paint order, so every frame is pixel-identical to the gallery's (codeScreenFrames.test.ts evaluates the gallery's own
 * script and compares). The rest states (thinking, lookaround, idle) are the gallery's STATES cards, ported the same way.
 *
 * Palette keys are MONO's (spriteData.ts; M is the monitor / keyboard-base grey). Pure data, no React.
 */
import type { AnimFrame } from "./pixelFrames";

export const CODE_W = 20;
export const CODE_H = 14;

type Grid = string[][];
type Eyes = "open" | "down" | "up" | "closed" | "left" | "right" | "focus";

// ── the gallery's tiny pixel painter ──
const blank = (): Grid => Array.from({ length: CODE_H }, () => Array<string>(CODE_W).fill("."));
function put(g: Grid, x: number, y: number, c: string): void {
  if (x >= 0 && x < CODE_W && y >= 0 && y < CODE_H) g[y]![x] = c;
}
function rect(g: Grid, x: number, y: number, w: number, h: number, c: string): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(g, x + i, y + j, c);
}
function stamp(g: Grid, x: number, y: number, rows: readonly string[]): void {
  rows.forEach((r, j) =>
    [...r].forEach((ch, i) => {
      if (ch !== ".") put(g, x + i, y + j, ch);
    }),
  );
}

const BODY = ["..WWWW..", ".WWWWWS.", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", ".WWWWWS."];
const EYES: Readonly<Record<Eyes, readonly (readonly [number, number])[]>> = {
  open: [
    [1, 3],
    [1, 4],
    [5, 3],
    [5, 4],
  ],
  down: [
    [1, 4],
    [5, 4],
    [1, 5],
    [5, 5],
  ],
  up: [
    [1, 2],
    [5, 2],
    [1, 3],
    [5, 3],
  ],
  closed: [
    [1, 4],
    [5, 4],
  ],
  left: [
    [0, 3],
    [0, 4],
    [4, 3],
    [4, 4],
  ],
  right: [
    [2, 3],
    [2, 4],
    [6, 3],
    [6, 4],
  ],
  focus: [
    [1, 4],
    [2, 4],
    [4, 4],
    [5, 4],
  ],
};
/** Kora's body (8x7) with its eyes. */
function body(g: Grid, x: number, y: number, eyes: Eyes = "open"): void {
  stamp(g, x, y, BODY);
  for (const [i, j] of EYES[eyes]) put(g, x + i, y + j, "K");
}
/** Two rows of keys on a base; `lit` keys glow and sink a pixel. */
function keyboard(g: Grid, x: number, y: number, w: number, lit: readonly number[] = []): void {
  rect(g, x, y + 2, w, 1, "D");
  rect(g, x, y + 1, w, 1, "M");
  for (let i = 0; i < Math.floor(w / 2); i++) {
    const kx = x + i * 2;
    const pressed = lit.includes(i);
    put(g, kx, pressed ? y + 1 : y, pressed ? "Q" : i % 3 === 0 ? "L" : "G");
  }
}
function paw(g: Grid, x: number, y: number, down: boolean): void {
  put(g, x, down ? y + 1 : y, "W");
  if (!down) put(g, x, y + 1, "S");
}
const rows = (g: Grid): string[] => g.map((r) => r.join(""));

// ── #4 Code screen: the typing loop, verbatim ──
const LENS = [
  [3, 5, 2, 4],
  [5, 2, 4, 6],
  [2, 4, 6, 3],
  [4, 6, 3, 5],
] as const;

/** Typing: 8 frames, 130 ms each; code lines change length, a key lights under each tapping paw. */
export const CODE_TYPE: readonly AnimFrame[] = LENS.flatMap((ls) =>
  [0, 1].map((half): AnimFrame => {
    const g = blank();
    body(g, 1, 3, "right");
    rect(g, 11, 1, 8, 8, "M");
    rect(g, 12, 2, 6, 6, "K");
    ls.forEach((len, row) =>
      rect(
        g,
        12 + (row % 2),
        3 + row,
        Math.min(len - (row === 3 && half === 0 ? 2 : 0), 5),
        1,
        row % 3 === 0 ? "L" : "G",
      ),
    );
    rect(g, 14, 9, 2, 1, "M");
    rect(g, 12, 10, 6, 1, "D");
    keyboard(g, 0, 11, 10, [half ? 1 : 3]);
    paw(g, 1, 9, half === 0);
    paw(g, 8, 9, half === 1);
    return { rows: rows(g), ms: 130 };
  }),
);

// ── the rest scene (the gallery's codeRest): static code, paws resting, optional cursor and thought bubble ──
const STATIC_LENS = LENS[0];

interface RestOptions {
  readonly cursor?: boolean;
  /** Thought bubble with this many dots (0-3); omitted = no bubble. */
  readonly dots?: number;
}

function codeRest(eyes: Eyes, { cursor = false, dots = -1 }: RestOptions = {}): string[] {
  const g = blank();
  body(g, 1, dots >= 0 ? 4 : 3, eyes); // thinking sits back a pixel, under the bubble
  rect(g, 11, 1, 8, 8, "M");
  rect(g, 12, 2, 6, 6, "K");
  STATIC_LENS.forEach((len, row) =>
    rect(g, 12 + (row % 2), 3 + row, Math.min(len, 5), 1, row % 3 === 0 ? "L" : "G"),
  );
  if (cursor) put(g, 13 + Math.min(STATIC_LENS[3], 5), 6, "Q"); // 1-px cursor after the last line
  rect(g, 14, 9, 2, 1, "M");
  rect(g, 12, 10, 6, 1, "D");
  keyboard(g, 0, 11, 10, []);
  paw(g, 1, 9, false);
  paw(g, 8, 9, false);
  if (dots >= 0) {
    // #6's thought bubble, up and right of the head, clear of the screen
    rect(g, 4, 0, 6, 3, "D");
    put(g, 7, 3, "D");
    for (let k = 0; k < dots && k < 3; k++) put(g, 5 + k * 2, 1, "Q");
  }
  return rows(g);
}

/** Thinking (loops): eyes up, the bubble fills dot by dot, the cursor blinks. */
export const CODE_THINK: readonly AnimFrame[] = [0, 0, 1, 1, 2, 2, 3, 3].map((dots, n) => ({
  rows: codeRest("up", { cursor: n % 2 === 0, dots }),
  ms: n === 7 ? 600 : 300,
}));

/** Look around (plays once, then idle): left, hold, right, hold, front, a blink. */
export const CODE_LOOK: readonly AnimFrame[] = (
  [
    ["open", 250],
    ["left", 700],
    ["open", 200],
    ["right", 700],
    ["open", 250],
    ["closed", 120],
    ["open", 300],
  ] as const
).map(([eyes, ms]) => ({ rows: codeRest(eyes, { cursor: true }), ms }));

/** Idle (loops): sitting at the screen, paws resting, the odd blink, the cursor blinking. */
export const CODE_IDLE: readonly AnimFrame[] = Array.from({ length: 8 }, (_, n) => ({
  rows: codeRest(n === 5 ? "closed" : "open", { cursor: n % 2 === 0 }),
  ms: n === 5 ? 140 : 500,
}));

/** The scene moved down `dy` rows; whatever falls past the bottom row (the composer's edge) is cut off. */
function lowered(frameRows: readonly string[], dy: number): string[] {
  const empty = ".".repeat(CODE_W);
  return Array.from({ length: CODE_H }, (_, y) => (y < dy ? empty : frameRows[y - dy]!));
}

const SEATED = CODE_TYPE[0]!.rows;

/** Body offset (rows below seated) of each RISE / SINK frame. */
export const RISE_DY = [8, 4, 0] as const;
export const SINK_DY = [4, 8, 12] as const;

/** Climbing over the composer's top edge (the whole desk comes up with it); ends seated. */
export const CODE_RISE: readonly AnimFrame[] = RISE_DY.map((dy, i) => ({
  rows: lowered(SEATED, dy),
  ms: i === RISE_DY.length - 1 ? 110 : 90,
}));
/** Back down behind the edge; the last frame leaves only the monitor's top showing. */
export const CODE_SINK: readonly AnimFrame[] = SINK_DY.map((dy, i) => ({
  rows: lowered(SEATED, dy),
  ms: i === SINK_DY.length - 1 ? 120 : 100,
}));

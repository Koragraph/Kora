/**
 * Kora's pixel sprite: 12x12 ASCII maps, accessory overlays, state frames and the mono palette.
 * Single source of truth for every creature in the app (Blobs, Chat dock, Code lead, logo, icons;
 * scripts/brand/make-icons.py mirrors BASE). Pure data, no React.
 *
 * Legend: W body, S shade, K ink (eyes), G accessory grey, L light grey, C crown, Q white (marks),
 * D dim grey (frame animations: shadows, idle dots), M mid grey (the typing sprite's monitor and keyboard base).
 */

export type SpriteRows = readonly string[];
export type SpritePalette = Readonly<Record<string, string>>;

/** The mono palette. All neutral greys (Ink: no hue); G/S stay visible on true black. */
export const MONO: SpritePalette = {
  W: "#ededf0",
  S: "#a9abb3",
  K: "#0a0a0b",
  G: "#74767e",
  L: "#c9cad0",
  C: "#f6f6f8",
  Q: "#ffffff",
  D: "#3a3b40",
  M: "#55575e",
};

export const GRID = 12;

/** Classic body, eyes included (cols 3 and 7, rows 6-7). Legs are separate (row 10 variants). */
export const BASE: SpriteRows = [
  "............",
  "............",
  "............",
  "....WWWW....",
  "...WWWWWS...",
  "..WWWWWWWS..",
  "..WKWWWKWS..",
  "..WKWWWKWS..",
  "..WWWWWWWS..",
  "...WWWWWS...",
  "...WS..WS...",
  "............",
];

/** Bounding box of the plain classic body: x 2..9, y 3..10 (an 8x8 mark). */
export const BODY_BOX = { x: 2, y: 3, w: 8, h: 8 } as const;

export const ACCESSORY_IDS = [
  "crown",
  "round",
  "monocle",
  "phones",
  "cap",
  "beret",
  "tophat",
  "shades",
  "beanie",
  "square",
  "flower",
] as const;
export type SpriteAccessory = (typeof ACCESSORY_IDS)[number];

/** Overlay rows (row index -> 12 chars; '.' leaves the pixel alone). */
export const ACCESSORIES: Readonly<Record<SpriteAccessory, Readonly<Record<number, string>>>> = {
  crown: { 1: "...C.CC.C...", 2: "...CCCCCC..." },
  round: { 5: "..GGG.GGG...", 6: "..G.GGG.G...", 7: "..G.G.G.G...", 8: "..GGG.GGG..." },
  monocle: {
    5: "......GGG...",
    6: "......G.G...",
    7: "......G.G...",
    8: "......GGG...",
    9: "........G...",
  },
  phones: {
    2: "...GGGGGG...",
    3: "..G......G..",
    4: "..G......G..",
    5: ".GG......GG.",
    6: ".GG......GG.",
    7: ".GG......GG.",
  },
  cap: { 1: "....GGGG....", 2: "...GGGGGGGG." },
  beret: { 1: "......G.....", 2: "..GGGGGGG..." },
  tophat: { 0: "....GGGG....", 1: "....GGGG....", 2: "...GGGGGG..." },
  shades: { 6: "..KKKKKKK...", 7: "..KKK.KKK..." },
  beanie: { 0: ".....L......", 1: "....GGGG....", 2: "...GGGGGG...", 3: "...LLLLLL..." },
  square: { 5: "..GGGGGGG...", 6: "..G.G.G.G...", 7: "..GGG.GGG..." },
  flower: { 0: ".....L.L....", 1: "......Q.....", 2: "......G....." },
};

/** Accessories that sit over the eyes: the eyes are baked in and never follow the pointer. */
const FACE_ACCESSORIES: ReadonlySet<SpriteAccessory> = new Set([
  "round",
  "monocle",
  "shades",
  "square",
]);

export type SpriteState = "idle" | "walk" | "wait" | "sleep" | "done" | "fail" | "off";
export const SPRITE_STATES: readonly SpriteState[] = [
  "idle",
  "walk",
  "wait",
  "sleep",
  "done",
  "fail",
  "off",
];

export interface Px {
  readonly x: number;
  readonly y: number;
  readonly c: string; // palette key
}

/** Overlay `o` (row -> mask) onto `rows`; '.' in the mask keeps the original. */
function over(rows: SpriteRows, o: Readonly<Record<number, string>>): string[] {
  return rows.map((r, i) => {
    const m = o[i];
    if (!m) return r;
    return r
      .split("")
      .map((ch, j) => (m[j] && m[j] !== "." ? m[j]! : ch))
      .join("");
  });
}

export function pixels(rows: SpriteRows): Px[] {
  const out: Px[] = [];
  rows.forEach((r, y) => {
    r.split("").forEach((ch, x) => {
      if (ch !== ".") out.push({ x, y, c: ch });
    });
  });
  return out;
}

/** Body without eyes and without legs: the eyes/legs are drawn as their own layers. */
const BODY_ROWS: SpriteRows = BASE.map((r, y) => {
  if (y === 6 || y === 7) return r.replace(/K/g, "W");
  if (y === 10) return "............";
  return r;
});

const LEGS: Readonly<Record<"rest" | "a" | "b", string>> = {
  rest: "...WS..WS...",
  a: "..WS....WS..",
  b: "....WSWS....",
};

/** Eye pixels per face (rows 6-8). */
const EYES: Readonly<
  Record<"open" | "happy" | "closed" | "x", readonly (readonly [number, number])[]>
> = {
  open: [
    [3, 6],
    [3, 7],
    [7, 6],
    [7, 7],
  ],
  happy: [
    [3, 6],
    [7, 6],
    [2, 7],
    [4, 7],
    [6, 7],
    [8, 7],
  ],
  closed: [
    [2, 7],
    [3, 7],
    [6, 7],
    [7, 7],
  ],
  x: [
    [2, 6],
    [4, 6],
    [6, 6],
    [8, 6],
    [3, 7],
    [7, 7],
    [2, 8],
    [4, 8],
    [6, 8],
    [8, 8],
  ],
};
/** The little mark above the head: a question mark (wait) or a z (sleep). Rows 0-2, cols 9-10. */
const MARKS = {
  wait: [".........QQ.", "..........Q.", ".........Q.."],
  sleep: [".........QQ.", "..........Q.", ".........QQ."],
} as const;

export type EyeFace = keyof typeof EYES;

function eyeFaceFor(state: SpriteState): EyeFace {
  switch (state) {
    case "done":
      return "happy";
    case "fail":
      return "x";
    case "sleep":
    case "off":
      return "closed";
    default:
      return "open";
  }
}

export interface SpriteLayers {
  /** Body (+ accessory overlays that sit on the body) pixels, eyes excluded. */
  readonly body: Px[];
  readonly accessory: Px[];
  readonly eyes: Px[];
  readonly happyEyes: Px[];
  readonly legs: Readonly<Record<"rest" | "a" | "b", Px[]>>;
  readonly mark: Px[];
  /** Whether the eyes layer may be shifted by pointer-follow / reaction faces. */
  readonly eyesMovable: boolean;
}

function accessoryPixels(acc: SpriteAccessory | null): Px[] {
  if (!acc) return [];
  const blank: string[] = new Array(GRID).fill("............");
  return pixels(over(blank, ACCESSORIES[acc]));
}

/** Everything a renderer needs for one (state, accessory) pair. */
export function layersFor(state: SpriteState, accessory: SpriteAccessory | null): SpriteLayers {
  const face = eyeFaceFor(state);
  const eyesBaked = accessory !== null && FACE_ACCESSORIES.has(accessory);
  const eyesRows = (f: EyeFace): Px[] => EYES[f].map(([x, y]) => ({ x, y, c: "K" }));
  const legRow = (r: string): Px[] => pixels([r]).map((p) => ({ ...p, y: 10 }));
  const legs = { rest: legRow(LEGS.rest), a: legRow(LEGS.a), b: legRow(LEGS.b) };
  let mark: Px[] = [];
  if (state === "wait") mark = pixels(MARKS.wait);
  if (state === "sleep") mark = pixels(MARKS.sleep);
  return {
    body: pixels(BODY_ROWS),
    accessory: accessoryPixels(accessory),
    eyes: eyesRows(face),
    happyEyes: eyesBaked ? [] : eyesRows("happy"),
    legs,
    mark,
    eyesMovable: !eyesBaked && face === "open",
  };
}

/** Flat 12x12 rows for a given state/accessory (used by tests, the icon script and static renders). */
export function composeRows(
  state: SpriteState,
  accessory: SpriteAccessory | null,
  legs: "rest" | "a" | "b" = "rest",
): string[] {
  const face = eyeFaceFor(state);
  let rows: string[] = [...BODY_ROWS];
  rows[10] = LEGS[state === "walk" ? (legs === "rest" ? "a" : legs) : "rest"];
  const eyeMask: Record<number, string> = {};
  for (const [x, y] of EYES[face]) {
    const row = (eyeMask[y] ?? "............").split("");
    row[x] = "K";
    eyeMask[y] = row.join("");
  }
  rows = over(rows, eyeMask);
  if (accessory) rows = over(rows, ACCESSORIES[accessory]);
  if (state === "wait") rows = over(rows, { 0: MARKS.wait[0], 1: MARKS.wait[1], 2: MARKS.wait[2] });
  if (state === "sleep")
    rows = over(rows, { 0: MARKS.sleep[0], 1: MARKS.sleep[1], 2: MARKS.sleep[2] });
  return rows;
}

/** Whole-pixel scale for a requested box size: >= 1 device-crisp pixel per sprite pixel. */
export function spriteScale(size: number): number {
  return Math.max(1, Math.floor(size / GRID + 0.4));
}

/** Whether the eyes are an open pair that may shift by whole pixels (follow / glance). */
export function eyesMovable(state: SpriteState, accessory: SpriteAccessory | null): boolean {
  return layersFor(state, accessory).eyesMovable;
}

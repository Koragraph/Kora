/**
 * Outfit model for the blob avatar: two slots (head / face), ids only, never colour, and ONLY ids that have sprite
 * art (the wire still carries a `neck` slot for compatibility; it is never drawn). A blob wears at most ONE
 * accessory: the avatar draws the head slot, else the face slot.
 * Everything here is pure data + a deterministic hash so a blob's default look is stable across
 * machines and sessions.
 */

export const HEAD_IDS = [
  "top-hat",
  "beanie",
  "cap",
  "beret",
  "crown",
  "headphones",
  "flower",
] as const;
export const FACE_IDS = ["monocle", "round-glasses", "square-glasses", "sunglasses"] as const;

export type HeadId = (typeof HEAD_IDS)[number];
export type FaceId = (typeof FACE_IDS)[number];

export type BlobOutfit = { head?: HeadId; face?: FaceId };

/** Head items anyone may wear. The crown is reserved for the Chief. */
const PICKABLE_HEAD_IDS: readonly HeadId[] = HEAD_IDS.filter((id) => id !== "crown");

export const ACCESSORY_LABELS: Record<HeadId | FaceId, string> = {
  "top-hat": "Top hat",
  beanie: "Beanie",
  cap: "Cap",
  beret: "Beret",
  crown: "Crown",
  headphones: "Headphones",
  flower: "Flower",
  monocle: "Monocle",
  "round-glasses": "Round glasses",
  "square-glasses": "Square glasses",
  sunglasses: "Sunglasses",
};

/** FNV-1a, 32-bit. Small, dependency-free and stable. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A tiny seeded PRNG (mulberry32) returning floats in [0, 1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every accessory that has art, in picker order. The crown is Chief-only. */
export type AccessoryChoice = { slot: "head"; id: HeadId } | { slot: "face"; id: FaceId };
export const ACCESSORY_CHOICES: readonly AccessoryChoice[] = [
  { slot: "face", id: "round-glasses" },
  { slot: "face", id: "square-glasses" },
  { slot: "face", id: "monocle" },
  { slot: "face", id: "sunglasses" },
  { slot: "head", id: "top-hat" },
  { slot: "head", id: "beanie" },
  { slot: "head", id: "cap" },
  { slot: "head", id: "beret" },
  { slot: "head", id: "headphones" },
  { slot: "head", id: "flower" },
  { slot: "head", id: "crown" },
];
export const PICKABLE_ACCESSORY_CHOICES = ACCESSORY_CHOICES.filter((c) => c.id !== "crown");

function outfitOf(choice: AccessoryChoice): BlobOutfit {
  return choice.slot === "head" ? { head: choice.id } : { face: choice.id };
}

/** The one accessory a new blob gets from its id (never the crown). Same id, same outfit, forever. */
export function defaultOutfitFor(id: string): BlobOutfit {
  const next = rng(hashString(`blob-outfit:${id}`));
  return outfitOf(
    PICKABLE_ACCESSORY_CHOICES[Math.floor(next() * PICKABLE_ACCESSORY_CHOICES.length)]!,
  );
}

/** A random single accessory for the picker's Shuffle (crown only for the Chief). */
export function shuffledOutfit(chief = false, random: () => number = Math.random): BlobOutfit {
  const pool = chief ? ACCESSORY_CHOICES : PICKABLE_ACCESSORY_CHOICES;
  return outfitOf(pool[Math.floor(random() * pool.length)]!);
}

export type StarterBlobId =
  | "kora"
  | "popo"
  | "bobble"
  | "dimp"
  | "junip"
  | "wobbo"
  | "tibbo"
  | "mibble"
  | "zonk"
  | "plonk"
  | "fizzle";

/** The starter roster, exactly as docs/bots/SPEC.md "Starter roster". */
export const STARTER_OUTFITS: Readonly<Record<StarterBlobId, BlobOutfit>> = {
  kora: { head: "crown" },
  popo: { face: "round-glasses" },
  bobble: { head: "headphones" },
  dimp: { head: "cap" },
  junip: { head: "beret" },
  wobbo: { face: "monocle" },
  tibbo: { head: "top-hat" },
  mibble: { face: "sunglasses" },
  zonk: { head: "beanie" },
  plonk: { face: "square-glasses" },
  fizzle: { head: "flower" },
};

export const STARTER_BLOB_IDS = Object.keys(STARTER_OUTFITS) as StarterBlobId[];

export const STARTER_NAMES: Readonly<Record<StarterBlobId, string>> = {
  kora: "Kora",
  popo: "Popo",
  bobble: "Bobble",
  dimp: "Dimp",
  junip: "Junip",
  wobbo: "Wobbo",
  tibbo: "Tibbo",
  mibble: "Mibble",
  zonk: "Zonk",
  plonk: "Plonk",
  fizzle: "Fizzle",
};

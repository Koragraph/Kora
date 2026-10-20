/** Maps the wire-level outfit ids (HeadId / FaceId) to the pixel sprite's accessory overlays. */
import type { SpriteAccessory } from "~/components/sprite";

import type { BlobOutfit, FaceId, HeadId } from "./outfit";

const HEAD_SPRITE: Partial<Record<HeadId, SpriteAccessory>> = {
  "top-hat": "tophat",
  beanie: "beanie",
  cap: "cap",
  beret: "beret",
  crown: "crown",
  headphones: "phones",
  flower: "flower",
};

const FACE_SPRITE: Partial<Record<FaceId, SpriteAccessory>> = {
  monocle: "monocle",
  "round-glasses": "round",
  "square-glasses": "square",
  sunglasses: "shades",
};

/** The single accessory a blob wears: head, else face. Legacy ids with no art draw nothing; the Chief defaults to the crown. */
export function spriteAccessoryFor(
  outfit: BlobOutfit | undefined,
  chief: boolean,
): SpriteAccessory | null {
  const head = outfit?.head ? HEAD_SPRITE[outfit.head] : undefined;
  if (head) return head;
  const face = outfit?.face ? FACE_SPRITE[outfit.face] : undefined;
  if (face) return face;
  if (chief && !outfit?.head && !outfit?.face) return "crown";
  return null;
}

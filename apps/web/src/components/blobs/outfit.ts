// The one place that knows both outfit shapes: the wire's `{ head, face, neck }` of nullable ids (BlobOutfitWire)
// and the avatar's sparse `BlobOutfit`. A null wire outfit means "the default for this id".
import type { BlobOutfitWire } from "@kora/contracts";

import {
  FACE_IDS,
  HEAD_IDS,
  STARTER_OUTFITS,
  defaultOutfitFor,
  type BlobOutfit,
} from "~/components/blobs/avatar";

const oneOf = <T extends string>(ids: readonly T[], value: string | null): T | undefined =>
  ids.find((id) => id === value);

/** The Chief wears the crown unless the user changed it. */
function fallbackOutfitFor(id: string, chief: boolean): BlobOutfit {
  return chief ? { ...STARTER_OUTFITS.kora } : defaultOutfitFor(id);
}

/** Wire -> avatar. Unknown accessory ids (a newer daemon) are dropped, never rendered as garbage. */
export function toAvatarOutfit(
  wire: BlobOutfitWire | null | undefined,
  id: string,
  chief = false,
): BlobOutfit {
  if (!wire) return fallbackOutfitFor(id, chief);
  const outfit: BlobOutfit = {};
  const head = oneOf(HEAD_IDS, wire.head);
  const face = oneOf(FACE_IDS, wire.face);
  if (head) outfit.head = head;
  if (face) outfit.face = face;
  return outfit;
}

/** Avatar -> wire: every slot present, empty ones null. */
export function fromAvatarOutfit(outfit: BlobOutfit): BlobOutfitWire {
  return { head: outfit.head ?? null, face: outfit.face ?? null, neck: null };
}

export function sameOutfit(a: BlobOutfit, b: BlobOutfit): boolean {
  return a.head === b.head && a.face === b.face;
}

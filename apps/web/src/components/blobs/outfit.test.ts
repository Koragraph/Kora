import { describe, expect, it } from "vite-plus/test";

import { defaultOutfitFor } from "~/components/blobs/avatar";
import { fromAvatarOutfit, sameOutfit, toAvatarOutfit } from "./outfit";

describe("blob outfit adapter", () => {
  it("null wire = the deterministic default for the id", () => {
    expect(toAvatarOutfit(null, "blob_abc")).toEqual(defaultOutfitFor("blob_abc"));
  });
  it("the Chief's default is the crown alone", () => {
    expect(toAvatarOutfit(null, "blob_kora", true)).toEqual({ head: "crown" });
  });
  it("round-trips a sparse outfit through the wire", () => {
    const outfit = { head: "beret", face: "monocle" } as const;
    const wire = fromAvatarOutfit(outfit);
    expect(wire).toEqual({ head: "beret", face: "monocle", neck: null });
    expect(toAvatarOutfit(wire, "x")).toEqual(outfit);
  });
  it("drops accessory ids it does not know", () => {
    expect(toAvatarOutfit({ head: "laser-helmet", face: "monocle", neck: null }, "x")).toEqual({
      face: "monocle",
    });
  });
  it("compares outfits slot by slot", () => {
    expect(sameOutfit({ head: "cap" }, { head: "cap" })).toBe(true);
    expect(sameOutfit({ head: "cap" }, { head: "cap", face: "monocle" })).toBe(false);
  });
});

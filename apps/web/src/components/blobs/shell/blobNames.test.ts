import { describe, expect, it } from "vite-plus/test";

import { BLOB_NAME_POOL, suggestBlobName } from "./blobNames";

describe("suggestBlobName", () => {
  it("never suggests a taken name (case-insensitive)", () => {
    for (let i = 0; i < 50; i += 1) {
      const name = suggestBlobName(["popo", "BOBBLE"], Math.random);
      expect(name.toLowerCase()).not.toBe("popo");
      expect(name.toLowerCase()).not.toBe("bobble");
    }
  });
  it("avoids the name it just suggested so 'suggest again' changes it", () => {
    for (let i = 0; i < 50; i += 1)
      expect(suggestBlobName([], Math.random, "Tiki")).not.toBe("Tiki");
  });
  it("falls back to a numbered name when the pool is exhausted", () => {
    expect(suggestBlobName(BLOB_NAME_POOL, () => 0)).toBe(`${BLOB_NAME_POOL[0]} 2`);
  });
});

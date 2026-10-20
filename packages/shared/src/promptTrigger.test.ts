import { describe, expect, it } from "vite-plus/test";

import { serializePromptFileLink } from "./promptTrigger.ts";

describe("serializePromptFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializePromptFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializePromptFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializePromptFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializePromptFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

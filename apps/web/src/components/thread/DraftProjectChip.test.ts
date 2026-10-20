import { describe, expect, it } from "vite-plus/test";

import { abbreviateHomePath } from "./DraftProjectChip";

describe("abbreviateHomePath", () => {
  it("replaces a macOS or Linux home prefix with ~", () => {
    expect(abbreviateHomePath("/Users/akhil/Projects/kora")).toBe("~/Projects/kora");
    expect(abbreviateHomePath("/home/dev/src/app")).toBe("~/src/app");
    expect(abbreviateHomePath("/Users/akhil")).toBe("~");
  });
  it("leaves other paths alone", () => {
    expect(abbreviateHomePath("/opt/repo")).toBe("/opt/repo");
    expect(abbreviateHomePath("/Users")).toBe("/Users");
  });
});

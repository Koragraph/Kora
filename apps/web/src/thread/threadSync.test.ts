import { resolveThreadLoadPhase } from "./threadSync";
import { describe, expect, it } from "vite-plus/test";

describe("resolveThreadLoadPhase", () => {
  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadLoadPhase({
        status: "empty",
        shellExists: false,
        detailExists: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadLoadPhase({
        status: "live",
        shellExists: true,
        detailExists: true,
      }),
    ).toBeNull();
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadLoadPhase({
        status: "cached",
        shellExists: true,
        detailExists: true,
      }),
    ).toBe("syncing");
  });
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadLoadPhase({
        status: "synchronizing",
        shellExists: true,
        detailExists: false,
      }),
    ).toBe("loading");
  });
});

import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { describe, expect, it } from "vite-plus/test";

describe("resolveCenteredFileLineScrollTop", () => {
  it("corrects a stale estimate from the rendered line geometry", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        renderedLine: { top: 620, height: 20 },
        estimatedLine: { top: 1_000, height: 20 },
        fileTop: 20,
        viewportHeight: 400,
        viewportTop: 100,
        scrollHeight: 2_000,
        scrollTop: 830,
      }),
    ).toBe(1_160);
  });
  it("centers an estimated virtualized line position", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        estimatedLine: { top: 1_000, height: 20 },
        fileTop: 20,
        viewportHeight: 400,
        viewportTop: 100,
        scrollHeight: 2_000,
        scrollTop: 0,
      }),
    ).toBe(830);
  });
});

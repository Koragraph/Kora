import { resolvePromptMenuActiveItemId } from "./promptMenuHighlight";
import { describe, expect, it } from "vite-plus/test";

describe("resolvePromptMenuActiveItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("falls back to the first item when the highlighted item disappears", () => {
    expect(
      resolvePromptMenuActiveItemId({
        highlightedSearchKey: "skill:ui",
        currentSearchKey: "skill:ui",
        highlightedItemId: "missing",
        items,
      }),
    ).toBe("top");
  });

  it("resets to the top result when the query changes", () => {
    expect(
      resolvePromptMenuActiveItemId({
        highlightedSearchKey: "skill:u",
        currentSearchKey: "skill:ui",
        highlightedItemId: "second",
        items,
      }),
    ).toBe("top");
  });

  it("preserves the highlighted item within the same query", () => {
    expect(
      resolvePromptMenuActiveItemId({
        highlightedSearchKey: "skill:u",
        currentSearchKey: "skill:u",
        highlightedItemId: "second",
        items,
      }),
    ).toBe("second");
  });

  it("defaults to the first item when nothing is highlighted", () => {
    expect(
      resolvePromptMenuActiveItemId({
        highlightedSearchKey: null,
        currentSearchKey: "skill:u",
        highlightedItemId: null,
        items,
      }),
    ).toBe("top");
  });
});

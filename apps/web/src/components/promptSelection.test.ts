import { describe, expect, it } from "vite-plus/test";

import { didPromptSelectionChangeVisibly } from "./promptSelection";

describe("didPromptSelectionChangeVisibly", () => {
  it("ignores selection-neutral editor updates", () => {
    expect(didPromptSelectionChangeVisibly({ start: 3, end: 3 }, null)).toBe(false);
    expect(didPromptSelectionChangeVisibly({ start: 3, end: 3 }, { start: 3, end: 3 })).toBe(false);
  });

  it("detects entering and extending a visible range selection", () => {
    expect(didPromptSelectionChangeVisibly({ start: 3, end: 3 }, { start: 0, end: 3 })).toBe(true);
    expect(didPromptSelectionChangeVisibly({ start: 1, end: 3 }, { start: 0, end: 3 })).toBe(true);
  });

  it("does not repeatedly report the same visible selection", () => {
    expect(didPromptSelectionChangeVisibly({ start: 0, end: 3 }, { start: 0, end: 3 })).toBe(false);
  });
});

import { shouldCollapsePromptForScrollKey } from "./promptScrollGesture";
import { describe, expect, it } from "vite-plus/test";

describe("composer keyboard scroll collapse", () => {
  const middle = {
    isAtLogicalEnd: false,
    clientHeight: 500,
    scrollHeight: 1500,
    scrollTop: 500,
  };

  it("ignores unrelated keys", () => {
    expect(shouldCollapsePromptForScrollKey({ ...middle, key: "Enter" })).toBe(false);
  });

  it.each(["PageDown", "End"])("does not collapse on %s at the logical end", (key) => {
    expect(shouldCollapsePromptForScrollKey({ ...middle, key, isAtLogicalEnd: true })).toBe(false);
    expect(shouldCollapsePromptForScrollKey({ ...middle, key, scrollTop: 1000 })).toBe(false);
  });

  it.each(["PageUp", "Home"])("does not collapse on %s at the top", (key) => {
    expect(shouldCollapsePromptForScrollKey({ ...middle, key, scrollTop: 0 })).toBe(false);
  });

  it.each(["PageUp", "PageDown", "Home", "End"])("collapses on %s in the timeline", (key) => {
    expect(shouldCollapsePromptForScrollKey({ ...middle, key })).toBe(true);
  });
});

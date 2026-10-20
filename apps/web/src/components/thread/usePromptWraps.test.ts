import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { promptWraps } from "./usePromptWraps";

/**
 * A composer 500px wide inside (padding 16 + 16), whose editor is `editorWidth` wide with `lineHeight` lines, holding
 * text that measures `text` (width x height).
 */
function wraps(text: { width: number; height: number }, editorWidth = 500, lineHeight = 22.75) {
  const editor = { clientWidth: editorWidth };
  const body = { clientWidth: 532, querySelector: () => editor };
  vi.stubGlobal("getComputedStyle", (el: unknown) =>
    el === body ? { paddingLeft: "16px", paddingRight: "16px" } : { lineHeight: `${lineHeight}px` },
  );
  vi.stubGlobal("document", {
    createRange: () => ({ selectNodeContents: () => undefined, getBoundingClientRect: () => text }),
  });
  return promptWraps(body as unknown as HTMLElement);
}

afterEach(() => vi.unstubAllGlobals());

describe("promptWraps", () => {
  it("has no answer while the editor is hidden (zero width)", () => {
    expect(wraps({ width: 0, height: 0 }, 0)).toBeNull();
  });

  it("follows the text height: one line, two lines, back to one", () => {
    expect(wraps({ width: 480, height: 22.75 })).toBe(false);
    expect(wraps({ width: 480, height: 45.5 })).toBe(true);
    expect(wraps({ width: 120, height: 22.75 })).toBe(false);
  });

  it("allows a pixel of rounding on either axis", () => {
    expect(wraps({ width: 500.6, height: 23.5 })).toBe(false);
  });

  describe("with the actions inline (narrower editor, taller line box)", () => {
    it("judges width against the full row, so text that fits it stays one line", () => {
      expect(wraps({ width: 450, height: 32 }, 400, 32)).toBe(false);
    });

    it("still spots unwrapped text wider than the full row (a restored long draft)", () => {
      expect(wraps({ width: 700, height: 32 }, 400, 32)).toBe(true);
    });
  });
});

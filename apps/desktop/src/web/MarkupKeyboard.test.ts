import { describe, expect, it } from "vite-plus/test";

import { resolveMarkupSubmission } from "./MarkupKeyboard.ts";

const keyboardEvent = (overrides: Partial<Parameters<typeof resolveMarkupSubmission>[0]> = {}) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("resolveMarkupSubmission", () => {
  it("attaches on Enter, with or without a modifier (no send shortcut)", () => {
    expect(resolveMarkupSubmission(keyboardEvent())).toBe("attach");
    expect(resolveMarkupSubmission(keyboardEvent({ metaKey: true }))).toBe("attach");
    expect(resolveMarkupSubmission(keyboardEvent({ ctrlKey: true }))).toBe("attach");
  });

  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveMarkupSubmission(keyboardEvent({ shiftKey: true }))).toBeNull();
    expect(resolveMarkupSubmission(keyboardEvent({ isComposing: true }))).toBeNull();
    expect(resolveMarkupSubmission(keyboardEvent({ key: " " }))).toBeNull();
  });
});

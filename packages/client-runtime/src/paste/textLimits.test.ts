import { describe, expect, it } from "vite-plus/test";

import { wouldTextPasteExceedLimit } from "./textLimits.ts";

describe("text paste insertion", () => {
  // 100 chars with 40 of them selected leaves room for 40 more under a cap of 100.
  const pasteOf = (textLength: number) =>
    wouldTextPasteExceedLimit({
      maxLength: 100,
      textLength,
      valueLength: 100,
      selection: { end: 80, start: 40 },
    });

  it("counts the selection as freed before measuring the paste", () => {
    expect([pasteOf(30), pasteOf(40), pasteOf(41)]).toEqual([false, false, true]);
  });
});

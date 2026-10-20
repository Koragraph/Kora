import { describe, expect, test } from "vite-plus/test";

import {
  areFontAdvancesMonospace,
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  cssFontFamilies,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
} from "./appearanceFonts";

describe("font size clamping", () => {
  test.each([
    [clampInterfaceFontSize, 16, 16],
    [clampInterfaceFontSize, 2, 12],
    [clampInterfaceFontSize, 96, 20],
    [clampPromptFontSize, 40, 20],
    [clampCodeFontSize, 1, 10],
  ])("%o(%i) = %i", (clamp, input, expected) => {
    expect(clamp(input)).toBe(expected);
  });

  test("fractions are rounded", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampCodeFontSize(13.6)).toBe(14);
  });

  test("NaN and infinity fall back to each control's default", () => {
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});

describe("terminal font preferences", () => {
  const prefs = { code: "Fira Code", terminal: "Berkeley Mono" };

  test("in advanced mode the terminal has its own font, even an empty one", () => {
    expect(resolveTerminalFontPreference({ ...prefs, advanced: true })).toBe("Berkeley Mono");
    expect(resolveTerminalFontPreference({ code: "Fira Code", terminal: "", advanced: true })).toBe(
      "",
    );
  });

  test("in simple mode it follows the code font", () => {
    expect(resolveTerminalFontPreference({ ...prefs, advanced: false })).toBe("Fira Code");
    expect(
      resolveTerminalFontPreference({ code: "Fira Code", terminal: "", advanced: false }),
    ).toBe("Fira Code");
  });

  test("sizes follow the same rule", () => {
    expect(resolveTerminalFontSizePreference({ advanced: true, code: 15, terminal: 12 })).toBe(12);
    expect(resolveTerminalFontSizePreference({ advanced: false, code: 15, terminal: 12 })).toBe(15);
  });
});

describe("cssFontFamilies", () => {
  test.each([
    ["monospace", "monospace"],
    ["Fira Code", '"Fira Code"'],
    ["3270 Nerd Font", '"3270 Nerd Font"'],
    ["M+ 1m", '"M+ 1m"'],
    ['"Comic Mono"', '"Comic Mono"'],
    [" Fira Code , Menlo ", '"Fira Code", Menlo'],
    ['Bad"Name', '"BadName"'],
  ])("%j -> %s", (input, css) => {
    expect(cssFontFamilies(input)).toBe(css);
  });

  test.each(["", "   ", " , , "])("%j has no families", (input) => {
    expect(cssFontFamilies(input)).toBeNull();
  });
});

describe("areFontAdvancesMonospace", () => {
  test.each([[[]], [[Number.NaN, Number.NaN]]])(
    "%j (no usable metrics) is assumed monospace",
    (advances) => {
      expect(areFontAdvancesMonospace(advances)).toBe(true);
    },
  );

  test.each([
    [[10, 10, 10, 10], true],
    [[10, 10, 7, 10], false],
    [[10, 10.02], false],
  ])("%j -> %s", (advances, mono) => {
    expect(areFontAdvancesMonospace(advances)).toBe(mono);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  terminalDeleteInputData,
  terminalNavigationInputData,
  type ShellKeyLike,
} from "./keyInput";

function press(key: string, held: Partial<Omit<ShellKeyLike, "key">> = {}): ShellKeyLike {
  return {
    key,
    type: "keydown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...held,
  };
}

const MAC = "MacIntel";
const PC = "Win32";

describe("shell line-editing keys on a Mac", () => {
  it.each([
    ["Option+Left moves a word back", press("ArrowLeft", { altKey: true }), "\u001bb"],
    ["Option+Right moves a word forward", press("ArrowRight", { altKey: true }), "\u001bf"],
    ["Cmd+Left jumps to the line start", press("ArrowLeft", { metaKey: true }), "\u0001"],
    ["Cmd+Right jumps to the line end", press("ArrowRight", { metaKey: true }), "\u0005"],
  ])("%s", (_name, event, bytes) => {
    expect(terminalNavigationInputData(event, MAC)).toBe(bytes);
  });

  it("leaves plain, shifted, Ctrl and multi-modifier arrows to the terminal", () => {
    for (const event of [
      press("ArrowLeft"),
      press("ArrowLeft", { altKey: true, shiftKey: true }),
      press("ArrowLeft", { ctrlKey: true }),
      press("ArrowRight", { altKey: true, metaKey: true }),
      press("ArrowUp", { altKey: true }),
    ]) {
      expect(terminalNavigationInputData(event, MAC)).toBeNull();
    }
  });

  it("sends kill-to-line-start for Cmd+Backspace only", () => {
    expect(terminalDeleteInputData(press("Backspace", { metaKey: true }), MAC)).toBe("\u0015");
    expect(
      terminalDeleteInputData(press("Backspace", { metaKey: true, altKey: true }), MAC),
    ).toBeNull();
    expect(terminalDeleteInputData(press("Backspace"), MAC)).toBeNull();
  });

  it("ignores key-up events", () => {
    const up = { ...press("Backspace", { metaKey: true }), type: "keyup" };
    expect(terminalDeleteInputData(up, MAC)).toBeNull();
    expect(
      terminalNavigationInputData({ ...press("ArrowLeft", { altKey: true }), type: "keyup" }, MAC),
    ).toBeNull();
  });
});

describe("shell line-editing keys elsewhere", () => {
  it("moves by word with Ctrl or Alt, never with Meta", () => {
    expect(terminalNavigationInputData(press("ArrowLeft", { ctrlKey: true }), PC)).toBe("\u001bb");
    expect(terminalNavigationInputData(press("ArrowRight", { altKey: true }), PC)).toBe("\u001bf");
    expect(terminalNavigationInputData(press("ArrowRight", { metaKey: true }), PC)).toBeNull();
  });

  it("has no Cmd+Backspace mapping", () => {
    expect(terminalDeleteInputData(press("Backspace", { metaKey: true }), PC)).toBeNull();
  });
});

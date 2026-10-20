import { describe, expect, it } from "vite-plus/test";
import { resolveAppShortcut } from "./appShortcuts";

const key = (
  k: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("resolveAppShortcut", () => {
  it("maps ⌘B and ⌘, on the Mac", () => {
    expect(resolveAppShortcut(key("b", { metaKey: true }), true)).toBe("toggle-sidebar");
    expect(resolveAppShortcut(key(",", { metaKey: true }), true)).toBe("open-settings");
  });

  it("uses Ctrl off the Mac and ignores the other modifier", () => {
    expect(resolveAppShortcut(key("B", { ctrlKey: true }), false)).toBe("toggle-sidebar");
    expect(resolveAppShortcut(key("b", { ctrlKey: true }), true)).toBeNull();
    expect(resolveAppShortcut(key("b", { metaKey: true }), false)).toBeNull();
  });

  it("ignores Shift/Alt chords and plain keys", () => {
    expect(resolveAppShortcut(key("b", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolveAppShortcut(key("b"), true)).toBeNull();
  });
});

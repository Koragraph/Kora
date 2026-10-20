import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { isAppWindow } from "./AppWindows.ts";

describe("isAppWindow", () => {
  const appSession = { name: "default" };
  const guestSession = { name: "persist:kora-preview-abc" };

  it("is true only for windows in the app's own session", () => {
    expect(isAppWindow({ webContents: { session: appSession } }, appSession)).toBe(true);
    expect(isAppWindow({ webContents: { session: guestSession } }, appSession)).toBe(false);
    expect(isAppWindow({ webContents: {} }, appSession)).toBe(false);
    expect(isAppWindow({}, appSession)).toBe(false);
  });

  it("fails closed when the window's contents are gone", () => {
    const destroyed = {
      get webContents(): never {
        throw new Error("Object has been destroyed");
      },
    };
    expect(isAppWindow(destroyed, appSession)).toBe(false);
  });
});

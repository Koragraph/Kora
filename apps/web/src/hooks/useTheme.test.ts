import { describe, expect, it } from "vite-plus/test";

import indexHtml from "../../index.html?raw";
import bootFrameScript from "../../public/boot-frame.js?raw";
import { useTheme } from "./useTheme";

describe("useTheme · Kora is dark-only (Ink)", () => {
  it("always resolves dark", () => {
    expect(useTheme().resolvedTheme).toBe("dark");
  });

  it("the boot script paints the Ink frame and turns dark on before the app mounts", () => {
    // Loaded as an external classic script first thing in <head>, never inline:
    // the packaged app's CSP refuses inline script.
    expect(indexHtml).toContain('<script src="/boot-frame.js"></script>');
    expect(indexHtml).not.toMatch(/<script>\s*\S/);
    expect(bootFrameScript).toContain('root.classList.add("dark")');
    expect(bootFrameScript).toContain('const FRAME = "#000000"');
    expect(indexHtml + bootFrameScript).not.toContain("kora:theme");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { WEBVIEW_PREFERENCES } from "./WebviewPreferences.ts";

// Electron reads a <webview webpreferences="…"> attribute by splitting on "," and then "=", with no trimming, and
// keeps each value as a string. Two consequences this guards against: a stray space turns " sandbox" into an
// unknown key (so the guest silently gets defaults), and any non-empty string is truthy, so "no" would mean yes.
const asElectronReadsIt = new Map(
  WEBVIEW_PREFERENCES.split(",").map((pair) => {
    const [key = "", value] = pair.split("=");
    return [key, value] as const;
  }),
);

describe("the preferences every preview <webview> is created with", () => {
  it("isolate the page, sandbox it and keep Node out, and say nothing else", () => {
    expect(Object.fromEntries(asElectronReadsIt)).toEqual({
      contextIsolation: "true",
      sandbox: "true",
      nodeIntegration: "false",
    });
  });

  it("are written the only way Electron reads correctly: no spaces, only true/false", () => {
    expect(WEBVIEW_PREFERENCES).toMatch(/^(\w+=(true|false))(,\w+=(true|false))*$/);
  });
});

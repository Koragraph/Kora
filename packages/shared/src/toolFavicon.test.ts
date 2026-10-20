import { describe, expect, it } from "vite-plus/test";

import { toolActivityFaviconUrl } from "./toolFavicon.ts";

describe("toolActivityFaviconUrl (local-only, pl4 S3-12)", () => {
  it("never builds a remote icon URL: no /favicon.ico, no site CDN, no provider http(s) icon", () => {
    expect(
      toolActivityFaviconUrl({ pageUrl: "https://example.com/docs/page?q=1" }, "light"),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl({ pageUrl: "https://github.com/openai/codex" }, "dark"),
    ).toBeNull();
    expect(
      toolActivityFaviconUrl(
        { pageUrl: "https://example.com/docs", faviconUrl: "https://example.com/icon.png" },
        "light",
      ),
    ).toBeNull();
  });

  it("shows an icon that arrived inline, preferring the dark one in dark mode", () => {
    const light = "data:image/png;base64,AAAA";
    const dark = "data:image/png;base64,BBBB";
    const icon = { pageUrl: "https://example.com", faviconUrl: light, faviconUrlDark: dark };
    expect(toolActivityFaviconUrl(icon, "light")).toBe(light);
    expect(toolActivityFaviconUrl(icon, "dark")).toBe(dark);
    expect(
      toolActivityFaviconUrl({ pageUrl: "https://example.com", faviconUrl: light }, "dark"),
    ).toBe(light);
  });
});

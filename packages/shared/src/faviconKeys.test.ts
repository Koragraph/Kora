import { describe, expect, it } from "vite-plus/test";

import * as favicon from "./faviconKeys.ts";

const marker = favicon.PROJECT_FAVICON_FALLBACK_MARKER;
const asset = (token: string, file: string) => `https://host.test/api/assets/${token}/${file}`;
const keyFor = (host: string, url: string) => favicon.getProjectFaviconCacheKey(host, "/repo", url);

describe("project favicon cache key", () => {
  it("ignores the signed token so a refreshed URL hits the same entry", () => {
    expect(keyFor("h1", asset("tok-a", "3-icon.png"))).toBe(
      keyFor("h1", asset("tok-b", "3-icon.png")),
    );
  });

  it("changes when the versioned filename changes", () => {
    expect(keyFor("h1", asset("tok-a", "3-icon.png"))).not.toBe(
      keyFor("h1", asset("tok-a", "4-icon.png")),
    );
  });

  it("is scoped per host", () => {
    const url = asset("tok-a", "3-icon.png");
    expect(keyFor("h1", url)).not.toBe(keyFor("h2", url));
  });
});

describe("project favicon fallback detection", () => {
  it.each([asset("tok", marker), `/api/assets/tok/${marker}`])("recognises %s", (url) => {
    expect(favicon.isProjectFaviconFallbackUrl(url)).toBe(true);
  });

  it.each([
    asset("tok", "icon.png"),
    `${asset("tok", "icon.png")}?file=${marker}`,
    null,
    undefined,
    "",
  ])("rejects %s", (url) => {
    expect(favicon.isProjectFaviconFallbackUrl(url)).toBe(false);
  });
});

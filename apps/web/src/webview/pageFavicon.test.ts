import { describe, expect, test } from "vite-plus/test";

import {
  BROWSER_FAVICON_MAX_ENTRIES,
  evictExcessFavicons,
  faviconKey,
  faviconStorageLocation,
  isStorableFaviconDataUrl,
  migrateSavedFavicons,
  type BrowserFaviconEntry,
} from "./pageFavicon";

const PNG = "data:image/png;base64,QUJD";
const icon = (capturedAt = 0): BrowserFaviconEntry => ({ capturedAt, dataUrl: PNG });
const SCOPE = "env:proj";
const HOST = "10.1.2.3";

describe("isStorableFaviconDataUrl", () => {
  test.each([
    [PNG, true],
    ["data:image/svg+xml;base64,QUJD", false],
    ["data:image/png;base64,", false],
    ["data:image/png;base64,%%%%", false],
    ["https://example.com/icon.png", false],
    [`data:image/png;base64,${"A".repeat(8192)}`, false],
  ])("%s -> %s", (url, ok) => {
    expect(isStorableFaviconDataUrl(url)).toBe(ok);
  });
});

describe("evictExcessFavicons", () => {
  test("the oldest captures go first once the cap is exceeded", () => {
    const all = Object.fromEntries(
      Array.from({ length: BROWSER_FAVICON_MAX_ENTRIES + 2 }, (_, n) => [`k${n}`, icon(n)]),
    );
    const kept = evictExcessFavicons(all);
    expect(Object.keys(kept)).toHaveLength(BROWSER_FAVICON_MAX_ENTRIES);
    expect(kept["k0"]).toBeUndefined();
    expect(kept["k1"]).toBeUndefined();
    expect(kept[`k${BROWSER_FAVICON_MAX_ENTRIES + 1}`]).toBeDefined();
  });
});

describe("migrateSavedFavicons", () => {
  test("drops unusable entries and cleans alias lists", () => {
    const out = migrateSavedFavicons({
      byKey: {
        [`${SCOPE} http://localhost:3002`]: { dataUrl: PNG, capturedAt: Number.NaN },
        [`${SCOPE} http://localhost:3001`]: { dataUrl: "https://example.com/i.png", capturedAt: 6 },
        [`${SCOPE} http://localhost:3003`]: {
          ...icon(6),
          aliases: [
            "172.20.9.2",
            "172.20.9.2",
            "172.20.9.3",
            "172.20.9.4",
            "172.20.9.5",
            "172.20.9.6",
            "Not Normalized",
            "not a host/",
            "x".repeat(5000),
          ],
        },
        [`${SCOPE} http://localhost:3000`]: icon(5),
        [`${SCOPE} http://local:3000`]: icon(4),
      },
    });

    expect(out).toEqual({
      byKey: {
        [`${SCOPE} http://localhost:3003`]: {
          ...icon(6),
          aliases: ["172.20.9.2", "172.20.9.3", "172.20.9.4", "172.20.9.5"],
        },
        [`${SCOPE} http://localhost:3000`]: icon(5),
      },
    });
  });
});

describe("faviconKey", () => {
  test("is the scope plus the canonical origin (no path, query or default-port ambiguity)", () => {
    expect(faviconKey(SCOPE, "http://myapp.test:3000/admin?x=1", null)).toBe(
      `${SCOPE} http://myapp.test:3000`,
    );
    expect(faviconKey(SCOPE, "http://[2001:4860:4860::8888]/", null)).toBe(
      `${SCOPE} http://[2001:4860:4860::8888]:80`,
    );
  });

  test("the daemon host and localhost are one origin; 127.0.0.1 and 0.0.0.0 too", () => {
    expect(faviconKey(SCOPE, `http://${HOST}:3000/`, HOST)).toBe(
      faviconKey(SCOPE, "http://localhost:3000/", HOST),
    );
    expect(faviconKey(SCOPE, "http://127.0.0.1:3000/", null)).toBe(
      faviconKey(SCOPE, "http://0.0.0.0:3000/", null),
    );
  });

  test("different scope, port, protocol or host give different keys", () => {
    const keys = [
      faviconKey("env:a", "http://localhost:3000/", null),
      faviconKey("env:b", "http://localhost:3000/", null),
      faviconKey("env:a", "http://localhost:5173/", null),
      faviconKey("env:a", "https://localhost:3000/", null),
      faviconKey("env:a", "http://192.168.1.50:3000/", HOST),
      faviconKey("env:a", "http://local:3000/", null),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test.each([
    ["env:a", "not a url"],
    ["env:a", "ftp://example.com/"],
    ["", "http://localhost/"],
  ])("(%j, %j) has no key", (scope, url) => {
    expect(faviconKey(scope, url, null)).toBeNull();
  });
});

describe("faviconStorageLocation", () => {
  test("a page on the daemon host (by name or address) is stored under localhost with the address as an alias", () => {
    const stored = { key: `${SCOPE} http://localhost:3000`, aliases: [HOST] };
    expect(faviconStorageLocation(SCOPE, "http://localhost:3000/app", HOST)).toEqual(stored);
    expect(faviconStorageLocation(SCOPE, `http://${HOST}:3000/app`, HOST)).toEqual(stored);
  });

  test("an IPv6 daemon address is kept as an alias too", () => {
    expect(faviconStorageLocation(SCOPE, "http://localhost:3000/app", "fd00::1")).toEqual({
      key: `${SCOPE} http://localhost:3000`,
      aliases: ["fd00::1"],
    });
  });

  test("an unrelated site gets no alias", () => {
    expect(faviconStorageLocation(SCOPE, "https://example.com/app", HOST)).toEqual({
      key: `${SCOPE} https://example.com:443`,
      aliases: [],
    });
  });
});

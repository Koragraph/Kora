import type { LinkOpenTarget } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { ensureClientPrefsHydrated } from "~/hooks/usePrefs";

import { resolveBrowserLinkTargetPreference, resolveLinkTarget } from "./browserLinkTarget";

const prefs = vi.hoisted(() => ({ browserLinkTarget: "system" as LinkOpenTarget }));

vi.mock("~/hooks/usePrefs", () => ({
  getClientPrefs: () => prefs,
  ensureClientPrefsHydrated: vi.fn(async () => undefined),
}));

const PLAIN_CLICK = { metaKey: false, ctrlKey: false };
const WEB = "https://example.com/";

const decide = (over: Partial<Parameters<typeof resolveLinkTarget>[0]> = {}) =>
  resolveLinkTarget({
    url: WEB,
    event: PLAIN_CLICK,
    preference: "app",
    canOpenInApp: true,
    ...over,
  });

describe("resolveBrowserLinkTargetPreference", () => {
  test.each(["system", "app"] as const)(
    "a failed settings read rejects instead of guessing; a retry returns %s",
    async (stored) => {
      prefs.browserLinkTarget = stored;
      const err = new Error("prefs read failed");
      vi.mocked(ensureClientPrefsHydrated).mockRejectedValueOnce(err);

      await expect(resolveBrowserLinkTargetPreference()).rejects.toBe(err);
      await expect(resolveBrowserLinkTargetPreference()).resolves.toBe(stored);
    },
  );
});

describe("resolveLinkTarget", () => {
  test.each(["mailto:a@b.co", "vscode://file/x", "not a url"])(
    "%s is not a web link, so the shell handles it",
    (url) => {
      expect(decide({ url })).toBe("system");
    },
  );

  test.each([
    ["cmd", { metaKey: true, ctrlKey: false }],
    ["ctrl", { metaKey: false, ctrlKey: true }],
  ])("a %s-click escapes the in-app default", (_key, event) => {
    expect(decide({ event })).toBe("system");
  });

  test("with no in-app browser available the link still opens, in the system browser", () => {
    expect(decide({ canOpenInApp: false })).toBe("system");
  });

  test("in-app is used when preferred and possible", () => {
    expect(decide()).toBe("app");
  });

  test("the system preference stays with the system browser", () => {
    expect(decide({ preference: "system" })).toBe("system");
  });
});

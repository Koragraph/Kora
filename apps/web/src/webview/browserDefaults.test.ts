import { DEFAULT_WEB_PROFILE_ID, PRIVATE_WEB_PROFILE_ID } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { ensureClientPrefsHydrated } from "~/hooks/usePrefs";

const stored = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));

vi.mock("~/hooks/usePrefs", () => ({
  ensureClientPrefsHydrated: vi.fn(async () => undefined),
  useClientPrefs: () => undefined,
  getClientPrefs: () => stored.prefs,
}));

const { getBrowserDefaults, resolveBrowserDefaults } = await import("./browserDefaults");

function storeWithDefaultProfile(id: string) {
  stored.prefs = {
    browserDefaultProfileId: id,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultAppearance: "system",
    browserDefaultZoomFactor: 1,
    browserDefaultViewport: { _tag: "fill" },
  };
  return getBrowserDefaults();
}

describe("getBrowserDefaults profile choice", () => {
  test.each([
    ["the private profile", PRIVATE_WEB_PROFILE_ID, DEFAULT_WEB_PROFILE_ID],
    ["a profile that no longer exists", "deleted", DEFAULT_WEB_PROFILE_ID],
    ["a configured persistent profile", "work", "work"],
  ])("%s", (_label, configured, effective) => {
    expect(storeWithDefaultProfile(configured).profileId).toBe(effective);
  });
});

describe("resolveBrowserDefaults", () => {
  test("a failed hydration rejects; the next call returns the saved values", async () => {
    storeWithDefaultProfile("work");
    Object.assign(stored.prefs, {
      browserDefaultZoomFactor: 1.5,
      browserDefaultAppearance: "light",
    });
    const boom = new Error("hydrate failed");
    vi.mocked(ensureClientPrefsHydrated).mockRejectedValueOnce(boom);

    await expect(resolveBrowserDefaults()).rejects.toBe(boom);
    await expect(resolveBrowserDefaults()).resolves.toMatchObject({
      profileId: "work",
      appearance: "light",
      zoomFactor: 1.5,
      viewport: { _tag: "fill" },
    });
  });
});

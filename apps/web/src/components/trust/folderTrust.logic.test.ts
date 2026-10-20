import { describe, expect, it } from "vite-plus/test";

import { displayFolder, shouldShowTrustPrompt, trustSourceLabel } from "./folderTrust.logic";

const status = (
  over: Partial<Parameters<typeof shouldShowTrustPrompt>[0]["status"] & object> = {},
) => ({
  cwd: "/Users/me/code/app",
  root: "/Users/me/code/app",
  trusted: false,
  trustedBy: null,
  source: null,
  canTrust: true,
  reason: null,
  ...over,
});

describe("shouldShowTrustPrompt", () => {
  it("asks in an untrusted, trustable folder", () => {
    expect(
      shouldShowTrustPrompt({
        status: status(),
        isAssistantLane: false,
        dismissedRoots: new Set(),
      }),
    ).toBe(true);
  });
  it("stays quiet when trusted, untrustable, unknown, dismissed or on the assistant lane", () => {
    const none = new Set<string>();
    expect(
      shouldShowTrustPrompt({
        status: status({ trusted: true }),
        isAssistantLane: false,
        dismissedRoots: none,
      }),
    ).toBe(false);
    expect(
      shouldShowTrustPrompt({
        status: status({ canTrust: false, reason: "home" }),
        isAssistantLane: false,
        dismissedRoots: none,
      }),
    ).toBe(false);
    expect(
      shouldShowTrustPrompt({ status: null, isAssistantLane: false, dismissedRoots: none }),
    ).toBe(false);
    expect(
      shouldShowTrustPrompt({ status: status(), isAssistantLane: true, dismissedRoots: none }),
    ).toBe(false);
    expect(
      shouldShowTrustPrompt({
        status: status(),
        isAssistantLane: false,
        dismissedRoots: new Set(["/Users/me/code/app"]),
      }),
    ).toBe(false);
  });
});

describe("labels", () => {
  it("shortens the home folder and names the trust source", () => {
    expect(displayFolder("/Users/me/code/app")).toBe("~/code/app");
    expect(trustSourceLabel("migration")).toMatch(/before/);
    expect(trustSourceLabel("user")).toBe("trusted by you");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  updateFeedFiles,
  updateFeedRefusal,
  updatePublishConfig,
  winSigning,
} from "./win-release.mjs";

describe("updatePublishConfig", () => {
  it("maps the public repo to electron-builder's github provider", () => {
    expect(updatePublishConfig("github:agilkatakam/kora")).toEqual({
      provider: "github",
      owner: "agilkatakam",
      repo: "kora",
      releaseType: "release",
    });
    expect(updatePublishConfig(undefined)).toBeNull();
  });

  it("allows plain http only on loopback, like package-app.sh", () => {
    expect(updatePublishConfig("generic:http://127.0.0.1:8123/feed")).toEqual({
      provider: "generic",
      url: "http://127.0.0.1:8123/feed",
    });
    expect(() => updatePublishConfig("generic:http://example.com/feed")).toThrow(/http only/);
    expect(() => updatePublishConfig("s3:bucket")).toThrow(/--update-feed/);
  });
});

describe("winSigning", () => {
  const azure = {
    KORA_WIN_AZURE_ENDPOINT: "https://eus.codesigning.azure.net",
    KORA_WIN_AZURE_ACCOUNT: "koraplex",
    KORA_WIN_AZURE_PROFILE: "kora-public",
    KORA_WIN_PUBLISHER: "Koragraph",
    AZURE_TENANT_ID: "t",
    AZURE_CLIENT_ID: "c",
    AZURE_CLIENT_SECRET: "s",
  };

  it("is unsigned when no secret is present", () => {
    expect(winSigning({})).toEqual({ mode: "none", force: false, win: {} });
    expect(winSigning({ WIN_CSC_LINK: " " })).toEqual({ mode: "none", force: false, win: {} });
  });

  it("uses Azure Trusted Signing when its set is complete, and refuses half a set", () => {
    const s = winSigning(azure);
    expect(s.mode).toBe("azure");
    expect(s.force).toBe(true);
    expect(s.win).toEqual({
      azureSignOptions: {
        endpoint: azure.KORA_WIN_AZURE_ENDPOINT,
        codeSigningAccountName: "koraplex",
        certificateProfileName: "kora-public",
        publisherName: "Koragraph",
      },
    });
    expect(JSON.stringify(s)).not.toContain("AZURE_CLIENT_SECRET");
    expect(() => winSigning({ ...azure, AZURE_CLIENT_SECRET: "" })).toThrow(/AZURE_CLIENT_SECRET/);
  });

  it("uses a .pfx when WIN_CSC_LINK has its password, and never copies either into the config", () => {
    const s = winSigning({ WIN_CSC_LINK: "base64pfx", WIN_CSC_KEY_PASSWORD: "pw" });
    expect(s).toEqual({ mode: "pfx", force: true, win: {} });
    expect(
      winSigning({ WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "pw", KORA_WIN_PUBLISHER: "Koragraph" })
        .win,
    ).toEqual({ signtoolOptions: { publisherName: "Koragraph" } });
    expect(() => winSigning({ WIN_CSC_LINK: "x" })).toThrow(/WIN_CSC_KEY_PASSWORD/);
  });
});

it("updateFeedFiles keeps the feed and drops builder-debug.yml", () => {
  expect(
    updateFeedFiles([
      "Kora-Setup-0.2.0.exe",
      "Kora-Setup-0.2.0.exe.blockmap",
      "builder-debug.yml",
      "builder-effective-config.yaml",
      "latest.yml",
    ]),
  ).toEqual(["latest.yml"]);
});

describe("updateFeedRefusal (2026-10-15 audit desktop #7)", () => {
  const feed = updatePublishConfig("github:agilkatakam/kora");
  it("refuses a feed on an unsigned build or one without a publisher name", () => {
    expect(updateFeedRefusal(feed, winSigning({}))).toMatch(/signed build/);
    expect(
      updateFeedRefusal(feed, winSigning({ WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "p" })),
    ).toMatch(/KORA_WIN_PUBLISHER/);
  });
  it("allows a feed on a signed build with a publisher, and any build without a feed", () => {
    expect(
      updateFeedRefusal(
        feed,
        winSigning({ WIN_CSC_LINK: "x", WIN_CSC_KEY_PASSWORD: "p", KORA_WIN_PUBLISHER: "Kora" }),
      ),
    ).toBeNull();
    expect(updateFeedRefusal(null, winSigning({}))).toBeNull();
  });
});

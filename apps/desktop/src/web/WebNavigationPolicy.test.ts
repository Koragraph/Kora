import { describe, expect, it } from "vite-plus/test";

import {
  hardenWebviewAttach,
  isWebTabNavigationUrl,
  popupOriginTitle,
  type WebviewAttachPreferences,
} from "./WebNavigationPolicy.ts";

const PICK_PRELOAD =
  "/Applications/Kora.app/Contents/Resources/app/dist-electron/web-pick-preload.cjs";
const isBrowserPartition = (partition: string) =>
  partition.startsWith("persist:kora-preview-") || partition.startsWith("kora-preview-ephemeral-");

describe("isWebTabNavigationUrl", () => {
  it("admits web URLs, about:blank and blob: URLs of web pages", () => {
    for (const url of [
      "https://example.com/",
      "http://localhost:5173/app?x=1",
      "about:blank",
      "blob:https://example.com/3f0c1c5e-1b5a-4d5e-9a3a-6f3c2a1b0c9d",
    ]) {
      expect(isWebTabNavigationUrl(url), url).toBe(true);
    }
  });

  it("refuses local files, script and data URLs, app and custom schemes", () => {
    for (const url of [
      "file:///Users/me/.ssh/id_rsa",
      "FILE:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "kora://app/",
      "kora-dev://app/settings",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.com",
      "blob:file:///tmp/x",
      "blob:kora://app/uuid",
      "smb://evil.example/share",
      "ms-msdt:/id PCWDiagnostic",
      "about:srcdoc",
      "not a url",
      "",
    ]) {
      expect(isWebTabNavigationUrl(url), url).toBe(false);
    }
    expect(isWebTabNavigationUrl(undefined)).toBe(false);
  });
});

describe("hardenWebviewAttach", () => {
  const attach = (
    webPreferences: WebviewAttachPreferences,
    params: Record<string, string>,
  ): {
    allowed: boolean;
    webPreferences: WebviewAttachPreferences;
    params: Record<string, string>;
  } => {
    const allowed = hardenWebviewAttach({
      webPreferences,
      params,
      isBrowserPartition,
      pickPreloadPath: PICK_PRELOAD,
    });
    return { allowed, webPreferences, params };
  };

  it("refuses guests outside the preview partitions", () => {
    expect(attach({}, { partition: "persist:other" }).allowed).toBe(false);
    expect(attach({}, {}).allowed).toBe(false);
    // The default session (the app's own) must never be handed to a guest.
    expect(attach({}, { partition: "" }).allowed).toBe(false);
  });

  it("pins the security-critical preferences whatever the element asked for", () => {
    const { allowed, webPreferences } = attach(
      {
        sandbox: false,
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        nodeIntegrationInWorker: true,
        contextIsolation: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        experimentalFeatures: true,
        enableBlinkFeatures: "SomethingDangerous",
        // Inherited from the embedder (the app window) unless overridden.
        webviewTag: true,
      },
      { partition: "persist:kora-preview-abc", src: "https://example.com/" },
    );
    expect(allowed).toBe(true);
    expect(webPreferences).toEqual({
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
  });

  it("only ever runs the app's own picker preload", () => {
    const evil = attach(
      { preload: "/tmp/evil-preload.js" },
      { partition: "persist:kora-preview-abc" },
    );
    expect(evil.webPreferences.preload).toBe(PICK_PRELOAD);

    // The app window's privileged preload (shellBridge) must not leak into a guest either.
    const inherited = attach(
      { preload: "/Applications/Kora.app/Contents/Resources/app/dist-electron/preload.cjs" },
      { partition: "kora-preview-ephemeral-abc" },
    );
    expect(inherited.webPreferences.preload).toBe(PICK_PRELOAD);

    const none = attach({}, { partition: "persist:kora-preview-abc" });
    expect(none.webPreferences.preload).toBeUndefined();
  });

  it("rewrites a non-web initial src to about:blank and keeps web ones", () => {
    for (const src of [
      "file:///Users/me/.aws/credentials",
      "javascript:alert(document.domain)",
      "data:text/html,<h1>phish</h1>",
      "kora://app/",
    ]) {
      expect(attach({}, { partition: "persist:kora-preview-abc", src }).params.src, src).toBe(
        "about:blank",
      );
    }
    for (const src of ["https://example.com/", "http://localhost:3000/", "about:blank"]) {
      expect(attach({}, { partition: "persist:kora-preview-abc", src }).params.src, src).toBe(src);
    }
  });
});

describe("popupOriginTitle (2026-10-15 audit desktop #8)", () => {
  it("is the host the popup is on, never the page's own title", () => {
    expect(popupOriginTitle("https://accounts.google.com/o/oauth2/auth?x=1")).toBe(
      "accounts.google.com",
    );
    expect(popupOriginTitle("http://evil.example:8080/login")).toBe(
      "Not secure — evil.example:8080",
    );
    expect(popupOriginTitle("about:blank")).toBe("about");
    expect(popupOriginTitle("not a url")).toBe("about:blank");
  });
});

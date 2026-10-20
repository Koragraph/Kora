import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  decideAppSessionPermission,
  installAppSessionPermissionPolicy,
  isShellAppOrigin,
} from "./AppSessionPermissions.ts";

describe("isShellAppOrigin", () => {
  it("accepts the app's own origin and its blob: documents", () => {
    for (const url of [
      "kora://app/",
      "kora://app",
      "kora-dev://app/settings?x=1",
      "blob:kora://app/0b9d2f0e-5f7e-4c3c-9d7e-2f1b0a9c8d7e",
    ]) {
      expect(isShellAppOrigin(url), url).toBe(true);
    }
  });

  it("refuses everything else, including opaque and look-alike origins", () => {
    for (const url of [
      "null",
      "about:srcdoc",
      "about:blank",
      "https://evil.example/",
      "http://127.0.0.1:8797/",
      "kora://evil/",
      "kora://user:pass@app/",
      "smb://app/",
      "file:///Users/me/",
      "data:text/html,x",
      "blob:https://evil.example/uuid",
      "",
    ]) {
      expect(isShellAppOrigin(url), url).toBe(false);
    }
    expect(isShellAppOrigin(undefined)).toBe(false);
    expect(isShellAppOrigin(null)).toBe(false);
  });
});

describe("decideAppSessionPermission", () => {
  const fromApp = (permission: string) =>
    decideAppSessionPermission({ permission, requestingUrl: "kora://app/" });

  it.each(
    "clipboard-read clipboard-sanitized-write notifications local-fonts display-capture media fullscreen".split(
      " ",
    ),
  )("the app keeps %s", (permission) => expect(fromApp(permission)).toBe(true));

  it.each(
    "geolocation midi midiSysex hid serial usb pointerLock keyboardLock idle-detection window-management storage-access unknown".split(
      " ",
    ),
  )("the app never gets %s (it does not use it)", (permission) =>
    expect(fromApp(permission)).toBe(false),
  );

  it("denies every permission to third-party frames (agent HTML srcdoc, remote iframes)", () => {
    for (const requestingUrl of ["about:srcdoc", "null", "https://evil.example/"]) {
      for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
        expect(decideAppSessionPermission({ permission, requestingUrl })).toBe(false);
      }
      expect(
        decideAppSessionPermission({
          permission: "openExternal",
          requestingUrl,
          externalUrl: "https://example.com/",
        }),
      ).toBe(false);
    }
  });

  it("lets even the app hand only safe URLs to the OS", () => {
    const openExternal = (externalUrl: string | undefined) =>
      decideAppSessionPermission({
        permission: "openExternal",
        requestingUrl: "kora://app/",
        externalUrl,
      });
    expect(openExternal("https://example.com/")).toBe(true);
    expect(openExternal("vscode://vscode-remote/ssh-remote+host/home/me/project")).toBe(true);
    for (const url of [
      "smb://evil.example/share",
      "ms-msdt:/id PCWDiagnostic /skip force",
      "search-ms:query=x&crumb=location:\\\\evil\\share",
      "file:///Applications/Calculator.app",
      "x-apple.systempreferences:com.apple.preference.security",
      "javascript:alert(1)",
    ]) {
      expect(openExternal(url), url).toBe(false);
    }
    expect(openExternal(undefined)).toBe(false);
  });
});

describe("installAppSessionPermissionPolicy", () => {
  const makeSession = () => {
    const session = {
      requestHandler: undefined as
        | undefined
        | ((
            webContents: unknown,
            permission: string,
            callback: (granted: boolean) => void,
            details: Record<string, unknown>,
          ) => void),
      checkHandler: undefined as
        | undefined
        | ((
            webContents: unknown,
            permission: string,
            requestingOrigin: string,
            details: Record<string, unknown>,
          ) => boolean),
      setPermissionRequestHandler: vi.fn((handler) => {
        session.requestHandler = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        session.checkHandler = handler;
      }),
    };
    return session;
  };

  it("installs request and check handlers once per session", () => {
    const session = makeSession();
    installAppSessionPermissionPolicy(session as never);
    installAppSessionPermissionPolicy(session as never);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });

  it("decides requests by the requesting frame, not the top-level app window", () => {
    const session = makeSession();
    installAppSessionPermissionPolicy(session as never);
    const appContents = { getURL: () => "kora://app/" };
    const decide = (permission: string, details: Record<string, unknown>) => {
      let granted: boolean | undefined;
      session.requestHandler!(appContents, permission, (value) => (granted = value), details);
      return granted;
    };
    expect(decide("notifications", { requestingUrl: "kora://app/" })).toBe(true);
    expect(decide("media", { requestingUrl: "about:srcdoc", isMainFrame: false })).toBe(false);
    expect(
      decide("openExternal", {
        requestingUrl: "about:srcdoc",
        externalUrl: "smb://evil.example/share",
      }),
    ).toBe(false);
    expect(
      decide("openExternal", { requestingUrl: "kora://app/", externalURL: "smb://evil/share" }),
    ).toBe(false);
    expect(
      decide("openExternal", { requestingUrl: "kora://app/", externalURL: "https://example.com/" }),
    ).toBe(true);
  });

  it("answers permission checks by the requesting origin", () => {
    const session = makeSession();
    installAppSessionPermissionPolicy(session as never);
    const appContents = { getURL: () => "kora://app/" };
    expect(session.checkHandler!(appContents, "clipboard-sanitized-write", "kora://app", {})).toBe(
      true,
    );
    expect(session.checkHandler!(appContents, "clipboard-read", "null", {})).toBe(false);
    expect(
      session.checkHandler!(appContents, "media", "https://evil.example", {
        requestingUrl: "https://evil.example/frame",
      }),
    ).toBe(false);
    expect(session.checkHandler!(null, "notifications", "", {})).toBe(false);
  });
});

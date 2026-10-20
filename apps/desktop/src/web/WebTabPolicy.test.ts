import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { getPath: () => "/Users/test/Downloads" }, session: {} }));

import { installWebTabSessionPolicy } from "./WebPartitions.ts";
import {
  createDownloadRateLimiter,
  decideWebTabDownload,
  decideWebTabPermission,
  isLoopbackHostname,
  sanitizeDownloadFilename,
} from "./WebTabPolicy.ts";

describe("decideWebTabPermission", () => {
  it("treats only real loopback hosts as the user's dev server", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "[::1]",
      "LOCALHOST.",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of [
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "10.0.0.1",
      "example.com",
      "0.0.0.0",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it("denies non-web and credentialed origins outright", () => {
    for (const requestingUrl of [
      "file:///Users/me/",
      "data:text/html,x",
      "about:blank",
      "null",
      "",
      undefined,
      "http://user:pass@localhost/",
      "kora://app/",
    ]) {
      expect(
        decideWebTabPermission({ permission: "clipboard-sanitized-write", requestingUrl }),
        String(requestingUrl),
      ).toBe(false);
    }
  });

  it("resolves blob: URLs to their creator's origin", () => {
    expect(
      decideWebTabPermission({
        permission: "geolocation",
        requestingUrl: "blob:http://localhost:3000/x",
      }),
    ).toBe(true);
    expect(
      decideWebTabPermission({
        permission: "geolocation",
        requestingUrl: "blob:https://evil.example/x",
      }),
    ).toBe(false);
  });
});

describe("downloads", () => {
  it("sanitizes the pre-filled file name", () => {
    expect(sanitizeDownloadFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeDownloadFilename("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(sanitizeDownloadFilename("..\\..\\evil.exe")).toBe("evil.exe");
    expect(sanitizeDownloadFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeDownloadFilename("a\u0000b\nc:d?.txt")).toBe("a_b_c_d_.txt");
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename(undefined)).toBe("download");
    const long = sanitizeDownloadFilename(`${"x".repeat(300)}.tar.gz`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".gz")).toBe(true);
  });

  it("prompts for web downloads, naming the source, and cancels other schemes", () => {
    const decision = decideWebTabDownload({
      url: "https://files.example.com/a/report.pdf",
      suggestedFileName: "report.pdf",
      allowedByRateLimit: true,
    });
    expect(decision).toMatchObject({ action: "prompt", fileName: "report.pdf" });
    expect(decision.action === "prompt" && decision.title).toContain("files.example.com");
    for (const url of ["file:///etc/passwd", "kora://app/x", "javascript:alert(1)", "not a url"]) {
      expect(
        decideWebTabDownload({ url, suggestedFileName: "x", allowedByRateLimit: true }),
      ).toEqual({
        action: "cancel",
        reason: "scheme",
      });
    }
    expect(
      decideWebTabDownload({
        url: "blob:https://site.example/uuid",
        suggestedFileName: "a",
        allowedByRateLimit: true,
      }),
    ).toMatchObject({ action: "prompt" });
    expect(
      decideWebTabDownload({
        url: "https://a.example/x",
        suggestedFileName: "a",
        allowedByRateLimit: false,
      }),
    ).toEqual({ action: "cancel", reason: "rate-limit" });
  });

  it("rate-limits per tab in a sliding window", () => {
    let now = 0;
    const allow = createDownloadRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    expect(allow(1)).toBe(true);
    expect(allow(1)).toBe(true);
    expect(allow(1)).toBe(false);
    expect(allow(2)).toBe(true);
    now = 1_001;
    expect(allow(1)).toBe(true);
  });

  it("the session handler always shows a save dialog and never sets a path itself", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    installWebTabSessionPolicy(
      {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
          listeners.set(name, listener);
        }),
      } as never,
      () => "/Users/test/Downloads",
      () => 0,
    );
    const willDownload = listeners.get("will-download");
    expect(willDownload).toBeDefined();
    const makeItem = (url: string) => ({
      getURL: () => url,
      getFilename: () => "../setup.dmg",
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    });

    const event = { preventDefault: vi.fn() };
    const item = makeItem("https://example.com/setup.dmg");
    willDownload?.(event, item, { id: 7 });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/Users/test/Downloads/setup.dmg" }),
    );

    const fileEvent = { preventDefault: vi.fn() };
    willDownload?.(fileEvent, makeItem("file:///etc/passwd"), { id: 7 });
    expect(fileEvent.preventDefault).toHaveBeenCalled();

    // Three per tab per 10 s, then cancelled (a page cannot stack dialogs).
    willDownload?.({ preventDefault: vi.fn() }, makeItem("https://example.com/2"), { id: 7 });
    willDownload?.({ preventDefault: vi.fn() }, makeItem("https://example.com/3"), { id: 7 });
    const flood = { preventDefault: vi.fn() };
    willDownload?.(flood, makeItem("https://example.com/4"), { id: 7 });
    expect(flood.preventDefault).toHaveBeenCalled();
  });
});

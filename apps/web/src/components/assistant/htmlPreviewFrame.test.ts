import { describe, expect, it, vi } from "vite-plus/test";

import { resolveHtmlPreviewFrame, withRemoteContent } from "./htmlPreviewFrame";

describe("resolveHtmlPreviewFrame", () => {
  it("uses the desktop's kora-preview origin when the bridge is there", async () => {
    const register = vi.fn().mockResolvedValue(`kora-preview://doc/${"a".repeat(32)}`);
    await expect(resolveHtmlPreviewFrame("<p>x</p>", register)).resolves.toEqual({
      kind: "url",
      url: `kora-preview://doc/${"a".repeat(32)}`,
    });
    expect(register).toHaveBeenCalledWith("<p>x</p>");
  });

  it("falls back to srcdoc in a plain browser or when registration fails", async () => {
    await expect(resolveHtmlPreviewFrame("<p>x</p>", undefined)).resolves.toEqual({
      kind: "srcdoc",
    });
    await expect(
      resolveHtmlPreviewFrame("<p>x</p>", vi.fn().mockRejectedValue(new Error("too large"))),
    ).resolves.toEqual({ kind: "srcdoc" });
  });

  it("never loads a URL that is not a preview document", async () => {
    for (const url of ["kora://app/", "https://evil.example/", "javascript:alert(1)", 42]) {
      await expect(
        resolveHtmlPreviewFrame("<p>x</p>", vi.fn().mockResolvedValue(url)),
      ).resolves.toEqual({ kind: "srcdoc" });
    }
  });
});

describe("withRemoteContent", () => {
  it("adds the remote opt-in to a preview URL", () => {
    const url = `kora-preview://doc/${"a".repeat(32)}`;
    expect(withRemoteContent(url)).toBe(`${url}?remote=1`);
    expect(withRemoteContent(`${url}?x=1`)).toBe(`${url}?x=1&remote=1`);
  });
});

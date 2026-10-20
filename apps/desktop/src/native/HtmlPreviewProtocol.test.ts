import { describe, expect, it } from "vite-plus/test";

import {
  HTML_PREVIEW_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_REMOTE_CONTENT_SECURITY_POLICY,
  HTML_PREVIEW_MAX_CHARS,
  createHtmlPreviewStore,
  htmlPreviewUrl,
  randomHtmlPreviewId,
  serveHtmlPreview,
} from "./HtmlPreviewProtocol.ts";

const sequentialIds = () => {
  let next = 0;
  return () => (next++).toString(16).padStart(32, "0");
};

describe("HTML preview store", () => {
  it("returns unguessable ids by default", () => {
    const id = randomHtmlPreviewId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(randomHtmlPreviewId()).not.toBe(id);
  });

  it("evicts the least recently used documents past its bound", () => {
    const store = createHtmlPreviewStore(sequentialIds());
    const first = store.put("<p>first</p>");
    for (let index = 0; index < 40; index += 1) store.put(`<p>${index}</p>`);
    expect(store.size()).toBeLessThanOrEqual(32);
    expect(store.get(first)).toBeUndefined();
  });

  it("refuses oversized documents and malformed ids", () => {
    const store = createHtmlPreviewStore(sequentialIds());
    expect(() => store.put("x".repeat(HTML_PREVIEW_MAX_CHARS + 1))).toThrow();
    const bad = createHtmlPreviewStore(() => "../../etc/passwd");
    expect(() => bad.put("<p></p>")).toThrow();
  });
});

describe("serveHtmlPreview", () => {
  const store = createHtmlPreviewStore(sequentialIds());
  const id = store.put("<script>document.title='x'</script><p>hi</p>");

  it("serves the document with its own sandboxing CSP", async () => {
    const response = serveHtmlPreview(new Request(htmlPreviewUrl(id)), store);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<p>hi</p>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(HTML_PREVIEW_CONTENT_SECURITY_POLICY);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    // By default nothing leaves the machine (2026-10-15 audit desktop #5): no fetch, no remote script/image.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it("loads remote content only on the user's opt-in, and never plain http", async () => {
    const response = serveHtmlPreview(new Request(`${htmlPreviewUrl(id)}?remote=1`), store);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(HTML_PREVIEW_REMOTE_CONTENT_SECURITY_POLICY);
    expect(csp).toContain("connect-src https:");
    expect(csp).not.toMatch(/connect-src[^;]*http:/);
    expect(csp).toContain("sandbox allow-scripts");
  });

  it("404s unknown ids, other hosts and malformed paths; 405s writes", () => {
    expect(serveHtmlPreview(new Request(htmlPreviewUrl("f".repeat(32))), store).status).toBe(404);
    expect(serveHtmlPreview(new Request(`kora-preview://other/${id}`), store).status).toBe(404);
    expect(serveHtmlPreview(new Request(`kora-preview://doc/${id}/../x`), store).status).toBe(404);
    expect(
      serveHtmlPreview(new Request(htmlPreviewUrl(id), { method: "POST", body: "x" }), store)
        .status,
    ).toBe(405);
  });
});

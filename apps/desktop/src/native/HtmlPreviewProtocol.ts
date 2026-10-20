// Serves agent-written HTML under its own `kora-preview://doc/<id>` origin. The document gets a dedicated, strict
// policy there, which is what lets the app window's own policy refuse inline scripts. Nothing in here touches
// Electron: the protocol handler in NativeProtocol.ts feeds requests in and sends the Response back out.

export const HTML_PREVIEW_SCHEME = "kora-preview";
/** Longest single document accepted, in characters. */
export const HTML_PREVIEW_MAX_CHARS = 10 * 1024 * 1024;

const MAX_DOCUMENTS = 32;
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{32}$/;

// `sandbox` alone already gives the page an opaque origin. By default nothing leaves the machine (2026-10-15 audit
// desktop #5): agent-written HTML rendered with remote scripts, images and fetch() allowed could send whatever the agent
// read to a server the moment the preview showed, with no click. Inline and data:/blob: content still renders.
export const HTML_PREVIEW_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' data: blob:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

// The user's "load remote content" opt-in (`?remote=1` on the preview URL): https only, so a page still can never
// fetch() the daemon listening on plain-http loopback.
export const HTML_PREVIEW_REMOTE_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  "img-src https: data: blob:",
  "media-src https: data: blob:",
  "font-src https: data:",
  "connect-src https:",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export const htmlPreviewUrl = (id: string): string => `${HTML_PREVIEW_SCHEME}://doc/${id}`;

export interface HtmlPreviewStore {
  readonly put: (html: string) => string;
  readonly get: (id: string) => string | undefined;
  readonly size: () => number;
}

/** A bounded least-recently-used map from unguessable ids to documents. */
export function createHtmlPreviewStore(randomId: () => string): HtmlPreviewStore {
  // A Map iterates in insertion order, so re-inserting on read keeps the oldest entry first.
  const documents = new Map<string, string>();
  let totalChars = 0;

  const evict = () => {
    for (const [id, html] of documents) {
      if (documents.size <= MAX_DOCUMENTS && totalChars <= MAX_TOTAL_CHARS) return;
      documents.delete(id);
      totalChars -= html.length;
    }
  };

  return {
    put: (html) => {
      if (html.length > HTML_PREVIEW_MAX_CHARS) throw new Error("HTML preview too large");
      const id = randomId();
      if (!ID_PATTERN.test(id)) throw new Error("Invalid HTML preview id");
      documents.set(id, html);
      totalChars += html.length;
      evict();
      return id;
    },
    get: (id) => {
      const html = documents.get(id);
      if (html === undefined) return undefined;
      documents.delete(id);
      documents.set(id, html);
      return html;
    },
    size: () => documents.size,
  };
}

export function serveHtmlPreview(request: Request, store: HtmlPreviewStore): Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (url.protocol !== `${HTML_PREVIEW_SCHEME}:` || url.hostname !== "doc") {
    return new Response(null, { status: 404 });
  }
  const isHead = request.method === "HEAD";
  if (request.method !== "GET" && !isHead) return new Response(null, { status: 405 });

  const id = url.pathname.replace(/^\//, "");
  const html = ID_PATTERN.test(id) ? store.get(id) : undefined;
  if (html === undefined) return new Response(null, { status: 404 });

  return new Response(isHead ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        url.searchParams.get("remote") === "1"
          ? HTML_PREVIEW_REMOTE_CONTENT_SECURITY_POLICY
          : HTML_PREVIEW_CONTENT_SECURITY_POLICY,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function randomHtmlPreviewId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let sharedStore: HtmlPreviewStore | undefined;

/** The process-wide store shared by the IPC registration and the protocol handler. */
export function htmlPreviewStore(): HtmlPreviewStore {
  sharedStore ??= createHtmlPreviewStore(randomHtmlPreviewId);
  return sharedStore;
}

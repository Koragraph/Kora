export type HtmlPreviewFrame =
  | { readonly kind: "pending" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "srcdoc" };

/**
 * Where the agent's HTML is rendered from. In the desktop app it is registered
 * with the main process and served from `kora-preview://doc/<id>` — its own
 * origin with its own CSP — so the app's CSP never has to allow inline script
 * (apps/desktop/src/native/HtmlPreviewProtocol.ts). In a plain browser (QA,
 * Vite dev) there is no bridge and `srcdoc` is used as before.
 */
export function resolveHtmlPreviewFrame(
  html: string,
  register: ((html: string) => Promise<string>) | undefined,
): Promise<HtmlPreviewFrame> {
  if (!register) return Promise.resolve({ kind: "srcdoc" });
  return register(html).then(
    (url): HtmlPreviewFrame =>
      typeof url === "string" && url.startsWith("kora-preview://doc/")
        ? { kind: "url", url }
        : { kind: "srcdoc" },
    (): HtmlPreviewFrame => ({ kind: "srcdoc" }),
  );
}

/**
 * The preview origin blocks remote assets by default; `?remote=1` is the
 * desktop protocol's opt-in to load https content for this one document.
 */
export function withRemoteContent(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}remote=1`;
}

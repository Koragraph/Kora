/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
// `/blob-browser/:blobId/live` is the blob browser's live-view WebSocket (Computer tab).
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/blob-browser",
] as const;

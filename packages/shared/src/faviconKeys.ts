export const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";

export function getProjectFaviconResourceKey(
  hostId: string,
  workspaceRoot: string,
  faviconPath?: string | null,
) {
  return JSON.stringify([hostId, workspaceRoot, faviconPath || null]);
}

/** Last path segment of `url` (resolved against a dummy origin), or null when it does not parse. */
function lastSegmentOf(url: string): string | null {
  if (!URL.canParse(url, "https://kora.invalid")) return null;
  const { pathname } = new URL(url, "https://kora.invalid");
  return pathname.split("/").at(-1) ?? "";
}

/** Signed asset URLs change per request; the filename carries the version, so key on it. */
export function getProjectFaviconCacheKey(hostId: string, workspaceRoot: string, url: string) {
  return JSON.stringify([hostId, workspaceRoot, lastSegmentOf(url) ?? url]);
}

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  return url ? lastSegmentOf(url) === PROJECT_FAVICON_FALLBACK_MARKER : false;
}

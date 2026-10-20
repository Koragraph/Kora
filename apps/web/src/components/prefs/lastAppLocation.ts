/**
 * Where Settings' Back returns to: the last address outside /settings. Browser history is not reliable for this
 * (redirects with `replace` and scope updates add or overwrite entries), so the layout records it as you move.
 */
let lastAppHref: string | null = null;

/**
 * Addresses that only redirect into Settings (`/projects/<key>` = "Project settings" from a thread menu or the graph
 * chip). Remembering one made Back land on it, which sent you straight back into Settings: you could never leave.
 */
function redirectsIntoSettings(href: string): boolean {
  return /^\/projects\//.test(href);
}

export function rememberAppLocation(href: string): void {
  if (redirectsIntoSettings(href)) return;
  lastAppHref = href;
}

export function lastAppLocation(): string | null {
  return lastAppHref;
}

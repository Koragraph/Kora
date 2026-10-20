// How many Kora desktop windows the UI server has connected right now. Only the desktop app has the in-app browser, so
// kora_open_preview (session/fleet-tools.ts) reads this to say truthfully whether anything can show the page.
let probe: (() => number) | null = null;

/** Set by server/ui.ts once the UI server is up. */
export function setDesktopClientProbe(fn: (() => number) | null): void { probe = fn; }

/** Connected desktop windows; null when unknown (no UI server yet, or a bundle that doesn't report it). */
export function desktopClientsNow(): number | null {
  try { return probe ? probe() : null; } catch { return null; }
}

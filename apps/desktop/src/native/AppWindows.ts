import * as Electron from "electron";

/**
 * Which BrowserWindows are Kora's own (the main window, the connecting splash,
 * picture-in-picture): exactly the windows in the app's default session.
 *
 * Every other BrowserWindow is a popup a preview page opened (an OAuth window
 * in the guest's partition session). Those must never receive app broadcasts
 * (tab URLs/titles, screencast frames, update state) nor be picked as "the main
 * window". They are context-isolated without a bridge today, so they could not
 * read the messages anyway; this keeps it that way by construction.
 */
function appSession(): unknown {
  try {
    return Electron.session.defaultSession;
  } catch {
    // Before `ready` (no windows exist yet) or in a unit test's electron mock.
    return undefined;
  }
}

export function isAppWindow(
  window: { readonly webContents?: { readonly session?: unknown } | undefined },
  session: unknown = appSession(),
): boolean {
  try {
    return window.webContents?.session === session;
  } catch {
    return false;
  }
}

/** Live (not destroyed) app windows, in Electron's order. */
export function listAppWindows(): Electron.BrowserWindow[] {
  const session = appSession();
  return Electron.BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && isAppWindow(window, session),
  );
}

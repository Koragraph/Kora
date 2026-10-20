// How many UI websocket clients are connected right now. The daemon outlives the app, so "nobody is looking" is the
// moment a macOS notification is worth sending (blobsNotify.ts).
let open = 0;
// Connections from the desktop renderer (Origin kora://app / kora-dev://app): only it has the in-app browser, so an
// agent's "open this page" can only be shown while one is connected (kora_open_preview).
let desktop = 0;
export const wsClientCount = (): number => open;
export const desktopClientCount = (): number => desktop;
export function wsClientOpened(fromDesktop = false): void {
  open += 1;
  if (fromDesktop) desktop += 1;
}
export function wsClientClosed(fromDesktop = false): void {
  open = Math.max(0, open - 1);
  if (fromDesktop) desktop = Math.max(0, desktop - 1);
}

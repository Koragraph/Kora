// "A new blob waves": the editor announces the blob it just created; its roster row plays the avatar's `wave`
// reaction once. A tiny external store so the dialog and the row stay decoupled.
import { useSyncExternalStore } from "react";

let lastCreated: { id: string; key: number } | null = null;
const listeners = new Set<() => void>();

export function announceBlobCreated(blobId: string): void {
  const mine = { id: blobId, key: Date.now() };
  lastCreated = mine;
  for (const l of listeners) l();
  // One wave only: forget it shortly after, so a later remount (switching surfaces) does not replay it.
  setTimeout(() => {
    if (lastCreated === mine) {
      lastCreated = null;
      for (const l of listeners) l();
    }
  }, 6000);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The reaction key for this blob's row: changes (and so replays the wave) only when it was just created. */
export function useBlobCreatedWave(blobId: string): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (lastCreated?.id === blobId ? lastCreated.key : null),
    () => null,
  );
}

// Split chunks are fetched lazily, so a deploy (or desktop server swap)
// between page load and a later fetch can 404 the old hashed assets. One
// reload picks up the fresh index.html. A sessionStorage flag keeps a
// persistent failure from becoming a reload loop, and a successful boot clears
// it so the next stale deploy gets its own single reload.
const CHUNK_RELOAD_GUARD_KEY = "kora:chunk-reload-guard";

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * failure streak and returns whether it did, so the caller knows whether to
 * swallow the event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  openStorage: () => Storage = () => window.sessionStorage,
  doReload: () => void = () => window.location.reload(),
): boolean {
  const claimReload = (): boolean => {
    const store = openStorage();
    if (store.getItem(CHUNK_RELOAD_GUARD_KEY) === "1") return false;
    store.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
    return true;
  };
  let mayReload = false;
  try {
    mayReload = claimReload();
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  if (mayReload) doReload();
  return mayReload;
}

/** Clears the guard after a successful boot so a later stale deploy can reload again. */
export function clearChunkReloadGuard(openStorage: () => Storage = () => window.sessionStorage) {
  try {
    openStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}

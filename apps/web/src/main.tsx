import "./index.css";
import ReactDOM from "react-dom/client";
import React from "react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import {
  syncDocumentNativePlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./util/windowControlsOverlay";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./util/chunkReloadGuard";
import { getRouter } from "./router";
import { isNative } from "./env";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isNative ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isNative) {
  syncDocumentNativePlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let reloadScheduled = false;
let chunkLoadFailed = false;
window.addEventListener("vite:preloadError", (evt) => {
  chunkLoadFailed = true;
  const reloading = reloadOnceForChunkLoadError();
  reloadScheduled ||= reloading;
  if (reloading) evt.preventDefault();
});

const app = <AppRoot router={router} />;

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve the initial route's split chunks before rendering, so the
// splash holds until real UI paints instead of dropping to a blank window while
// chunks download.
export const startup = router
  .load()
  .then(() => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary. Skip the
    // paint when a reload is on its way, and only re-arm the guard after a boot
    // that fetched every chunk it asked for.
    if (reloadScheduled) return;
    if (chunkLoadFailed === false) clearChunkReloadGuard();
    const container = document.getElementById("root") as HTMLElement;
    ReactDOM.createRoot(container).render(<React.StrictMode>{app}</React.StrictMode>);
  })
  .catch((err: unknown) => {
    // Let the bootstrap entry show the error unless a reload is already scheduled.
    if (reloadScheduled) return;
    throw err;
  });

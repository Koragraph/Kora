import { useEffect, useMemo } from "react";
import { FILL_WEB_VIEWPORT } from "@kora/contracts";
import { parseHostThreadKey } from "@kora/client-runtime/host";

import { useActiveWebSessions } from "~/stores/webStateStore";
import { useTheme } from "~/hooks/useTheme";
import { isNative } from "~/env";
import { webRuntimeTabId } from "./webRuntimeTabId";
import { readWebMarkupTheme } from "./markupTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

/** Mounts one hosted webview per live browser tab, across every thread (desktop only). */
export function NativeBrowserHost() {
  const activeSessions = useActiveWebSessions();
  const { resolvedTheme } = useTheme();

  const sesss = useMemo(
    () =>
      Object.entries(activeSessions).flatMap(([threadKey, state]) => {
        const threadHandle = parseHostThreadKey(threadKey);
        if (!threadHandle) return [];
        return Object.values(state.sessions).map((frameSnap) => {
          const overlay = state.desktopByTabId[frameSnap.tabId];
          return {
            threadRef: threadHandle,
            snapshot: frameSnap,
            runtimeTabId: webRuntimeTabId(threadHandle, state.serverEpoch, frameSnap.tabId),
            pictureInPicture: overlay?.pictureInPicture ?? false,
            zoomFactor: overlay?.zoomFactor ?? 1,
          };
        });
      }),
    [activeSessions],
  );

  // Keep the desktop's markup overlays dressed in the app's current theme.
  useEffect(() => {
    const preview = window.shellBridge?.preview;
    if (!preview) return;
    let lastSent: string | null = null;
    const sync = () => {
      const palette = readWebMarkupTheme();
      const serialized = JSON.stringify(palette);
      if (serialized === lastSent) return;
      lastSent = serialized;
      preview.setMarkupTheme(palette).catch(() => {
        lastSent = null; // retry on the next change
      });
    };
    const fr = requestAnimationFrame(sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelAnimationFrame(fr);
      observer.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.shellBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((evt) => useBrowserPointerStore.getState().apply(evt));
  }, []);

  if (!isNative) return null;
  return (
    <div style={{ display: "contents" }} data-native-browser-host>
      {sesss.map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => (
        <HostedBrowserWebview
          zoomFactor={zoomFactor}
          pictureInPicture={pictureInPicture}
          profileId={snapshot.profileId}
          viewport={snapshot.viewport ?? FILL_WEB_VIEWPORT}
          initialUrl={snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url}
          runtimeTabId={runtimeTabId}
          tabId={snapshot.tabId}
          threadRef={threadRef}
          key={runtimeTabId}
        />
      ))}
    </div>
  );
}

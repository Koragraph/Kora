import { useShallow } from "zustand/react/shallow";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HostThreadRef, WebViewportSetting } from "@kora/contracts";

import { cn } from "~/util/utils";
import { isMacPlatform } from "~/util/utils";
import { useClientPrefsHydrated } from "~/hooks/usePrefs";
import { webBridge } from "~/components/web/webBridge";
import { useWebBridge } from "~/components/web/useWebBridge";
import {
  type WebviewCrashRecoveryState,
  planWebviewCrashRecovery,
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
} from "./webviewCrashRecovery";
import { useWebviewConfig } from "./webviewConfigState";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
import { acquireShellTab, type AcquiredShellTab } from "./shellTabLifetime";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import {
  resolveFittedBrowserViewport,
  resolveBrowserViewportLayout,
  browserViewportSettingKey,
} from "./browserViewportLayout";
import { resolveBrowserSurfacePanelRect, usePreviewDockStore } from "./browserSurfaceStore";
import { useActiveBrowserScreencastTabIds } from "./browserScreencast";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";

/** The Electron guest element: React's own `<webview>` typing plus the methods Electron adds. */
type GuestElement = HTMLWebViewElement & {
  getWebContentsId(): number;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
};

// React types `allowpopups` as a boolean, but Electron reads the attribute's string value.
const ALLOW_POPUPS = { allowpopups: "true" } as unknown as Record<string, never>;

const FALLBACK_SIZE = { width: 1280, height: 800 } as const;
const normalizedZoom = (zoomLevel: number) =>
  Number.isFinite(zoomLevel) && zoomLevel > 0 ? zoomLevel : 1;

export function HostedBrowserWebview(props: {
  readonly zoomFactor: number;
  readonly profileId: string | undefined;
  readonly pictureInPicture: boolean;
  readonly viewport: WebViewportSetting;
  readonly initialUrl: string | null;
  readonly runtimeTabId: string;
  readonly tabId: string;
  readonly threadRef: HostThreadRef;
}) {
  const { threadRef, tabId, runtimeTabId, initialUrl, viewport, pictureInPicture, profileId } =
    props;
  const zoomLevel = normalizedZoom(props.zoomFactor);

  const prefsHydrated = useClientPrefsHydrated();
  const cfg = useWebviewConfig(threadRef.hostId, profileId);
  useWebBridge({ threadRef, tabId, runtimeTabId });

  // ---------- main-process tab lease ----------
  const [lease, setLease] = useState<AcquiredShellTab | null>(null);
  useEffect(() => {
    if (!prefsHydrated) return;
    const acquired = acquireShellTab(runtimeTabId);
    setLease(acquired);
    return () => {
      acquired.release();
      setLease(null);
    };
  }, [prefsHydrated, runtimeTabId]);

  // ---------- crash recovery ----------
  const latestUrl = useRef(initialUrl);
  latestUrl.current = initialUrl;
  const initialSrc = useRef(initialUrl ?? "about:blank");
  const [generation, setGeneration] = useState(0);
  const recoverySrc = useRef(initialSrc.current);
  const crashState = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    crashState.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    return () => {
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    };
  }, [runtimeTabId]);

  // ---------- presentation inputs ----------
  const surface = usePreviewDockStore(
    useShallow((dock) => {
      const entry = dock.byTabId[runtimeTabId];
      return {
        content: entry?.content ?? null,
        cornerRadius: entry?.cornerRadius ?? 0,
        fitSourceContent: entry?.fitSourceContent ?? false,
        fittedSourceContent: entry?.fittedSourceContent ?? null,
        rect: resolveBrowserSurfacePanelRect(dock.byTabId, runtimeTabId),
        visible: entry?.visible ?? false,
        zIndex: entry?.zIndex ?? 30,
        backgroundActivity: (dock.activityByTabId[runtimeTabId] ?? 0) > 0,
      };
    }),
  );
  const presentContent = usePreviewDockStore((dock) => dock.presentContent);
  const screencastActive = useActiveBrowserScreencastTabIds().has(runtimeTabId);

  const { rect, content, fitSourceContent } = surface;
  const engaged = surface.visible && rect !== null;
  const renderingActive =
    engaged || surface.backgroundActivity || pictureInPicture || screencastActive;

  const hiddenSize =
    viewport._tag !== "fill"
      ? { width: viewport.width * zoomLevel, height: viewport.height * zoomLevel }
      : content
        ? { width: content.width / content.scale, height: content.height / content.scale }
        : rect
          ? { width: rect.width, height: rect.height }
          : FALLBACK_SIZE;
  const containerSize = engaged && rect ? rect : hiddenSize;

  const [lockedAspectRatio, setLockedAspectRatio] = useState<number | null>(null);
  const fitMode = fitSourceContent && rect !== null;
  const deviceToolbarVisible = engaged && viewport._tag !== "fill" && !fitSourceContent;

  const resize = useBrowserViewportResize({
    tabId: runtimeTabId,
    viewport,
    zoomFactor: zoomLevel,
    containerSize: {
      width: Math.max(1, Math.round(containerSize.width)),
      height: Math.max(1, Math.round(containerSize.height)),
    } as never,
    deviceToolbarVisible,
    aspectRatio: viewport._tag === "fill" ? null : lockedAspectRatio,
  });

  const fittedViewport = fitMode
    ? resolveFittedBrowserViewport(viewport, surface.fittedSourceContent, zoomLevel)
    : null;
  const effectiveViewport = fittedViewport ?? resize.effectiveViewport;
  const arrangement =
    fitMode && fittedViewport && rect
      ? resolveBrowserViewportLayout(rect, fittedViewport, zoomLevel)
      : resize.layout;

  // ---------- content presentation + scroll ----------
  const wrapper = useRef<HTMLDivElement | null>(null);
  const reportContent = () => {
    const el = wrapper.current;
    presentContent(runtimeTabId, {
      x: arrangement.viewportX,
      y: arrangement.viewportY,
      width: arrangement.viewportWidth,
      height: arrangement.viewportHeight,
      scale: arrangement.viewportScale,
      scrollLeft: el?.scrollLeft ?? 0,
      scrollTop: el?.scrollTop ?? 0,
    });
  };
  const reportRef = useRef(reportContent);
  reportRef.current = reportContent;
  useEffect(() => {
    const fr = requestAnimationFrame(() => reportRef.current());
    return () => cancelAnimationFrame(fr);
  }, [
    arrangement.viewportX,
    arrangement.viewportY,
    arrangement.viewportWidth,
    arrangement.viewportHeight,
    arrangement.viewportScale,
    runtimeTabId,
  ]);

  const viewportKey = browserViewportSettingKey(effectiveViewport);
  useLayoutEffect(() => {
    wrapper.current?.scrollTo(0, 0);
  }, [runtimeTabId, effectiveViewport._tag, viewportKey]);

  // ---------- the guest ----------
  const [guest, setGuest] = useState<GuestElement | null>(null);
  useEffect(() => {
    if (!guest || !lease) return;
    let disposed = false;
    const register = async () => {
      await lease.ready.catch(() => undefined);
      if (disposed) return;
      try {
        const contentsId = guest.getWebContentsId();
        if (Number.isInteger(contentsId) && contentsId > 0)
          await webBridge?.registerWebview(runtimeTabId, contentsId);
      } catch {
        /* a later event retries */
      }
    };
    const onCrash = () => {
      if (recoveryTimer.current !== null) return;
      const plan = planWebviewCrashRecovery(crashState.current, Date.now());
      if (!plan) return;
      crashState.current = plan.state;
      recoveryTimer.current = setTimeout(() => {
        recoveryTimer.current = null;
        recoverySrc.current = latestUrl.current ?? initialSrc.current;
        setGeneration((g) => g + 1);
      }, plan.delayMs);
    };
    guest.addEventListener("did-attach", register);
    guest.addEventListener("dom-ready", register);
    guest.addEventListener("render-process-gone", onCrash);
    void register();
    return () => {
      disposed = true;
      guest.removeEventListener("did-attach", register);
      guest.removeEventListener("dom-ready", register);
      guest.removeEventListener("render-process-gone", onCrash);
    };
  }, [guest, lease, runtimeTabId]);

  if (!prefsHydrated || !cfg) return null;

  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active: engaged,
    renderingActive,
    keepPaintableWhenInactive:
      typeof navigator !== "undefined" && isMacPlatform(navigator.platform),
    cornerRadius: surface.cornerRadius,
    zIndex: surface.zIndex,
    rect,
    hiddenSize,
  });

  const showFrame = engaged && effectiveViewport._tag !== "fill" && !fitMode;
  const cssSize =
    effectiveViewport._tag !== "fill"
      ? { width: effectiveViewport.width, height: effectiveViewport.height }
      : {
          width: Math.max(1, Math.round(arrangement.viewportWidth / zoomLevel)),
          height: Math.max(1, Math.round(arrangement.viewportHeight / zoomLevel)),
        };

  return (
    <div
      ref={wrapper}
      data-web-rendering={renderingActive ? "active" : "suspended"}
      data-web-viewport={effectiveViewport._tag}
      aria-hidden={engaged ? undefined : true}
      className="overflow-hidden overscroll-contain bg-muted/35"
      style={{ position: "fixed", ...wrapperStyle }}
      onScroll={() => reportContent()}
    >
      <div
        className="relative"
        style={{ width: arrangement.canvasWidth, height: arrangement.canvasHeight }}
      >
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            onChange={resize.commitViewportChange}
            onAspectRatioChange={setLockedAspectRatio}
            aspectRatio={lockedAspectRatio}
            width={Math.max(1, Math.round(containerSize.width))}
            setting={effectiveViewport}
          />
        ) : null}
        <webview
          key={generation}
          ref={setGuest as (element: HTMLWebViewElement | null) => void}
          src={generation === 0 ? initialSrc.current : recoverySrc.current}
          partition={cfg.partition}
          webpreferences={cfg.webPreferences}
          {...(cfg.preloadUrl ? { preload: cfg.preloadUrl } : {})}
          {...ALLOW_POPUPS}
          data-web-tab={runtimeTabId}
          data-web-server-tab={tabId}
          data-web-viewport-mode={effectiveViewport._tag}
          data-web-viewport-key={viewportKey}
          data-web-css-width={cssSize.width}
          data-web-css-height={cssSize.height}
          className={cn(
            "absolute flex overflow-hidden bg-white",
            engaged && !arrangement.fillsPanel && "shadow-sm ring-1 ring-border/70",
          )}
          style={{
            left: arrangement.viewportX,
            top: arrangement.viewportY,
            width: arrangement.viewportWidth / arrangement.viewportScale,
            height: arrangement.viewportHeight / arrangement.viewportScale,
            ...(arrangement.viewportScale < 1
              ? { transform: `scale(${arrangement.viewportScale})`, transformOrigin: "top left" }
              : {}),
          }}
        />
        {showFrame ? (
          <BrowserViewportResizeHandles
            layout={arrangement}
            activeDirection={resize.activeDrag?.direction ?? null}
            onPointerDown={resize.handleResizePointerDown}
            onKeyDown={resize.handleResizeKeyDown}
          />
        ) : null}
        {showFrame && resize.activeDrag ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-[11px] font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
            style={{
              left: arrangement.viewportX + arrangement.viewportWidth / 2,
              top: arrangement.viewportY + 10,
            }}
          >
            {`${resize.activeDrag.width} × ${resize.activeDrag.height}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

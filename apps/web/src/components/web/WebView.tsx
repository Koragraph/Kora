import { webRuntimeTabId } from "~/webview/webRuntimeTabId";
import {
  subscribeBrowserViewportChange,
  commitBrowserViewportChange,
} from "~/webview/browserViewportActions";
import { resolveDiscoveredDaemonUrl } from "~/webview/browserTargetResolver";
import { usePreviewDockStore } from "~/webview/browserSurfaceStore";
import {
  findActiveBrowserScreencastRuntimeTabId,
  isBrowserScreencastStartCancelledError,
  useActiveBrowserScreencastTabIds,
  startBrowserScreencast,
  stopBrowserScreencast,
} from "~/webview/browserScreencast";
import { browserResponsiveViewportForToggle, usePreviewDefaults } from "~/webview/browserDefaults";
import { BrowserSurfaceSlot } from "~/webview/BrowserSurfaceSlot";
import { cn } from "~/util/utils";
import { updateWebDaemonSnapshot, useThreadWebState, rememberWebUrl } from "~/stores/webStateStore";
import {
  useThreadRecentHistory,
  rememberThreadVisit,
  setTitleForThreadUrl,
  removeUrlForThread,
} from "~/stores/webHistoryStore";
import { usePromptDraftStore } from "~/stores/promptDraftStore";
import { localApiOrThrow } from "~/localApi";
import { writeTextToClipboard } from "~/hooks/useCopyText";
import { useAtomAction } from "~/atoms/use-atom-command";
import { webHost } from "~/atoms/preview";
import { useHostHttpBaseUrl } from "~/atoms/hosts";
import { shouldShowWebEmptyState } from "./webEmptyStateLogic";
import { webBridge } from "./webBridge";
import { useWebSession } from "./useWebSession";
import { openWebSession } from "./openWebSession";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { ZoomIndicator } from "./ZoomIndicator";
import { WebUnreachable } from "./WebUnreachable";
import { WebMoreMenu } from "./WebMoreMenu";
import { WebEmptyState } from "./WebEmptyState";
import { WebChromeRow } from "./WebChromeRow";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { threadToast, toastManager } from "../ui/toast";
import { Badge } from "../ui/badge";
import { normalizeWebUrl } from "@kora/shared/webUrl";
import {
  type ShellWebScreencastArtifact,
  type ShellWebScreenshotArtifact,
  DEFAULT_WEB_PROFILE_ID,
  type WebViewportSetting,
  FILL_WEB_VIEWPORT,
  type WebMarkupPayload,
  type HostThreadRef,
} from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { hostThreadKey } from "@kora/client-runtime/host";
import { useCallback, useEffect, useState, useMemo, useRef } from "react";

function hostnameOf(baseUrl: string | null): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

const COPIED_FLASH_MS = 2_000;
const RECENT_HISTORY_LIMIT = 8;

const errorText = (cause: unknown, fallback = "An error occurred.") =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Copy a path next to a toast, flashing "Copied!" on its button for a moment. */
async function copyPathWithFeedback(args: {
  toastId: string;
  path: string;
  failureTitle: string;
  target: string;
  restore: () => void;
  flash: () => void;
}): Promise<void> {
  try {
    await writeTextToClipboard(args.path, args.target);
    args.flash();
    setTimeout(args.restore, COPIED_FLASH_MS);
  } catch (cause) {
    toastManager.update(args.toastId, {
      type: "error",
      title: args.failureTitle,
      description:
        (cause as { _tag?: string } | null)?._tag === "ClipboardApiUnavailableError"
          ? "Clipboard API unavailable."
          : errorText(cause),
    });
  }
}

export function WebView({
  threadRef,
  tabId: requestedTabId,
  visible,
  onSendAnnotation,
}: {
  threadRef: HostThreadRef;
  tabId?: string | null;
  visible: boolean;
  onSendAnnotation?: (annotation: WebMarkupPayload) => void;
}) {
  useWebSession(threadRef);

  const web = useThreadWebState(threadRef);
  const defaults = usePreviewDefaults();
  const hostName = hostnameOf(useHostHttpBaseUrl(threadRef.hostId));
  const history = useThreadRecentHistory(threadRef, RECENT_HISTORY_LIMIT);
  const addPreviewAnnotation = usePromptDraftStore((store) => store.addPreviewAnnotation);

  const openPreview = useAtomAction(webHost.open, { reportFailure: false });
  const resizePreview = useAtomAction(webHost.resize, { reportFailure: false });

  const tabId = requestedTabId ?? web.activeTabId;
  const runtimeTabId = tabId ? webRuntimeTabId(threadRef, web.serverEpoch, tabId) : null;
  const snapshot = tabId ? (web.sessions[tabId] ?? null) : null;
  const shell = tabId ? (web.desktopByTabId[tabId] ?? null) : null;

  const nav = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = nav._tag === "Idle" ? "" : nav.url;
  const unreachable = nav._tag === "LoadFailed";
  const emptyState = shouldShowWebEmptyState(snapshot);
  const loading = shell?.loading ?? nav._tag === "Loading";
  const canGoBack = shell?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = shell?.canGoForward ?? snapshot?.canGoForward ?? false;
  const zoomFactor = shell?.zoomFactor;
  const colorScheme = shell?.colorScheme;
  const controller = shell?.controller ?? "none";
  const pictureInPicture = shell?.pictureInPicture ?? false;

  // A tab from before profiles lives in the built-in default partition, not the configured default.
  const activeProfileId = snapshot?.profileId ?? DEFAULT_WEB_PROFILE_ID;
  const profileName =
    defaults.profiles.find((profile) => profile.id === activeProfileId)?.name ?? "Removed profile";
  const viewport: WebViewportSetting = snapshot?.viewport ?? FILL_WEB_VIEWPORT;
  const deviceToolbarVisible = viewport._tag !== "fill";

  const panelRect = usePreviewDockStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );
  const activeRecordingTabIds = useActiveBrowserScreencastTabIds();
  const activeRecordingRuntimeId = runtimeTabId
    ? activeRecordingTabIds.has(runtimeTabId)
      ? runtimeTabId
      : tabId
        ? findActiveBrowserScreencastRuntimeTabId(threadRef, tabId)
        : null
    : null;

  // Titles of successful navigations enrich an existing history entry; agents alone never create one.
  const latestHistoryUrl = history[0]?.url;
  useEffect(() => {
    if (nav._tag !== "Success" || !nav.title || latestHistoryUrl === undefined) return;
    setTitleForThreadUrl(threadRef, nav.url, nav.title, hostName);
  }, [nav, latestHistoryUrl, threadRef, hostName]);

  // ---- navigation ----
  const navigateTo = useCallback(
    async (target: string, visitedUrl: string) => {
      try {
        if (webBridge && runtimeTabId) {
          await webBridge.navigate(runtimeTabId, target);
          rememberWebUrl(threadRef, target);
        } else {
          const result = await openWebSession({ openPreview, threadRef, url: target });
          if (result._tag === "Failure") {
            if (isAtomActionInterrupted(result)) return;
            const failure = squashAtomActionFailure(result);
            if ((failure as { _tag?: string } | null)?._tag === "BrowserPrefsReadError") {
              toastManager.add({
                description: errorText(failure),
                type: "error",
                title: "Unable to open browser",
              });
            }
            return;
          }
        }
        rememberThreadVisit(threadRef, visitedUrl);
      } catch {
        // A failed load arrives as a `failed` event and renders the unreachable view.
      }
    },
    [openPreview, runtimeTabId, threadRef],
  );

  const submitUrl = useCallback(
    (raw: string) => {
      let normalized: string;
      try {
        normalized = normalizeWebUrl(raw);
      } catch {
        return;
      }
      void navigateTo(normalized, normalized);
    },
    [navigateTo],
  );

  const openDiscovered = useCallback(
    (discovered: string) => {
      void navigateTo(resolveDiscoveredDaemonUrl(threadRef.hostId, discovered), discovered);
    },
    [navigateTo, threadRef.hostId],
  );

  const goBack = () => runtimeTabId && void webBridge?.goBack(runtimeTabId);
  const goForward = () => runtimeTabId && void webBridge?.goForward(runtimeTabId);
  const refresh = () => runtimeTabId && void webBridge?.refresh(runtimeTabId);
  const openInSystemBrowser = () => {
    try {
      void localApiOrThrow().shell.openExternal(url);
    } catch {
      // Nothing useful to do if the shell refuses.
    }
  };

  // ---- viewport ----
  const commitViewport = useCallback(
    async (setting: WebViewportSetting) => {
      if (!tabId) return;
      const result = await resizePreview({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, tabId, viewport: setting },
      });
      if (result._tag === "Success") {
        updateWebDaemonSnapshot(threadRef, result.value);
        return;
      }
      if (isAtomActionInterrupted(result)) return;
      const failure = squashAtomActionFailure(result);
      toastManager.add({
        type: "error",
        description: errorText(failure),
        title: "Unable to resize browser viewport",
      });
      throw failure;
    },
    [resizePreview, tabId, threadRef],
  );

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, commitViewport);
  }, [runtimeTabId, commitViewport]);

  const toggleDeviceToolbar = useCallback(() => {
    if (!runtimeTabId) return;
    const next = deviceToolbarVisible
      ? FILL_WEB_VIEWPORT
      : browserResponsiveViewportForToggle({ defaults, panelRect, zoomFactor });
    void commitBrowserViewportChange(runtimeTabId, next).catch(() => undefined);
  }, [defaults, deviceToolbarVisible, panelRect, runtimeTabId, zoomFactor]);

  // ---- popout ----
  const togglePopout = useCallback(async () => {
    if (!webBridge || !runtimeTabId) return;
    try {
      await (pictureInPicture
        ? webBridge.pictureInPicture.close(runtimeTabId)
        : webBridge.pictureInPicture.open(runtimeTabId));
    } catch (cause) {
      toastManager.add({
        title: "Unable to update popped-out preview",
        type: "error",
        description: errorText(cause),
      });
    }
  }, [pictureInPicture, runtimeTabId]);

  // ---- capture ----
  const revealLabel = revealInFileExplorerLabel(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );

  const showRecordingSaved = (artifact: ShellWebScreencastArtifact) => {
    const bridge = webBridge;
    if (!bridge) return;
    const id = toastManager.add(
      threadToast({
        data: {
          secondaryActionProps: { children: "Copy path", onClick: () => void copyPath() },
          secondaryActionVariant: "outline",
        },
        actionProps: {
          children: revealLabel,
          onClick: () => void bridge.revealArtifact(artifact.path),
        },
        title: "Recording saved",
        type: "success",
        timeout: 8_000,
      }),
    );
    const setCopyButton = (copied: boolean) =>
      toastManager.update(id, {
        data: {
          actionLayout: "stacked-end",
          secondaryActionVariant: "outline",
          secondaryActionProps: {
            children: copied ? "Copied!" : "Copy path",
            disabled: copied,
            onClick: () => void copyPath(),
          },
        },
      });
    const copyPath = () =>
      copyPathWithFeedback({
        toastId: id,
        path: artifact.path,
        target: "recording path",
        failureTitle: "Unable to copy recording path",
        flash: () => setCopyButton(true),
        restore: () => setCopyButton(false),
      });
  };

  const showScreenshotSaved = (artifact: ShellWebScreenshotArtifact) => {
    const bridge = webBridge;
    if (!bridge) return;
    let id = "";
    const buttons = (state: { image: boolean; path: boolean }) => ({
      actionProps: {
        children: state.image ? "Copied!" : "Copy image",
        disabled: state.image,
        onClick: () => void copyImage(),
      },
      data: {
        actionLayout: "stacked-end" as const,
        additionalActions: [
          {
            id: "copy-path",
            props: {
              children: state.path ? "Copied!" : "Copy path",
              disabled: state.path,
              onClick: () => void copyPath(),
            },
          },
        ],
        secondaryActionVariant: "outline" as const,
        secondaryActionProps: {
          children: revealLabel,
          onClick: () => void bridge.revealArtifact(artifact.path),
        },
      },
    });
    const render = (state: { image: boolean; path: boolean }) =>
      toastManager.update(id, buttons(state));
    const copyPath = () =>
      copyPathWithFeedback({
        toastId: id,
        path: artifact.path,
        target: "screenshot path",
        failureTitle: "Unable to copy screenshot path",
        flash: () => render({ image: false, path: true }),
        restore: () => render({ image: false, path: false }),
      });
    const copyImage = async () => {
      try {
        await bridge.copyArtifactToClipboard(artifact.path);
        render({ image: true, path: false });
        setTimeout(() => render({ image: false, path: false }), COPIED_FLASH_MS);
      } catch (cause) {
        toastManager.update(id, {
          type: "error",
          title: "Unable to copy screenshot",
          description: errorText(cause),
        });
      }
    };
    const initial = buttons({ image: false, path: false });
    id = toastManager.add(
      threadToast({
        actionProps: initial.actionProps,
        title: "Screenshot saved",
        data: initial.data,
        type: "success",
        timeout: 8_000,
      }),
    );
  };

  const capture = useCallback(
    async (record: boolean) => {
      const bridge = webBridge;
      if (!bridge || !runtimeTabId || !tabId) return;

      const recordingRuntimeId = activeRecordingRuntimeId;
      if (recordingRuntimeId) {
        try {
          const artifact = await stopBrowserScreencast(recordingRuntimeId);
          if (artifact) showRecordingSaved(artifact);
        } catch (cause) {
          toastManager.add({
            title: "Unable to stop recording",
            description: errorText(cause),
            type: "error",
          });
        }
        return;
      }
      if (record) {
        try {
          await startBrowserScreencast(runtimeTabId, threadRef, tabId);
        } catch (cause) {
          if (isBrowserScreencastStartCancelledError(cause)) return;
          toastManager.add({
            type: "error",
            description: errorText(cause),
            title: "Unable to start recording",
          });
        }
        return;
      }
      try {
        showScreenshotSaved(await bridge.captureScreenshot(runtimeTabId));
      } catch (cause) {
        toastManager.add({
          title: "Unable to capture screenshot",
          description: errorText(cause),
          type: "error",
        });
      }
    },
    [activeRecordingRuntimeId, runtimeTabId, tabId, threadRef, revealLabel],
  );

  // ---- annotate ----
  const [picking, setPicking] = useState(false);
  const mountedRef = useRef(true);
  const pickingTabRef = useRef<string | null>(null);

  useEffect(() => {
    const flag = mountedRef;
    flag.current = true;
    return () => {
      flag.current = false;
    };
  }, []);

  // Leaving the tab mid-pick cancels it in main.
  useEffect(() => {
    return () => {
      if (pickingTabRef.current && pickingTabRef.current === runtimeTabId) {
        void webBridge?.cancelPickElement(runtimeTabId).catch(() => undefined);
        pickingTabRef.current = null;
        if (mountedRef.current) setPicking(false);
      }
    };
  }, [runtimeTabId]);

  const togglePick = useCallback(async () => {
    const bridge = webBridge;
    if (!bridge || !runtimeTabId) return;
    if (picking) {
      void bridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    const previouslyFocused = typeof document === "undefined" ? null : document.activeElement;
    pickingTabRef.current = runtimeTabId;
    setPicking(true);
    try {
      const result = await bridge.pickElement(runtimeTabId);
      if (result) {
        addPreviewAnnotation(threadRef, result.annotation);
        if (result.submission === "send") onSendAnnotation?.(result.annotation);
      }
    } catch {
      // A cancelled or failed pick leaves things as they were.
    } finally {
      pickingTabRef.current = null;
      if (mountedRef.current) setPicking(false);
      if (
        typeof HTMLElement !== "undefined" &&
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {
          // Focus can be refused; typing context is a nicety.
        }
      }
    }
  }, [addPreviewAnnotation, onSendAnnotation, picking, runtimeTabId, threadRef]);

  // ---- chrome ----
  const hasTab = webBridge !== null && runtimeTabId !== null && tabId !== null;
  const showProfileBadge = snapshot !== null && activeProfileId !== defaults.profileId;
  const threadKey = useMemo(() => hostThreadKey(threadRef), [threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-thread-key={threadKey}>
      <WebChromeRow
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        captureDisabled={shell === null || unreachable}
        {...(hasTab ? { onCapture: (record: boolean) => void capture(record) } : {})}
        leadingActions={
          showProfileBadge ? (
            <Tooltip>
              <TooltipTrigger render={<Badge className="max-w-28 shrink-0" variant="outline" />}>
                <span className="truncate">{profileName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{profileName}</TooltipPopup>
            </Tooltip>
          ) : undefined
        }
        loading={loading}
        onBack={goBack}
        onForward={goForward}
        {...(tabId ? { onOpenInBrowser: openInSystemBrowser } : {})}
        {...(hasTab ? { onPickElement: () => void togglePick() } : {})}
        onRefresh={refresh}
        onSubmit={submitUrl}
        pickActive={picking}
        pickDisabled={!tabId || unreachable}
        pickDisabledReason="Page didn't load — pick unavailable until the page renders"
        recording={activeRecordingRuntimeId !== null}
        refreshDisabled={nav._tag === "Idle"}
        trailingActions={
          webBridge ? (
            <WebMoreMenu
              colorScheme={colorScheme ?? "system"}
              deviceToolbarVisible={deviceToolbarVisible}
              hasWebContents={shell?.hasWebContents ?? false}
              hostId={threadRef.hostId}
              nativePictureInPicture={pictureInPicture}
              onNativePictureInPicture={() => void togglePopout()}
              onToggleDeviceToolbar={toggleDeviceToolbar}
              profileId={activeProfileId}
              profileName={profileName}
              tabId={runtimeTabId}
              zoomFactor={zoomFactor ?? 1}
            />
          ) : undefined
        }
        url={url}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && !emptyState ? (
          <BrowserSurfaceSlot
            className="absolute inset-0"
            key={runtimeTabId}
            tabId={runtimeTabId}
            visible={visible && !unreachable}
          />
        ) : null}
        {emptyState ? (
          <WebEmptyState
            onOpenUrl={openDiscovered}
            onRemoveRecent={(recentUrl) => removeUrlForThread(threadRef, recentUrl)}
            recentEntries={history}
            threadRef={threadRef}
          />
        ) : null}
        {snapshot && shell ? <ZoomIndicator zoomFactor={shell.zoomFactor} /> : null}
        {controller !== "none" ? (
          <div
            className={cn(
              "pointer-events-none absolute top-3 left-3 z-40 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 font-medium text-[11px] shadow-sm backdrop-blur",
            )}
          >
            {controller === "agent" ? "Agent controlling browser" : "Human control"}
          </div>
        ) : null}
        {nav._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <WebUnreachable
              code={nav.code}
              description={nav.description}
              onReload={refresh}
              url={nav.url}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

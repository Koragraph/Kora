import { useBrowserPointerStore } from "~/webview/browserPointerStore";
import {
  applyDesktopNavStatus,
  applyWebShellState,
  type ShellWebOverlay,
} from "~/stores/webStateStore";
import {
  flushPendingFaviconsForThread,
  useFaviconProjectRefForThread,
  recordFaviconForThread,
} from "~/stores/webIconStore";
import { useAtomAction } from "~/atoms/use-atom-command";
import { usePreparedLink } from "~/atoms/session";
import { webHost } from "~/atoms/preview";
import { webBridge } from "./webBridge";
import type { WebReportStatusInput, ShellWebTabState, HostThreadRef } from "@kora/contracts";
import { parseHostThreadKey, hostThreadKey } from "@kora/client-runtime/host";
import { useEffectEvent, useEffect, useMemo, useRef } from "react";
import * as Option from "effect/Option";

type NavStatus = ShellWebTabState["navStatus"];

function originOf(url: string): string | null {
  if (!URL.canParse(url)) {
    return null;
  }
  return new URL(url).origin;
}

/** The shell's tab state as the overlay the UI reads. A retained favicon only lives on its own origin. */
export function projectShellState(state: ShellWebTabState): ShellWebOverlay {
  const navOrigin = state.navStatus.kind === "Idle" ? null : originOf(state.navStatus.url);
  const favicon =
    state.favicon && originOf(state.favicon.pageUrl) === navOrigin ? state.favicon : null;
  return {
    hasWebContents: state.webContentsId !== null,
    loading: state.navStatus.kind === "Loading",
    pictureInPicture: state.pictureInPicture,
    canGoForward: state.canGoForward,
    colorScheme: state.colorScheme,
    zoomFactor: state.zoomFactor,
    controller: state.controller,
    audioMuted: state.audioMuted,
    canGoBack: state.canGoBack,
    audible: state.audible,
    favicon,
  };
}

function shouldClearPointer(previous: NavStatus | null, current: NavStatus): boolean {
  if (previous === null) return false;
  if (current.kind === "Loading" && previous.kind !== "Loading") {
    return true;
  }
  if (current.kind === "Idle" || previous.kind === "Idle") {
    return false;
  }
  return current.url !== previous.url;
}

type Last = { url: string | null; kind: NavStatus["kind"] | null };

function buildReport(args: {
  state: ShellWebTabState;
  threadId: HostThreadRef["threadId"];
  tabId: string;
  last: Last;
}): { input: WebReportStatusInput; last: Last } | null {
  const { state, last } = args;
  const nav = state.navStatus;
  if (nav.kind === "Idle") return null;
  if (nav.kind !== "LoadFailed" && nav.kind === last.kind && nav.url === last.url) return null;

  const base = {
    threadId: args.threadId,
    tabId: args.tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  };
  const navStatus =
    nav.kind === "LoadFailed"
      ? {
          _tag: nav.kind,
          url: nav.url,
          title: nav.title,
          code: nav.code,
          description: nav.description,
        }
      : { _tag: nav.kind, url: nav.url, title: nav.title };
  return {
    input: { ...base, navStatus } as WebReportStatusInput,
    last: { url: nav.url, kind: nav.kind },
  };
}

export function useWebBridge(input: {
  threadRef: HostThreadRef;
  runtimeTabId: string;
  tabId: string;
}): void {
  const { tabId, runtimeTabId } = input;

  // Same key, same ref: a fresh-but-equal object must not resubscribe.
  const threadKey = hostThreadKey(input.threadRef);
  const threadRef = useMemo(() => {
    const parsed = parseHostThreadKey(threadKey);
    if (!parsed) {
      throw new Error(`Invalid scoped thread key: ${threadKey}`);
    }
    return parsed;
  }, [threadKey]);

  const report = useAtomAction(webHost.reportStatus, { label: "preview status report" });
  const projectRef = useFaviconProjectRefForThread(threadRef);
  const link = usePreparedLink(threadRef.hostId);
  const hostName = Option.isSome(link) ? safeHostname(link.value.httpBaseUrl) : undefined;

  const lastReport = useRef<Last>({ url: null, kind: null });
  const lastNav = useRef<NavStatus | null>(null);

  const onState = useEffectEvent((changedTabId: string, state: ShellWebTabState) => {
    if (changedTabId !== runtimeTabId) return;

    if (shouldClearPointer(lastNav.current, state.navStatus)) {
      useBrowserPointerStore.getState().clear(runtimeTabId);
    }
    lastNav.current = state.navStatus;

    applyWebShellState(threadRef, tabId, projectShellState(state));
    if (state.favicon) recordFaviconForThread(threadRef, state.favicon, projectRef, hostName);

    const built = buildReport({
      state,
      threadId: threadRef.threadId,
      tabId,
      last: lastReport.current,
    });
    if (!built) return;
    lastReport.current = built.last;
    applyDesktopNavStatus(threadRef, built.input);
    void report({ hostId: threadRef.hostId, input: built.input });
  });

  useEffect(() => {
    if (!webBridge || typeof window === "undefined") return;
    lastReport.current = { url: null, kind: null };
    lastNav.current = null;
    return webBridge.onStateChange(onState);
  }, [runtimeTabId, threadRef, tabId]);

  useEffect(() => {
    if (projectRef) flushPendingFaviconsForThread(threadRef, projectRef, hostName);
  }, [projectRef, hostName, threadRef]);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

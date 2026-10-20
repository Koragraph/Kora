import { Atom } from "effect/unstable/reactivity";
import type {
  WebSessionSnapshot,
  WebListResult,
  WebEvent,
  ShellWebFavicon,
  ShellWebColorScheme,
  HostThreadRef,
} from "@kora/contracts";
import { hostThreadKey } from "@kora/client-runtime/host";
import { useAtomValue } from "@effect/atom-react";

import { koraAtomRegistry } from "../wire/atomRegistry";
import { WEB_RECENT_URL_LIMIT } from "../components/web/webConstants";

export interface ShellWebOverlay {
  favicon: ShellWebFavicon | null;
  controller: "human" | "agent" | "none";
  audible: boolean;
  audioMuted: boolean;
  colorScheme: ShellWebColorScheme;
  pictureInPicture: boolean;
  zoomFactor: number;
  loading: boolean;
  canGoForward: boolean;
  canGoBack: boolean;
  hasWebContents: boolean;
}

export interface ThreadWebState {
  snapshot: WebSessionSnapshot | null;
  sessions: Record<string, WebSessionSnapshot>;
  /** Tabs this client closed: a stale list from the server must not bring them back. */
  suppressedTabIds: ReadonlySet<string>;
  activeTabId: string | null;
  desktopOverlay: ShellWebOverlay | null;
  desktopByTabId: Record<string, ShellWebOverlay>;
  recentlySeenUrls: string[];
  serverEpoch: string | null;
  serverRevision: number;
}

const EMPTY_THREAD_WEB_STATE: ThreadWebState = Object.freeze({
  snapshot: null,
  sessions: Object.freeze({}) as Record<string, WebSessionSnapshot>,
  suppressedTabIds: new Set<string>() as ReadonlySet<string>,
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: Object.freeze({}) as Record<string, ShellWebOverlay>,
  recentlySeenUrls: Object.freeze([]) as unknown as string[],
  serverEpoch: null,
  serverRevision: 0,
});

// ---------- atoms ----------

export const webStateAtom = Atom.family((tkey: string) =>
  Atom.make<ThreadWebState>(EMPTY_THREAD_WEB_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`preview:thread:${tkey}`),
  ),
);

/** Which threads currently hold sessions, so thread-local readers never watch other threads. */
const sessionThreadKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);

const activeWebSessionsAtom = Atom.make((get) => {
  const byThread: Record<string, ThreadWebState> = {};
  for (const keyName of get(sessionThreadKeysAtom)) {
    const state = get(webStateAtom(keyName));
    if (Object.keys(state.sessions).length > 0) byThread[keyName] = state;
  }
  return byThread;
});

const touchedThreadKeys = new Set<string>();

function commit(handle: HostThreadRef, change: (state: ThreadWebState) => ThreadWebState): void {
  const keyName = hostThreadKey(handle);
  const atom = webStateAtom(keyName);
  const earlier = koraAtomRegistry.get(atom);
  const after = change(earlier);
  if (after === earlier) return;
  touchedThreadKeys.add(keyName);
  koraAtomRegistry.set(atom, after);

  const hasSessions = Object.keys(after.sessions).length > 0;
  const indexed = koraAtomRegistry.get(sessionThreadKeysAtom);
  if (hasSessions !== indexed.has(keyName)) {
    const upcoming = new Set(indexed);
    if (hasSessions) upcoming.add(keyName);
    else upcoming.delete(keyName);
    koraAtomRegistry.set(sessionThreadKeysAtom, upcoming);
  }
}

// ---------- pure helpers ----------

const pushRecentUrl = (urls: string[], address: string): string[] =>
  [address, ...urls.filter((u) => u !== address)].slice(0, WEB_RECENT_URL_LIMIT);

function rememberSnapshotUrl(urls: string[], frameSnap: WebSessionSnapshot): string[] {
  return frameSnap.navStatus._tag === "Idle" ? urls : pushRecentUrl(urls, frameSnap.navStatus.url);
}

function latestSnapshot(sessions: Record<string, WebSessionSnapshot>): WebSessionSnapshot | null {
  let best: WebSessionSnapshot | null = null;
  for (const session of Object.values(sessions)) {
    if (best === null || session.updatedAt > best.updatedAt) best = session;
  }
  return best;
}

/** Derived fields follow whichever tab is active. */
function withActive(state: ThreadWebState, activeTabId: string | null): ThreadWebState {
  return {
    ...state,
    activeTabId,
    snapshot: activeTabId === null ? null : (state.sessions[activeTabId] ?? null),
    desktopOverlay: activeTabId === null ? null : (state.desktopByTabId[activeTabId] ?? null),
  };
}

function removeSession(state: ThreadWebState, tabKey: string): ThreadWebState {
  if (!(tabKey in state.sessions)) return state;
  const { [tabKey]: _gone, ...sessions } = state.sessions;
  const { [tabKey]: _overlay, ...desktopByTabId } = state.desktopByTabId;
  const leftover = { ...state, sessions, desktopByTabId };
  const engaged =
    state.activeTabId === tabKey ? (latestSnapshot(sessions)?.tabId ?? null) : state.activeTabId;
  return withActive(leftover, engaged);
}

const overlayEqual = (left: ShellWebOverlay, right: ShellWebOverlay): boolean =>
  left.hasWebContents === right.hasWebContents &&
  left.canGoBack === right.canGoBack &&
  left.canGoForward === right.canGoForward &&
  left.loading === right.loading &&
  left.zoomFactor === right.zoomFactor &&
  left.pictureInPicture === right.pictureInPicture &&
  left.colorScheme === right.colorScheme &&
  left.audioMuted === right.audioMuted &&
  left.audible === right.audible &&
  left.controller === right.controller &&
  (left.favicon === right.favicon ||
    (left.favicon !== null &&
      right.favicon !== null &&
      left.favicon.dataUrl === right.favicon.dataUrl &&
      left.favicon.pageUrl === right.favicon.pageUrl &&
      left.favicon.capturedAt === right.favicon.capturedAt));

// ---------- readers ----------

export function useThreadWebState(handle: HostThreadRef | null | undefined): ThreadWebState {
  const state = useAtomValue(webStateAtom(handle ? hostThreadKey(handle) : ""));
  return handle ? state : EMPTY_THREAD_WEB_STATE;
}

export function useActiveWebSessions(): Record<string, ThreadWebState> {
  return useAtomValue(activeWebSessionsAtom);
}

export function readThreadWebState(handle: HostThreadRef): ThreadWebState {
  return koraAtomRegistry.get(webStateAtom(hostThreadKey(handle)));
}

export const isWebSupportedInRuntime = (): boolean =>
  typeof window !== "undefined" && !!window.shellBridge?.preview;

// ---------- daemon -> state ----------

export function applyWebDaemonEvent(handle: HostThreadRef, evt: WebEvent): void {
  commit(handle, (state) => {
    // Revisions only order events within one server process.
    if (state.serverEpoch !== null && evt.serverEpoch !== state.serverEpoch) return state;
    if (evt.revision < state.serverRevision) return state;

    let upcoming = state;
    switch (evt.type) {
      case "opened":
      case "navigated":
      case "resized": {
        if (state.suppressedTabIds.has(evt.snapshot.tabId)) break;
        const { snapshot } = evt;
        upcoming = withActive(
          {
            ...state,
            sessions: { ...state.sessions, [snapshot.tabId]: snapshot },
            recentlySeenUrls: rememberSnapshotUrl(state.recentlySeenUrls, snapshot),
          },
          evt.type === "opened" ? snapshot.tabId : (state.activeTabId ?? snapshot.tabId),
        );
        break;
      }
      case "failed": {
        const sess = state.sessions[evt.tabId];
        if (!sess) break;
        const failed: WebSessionSnapshot = {
          ...sess,
          navStatus: {
            _tag: "LoadFailed",
            url: evt.url,
            title: evt.title,
            code: evt.code,
            description: evt.description,
          },
          updatedAt: evt.createdAt,
        };
        upcoming = withActive(
          { ...state, sessions: { ...state.sessions, [evt.tabId]: failed } },
          state.activeTabId,
        );
        break;
      }
      case "closed": {
        upcoming = removeSession(state, evt.tabId);
        if (state.suppressedTabIds.has(evt.tabId)) {
          const suppressedTabIds = new Set(state.suppressedTabIds);
          suppressedTabIds.delete(evt.tabId);
          upcoming = { ...upcoming, suppressedTabIds };
        }
        break;
      }
    }
    return { ...upcoming, serverEpoch: evt.serverEpoch, serverRevision: evt.revision };
  });
}

export function applyWebDaemonSnapshot(
  handle: HostThreadRef,
  frameSnap: WebSessionSnapshot | null,
): void {
  commit(handle, (state) => {
    if (frameSnap === null) {
      if (state.snapshot === null) return state;
      return {
        ...state,
        desktopByTabId: {},
        desktopOverlay: null,
        activeTabId: null,
        sessions: {},
        snapshot: null,
      };
    }
    if (state.suppressedTabIds.has(frameSnap.tabId)) return state;
    const earlierFound = state.sessions[frameSnap.tabId];
    if (earlierFound && earlierFound.updatedAt > frameSnap.updatedAt) return state;
    return withActive(
      {
        ...state,
        sessions: { ...state.sessions, [frameSnap.tabId]: frameSnap },
        recentlySeenUrls: rememberSnapshotUrl(state.recentlySeenUrls, frameSnap),
      },
      frameSnap.tabId,
    );
  });
}

/** A mutation response: update the tab without stealing focus from the one in view. */
export function updateWebDaemonSnapshot(
  handle: HostThreadRef,
  frameSnap: WebSessionSnapshot,
): void {
  commit(handle, (state) => {
    if (state.suppressedTabIds.has(frameSnap.tabId)) return state;
    const earlierFound = state.sessions[frameSnap.tabId];
    if (earlierFound && earlierFound.updatedAt > frameSnap.updatedAt) return state;
    const nextSessions = { ...state.sessions, [frameSnap.tabId]: frameSnap };
    const keepActive = state.activeTabId !== null && state.activeTabId in nextSessions;
    return withActive(
      {
        ...state,
        sessions: nextSessions,
        recentlySeenUrls: rememberSnapshotUrl(state.recentlySeenUrls, frameSnap),
      },
      keepActive ? state.activeTabId : frameSnap.tabId,
    );
  });
}

/** The desktop's report is the only thing that moves a tab past its opening snapshot. */
export function applyDesktopNavStatus(
  handle: HostThreadRef,
  report: Pick<WebSessionSnapshot, "tabId" | "navStatus" | "canGoBack" | "canGoForward">,
): void {
  commit(handle, (state) => {
    const sess = state.sessions[report.tabId];
    if (!sess || state.suppressedTabIds.has(report.tabId)) return state;
    const updated: WebSessionSnapshot = {
      ...sess,
      navStatus: report.navStatus,
      canGoBack: report.canGoBack,
      canGoForward: report.canGoForward,
      updatedAt: new Date().toISOString(),
    };
    return withActive(
      {
        ...state,
        sessions: { ...state.sessions, [report.tabId]: updated },
        recentlySeenUrls: rememberSnapshotUrl(state.recentlySeenUrls, updated),
      },
      state.activeTabId,
    );
  });
}

export function reconcileWebDaemonSessions(handle: HostThreadRef, listing: WebListResult): void {
  commit(handle, (state) => {
    const sameEpoch = state.serverEpoch === listing.serverEpoch;
    if (sameEpoch && listing.revision < state.serverRevision) return state;

    const sessions: Record<string, WebSessionSnapshot> = {};
    let recentlySeenUrls = state.recentlySeenUrls;
    for (const listed of listing.sessions) {
      if (sameEpoch && state.suppressedTabIds.has(listed.tabId)) continue;
      const recognised = sameEpoch ? state.sessions[listed.tabId] : undefined;
      const chosen = recognised && recognised.updatedAt > listed.updatedAt ? recognised : listed;
      sessions[listed.tabId] = chosen;
      recentlySeenUrls = rememberSnapshotUrl(recentlySeenUrls, chosen);
    }

    const engaged =
      state.activeTabId !== null && state.activeTabId in sessions
        ? state.activeTabId
        : (latestSnapshot(sessions)?.tabId ?? null);

    const desktopByTabId: Record<string, ShellWebOverlay> = {};
    if (sameEpoch) {
      for (const [tabId, overlay] of Object.entries(state.desktopByTabId)) {
        if (tabId in sessions) desktopByTabId[tabId] = overlay;
      }
    }
    // Suppressed tabs the server no longer lists have been closed for real.
    const listedIds = new Set(listing.sessions.map((session) => session.tabId));
    const suppressedTabIds = new Set(
      sameEpoch ? [...state.suppressedTabIds].filter((tabId) => listedIds.has(tabId)) : [],
    );

    return withActive(
      {
        ...state,
        sessions: sessions,
        desktopByTabId,
        suppressedTabIds,
        recentlySeenUrls,
        serverEpoch: listing.serverEpoch,
        serverRevision: listing.revision,
      },
      engaged,
    );
  });
}

// ---------- desktop shell + local intent ----------

export function applyWebShellState(
  handle: HostThreadRef,
  tabKey: string,
  overlay: ShellWebOverlay | null,
): void {
  commit(handle, (state) => {
    const live = state.desktopByTabId[tabKey];
    if (overlay === null ? live === undefined : live !== undefined && overlayEqual(live, overlay)) {
      return state;
    }
    const desktopByTabId = { ...state.desktopByTabId };
    if (overlay === null) delete desktopByTabId[tabKey];
    else desktopByTabId[tabKey] = overlay;
    return {
      ...state,
      desktopByTabId,
      desktopOverlay: tabKey === state.activeTabId ? overlay : state.desktopOverlay,
    };
  });
}

export function beginWebSessionClose(handle: HostThreadRef, tabKey: string): void {
  commit(handle, (state) =>
    removeSession(
      { ...state, suppressedTabIds: new Set(state.suppressedTabIds).add(tabKey) },
      tabKey,
    ),
  );
}

export function cancelWebSessionClose(
  handle: HostThreadRef,
  frameSnap: WebSessionSnapshot | null,
  tabKey: string,
): void {
  commit(handle, (state) => {
    if (!state.suppressedTabIds.has(tabKey)) return state;
    const suppressedTabIds = new Set(state.suppressedTabIds);
    suppressedTabIds.delete(tabKey);
    if (frameSnap === null) return { ...state, suppressedTabIds };
    return withActive(
      {
        ...state,
        suppressedTabIds,
        sessions: { ...state.sessions, [tabKey]: frameSnap },
        recentlySeenUrls: rememberSnapshotUrl(state.recentlySeenUrls, frameSnap),
      },
      tabKey,
    );
  });
}

export function setActiveWebTab(handle: HostThreadRef, tabKey: string): void {
  commit(handle, (state) =>
    tabKey in state.sessions && state.activeTabId !== tabKey ? withActive(state, tabKey) : state,
  );
}

export function rememberWebUrl(handle: HostThreadRef, address: string): void {
  if (address.trim() === "") return;
  commit(handle, (state) => ({
    ...state,
    recentlySeenUrls: pushRecentUrl(state.recentlySeenUrls, address),
  }));
}

export function resetWebStateForTests(): void {
  for (const keyName of touchedThreadKeys)
    koraAtomRegistry.set(webStateAtom(keyName), EMPTY_THREAD_WEB_STATE);
  touchedThreadKeys.clear();
  koraAtomRegistry.set(sessionThreadKeysAtom, new Set());
}

export const __testing = {
  EMPTY_THREAD_WEB_STATE,
  RECENT_URL_LIMIT: WEB_RECENT_URL_LIMIT,
};

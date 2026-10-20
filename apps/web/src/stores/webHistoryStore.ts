import { useShallow } from "zustand/react/shallow";
import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand";
import { normalizeWebUrl } from "@kora/shared/webUrl";
import type { HostThreadRef } from "@kora/contracts";
import { hostThreadKey } from "@kora/client-runtime/host";

import { readPreparedLink } from "~/atoms/session";
import { canonicalHostname, isLocalLoopbackHost } from "../webview/browserTargetResolver";
import { resolveStorage } from "../util/storage";

export type BrowserHistoryEntry = { title?: string; lastVisitedAt: number; url: string };

export const BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT = 50;
export const BROWSER_HISTORY_MAX_PROJECTS = 20;
export const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;

const MAX_URL_LENGTH = 2048;
const MAX_REMEMBERED_THREADS = 100;
const PENDING_ITEMS_PER_THREAD = 10;
const PENDING_THREADS = 20;
const MAX_JS_DATE_MS = 8_640_000_000_000_000;
const LOCAL_HOST_LABEL = "local";

type PendingVisit = { url: string; at: number; hostName: string | null };
type PendingTitle = { url: string; title: string; hostName: string | null | undefined };

export interface BrowserHistoryStoreState {
  registerThreadProject: (handle: HostThreadRef, projId: string) => void;
  removeUrl: (projId: string, address: string) => void;
  setTitleForUrl: (
    projId: string,
    address: string,
    heading: string,
    hostLabel?: string | null,
  ) => void;
  recordVisit: (
    projId: string,
    address: string,
    when: number,
    opts?: { hostName?: string | null; insertOrdered?: boolean },
  ) => void;
  pendingTitlesByThreadKey: Record<string, PendingTitle[]>;
  pendingVisitsByThreadKey: Record<string, PendingVisit[]>;
  projectKeyByThreadKey: Record<string, string>;
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
}

export const isValidHistoryTimestamp = (val: unknown): val is number =>
  typeof val === "number" && Number.isFinite(val) && Math.abs(val) <= MAX_JS_DATE_MS;

export function normalizeHistoryUrl(unparsed: string): string | null {
  try {
    const address = new URL(normalizeWebUrl(unparsed));
    address.username = "";
    address.password = "";
    return address.href.length > MAX_URL_LENGTH ? null : address.href;
  } catch {
    return null;
  }
}

// ---------- keys ----------

const isStableLocalHost = (hostInfo: string) =>
  isLocalLoopbackHost(hostInfo) || hostInfo === "0.0.0.0";

/** Same site under different spellings (localhost, 127.0.0.1, the machine's own name) is one key. */
function visitKey(address: string, hostLabel?: string | null): string {
  try {
    const decoded = new URL(address);
    const hostInfo = canonicalHostname(decoded.hostname);
    const own = hostLabel ? canonicalHostname(hostLabel) : null;
    if (isStableLocalHost(hostInfo) || (own !== null && own !== "" && hostInfo === own)) {
      decoded.hostname = LOCAL_HOST_LABEL;
    }
    return decoded.href;
  } catch {
    return address;
  }
}

function titleKey(address: string, hostLabel?: string | null): string {
  const keyName = visitKey(address, hostLabel);
  try {
    const decoded = new URL(keyName);
    if (decoded.pathname.length > 1 && decoded.pathname.endsWith("/")) {
      decoded.pathname = decoded.pathname.slice(0, -1);
    }
    return decoded.href;
  } catch {
    return keyName;
  }
}

const isStableLocalUrl = (address: string): boolean => {
  try {
    return isStableLocalHost(canonicalHostname(new URL(address).hostname));
  } catch {
    return false;
  }
};

// ---------- pure operations ----------

export function upsertHistoryEntry(
  records: ReadonlyArray<BrowserHistoryEntry>,
  address: string,
  when: number,
  opts?: { insertOrdered?: boolean; hostName?: string | null },
): BrowserHistoryEntry[] {
  const keyName = visitKey(address, opts?.hostName);
  const earlierFound = records.find((ev) => visitKey(ev.url, opts?.hostName) === keyName);
  const rest = records.filter((ev) => ev !== earlierFound);

  const visitedAt =
    opts?.insertOrdered && earlierFound ? Math.max(earlierFound.lastVisitedAt, when) : when;
  // Prefer a stable local spelling over a LAN-name one.
  const keepStoredUrl =
    earlierFound && (isStableLocalUrl(earlierFound.url) || !isStableLocalUrl(address));
  const rec: BrowserHistoryEntry = {
    url: keepStoredUrl ? earlierFound.url : address,
    lastVisitedAt: visitedAt,
    ...(earlierFound?.title !== undefined ? { title: earlierFound.title } : {}),
  };

  if (!opts?.insertOrdered) {
    return [rec, ...rest].slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
  }
  const at0 = rest.findIndex((ev) => ev.lastVisitedAt < rec.lastVisitedAt);
  const ranked = at0 < 0 ? [...rest, rec] : [...rest.slice(0, at0), rec, ...rest.slice(at0)];
  return ranked.slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
}

export function evictExcessProjects(
  byProject: Record<string, BrowserHistoryEntry[]>,
): Record<string, BrowserHistoryEntry[]> {
  const projects = Object.entries(byProject);
  if (projects.length <= BROWSER_HISTORY_MAX_PROJECTS) return byProject;
  projects.sort(([, a], [, b]) => (b[0]?.lastVisitedAt ?? 0) - (a[0]?.lastVisitedAt ?? 0));
  return Object.fromEntries(projects.slice(0, BROWSER_HISTORY_MAX_PROJECTS));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cleanEntry(unparsed: unknown): BrowserHistoryEntry | null {
  if (!isRecord(unparsed) || typeof unparsed.url !== "string") return null;
  const address = normalizeHistoryUrl(unparsed.url);
  if (address === null || !isValidHistoryTimestamp(unparsed.lastVisitedAt)) return null;
  const heading =
    typeof unparsed.title === "string" && unparsed.title !== ""
      ? unparsed.title.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH)
      : undefined;
  return {
    url: address,
    lastVisitedAt: unparsed.lastVisitedAt,
    ...(heading !== undefined ? { title: heading } : {}),
  };
}

export function migratePersistedBrowserHistoryState(storedState: unknown): {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
} {
  const origin = isRecord(storedState) ? storedState.byProjectKey : undefined;
  if (!isRecord(origin)) return { byProjectKey: {} };

  const byProject: Record<string, BrowserHistoryEntry[]> = {};
  for (const [projectKey, rawEntries] of Object.entries(origin)) {
    if (!Array.isArray(rawEntries)) continue;
    const visited = new Set<string>();
    const records = rawEntries
      .map(cleanEntry)
      .filter((ev): ev is BrowserHistoryEntry => ev !== null)
      .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
      .filter((ev) => {
        const keyName = visitKey(ev.url);
        if (visited.has(keyName)) return false;
        visited.add(keyName);
        return true;
      })
      .slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    if (records.length > 0) byProject[projectKey] = records;
  }
  return { byProjectKey: evictExcessProjects(byProject) };
}

export function mergeBrowserHistoryState(
  storedState: unknown,
  liveState: BrowserHistoryStoreState,
): BrowserHistoryStoreState {
  const { byProjectKey } = migratePersistedBrowserHistoryState(storedState);
  const rawThreads = isRecord(storedState) ? storedState.projectKeyByThreadKey : undefined;
  const projectKeyByThreadKey = Object.fromEntries(
    Object.entries(isRecord(rawThreads) ? rawThreads : {})
      .filter(
        (pair): pair is [string, string] => typeof pair[1] === "string" && pair[1] in byProjectKey,
      )
      .slice(-MAX_REMEMBERED_THREADS),
  );
  return {
    ...liveState,
    byProjectKey,
    projectKeyByThreadKey,
    pendingVisitsByThreadKey: {},
    pendingTitlesByThreadKey: {},
  };
}

// ---------- store ----------

const titled = (heading: string) => heading.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);

function applyTitle(
  state: Pick<BrowserHistoryStoreState, "byProjectKey">,
  projId: string,
  urlText: string,
  rawTitle: string,
  hostLabel: string | null | undefined,
): Pick<BrowserHistoryStoreState, "byProjectKey"> | null {
  const address = normalizeHistoryUrl(urlText);
  const heading = titled(rawTitle);
  const records = state.byProjectKey[projId];
  if (address === null || heading === "" || !records || records.length === 0) return null;
  const wanted = titleKey(address, hostLabel);
  const pos = records.findIndex((ev) => titleKey(ev.url, hostLabel) === wanted);
  if (pos < 0 || records[pos]!.title === heading) return null;
  return {
    byProjectKey: {
      ...state.byProjectKey,
      [projId]: records.map((ev, idx) => (idx === pos ? { ...ev, title: heading } : ev)),
    },
  };
}

export const useBrowserHistoryStore = create<BrowserHistoryStoreState>()(
  persist(
    (bag, get) => ({
      registerThreadProject: (handle, projId) => {
        const tkey = hostThreadKey(handle);
        const current = get();
        const hasBuffered =
          tkey in current.pendingVisitsByThreadKey || tkey in current.pendingTitlesByThreadKey;
        if (current.projectKeyByThreadKey[tkey] === projId && !hasBuffered) return;

        const { [tkey]: visits = [], ...otherVisits } = current.pendingVisitsByThreadKey;
        const { [tkey]: titles = [], ...otherTitles } = current.pendingTitlesByThreadKey;
        bag({
          projectKeyByThreadKey: { ...current.projectKeyByThreadKey, [tkey]: projId },
          pendingVisitsByThreadKey: otherVisits,
          pendingTitlesByThreadKey: otherTitles,
        });
        // Replay what arrived before the project was known, keeping chronology.
        for (const visit of visits) {
          get().recordVisit(projId, visit.url, visit.at, {
            insertOrdered: true,
            hostName: visit.hostName,
          });
        }
        for (const tt of titles) get().setTitleForUrl(projId, tt.url, tt.title, tt.hostName);
      },

      removeUrl: (projId, urlText) => {
        const address = normalizeHistoryUrl(urlText);
        const records = get().byProjectKey[projId];
        if (address === null || !records) return;
        const retained = records.filter((ev) => ev.url !== address);
        if (retained.length === records.length) return;
        bag((state) => {
          const { [projId]: _old, ...others } = state.byProjectKey;
          return { byProjectKey: retained.length > 0 ? { ...others, [projId]: retained } : others };
        });
      },

      setTitleForUrl: (projId, address, heading, hostLabel) => {
        const upcoming = applyTitle(get(), projId, address, heading, hostLabel);
        if (upcoming) bag(upcoming);
      },

      recordVisit: (projId, urlText, when, opts) => {
        const address = normalizeHistoryUrl(urlText);
        if (address === null) return;
        bag((state) => ({
          byProjectKey: evictExcessProjects({
            ...state.byProjectKey,
            [projId]: upsertHistoryEntry(state.byProjectKey[projId] ?? [], address, when, opts),
          }),
        }));
      },
      pendingTitlesByThreadKey: {},
      pendingVisitsByThreadKey: {},
      projectKeyByThreadKey: {},
      byProjectKey: {},
    }),
    {
      name: "kora:web-history:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (current) => ({
        byProjectKey: current.byProjectKey,
        projectKeyByThreadKey: current.projectKeyByThreadKey,
      }),
      migrate: (persisted) => migratePersistedBrowserHistoryState(persisted) as never,
      merge: (persisted, live) => mergeBrowserHistoryState(persisted, live),
    },
  ),
);

// ---------- thread-facing helpers ----------

function hostNameFor(handle: HostThreadRef): string | null {
  const link = readPreparedLink(handle.hostId);
  if (!link) return null;
  try {
    return new URL(link.httpBaseUrl).hostname;
  } catch {
    return null;
  }
}

/** Newest few items per thread, and a bounded number of threads; the thread just written survives. */
function buffer<Item>(
  table: Record<string, Item[]>,
  tkey: string,
  item: Item,
): Record<string, Item[]> {
  const { [tkey]: current = [], ...others } = table;
  const upcoming = { ...others, [tkey]: [...current, item].slice(-PENDING_ITEMS_PER_THREAD) };
  const keys = Object.keys(upcoming);
  for (const keyName of keys) {
    if (Object.keys(upcoming).length <= PENDING_THREADS) break;
    if (keyName !== tkey) delete upcoming[keyName];
  }
  return upcoming;
}

export function rememberThreadVisit(
  handle: HostThreadRef,
  address: string,
  when: number = Date.now(),
): void {
  const tkey = hostThreadKey(handle);
  const hostLabel = hostNameFor(handle);
  const storeObj = useBrowserHistoryStore;
  const projId = storeObj.getState().projectKeyByThreadKey[tkey];
  if (projId === undefined) {
    storeObj.setState((state) => ({
      pendingVisitsByThreadKey: buffer(state.pendingVisitsByThreadKey, tkey, {
        url: address,
        at: when,
        hostName: hostLabel,
      }),
    }));
    return;
  }
  storeObj.getState().recordVisit(projId, address, when, { hostName: hostLabel });
}

export function setTitleForThreadUrl(
  handle: HostThreadRef,
  address: string,
  heading: string,
  hostLabel?: string | null,
): void {
  const tkey = hostThreadKey(handle);
  const storeObj = useBrowserHistoryStore;
  const projId = storeObj.getState().projectKeyByThreadKey[tkey];
  if (projId === undefined) {
    storeObj.setState((state) => ({
      pendingTitlesByThreadKey: buffer(state.pendingTitlesByThreadKey, tkey, {
        url: address,
        title: heading,
        hostName: hostLabel,
      }),
    }));
    return;
  }
  storeObj.getState().setTitleForUrl(projId, address, heading, hostLabel);
}

export function removeUrlForThread(handle: HostThreadRef, address: string): void {
  const projId = useBrowserHistoryStore.getState().projectKeyByThreadKey[hostThreadKey(handle)];
  if (projId !== undefined) useBrowserHistoryStore.getState().removeUrl(projId, address);
}

const NO_HISTORY: ReadonlyArray<BrowserHistoryEntry> = Object.freeze([]);

export function useThreadRecentHistory(
  handle: HostThreadRef,
  limit: number,
): ReadonlyArray<BrowserHistoryEntry> {
  const tkey = hostThreadKey(handle);
  return useBrowserHistoryStore(
    useShallow((state) => {
      const projId = state.projectKeyByThreadKey[tkey];
      const records = projId === undefined ? undefined : state.byProjectKey[projId];
      return records && records.length > 0 ? records.slice(0, limit) : NO_HISTORY;
    }),
  );
}

export function resetBrowserHistoryForTests(): void {
  useBrowserHistoryStore.setState({
    pendingTitlesByThreadKey: {},
    pendingVisitsByThreadKey: {},
    projectKeyByThreadKey: {},
    byProjectKey: {},
  });
  useBrowserHistoryStore.persist.clearStorage();
}

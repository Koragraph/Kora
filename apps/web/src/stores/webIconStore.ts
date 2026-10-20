import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand";
import { useMemo } from "react";
import * as Option from "effect/Option";
import type { HostProjectRef, HostThreadRef, ShellWebFavicon } from "@kora/contracts";
import { hostProjectKey, hostThreadKey, hostProjectRef } from "@kora/client-runtime/host";

import { canonicalHostname } from "~/webview/browserTargetResolver";
import { usePreparedLink } from "~/atoms/session";
import { useThreadSummary } from "~/atoms/entities";
import { createMemoryStorage, type StateStorage } from "../util/storage";
import {
  type BrowserFaviconEntry,
  migrateSavedFavicons,
  isValidFaviconCapturedAt,
  isStorableFaviconDataUrl,
  faviconStorageLocation,
  faviconKey,
  evictExcessFavicons,
  canCanonicalizeFaviconWithoutHost,
  BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY,
} from "../webview/pageFavicon";

const PENDING_ORIGINS_PER_THREAD = 10;
const PENDING_THREADS = 20;
const MAX_REMEMBERED_THREADS = 100;

export interface BrowserFaviconStoreState {
  recordFavicon: (
    keyName: string,
    imageUrl: string,
    takenAt: number,
    altKeys?: ReadonlyArray<string>,
  ) => void;
  projectRefByThreadKey: Record<string, HostProjectRef>;
  pendingByThreadKey: Record<string, Record<string, ShellWebFavicon>>;
  byKey: Record<string, BrowserFaviconEntry>;
}

/** localStorage when it works; a memory copy that keeps winning for any key whose write threw. */
export function resolveBrowserFaviconStorage(): StateStorage {
  const memory = createMemoryStorage();
  let local: Storage | undefined;
  try {
    local = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return memory;
  }
  if (!local) return memory;

  const shadowed = new Set<string>();
  const mirror = (label: string, attempt: () => void) => {
    try {
      attempt();
      shadowed.delete(label);
    } catch {
      shadowed.add(label);
    }
  };
  return {
    getItem: (label) => {
      if (shadowed.has(label)) return memory.getItem(label);
      try {
        return local.getItem(label);
      } catch {
        return memory.getItem(label);
      }
    },
    setItem: (label, val) => {
      memory.setItem(label, val);
      mirror(label, () => local.setItem(label, val));
    },
    removeItem: (label) => {
      memory.removeItem(label);
      mirror(label, () => local.removeItem(label));
    },
  };
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values)];

export const useBrowserFaviconStore = create<BrowserFaviconStoreState>()(
  persist(
    (bag) => ({
      recordFavicon: (keyName, imageUrl, takenAt, altKeys = []) => {
        if (!isStorableFaviconDataUrl(imageUrl) || !isValidFaviconCapturedAt(takenAt)) return;
        bag((current) => {
          const earlierFound = current.byKey[keyName];
          const newer = earlierFound === undefined || takenAt > earlierFound.capturedAt;
          const recognised = earlierFound?.aliases ?? [];
          const combined = unique(
            newer ? [...altKeys, ...recognised] : [...recognised, ...altKeys],
          ).slice(0, BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY);
          if (
            earlierFound &&
            !newer &&
            combined.length === recognised.length &&
            combined.every((alias, idx) => alias === recognised[idx])
          ) {
            return current;
          }
          const rec: BrowserFaviconEntry = {
            dataUrl: newer ? imageUrl : earlierFound!.dataUrl,
            capturedAt: Math.max(takenAt, earlierFound?.capturedAt ?? takenAt),
            ...(combined.length > 0 ? { aliases: combined } : {}),
          };
          return { byKey: evictExcessFavicons({ ...current.byKey, [keyName]: rec }) };
        });
      },
      projectRefByThreadKey: {},
      pendingByThreadKey: {},
      byKey: {},
    }),
    {
      name: "kora:web-icons:v1",
      version: 1,
      storage: createJSONStorage(() => resolveBrowserFaviconStorage()),
      partialize: (current) => ({ byKey: current.byKey }),
      migrate: (persisted) => migrateSavedFavicons(persisted) as never,
      merge: (persisted, live) => mergeBrowserFaviconState(persisted, live),
    },
  ),
);

export function mergeBrowserFaviconState(
  storedState: unknown,
  liveState: BrowserFaviconStoreState,
): BrowserFaviconStoreState {
  return { ...liveState, ...migrateSavedFavicons(storedState) };
}

export function registerFaviconProjectForThread(
  threadHandle: HostThreadRef,
  projKey: HostProjectRef,
): void {
  const keyName = hostThreadKey(threadHandle);
  useBrowserFaviconStore.setState((current) => {
    const recognised = current.projectRefByThreadKey[keyName];
    if (
      recognised &&
      recognised.hostId === projKey.hostId &&
      recognised.projectId === projKey.projectId
    ) {
      return current;
    }
    const { [keyName]: _old, ...others } = current.projectRefByThreadKey;
    const records = Object.entries({ ...others, [keyName]: projKey }).slice(
      -MAX_REMEMBERED_THREADS,
    );
    return { projectRefByThreadKey: Object.fromEntries(records) };
  });
}

export function useFaviconProjectRefForThread(threadHandle: HostThreadRef): HostProjectRef | null {
  const sh = useThreadSummary(threadHandle);
  const backup = useBrowserFaviconStore(
    (current) => current.projectRefByThreadKey[hostThreadKey(threadHandle)] ?? null,
  );
  const fromShell = useMemo(
    () => (sh ? hostProjectRef(threadHandle.hostId, sh.projectId) : null),
    [sh, threadHandle.hostId],
  );
  return fromShell ?? backup;
}

const isRecordable = (favImage: ShellWebFavicon) =>
  isStorableFaviconDataUrl(favImage.dataUrl) && isValidFaviconCapturedAt(favImage.capturedAt);

export function recordFaviconForProject(
  projKey: HostProjectRef,
  favImage: ShellWebFavicon,
  hostLabel: string | null,
): boolean {
  if (!isRecordable(favImage)) return false;
  const location = faviconStorageLocation(hostProjectKey(projKey), favImage.pageUrl, hostLabel);
  if (!location) return false;

  const storeObj = useBrowserFaviconStore.getState();
  const earlierFound = storeObj.byKey[location.key];
  if (
    earlierFound &&
    earlierFound.capturedAt >= favImage.capturedAt &&
    location.aliases.every((alias) => earlierFound.aliases?.includes(alias))
  ) {
    return true;
  }
  storeObj.recordFavicon(location.key, favImage.dataUrl, favImage.capturedAt, location.aliases);
  return true;
}

const pendingOriginKey = (pageUrl: string): string | null =>
  faviconKey("pending", pageUrl, null)?.replace(/^pending /, "") ?? null;

/** `undefined` = the connection's host name is not known yet and the icon must wait. */
function resolveHost(pageUrl: string, hostLabel: string | undefined): string | null | undefined {
  if (hostLabel !== undefined) return hostLabel;
  return canCanonicalizeFaviconWithoutHost(pageUrl) ? null : undefined;
}

function bufferFavicon(tkey: string, originKey: string, favImage: ShellWebFavicon): void {
  useBrowserFaviconStore.setState((current) => {
    const live = current.pendingByThreadKey[tkey] ?? {};
    const held = live[originKey];
    if (held && held.capturedAt >= favImage.capturedAt) return current;

    const origins = Object.entries({ ...live, [originKey]: favImage })
      .sort(([, a], [, b]) => b.capturedAt - a.capturedAt)
      .slice(0, PENDING_ORIGINS_PER_THREAD);
    const { [tkey]: _old, ...others } = current.pendingByThreadKey;
    // The thread just written moves to the end, so the oldest thread is the one dropped.
    const threads = Object.entries({ ...others, [tkey]: Object.fromEntries(origins) }).slice(
      -PENDING_THREADS,
    );
    return { pendingByThreadKey: Object.fromEntries(threads) };
  });
}

export function recordFaviconForThread(
  threadHandle: HostThreadRef,
  favImage: ShellWebFavicon,
  projKey: HostProjectRef | null,
  hostLabel: string | undefined,
): boolean {
  if (!isRecordable(favImage)) return false;
  const originKey = pendingOriginKey(favImage.pageUrl);
  if (originKey === null) return false;

  const hostInfo = resolveHost(favImage.pageUrl, hostLabel);
  if (projKey && hostInfo !== undefined && recordFaviconForProject(projKey, favImage, hostInfo)) {
    return true;
  }
  bufferFavicon(hostThreadKey(threadHandle), originKey, favImage);
  return false;
}

export function flushPendingFaviconsForThread(
  threadHandle: HostThreadRef,
  projKey: HostProjectRef,
  hostLabel: string | undefined,
): boolean {
  const tkey = hostThreadKey(threadHandle);
  const queued = useBrowserFaviconStore.getState().pendingByThreadKey[tkey];
  if (!queued) return true;

  const leftover: Record<string, ShellWebFavicon> = {};
  for (const [originKey, favicon] of Object.entries(queued)) {
    const hostInfo = resolveHost(favicon.pageUrl, hostLabel);
    if (hostInfo === undefined || !recordFaviconForProject(projKey, favicon, hostInfo)) {
      leftover[originKey] = favicon;
    }
  }
  const nothingLeft = Object.keys(leftover).length === 0;
  useBrowserFaviconStore.setState((current) => {
    const { [tkey]: _old, ...others } = current.pendingByThreadKey;
    return { pendingByThreadKey: nothingLeft ? others : { ...others, [tkey]: leftover } };
  });
  return nothingLeft;
}

export function lookupFavicon(
  byKey: Record<string, BrowserFaviconEntry>,
  projKey: HostProjectRef | null,
  address: string,
  hostLabel: string | null,
): string | null {
  if (projKey === null) return null;
  try {
    const projId = hostProjectKey(projKey);
    const keyName = faviconKey(projId, address, hostLabel);
    if (keyName === null) return null;
    const direct = byKey[keyName];
    if (direct) return direct.dataUrl;

    const urlHost = canonicalHostname(new URL(address).hostname);
    const aliasKey = faviconKey(projId, address, urlHost);
    const aliased = aliasKey === null ? undefined : byKey[aliasKey];
    return aliased?.aliases?.includes(urlHost) ? aliased.dataUrl : null;
  } catch {
    return null;
  }
}

export function useFaviconForThreadUrl(
  threadHandle: HostThreadRef,
  address: string,
): string | null {
  const projKey = useFaviconProjectRefForThread(threadHandle);
  const link = usePreparedLink(threadHandle.hostId);
  const hostLabel = useMemo(() => {
    const prepared = Option.getOrNull(link);
    try {
      return prepared ? new URL(prepared.httpBaseUrl).hostname : null;
    } catch {
      return null;
    }
  }, [link]);
  return useBrowserFaviconStore((current) =>
    lookupFavicon(current.byKey, projKey, address, hostLabel),
  );
}

export function resetBrowserFaviconsForTests(): void {
  useBrowserFaviconStore.setState({ byKey: {}, pendingByThreadKey: {}, projectRefByThreadKey: {} });
  useBrowserFaviconStore.persist.clearStorage();
}

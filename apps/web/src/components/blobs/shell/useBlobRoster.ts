// The roster the sidebar, the chat header and the concurrency guard share: the live blob snapshot joined with each
// blob's threads (a blob IS a project: `thread.projectId === blob.id`) and their status dots.
import { hostThreadKey, hostThreadRef } from "@kora/client-runtime/host";
import type { HostThreadShell } from "@kora/client-runtime/store/models";
import type { BlobProfile, BlobsSnapshot, HostId } from "@kora/contracts";
import { useCallback, useMemo } from "react";

import { useHosts } from "~/atoms/hosts";
import { useThreadSummaries } from "~/atoms/entities";
import { useViewStateStore } from "~/stores/uiStateStore";
import { resolveThreadDot, type ThreadDot } from "../../ThreadNav.logic";
import { type BlobOutfit } from "~/components/blobs/avatar";
import { toAvatarOutfit } from "../outfit";
import { orderRoster, isChief, type Roster } from "./blobRoster";
import { deriveBlobStatus, type BlobStatus } from "./blobStatus";
import { useBlobsState } from "./blobsApi";

export interface RosterEntry {
  readonly blob: BlobProfile;
  readonly chief: boolean;
  readonly outfit: BlobOutfit;
  readonly status: BlobStatus;
  /** Un-archived threads, newest first, each with its dot. */
  readonly threads: ReadonlyArray<{ readonly thread: HostThreadShell; readonly dot: ThreadDot }>;
  readonly lastActiveAt: number;
}

export interface BlobRoster {
  readonly hostId: HostId | null;
  /** False until the first `blobs.subscribe` frame: render a skeleton, not the empty state. */
  readonly ready: boolean;
  readonly snapshot: BlobsSnapshot | null;
  readonly roster: Roster;
  readonly entries: ReadonlyMap<string, RosterEntry>;
  /** Blobs with a turn running right now. */
  readonly workingBlobIds: ReadonlySet<string>;
  /** Stamp every thread of a blob as seen (the "Mark read" action). */
  readonly markRead: (blobId: string) => void;
}

const EMPTY_ROSTER: Roster = { chief: null, team: [], hidden: [], retired: [] };

export function useBlobRoster(): BlobRoster {
  const { hostId, snapshot } = useBlobsState();
  const threads = useThreadSummaries();
  const lastVisitedAtById = useViewStateStore((state) => state.threadLastVisitedAtById);
  const markThreadVisited = useViewStateStore((state) => state.markThreadVisited);
  const { environments } = useHosts();
  const offlineHostIds = useMemo(
    () =>
      new Set(
        environments
          .filter((e) => e.connection.phase === "offline" || e.connection.phase === "error")
          .map((e) => e.hostId),
      ),
    [environments],
  );

  const entries = useMemo(() => {
    const map = new Map<string, RosterEntry>();
    if (!snapshot) return map;
    const byProject = new Map<string, HostThreadShell[]>();
    for (const t of threads) {
      if (t.archivedAt) continue;
      (byProject.get(t.projectId) ?? byProject.set(t.projectId, []).get(t.projectId)!).push(t);
    }
    for (const blob of snapshot.blobs) {
      const mine = (byProject.get(blob.id) ?? [])
        .filter((t) => hostId === null || t.hostId === hostId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map((thread) => ({
          thread,
          dot: resolveThreadDot(
            thread,
            lastVisitedAtById[hostThreadKey(hostThreadRef(thread.hostId, thread.id))],
            offlineHostIds.has(thread.hostId),
          ),
        }));
      const chief = isChief(blob);
      map.set(blob.id, {
        blob,
        chief,
        outfit: toAvatarOutfit(blob.outfit, blob.id, chief),
        status: deriveBlobStatus(mine.map((m) => m.dot)),
        threads: mine,
        lastActiveAt: mine[0] ? Date.parse(mine[0].thread.updatedAt) || 0 : 0,
      });
    }
    return map;
  }, [snapshot, threads, hostId, lastVisitedAtById, offlineHostIds]);

  const roster = useMemo(() => {
    if (!snapshot) return EMPTY_ROSTER;
    const activity = new Map<string, number>();
    for (const [id, entry] of entries) activity.set(id, entry.lastActiveAt);
    return orderRoster(snapshot.blobs, activity);
  }, [snapshot, entries]);

  const workingBlobIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, entry] of entries)
      if (entry.status.working && !entry.blob.archivedAt) ids.add(id);
    return ids;
  }, [entries]);

  const markRead = useCallback(
    (blobId: string) => {
      const entry = entries.get(blobId);
      if (!entry) return;
      const now = new Date().toISOString();
      for (const { thread } of entry.threads) {
        markThreadVisited(hostThreadKey(hostThreadRef(thread.hostId, thread.id)), now);
      }
    },
    [entries, markThreadVisited],
  );

  return { hostId, ready: snapshot !== null, snapshot, roster, entries, workingBlobIds, markRead };
}

import { useCallback, useMemo } from "react";
import type { HostId } from "@kora/contracts";
import {
  makeArchivedThreadsHostKey,
  createArchivedThreadSnapshotsAtomFamily,
  type ArchivedSnapshotEntry,
} from "@kora/client-runtime/store/threads";
import { useAtomValue } from "@effect/atom-react";

import { koraAtomRegistry } from "../wire/atomRegistry";
import { chatHost } from "../atoms/chat";

function archivedSnapshotAtom(hostId: HostId) {
  return chatHost.archivedShellSnapshot({
    hostId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  labelPrefix: "web:archived-thread-snapshots",
  getSnapshotAtom: archivedSnapshotAtom,
});

export function refreshArchivedThreadsForHost(hostId: HostId): void {
  koraAtomRegistry.refresh(archivedSnapshotAtom(hostId));
}

export function useArchivedThreadSnapshots(hostIds: ReadonlyArray<HostId>): {
  readonly refresh: () => void;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
} {
  const hostKey = useMemo(() => makeArchivedThreadsHostKey(hostIds), [hostIds]);
  const outcomeVal = useAtomValue(archivedSnapshotsAtom(hostKey));
  const refresh = useCallback(() => {
    for (const hostId of hostIds) {
      koraAtomRegistry.refresh(archivedSnapshotAtom(hostId));
    }
  }, [hostIds]);

  return {
    ...outcomeVal,
    refresh,
  };
}

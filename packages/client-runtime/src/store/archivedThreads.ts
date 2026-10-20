import { HostId, type ThreadIndexSnapshot } from "@kora/contracts";
import * as Order from "effect/Order";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface ArchivedSnapshotEntry {
  readonly hostId: HostId;
  readonly snapshot: ThreadIndexSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
}

const ARCHIVED_THREADS_HOST_KEY_SEPARATOR = "\u001f";
const hostIdOrder = Order.String as Order.Order<HostId>;

export function makeArchivedThreadsHostKey(hostIds: ReadonlyArray<HostId>): string {
  return pipe(hostIds, Arr.sort(hostIdOrder), (sortedHostIds) =>
    sortedHostIds.join(ARCHIVED_THREADS_HOST_KEY_SEPARATOR),
  );
}

export function parseArchivedThreadsHostKey(key: string): ReadonlyArray<HostId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_HOST_KEY_SEPARATOR),
    Arr.map((hostId) => HostId.make(hostId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    hostId: HostId,
  ) => Atom.Atom<AsyncResult.AsyncResult<ThreadIndexSnapshot, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((hostKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      let isLoading = false;
      let error: string | null = null;
      const snapshots: ArchivedSnapshotEntry[] = [];

      for (const hostId of parseArchivedThreadsHostKey(hostKey)) {
        const result = get(options.getSnapshotAtom(hostId));
        isLoading = isLoading || result.waiting;

        const loaded = Option.getOrNull(AsyncResult.value(result));
        if (loaded !== null) snapshots.push({ hostId, snapshot: loaded });

        if (result._tag === "Failure") error ??= "Failed to load archived threads.";
      }

      return { isLoading, error, snapshots };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${hostKey}`)),
  );
}

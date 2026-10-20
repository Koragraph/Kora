import { useAtomValue } from "@effect/atom-react";
import {
  createHostThreadDetailAtoms,
  createHostThreadShellAtoms,
  createHostThreadStateAtoms,
  EMPTY_HOST_THREAD_STATE,
  type HostThreadState,
  createThreadHostAtoms,
} from "@kora/client-runtime/store/threads";
import type { HostId, ThreadId } from "@kora/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { hostCatalog } from "../link/catalog";
import { daemonAtomRuntime } from "../link/runtime";
import { hostSnapshotAtom } from "./shell";

export const threadHost = createThreadHostAtoms(daemonAtomRuntime, hostSnapshotAtom);
const hostThreads = createHostThreadStateAtoms(daemonAtomRuntime);
export const hostThreadDetails = createHostThreadDetailAtoms(hostThreads.stateAtom);
export const hostThreadShells = createHostThreadShellAtoms({
  catalogEntryAtom: hostCatalog.catalogEntryAtom,
  snapshotAtom: threadHost.snapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_HOST_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useHostThread(hostId: HostId | null, threadId: ThreadId | null): HostThreadState {
  const result = useAtomValue(
    hostId !== null && threadId !== null
      ? hostThreads.stateAtom(hostId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_HOST_THREAD_STATE,
  ) as HostThreadState;
}

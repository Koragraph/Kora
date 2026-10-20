import type { HostId, ThreadIndexSnapshot } from "@kora/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { HostShellState } from "./shell.ts";

export function createHostSnapshotAtom<E>(
  shellStateAtom: (hostId: HostId) => Atom.Atom<AsyncResult.AsyncResult<HostShellState, E>>,
) {
  return Atom.family((hostId: HostId) =>
    Atom.make((get): ThreadIndexSnapshot | null =>
      Option.match(AsyncResult.value(get(shellStateAtom(hostId))), {
        onNone: () => null,
        onSome: (state) => Option.getOrNull(state.snapshot),
      }),
    ).pipe(Atom.withLabel(`environment-snapshot:${hostId}`)),
  );
}

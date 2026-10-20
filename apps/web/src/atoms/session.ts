import { useAtomValue } from "@effect/atom-react";
import { createHostSessionAtoms } from "@kora/client-runtime/store/session";
import type { HostId } from "@kora/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { daemonAtomRuntime } from "../link/runtime";
import { koraAtomRegistry } from "../wire/atomRegistry";

export const hostSession = createHostSessionAtoms(daemonAtomRuntime);

const EMPTY_PREPARED_LINK_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedLink(hostId: HostId | null) {
  return useAtomValue(
    hostId === null ? EMPTY_PREPARED_LINK_ATOM : hostSession.preparedConnectionValueAtom(hostId),
  );
}

export function readPreparedLink(hostId: HostId) {
  return Option.getOrNull(koraAtomRegistry.get(hostSession.preparedConnectionValueAtom(hostId)));
}

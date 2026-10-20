import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import {
  createShellHostAtoms,
  createHostSnapshotAtom,
  createHostShellAtoms,
} from "@kora/client-runtime/store/shell";
import { enabledHostIds } from "@kora/client-runtime/store/connections";
import { AVAILABLE_LINK_STATE, linkProjectionPhase } from "@kora/client-runtime/link";

import { daemonAtomRuntime } from "../link/runtime";
import { hostCatalog } from "../link/catalog";

export const shellHost = createShellHostAtoms(daemonAtomRuntime);
export const hostShell = createHostShellAtoms(daemonAtomRuntime);
export const hostSnapshotAtom = createHostSnapshotAtom(hostShell.stateAtom);

export const allHostShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(hostCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const hostKey of enabledHostIds(catalog.value)) {
    if (Option.isSome(get(hostShell.stateEntryAtom(hostKey)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(hostCatalog.stateAtom(hostKey))),
      () => AVAILABLE_LINK_STATE,
    );
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    const stillRetryingEarly =
      connection.phase === "backoff" && connection.desired && connection.attempt <= 2;
    const connected = linkProjectionPhase(connection) !== "disconnected";
    if (connected || stillRetryingEarly) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

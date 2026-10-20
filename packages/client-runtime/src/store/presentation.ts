import type { HostId, DaemonConfig } from "@kora/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { AVAILABLE_LINK_STATE, type SupervisorLinkState } from "../link/model.ts";
import { presentLinkState, type HostPresentation } from "../link/presentation.ts";
import type { HostCatalogState } from "./connections.ts";

const mapsEqual = <K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean =>
  left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);

export function createHostPresentationAtoms<E>(input: {
  readonly catalogEntryAtom: Atom.Atom<HostCatalogState>;
  readonly stateAtom: (
    hostId: HostId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorLinkState, E>>;
  /** Authoritative live server config, including streamed provider/settings updates. */
  readonly daemonConfigValueAtom: (hostId: HostId) => Atom.Atom<DaemonConfig | null>;
}) {
  const presentationAtom = Atom.family((hostId: HostId) =>
    Atom.make((get) => {
      const entry = get(input.catalogEntryAtom).entries.get(hostId);
      if (entry === undefined) return null;
      const state = Option.getOrElse(
        AsyncResult.value(get(input.stateAtom(hostId))),
        () => AVAILABLE_LINK_STATE,
      );
      return {
        entry,
        connection: presentLinkState(state),
        daemonConfig: get(input.daemonConfigValueAtom(hostId)),
      } satisfies HostPresentation;
    }).pipe(Atom.withLabel(`environment-presentation:${hostId}`)),
  );

  let previous: ReadonlyMap<HostId, HostPresentation> = new Map();
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<HostId, HostPresentation>();
    for (const hostId of get(input.catalogEntryAtom).entries.keys()) {
      const presentation = get(presentationAtom(hostId));
      if (presentation !== null) {
        next.set(hostId, presentation);
      }
    }
    if (!mapsEqual(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  return { presentationsAtom, presentationAtom };
}

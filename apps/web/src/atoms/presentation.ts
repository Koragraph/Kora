import { useAtomValue } from "@effect/atom-react";
import type { HostPresentation } from "@kora/client-runtime/link";
import { createHostPresentationAtoms } from "@kora/client-runtime/store/presentation";
import type { HostId } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { hostCatalog } from "../link/catalog";
import { daemonHost } from "./server";

export const hostPresentations = createHostPresentationAtoms({
  catalogEntryAtom: hostCatalog.catalogEntryAtom,
  stateAtom: hostCatalog.stateAtom,
  daemonConfigValueAtom: daemonHost.configValueAtom,
});

const EMPTY_HOST_PRESENTATION_ATOM = Atom.make<HostPresentation | null>(null).pipe(
  Atom.withLabel("web-environment-presentation:empty"),
);

export function useHostPresentation(hostId: HostId | null) {
  const catalog = useAtomValue(hostCatalog.catalogEntryAtom);
  const presentation = useAtomValue(
    hostId === null ? EMPTY_HOST_PRESENTATION_ATOM : hostPresentations.presentationAtom(hostId),
  );
  return {
    isReady: catalog.isReady,
    presentation,
  };
}

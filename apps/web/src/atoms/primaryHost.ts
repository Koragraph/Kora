import { Atom } from "effect/unstable/reactivity";

import { hostCatalog } from "../link/catalog";

export const primaryHostIdAtom = Atom.make((get) => {
  for (const [hostId, entry] of get(hostCatalog.catalogEntryAtom).entries) {
    if (entry.target._tag === "LocalLinkTarget") {
      return hostId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

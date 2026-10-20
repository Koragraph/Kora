import { createHostProjectAtoms } from "@kora/client-runtime/store/projects";
import { createProjectHostAtoms } from "@kora/client-runtime/store/projects";

import { hostCatalog } from "../link/catalog";
import { daemonAtomRuntime } from "../link/runtime";
import { hostSnapshotAtom } from "./shell";

export const projectHost = createProjectHostAtoms(daemonAtomRuntime);
export const hostProjects = createHostProjectAtoms({
  catalogEntryAtom: hostCatalog.catalogEntryAtom,
  snapshotAtom: hostSnapshotAtom,
});

import { createHostCatalogAtoms } from "@kora/client-runtime/store/connections";

import { daemonAtomRuntime } from "./runtime";

export const hostCatalog = createHostCatalogAtoms(daemonAtomRuntime);

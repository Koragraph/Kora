import { createBlobsHostAtoms } from "@kora/client-runtime/store/blobs";

import { daemonAtomRuntime } from "../link/runtime";

export const blobsHost = createBlobsHostAtoms(daemonAtomRuntime);

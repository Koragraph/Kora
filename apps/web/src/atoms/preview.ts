import { createWebHostAtoms } from "@kora/client-runtime/store/web";

import { daemonAtomRuntime } from "../link/runtime";

export const webHost = createWebHostAtoms(daemonAtomRuntime);

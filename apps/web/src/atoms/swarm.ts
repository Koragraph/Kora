import { createSwarmHostAtoms } from "@kora/client-runtime/store/swarm";

import { daemonAtomRuntime } from "../link/runtime";

export const swarmHost = createSwarmHostAtoms(daemonAtomRuntime);

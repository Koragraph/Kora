import { createFleetHostAtoms } from "@kora/client-runtime/store/fleet";

import { daemonAtomRuntime } from "../link/runtime";

export const fleetHost = createFleetHostAtoms(daemonAtomRuntime);

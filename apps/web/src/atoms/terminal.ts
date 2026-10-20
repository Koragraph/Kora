import { createTerminalHostAtoms } from "@kora/client-runtime/store/terminal";

import { daemonAtomRuntime } from "../link/runtime";

export const terminalHost = createTerminalHostAtoms(daemonAtomRuntime);

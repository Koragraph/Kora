import { createChatHostAtoms } from "@kora/client-runtime/store/chat";

import { daemonAtomRuntime } from "../link/runtime";

export const chatHost = createChatHostAtoms(daemonAtomRuntime);

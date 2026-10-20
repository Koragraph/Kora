import { CHAT_METHODS } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createHostRpcQueryAtomFamily } from "./runtime.ts";
import type { HostRegistry } from "../link/registry.ts";

export function createChatHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  return {
    archivedShellSnapshot: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat:archived-shell-snapshot",
      tag: CHAT_METHODS.listArchivedThreads,
    }),
  };
}

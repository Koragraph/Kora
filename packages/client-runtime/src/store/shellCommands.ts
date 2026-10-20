import { RPC_METHODS } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createHostRpcCommand } from "./runtime.ts";
import type { HostRegistry } from "../link/registry.ts";

export function createShellHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  return {
    openInEditor: createHostRpcCommand(runtime, {
      label: "environment-data:shell:open-in-editor",
      tag: RPC_METHODS.editorOpen,
    }),
  };
}

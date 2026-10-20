import {
  createHostRpcCommand,
  createHostRpcQueryAtomFamily,
} from "@kora/client-runtime/store/runtime";
import { RPC_METHODS } from "@kora/contracts";

import { daemonAtomRuntime } from "../../link/runtime";

/**
 * Folder trust (daemon `trust.*` RPCs): may Kora's agents run a folder's own setup — its `.claude` hooks, project MCP
 * servers, Codex project config, OpenCode / Koragent plugins and tools? Until trusted they run in restricted mode.
 */
export const trustHost = {
  status: createHostRpcQueryAtomFamily(daemonAtomRuntime, {
    label: "environment-data:trust:status",
    tag: RPC_METHODS.trustGet,
    staleTimeMs: 15_000,
    idleTtlMs: 5 * 60_000,
  }),
  list: createHostRpcQueryAtomFamily(daemonAtomRuntime, {
    label: "environment-data:trust:list",
    tag: RPC_METHODS.trustList,
    staleTimeMs: 5_000,
  }),
  set: createHostRpcCommand(daemonAtomRuntime, {
    label: "environment-data:trust:set",
    tag: RPC_METHODS.trustSet,
  }),
};

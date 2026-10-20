import { RPC_METHODS } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { HostRegistry } from "../link/registry.ts";
import {
  createHostRpcSubscriptionAtomFamily,
  createHostRpcQueryAtomFamily,
  createHostRpcCommand,
  createAtomActionScheduler,
} from "./runtime.ts";

/** Host-RPC atoms for the in-app browser preview: tab list, event stream, lifecycle and status. */
export function createWebHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  // Open, resize and close for one thread run in order.
  const lifecycleScheduler = createAtomActionScheduler();
  const lifecycle = {
    mode: "serial",
    key: (target: { readonly hostId: string; readonly input: { readonly threadId: string } }) =>
      JSON.stringify([target.hostId, target.input.threadId]),
  } as const;
  // Only the newest status report per tab matters.
  const statusScheduler = createAtomActionScheduler();

  return {
    list: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: RPC_METHODS.browserList,
      staleTimeMs: 5_000,
    }),
    events: createHostRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: RPC_METHODS.browserWatch,
    }),
    open: createHostRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: RPC_METHODS.browserOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycle,
    }),
    resize: createHostRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: RPC_METHODS.browserResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycle,
    }),
    close: createHostRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: RPC_METHODS.browserClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycle,
    }),
    reportStatus: createHostRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: RPC_METHODS.browserReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        key: (target) => JSON.stringify([target.hostId, target.input.threadId, target.input.tabId]),
        mode: "latest",
      },
    }),
  };
}

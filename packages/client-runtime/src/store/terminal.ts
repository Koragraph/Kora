import { RPC_METHODS, type PtySummary } from "@kora/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { HostRegistry } from "../link/registry.ts";
import { subscribe } from "../wire/client.ts";
import {
  createHostSubscriptionAtomFamily,
  createHostRpcSubscriptionAtomFamily,
  createHostRpcCommand,
  createAtomActionScheduler,
} from "./runtime.ts";
import {
  nextTerminalAttachSeedState,
  applyTerminalMetadataStreamEvent,
  applyTerminalAttachStreamEvent,
} from "./terminalSession.ts";

/** Host-RPC atoms for terminals: attach, metadata watch, and open/write/resize/close. */
export function createTerminalHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  const lifecycleScheduler = createAtomActionScheduler();
  const lifecycleConcurrency = {
    mode: "serial",
    key: (target: { readonly hostId: string; readonly input: { readonly threadId: string } }) =>
      JSON.stringify([target.hostId, target.input.threadId]),
  } as const;
  // Open and close for one thread run one at a time, in order.
  const lifecycle = { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency };
  // Of many queued resizes, only the newest is worth sending.
  const resizeScheduler = createAtomActionScheduler();

  return {
    attach: createHostRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      tag: RPC_METHODS.ptyAttach,
      // The fold starts from a fresh seed on every (re)subscription.
      transform: (stream) =>
        Stream.suspend(() =>
          stream.pipe(Stream.scan(nextTerminalAttachSeedState(), applyTerminalAttachStreamEvent)),
        ),
    }),
    metadata: createHostSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(RPC_METHODS.ptyWatchMeta, {}).pipe(
          Stream.scan([] as ReadonlyArray<PtySummary>, applyTerminalMetadataStreamEvent),
        ),
    }),
    open: createHostRpcCommand(runtime, {
      ...lifecycle,
      label: "environment-data:terminal:open",
      tag: RPC_METHODS.ptyOpen,
    }),
    write: createHostRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: RPC_METHODS.ptyWrite,
    }),
    resize: createHostRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: RPC_METHODS.ptyResize,
      scheduler: resizeScheduler,
      concurrency: {
        mode: "latest",
        key: (target) =>
          JSON.stringify([target.hostId, target.input.threadId, target.input.terminalId ?? null]),
      },
    }),
    close: createHostRpcCommand(runtime, {
      ...lifecycle,
      label: "environment-data:terminal:close",
      tag: RPC_METHODS.ptyClose,
    }),
  };
}

export * from "./terminalSession.ts";

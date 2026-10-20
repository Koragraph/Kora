import { RPC_METHODS } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createHostRpcCommand, createHostRpcSubscriptionAtomFamily } from "./runtime.ts";
import type { HostRegistry } from "../link/registry.ts";

/**
 * Swarm setup atoms: the host's live readiness (`swarm.subscribe`, a snapshot-only stream that also
 * carries install progress) and the setup actions (install, keys, provider tests, consent,
 * preferences). `getStatus` with `{ probe: true }` is the "Check again" action. Gate every use on
 * the host capability `swarm` (older daemons do not serve these RPCs).
 */
export function createSwarmHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  return {
    status: createHostRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:swarm:status",
      tag: RPC_METHODS.swarmSubscribe,
      idleTtlMs: 60_000,
    }),
    getStatus: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:get-status",
      tag: RPC_METHODS.swarmGetStatus,
    }),
    installStart: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:install-start",
      tag: RPC_METHODS.swarmInstallStart,
    }),
    installCancel: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:install-cancel",
      tag: RPC_METHODS.swarmInstallCancel,
    }),
    setKey: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:set-key",
      tag: RPC_METHODS.swarmSetKey,
    }),
    clearKey: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:clear-key",
      tag: RPC_METHODS.swarmClearKey,
    }),
    testProvider: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:test-provider",
      tag: RPC_METHODS.swarmTestProvider,
    }),
    setConsent: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:set-consent",
      tag: RPC_METHODS.swarmSetConsent,
    }),
    setPreferences: createHostRpcCommand(runtime, {
      label: "environment-data:swarm:set-preferences",
      tag: RPC_METHODS.swarmSetPreferences,
    }),
  };
}

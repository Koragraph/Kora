import type { HostId } from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { LinkCatalogEntry } from "../link/catalog.ts";
import { AVAILABLE_LINK_STATE, type NetworkStatus } from "../link/model.ts";
import { HostRegistry } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { createAtomActionScheduler, createRuntimeCommand, followStreamInHost } from "./runtime.ts";

export interface HostCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<HostId, LinkCatalogEntry>;
}

/** The hosts that take part in the workspace; projects, threads and shell summaries come only from these. */
export function* enabledHostIds(catalog: HostCatalogState): Generator<HostId> {
  for (const [hostId, entry] of catalog.entries) {
    if (entry.enabled) yield hostId;
  }
}

const INITIAL_CATALOG: HostCatalogState = Object.freeze({
  isReady: false,
  entries: new Map<HostId, LinkCatalogEntry>(),
});

export function createHostCatalogAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  const catalogAtom = runtime
    .atom(
      Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* HostRegistry;
          return SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries): HostCatalogState => ({ isReady: true, entries })),
          );
        }),
      ),
    )
    .pipe(Atom.withLabel("environment-catalog"));

  const catalogEntryAtom = Atom.make((get): HostCatalogState =>
    Option.getOrElse(AsyncResult.value(get(catalogAtom)), () => INITIAL_CATALOG),
  ).pipe(Atom.withLabel("environment-catalog-value"));

  const networkStatusAtom = runtime
    .atom(
      Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* HostRegistry;
          return SubscriptionRef.changes(registry.networkStatus);
        }),
      ),
      { initialValue: "unknown" as NetworkStatus },
    )
    .pipe(Atom.withLabel("environment-network-status"));

  const networkStatusValueAtom = Atom.make((get): NetworkStatus =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as NetworkStatus),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* HostSupervisor.HostSupervisor;
              return SubscriptionRef.changes(supervisor.state);
            }),
          ),
        ),
        { initialValue: AVAILABLE_LINK_STATE },
      )
      .pipe(Atom.withLabel(`environment-state:${hostId}`)),
  );

  // Catalog commands all share one lane: enabling and retrying never interleave.
  const scheduler = createAtomActionScheduler();
  const concurrency = { mode: "serial", key: () => "environment-catalog" } as const;

  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler,
    concurrency,
    execute: (input: { readonly hostId: HostId; readonly enabled: boolean }) =>
      Effect.gen(function* () {
        const registry = yield* HostRegistry;
        return yield* registry.setEnabled(input.hostId, input.enabled);
      }),
  });

  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler,
    concurrency,
    execute: (hostId: HostId) =>
      Effect.gen(function* () {
        const registry = yield* HostRegistry;
        return yield* registry.retryNow(hostId);
      }),
  });

  const actions = { retryNow, setEnabled };
  return {
    stateAtom,
    networkStatusAtom,
    networkStatusValueAtom,
    catalogAtom,
    catalogEntryAtom,
    ...actions,
  };
}

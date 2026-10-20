import { HostId } from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as Persistence from "../embedder/hostCache.ts";
import {
  type PlatformLinkRegistration,
  type LocalLinkRegistration,
  type LinkCatalogEntry,
  linkRegistrationCatalogEntry,
} from "./catalog.ts";
import { Connectivity } from "./connectivity.ts";
import { LinkDriver } from "./driver.ts";
import type { NetworkStatus, SupervisorLinkState } from "./model.ts";
import * as HostSupervisor from "./supervisor.ts";
import { LinkWakeups } from "./wakeups.ts";

export class HostNotRegisteredError extends Schema.TaggedError<HostNotRegisteredError>()(
  "HostNotRegisteredError",
  { hostId: HostId },
) {
  override get message() {
    return `Environment ${this.hostId} is not registered.`;
  }
}

export class HostRegistry extends Context.Service<
  HostRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<ReadonlyMap<HostId, LinkCatalogEntry>>;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    readonly registerPlatform: (registration: LocalLinkRegistration) => Effect.Effect<void>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformLinkRegistration>,
    ) => Effect.Effect<void>;
    readonly retryNow: (hostId: HostId) => Effect.Effect<void>;
    /** Off drops the socket and stops the retry ladder. */
    readonly setEnabled: (
      hostId: HostId,
      enabled: boolean,
    ) => Effect.Effect<void, HostNotRegisteredError>;
    readonly state: (hostId: HostId) => Effect.Effect<SupervisorLinkState, HostNotRegisteredError>;
    readonly stateChanges: (
      hostId: HostId,
    ) => Stream.Stream<SupervisorLinkState, HostNotRegisteredError>;
    readonly run: <A, E, R>(
      hostId: HostId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HostNotRegisteredError, Exclude<R, HostSupervisor.HostSupervisor>>;
    readonly runStream: <A, E, R>(
      hostId: HostId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E | HostNotRegisteredError, Exclude<R, HostSupervisor.HostSupervisor>>;
    /** Survives the host's entry being replaced or removed instead of failing. */
    readonly followStream: <A, E, R>(
      hostId: HostId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, HostSupervisor.HostSupervisor>>;
  }
>()("@kora/client-runtime/link/registry/HostRegistry") {}

/** A live supervisor and the entry it was built for. */
interface Lease {
  entry: LinkCatalogEntry;
  readonly supervisor: HostSupervisor.HostSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

const sameEntry = (a: LinkCatalogEntry, b: LinkCatalogEntry): boolean =>
  a.enabled === b.enabled && Equal.equals(a.target, b.target);

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const connectivity = yield* Connectivity;
  const driver = yield* LinkDriver;
  const wakeups = yield* LinkWakeups;
  const cache = yield* Persistence.HostCacheStore;
  const ownedData = yield* Persistence.HostOwnedDataCleanup;

  const entries = yield* SubscriptionRef.make<ReadonlyMap<HostId, LinkCatalogEntry>>(new Map());
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(yield* connectivity.status);
  const leases = new Map<HostId, Lease>();
  const platformHostIds = new Set<HostId>();

  const publishNetworkStatus = (status: NetworkStatus) =>
    SubscriptionRef.set(networkStatus, status);
  yield* Effect.forkScoped(Stream.runForEach(connectivity.changes, publishNetworkStatus));

  // One lock per host, reference-counted so the map does not grow without bound. Everything that
  // creates or replaces a host's supervisor runs under it, so two callers never build two.
  const locks = new Map<HostId, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const withHostLock = <A, E, R>(hostId: HostId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = locks.get(hostId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lock.users += 1;
        locks.set(hostId, lock);
        return lock;
      }),
      (lock) => lock.semaphore.withPermit(effect),
      (lock) =>
        Effect.sync(() => {
          lock.users -= 1;
          if (lock.users === 0) locks.delete(hostId);
        }),
    );

  const createLease = (entry: LinkCatalogEntry) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(scope);
        const supervisor = yield* restore(
          HostSupervisor.make(entry, { initiallyDesired: false }).pipe(
            Effect.provideService(Scope.Scope, child),
            Effect.provideService(Connectivity, connectivity),
            Effect.provideService(LinkDriver, driver),
            Effect.provideService(LinkWakeups, wakeups),
          ),
        ).pipe(Effect.onError(() => Scope.close(child, Exit.void)));
        if (entry.enabled) yield* supervisor.connect;
        const lease: Lease = { entry, supervisor, scope: child };
        leases.set(entry.target.hostId, lease);
        return lease;
      }),
    );

  const dropLease = (hostId: HostId) =>
    Effect.suspend(() => {
      const lease = leases.get(hostId);
      leases.delete(hostId);
      return lease === undefined ? Effect.void : Scope.close(lease.scope, Exit.void);
    });

  const acquireSupervisor = (hostId: HostId) =>
    withHostLock(
      hostId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(hostId);
        if (entry === undefined) return yield* Effect.fail(new HostNotRegisteredError({ hostId }));
        const existing = leases.get(hostId);
        if (existing !== undefined && sameEntry(existing.entry, entry)) return existing.supervisor;
        // The entry changed: a new supervisor replaces the old one.
        yield* dropLease(hostId);
        return (yield* createLease(entry)).supervisor;
      }),
    );

  const run = <A, E, R>(hostId: HostId, effect: Effect.Effect<A, E, R>) =>
    acquireSupervisor(hostId).pipe(
      Effect.flatMap((supervisor) =>
        Effect.provideService(effect, HostSupervisor.HostSupervisor, supervisor),
      ),
    ) as Effect.Effect<A, E | HostNotRegisteredError, Exclude<R, HostSupervisor.HostSupervisor>>;

  const runStream = <A, E, R>(hostId: HostId, stream: Stream.Stream<A, E, R>) =>
    Stream.unwrap(
      acquireSupervisor(hostId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, HostSupervisor.HostSupervisor, supervisor),
        ),
      ),
    ) as Stream.Stream<A, E | HostNotRegisteredError, Exclude<R, HostSupervisor.HostSupervisor>>;

  const followStream = <A, E, R>(hostId: HostId, stream: Stream.Stream<A, E, R>) =>
    SubscriptionRef.changes(entries).pipe(
      Stream.map((current) => current.get(hostId)),
      Stream.changesWith((a, b) =>
        a === undefined || b === undefined ? a === b : sameEntry(a, b),
      ),
      Stream.switchMap((entry) =>
        entry === undefined
          ? Stream.empty
          : Stream.unwrap(
              acquireSupervisor(hostId).pipe(
                Effect.map((supervisor) =>
                  Stream.provideService(stream, HostSupervisor.HostSupervisor, supervisor),
                ),
                // The host went away between the entry change and the acquire: end quietly.
                Effect.catchTag("HostNotRegisteredError", () => Effect.succeed(Stream.empty)),
              ),
            ),
      ),
    ) as Stream.Stream<A, E, Exclude<R, HostSupervisor.HostSupervisor>>;

  const installEntry = (entry: LinkCatalogEntry) => {
    const hostId = entry.target.hostId;
    return withHostLock(
      hostId,
      Effect.gen(function* () {
        platformHostIds.add(hostId);
        const previous = (yield* SubscriptionRef.get(entries)).get(hostId);
        const lease = leases.get(hostId);
        // Re-registering the same thing must not disturb a running connection.
        if (
          previous !== undefined &&
          lease !== undefined &&
          sameEntry(previous, entry) &&
          sameEntry(lease.entry, entry)
        ) {
          return;
        }
        yield* dropLease(hostId);
        yield* SubscriptionRef.update(entries, (current) => new Map(current).set(hostId, entry));
        yield* createLease(entry);
      }),
    );
  };

  const removeHost = (hostId: HostId) =>
    withHostLock(
      hostId,
      Effect.gen(function* () {
        platformHostIds.delete(hostId);
        yield* dropLease(hostId);
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(hostId);
          return next;
        });
      }),
    ).pipe(
      Effect.andThen(
        Effect.all(
          [
            cache
              .clear(hostId)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Could not clear cached environment data after removal.",
                    error,
                  ),
                ),
              ),
            ownedData.clear(hostId),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  const registerPlatform = (registration: LocalLinkRegistration) =>
    installEntry(linkRegistrationCatalogEntry(registration));

  const reconcilePlatform = (registrations: ReadonlyArray<PlatformLinkRegistration>) =>
    Effect.gen(function* () {
      const wanted = new Set(registrations.map((registration) => registration.target.hostId));
      for (const hostId of [...platformHostIds]) {
        if (!wanted.has(hostId)) yield* removeHost(hostId);
      }
      for (const registration of registrations) {
        yield* installEntry(linkRegistrationCatalogEntry(registration));
      }
    });

  const retryNow = (hostId: HostId) =>
    acquireSupervisor(hostId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("HostNotRegisteredError", () => Effect.void),
    );

  const setEnabled = (hostId: HostId, enabled: boolean) =>
    withHostLock(
      hostId,
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(hostId);
        if (entry === undefined) return yield* Effect.fail(new HostNotRegisteredError({ hostId }));
        if (entry.enabled === enabled) return;

        const next: LinkCatalogEntry = { ...entry, enabled };
        yield* SubscriptionRef.update(entries, (current) => new Map(current).set(hostId, next));
        const lease = leases.get(hostId);
        if (lease === undefined) {
          if (enabled) yield* createLease(next);
          return;
        }
        // Updated in place: replacing the supervisor would reset its generation and drop durable streams.
        lease.entry = next;
        yield* enabled ? lease.supervisor.connect : lease.supervisor.disconnect;
      }),
    );

  const state = (hostId: HostId) =>
    acquireSupervisor(hostId).pipe(
      Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.state)),
    );

  const stateChanges = (hostId: HostId) =>
    followStream(
      hostId,
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* HostSupervisor.HostSupervisor;
          return SubscriptionRef.changes(supervisor.state);
        }),
      ),
    ) as Stream.Stream<SupervisorLinkState, HostNotRegisteredError>;

  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() =>
      Effect.forEach([...leases.values()], (lease) => Scope.close(lease.scope, Exit.void), {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  );

  return HostRegistry.of({
    entries,
    networkStatus,
    start: Effect.void,
    registerPlatform,
    reconcilePlatform,
    retryNow,
    setEnabled,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(HostRegistry, make);

import {
  type ThreadIndexSnapshot,
  type ThreadIndexItem,
  type HostId,
  type DaemonConfig,
  CHAT_METHODS,
} from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { errorLogFields } from "../failures/logFields.ts";
import { linkProjectionPhase } from "../link/model.ts";
import type { HostRegistry } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { LinkWakeups, shouldResubscribeAfterWakeup } from "../link/wakeups.ts";
import { HostCacheStore } from "../embedder/hostCache.ts";
import { subscribeDynamic } from "../wire/client.ts";
import type { RpcSession } from "../wire/session.ts";
import { enabledHostIds, type HostCatalogState } from "./connections.ts";
import { followStreamInHost } from "./runtime.ts";
import { applySummaryStreamEvent } from "./shellReducer.ts";

export type HostShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface HostShellState {
  readonly snapshot: Option.Option<ThreadIndexSnapshot>;
  readonly status: HostShellStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: HostShellState = Object.freeze({
  error: Option.none(),
  status: "empty",
  snapshot: Option.none(),
});

const SAVE_DEBOUNCE = Duration.millis(500);
const RETRY_AFTER = "250 millis";

/** Where a shell with no live feed stands: showing the cache, or nothing. */
const idleStatus = (snapshot: Option.Option<ThreadIndexSnapshot>): HostShellStatus =>
  Option.isSome(snapshot) ? "cached" : "empty";

export const makeHostShellState = Effect.fn("clientRuntime.state.makeHostShellState")(function* () {
  const supervisor = yield* HostSupervisor.HostSupervisor;
  const cache = yield* HostCacheStore;
  const wakeups = yield* Effect.serviceOption(LinkWakeups);
  const hostId = supervisor.target.hostId;

  const cached = yield* cache.loadShell(hostId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.", {
        hostId,
        ...errorLogFields(error),
      }).pipe(Effect.as(Option.none<ThreadIndexSnapshot>())),
    ),
  );
  const state = yield* SubscriptionRef.make<HostShellState>({
    snapshot: cached,
    status: idleStatus(cached),
    error: Option.none(),
  });

  // Persistence trails the live state: the newest snapshot is written after it has been quiet for 500 ms.
  const pending = yield* Queue.sliding<ThreadIndexSnapshot>(1);
  yield* Stream.fromQueue(pending).pipe(
    Stream.debounce(SAVE_DEBOUNCE),
    Stream.runForEach((snapshot) =>
      cache.saveShell(hostId, snapshot).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.", {
            hostId,
            ...errorLogFields(error),
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const update = (patch: Partial<HostShellState>) =>
    SubscriptionRef.update(state, (current) => ({ ...current, ...patch }));

  // The session the subscription is running on, and whether its snapshot is complete.
  let activeSession: RpcSession | null = null;
  let lastAuthoritativeSession: RpcSession | null = null;
  let awaitingCompletion = false;

  // Link state decides the status while there is no feed. Started first, so its initial
  // reading is applied before the subscription's.
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.map(linkProjectionPhase),
    Stream.changes,
    Stream.runForEach((phase) =>
      SubscriptionRef.update(state, (current): HostShellState => {
        switch (phase) {
          case "synchronizing":
            return { ...current, status: "synchronizing", error: Option.none() };
          case "disconnected":
            awaitingCompletion = false;
            return { ...current, status: idleStatus(current.snapshot) };
          case "ready":
            return current.status === "live" ? current : { ...current, status: "synchronizing" };
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const makeInput = (session: RpcSession) =>
    Effect.gen(function* () {
      activeSession = session;
      const supportsMarker = yield* session.initialConfig.pipe(
        Effect.map((config: DaemonConfig) => config.shellResumeCompletionMarker === true),
        Effect.orElseSucceed(() => false),
      );
      awaitingCompletion = supportsMarker;
      yield* update({ status: "synchronizing" });

      const snapshot = (yield* SubscriptionRef.get(state)).snapshot;
      const marker = supportsMarker ? ({ requestCompletionMarker: true } as const) : {};
      // A cursor is only trusted when the snapshot came from this very session; otherwise the
      // server must send a complete snapshot, because a stale cursor would preserve incomplete data.
      if (lastAuthoritativeSession === session && Option.isSome(snapshot)) {
        // Without the completion marker nothing will say "caught up", so assume it.
        if (!supportsMarker) yield* update({ status: "live" });
        return { afterSequence: snapshot.value.seq, ...marker };
      }
      return marker;
    });

  const applyBatch = (items: ReadonlyArray<ThreadIndexItem>) =>
    Effect.gen(function* () {
      const before = yield* SubscriptionRef.get(state);
      let snapshot = before.snapshot;
      let status = before.status;
      let sawSnapshot = false;
      for (const item of items) {
        if (item.kind === "snapshot") {
          snapshot = Option.some(item.snapshot);
          sawSnapshot = true;
        } else if (item.kind === "synchronized") {
          awaitingCompletion = false;
          if (Option.isSome(snapshot)) status = "live";
        } else if (Option.isSome(snapshot) && item.sequence > snapshot.value.seq) {
          snapshot = Option.some(applySummaryStreamEvent(snapshot.value, item));
        }
        status = awaitingCompletion ? "synchronizing" : "live";
      }
      if (sawSnapshot) lastAuthoritativeSession = activeSession;

      // One write per batch, not per event.
      yield* update({ snapshot, status, error: Option.none() });
      if (Option.isSome(snapshot) && snapshot !== before.snapshot) {
        yield* Queue.offer(pending, snapshot.value);
      }
    });

  yield* subscribeDynamic(CHAT_METHODS.subscribeThreads, makeInput, {
    onExpectedFailure: () =>
      Effect.gen(function* () {
        awaitingCompletion = false;
        yield* Effect.logWarning("Could not synchronize the environment shell.", { hostId });
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          status: idleStatus(current.snapshot),
          error: Option.some("Could not synchronize environment data."),
        }));
      }),
    retryExpectedFailureAfter: RETRY_AFTER,
    retryDefectAfter: "1 second",
    ...(Option.isSome(wakeups)
      ? {
          resubscribe: wakeups.value.changes.pipe(Stream.filter(shouldResubscribeAfterWakeup)),
        }
      : {}),
  }).pipe(Stream.runForEachArray(applyBatch), Effect.forkScoped);

  return state;
});

/** Roll-up of every host's shell for status UI. */
export type HostShellSummary = Readonly<
  Record<"hasSnapshot" | "hasLiveShell" | "hasCachedShell" | "hasSynchronizingShell", boolean> &
    Record<"firstError" | "latestSnapshotUpdatedAt", string | null>
>;

/** The daemon config of every enabled host that has one; the previous map is kept while nothing changed. */
export function createHostDaemonConfigsAtom(input: {
  readonly catalogEntryAtom: Atom.Atom<HostCatalogState>;
  readonly daemonConfigValueAtom: (hostId: HostId) => Atom.Atom<DaemonConfig | null>;
}): Atom.Atom<ReadonlyMap<HostId, DaemonConfig>> {
  let previous: ReadonlyMap<HostId, DaemonConfig> = new Map();
  return Atom.make((get): ReadonlyMap<HostId, DaemonConfig> => {
    const next = new Map<HostId, DaemonConfig>();
    for (const hostId of enabledHostIds(get(input.catalogEntryAtom))) {
      const config = get(input.daemonConfigValueAtom(hostId));
      if (config !== null) next.set(hostId, config);
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([hostId, config]) => previous.get(hostId) === config);
    if (unchanged) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createHostShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | HostCacheStore | R, E>,
) {
  const stateAtom = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const shell = yield* makeHostShellState();
              return SubscriptionRef.changes(shell);
            }),
          ),
        ),
        { initialValue: EMPTY_SHELL_STATE },
      )
      .pipe(Atom.withLabel(`environment-shell-state:${hostId}`)),
  );

  const stateEntryAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): HostShellState =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(hostId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${hostId}`)),
  );

  return { stateAtom, stateEntryAtom };
}

export * from "./shellReducer.ts";
export * from "./shellCommands.ts";
export * from "./models.ts";
export * from "./snapshots.ts";

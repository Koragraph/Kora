import { describe, expect, it } from "@effect/vitest";
import { HostId } from "@kora/contracts";
import { Deferred, Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect";
import * as TestClock from "effect/testing/TestClock";

import type { KoraRpcClient } from "../wire/protocol.ts";
import * as RpcSession from "../wire/session.ts";
import type { LinkCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as LinkDriver from "./driver.ts";
import {
  LinkBlockedError,
  LinkTransientError,
  LocalLinkTarget,
  type LinkAttemptError,
  type LinkTarget,
  type NetworkStatus,
  type PreparedLink,
  type SupervisorLinkState,
} from "./model.ts";
import * as HostSupervisor from "./supervisor.ts";
import * as LinkWakeups from "./wakeups.ts";

const TARGET = new LocalLinkTarget({
  wsBaseUrl: "wss://supervised.test",
  httpBaseUrl: "https://supervised.test",
  label: "Test environment",
  hostId: HostId.make("environment-1"),
});

const TARGET_ENTRY: LinkCatalogEntry = { enabled: true, target: TARGET };

const PREPARED_LINK: PreparedLink = {
  target: TARGET,
  socketUrl: `${TARGET.wsBaseUrl}/ws`,
  httpAuthorization: null,
  httpBaseUrl: TARGET.httpBaseUrl,
  label: TARGET.label,
  hostId: TARGET.hostId,
};

const TEST_RPC_CLIENT = {} as KoraRpcClient;

/** What a link that missed its setup deadline records as its last failure. */
const SETUP_TIMEOUT_FAILURE = {
  message: "Test environment did not respond during connection setup.",
  reason: "timeout",
  _tag: "LinkTransientError",
} as const;

const transient = (detail = "Connection failed.") =>
  new LinkTransientError({ detail, reason: "transport" });

const blocked = (detail = "Authentication required.") =>
  new LinkBlockedError({ detail, reason: "authentication" });

type StateRef = SubscriptionRef.SubscriptionRef<SupervisorLinkState>;
type StatePredicate = (value: SupervisorLinkState) => boolean;

/** Waits (event-driven) for the first state satisfying the predicate. */
const awaitState = (state: StateRef, predicate: StatePredicate) =>
  Effect.map(
    Stream.runHead(Stream.filter(SubscriptionRef.changes(state), predicate)),
    Option.getOrThrow,
  );

const describeState = (state: SupervisorLinkState) =>
  [
    `phase=${state.phase}`,
    `stage=${state.stage ?? "none"}`,
    `attempt=${state.attempt}`,
    `generation=${state.generation}`,
  ].join(", ");

/** Polls the state while yielding, for assertions made after a manual clock advance. */
const eventuallyState = (state: StateRef, predicate: StatePredicate) =>
  Effect.gen(function* () {
    let polls = 100;
    let latest = yield* SubscriptionRef.get(state);
    while (!predicate(latest)) {
      if (polls-- === 0) {
        const detail = `Expected supervisor state was not observed. Last state: ${describeState(latest)}`;
        return yield* Effect.die(new Error(detail));
      }
      yield* Effect.yieldNow;
      latest = yield* SubscriptionRef.get(state);
    }
    return latest;
  });

type Position = Pick<SupervisorLinkState, "phase"> &
  Partial<Pick<SupervisorLinkState, "attempt" | "generation" | "stage">>;

/** Matches a state whose phase and every given field agree with `position`. */
const at =
  (position: Position): StatePredicate =>
  (state) =>
    (Object.keys(position) as Array<keyof Position>).every(
      (field) => position[field] === undefined || state[field] === position[field],
    );

/** `awaitState` / `eventuallyState` on a supervisor's own state, by position. */
const reach = (supervisor: { readonly state: StateRef }, position: Position) =>
  awaitState(supervisor.state, at(position));
const settle = (supervisor: { readonly state: StateRef }, position: Position) =>
  eventuallyState(supervisor.state, at(position));

type HarnessOptions = Partial<{
  readonly networkStatus: NetworkStatus;
  readonly probe: (attempt: number) => Effect.Effect<void, LinkAttemptError>;
  readonly ready: (attempt: number) => Effect.Effect<void, LinkAttemptError>;
  readonly prepare: (
    attempt: number,
    target: LinkTarget,
  ) => Effect.Effect<PreparedLink, LinkAttemptError>;
}>;

type WakeEvent = { readonly reason: LinkWakeups.LinkWakeup; readonly sequence: number };

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (
  options: HarnessOptions = {},
) {
  const [prepareCount, sessionCount, releaseCount] = yield* Effect.all([
    Ref.make(0),
    Ref.make(0),
    Ref.make(0),
  ]);
  const network = yield* SubscriptionRef.make<NetworkStatus>(options.networkStatus ?? "online");
  // The first value is a placeholder; subscribers skip it.
  const wakeups = yield* SubscriptionRef.make<WakeEvent>({
    reason: "application-active",
    sequence: 0,
  });
  const closers = yield* Ref.make<ReadonlyArray<Deferred.Deferred<never, LinkTransientError>>>([]);
  const bump = (counter: Ref.Ref<number>) => Ref.updateAndGet(counter, (n) => n + 1);

  const prepare = (target: LinkTarget) =>
    Effect.flatMap(bump(prepareCount), (attempt) =>
      options.prepare === undefined
        ? Effect.succeed(PREPARED_LINK)
        : options.prepare(attempt, target),
    );

  /** Opens a fake session for `attempt` that stays up until the test closes it. */
  const openSession = (
    attempt: number,
    closeSignal: Deferred.Deferred<never, LinkTransientError>,
  ) => {
    const session: RpcSession.RpcSession = {
      closed: Deferred.await(closeSignal),
      probe: options.probe?.(attempt) ?? Effect.void,
      ready: options.ready?.(attempt) ?? Effect.void,
      subscribeDaemonConfig: (input) => TEST_RPC_CLIENT.subscribeDaemonConfig(input),
      initialConfig: Effect.die(new Error("Initial config is not used by supervisor tests.")),
      client: TEST_RPC_CLIENT,
    };
    return Effect.acquireRelease(Effect.succeed(session), () => Effect.asVoid(bump(releaseCount)));
  };

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: LinkCatalogEntry,
    reportProgress: (progress: LinkDriver.LinkDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* prepare(entry.target);
    yield* reportProgress({ prepared, stage: "opening" });

    const closeSignal = yield* Deferred.make<never, LinkTransientError>();
    yield* Ref.update(closers, (list) => list.concat([closeSignal]));
    const session = yield* openSession(yield* bump(sessionCount), closeSignal);

    yield* reportProgress({ prepared, stage: "synchronizing" });
    yield* session.ready;
    const lease: LinkDriver.HostLinkLease = { session, prepared };
    return lease;
  });

  const wakeChanges = Stream.map(
    Stream.drop(SubscriptionRef.changes(wakeups), 1),
    ({ reason }) => reason,
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(LinkDriver.LinkDriver, LinkDriver.LinkDriver.of({ connect })),
    Layer.succeed(LinkWakeups.LinkWakeups, LinkWakeups.LinkWakeups.of({ changes: wakeChanges })),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({
        changes: SubscriptionRef.changes(network),
        status: SubscriptionRef.get(network),
      }),
    ),
  );

  const closeLatestSession = (error = transient("Session closed.")) =>
    Effect.flatMap(Ref.get(closers), (list) => {
      const latest = list.at(-1);
      return latest === undefined ? Effect.void : Effect.asVoid(Deferred.fail(latest, error));
    });

  return {
    closeLatestSession,
    wake: (reason: LinkWakeups.LinkWakeup) =>
      SubscriptionRef.update(wakeups, ({ sequence }) => ({ reason, sequence: sequence + 1 })),
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(network, status),
    releaseCount,
    sessionCount,
    prepareCount,
    dependencies,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
type Supervisor = Effect.Success<ReturnType<typeof HostSupervisor.make>>;

interface Scenario {
  readonly harness?: HarnessOptions;
  /** `false` builds the supervisor without the "connect on creation" flag. */
  readonly desired?: boolean;
}

/** Builds the harness and a supervisor wired to it, then hands both to the body. */
const supervised = <A, E>(
  scenario: Scenario,
  body: (supervisor: Supervisor, harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(scenario.harness);
    const supervisor = yield* HostSupervisor.make(
      TARGET_ENTRY,
      scenario.desired === false ? undefined : { initiallyDesired: true },
    ).pipe(Effect.provide(harness.dependencies));
    return yield* body(supervisor, harness);
  });

const advance = (duration: Parameters<typeof TestClock.adjust>[0]) => TestClock.adjust(duration);

/** Fires the given platform wakeups all at once. */
const wakeTogether = (harness: Harness, ...reasons: ReadonlyArray<LinkWakeups.LinkWakeup>) =>
  Effect.all(
    reasons.map((reason) => harness.wake(reason)),
    { concurrency: "unbounded", discard: true },
  );

const withManualClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

const countOf = (counter: Ref.Ref<number>) => Ref.get(counter);
const isEmpty = <A>(ref: SubscriptionRef.SubscriptionRef<Option.Option<A>>) =>
  SubscriptionRef.get(ref).pipe(Effect.map(Option.isNone));

// First backoff rung is 3s, doubling to a 16s ceiling.
const BACKOFF_LADDER_MS = [3_000, 4_000, 8_000, 16_000, 16_000, 16_000];

describe("HostSupervisor", () => {
  describe("starting up", () => {
    it.effect("stays idle until a connection is wanted", () =>
      supervised({ desired: false }, (supervisor, harness) =>
        Effect.gen(function* () {
          expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
          expect(yield* countOf(harness.prepareCount)).toBe(0);
        }),
      ),
    );

    it.effect("keeps the first attempt alive when the initial connect request arrives", () =>
      supervised({ desired: false }, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* supervisor.connect;
          yield* reach(supervisor, { phase: "connected" });

          expect(yield* countOf(harness.sessionCount)).toBe(1);
          expect(yield* countOf(harness.releaseCount)).toBe(0);
        }),
      ),
    );

    it.effect("holds off while offline, then connects once the network is back", () =>
      supervised({ harness: { networkStatus: "offline" } }, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "offline" });
          expect(yield* countOf(harness.prepareCount)).toBe(0);

          yield* harness.setNetworkStatus("online");
          const connected = yield* reach(supervisor, { phase: "connected" });

          const { desired, network, attempt, generation, lastFailure } = connected;
          expect({ attempt, generation, lastFailure, network, desired }).toEqual({
            desired: true,
            network: "online",
            lastFailure: null,
            generation: 1,
            attempt: 1,
          });
          expect(yield* countOf(harness.prepareCount)).toBe(1);
        }),
      ),
    );
  });

  describe("backoff", () => {
    it.effect("climbs the backoff ladder and stays at sixteen seconds forever", () =>
      withManualClock(
        supervised(
          { harness: { prepare: () => Effect.fail(transient()) } },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              expect(yield* countOf(harness.prepareCount)).toBe(1);

              for (const [rung, delay] of BACKOFF_LADDER_MS.entries()) {
                yield* advance(delay);
                yield* settle(supervisor, { phase: "backoff", attempt: rung + 2 });
              }

              expect(yield* countOf(harness.prepareCount)).toBe(7);
            }),
        ),
      ),
    );

    it.effect("shows the previous failure while the next attempt is underway", () =>
      withManualClock(
        supervised(
          {
            harness: {
              prepare: (attempt) =>
                attempt > 1 ? Effect.never : Effect.fail(transient("Relay connection timed out.")),
            },
          },
          (supervisor) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              yield* advance("3 seconds");

              const retrying = yield* reach(supervisor, {
                phase: "connecting",
                stage: "preparing",
                attempt: 2,
              });
              // The failed first attempt stays visible while attempt two prepares.
              expect(retrying.lastFailure).toMatchObject({
                message: "Relay connection timed out.",
                reason: "transport",
                _tag: "LinkTransientError",
              });
            }),
        ),
      ),
    );

    it.effect("gives up on a session that never reports ready and backs off", () =>
      withManualClock(
        supervised({ harness: { ready: () => Effect.never } }, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connecting", stage: "synchronizing" });
            yield* advance("14 seconds");
            expect((yield* SubscriptionRef.get(supervisor.state)).stage).toBe("synchronizing");

            yield* advance("1 second");
            const backedOff = yield* reach(supervisor, { phase: "backoff" });

            expect(backedOff).toMatchObject({
              phase: "backoff",
              lastFailure: SETUP_TIMEOUT_FAILURE,
            });
            expect(yield* countOf(harness.releaseCount)).toBe(1);
            expect(yield* isEmpty(supervisor.prepared)).toBe(true);
          }),
        ),
      ),
    );

    it.effect("interrupts a preparation that outlasts the setup deadline", () =>
      withManualClock(
        supervised({ harness: { prepare: () => Effect.never } }, (supervisor) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connecting", stage: "preparing" });
            yield* advance("15 seconds");
            const backedOff = yield* settle(supervisor, { phase: "backoff", attempt: 1 });

            expect(backedOff).toMatchObject({ lastFailure: SETUP_TIMEOUT_FAILURE });
          }),
        ),
      ),
    );

    it.effect("ignores platform wakeups while an attempt is already in flight", () =>
      withManualClock(
        Effect.gen(function* () {
          const attemptBegan = yield* Deferred.make<void>();
          return yield* supervised(
            {
              harness: {
                prepare: () =>
                  Deferred.succeed(attemptBegan, undefined).pipe(Effect.andThen(Effect.never)),
              },
            },
            (supervisor, harness) =>
              Effect.gen(function* () {
                yield* Deferred.await(attemptBegan);
                const burst = ["credentials-changed", "application-active"] as const;
                yield* wakeTogether(harness, ...burst, burst[0]);
                yield* Effect.yieldNow;
                expect(yield* countOf(harness.prepareCount)).toBe(1);

                yield* advance("15 seconds");
                const backedOff = yield* settle(supervisor, { phase: "backoff", attempt: 1 });

                expect(backedOff).toMatchObject({ lastFailure: SETUP_TIMEOUT_FAILURE });
                expect(yield* countOf(harness.prepareCount)).toBe(1);
                expect(yield* countOf(harness.sessionCount)).toBe(0);
              }),
          );
        }),
      ),
    );

    it.effect("treats an unexpected session close as transient and reconnects", () =>
      withManualClock(
        supervised({}, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connected" });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 1 });
            expect(yield* isEmpty(supervisor.prepared)).toBe(true);

            yield* advance("3 seconds");
            yield* reach(supervisor, { phase: "connected", generation: 2 });

            expect(yield* countOf(harness.sessionCount)).toBe(2);
            expect(yield* isEmpty(supervisor.prepared)).toBe(false);
          }),
        ),
      ),
    );

    it.effect("keeps escalating when a freshly opened session drops again", () =>
      withManualClock(
        supervised({}, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connected" });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 1 });

            yield* advance("3 seconds");
            yield* reach(supervisor, { phase: "connected", generation: 2 });
            yield* harness.closeLatestSession();
            const second = yield* reach(supervisor, { phase: "backoff", attempt: 2 });
            expect(second.retryAt).not.toBeNull();

            yield* advance("3 seconds");
            expect(yield* countOf(harness.sessionCount)).toBe(2);

            yield* advance("1 second");
            yield* reach(supervisor, { phase: "connected", generation: 3 });
            expect(yield* countOf(harness.sessionCount)).toBe(3);
          }),
        ),
      ),
    );
  });

  describe("explicit retry", () => {
    it.effect("cuts the current backoff short", () =>
      supervised(
        {
          harness: {
            prepare: (attempt) =>
              attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_LINK),
          },
        },
        (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "backoff" });
            yield* supervisor.retryNow;
            yield* reach(supervisor, { phase: "connected" });

            expect(yield* countOf(harness.prepareCount)).toBe(2);
          }),
      ),
    );

    it.effect("begins a new backoff ladder from the first rung", () =>
      withManualClock(
        supervised(
          { harness: { prepare: () => Effect.fail(transient()) } },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              yield* advance("3 seconds");
              yield* settle(supervisor, { phase: "backoff", attempt: 2 });

              yield* supervisor.retryNow;
              yield* settle(supervisor, { phase: "backoff", attempt: 1 });
              expect(yield* countOf(harness.prepareCount)).toBe(3);

              yield* advance("2999 millis");
              expect(yield* countOf(harness.prepareCount)).toBe(3);
              yield* advance("1 milli");
              yield* settle(supervisor, { phase: "backoff", attempt: 2 });
              expect(yield* countOf(harness.prepareCount)).toBe(4);
            }),
        ),
      ),
    );
  });

  describe("blocked links", () => {
    const blockedOnce: HarnessOptions = {
      prepare: (attempt) =>
        attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_LINK),
    };

    it.effect("sits idle until something asks for another attempt", () =>
      withManualClock(
        supervised({ harness: blockedOnce }, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "blocked" });
            yield* advance("1 hour");
            expect(yield* countOf(harness.prepareCount)).toBe(1);

            yield* supervisor.retryNow;
            yield* reach(supervisor, { phase: "connected" });
            expect(yield* countOf(harness.prepareCount)).toBe(2);
          }),
        ),
      ),
    );

    it.effect("starts the retry ladder over when activation wakes a blocked link", () =>
      withManualClock(
        supervised(
          {
            harness: {
              prepare: (attempt) => {
                if (attempt === 1) return Effect.fail(transient());
                if (attempt === 2) return Effect.fail(blocked());
                return Effect.succeed(PREPARED_LINK);
              },
            },
          },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              yield* advance("3 seconds");
              yield* reach(supervisor, { phase: "blocked", attempt: 2 });

              yield* harness.wake("application-active-reconnect");
              yield* reach(supervisor, { phase: "connected", attempt: 1 });
            }),
        ),
      ),
    );

    it.effect("tries again when platform credentials change", () =>
      supervised({ harness: blockedOnce }, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "blocked" });
          yield* harness.wake("credentials-changed");
          yield* reach(supervisor, { phase: "connected" });

          expect(yield* countOf(harness.prepareCount)).toBe(2);
        }),
      ),
    );
  });

  describe("network changes", () => {
    it.effect("restarts retries when activation lands before the network returns", () =>
      supervised({}, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "connected" });
          yield* harness.closeLatestSession();
          yield* reach(supervisor, { phase: "backoff", attempt: 1 });
          yield* harness.setNetworkStatus("offline");
          yield* reach(supervisor, { phase: "offline", attempt: 2 });

          yield* harness.wake("application-active-reconnect");
          yield* reach(supervisor, { phase: "offline", attempt: 1 });
          yield* harness.setNetworkStatus("online");
          yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 1 });
        }),
      ),
    );

    it.effect("drops a live session when offline and opens a new generation when back", () =>
      supervised({}, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "connected", generation: 1 });
          yield* harness.setNetworkStatus("offline");
          yield* reach(supervisor, { phase: "offline" });

          expect(yield* countOf(harness.releaseCount)).toBe(1);
          expect(yield* isEmpty(supervisor.session)).toBe(true);

          yield* harness.setNetworkStatus("online");
          yield* reach(supervisor, { phase: "connected", generation: 2 });
          expect(yield* countOf(harness.sessionCount)).toBe(2);
        }),
      ),
    );
  });

  describe("long resume (application-active-reconnect)", () => {
    it.effect("resets the ladder when the app returns to the foreground on mobile", () =>
      withManualClock(
        supervised({}, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connected" });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 1 });
            yield* advance("3 seconds");
            yield* reach(supervisor, { phase: "connected", generation: 2 });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 2 });

            yield* harness.wake("application-active-reconnect");
            yield* reach(supervisor, { phase: "connected", generation: 3, attempt: 1 });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 1 });

            expect(yield* countOf(harness.sessionCount)).toBe(3);
          }),
        ),
      ),
    );

    it.effect("resets the ladder when a long resume replaces a connected session", () =>
      withManualClock(
        supervised({}, (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connected" });
            yield* harness.closeLatestSession();
            yield* reach(supervisor, { phase: "backoff", attempt: 1 });
            yield* advance("3 seconds");
            yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 2 });

            yield* harness.wake("application-active-reconnect");
            yield* reach(supervisor, { phase: "connected", generation: 3, attempt: 1 });
          }),
        ),
      ),
    );

    it.effect("resets the ladder when a long resume interrupts connection setup", () =>
      withManualClock(
        supervised(
          {
            harness: {
              prepare: (attempt) => (attempt === 2 ? Effect.never : Effect.succeed(PREPARED_LINK)),
            },
          },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.closeLatestSession();
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              yield* advance("3 seconds");
              yield* reach(supervisor, { phase: "connecting", attempt: 2 });

              yield* harness.wake("application-active-reconnect");
              yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 1 });
            }),
        ),
      ),
    );

    it.effect("swaps the session at once after a long background resume", () => {
      return Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        yield* supervised(
          { harness: { probe: () => Ref.update(probes, (count) => count + 1) } },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected", generation: 1 });
              yield* harness.wake("application-active-reconnect");
              yield* reach(supervisor, { phase: "connected", generation: 2 });

              expect(yield* countOf(probes)).toBe(0);
              expect(yield* countOf(harness.sessionCount)).toBe(2);
              expect(yield* countOf(harness.releaseCount)).toBe(1);
            }),
        );
      });
    });

    it.effect("swaps the session even when a probe is hanging at the time", () =>
      supervised(
        { harness: { probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void) } },
        (supervisor, harness) =>
          Effect.gen(function* () {
            yield* reach(supervisor, { phase: "connected", generation: 1 });
            for (const reason of [
              "application-active-probe",
              "application-active-reconnect",
            ] as const) {
              yield* Effect.andThen(harness.wake(reason), Effect.yieldNow);
            }
            yield* reach(supervisor, { phase: "connected", generation: 2 });

            expect(yield* countOf(harness.sessionCount)).toBe(2);
            expect(yield* countOf(harness.releaseCount)).toBe(1);
          }),
      ),
    );
  });

  describe("foreground liveness probe", () => {
    it.effect("probes the live session on activation without reconnecting", () =>
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const probeRan = yield* Deferred.make<void>();
        yield* supervised(
          {
            harness: {
              probe: () =>
                Ref.update(probes, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(probeRan, undefined)),
                ),
            },
          },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.wake("application-active");
              yield* Deferred.await(probeRan);

              expect(yield* countOf(probes)).toBe(1);
              expect(yield* countOf(harness.sessionCount)).toBe(1);
              expect(yield* countOf(harness.releaseCount)).toBe(0);
              expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
            }),
        );
      }),
    );

    const staleFirstProbe = (attempt: number) =>
      attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void;

    it.effect("reconnects immediately when the probe finds the session dead", () =>
      withManualClock(
        Effect.gen(function* () {
          const reconnectGate = yield* Deferred.make<void>();
          yield* supervised(
            {
              harness: {
                prepare: (attempt) =>
                  attempt === 2
                    ? Deferred.await(reconnectGate).pipe(Effect.as(PREPARED_LINK))
                    : Effect.succeed(PREPARED_LINK),
                probe: staleFirstProbe,
              },
            },
            (supervisor, harness) =>
              Effect.gen(function* () {
                yield* reach(supervisor, { phase: "connected" });
                yield* harness.wake("application-active");
                const reconnecting = yield* reach(supervisor, { phase: "connecting" });
                expect(reconnecting.attempt).toBe(1);
                expect(yield* isEmpty(supervisor.session)).toBe(true);

                // No clock advance: a failed wake probe skips the first backoff rung.
                yield* Deferred.succeed(reconnectGate, undefined);
                yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 1 });

                expect(yield* countOf(harness.sessionCount)).toBe(2);
                expect(yield* countOf(harness.releaseCount)).toBe(1);
              }),
          );
        }),
      ),
    );

    it.effect("falls back to normal backoff if the follow-up reconnect fails as well", () =>
      withManualClock(
        supervised(
          {
            harness: {
              prepare: (attempt) =>
                attempt === 2 ? Effect.fail(transient()) : Effect.succeed(PREPARED_LINK),
              probe: staleFirstProbe,
            },
          },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.wake("application-active");
              // Only the first attempt after the wake probe skips the ladder, so
              // this failure backs off the usual way.
              yield* reach(supervisor, { phase: "backoff", attempt: 1 });
              yield* advance("2999 millis");
              expect(yield* countOf(harness.prepareCount)).toBe(2);
              yield* advance("1 milli");
              yield* settle(supervisor, { phase: "connected", generation: 2 });

              expect(yield* countOf(harness.prepareCount)).toBe(3);
            }),
        ),
      ),
    );

    it.effect("gives a stalled desktop probe the whole tolerance window", () =>
      withManualClock(
        supervised(
          { harness: { probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void) } },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.wake("application-active");
              yield* advance("14999 millis");
              expect(yield* countOf(harness.sessionCount)).toBe(1);
              yield* advance("1 milli");
              yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 1 });

              expect(yield* countOf(harness.sessionCount)).toBe(2);
            }),
        ),
      ),
    );

    it.effect("times a stalled mobile probe out quickly", () =>
      withManualClock(
        supervised(
          { harness: { probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void) } },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.wake("application-active-probe");
              yield* advance("3 seconds");
              // The timed-out wake probe reconnects with no backoff sleep, so the
              // clock needs no further advance.
              yield* reach(supervisor, { phase: "connected", generation: 2, attempt: 1 });

              expect(yield* countOf(harness.sessionCount)).toBe(2);
            }),
        ),
      ),
    );

    it.effect("obeys an explicit disconnect while a probe is stalled", () =>
      Effect.gen(function* () {
        const probeBegan = yield* Deferred.make<void>();
        yield* supervised(
          {
            harness: {
              probe: () =>
                Deferred.succeed(probeBegan, undefined).pipe(Effect.andThen(Effect.never)),
            },
          },
          (supervisor, harness) =>
            Effect.gen(function* () {
              yield* reach(supervisor, { phase: "connected" });
              yield* harness.wake("application-active");
              yield* Deferred.await(probeBegan);
              yield* supervisor.disconnect;
              yield* reach(supervisor, { phase: "available" });

              expect(yield* countOf(harness.releaseCount)).toBe(1);
            }),
        );
      }),
    );
  });

  describe("disconnecting and credentials", () => {
    it.effect("leaves a healthy session alone when credentials change", () =>
      supervised({}, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "connected" });
          yield* harness.wake("credentials-changed");
          yield* Effect.yieldNow;

          expect(yield* countOf(harness.sessionCount)).toBe(1);
          expect(yield* countOf(harness.releaseCount)).toBe(0);
          expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
        }),
      ),
    );

    it.effect("disconnect frees the session and goes back to available", () =>
      supervised({}, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "connected" });
          yield* supervisor.disconnect;
          yield* reach(supervisor, { phase: "available" });

          expect(yield* countOf(harness.releaseCount)).toBe(1);
          expect(yield* isEmpty(supervisor.session)).toBe(true);
          expect(yield* isEmpty(supervisor.prepared)).toBe(true);
        }),
      ),
    );

    it.effect("honors a disconnect that races with several wakeup signals", () =>
      supervised({}, (supervisor, harness) =>
        Effect.gen(function* () {
          yield* reach(supervisor, { phase: "connected" });
          // A disconnect racing a burst of wakeups must still win.
          const wakes = wakeTogether(
            harness,
            "credentials-changed",
            "application-active",
            "credentials-changed",
          );
          yield* Effect.all([supervisor.disconnect, wakes], { concurrency: "unbounded" });
          yield* reach(supervisor, { phase: "available" });

          expect(yield* countOf(harness.releaseCount)).toBe(1);
          expect(yield* isEmpty(supervisor.session)).toBe(true);
        }),
      ),
    );
  });
});

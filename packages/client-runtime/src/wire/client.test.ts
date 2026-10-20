import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_DAEMON_PREFS,
  HostId,
  RPC_METHODS,
  type DaemonConfigStreamEvent,
  type DaemonLifecycleStreamEvent,
} from "@kora/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Stream, SubscriptionRef } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_LINK_STATE,
  LocalLinkTarget,
  type PreparedLink,
  type SupervisorLinkState,
} from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { retryDelayMillis, subscribe, subscribeDynamicWithSession } from "./client.ts";
import type { KoraRpcClient } from "./protocol.ts";
import * as RpcSession from "./session.ts";

const TARGET = new LocalLinkTarget({
  wsBaseUrl: "wss://rpc-host.test",
  label: "RPC host",
  hostId: HostId.make("environment-1"),
  httpBaseUrl: "https://rpc-host.test",
});

const sessionFor = (client: KoraRpcClient): RpcSession.RpcSession => {
  const subscribeDaemonConfig: RpcSession.RpcSession["subscribeDaemonConfig"] = (input) =>
    client.subscribeDaemonConfig(input);
  return {
    subscribeDaemonConfig,
    client,
    probe: Effect.void,
    ready: Effect.void,
    closed: Effect.never,
    initialConfig: Effect.never,
  };
};

/** A client double that only implements the listed RPC methods. */
const clientWith = (methods: Record<string, () => unknown>) => methods as unknown as KoraRpcClient;

/** A `ptyWatchMeta` client that records its name and then behaves as `produce` says. */
const labelledWatcher = (label: string, trail: string[], produce: () => unknown) =>
  clientWith({
    [RPC_METHODS.ptyWatchMeta]: () => {
      trail.push(label);
      return produce();
    },
  });

/** The client error a dropped socket surfaces as. */
const socketClosed = () => {
  const message = "socket closed";
  const reason = new RpcClientError.RpcClientDefect({ cause: new Error(message), message });
  return new RpcClientError.RpcClientError({ reason });
};

const makeHarness = Effect.fn("TestHostRpc.makeHarness")(function* () {
  const retryCount = yield* Ref.make(0);
  const activeSession = yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>());
  const service: HostSupervisor.HostSupervisor["Service"] = {
    retryNow: Ref.updateAndGet(retryCount, (count) => count + 1).pipe(Effect.asVoid),
    disconnect: Effect.void,
    connect: Effect.void,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedLink>()),
    session: activeSession,
    state: yield* SubscriptionRef.make<SupervisorLinkState>(AVAILABLE_LINK_STATE),
    target: TARGET,
  };
  return { supervisor: HostSupervisor.HostSupervisor.of(service), retryCount, activeSession };
});

type Supervisor = HostSupervisor.HostSupervisor["Service"];

const useSession = (
  slot: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>,
  session: RpcSession.RpcSession | null,
) => SubscriptionRef.set(slot, session ? Option.some(session) : Option.none());

/** Yields until `done()` is true, at most `limit` times. */
const spinUntil = (done: () => boolean, limit = 100) =>
  Effect.gen(function* () {
    for (let n = 0; n < limit && !done(); n += 1) yield* Effect.yieldNow;
  });

const domainFailure = (message: string) => new Error(message);

describe("environment RPC", () => {
  it.effect("takes the config stream from the session instead of opening a second one", () =>
    Effect.gen(function* () {
      const update: DaemonConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_DAEMON_PREFS },
      };
      let extraSubscriptions = 0;
      const client = clientWith({
        [RPC_METHODS.subscribeDaemonConfig]: () => {
          extraSubscriptions += 1;
          return Stream.never;
        },
      });
      const { activeSession, supervisor } = yield* makeHarness();
      yield* useSession(activeSession, {
        ...sessionFor(client),
        subscribeDaemonConfig: () => Stream.succeed(update),
      });

      const first = yield* subscribe(RPC_METHODS.subscribeDaemonConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
      );

      expect(first).toEqual(Option.some(update));
      expect(extraSubscriptions).toBe(0);
    }),
  );

  describe("durable subscriptions", () => {
    const drainOn = (supervisor: Supervisor) =>
      subscribe(RPC_METHODS.ptyWatchMeta, {}).pipe(
        Stream.runDrain,
        Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
        Effect.forkChild,
      );

    it.effect("moves to the new session when the supervisor replaces it", () =>
      Effect.gen(function* () {
        const trail: string[] = [];
        const firstClient = labelledWatcher("first", trail, () => Stream.never);
        const secondClient = labelledWatcher("second", trail, () => Stream.never);
        const { activeSession, retryCount, supervisor } = yield* makeHarness();
        const awaitCount = Effect.fn("TestHostRpc.awaitSubscriptions")(function* (count: number) {
          yield* spinUntil(() => trail.length >= count);
          if (trail.length < count) {
            return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
          }
        });

        const watcher = yield* drainOn(supervisor);
        yield* useSession(activeSession, sessionFor(firstClient));
        yield* awaitCount(1);
        yield* useSession(activeSession, sessionFor(secondClient));
        yield* awaitCount(2);
        yield* Fiber.interrupt(watcher);

        const retries = yield* Ref.get(retryCount);
        expect({ retries, trail }).toEqual({ trail: ["first", "second"], retries: 0 });
      }),
    );

    it.effect("stays subscribed through a transport failure and a fresh session", () =>
      Effect.gen(function* () {
        const trail: string[] = [];
        const firstClient = labelledWatcher("first", trail, () => Stream.fail(socketClosed()));
        const secondClient = labelledWatcher("second", trail, () => Stream.never);
        const { activeSession, retryCount, supervisor } = yield* makeHarness();

        const watcher = yield* drainOn(supervisor);
        yield* useSession(activeSession, sessionFor(firstClient));
        yield* spinUntil(() => trail.length >= 1);
        yield* useSession(activeSession, null);
        yield* useSession(activeSession, sessionFor(secondClient));

        yield* spinUntil(() => trail.length >= 2);
        yield* Fiber.interrupt(watcher);

        const retries = yield* Ref.get(retryCount);
        expect({ retries, trail }).toEqual({ trail: ["first", "second"], retries: 0 });
      }),
    );

    it.effect("lets the old session's producer finish values it had already buffered", () =>
      Effect.gen(function* () {
        const gate = () => Deferred.make<void>();
        const [firstOpened, secondOpened, firstHeld, letFirstGo] = yield* Effect.all([
          gate(),
          gate(),
          gate(),
          gate(),
        ]);
        const asLifecycle = (source: string, index: number) =>
          ({ source, index }) as unknown as DaemonLifecycleStreamEvent;
        const firstValue = asLifecycle("first", 1);
        const bufferedValue = asLifecycle("first", 2);
        const secondValue = asLifecycle("second", 1);
        const lifecycleClient = (
          opened: Deferred.Deferred<void>,
          values: DaemonLifecycleStreamEvent[],
        ) =>
          clientWith({
            [RPC_METHODS.subscribeDaemonLifecycle]: () =>
              Stream.concat(
                Stream.drain(Stream.fromEffect(Deferred.succeed(opened, undefined))),
                Stream.concat(Stream.fromIterable(values), Stream.never),
              ),
          });
        const firstSession = sessionFor(lifecycleClient(firstOpened, [firstValue, bufferedValue]));
        const secondSession = sessionFor(lifecycleClient(secondOpened, [secondValue]));
        const { activeSession, supervisor } = yield* makeHarness();

        const collector = yield* subscribeDynamicWithSession(
          RPC_METHODS.subscribeDaemonLifecycle,
          () => Effect.succeed({}),
        ).pipe(
          Stream.mapEffect((pair) => {
            if (pair[1] !== firstValue) return Effect.succeed(pair);
            // Hold the first value until the test lets it through.
            const hold = Effect.andThen(
              Deferred.succeed(firstHeld, undefined),
              Deferred.await(letFirstGo),
            );
            return Effect.as(hold, pair);
          }),
          Stream.take(3),
          Stream.runCollect,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );

        yield* useSession(activeSession, firstSession);
        yield* Deferred.await(firstOpened);
        yield* Deferred.await(firstHeld);
        yield* useSession(activeSession, secondSession);
        yield* Deferred.await(secondOpened);
        yield* Deferred.succeed(letFirstGo, undefined);

        expect(yield* Fiber.join(collector)).toEqual([
          [firstSession, firstValue],
          [firstSession, bufferedValue],
          [secondSession, secondValue],
        ]);
      }),
    );
  });

  describe("domain failures", () => {
    it.effect("passes a domain failure through without reconnecting", () =>
      Effect.gen(function* () {
        const failure = domainFailure("terminal subscription rejected");
        const client = clientWith({ [RPC_METHODS.ptyWatchMeta]: () => Stream.fail(failure) });
        const { activeSession, retryCount, supervisor } = yield* makeHarness();

        yield* useSession(activeSession, sessionFor(client));
        const error = yield* subscribe(RPC_METHODS.ptyWatchMeta, {}).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.flip,
        );

        expect(error).toBe(failure);
        expect(yield* Ref.get(retryCount)).toBe(0);
      }),
    );

    it.effect("parks a handled domain failure until a replacement session shows up", () =>
      Effect.gen(function* () {
        const failure = domainFailure("terminal subscription rejected");
        const trail: string[] = [];
        const seenFailures: Error[] = [];
        const firstClient = labelledWatcher("first", trail, () => Stream.fail(failure));
        const secondClient = labelledWatcher("second", trail, () => Stream.never);
        const { activeSession, retryCount, supervisor } = yield* makeHarness();

        yield* useSession(activeSession, sessionFor(firstClient));
        const watcher = yield* subscribe(
          RPC_METHODS.ptyWatchMeta,
          {},
          {
            onExpectedFailure: (cause) =>
              Effect.sync(() => {
                seenFailures.push(Cause.squash(cause) as Error);
              }),
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* spinUntil(() => seenFailures.length >= 1);

        expect(trail).toEqual(["first"]);
        expect(seenFailures).toEqual([failure]);

        yield* useSession(activeSession, sessionFor(secondClient));
        yield* spinUntil(() => trail.length >= 2);
        yield* Fiber.interrupt(watcher);

        expect(trail).toEqual(["first", "second"]);
        expect(yield* Ref.get(retryCount)).toBe(0);
      }),
    );

    it.effect("retries a handled domain failure on the same session when asked to", () =>
      Effect.gen(function* () {
        const failure = domainFailure("thread not found yet");
        const opens = yield* Ref.make(0);
        const handled = yield* Ref.make(0);
        const client = clientWith({
          [RPC_METHODS.ptyWatchMeta]: () =>
            Stream.unwrap(
              Ref.getAndUpdate(opens, (count) => count + 1).pipe(
                Effect.map((before) => (before === 0 ? Stream.fail(failure) : Stream.never)),
              ),
            ),
        });
        const { activeSession, supervisor } = yield* makeHarness();
        const refAtLeast = (ref: Ref.Ref<number>, target: number) =>
          Effect.gen(function* () {
            for (let n = 0; n < 100 && (yield* Ref.get(ref)) < target; n += 1) {
              yield* Effect.yieldNow;
            }
          });

        yield* useSession(activeSession, sessionFor(client));
        const watcher = yield* subscribe(
          RPC_METHODS.ptyWatchMeta,
          {},
          {
            onExpectedFailure: () => Ref.update(handled, (count) => count + 1),
            retryExpectedFailureAfter: "100 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* refAtLeast(handled, 1);

        expect(yield* Ref.get(opens)).toBe(1);
        expect(yield* Ref.get(handled)).toBe(1);

        yield* TestClock.adjust("100 millis");
        yield* refAtLeast(opens, 2);
        yield* Fiber.interrupt(watcher);

        expect(yield* Ref.get(opens)).toBe(2);
        expect(yield* Ref.get(handled)).toBe(1);
      }),
    );
  });

  describe("defects", () => {
    const expectDefect = (exit: Exit.Exit<unknown, unknown>, defect: Error) => {
      const cause = Exit.isFailure(exit) ? exit.cause : undefined;
      expect(cause).toBeDefined();
      expect(cause && Cause.hasDies(cause)).toBe(true);
      expect(cause && Cause.squash(cause)).toBe(defect);
    };

    it.effect.each(["input", "stream"] as const)(
      "never mistakes a defect in the %s for an expected failure",
      (origin) =>
        Effect.gen(function* () {
          const defect = new Error("subscription invariant failed");
          let handledCount = 0;
          let inputRuns = 0;
          let streamRuns = 0;
          const reportedDefects: unknown[] = [];
          const client = clientWith({
            [RPC_METHODS.ptyWatchMeta]: () => {
              streamRuns += 1;
              return origin === "stream" ? Stream.die(defect) : Stream.never;
            },
          });
          const { activeSession, supervisor } = yield* makeHarness();

          yield* useSession(activeSession, sessionFor(client));
          const exit = yield* subscribeDynamicWithSession(
            RPC_METHODS.ptyWatchMeta,
            () =>
              Effect.sync(() => {
                inputRuns += 1;
              }).pipe(Effect.andThen(origin === "input" ? Effect.die(defect) : Effect.succeed({}))),
            {
              onDefect: (cause) =>
                Effect.sync(() => {
                  reportedDefects.push(Cause.squash(cause));
                }),
              onExpectedFailure: () =>
                Effect.sync(() => {
                  handledCount += 1;
                }),
              retryExpectedFailureAfter: "250 millis",
            },
          ).pipe(
            Stream.runDrain,
            Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
            Effect.exit,
          );

          expectDefect(exit, defect);
          expect(inputRuns).toBe(1);
          expect(streamRuns).toBe(origin === "input" ? 0 : 1);
          expect({ handledCount, reportedDefects }).toEqual({
            reportedDefects: [defect],
            handledCount: 0,
          });
        }),
    );

    it.effect("reports an initializer defect exactly once after an expected failure retried", () =>
      Effect.gen(function* () {
        const timeline: string[] = [];
        const reportedDefects: unknown[] = [];
        const defect = new Error("Synthetic retry initializer defect");
        let inputRuns = 0;
        const handledOnce = yield* Deferred.make<void>();
        const client = clientWith({
          [RPC_METHODS.ptyWatchMeta]: () => {
            timeline.push("stream");
            return Stream.fail(new Error("subscription not ready"));
          },
        });
        const { activeSession, supervisor } = yield* makeHarness();
        yield* useSession(activeSession, sessionFor(client));
        const runner = yield* subscribeDynamicWithSession(
          RPC_METHODS.ptyWatchMeta,
          () =>
            Effect.sync(() => {
              inputRuns += 1;
              timeline.push(`input ${inputRuns}`);
              return inputRuns;
            }).pipe(Effect.flatMap((run) => (run === 1 ? Effect.succeed({}) : Effect.die(defect)))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                timeline.push("defect");
                reportedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                timeline.push("expected failure");
              }).pipe(Effect.andThen(Deferred.succeed(handledOnce, undefined)), Effect.asVoid),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(handledOnce);
        yield* TestClock.adjust("250 millis");

        expectDefect(yield* Fiber.join(runner), defect);
        expect(timeline).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
        expect(reportedDefects).toEqual([defect]);
      }),
    );
  });

  describe("retry backoff", () => {
    const refAtLeast = (ref: Ref.Ref<number>, target: number) =>
      Effect.gen(function* () {
        for (let n = 0; n < 200 && (yield* Ref.get(ref)) < target; n += 1) {
          yield* Effect.yieldNow;
        }
      });

    it("doubles the delay per failure in a row and caps it", () => {
      expect(retryDelayMillis("250 millis", 1)).toBe(250);
      expect(retryDelayMillis("250 millis", 2)).toBe(500);
      expect(retryDelayMillis("250 millis", 4)).toBe(2000);
      expect(retryDelayMillis("250 millis", 50)).toBe(30_000);
      expect(retryDelayMillis("1 second", 3, "3 seconds")).toBe(3000);
    });

    it.effect("backs off between expected failures instead of retrying at a fixed rate", () =>
      Effect.gen(function* () {
        const opens = yield* Ref.make(0);
        const client = clientWith({
          [RPC_METHODS.ptyWatchMeta]: () =>
            Stream.unwrap(
              Ref.update(opens, (count) => count + 1).pipe(
                Effect.as(Stream.fail(domainFailure("corrupt thread file"))),
              ),
            ),
        });
        const { activeSession, supervisor } = yield* makeHarness();
        yield* useSession(activeSession, sessionFor(client));
        const watcher = yield* subscribe(
          RPC_METHODS.ptyWatchMeta,
          {},
          { onExpectedFailure: () => Effect.void, retryExpectedFailureAfter: "100 millis" },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* refAtLeast(opens, 1);
        yield* TestClock.adjust("100 millis");
        yield* refAtLeast(opens, 2);
        // The second retry waits 200 ms, not 100.
        yield* TestClock.adjust("100 millis");
        for (let n = 0; n < 20; n += 1) yield* Effect.yieldNow;
        expect(yield* Ref.get(opens)).toBe(2);
        yield* TestClock.adjust("100 millis");
        yield* refAtLeast(opens, 3);
        yield* Fiber.interrupt(watcher);
        expect(yield* Ref.get(opens)).toBe(3);
      }),
    );

    it.effect("does not retry an authorization failure on the same session", () =>
      Effect.gen(function* () {
        const opens = yield* Ref.make(0);
        const handled = yield* Ref.make(0);
        const denied = Object.assign(new Error("not authorized"), {
          _tag: "HostAuthorizationError",
        });
        const client = clientWith({
          [RPC_METHODS.ptyWatchMeta]: () =>
            Stream.unwrap(
              Ref.update(opens, (count) => count + 1).pipe(Effect.as(Stream.fail(denied))),
            ),
        });
        const { activeSession, supervisor } = yield* makeHarness();
        yield* useSession(activeSession, sessionFor(client));
        const watcher = yield* subscribe(
          RPC_METHODS.ptyWatchMeta,
          {},
          {
            onExpectedFailure: () => Ref.update(handled, (count) => count + 1),
            retryExpectedFailureAfter: "100 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* refAtLeast(handled, 1);
        yield* TestClock.adjust("10 seconds");
        for (let n = 0; n < 20; n += 1) yield* Effect.yieldNow;
        yield* Fiber.interrupt(watcher);
        expect(yield* Ref.get(opens)).toBe(1);
      }),
    );

    it.effect("keeps a subscription alive through a defect when asked to retry defects", () =>
      Effect.gen(function* () {
        const defect = new Error("encode crash");
        const opens = yield* Ref.make(0);
        const reported: unknown[] = [];
        const client = clientWith({
          [RPC_METHODS.ptyWatchMeta]: () =>
            Stream.unwrap(
              Ref.getAndUpdate(opens, (count) => count + 1).pipe(
                Effect.map((before) => (before === 0 ? Stream.die(defect) : Stream.never)),
              ),
            ),
        });
        const { activeSession, supervisor } = yield* makeHarness();
        yield* useSession(activeSession, sessionFor(client));
        const watcher = yield* subscribe(
          RPC_METHODS.ptyWatchMeta,
          {},
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                reported.push(Cause.squash(cause));
              }),
            retryDefectAfter: "1 second",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* refAtLeast(opens, 1);
        yield* spinUntil(() => reported.length >= 1);
        yield* TestClock.adjust("1 second");
        yield* refAtLeast(opens, 2);
        yield* Fiber.interrupt(watcher);
        expect(reported).toEqual([defect]);
        expect(yield* Ref.get(opens)).toBe(2);
      }),
    );
  });
});

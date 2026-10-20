import { describe, expect, it } from "@effect/vitest";
import { HostId } from "@kora/contracts";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_LINK_STATE,
  LinkBlockedError,
  LinkTransientError,
  LocalLinkTarget,
  type PreparedLink,
  type SupervisorLinkState,
} from "../link/model.ts";
import * as HostRegistry from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { HostRpcUnavailableError } from "../wire/client.ts";
import type * as RpcSession from "../wire/session.ts";
import * as Runtime from "./runtime.ts";

const {
  createAtomActionScheduler,
  createHostQueryAtomFamily,
  hostRpcKey,
  createRuntimeCommand,
  executeAtomQuery,
  executeAtomAction,
  runAtomAction,
  mapAtomActionResult,
  isAtomActionInterrupted,
  squashAtomActionFailure,
  settlePromise,
  settleAsyncResult,
} = Runtime;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const QUERY_HOST = new LocalLinkTarget({
  hostId: HostId.make("query-environment"),
  wsBaseUrl: "wss://query.host.test",
  httpBaseUrl: "https://query.host.test",
  label: "Query host",
});

const FAKE_SESSION = {} as RpcSession.RpcSession;

class TestQueryError extends Schema.TaggedError<TestQueryError>()("TestQueryError", {
  message: Schema.String,
}) {}

const RELAY_DOWN = new LinkTransientError({ reason: "transport", detail: "Relay is unavailable." });
const ACCESS_DENIED = new LinkBlockedError({ reason: "permission", detail: "Access denied." });

const linkState = (overrides: Partial<SupervisorLinkState> = {}): SupervisorLinkState => ({
  ...AVAILABLE_LINK_STATE,
  phase: "connected",
  ...{ attempt: 1, generation: 1, desired: true, network: "online" as const },
  ...overrides,
});

/** A latch that is closed until someone opens it. */
const gate = () => Latch.makeUnsafe();

const hostQueryRig = Effect.fn("TestHostQuery.makeHarness")(function* <A, E>(
  execute: Effect.Effect<A, E>,
) {
  const [supervisorState, supervisorSession] = yield* Effect.all([
    SubscriptionRef.make(linkState()),
    SubscriptionRef.make(Option.some(FAKE_SESSION)),
  ]);
  const idle = { retryNow: Effect.void, connect: Effect.void, disconnect: Effect.void };
  const supervisor = HostSupervisor.HostSupervisor.of({
    ...idle,
    target: QUERY_HOST,
    session: supervisorSession,
    state: supervisorState,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedLink>>(Option.none()),
  } satisfies HostSupervisor.HostSupervisor["Service"]);
  type RegistryApi = HostRegistry.HostRegistry["Service"];
  const runOnSupervisor: RegistryApi["run"] = (_hostId, effect) =>
    Effect.provideService(effect, HostSupervisor.HostSupervisor, supervisor);
  const followOnSupervisor: RegistryApi["followStream"] = (_hostId, stream) =>
    Stream.provideService(stream, HostSupervisor.HostSupervisor, supervisor);
  const registryService = HostRegistry.HostRegistry.of({
    run: runOnSupervisor,
    followStream: followOnSupervisor,
    stateChanges: () => SubscriptionRef.changes(supervisorState),
  } as unknown as RegistryApi);
  const family = createHostQueryAtomFamily(
    Atom.runtime(Layer.succeed(HostRegistry.HostRegistry, registryService)),
    { label: "test.environment-query", staleTimeMs: 60_000, execute: () => execute },
  );

  return {
    atom: family({ hostId: QUERY_HOST.hostId, input: undefined }),
    supervisorSession,
    supervisorState,
  };
});

const mountQuery = Effect.fn("TestHostQuery.mount")(function* <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      const made = AtomRegistry.make();
      return { made, release: made.mount(atom) };
    }),
    ({ made, release }) => Effect.sync(() => (release(), made.dispose())),
  ).pipe(Effect.map(({ made }) => made));
});

/** Resolves the atom once it is no longer waiting. */
const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });

const failureCause = (result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) => {
  expect(result._tag).toBe("Failure");
  return result.cause!;
};

// ---------------------------------------------------------------------------

describe("settleAsyncResult", () => {
  it("keeps successful values as they are", async () => {
    const result = await settleAsyncResult(() => Promise.resolve(Exit.succeed("done")));

    expect(AsyncResult.isSuccess(result) && result.value).toBe("done");
  });

  it("keeps typed failures typed", async () => {
    const boom = new Error("request failed");
    const result = await settleAsyncResult(() => Promise.resolve(Exit.fail(boom)));

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(false);
      expect(Cause.squash(result.cause)).toBe(boom);
    }
  });

  it.each([
    {
      how: "throws synchronously",
      defect: new Error("thrown defect"),
      start: (defect: Error) => () => {
        throw defect;
      },
    },
    {
      how: "rejects",
      defect: new Error("rejected defect"),
      start: (defect: Error) => () => Promise.reject(defect),
    },
  ])("turns a source that $how into a defect", async ({ defect, start }) => {
    const result = await settleAsyncResult<void, never>(start(defect));

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
  });
});

describe("atom command result helpers", () => {
  it("transforms the value of a successful command", () => {
    const mapped = mapAtomActionResult(AsyncResult.success(2), (value) => value * 3);

    expect(mapped._tag === "Success" && mapped.value).toBe(6);
  });

  it("passes a failure through unchanged", () => {
    const mapped = mapAtomActionResult(
      AsyncResult.failure<number, string>(Cause.fail("nope")),
      (value) => value * 3,
    );

    expect(mapped._tag).toBe("Failure");
    if (mapped._tag === "Failure") expect(Cause.squash(mapped.cause)).toBe("nope");
  });

  it("tells an interruption apart from a real failure", () => {
    const interruption = AsyncResult.failure(Cause.interrupt(1));
    const realFailure = AsyncResult.failure(Cause.fail("nope"));

    expect(isAtomActionInterrupted(interruption)).toBe(true);
    expect(isAtomActionInterrupted(realFailure)).toBe(false);
    expect(squashAtomActionFailure(realFailure)).toBe("nope");
  });

  it("settles a bare promise as a success or a defect", async () => {
    expect((await settlePromise(() => Promise.resolve("done")))._tag).toBe("Success");

    const rejection = new Error("raw promise rejected");
    const failed = await settlePromise(() => Promise.reject(rejection));
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") {
      expect(Cause.hasDies(failed.cause)).toBe(true);
      expect(Cause.squash(failed.cause)).toBe(rejection);
    }
  });

  it("logs expected failures as warnings and defects as errors", async () => {
    const logged = { warn: [] as string[], error: [] as string[] };
    const reporter = {
      error: (line: string) => void logged.error.push(line),
      warn: (line: string) => void logged.warn.push(line),
    };
    const quiet = { reportFailure: false, label: "quiet save" };
    const outcomes: Array<
      [() => Promise<Exit.Exit<unknown, unknown>>, Parameters<typeof executeAtomAction>[1]]
    > = [
      [async () => Exit.fail("nope"), { label: "save" }],
      [async () => Exit.fail("ignored"), quiet],
      [() => Promise.reject(new Error("defect")), quiet],
      [async () => Exit.interrupt(1), { label: "interrupted" }],
    ];
    for (const [run, options] of outcomes) await executeAtomAction(run as never, options, reporter);

    // Typed failures warn unless silenced, defects always error, interruptions say nothing.
    expect(logged).toEqual({
      warn: ["[atom-command] save failed"],
      error: ["[atom-command] quiet save defected"],
    });
  });
});

describe("hostRpcKey", () => {
  it("separates subscription state per environment and per cwd", () => {
    const hostId = HostId.make("environment-1");
    const here = { hostId, input: { cwd: "/repo/original" } };
    const elsewhere = { hostId, input: { cwd: "/repo/next" } };
    const otherHost = { hostId: HostId.make("environment-2"), input: here.input };

    expect(hostRpcKey(here)).not.toBe(hostRpcKey(elsewhere));
    expect(hostRpcKey(here)).toBe(hostRpcKey({ ...here }));
    expect(hostRpcKey(otherHost)).not.toBe(hostRpcKey(here));
  });
});

describe("environment query lifecycle", () => {
  it.effect(
    "retries an interrupted query without surfacing a failure while the session is swapped",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstBegan = gate();
          const releaseFirst = gate();
          const firstDone = gate();
          const notConnected = new HostRpcUnavailableError({
            hostId: QUERY_HOST.hostId,
            message: "Query environment is not connected.",
          });
          let runs = 0;
          const execute = Effect.suspend(() => {
            runs += 1;
            if (runs > 1) return Effect.succeed("recovered");
            firstBegan.openUnsafe();
            return releaseFirst.await.pipe(
              Effect.andThen(Effect.fail(notConnected)),
              Effect.ensuring(Effect.sync(() => firstDone.openUnsafe())),
            );
          });
          const rig = yield* hostQueryRig(execute);
          const registry = AtomRegistry.make();
          const seen: Array<AsyncResult.AsyncResult<string, unknown>> = [];
          const unsubscribe = registry.subscribe(rig.atom, (result) => void seen.push(result), {
            immediate: true,
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => [unsubscribe, () => registry.dispose()].forEach((f) => f())),
          );

          yield* firstBegan.await;
          yield* SubscriptionRef.set(rig.supervisorSession, Option.none());
          yield* Effect.yieldNow;
          releaseFirst.openUnsafe();
          yield* firstDone.await;
          yield* Effect.yieldNow;

          expect(seen.some(AsyncResult.isFailure)).toBe(false);

          yield* SubscriptionRef.set(
            rig.supervisorState,
            linkState({ phase: "connecting", stage: "preparing" }),
          );
          yield* Effect.yieldNow;
          yield* SubscriptionRef.set(
            rig.supervisorState,
            linkState({
              phase: "backoff",
              stage: null,
              lastFailure: new LinkTransientError({
                detail: "The relay is reconnecting.",
                reason: "transport",
              }),
              retryAt: 1,
            }),
          );
          yield* Effect.yieldNow;

          yield* SubscriptionRef.set(rig.supervisorSession, Option.some(FAKE_SESSION));
          yield* SubscriptionRef.set(rig.supervisorState, linkState({ generation: 2 }));
          expect(yield* settled(registry, rig.atom)).toBe("recovered");
        }),
      ),
  );

  it.effect.each([
    {
      when: "the user disconnected",
      state: linkState({ desired: false, phase: "available", stage: null, attempt: 0 }),
      cause: null,
    },
    {
      when: "the environment is offline",
      state: linkState({
        lastFailure: RELAY_DOWN,
        stage: null,
        phase: "offline",
        network: "offline",
      }),
      cause: RELAY_DOWN,
    },
    {
      when: "recovery is blocked",
      state: linkState({ phase: "blocked", stage: null, lastFailure: ACCESS_DENIED }),
      cause: ACCESS_DENIED,
    },
  ] as const)("reports the query unavailable when $when", ({ state, cause }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const rig = yield* hostQueryRig(Effect.succeed("connected"));
        const registry = yield* mountQuery(rig.atom);
        expect(yield* settled(registry, rig.atom)).toBe("connected");

        yield* SubscriptionRef.set(rig.supervisorState, state);
        yield* Effect.yieldNow;

        const now = registry.get(rig.atom);
        expect(AsyncResult.isFailure(now)).toBe(true);
        expect(now.waiting).toBe(false);
        if (AsyncResult.isFailure(now) && cause !== null) {
          expect(Cause.squash(now.cause)).toBe(cause);
        }
      }),
    ),
  );

  it.effect("leaves a genuine query failure in place while reconnecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queryError = new TestQueryError({ message: "Query failed." });
        const firstBegan = gate();
        const failFirst = gate();
        const refreshBegan = gate();
        const finishRefresh = gate();
        let runs = 0;
        const execute = Effect.suspend(() => {
          runs += 1;
          if (runs === 1) {
            firstBegan.openUnsafe();
            return failFirst.await.pipe(Effect.andThen(Effect.fail(queryError)));
          }
          refreshBegan.openUnsafe();
          return finishRefresh.await.pipe(Effect.as("recovered"));
        });
        const rig = yield* hostQueryRig(execute);
        const registry = yield* mountQuery(rig.atom);

        yield* firstBegan.await;
        failFirst.openUnsafe();
        const first = yield* settled(registry, rig.atom).pipe(Effect.exit);
        expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBe(queryError);

        yield* SubscriptionRef.set(
          rig.supervisorState,
          linkState({ phase: "connecting", stage: "opening" }),
        );
        yield* Effect.yieldNow;

        const whileReconnecting = registry.get(rig.atom);
        expect(AsyncResult.isFailure(whileReconnecting)).toBe(true);
        expect(whileReconnecting.waiting).toBe(true);
        if (AsyncResult.isFailure(whileReconnecting)) {
          expect(Cause.squash(whileReconnecting.cause)).toBe(queryError);
        }

        yield* SubscriptionRef.set(rig.supervisorState, linkState({ generation: 2 }));
        yield* refreshBegan.await;
        finishRefresh.openUnsafe();
        expect(yield* settled(registry, rig.atom)).toBe("recovered");
      }),
    ),
  );

  it.effect("serves the last good value while a reconnect is in progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshBegan = gate();
        const finishRefresh = gate();
        let runs = 0;
        const execute = Effect.suspend(() => {
          runs += 1;
          if (runs === 1) return Effect.succeed("cached");
          refreshBegan.openUnsafe();
          return finishRefresh.await.pipe(Effect.as("updated"));
        });
        const rig = yield* hostQueryRig(execute);
        const registry = yield* mountQuery(rig.atom);
        expect(yield* settled(registry, rig.atom)).toBe("cached");

        const stillCached = () =>
          expect(registry.get(rig.atom)).toMatchObject({
            waiting: true,
            value: "cached",
            _tag: "Success",
          });

        yield* SubscriptionRef.set(
          rig.supervisorState,
          linkState({ phase: "connecting", stage: "opening" }),
        );
        yield* Effect.yieldNow;
        stillCached();

        yield* SubscriptionRef.set(
          rig.supervisorState,
          linkState({
            phase: "backoff",
            stage: null,
            lastFailure: new LinkTransientError({ reason: "transport", detail: "Retrying." }),
            retryAt: 1,
          }),
        );
        yield* Effect.yieldNow;
        stillCached();

        yield* SubscriptionRef.set(rig.supervisorState, linkState({ generation: 2 }));
        yield* refreshBegan.await;
        stillCached();

        finishRefresh.openUnsafe();
        expect(yield* settled(registry, rig.atom)).toBe("updated");
      }),
    ),
  );
});

describe("Atom.fn mutation semantics", () => {
  it.effect("cancels the earlier call when the same mutation atom is written again", () =>
    Effect.gen(function* () {
      const gates = { first: gate(), second: gate() };
      const cancelled: string[] = [];
      const mutation = Atom.fn((id: "first" | "second") =>
        gates[id].await.pipe(
          Effect.as(id),
          Effect.onInterrupt(() => Effect.sync(() => void cancelled.push(id))),
        ),
      );
      const registry = AtomRegistry.make();
      const release = registry.mount(mutation);

      for (const id of ["first", "second"] as const) registry.set(mutation, id);
      yield* Effect.yieldNow;
      expect(cancelled).toEqual(["first"]);

      gates.second.openUnsafe();
      expect(yield* settled(registry, mutation)).toBe("second");

      release();
      registry.dispose();
    }),
  );

  it.effect("stays waiting through a streamed mutation until its last value", () =>
    Effect.gen(function* () {
      const finish = gate();
      const mutation = Atom.fn(() =>
        Stream.make("progress").pipe(
          Stream.concat(Stream.fromEffect(finish.await.pipe(Effect.as("done")))),
        ),
      );
      const registry = AtomRegistry.make();
      const release = registry.mount(mutation);

      registry.set(mutation, undefined);

      const midway = registry.get(mutation);
      expect(AsyncResult.isSuccess(midway) && [midway.value, midway.waiting]).toEqual([
        "progress",
        true,
      ]);

      finish.openUnsafe();
      expect(yield* settled(registry, mutation)).toBe("done");

      release();
      registry.dispose();
    }),
  );

  it.effect("lets concurrent calls complete but does not tie results to individual writes", () =>
    Effect.gen(function* () {
      const gates = { first: gate(), second: gate() };
      const mutation = Atom.fn<never, "first" | "second", "first" | "second">(
        (id: "first" | "second") => gates[id].await.pipe(Effect.as(id)),
        { concurrent: true },
      );
      const registry = AtomRegistry.make();
      const release = registry.mount(mutation);
      const watch = () =>
        settled(registry, mutation).pipe(Effect.forkChild({ startImmediately: true }));

      registry.set(mutation, "first");
      const watchFirst = yield* watch();
      registry.set(mutation, "second");
      const watchSecond = yield* watch();

      gates.second.openUnsafe();
      yield* Effect.yieldNow;
      expect(registry.get(mutation).waiting).toBe(true);

      gates.first.openUnsafe();
      expect([yield* Fiber.join(watchFirst), yield* Fiber.join(watchSecond)]).toEqual([
        "first",
        "first",
      ]);

      release();
      registry.dispose();
    }),
  );
});

describe("executeAtomQuery", () => {
  it("returns each query's own result even when they finish out of order", async () => {
    const gates = { first: gate(), second: gate() };
    const registry = AtomRegistry.make();
    const firstAtom = Atom.make(gates.first.await.pipe(Effect.as("first")));
    const secondAtom = Atom.make(gates.second.await.pipe(Effect.as("second")));

    const pendingFirst = executeAtomQuery(registry, firstAtom);
    const pendingSecond = executeAtomQuery(registry, secondAtom);
    gates.second.openUnsafe();
    gates.first.openUnsafe();

    const results = await Promise.all([pendingFirst, pendingSecond]);
    expect(results.map((result) => result._tag)).toEqual(["Success", "Success"]);
    expect(results.map((result) => (result._tag === "Success" ? result.value : null))).toEqual([
      "first",
      "second",
    ]);

    registry.dispose();
  });

  it("settles as interrupted when the caller aborts a query that is still waiting", async () => {
    const abort = new AbortController();
    const registry = AtomRegistry.make();
    const forever = Atom.make(Effect.never);
    const pending = executeAtomQuery(registry, forever, {
      signal: abort.signal,
      reportDefect: false,
    });

    abort.abort();

    const result = await pending;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
    registry.dispose();
  });
});

describe("runtime command runner", () => {
  const emptyRuntime = () => Atom.runtime(Layer.empty);

  it("records a rejected custom command as a defect", async () => {
    const rejection = new Error("custom command rejected");
    const registry = AtomRegistry.make();
    const result = await runAtomAction(
      registry,
      { label: "test.rejected-command", run: () => Promise.reject(rejection) },
      undefined,
      { reportDefect: false },
    );

    const cause = failureCause(result);
    expect(Cause.hasDies(cause)).toBe(true);
    expect(Cause.squash(cause)).toBe(rejection);
    registry.dispose();
  });

  it("hands scheduler defects back to direct callers as failures", async () => {
    const keyError = new Error("invalid command key");
    const explode = (): never => {
      throw keyError;
    };
    const command = createRuntimeCommand(emptyRuntime(), {
      concurrency: { key: explode, mode: "serial" },
      label: "test.invalid-key",
      execute: () => Effect.void,
    });
    const registry = AtomRegistry.make();

    const cause = failureCause(await command.run(registry, undefined));
    expect(Cause.hasDies(cause)).toBe(true);
    expect(Cause.squash(cause)).toBe(keyError);
    registry.dispose();
  });

  it("matches each parallel call with its own result", async () => {
    const gates = { first: gate(), second: gate() };
    const command = createRuntimeCommand(emptyRuntime(), {
      label: "test.parallel",
      execute: (id: "first" | "second") => gates[id].await.pipe(Effect.as(id)),
    });
    const registry = AtomRegistry.make();

    const callFirst = command.run(registry, "first");
    const callSecond = command.run(registry, "second");
    gates.second.openUnsafe();
    gates.first.openUnsafe();

    expect(await callFirst).toMatchObject({ _tag: "Success", value: "first", waiting: false });
    expect(await callSecond).toMatchObject({ _tag: "Success", value: "second", waiting: false });
    registry.dispose();
  });

  it("runs commands in order when they share a scheduler and a lane", async () => {
    const holdFirst = gate();
    const trace: string[] = [];
    const runtime = emptyRuntime();
    const scheduler = createAtomActionScheduler();
    const concurrency = { mode: "serial" as const, key: () => "shared" };
    const earlier = createRuntimeCommand(runtime, {
      scheduler,
      concurrency,
      label: "test.first",
      execute: () =>
        Effect.sync(() => trace.push("first:start")).pipe(
          Effect.andThen(holdFirst.await),
          Effect.tap(() => Effect.sync(() => trace.push("first:end"))),
        ),
    });
    const later = createRuntimeCommand(runtime, {
      label: "test.second",
      scheduler,
      concurrency,
      execute: () => Effect.sync(() => trace.push("second:start")),
    });
    const registry = AtomRegistry.make();

    const runEarlier = earlier.run(registry, undefined);
    const runLater = later.run(registry, undefined);
    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);

    holdFirst.openUnsafe();
    await Promise.all([runEarlier, runLater]);
    expect(trace).toEqual(["first:start", "first:end", "second:start"]);
    registry.dispose();
  });

  it("shares one execution between single-flight calls with the same key", async () => {
    const hold = gate();
    let executions = 0;
    const command = createRuntimeCommand(emptyRuntime(), {
      concurrency: { key: (key: string) => key, mode: "singleFlight" },
      label: "test.single-flight",
      execute: () =>
        Effect.sync(() => executions++).pipe(Effect.andThen(hold.await), Effect.as("done")),
    });
    const registry = AtomRegistry.make();

    const callA = command.run(registry, "same");
    const callB = command.run(registry, "same");
    hold.openUnsafe();

    for (const call of [callA, callB]) {
      expect(await call).toMatchObject({ _tag: "Success", value: "done", waiting: false });
    }
    expect(executions).toBe(1);
    registry.dispose();
  });

  it("collapses queued latest-value calls and leaves the running one alone", async () => {
    const holdFirst = gate();
    const executed: number[] = [];
    const command = createRuntimeCommand(emptyRuntime(), {
      concurrency: { key: () => "shared", mode: "latest" },
      label: "test.latest",
      execute: (value: number) =>
        Effect.andThen(
          Effect.sync(() => executed.push(value)),
          Effect.void,
        ).pipe(Effect.andThen(value === 1 ? holdFirst.await : Effect.void), Effect.as(value)),
    });
    const registry = AtomRegistry.make();

    const callOne = command.run(registry, 1);
    await Promise.resolve();
    const callTwo = command.run(registry, 2);
    const callThree = command.run(registry, 3);
    holdFirst.openUnsafe();

    expect(await callOne).toMatchObject({ _tag: "Success", value: 1, waiting: false });
    expect(await callTwo).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(await callThree).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(executed).toEqual([1, 3]);
    registry.dispose();
  });
});

// @effect-diagnostics globalConsole:off -- the default command reporter is the console; callers can supply their own.
import type { HostId } from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import type * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { HostRegistry, type HostNotRegisteredError } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import type { LinkAttemptError, SupervisorLinkState } from "../link/model.ts";
import type { RpcSession } from "../wire/session.ts";
import {
  type HostUnaryRpcTag,
  type HostSubscriptionRpcTag,
  type HostRpcSuccess,
  type HostRpcStreamValue,
  type HostRpcStreamFailure,
  type HostRpcInput,
  type HostRpcFailure,
  type SubscriptionOptions,
  subscribe,
  request,
  HostRpcUnavailableError,
} from "../wire/client.ts";

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export type SettledAsyncResult<A, E> = AsyncResult.Failure<A, E> | AsyncResult.Success<A, E>;
export type AtomActionResult<A, E> = SettledAsyncResult<A, E>;
export type AtomActionFailure<R> = R extends AtomActionResult<infer _A, infer E> ? E : never;
export type AtomActionSuccess<R> = R extends AtomActionResult<infer A, infer _E> ? A : never;

export interface AtomActionOptions {
  /** Report defects. Default true. */
  readonly reportDefect?: boolean;
  /** Report expected failures. Default true. */
  readonly reportFailure?: boolean;
  readonly label?: string;
}

export interface AtomActionReporter {
  error(message: string, cause: Cause.Cause<unknown>): void;
  warn(message: string, cause: Cause.Cause<unknown>): void;
}

/** Spreads to `{ [key]: value }`, or to nothing while the option is unset. */
const whenSet = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });

const consoleReporter: AtomActionReporter = {
  warn: (message, cause) => console.warn(message, Cause.pretty(cause)),
  error: (message, cause) => console.error(message, Cause.pretty(cause)),
};

type CommandRun<W, A, E> = (
  registry: AtomRegistry.AtomRegistry,
  input: W,
) => Promise<AtomActionResult<A, E>>;

export interface AtomCommand<W, A, E> {
  readonly run: CommandRun<W, A, E>;
  readonly label: string;
}

export type AtomActionConcurrency<W> =
  | {
      readonly key: (input: W) => string;
      readonly mode: "serial" | "singleFlight" | "latest";
    }
  | { readonly mode: "parallel" };

type Deferred<A, E> = () => Promise<AtomActionResult<A, E>>;

export interface AtomActionScheduler {
  schedule<W, A, E>(
    registry: AtomRegistry.AtomRegistry,
    concurrency: AtomActionConcurrency<W>,
    input: W,
    execute: Deferred<A, E>,
  ): Promise<AtomActionResult<A, E>>;
}

/** Turn anything that throws or rejects into a settled defect. */
const settleThrown = async <A, E>(
  execute: () => Promise<AtomActionResult<A, E>>,
): Promise<AtomActionResult<A, E>> => {
  try {
    return await execute();
  } catch (defect) {
    return AsyncResult.failure<A, E>(Cause.die(defect));
  }
};

export const settleAsyncResult = async <A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
): Promise<SettledAsyncResult<A, E>> => {
  let settled: SettledAsyncResult<A, E>;
  try {
    settled = AsyncResult.fromExit(await execute());
  } catch (defect) {
    settled = AsyncResult.failure<A, E>(Cause.die(defect));
  }
  return settled;
};

export const settlePromise = async <A>(
  execute: () => Promise<A>,
): Promise<AtomActionResult<A, never>> => {
  let value: A;
  try {
    value = await execute();
  } catch (defect) {
    return AsyncResult.failure<A, never>(Cause.die(defect));
  }
  return AsyncResult.success<A, never>(value);
};

export function mapAtomActionResult<A, E, B>(
  result: AtomActionResult<A, E>,
  transform: (value: A) => B,
): AtomActionResult<B, E> {
  if (!AsyncResult.isSuccess(result)) return result as unknown as AtomActionResult<B, E>;
  return AsyncResult.success<B, E>(transform(result.value), { waiting: result.waiting });
}

export function isAtomActionInterrupted(result: AtomActionResult<unknown, unknown>): boolean {
  return AsyncResult.isFailure(result) && Cause.hasInterruptsOnly(result.cause);
}

export const squashAtomActionFailure = (failed: {
  readonly cause: Cause.Cause<unknown>;
}): unknown => Cause.squash(failed.cause);

const reportResult = (
  result: AtomActionResult<unknown, unknown>,
  options: AtomActionOptions | undefined,
  reporter: AtomActionReporter,
): void => {
  if (!AsyncResult.isFailure(result) || Cause.hasInterruptsOnly(result.cause)) return;
  const label = options?.label ?? "atom command";
  if (Cause.hasDies(result.cause)) {
    if (options?.reportDefect ?? true)
      reporter.error(`[atom-command] ${label} defected`, result.cause);
  } else if (options?.reportFailure ?? true) {
    reporter.warn(`[atom-command] ${label} failed`, result.cause);
  }
};

export async function executeAtomAction<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
  options?: AtomActionOptions,
  reporter: AtomActionReporter = consoleReporter,
): Promise<AtomActionResult<A, E>> {
  const result = await settleAsyncResult(execute);
  reportResult(result, options, reporter);
  return result;
}

type Registry = AtomRegistry.AtomRegistry;

export async function runAtomAction<W, A, E>(
  registry: Registry,
  command: AtomCommand<W, A, E>,
  input: W,
  options?: AtomActionOptions,
  reporter: AtomActionReporter = consoleReporter,
): Promise<AtomActionResult<A, E>> {
  const result = await settleThrown(() => command.run(registry, input));
  reportResult(result, { label: command.label, ...options }, reporter);
  return result;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

interface LatestLane {
  pending: {
    execute: () => Promise<AtomActionResult<any, any>>;
    readonly waiters: Array<(result: AtomActionResult<any, any>) => void>;
  } | null;
}

interface SchedulerState {
  readonly singleFlight: Map<string, Promise<AtomActionResult<any, any>>>;
  readonly serial: Map<string, Promise<unknown>>;
  readonly latest: Map<string, LatestLane>;
}

export function createAtomActionScheduler(): AtomActionScheduler {
  // Per registry: two registries (tests, multiple windows) never share lanes.
  const states = new WeakMap<AtomRegistry.AtomRegistry, SchedulerState>();
  const stateFor = (registry: AtomRegistry.AtomRegistry): SchedulerState => {
    let state = states.get(registry);
    if (state === undefined) {
      state = { singleFlight: new Map(), serial: new Map(), latest: new Map() };
      states.set(registry, state);
    }
    return state;
  };

  /** After a lane's running call settles, run whatever replaced the pending slot, and repeat. */
  const drainLatest = async (state: SchedulerState, key: string, lane: LatestLane) => {
    while (lane.pending !== null) {
      const pending = lane.pending;
      lane.pending = null;
      const result = await settleThrown(pending.execute);
      for (const resolve of pending.waiters) resolve(result);
    }
    if (state.latest.get(key) === lane) state.latest.delete(key);
  };

  return {
    schedule<W, A, E>(
      registry: AtomRegistry.AtomRegistry,
      concurrency: AtomActionConcurrency<W>,
      input: W,
      execute: Deferred<A, E>,
    ): Promise<AtomActionResult<A, E>> {
      if (concurrency.mode === "parallel") return settleThrown(execute);

      let key: string;
      try {
        key = concurrency.key(input);
      } catch (defect) {
        return Promise.resolve(AsyncResult.failure<A, E>(Cause.die(defect)));
      }
      const state = stateFor(registry);

      switch (concurrency.mode) {
        case "singleFlight": {
          const active = state.singleFlight.get(key);
          if (active !== undefined) return active;
          const flight = settleThrown(execute).finally(() => {
            if (state.singleFlight.get(key) === flight) state.singleFlight.delete(key);
          });
          state.singleFlight.set(key, flight);
          return flight;
        }
        case "serial": {
          const tail = state.serial.get(key) ?? Promise.resolve();
          const run = tail.then(() => settleThrown(execute));
          state.serial.set(key, run);
          void run.finally(() => {
            if (state.serial.get(key) === run) state.serial.delete(key);
          });
          return run;
        }
        case "latest": {
          const lane = state.latest.get(key);
          if (lane === undefined) {
            const fresh: LatestLane = { pending: null };
            state.latest.set(key, fresh);
            const first = settleThrown(execute);
            void first.then(() => drainLatest(state, key, fresh));
            return first;
          }
          // The lane is busy: only the newest waiting call will run, and everyone waiting gets its result.
          return new Promise((resolve) => {
            if (lane.pending === null) lane.pending = { execute, waiters: [resolve as never] };
            else {
              lane.pending.execute = execute;
              lane.pending.waiters.push(resolve as never);
            }
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface AtomQueryOptions extends AtomActionOptions {
  readonly signal?: AbortSignal;
  /** Force a refresh when the atom already holds a settled value (a cached failure must not satisfy a retry). */
  readonly refresh?: boolean;
}

type QueryAtom<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;

export async function executeAtomQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: QueryAtom<A, E>,
  options?: AtomQueryOptions,
  reporter: AtomActionReporter = consoleReporter,
): Promise<AtomActionResult<A, E>> {
  const unmount = registry.mount(atom);
  try {
    if (options?.refresh === true) {
      const current = registry.get(atom);
      if (AsyncResult.isNotInitial(current) && !current.waiting) registry.refresh(atom);
    }
    return await executeAtomAction(
      () =>
        Effect.runPromiseExit(
          AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
          options?.signal === undefined ? undefined : { signal: options.signal },
        ),
      options,
      reporter,
    );
  } finally {
    unmount();
  }
}

export function createRuntimeCommand<R, ER, W, A, E>(
  runtime: Atom.AtomRuntime<R, ER>,
  options: {
    readonly concurrency?: AtomActionConcurrency<W>;
    readonly scheduler?: AtomActionScheduler;
    readonly execute: (
      input: W,
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<A, E, R | AtomRegistry.AtomRegistry>;
    readonly label: string;
  },
): AtomCommand<W, A, E | ER> {
  const scheduler = options.scheduler ?? createAtomActionScheduler();
  const concurrency = options.concurrency ?? ({ mode: "parallel" } as const);
  return {
    label: options.label,
    run: (registry, input) =>
      scheduler.schedule(registry, concurrency, input, () => {
        // A fresh atom per run, so concurrent runs never share state; the outer
        // `runAtomAction` does the reporting.
        const atom = runtime
          .atom(options.execute(input, registry) as never)
          .pipe(Atom.withLabel(options.label)) as unknown as Atom.Atom<
          AsyncResult.AsyncResult<A, E | ER>
        >;
        return executeAtomQuery(registry, atom, { reportFailure: false, reportDefect: false });
      }),
  };
}

// ---------------------------------------------------------------------------
// Host-scoped atoms
// ---------------------------------------------------------------------------

export function hostRpcKey<Input>(target: {
  readonly hostId: HostId;
  readonly input: Input;
}): string {
  return JSON.stringify([target.hostId, target.input]);
}

export function followStreamInHost<A, E, R>(
  hostId: HostId,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, HostRegistry | Exclude<R, HostSupervisor.HostSupervisor>> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* HostRegistry;
      return registry.followStream(hostId, stream);
    }),
  ) as never;
}

type HostRuntime<R, E> = Atom.AtomRuntime<HostRegistry | R, E>;

interface HostTarget<Input> {
  readonly hostId: HostId;
  readonly input: Input;
}

/** What a host query needs to know about its connection. */
type Readiness =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ready"; readonly generation: number; readonly session: RpcSession }
  | { readonly _tag: "Unavailable"; readonly failure: LinkAttemptError | HostRpcUnavailableError };

const unavailableMessage = (hostId: HostId, state: SupervisorLinkState): string =>
  state.phase === "offline"
    ? `Environment ${hostId} is offline.`
    : state.phase === "blocked"
      ? `Environment ${hostId} is blocked.`
      : `Environment ${hostId} is not connected.`;

const readinessOf = (
  hostId: HostId,
  state: SupervisorLinkState,
  session: Option.Option<RpcSession>,
): Readiness => {
  switch (state.phase) {
    case "connected":
      return Option.isSome(session)
        ? { _tag: "Ready", generation: state.generation, session: session.value }
        : { _tag: "Pending" };
    case "connecting":
    case "backoff":
      return { _tag: "Pending" };
    default:
      return {
        _tag: "Unavailable",
        failure:
          state.lastFailure ??
          new HostRpcUnavailableError({ hostId, message: unavailableMessage(hostId, state) }),
      };
  }
};

const sameReadiness = (a: Readiness, b: Readiness): boolean => {
  if (a._tag !== b._tag) return false;
  if (a._tag === "Ready" && b._tag === "Ready") {
    return a.generation === b.generation && a.session === b.session;
  }
  if (a._tag === "Unavailable" && b._tag === "Unavailable") return a.failure === b.failure;
  return true;
};

/** Per-runtime cache of "what is this host's connection doing" atoms. */
const readinessFamily = <R, E>(runtime: HostRuntime<R, E>) =>
  Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const supervisor = yield* HostSupervisor.HostSupervisor;
              return Stream.zipLatest(
                SubscriptionRef.changes(supervisor.state),
                SubscriptionRef.changes(supervisor.session),
              ).pipe(
                Stream.map(([state, session]) => readinessOf(hostId, state, session)),
                Stream.changesWith(sameReadiness),
              );
            }),
          ),
        ),
      )
      .pipe(Atom.withLabel(`environment-readiness:${hostId}`)),
  );

const DEFAULT_STALE_TIME_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

/** Atoms are cached per key; the key is the JSON of the target, so equal inputs share one atom. */
const keyedFamily = <Input, T extends object>(make: (target: HostTarget<Input>) => T) => {
  const targets = new Map<string, HostTarget<Input>>();
  const family = Atom.family((key: string) => make(targets.get(key)!));
  return (target: HostTarget<Input>): T => {
    const key = hostRpcKey(target);
    if (!targets.has(key)) targets.set(key, target);
    return family(key);
  };
};

export function createHostQueryAtomFamily<R, ER, Input, A, E>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly concurrency?: AtomActionConcurrency<unknown>;
    readonly scheduler?: AtomActionScheduler;
    readonly refreshTrigger?: (target: HostTarget<Input>) => Atom.Atom<unknown> | undefined;
    readonly refreshIntervalMs?: number;
    readonly idleTtlMs?: number;
    readonly staleTimeMs?: number;
    readonly execute: (input: Input) => Effect.Effect<A, E, R | HostSupervisor.HostSupervisor>;
    readonly label: string;
  },
): (
  target: HostTarget<Input>,
) => Atom.Atom<
  AsyncResult.AsyncResult<
    A,
    E | ER | HostNotRegisteredError | HostRpcUnavailableError | LinkAttemptError
  >
> {
  const readiness = readinessFamily(runtime);

  return keyedFamily((target: HostTarget<Input>) => {
    const key = hostRpcKey(target);
    // The readiness atom re-runs this query whenever the connection changes.
    let atom: Atom.Atom<AsyncResult.AsyncResult<any, any>> = runtime.atom((get) =>
      Effect.gen(function* () {
        const state = yield* get.result(readiness(target.hostId));
        switch (state._tag) {
          case "Pending":
            // Never completes: the UI keeps showing "loading" (or the last value) while reconnecting.
            return yield* Effect.never;
          case "Unavailable":
            return yield* Effect.fail(state.failure);
          case "Ready": {
            const registry = yield* HostRegistry;
            return yield* registry.run(target.hostId, options.execute(target.input));
          }
        }
      }),
    ) as never;

    atom = atom.pipe(
      Atom.swr({
        staleTime: options.staleTimeMs ?? DEFAULT_STALE_TIME_MS,
        revalidateOnMount: true,
      }),
      Atom.setIdleTTL(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS),
    ) as never;
    if (options.refreshIntervalMs !== undefined) {
      atom = atom.pipe(Atom.withRefresh(options.refreshIntervalMs)) as never;
    }
    const trigger = options.refreshTrigger?.(target);
    if (trigger !== undefined) atom = atom.pipe(Atom.makeRefreshOnSignal(trigger)) as never;
    return atom.pipe(Atom.withLabel(`${options.label}:${key}`)) as never;
  });
}

export function createHostSubscriptionAtomFamily<R, ER, Input, A, E>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly label: string;
    readonly subscribe: (input: Input) => Stream.Stream<A, E, R | HostSupervisor.HostSupervisor>;
    readonly idleTtlMs?: number;
  },
): (target: HostTarget<Input>) => Atom.Atom<AsyncResult.AsyncResult<A, E | ER>> {
  return keyedFamily((target: HostTarget<Input>) =>
    runtime
      .atom(followStreamInHost(target.hostId, options.subscribe(target.input)) as never)
      .pipe(
        Atom.setIdleTTL(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS),
        Atom.withLabel(`${options.label}:${hostRpcKey(target)}`),
      ),
  ) as never;
}

export function createHostCommand<R, ER, Input, A, E>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly concurrency?: AtomActionConcurrency<HostTarget<Input>>;
    readonly scheduler?: AtomActionScheduler;
    readonly execute: (
      input: Input,
      registry: Registry,
      hostId: HostId,
    ) => Effect.Effect<A, E, R | HostSupervisor.HostSupervisor | AtomRegistry.AtomRegistry>;
    readonly label: string;
  },
): AtomCommand<HostTarget<Input>, A, E | ER | HostNotRegisteredError> {
  return createRuntimeCommand(runtime, {
    ...whenSet("scheduler", options.scheduler),
    ...whenSet("concurrency", options.concurrency),
    label: options.label,
    execute: (target: HostTarget<Input>, registry) =>
      Effect.gen(function* () {
        const hosts = yield* HostRegistry;
        return yield* hosts.run(
          target.hostId,
          options.execute(target.input, registry, target.hostId),
        );
      }),
  }) as never;
}

export function createHostRpcQueryAtomFamily<
  R,
  ER,
  T extends HostUnaryRpcTag,
  A = HostRpcSuccess<T>,
  E = HostRpcFailure<T> | HostRpcUnavailableError,
>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly refreshTrigger?: (
      target: HostTarget<HostRpcInput<T>>,
    ) => Atom.Atom<unknown> | undefined;
    readonly refreshIntervalMs?: number;
    readonly idleTtlMs?: number;
    readonly staleTimeMs?: number;
    readonly execute?: (
      input: HostRpcInput<T>,
    ) => Effect.Effect<A, E, R | HostSupervisor.HostSupervisor>;
    readonly tag: T;
    readonly label: string;
  },
) {
  return createHostQueryAtomFamily<R, ER, HostRpcInput<T>, A, E>(runtime, {
    label: options.label,
    execute:
      options.execute ??
      ((input) =>
        request(options.tag, input) as unknown as Effect.Effect<
          A,
          E,
          HostSupervisor.HostSupervisor
        >),
    ...whenSet("staleTimeMs", options.staleTimeMs),
    ...whenSet("idleTtlMs", options.idleTtlMs),
    ...whenSet("refreshIntervalMs", options.refreshIntervalMs),
    ...whenSet("refreshTrigger", options.refreshTrigger),
  });
}

export function createHostRpcSubscriptionAtomFamily<
  R,
  ER,
  T extends HostSubscriptionRpcTag,
  A = HostRpcStreamValue<T>,
>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly label: string;
    readonly tag: T;
    readonly idleTtlMs?: number;
    /** Recovery for the durable subscription (retry/backoff on failures and defects). */
    readonly subscription?: SubscriptionOptions<T>;
    /** Folds the raw event stream into the value the atom exposes. */
    readonly transform?: (
      stream: Stream.Stream<
        HostRpcStreamValue<T>,
        HostRpcStreamFailure<T>,
        HostSupervisor.HostSupervisor
      >,
    ) => Stream.Stream<A, HostRpcStreamFailure<T>, HostSupervisor.HostSupervisor>;
  },
) {
  return createHostSubscriptionAtomFamily<R, ER, HostRpcInput<T>, A, HostRpcStreamFailure<T>>(
    runtime,
    {
      label: options.label,
      subscribe: (input) => {
        const stream = subscribe(options.tag, input, options.subscription);
        return (
          options.transform === undefined ? stream : options.transform(stream)
        ) as Stream.Stream<A, HostRpcStreamFailure<T>, HostSupervisor.HostSupervisor>;
      },
      ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    },
  );
}

export function createHostRpcCommand<
  R,
  ER,
  T extends HostUnaryRpcTag,
  A = HostRpcSuccess<T>,
  E = HostRpcFailure<T> | HostRpcUnavailableError,
>(
  runtime: HostRuntime<R, ER>,
  options: {
    readonly label: string;
    readonly tag: T;
    readonly execute?: (
      input: HostRpcInput<T>,
    ) => Effect.Effect<A, E, R | HostSupervisor.HostSupervisor | AtomRegistry.AtomRegistry>;
    readonly scheduler?: AtomActionScheduler;
    readonly concurrency?: AtomActionConcurrency<HostTarget<HostRpcInput<T>>>;
    readonly onSuccess?: (
      target: HostTarget<HostRpcInput<T>>,
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<void>;
    readonly onSettled?: (
      target: HostTarget<HostRpcInput<T>>,
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<void>;
  },
) {
  // The target is not visible to `createHostCommand`'s executor, so thread it through a closure.
  return createRuntimeCommand(runtime, {
    ...whenSet("scheduler", options.scheduler),
    ...whenSet("concurrency", options.concurrency),
    label: options.label,
    execute: (target: HostTarget<HostRpcInput<T>>, registry) =>
      Effect.gen(function* () {
        const hosts = yield* HostRegistry;
        const call =
          options.execute?.(target.input) ??
          (request(options.tag, target.input) as unknown as Effect.Effect<
            A,
            E,
            HostSupervisor.HostSupervisor
          >);
        const run = hosts.run(target.hostId, call);
        const withSuccess =
          options.onSuccess === undefined
            ? run
            : run.pipe(Effect.tap(() => options.onSuccess!(target, registry)));
        return yield* options.onSettled === undefined
          ? withSuccess
          : Effect.ensuring(withSuccess, options.onSettled(target, registry));
      }),
  }) as unknown as AtomCommand<HostTarget<HostRpcInput<T>>, A, E | ER | HostNotRegisteredError>;
}

import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";

import { errorLogFields } from "../failures/logFields.ts";
import type { RpcSession } from "../wire/session.ts";
import type { LinkCatalogEntry } from "./catalog.ts";
import { Connectivity } from "./connectivity.ts";
import { LinkDriver, type HostLinkLease } from "./driver.ts";
import {
  type SupervisorLinkState,
  type PreparedLink,
  type NetworkStatus,
  type LinkTarget,
  type LinkAttemptError,
  LinkTransientError,
  AVAILABLE_LINK_STATE,
} from "./model.ts";
import { isApplicationActiveWakeup, LinkWakeups, type LinkWakeup } from "./wakeups.ts";

export interface HostSupervisorOptions {
  readonly initiallyDesired?: boolean;
}

export class HostSupervisor extends Context.Service<
  HostSupervisor,
  {
    readonly target: LinkTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorLinkState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedLink>>;
    readonly retryNow: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly connect: Effect.Effect<void>;
  }
>()("@kora/client-runtime/link/supervisor/HostSupervisor") {}

// Delays between attempts, by consecutive failure; the last rung repeats.
const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
const ESTABLISH_TIMEOUT = Duration.seconds(15);
const PROBE_TIMEOUT = Duration.seconds(15);
const MOBILE_PROBE_TIMEOUT = Duration.seconds(3);
// A link that stayed up this long starts the ladder over when it eventually fails.
const STABLE_CONNECTION_MS = 30_000;

type Signal =
  | { readonly _tag: "Wakeup"; readonly reason: LinkWakeup }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "ConnectRequested" };

interface Intent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

/** How one attempt ended. */
type AttemptOutcome =
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean; readonly established: boolean }
  | {
      readonly _tag: "Failed";
      readonly error: LinkAttemptError;
      readonly established: boolean;
      readonly uptimeMs: number;
    };

/** A reason to stop waiting on or holding a link, found while watching the signal queue. */
type StopReason = { readonly resetRetry: boolean };

export const make = Effect.fn("HostSupervisor.make")(function* (
  entry: LinkCatalogEntry,
  options: HostSupervisorOptions = {},
) {
  const connectivity = yield* Connectivity;
  const driver = yield* LinkDriver;
  const wakeups = yield* LinkWakeups;
  const scope = yield* Scope.Scope;

  const target = entry.target;
  const label = target.label;
  yield* Effect.annotateCurrentSpan({
    "environment.id": target.hostId,
    "environment.label": label,
    "target.kind": target._tag,
  });

  const initialNetwork = yield* connectivity.status;
  const intent = yield* Ref.make<Intent>({
    desired: options.initiallyDesired ?? false,
    network: initialNetwork,
  });
  const signals = yield* Queue.unbounded<Signal>();
  // Both flags are read and cleared by the main loop; see `wakeProbeFailed` below.
  const resetRetryRequested = yield* Ref.make(false);
  const wakeProbeFailed = yield* Ref.make(false);

  const initialState = (): SupervisorLinkState => {
    const desired = options.initiallyDesired ?? false;
    if (!desired) return { ...AVAILABLE_LINK_STATE, network: initialNetwork };
    if (initialNetwork === "offline") {
      return {
        ...AVAILABLE_LINK_STATE,
        desired,
        network: initialNetwork,
        phase: "offline",
        attempt: 1,
      };
    }
    return {
      ...AVAILABLE_LINK_STATE,
      desired,
      network: initialNetwork,
      phase: "connecting",
      stage: "preparing",
      attempt: 1,
    };
  };
  const state = yield* SubscriptionRef.make(initialState());
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedLink>>(Option.none());

  const publish = (patch: Partial<SupervisorLinkState>) =>
    Effect.gen(function* () {
      const { desired, network } = yield* Ref.get(intent);
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        desired,
        network,
        stage: null,
        retryAt: null,
        ...patch,
      }));
    });

  const clearLease = SubscriptionRef.set(session, Option.none()).pipe(
    Effect.andThen(SubscriptionRef.set(prepared, Option.none())),
    Effect.asVoid,
  );

  const send = (signal: Signal) => Queue.offer(signals, signal).pipe(Effect.asVoid);

  // -- intent from the outside ------------------------------------------------
  const connect = Ref.update(intent, (current) => ({ ...current, desired: true })).pipe(
    Effect.andThen(send({ _tag: "ConnectRequested" })),
    Effect.withSpan("HostSupervisor.connect"),
  );
  const disconnect = Ref.update(intent, (current) => ({ ...current, desired: false })).pipe(
    Effect.andThen(send({ _tag: "DisconnectRequested" })),
    Effect.withSpan("HostSupervisor.disconnect"),
  );
  const retryNow = Ref.set(resetRetryRequested, true).pipe(
    Effect.andThen(send({ _tag: "RetryRequested" })),
    Effect.withSpan("HostSupervisor.retryNow"),
  );

  // Network changes update the intent first and only signal when the status really changed.
  const noteNetwork = (network: NetworkStatus) =>
    Ref.modify(intent, (current) =>
      current.network !== network
        ? ([true, { ...current, network }] as const)
        : ([false, current] as const),
    ).pipe(
      Effect.flatMap((changed) =>
        changed ? send({ _tag: "NetworkChanged", network }) : Effect.void,
      ),
    );
  yield* connectivity.changes.pipe(Stream.runForEach(noteNetwork), Effect.forkScoped);
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => send({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );

  const isOffline = Ref.get(intent).pipe(Effect.map((current) => current.network === "offline"));

  /** Does this signal, seen while a link is being set up or held, end it? */
  const stopsLink = (signal: Signal): Effect.Effect<Option.Option<StopReason>> => {
    switch (signal._tag) {
      case "DisconnectRequested":
      case "RetryRequested":
        return Effect.succeed(Option.some({ resetRetry: false }));
      case "NetworkChanged":
        return Effect.succeed(
          signal.network === "offline" ? Option.some({ resetRetry: false }) : Option.none(),
        );
      case "Wakeup":
        // Mobile OSes suspend sockets without a close event, so a long resume replaces the link.
        return Effect.succeed(
          signal.reason === "application-active-reconnect"
            ? Option.some({ resetRetry: true })
            : Option.none(),
        );
      case "ConnectRequested":
        return Effect.succeed(Option.none());
    }
  };

  /** Wait until some signal says the link must go. */
  const awaitStop: Effect.Effect<StopReason> = Effect.gen(function* () {
    while (true) {
      const stop = yield* stopsLink(yield* Queue.take(signals));
      if (Option.isSome(stop)) return stop.value;
    }
  });

  // -- one connection attempt ---------------------------------------------------
  const connectWithProgress = (
    attemptGeneration: number,
    attempt: number,
    lastFailure: LinkAttemptError | null,
  ) =>
    driver
      .connect(entry, (progress) =>
        progress.stage === "preparing"
          ? publish({
              phase: "connecting",
              stage: "preparing",
              attempt,
              generation: attemptGeneration - 1,
              lastFailure,
            })
          : SubscriptionRef.set(prepared, Option.some(progress.prepared)).pipe(
              Effect.andThen(
                publish({
                  phase: "connecting",
                  stage: progress.stage,
                  attempt,
                  generation: attemptGeneration - 1,
                  lastFailure,
                }),
              ),
            ),
      )
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const typed = Cause.findErrorOption(cause);
          if (Option.isSome(typed)) return Effect.fail(typed.value);
          return Effect.logError("Connection attempt failed with an unexpected defect.", {
            "environment.id": target.hostId,
            "environment.label": label,
            reasons: cause.reasons.length,
            ...errorLogFields(Cause.squash(cause)),
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new LinkTransientError({
                  reason: "transport",
                  detail: `${label} connection failed unexpectedly.`,
                }),
              ),
            ),
          );
        }),
      );

  const setupTimeout = Effect.sleep(ESTABLISH_TIMEOUT).pipe(
    Effect.andThen(
      Effect.fail(
        new LinkTransientError({
          reason: "timeout",
          detail: `${label} did not respond during connection setup.`,
        }),
      ),
    ),
  );

  /** Probe the held link on a foreground wakeup, while still honouring signals that end it. */
  const probeLease = (lease: HostLinkLease, timeout: Duration.Duration) =>
    lease.session.probe.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new LinkTransientError({
              reason: "timeout",
              detail: `${label} did not respond to a connection health check.`,
            }),
          ),
      }),
    );

  type MonitorResult =
    | { readonly _tag: "Stopped"; readonly resetRetry: boolean }
    | { readonly _tag: "Failed"; readonly error: LinkAttemptError };

  const monitorLease = (lease: HostLinkLease): Effect.Effect<MonitorResult> =>
    Effect.gen(function* () {
      while (true) {
        const signal = yield* Queue.take(signals);
        const stop = yield* stopsLink(signal);
        if (Option.isSome(stop))
          return { _tag: "Stopped", resetRetry: stop.value.resetRetry } as const;
        if (signal._tag !== "Wakeup") continue;
        if (signal.reason !== "application-active" && signal.reason !== "application-active-probe")
          continue;

        const timeout =
          signal.reason === "application-active-probe" ? MOBILE_PROBE_TIMEOUT : PROBE_TIMEOUT;
        const probed = yield* Effect.raceFirst(
          probeLease(lease, timeout).pipe(
            Effect.result,
            Effect.map((result) => ({ _tag: "Probed", result }) as const),
          ),
          awaitStop.pipe(Effect.map((reason) => ({ _tag: "Stopped", reason }) as const)),
        );
        if (probed._tag === "Stopped") {
          return { _tag: "Stopped", resetRetry: probed.reason.resetRetry } as const;
        }
        if (probed.result._tag === "Failure") {
          // The user came back to a dead transport: reconnect now, without waiting out a backoff.
          yield* Ref.set(wakeProbeFailed, true);
          return { _tag: "Failed", error: probed.result.failure } as const;
        }
      }
    });

  const runAttempt = (
    attempt: number,
    attemptGeneration: number,
    lastFailure: LinkAttemptError | null,
  ): Effect.Effect<AttemptOutcome> =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptScope = yield* Scope.Scope;
        yield* SubscriptionRef.set(prepared, Option.none());
        yield* publish({
          phase: "connecting",
          stage: "preparing",
          attempt,
          generation: attemptGeneration - 1,
          lastFailure,
        });

        type Establishing =
          | { readonly _tag: "Connected"; readonly lease: HostLinkLease }
          | { readonly _tag: "Stopped"; readonly reason: StopReason };
        const establishing = yield* Effect.exit(
          Effect.raceFirst(
            connectWithProgress(attemptGeneration, attempt, lastFailure).pipe(
              Effect.provideService(Scope.Scope, attemptScope),
              Effect.map((lease): Establishing => ({ _tag: "Connected", lease })),
            ),
            Effect.raceFirst(
              awaitStop.pipe(Effect.map((reason): Establishing => ({ _tag: "Stopped", reason }))),
              setupTimeout,
            ),
          ),
        );

        const clear = clearLease;
        if (establishing._tag === "Failure") {
          yield* clear;
          if (Cause.hasInterruptsOnly(establishing.cause)) {
            return { _tag: "Interrupted", resetRetry: false, established: false } as const;
          }
          const error = Option.getOrElse(
            Cause.findErrorOption(establishing.cause),
            () =>
              new LinkTransientError({
                reason: "transport",
                detail: `${label} connection failed unexpectedly.`,
              }) as LinkAttemptError,
          );
          return { _tag: "Failed", error, established: false, uptimeMs: 0 } as const;
        }

        const outcome = establishing.value;
        if (outcome._tag === "Stopped") {
          yield* clear;
          return {
            _tag: "Interrupted",
            resetRetry: outcome.reason.resetRetry,
            established: false,
          } as const;
        }

        // Intent may have changed while the link was being established.
        const current = yield* Ref.get(intent);
        if (!current.desired || current.network === "offline") {
          yield* clear;
          return { _tag: "Interrupted", resetRetry: false, established: false } as const;
        }

        const lease = outcome.lease;
        yield* SubscriptionRef.set(prepared, Option.some(lease.prepared));
        yield* SubscriptionRef.set(session, Option.some(lease.session));
        yield* publish({
          phase: "connected",
          attempt,
          generation: attemptGeneration,
          lastFailure: null,
        });
        const connectedAt = yield* Clock.currentTimeMillis;

        const held = yield* Effect.raceFirst(
          lease.session.closed.pipe(
            Effect.flip,
            Effect.map((error) => ({ _tag: "Failed", error }) as MonitorResult),
          ),
          monitorLease(lease),
        );
        const uptimeMs = (yield* Clock.currentTimeMillis) - connectedAt;
        yield* clear;
        return held._tag === "Stopped"
          ? ({ _tag: "Interrupted", resetRetry: held.resetRetry, established: true } as const)
          : ({ _tag: "Failed", error: held.error, established: true, uptimeMs } as const);
      }),
    );

  // -- the main loop ------------------------------------------------------------
  const run = Effect.gen(function* () {
    let failureCount = 0;
    let generation = 0;
    let lastFailure: LinkAttemptError | null = null;

    const resetLadder = () => {
      failureCount = 0;
      lastFailure = null;
    };
    const idleWait = Effect.gen(function* () {
      const signal = yield* Queue.take(signals);
      if (signal._tag === "Wakeup" && isApplicationActiveWakeup(signal.reason)) resetLadder();
    });

    while (true) {
      if (yield* Ref.getAndSet(resetRetryRequested, false)) resetLadder();

      const { desired, network } = yield* Ref.get(intent);
      if (!desired) {
        resetLadder();
        yield* clearLease;
        yield* publish({ phase: "available", attempt: 0, generation, lastFailure: null });
        yield* idleWait;
        continue;
      }
      if (network === "offline") {
        yield* clearLease;
        yield* publish({ phase: "offline", attempt: failureCount + 1, generation, lastFailure });
        yield* idleWait;
        continue;
      }

      const attempt = failureCount + 1;
      const outcome: AttemptOutcome = yield* runAttempt(attempt, generation + 1, lastFailure);
      const probeFailed = yield* Ref.getAndSet(wakeProbeFailed, false);
      if (outcome.established) generation += 1;

      if (outcome._tag === "Interrupted") {
        if (outcome.resetRetry) resetLadder();
        continue;
      }

      if (outcome.established && outcome.uptimeMs >= STABLE_CONNECTION_MS) resetLadder();
      lastFailure = outcome.error;

      if (outcome.error._tag === "LinkBlockedError") {
        yield* publish({ phase: "blocked", attempt, generation, lastFailure });
        yield* idleWait;
        continue;
      }

      if (probeFailed) {
        // The first reconnect after a failed wake probe skips the ladder.
        failureCount = 0;
        continue;
      }

      failureCount += 1;
      const delayMs = RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length) - 1]!;
      const now = yield* Clock.currentTimeMillis;
      yield* publish({
        phase: "backoff",
        attempt: failureCount,
        generation,
        lastFailure,
        retryAt: now + delayMs,
      });
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(delayMs)), idleWait);
    }
  });

  yield* run.pipe(Effect.forkScoped);
  yield* Scope.addFinalizer(
    scope,
    Effect.all([Queue.shutdown(signals), clearLease], { discard: true }),
  );

  return HostSupervisor.of({ target, state, session, prepared, connect, disconnect, retryNow });
});

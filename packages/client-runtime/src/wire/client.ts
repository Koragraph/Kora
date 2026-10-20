import { CHAT_METHODS, RPC_METHODS } from "@kora/contracts";
import * as Cause from "effect/Cause";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";

import * as HostSupervisor from "../link/supervisor.ts";
import type { KoraRpcClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";

export class HostRpcUnavailableError extends Schema.TaggedError<HostRpcUnavailableError>()(
  "HostRpcUnavailableError",
  { hostId: Schema.String, message: Schema.String },
) {}

export interface HostRpcRequestObservation {
  readonly hostId: string;
  readonly method: string;
}

/** Lets a platform watch RPC traffic: `observe` returns the effect to run when the request ends. */
export class HostRpcRequestObserver extends Context.Reference<{
  observe(request: HostRpcRequestObservation): Effect.Effect<Effect.Effect<void>>;
}>("@kora/client-runtime/rpc/HostRpcRequestObserver", {
  defaultValue: () => ({ observe: () => Effect.succeed(Effect.void) }),
}) {}

export type HostRpcTag = keyof KoraRpcClient & string;

export type HostSubscriptionRpcTag =
  | typeof CHAT_METHODS.subscribeThreads
  | typeof CHAT_METHODS.subscribeThread
  | typeof RPC_METHODS.subscribeDaemonConfig
  | typeof RPC_METHODS.subscribeDaemonLifecycle
  | typeof RPC_METHODS.ptyWatchMeta
  | typeof RPC_METHODS.fleetSubscribe
  | typeof RPC_METHODS.fleetSubscribeWorker
  | typeof RPC_METHODS.swarmSubscribe
  | typeof RPC_METHODS.blobsSubscribe
  | typeof RPC_METHODS.blobsRoutinesSubscribe
  | typeof RPC_METHODS.blobsGroupsSubscribe
  | typeof RPC_METHODS.browserWatch
  | typeof RPC_METHODS.ptyAttach;
export type HostStreamRpcTag = HostSubscriptionRpcTag;
export type HostUnaryRpcTag = Exclude<HostRpcTag, HostStreamRpcTag>;

export interface HostRpcSubscriptionObservation {
  readonly hostId: string;
  readonly method: HostSubscriptionRpcTag;
  readonly input: unknown;
}

class HostRpcSubscriptionObserver extends Context.Reference<{
  observe(request: HostRpcSubscriptionObservation): Effect.Effect<Effect.Effect<void>>;
}>("@kora/client-runtime/rpc/HostRpcSubscriptionObserver", {
  defaultValue: () => ({ observe: () => Effect.succeed(Effect.void) }),
}) {}

type MethodOf<T extends HostRpcTag> = KoraRpcClient[T];
type MethodResult<T extends HostRpcTag> =
  MethodOf<T> extends (...args: any[]) => infer R ? R : never;

export type HostRpcInput<T extends HostRpcTag> =
  MethodOf<T> extends (input: infer I, ...rest: any[]) => unknown ? I : never;
export type HostRpcSuccess<T extends HostUnaryRpcTag> =
  MethodResult<T> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;
export type HostRpcFailure<T extends HostUnaryRpcTag> =
  MethodResult<T> extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;
// Streaming methods are overloaded on `asQueue`; the plain call is the stream branch.
type StreamResult<T extends HostRpcTag> = Extract<MethodResult<T>, Stream.Stream<any, any, any>>;
export type HostRpcStreamValue<T extends HostStreamRpcTag> =
  StreamResult<T> extends Stream.Stream<infer A, infer _E, infer _R> ? A : never;
export type HostRpcStreamFailure<T extends HostStreamRpcTag> =
  StreamResult<T> extends Stream.Stream<infer _A, infer E, infer _R> ? E : never;

export interface SubscriptionOptions<T extends HostSubscriptionRpcTag> {
  /** Only reports a defect; recovery is unchanged. */
  readonly onDefect?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
  readonly onExpectedFailure?: (cause: Cause.Cause<HostRpcStreamFailure<T>>) => Effect.Effect<void>;
  /**
   * Re-subscribe on the same session after an expected failure. This is the first delay; each
   * further failure in a row doubles it, up to `retryMaxDelay`. A value received resets it.
   * Authorization failures are never retried on the same session.
   */
  readonly retryExpectedFailureAfter?: Duration.Input;
  /**
   * Re-subscribe on the same session after a defect (after `onDefect`), with the same backoff,
   * instead of failing the whole stream. Without it a defect ends the subscription for good.
   */
  readonly retryDefectAfter?: Duration.Input;
  /** Cap for the doubling retry delays. Defaults to 30 seconds. */
  readonly retryMaxDelay?: Duration.Input;
  /** Each emission re-reads the current session and re-subscribes (e.g. the app came to the foreground). */
  readonly resubscribe?: Stream.Stream<unknown, never>;
}

type LooseClient = Record<string, (input: unknown) => unknown>;

const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** `base` doubled once per earlier failure in a row, capped at `max`. */
export const retryDelayMillis = (
  base: Duration.Input,
  failuresInARow: number,
  max: Duration.Input = DEFAULT_RETRY_MAX_DELAY_MS,
): number => {
  const cap = Duration.toMillis(max);
  const exponent = Math.min(Math.max(failuresInARow - 1, 0), 30);
  return Math.min(Duration.toMillis(base) * 2 ** exponent, cap);
};

const optionOf = <A>(value: Option.Option<A>) => value;

export const request = Effect.fn("HostRpc.request")(function* <T extends HostUnaryRpcTag>(
  tag: T,
  input: HostRpcInput<T>,
) {
  const supervisor = yield* HostSupervisor.HostSupervisor;
  const hostId = supervisor.target.hostId;
  yield* Effect.annotateCurrentSpan({ "environment.id": hostId, "rpc.method": tag });

  const current = optionOf(yield* SubscriptionRef.get(supervisor.session));
  if (Option.isNone(current)) {
    return yield* Effect.fail(
      new HostRpcUnavailableError({
        hostId,
        message: `${supervisor.target.label} is not connected.`,
      }),
    );
  }
  const observer = yield* HostRpcRequestObserver;
  const complete = yield* observer.observe({ hostId, method: tag });
  const call = (current.value.client as unknown as LooseClient)[tag]!(input) as Effect.Effect<
    HostRpcSuccess<T>,
    HostRpcFailure<T>
  >;
  return yield* Effect.ensuring(call, complete);
});

// ---------------------------------------------------------------------------
// Durable subscriptions
// ---------------------------------------------------------------------------

type ReasonLike = { readonly _tag: string; readonly error?: unknown; readonly defect?: unknown };

const reasonsOf = (cause: Cause.Cause<unknown>): ReadonlyArray<ReasonLike> =>
  cause.reasons as unknown as ReadonlyArray<ReasonLike>;

const isRpcClientError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "RpcClientError";

const isAuthorizationError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "HostAuthorizationError";

const isRpcClientDefectError = (error: unknown): boolean =>
  isRpcClientError(error) &&
  (error as { reason?: { _tag?: unknown } }).reason?._tag === "RpcClientDefect";

export function subscribeDynamicWithSession<T extends HostSubscriptionRpcTag>(
  tag: T,
  makeInput: (session: RpcSession) => Effect.Effect<HostRpcInput<T>>,
  options?: SubscriptionOptions<T>,
): Stream.Stream<
  readonly [RpcSession, HostRpcStreamValue<T>],
  HostRpcStreamFailure<T>,
  HostSupervisor.HostSupervisor
> {
  type Value = readonly [RpcSession, HostRpcStreamValue<T>];

  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* HostSupervisor.HostSupervisor;
      const hostId = supervisor.target.hostId;
      const observer = yield* HostRpcSubscriptionObserver;

      /** One subscription attempt on one session. The input is recomputed each time so resume cursors are fresh. */
      const attempt = (session: RpcSession): Stream.Stream<Value, HostRpcStreamFailure<T>> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Recomputed per attempt so a resume cursor is always current.
            const freshInput = yield* makeInput(session);
            const input = freshInput;
            const complete = yield* observer.observe({ input, hostId, method: tag });
            const source: Stream.Stream<HostRpcStreamValue<T>, HostRpcStreamFailure<T>> = tag ===
            RPC_METHODS.subscribeDaemonConfig
              ? (session.subscribeDaemonConfig(input as never) as never)
              : ((session.client as unknown as LooseClient)[tag]!(input) as never);
            // Tag each value with the session that produced it, at emission time: a value
            // buffered across a session switch must not be attributed to the next session.
            return source.pipe(
              Stream.map((value): Value => [session, value]),
              Stream.ensuring(complete),
            );
          }),
        );

      /** Failures in a row on one session; the first value received resets it. */
      type Streak = { failures: number };

      const retryLater = (
        session: RpcSession,
        streak: Streak,
        base: Duration.Input,
      ): Stream.Stream<Value, HostRpcStreamFailure<T>> => {
        streak.failures += 1;
        const delay = retryDelayMillis(base, streak.failures, options?.retryMaxDelay);
        return Stream.unwrap(Effect.sleep(delay).pipe(Effect.as(guarded(session, streak))));
      };

      const recover = (
        session: RpcSession,
        streak: Streak,
        cause: Cause.Cause<HostRpcStreamFailure<T>>,
      ): Stream.Stream<Value, HostRpcStreamFailure<T>> => {
        if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause);
        const reasons = reasonsOf(cause);

        const report =
          options?.onDefect !== undefined &&
          reasons.some(
            (reason) =>
              reason._tag === "Die" ||
              (reason._tag === "Fail" && isRpcClientDefectError(reason.error)),
          )
            ? Stream.fromEffect(options.onDefect(cause)).pipe(Stream.drain)
            : Stream.empty;
        const rethrow = Stream.concat(report, Stream.failCause(cause));

        if (!reasons.every((reason) => reason._tag === "Fail")) {
          // A defect. Either keep the subscription alive with backoff, or fail it for good.
          if (options?.retryDefectAfter === undefined) return rethrow;
          return Stream.concat(
            report,
            Stream.concat(
              Stream.fromEffect(
                Effect.logWarning("Durable RPC subscription hit a defect; retrying.", {
                  hostId,
                  method: tag,
                  cause: Cause.pretty(cause),
                }),
              ).pipe(Stream.drain),
              retryLater(session, streak, options.retryDefectAfter),
            ),
          );
        }

        // A transport failure: the next session replaces this one, so wait for it.
        if (reasons.every((reason) => isRpcClientError(reason.error))) {
          return Stream.concat(
            report,
            Stream.fromEffect(
              Effect.logWarning(
                "Durable RPC subscription lost its transport; waiting for the next session.",
                {
                  hostId,
                  method: tag,
                  cause: Cause.pretty(cause),
                },
              ),
            ).pipe(Stream.drain),
          );
        }

        const onExpected = options?.onExpectedFailure;
        if (onExpected === undefined) return rethrow;
        const handled = Stream.fromEffect(onExpected(cause)).pipe(Stream.drain);
        if (options?.retryExpectedFailureAfter === undefined) return handled;
        // Retrying the same session cannot fix an authorization failure; wait for the next one.
        if (reasons.some((reason) => isAuthorizationError(reason.error))) return handled;
        return Stream.concat(
          handled,
          retryLater(session, streak, options.retryExpectedFailureAfter),
        );
      };

      const guarded = (
        session: RpcSession,
        streak: Streak = { failures: 0 },
      ): Stream.Stream<Value, HostRpcStreamFailure<T>> =>
        attempt(session).pipe(
          Stream.map((value) => {
            streak.failures = 0;
            return value;
          }),
          Stream.catchCause((cause) => recover(session, streak, cause)),
        );

      // The current session whenever it changes, plus each external re-subscribe signal.
      const sessions = SubscriptionRef.changes(supervisor.session);
      const signals =
        options?.resubscribe === undefined
          ? sessions
          : Stream.merge(
              sessions,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );

      return signals.pipe(
        Stream.switchMap((session) =>
          Option.isNone(session) ? Stream.empty : guarded(session.value),
        ),
      );
    }),
  ).pipe(Stream.withSpan("HostRpc.subscribe", { attributes: { "rpc.method": tag } }));
}

export function subscribeDynamic<T extends HostSubscriptionRpcTag>(
  tag: T,
  makeInput: (session: RpcSession) => Effect.Effect<HostRpcInput<T>>,
  options?: SubscriptionOptions<T>,
): Stream.Stream<HostRpcStreamValue<T>, HostRpcStreamFailure<T>, HostSupervisor.HostSupervisor> {
  return subscribeDynamicWithSession(tag, makeInput, options).pipe(
    Stream.map(([, value]) => value),
  );
}

export function subscribe<T extends HostSubscriptionRpcTag>(
  tag: T,
  input: HostRpcInput<T>,
  options?: SubscriptionOptions<T>,
): Stream.Stream<HostRpcStreamValue<T>, HostRpcStreamFailure<T>, HostSupervisor.HostSupervisor> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

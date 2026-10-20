import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Schedule from "effect/Schedule";
import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";

interface ProbeFailureInfo {
  readonly cause: unknown;
  readonly attempt: number;
  readonly probeTimeoutMs: number;
  readonly requestUrl: string;
}

/** A log-safe description of a failure: tags, messages and nested causes, no raw objects. */
const describeCause = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    const tag = (cause as { _tag?: unknown })._tag;
    return {
      ...(typeof tag === "string" ? { _tag: tag } : { name: cause.name }),
      message: cause.message,
      ...(cause.cause === undefined ? {} : { cause: describeCause(cause.cause) }),
    };
  }
  if (typeof cause === "object" && cause !== null) {
    const record = cause as {
      _tag?: unknown;
      message?: unknown;
      reason?: unknown;
      cause?: unknown;
    };
    return {
      ...(record._tag === undefined ? {} : { _tag: record._tag }),
      ...(record.message === undefined ? {} : { message: record.message }),
      ...(record.reason === undefined ? {} : { reason: describeCause(record.reason) }),
      ...(record.cause === undefined ? {} : { cause: describeCause(record.cause) }),
    };
  }
  return cause;
};

/**
 * Poll `baseUrl + path` until it answers 2xx or `timeoutMs` passes. A hung request cannot
 * stall the loop (each probe has its own timeout), and the caller's own error type comes
 * from `makeError`.
 */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly makeError: (info: ProbeFailureInfo) => E;
  readonly probeTimeoutMs?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly path?: string;
  readonly baseUrl: string;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? 1_000;
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const attempts = yield* Ref.make(0);
  const lastFailure = yield* Ref.make<unknown>(undefined);
  // Errors the caller's factory produced must not be wrapped a second time.
  const made = new WeakSet<object>();
  const build = (cause: unknown, attempt: number): E => {
    const error = input.makeError({ requestUrl, probeTimeoutMs, attempt, cause });
    if (typeof error === "object" && error !== null) made.add(error);
    return error;
  };

  const baseFields = { baseUrl: input.baseUrl, requestUrl, timeoutMs, intervalMs, probeTimeoutMs };
  yield* Effect.logDebug("httpReadiness.start", baseFields);

  const probe = Effect.gen(function* () {
    const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
    const response = yield* client.execute(HttpClientRequest.get(requestUrl)).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(probeTimeoutMs),
        orElse: () =>
          Effect.fail(build({ kind: "probe-timeout", attempt, probeTimeoutMs }, attempt)),
      }),
      Effect.mapError((error) =>
        typeof error === "object" && error !== null && made.has(error)
          ? (error as E)
          : build(error, attempt),
      ),
      Effect.tapError((error) => Ref.set(lastFailure, { attempt, cause: describeCause(error) })),
    );
    // Drain the body so the connection is released.
    yield* response.text.pipe(Effect.ignore);
  });

  const retries = Math.max(0, Math.ceil(timeoutMs / intervalMs));
  yield* probe.pipe(
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(intervalMs)), times: retries }),
    Effect.timeoutOrElse({
      orElse: () =>
        Effect.gen(function* () {
          const failure = yield* Ref.get(lastFailure);
          const count = yield* Ref.get(attempts);
          yield* Effect.logWarning("httpReadiness.timedOut", {
            ...baseFields,
            attempts: count,
            lastFailure: failure,
          });
          return yield* Effect.fail(
            build(
              { kind: "overall-timeout", baseUrl: input.baseUrl, timeoutMs, lastFailure: failure },
              count,
            ),
          );
        }),
      duration: Duration.millis(timeoutMs),
    }),
  );

  yield* Effect.logDebug("httpReadiness.succeeded", {
    baseUrl: input.baseUrl,
    requestUrl,
    attempts: yield* Ref.get(attempts),
  });
});

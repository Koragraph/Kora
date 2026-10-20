import {
  HostScopeRequiredError,
  HostResourceNotFoundError,
  HostRequestInvalidError,
  HostOperationForbiddenError,
  HostInternalError,
  HostHttpCommonError,
  HostHttpApi,
  HostAuthInvalidError,
} from "@kora/contracts";
import { httpHeaderRedactionLayer } from "@kora/shared/httpTracing";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Data from "effect/Data";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export class RemoteHostAuthInvalidJsonError extends Data.TaggedError(
  "RemoteHostAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteHostAuthTimeoutError extends Data.TaggedError("RemoteHostAuthTimeoutError")<{
  readonly timeoutMs: number;
  readonly requestUrl: string;
  readonly message: string;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      timeoutMs,
      requestUrl,
      message:
        "Remote environment endpoint " + requestUrl + " timed out after " + timeoutMs + "ms.",
    });
  }
}

class RemoteHostAuthFetchError extends Data.TaggedError("RemoteHostAuthFetchError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class RemoteHostAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteHostAuthUndeclaredStatusError",
)<{
  readonly requestUrl: string;
  readonly status: number;
  readonly message: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      requestUrl,
      status,
      message: `Remote environment endpoint ${requestUrl} returned undeclared status ${status}.`,
    });
  }
}

export type RemoteHostRequestError =
  | HostRequestInvalidError
  | HostAuthInvalidError
  | HostScopeRequiredError
  | HostOperationForbiddenError
  | HostResourceNotFoundError
  | HostInternalError
  | RemoteHostAuthFetchError
  | RemoteHostAuthInvalidJsonError
  | RemoteHostAuthUndeclaredStatusError
  | RemoteHostAuthTimeoutError;

const isDeclaredApiError = Schema.is(HostHttpCommonError);

/** An HttpClient over the given fetch, with sensitive headers redacted from traces. */
export const remoteHttpClientLayer = (fetchFn: typeof fetch) =>
  Layer.mergeAll(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    httpHeaderRedactionLayer,
  );

// The endpoints in the API definition are absolute paths, so only the origin matters.
const apiBaseUrl = (httpBaseUrl: string): string => {
  return Object.assign(new URL(httpBaseUrl), { pathname: "/", search: "", hash: "" }).toString();
};

export const makeHostHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(HostHttpApi, { baseUrl: apiBaseUrl(httpBaseUrl) });

export const makeHostHttpApiGroupClient = <G extends keyof typeof HostHttpApi.groups>(
  httpBaseUrl: string,
  group: G,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* HttpApiClient.group(HostHttpApi, {
      group,
      httpClient,
      baseUrl: apiBaseUrl(httpBaseUrl),
    });
  });

const invalidResponse = (requestUrl: string, cause: unknown) =>
  new RemoteHostAuthInvalidJsonError({
    message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
    cause,
  });

const toRequestError = (requestUrl: string, error: unknown): RemoteHostRequestError => {
  if (error instanceof RemoteHostAuthTimeoutError) return error;
  if (isDeclaredApiError(error)) return error;
  if (Schema.isSchemaError(error)) return invalidResponse(requestUrl, error);
  if (HttpClientError.isHttpClientError(error) && error.response !== undefined) {
    const status = error.response.status;
    return status < 200 || status > 299
      ? new RemoteHostAuthUndeclaredStatusError(requestUrl, status)
      : invalidResponse(requestUrl, error);
  }
  return new RemoteHostAuthFetchError({
    message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(error)}).`,
    cause: error,
  });
};

/** Run one request with a deadline, folding every failure into `RemoteHostRequestError`. */
export const executeHostHttpRequest = <A, E, R>(
  url: string,
  deadlineMs: number,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteHostRequestError, R> =>
  Effect.mapError(
    Effect.timeoutOrElse(run, {
      duration: Duration.millis(deadlineMs),
      orElse: () => Effect.fail(new RemoteHostAuthTimeoutError(url, deadlineMs)),
    }),
    (error) => toRequestError(url, error),
  );

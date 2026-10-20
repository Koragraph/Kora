import * as Effect from "effect/Effect";
import { FetchHttpClient, type HttpMethod } from "effect/unstable/http";

import type { PreparedLink, PreparedHttpAuthorization } from "../link/model.ts";
import {
  type RemoteHostRequestError,
  RemoteHostAuthTimeoutError,
  makeHostHttpApiGroupClient,
  executeHostHttpRequest,
} from "../wire/http.ts";

export interface HostHttpAuthHeaders {
  readonly authorization?: string;
}

/**
 * With no bearer token the browser authenticates through the daemon's session cookie. A
 * cross-origin `fetch` does not send cookies by default, so those requests opt into credentialed
 * mode; bearer requests carry the token in a header instead.
 */
type MaybeAuthorization = PreparedHttpAuthorization | null;

const withHostCredentials = <A, E, R>(
  authorization: MaybeAuthorization,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization !== null
    ? request
    : request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }));

const hostAuthHeaders = (authorization: PreparedHttpAuthorization | null): HostHttpAuthHeaders =>
  authorization === null ? {} : { authorization: `Bearer ${authorization.token}` };

/** Runs one HTTP request against the daemon with the connection's credential. */
export const executeAuthenticatedHostHttpRequest = Effect.fn(
  "clientRuntime.state.executeAuthenticatedHostHttpRequest",
)(function* <Group extends Parameters<typeof makeHostHttpApiGroupClient>[1], A, E, R>(input: {
  readonly prepared: PreparedLink;
  readonly method: HttpMethod.HttpMethod;
  readonly url: (httpBaseUrl: string) => string;
  readonly group: Group;
  readonly timeoutMs: number;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeHostHttpApiGroupClient<Group>>>;
    readonly headers: HostHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<
  A,
  RemoteHostRequestError,
  Effect.Services<ReturnType<typeof makeHostHttpApiGroupClient<Group>>> | R
> {
  const httpBaseUrl = input.prepared.httpBaseUrl;
  const authorization = input.prepared.httpAuthorization;
  const requestUrl = input.url(httpBaseUrl);
  return yield* Effect.gen(function* () {
    const client = yield* makeHostHttpApiGroupClient(httpBaseUrl, input.group);
    return yield* executeHostHttpRequest(
      requestUrl,
      input.timeoutMs,
      withHostCredentials(
        authorization,
        input.request({ client, headers: hostAuthHeaders(authorization) }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () => Effect.fail(new RemoteHostAuthTimeoutError(requestUrl, input.timeoutMs)),
    }),
  );
});

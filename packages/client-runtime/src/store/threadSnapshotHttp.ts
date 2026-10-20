import {
  type ThreadId,
  type ChatThreadDetailSnapshot,
  HostResourceNotFoundError,
} from "@kora/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import type { HttpClient } from "effect/unstable/http";

import { hostEndpointUrl } from "../host/endpoint.ts";
import type { PreparedLink } from "../link/model.ts";
import type { RemoteHostRequestError } from "../wire/http.ts";
import { executeAuthenticatedHostHttpRequest } from "./hostHttpAuth.ts";

/** How much history to fetch: the newest `turnLimit` user turns, or older ones before a cursor. */
export type ThreadSnapshotWindow = { readonly beforeCursor?: string; readonly turnLimit: number };

export type FetchHostThreadSnapshotError = RemoteHostRequestError;

const isNotFound = Schema.is(HostResourceNotFoundError);

// Bounded so a slow endpoint never holds up the cheaper socket fallback.
const SNAPSHOT_TIMEOUT_MS = 6_000;

const fetchSnapshot = Effect.fn("clientRuntime.state.fetchHostThreadSnapshot")(function* (
  prepared: PreparedLink,
  threadId: ThreadId,
  window: ThreadSnapshotWindow | undefined,
) {
  const query: { turnLimit?: number; beforeCursor?: string } = {};
  if (window !== undefined) {
    query.turnLimit = window.turnLimit;
    if (window.beforeCursor !== undefined) query.beforeCursor = window.beforeCursor;
  }
  return yield* executeAuthenticatedHostHttpRequest({
    prepared,
    method: "GET",
    url: (httpBaseUrl) => hostEndpointUrl(httpBaseUrl, `/api/chat/threads/${threadId}`),
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    group: "chat",
    request: ({ client, headers }) =>
      client.threadSnapshot({ headers, params: { threadId }, query }),
  });
});

export class ThreadSnapshotFetcher extends Context.Service<
  ThreadSnapshotFetcher,
  {
    readonly load: (
      prepared: PreparedLink,
      threadId: ThreadId,
      window?: ThreadSnapshotWindow,
    ) => Effect.Effect<Option.Option<ChatThreadDetailSnapshot>>;
  }
>()("@kora/client-runtime/store/threadSnapshotHttp/ThreadSnapshotFetcher") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotFetcher,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotFetcher,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return {
      load: (prepared, threadId, window) =>
        fetchSnapshot(prepared, threadId, window).pipe(
          Effect.provideContext(context),
          Effect.map(Option.some),
          Effect.catchCause((cause) => {
            const notFound = Cause.findErrorOption(cause).pipe(
              Option.filter((error) => isNotFound(error)),
            );
            if (Option.isSome(notFound)) {
              return Effect.logDebug(
                "Thread snapshot not found over HTTP; deferring to the socket subscription.",
              ).pipe(Effect.annotateLogs({ threadId }), Effect.as(Option.none()));
            }
            return Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none()),
            );
          }),
        ),
    };
  }),
);

import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { remoteHttpClientLayer } from "@kora/client-runtime/wire";

import { resolvePrimaryHostHttpUrl } from "./target";
import {
  readVerifiedShellPrimaryBearerToken,
  isPrimaryHostUrl,
  invalidatePrimaryHostIdentity,
} from "./shellAuth";

/**
 * Whether the daemon's bearer may ride on this request. API-client calls reach this client
 * relative (the base URL is prepended afterwards), so relative URLs count as primary; an
 * absolute URL must share the primary origin.
 */
export function isPrimaryRequestUrl(address: string): boolean {
  if (address.startsWith("//")) return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(address)) return true;
  return isPrimaryHostUrl(address);
}

const withCredentials =
  (credentials: RequestCredentials): typeof fetch =>
  (resource, init) =>
    globalThis.fetch(resource, { ...init, credentials });

/** A page served by the daemon itself authenticates with its cookie, not a bearer. */
function isSameOriginBrowserPage(): boolean {
  if (typeof window === "undefined" || window.shellBridge) return false;
  if (!/^https?:\/\//.test(window.location.origin ?? "")) return false;
  try {
    return new URL(resolvePrimaryHostHttpUrl("/")).origin === window.location.origin;
  } catch {
    return false;
  }
}

const addBearer = (req: HttpClientRequest.HttpClientRequest) => {
  if (!isPrimaryRequestUrl(req.url)) return Effect.succeed(req);
  return Effect.tryPromise({
    try: () => readVerifiedShellPrimaryBearerToken(),
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: req,
          cause,
          description: "The Kora daemon could not prove its identity; nothing was sent.",
        }),
      }),
  }).pipe(Effect.map((tok) => (tok ? HttpClientRequest.bearerToken(req, tok) : req)));
};

export function makePrimaryHostHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      if (isSameOriginBrowserPage()) return remoteHttpClientLayer(withCredentials("include"));

      return Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(
            HttpClient.mapRequestEffect(addBearer),
            // A dead transport may mean the port changed hands: prove identity again next time.
            HttpClient.tapError((err) =>
              err._tag === "HttpClientError" && err.reason._tag === "TransportError"
                ? Effect.sync(invalidatePrimaryHostIdentity)
                : Effect.void,
            ),
          ),
        ),
      ).pipe(Layer.provide(remoteHttpClientLayer(withCredentials("omit"))));
    }),
  );
}

export const primaryHostHttpLayer = makePrimaryHostHttpLayer();

import type { AuthClientDisplayMetadata } from "@kora/contracts";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import { appendClientLinkParams } from "../auth/remote.ts";
import * as HostAuthorization from "../auth/service.ts";
import * as ClientCapabilities from "../embedder/presentation.ts";
import type { LinkCatalogEntry } from "./catalog.ts";
import type { PreparedLink, LocalLinkTarget } from "./model.ts";
import type { LinkAttemptError } from "./model.ts";

export class LinkResolver extends Context.Service<
  LinkResolver,
  {
    readonly prepare: (entry: LinkCatalogEntry) => Effect.Effect<PreparedLink, LinkAttemptError>;
  }
>()("@kora/client-runtime/link/resolver/LinkResolver") {}

type ClientMetadata = AuthClientDisplayMetadata | undefined;

function primarySocketUrl(target: LocalLinkTarget, clientMetadata: ClientMetadata): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  appendClientLinkParams(url, clientMetadata, "direct");
  return url.toString();
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const auth = yield* ClientCapabilities.PrimaryHostAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const authorization = yield* HostAuthorization.HostAuthorization;

  const prepare = Effect.fn("clientRuntime.connection.prepare")(function* (
    entry: LinkCatalogEntry,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({ "connection.environment.id": target.hostId });
    const bearerToken = yield* auth.bearerToken;
    // Same-origin (browser against the daemon's own page): the cookie session authorizes the socket.
    if (Option.isNone(bearerToken)) {
      return {
        target,
        httpAuthorization: null,
        socketUrl: primarySocketUrl(target, presentation.metadata),
        httpBaseUrl: target.httpBaseUrl,
        label: target.label,
        hostId: target.hostId,
      } satisfies PreparedLink;
    }
    const authorized = yield* authorization.authorizeBearer({
      bearerToken: bearerToken.value,
      wsBaseUrl: target.wsBaseUrl,
      httpBaseUrl: target.httpBaseUrl,
      expectedHostId: target.hostId,
    });
    return { ...authorized, target } satisfies PreparedLink;
  });

  return LinkResolver.of({ prepare });
});

export const layer = Layer.effect(LinkResolver, make);

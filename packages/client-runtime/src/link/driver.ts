import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { LinkCatalogEntry } from "./catalog.ts";
import type { LinkAttemptError, LinkAttemptStage, PreparedLink } from "./model.ts";
import * as LinkResolver from "./resolver.ts";
import * as RpcSession from "../wire/session.ts";

export type LinkDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<LinkAttemptStage, "preparing">;
      readonly prepared: PreparedLink;
    };

export interface HostLinkLease {
  readonly prepared: PreparedLink;
  readonly session: RpcSession.RpcSession;
}

export class LinkDriver extends Context.Service<
  LinkDriver,
  {
    readonly connect: (
      entry: LinkCatalogEntry,
      reportProgress: (progress: LinkDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<HostLinkLease, LinkAttemptError, Scope.Scope>;
  }
>()("@kora/client-runtime/link/driver/LinkDriver") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const resolver = yield* LinkResolver.LinkResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;

  const connect = Effect.fn("LinkDriver.connect")(function* (
    entry: LinkCatalogEntry,
    reportProgress: (progress: LinkDriverProgress) => Effect.Effect<void>,
  ) {
    const { hostId, _tag: targetKind } = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.target.kind": targetKind,
      "connection.environment.id": hostId,
    });
    // preparing -> opening -> synchronizing, then the session must report ready.
    const prepared = yield* Effect.andThen(
      reportProgress({ stage: "preparing" }),
      resolver.prepare(entry),
    );
    const enter = (stage: Exclude<LinkAttemptStage, "preparing">) =>
      reportProgress({ stage, prepared });
    const session = yield* Effect.andThen(enter("opening"), sessions.connect(prepared));
    yield* Effect.andThen(enter("synchronizing"), session.ready);
    return { prepared, session } satisfies HostLinkLease;
  });

  return LinkDriver.of({ connect });
});

export const layer = Layer.effect(LinkDriver, make);

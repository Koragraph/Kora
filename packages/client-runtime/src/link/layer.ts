import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import * as LinkResolver from "./resolver.ts";
import * as LinkDriver from "./driver.ts";
import * as HostRegistry from "./registry.ts";
import * as PlatformLinkSource from "../embedder/linkSource.ts";
import * as HostAuthorization from "../auth/service.ts";
import * as RpcSession from "../wire/session.ts";

export function layerWithOptions(options: RpcSession.RpcSessionOptions) {
  const driverLayer = LinkDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(LinkResolver.layer, RpcSession.layerWithOptions(options))),
  );
  const registryLayer = HostRegistry.layer.pipe(Layer.provide(driverLayer));
  const connectionStartupLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* HostRegistry.HostRegistry;
      const platformSource = yield* PlatformLinkSource.PlatformLinkSource;
      const followPlatform = Stream.runForEach(
        platformSource.registrations,
        registry.reconcilePlatform,
      );
      yield* registry.start;
      yield* Effect.forkScoped(followPlatform);
    }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
  );
  return connectionStartupLayer.pipe(
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(HostAuthorization.layer),
  );
}

export const layer = layerWithOptions({});

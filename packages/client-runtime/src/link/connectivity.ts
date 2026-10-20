import type * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { NetworkStatus } from "./model.ts";

interface ConnectivityService {
  readonly changes: Stream.Stream<NetworkStatus>;
  readonly status: Effect.Effect<NetworkStatus>;
}

export class Connectivity extends Context.Service<Connectivity, ConnectivityService>()(
  "@kora/client-runtime/link/connectivity",
) {}

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, Connectivity.of(service));

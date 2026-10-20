import * as Socket from "effect/unstable/socket/Socket";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import { remoteHttpClientLayer } from "@kora/client-runtime/wire";

import { primaryHostHttpLayer } from "../hosts/primary/httpLayer";
import * as PrimaryHostHttpClient from "../hosts/primary/httpClient";

const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));

/** Web Crypto behind Effect's service: command and message ids are drawn from it. */
const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (extent) => globalThis.crypto.getRandomValues(new Uint8Array(extent)),
    digest: (algorithm, blob) =>
      Effect.promise(async () => {
        const copy = new Uint8Array(blob.length);
        copy.set(blob);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, copy.buffer));
      }),
  }),
);

type RuntimeLayerSource =
  | typeof httpClientLayer
  | typeof browserCryptoLayer
  | typeof Socket.layerWebSocketConstructorGlobal;

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryHostHttpClient.layer.pipe(Layer.provide(primaryHostHttpLayer)),
);

export type PrimaryHttpEffectRunner = <Ok, Err>(
  effect: Effect.Effect<Ok, Err, PrimaryHostHttpClient.PrimaryHostHttpClient>,
) => Promise<Ok>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (program) => {
  return primaryHttpRuntime.runPromise(program);
};

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <Ok, Err>(
  effect: Effect.Effect<Ok, Err, PrimaryHostHttpClient.PrimaryHostHttpClient>,
) => primaryHttpRunner(effect);

const runtimeLayer = Layer.mergeAll(
  httpClientLayer,
  browserCryptoLayer,
  Socket.layerWebSocketConstructorGlobal,
);

const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = runtime.contextEffect.pipe(Layer.effectContext);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

import { Connection } from "@kora/client-runtime/link";
import { threadSnapshotLoaderLayer } from "@kora/client-runtime/store/threads";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../util/runtime";
import { linkPlatformLayer } from "./platform";

const providedLinkPlatformLayer = linkPlatformLayer.pipe(Layer.provide(runtimeContextLayer));

const snapshotLoaderLayer = threadSnapshotLoaderLayer;

type LinkLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof linkPlatformLayer;

const providedClientLinkLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      usageLimitSources: true,
      usageLimitsCommand: true,
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedLinkPlatformLayer)),
);

const linkLayer = providedClientLinkLayer;

export const daemonAtomRuntime: Atom.AtomRuntime<
  Layer.Success<LinkLayerSource>,
  Layer.Error<LinkLayerSource>
> = Atom.runtime(linkLayer);

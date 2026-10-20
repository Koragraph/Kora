import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { makeHostHttpApiClient } from "@kora/client-runtime/wire";

import { resolvePrimaryHostHttpUrl } from "./target";

export class PrimaryHostHttpClient extends Context.Service<
  PrimaryHostHttpClient,
  Effect.Success<ReturnType<typeof makeHostHttpApiClient>>
>()("@kora/web/hosts/primary/httpClient/PrimaryHostHttpClient") {}

const make = Effect.suspend(() => makeHostHttpApiClient(resolvePrimaryHostHttpUrl("/")));

export const layer = Layer.effect(PrimaryHostHttpClient, make);

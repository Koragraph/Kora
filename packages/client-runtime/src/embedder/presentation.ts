import type { AuthClientDisplayMetadata, AuthHostScope } from "@kora/contracts";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { LinkAttemptError } from "../link/model.ts";

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly scopes: ReadonlyArray<AuthHostScope>;
    readonly metadata: AuthClientDisplayMetadata;
  }
>()("@kora/client-runtime/embedder/presentation/ClientPresentation") {}

export class PrimaryHostAuth extends Context.Service<
  PrimaryHostAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, LinkAttemptError>;
  }
>()("@kora/client-runtime/embedder/presentation/PrimaryHostAuth") {}

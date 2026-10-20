import type { HostDescriptor, HostId } from "@kora/contracts";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import { HttpClient } from "effect/unstable/http";

import { fetchRemoteHostDescriptor } from "../host/descriptor.ts";
import { hostMismatchError, mapRemoteHostError } from "../link/errors.ts";
import type { LinkAttemptError, PreparedHttpAuthorization } from "../link/model.ts";
import { ClientPresentation } from "../embedder/presentation.ts";
import { resolveRemoteWebSocketLinkUrl } from "./remote.ts";

export interface AuthorizedHost {
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly socketUrl: string;
  readonly httpBaseUrl: string;
  readonly label: string;
  readonly hostId: HostId;
}

type BearerAuthorizationRequest = Readonly<
  Record<"bearerToken" | "httpBaseUrl" | "wsBaseUrl", string> & { expectedHostId: HostId }
>;

export class HostAuthorization extends Context.Service<
  HostAuthorization,
  {
    readonly authorizeBearer: (
      input: BearerAuthorizationRequest,
    ) => Effect.Effect<AuthorizedHost, LinkAttemptError>;
  }
>()("@kora/client-runtime/auth/service/HostAuthorization") {}

// A descriptor check guards against talking to a different daemon on a reused port, so it is
// not trusted for long.
const DESCRIPTOR_CACHE_TTL_MS = 10_000;

interface ValidatedDescriptor {
  readonly httpBaseUrl: string;
  readonly descriptor: HostDescriptor;
  readonly validatedAtEpochMs: number;
}

export const layer: Layer.Layer<
  HostAuthorization,
  never,
  ClientPresentation | HttpClient.HttpClient
> = Layer.effect(
  HostAuthorization,
  Effect.gen(function* () {
    const presentation = yield* ClientPresentation;
    const http = yield* HttpClient.HttpClient;
    const validated = yield* Ref.make(new Map<HostId, ValidatedDescriptor>());

    const descriptorFor = Effect.fn("clientRuntime.connection.remote.descriptor")(function* (
      expectedHostId: HostId,
      httpBaseUrl: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(validated)).get(expectedHostId);
      if (
        cached !== undefined &&
        cached.httpBaseUrl === httpBaseUrl &&
        now - cached.validatedAtEpochMs < DESCRIPTOR_CACHE_TTL_MS
      ) {
        return cached.descriptor;
      }
      const descriptor = yield* fetchRemoteHostDescriptor({ httpBaseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => mapRemoteHostError(error, "direct")),
      );
      if (descriptor.hostId !== expectedHostId) {
        return yield* Effect.fail(
          hostMismatchError({ expected: expectedHostId, actual: descriptor.hostId }),
        );
      }
      yield* Ref.update(validated, (map) =>
        new Map(map).set(expectedHostId, { httpBaseUrl, descriptor, validatedAtEpochMs: now }),
      );
      return descriptor;
    });

    const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(function* (
      input: BearerAuthorizationRequest,
    ) {
      const descriptor = yield* descriptorFor(input.expectedHostId, input.httpBaseUrl);
      const socketUrl = yield* resolveRemoteWebSocketLinkUrl({
        connectionMethod: "direct",
        clientMetadata: presentation.metadata,
        bearerToken: input.bearerToken,
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => mapRemoteHostError(error, "direct")),
      );
      return {
        hostId: descriptor.hostId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
      } satisfies AuthorizedHost;
    });

    return HostAuthorization.of({ authorizeBearer });
  }),
);

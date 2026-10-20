import * as Effect from "effect/Effect";

import { hostEndpointUrl } from "./endpoint.ts";
import { executeHostHttpRequest, makeHostHttpApiGroupClient } from "../wire/http.ts";

/** Ten seconds: a reachable host answers its descriptor long before this. */
const DESCRIPTOR_TIMEOUT_MS = 10 * 1_000;

type DescriptorRequest = { readonly httpBaseUrl: string; readonly timeoutMs?: number };

export const fetchRemoteHostDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteHostDescriptor",
)(function* ({ httpBaseUrl, timeoutMs = DESCRIPTOR_TIMEOUT_MS }: DescriptorRequest) {
  const metadata = yield* makeHostHttpApiGroupClient(httpBaseUrl, "metadata");
  const url = hostEndpointUrl(httpBaseUrl, "/.well-known/kora/host");
  return yield* executeHostHttpRequest(url, timeoutMs, metadata.descriptor());
});

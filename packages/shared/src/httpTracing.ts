import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/unstable/http/Headers";

/** DPoP proofs are bearer-like: keep them out of traced request headers too. */
const withDpopRedacted = Headers.CurrentRedactedNames.pipe(
  Effect.map((redacted) => redacted.concat("dpop")),
);

export const httpHeaderRedactionLayer = Layer.effect(
  Headers.CurrentRedactedNames,
  withDpopRedacted,
);

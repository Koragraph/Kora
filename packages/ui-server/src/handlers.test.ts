import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOB_METHODS,
  FLEET_METHODS,
  KoraRpcGroup,
  SWARM_METHODS,
  type SwarmOperationError,
} from "@kora/contracts";
import * as Effect from "effect/Effect";

import { mergedHandlerTags } from "./handlers.ts";
import { swarmHandlers } from "./handlers/swarm.ts";
import { setHost, type UiHost } from "./host.ts";

// An RPC without a real handler is auto-stubbed by `buildHandlers` with Effect.never / Stream.never: the UI then
// spins forever with nothing in the logs (ref-reconciled §0). This guard fails on any such gap.
//
// Pre-existing gaps would be allowlisted here, each with a reason, so the guard only catches NEW ones. At the W0
// base (d2cc859) every RPC in KoraRpcGroup already has a domain handler, so the allowlist is empty — keep it so.
const KNOWN_UNHANDLED: ReadonlySet<string> = new Set<string>([]);

test("every RPC in KoraRpcGroup has a real (non-stub) handler", () => {
  const real = mergedHandlerTags();
  const missing = [...KoraRpcGroup.requests.keys()].filter(
    (tag) => !real.has(tag) && !KNOWN_UNHANDLED.has(tag),
  );
  assert.deepEqual(missing, [], `RPCs that would hang forever: ${missing.join(", ")}`);
});

test("every swarm RPC, every blobs RPC and fleet.readReport is real", () => {
  const real = mergedHandlerTags();
  for (const tag of [
    ...Object.values(SWARM_METHODS),
    ...Object.values(BLOB_METHODS),
    FLEET_METHODS.readReport,
  ]) {
    assert.ok(real.has(tag), `${tag} has a real handler`);
  }
});

function fakeHost(swarm: Partial<UiHost["swarm"]>): void {
  setHost({ swarm, log: () => {} } as unknown as UiHost);
}

test("swarm handlers delegate to UiHost.swarm and JSON-sanitize the result", async () => {
  let seen: unknown = "unset";
  fakeHost({
    setKey: async (input) => {
      seen = input;
      return { provider: "openrouter", hasKey: true, extra: undefined } as never;
    },
  });
  const effect = swarmHandlers[SWARM_METHODS.setKey]!({
    provider: "openrouter",
    apiKey: "sk-or-x",
  }) as Effect.Effect<unknown, SwarmOperationError>;
  const out = await Effect.runPromise(effect);
  assert.deepEqual(seen, { provider: "openrouter", apiKey: "sk-or-x" });
  assert.deepEqual(out, { provider: "openrouter", hasKey: true });
  assert.ok(!("extra" in (out as object)), "undefined keys are dropped (jsonSafe)");
});

test("a failing (stub) SwarmSetup answers a typed SwarmOperationError, never a hang or defect", async () => {
  fakeHost({
    getStatus: async () => {
      throw new Error("not implemented: SwarmSetup.getStatus");
    },
  });
  const effect = swarmHandlers[SWARM_METHODS.getStatus]!({}) as Effect.Effect<
    object,
    SwarmOperationError
  >;
  const error = await Effect.runPromise(Effect.flip(effect));
  assert.equal(error._tag, "SwarmOperationError");
  assert.equal(error.operation, "getStatus");
  assert.match(error.message, /not implemented/);
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KoraRpcGroup, RPC_METHODS } from "./koraRpc.ts";
import { FolderTrustStatus, TRUST_METHODS, TrustListResult, TrustSetInput } from "./trust.ts";

const strict = { onExcessProperty: "error" } as const;

it("registers the trust RPCs in KoraRpcGroup under their method names", () => {
  assert.strictEqual(RPC_METHODS.trustGet, TRUST_METHODS.get);
  assert.strictEqual(RPC_METHODS.trustSet, TRUST_METHODS.set);
  assert.strictEqual(RPC_METHODS.trustList, TRUST_METHODS.list);
  for (const tag of Object.values(TRUST_METHODS)) assert.ok(KoraRpcGroup.requests.has(tag), tag);
});

it.effect(
  "decodes the daemon's trust status strictly (nullable, never undefined) and round-trips it",
  () =>
    Effect.gen(function* () {
      const wire = {
        cwd: "/Users/me/Projects/app/src",
        root: "/Users/me/Projects/app",
        trusted: false,
        trustedBy: null,
        source: null,
        canTrust: true,
        reason: null,
      };
      const status = yield* Schema.decodeUnknownEffect(FolderTrustStatus)(wire, strict);
      assert.deepStrictEqual<unknown>(yield* Schema.encodeEffect(FolderTrustStatus)(status), wire);
      const list = yield* Schema.decodeUnknownEffect(TrustListResult)(
        { folders: [{ path: "/a", trustedAt: 1, source: "migration" }] },
        strict,
      );
      assert.strictEqual(list.folders[0]?.source, "migration");
      const bad = yield* Effect.exit(
        Schema.decodeUnknownEffect(TrustSetInput)({ cwd: "/a" }, strict),
      );
      assert.strictEqual(bad._tag, "Failure", "trusted is required");
    }),
);

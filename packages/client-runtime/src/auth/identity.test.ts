import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { remoteHttpClientLayer } from "../wire/http.ts";
import { daemonIdentityProof, newIdentityNonce, portOf, verifyDaemonIdentity } from "./identity.ts";

const SECRET = "k".repeat(43);
// Vectors from the daemon's implementation (Node `createHmac("sha256", secret)`, packages/ui-server/src/localAuth.ts).
const NONCE = "n".repeat(43);
const VECTORS: Record<number, string> = {
  8797: "ERc0BuG6RH1ko_TakjOvdQaoDNGuDhdA-FA8S5RH-sY",
  8790: "dND9-ABR4K_-rPUkiXrX6tuR-7beK63TZ3QFlgzTqjM",
};

/** A fetch that answers the identity challenge as a daemon holding `key` on `port` would. */
const challengeFetch = (key: string, port: number, seen: Array<string>) =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    seen.push(headers.get("authorization") ?? "");
    const nonce = url.searchParams.get("nonce") ?? "";
    return daemonIdentityProof(key, port, nonce).then(
      (proof) =>
        new Response(JSON.stringify({ v: 1, proof }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }) as typeof fetch;

describe("daemon identity proof", () => {
  it("matches the daemon's Node HMAC exactly", async () => {
    assert.match(newIdentityNonce(), /^[A-Za-z0-9_-]{43}$/);
    for (const port of [8797, 8790]) {
      assert.strictEqual(await daemonIdentityProof(SECRET, port, NONCE), VECTORS[port]);
    }
  });

  it("portOf reads the dialled port", () => {
    assert.strictEqual(portOf("http://127.0.0.1:8797/"), 8797);
    assert.strictEqual(portOf("http://127.0.0.1/"), 80);
  });

  it("verifies a daemon holding the secret, without sending any credential", async () => {
    const seen: Array<string> = [];
    const exit = await Effect.runPromiseExit(
      verifyDaemonIdentity({ httpBaseUrl: "http://127.0.0.1:8797/", secret: SECRET }).pipe(
        Effect.provide(remoteHttpClientLayer(challengeFetch(SECRET, 8797, seen))),
      ),
    );
    assert.strictEqual(exit._tag, "Success");
    assert.deepStrictEqual(seen, [""]);
  });

  it("rejects a server with another key or another port", async () => {
    for (const [key, port] of [
      ["guess", 8797],
      [SECRET, 8790],
    ] as const) {
      const exit = await Effect.runPromiseExit(
        verifyDaemonIdentity({ httpBaseUrl: "http://127.0.0.1:8797/", secret: SECRET }).pipe(
          Effect.provide(remoteHttpClientLayer(challengeFetch(key, port, []))),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
    }
  });
});

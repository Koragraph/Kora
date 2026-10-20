// @effect-diagnostics nodeBuiltinImport:off -- plain node:http stand-ins for whatever answers on the daemon port.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { exchangeVerifiedCredential } from "./ShellKoraUiToken.ts";

const SECRET = "s".repeat(43);

/** A stand-in for whatever listens on the daemon port. `genuine` answers the identity challenge with the secret. */
function fakeDaemon(mode: "genuine" | "squatter" | "no-identity") {
  const received: Array<string> = [];
  const server = NodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const port = (server.address() as NodeNet.AddressInfo).port;
    if (url.pathname === "/.well-known/kora/identity") {
      if (mode === "no-identity") {
        res.writeHead(404).end();
        return;
      }
      const nonce = url.searchParams.get("nonce") ?? "";
      const key = mode === "genuine" ? SECRET : "a-guess";
      const proof = NodeCrypto.createHmac("sha256", key)
        .update(`kora-ui-identity/v1\n${port}\n${nonce}`)
        .digest("base64url");
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ v: 1, proof }));
      return;
    }
    if (url.pathname === "/oauth/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(new URLSearchParams(body).get("subject_token") ?? "");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            access_token: SECRET,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 60,
            scope: "chat:read",
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  return {
    received,
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`),
        ),
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function homeWithSecret(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-desk-tok-"));
  NodeFS.writeFileSync(NodePath.join(dir, "ui-token"), `${SECRET}\n`, { mode: 0o600 });
  return dir;
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

describe("exchangeVerifiedCredential", () => {
  it("exchanges the secret with a daemon that proves it holds it", async () => {
    const daemon = fakeDaemon("genuine");
    const httpBaseUrl = await daemon.start();
    const baseDir = homeWithSecret();
    try {
      const exit = await run(
        exchangeVerifiedCredential({ baseDir, httpBaseUrl }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      assert.strictEqual(exit._tag, "Success");
      assert.deepStrictEqual(daemon.received, [SECRET]);
    } finally {
      await daemon.stop();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("never sends the secret to a port squatter that cannot prove it", async () => {
    for (const mode of ["squatter", "no-identity"] as const) {
      const daemon = fakeDaemon(mode);
      const httpBaseUrl = await daemon.start();
      const baseDir = homeWithSecret();
      try {
        const exit = await run(
          exchangeVerifiedCredential({ baseDir, httpBaseUrl }).pipe(
            Effect.provide(FetchHttpClient.layer),
          ),
        );
        assert.strictEqual(exit._tag, "Failure", mode);
        assert.deepStrictEqual(daemon.received, [], `${mode}: no token exchange happened`);
      } finally {
        await daemon.stop();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }
  });

  it("without a secret file sends nothing at all (no legacy credential to whoever answers)", async () => {
    for (const mode of ["genuine", "no-identity"] as const) {
      const daemon = fakeDaemon(mode);
      const httpBaseUrl = await daemon.start();
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-desk-tok-"));
      try {
        const exit = await run(
          exchangeVerifiedCredential({ baseDir, httpBaseUrl }).pipe(
            Effect.provide(FetchHttpClient.layer),
          ),
        );
        assert.strictEqual(exit._tag, "Failure", mode);
        assert.deepStrictEqual(daemon.received, [], `${mode}: no token exchange happened`);
      } finally {
        await daemon.stop();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }
  });
});

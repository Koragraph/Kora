// @effect-diagnostics nodeBuiltinImport:off -- one small synchronous read of a 0600 file the daemon owns.
// The kora daemon refuses /ws and /api/* callers that cannot present its UI secret (`<kora home>/ui-token`, written
// 0600 by the daemon before it serves; packages/ui-server/src/localAuth.ts). Only this main process reads the file:
// it exchanges the secret at /oauth/token, and the renderer gets the resulting bearer over IPC.
//
// The secret is sent only to a daemon that has first PROVEN it holds it (`verifyDaemonIdentity`: HMAC challenge on
// `/.well-known/kora/identity`). Loopback ports are not per-user: while the daemon is down, another local user can
// bind 127.0.0.1:8797, and without the check the desktop would hand it the real secret.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  bootstrapRemoteBearerSession,
  DaemonIdentityError,
  verifyDaemonIdentity,
} from "@kora/client-runtime/auth";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const KORA_UI_TOKEN_FILE = "ui-token";

/**
 * No secret to send yet (the daemon has not written `ui-token`, or it cannot be read). The desktop used to send a legacy
 * credential instead, WITHOUT the identity check; a current daemon rejects it, so it could only ever succeed against
 * whatever else answers on the port (2026-10-15 audit desktop #2). Now the exchange fails and the caller retries.
 */
export class MissingUiSecretError extends Data.TaggedError("MissingUiSecretError")<{
  readonly message: string;
}> {}

/** The secret in `baseDir` (the desktop's KORA_HOME / ~/.kora, the daemon's home), or a MissingUiSecretError. */
const readKoraUiSecret = (baseDir: string) =>
  Effect.suspend(() => {
    let token = "";
    try {
      token = NodeFS.readFileSync(NodePath.join(baseDir, KORA_UI_TOKEN_FILE), "utf8").trim();
    } catch {
      /* missing or unreadable */
    }
    return token.length > 0
      ? Effect.succeed(token)
      : Effect.fail(
          new MissingUiSecretError({
            message: `no daemon secret in ${NodePath.join(baseDir, KORA_UI_TOKEN_FILE)} yet`,
          }),
        );
  });

/**
 * Read the secret, make the daemon at `httpBaseUrl` prove it holds it, then exchange it for the session bearer.
 * A failed proof fails with `DaemonIdentityError` and nothing secret leaves the process; no secret file fails with
 * `MissingUiSecretError` and nothing is sent at all.
 */
export const exchangeVerifiedCredential = Effect.fn("shell.koraUiToken.exchangeVerifiedCredential")(
  function* (input: { readonly baseDir: string; readonly httpBaseUrl: string }) {
    const credential = yield* readKoraUiSecret(input.baseDir);
    yield* verifyDaemonIdentity({ httpBaseUrl: input.httpBaseUrl, secret: credential });
    const session = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: input.httpBaseUrl,
      credential,
      clientMetadata: { label: "Kora Desktop", deviceType: "desktop" },
    });
    return { accessToken: session.access_token };
  },
);

export { DaemonIdentityError };

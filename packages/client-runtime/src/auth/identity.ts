/**
 * Daemon identity proof: the client makes whatever answers on 127.0.0.1:<port> prove it holds the UI secret BEFORE
 * the client sends that secret (or the bearer, which is the same value) anywhere.
 *
 * Why: TCP loopback is not per-user. While Kora's daemon is down, any other local user (or a stray program) can bind
 * 127.0.0.1:8797; a client that just sends its credential to "the daemon" would hand the real secret to it, and the
 * secret drives the real daemon (agents, bypass permissions) once it is back.
 *
 * Protocol (v1): the client draws a fresh random nonce and calls
 *   GET /.well-known/kora/identity?nonce=<base64url, 22..128 chars>
 * The daemon answers `{ "v": 1, "proof": base64url(HMAC-SHA256(key = secret, msg)) }` with
 *   msg = "kora-ui-identity/v1\n" + <the daemon's own listen port> + "\n" + nonce
 * The port is bound into the proof so a squatter cannot relay the challenge to a Kora daemon listening elsewhere.
 * The client recomputes the HMAC with its copy of the secret and the port it dialled and compares in constant time.
 * Only on a match does it send the credential. The endpoint needs no credential (it only ever returns a MAC of a
 * client-chosen nonce: no oracle for the secret). Server side: `packages/ui-server/src/localAuth.ts`.
 *
 * Uses Web Crypto only, so the same code runs in the Electron main process (Node) and in a renderer.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

const DAEMON_IDENTITY_PATH = "/.well-known/kora/identity";
const IDENTITY_CONTEXT = "kora-ui-identity/v1";
const DEFAULT_TIMEOUT_MS = 5_000;

export class DaemonIdentityError extends Data.TaggedError("DaemonIdentityError")<{
  /** `mismatch`: something answered but could not prove it holds the secret. `unreachable`: no usable answer. */
  readonly reason: "mismatch" | "unreachable";
  readonly message: string;
}> {}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url (43 chars). */
export function newIdentityNonce(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** The proof a daemon holding `secret` and listening on `port` returns for `nonce`. */
export async function daemonIdentityProof(
  secret: string,
  port: number,
  nonce: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${IDENTITY_CONTEXT}\n${port}\n${nonce}`),
  );
  return base64url(new Uint8Array(mac));
}

/** Constant-time string compare (both are fixed-length base64url MACs; a length difference is not a secret). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The port a client dials for `httpBaseUrl` (explicit, else the scheme default). */
export function portOf(httpBaseUrl: string): number {
  const url = new URL(httpBaseUrl);
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Succeeds only when the server at `httpBaseUrl` proves it holds `secret`. Sends no credential. Requires an
 * `HttpClient` that does NOT add the credential itself (a plain fetch client).
 */
type IdentityCheck = Readonly<{ secret: string; httpBaseUrl: string; timeoutMs?: number }>;

export const verifyDaemonIdentity = Effect.fn("clientRuntime.authorization.verifyDaemonIdentity")(
  function* (input: IdentityCheck) {
    const client = yield* HttpClient.HttpClient;
    const nonce = newIdentityNonce();
    const url = new URL(DAEMON_IDENTITY_PATH, input.httpBaseUrl);
    url.searchParams.set("nonce", nonce);
    const unreachable = (message: string) =>
      new DaemonIdentityError({ reason: "unreachable", message });
    const response = yield* client.get(url.toString()).pipe(
      Effect.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      Effect.mapError((error) =>
        unreachable(`Kora daemon identity check failed: ${String(error)}`),
      ),
    );
    if (response.status !== 200) {
      return yield* new DaemonIdentityError({
        reason: "mismatch",
        message: `The program on ${url.host} is not a Kora daemon that knows this Mac's UI secret (identity check answered ${response.status}).`,
      });
    }
    const body: unknown = yield* response.json.pipe(
      Effect.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      Effect.mapError((error) =>
        unreachable(`Kora daemon identity answer unreadable: ${String(error)}`),
      ),
    );
    const proof =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { proof?: unknown }).proof === "string"
        ? (body as { proof: string }).proof
        : "";
    const expected = yield* Effect.promise(() =>
      daemonIdentityProof(input.secret, portOf(input.httpBaseUrl), nonce),
    );
    if (!sameString(proof, expected)) {
      return yield* new DaemonIdentityError({
        reason: "mismatch",
        message: `The program on ${url.host} could not prove it is this Mac's Kora daemon; the UI secret was not sent.`,
      });
    }
  },
);

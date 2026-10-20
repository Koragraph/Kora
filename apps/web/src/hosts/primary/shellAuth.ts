import { verifyDaemonIdentity } from "@kora/client-runtime/auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { resolvePrimaryHostHttpUrl } from "./target";

let shellBearerTokenPromise: Promise<string> | null = null;

/**
 * The desktop bearer, straight from the bridge. It IS the daemon's UI secret, so nothing may send it before the
 * server has proven it is this Mac's daemon — use `readVerifiedShellPrimaryBearerToken` for anything that goes on
 * the wire.
 */
export function readShellPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.shellBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  shellBearerTokenPromise ??= bridge.getLocalHostBearerToken().catch((error) => {
    shellBearerTokenPromise = null;
    throw error;
  });
  return shellBearerTokenPromise;
}

function primaryHostOrigin(): string | null {
  try {
    return new URL(resolvePrimaryHostHttpUrl("/")).origin;
  } catch {
    return null;
  }
}

/** True only for URLs on the primary host's own origin — the only place the bearer may ever go. */
export function isPrimaryHostUrl(url: string): boolean {
  const origin = primaryHostOrigin();
  if (origin === null) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// ── Daemon identity gate ─────────────────────────────────────────────────────
//
// TCP loopback is not per-user: if the daemon dies mid-session, another local user (or any program) can bind its port.
// The renderer holds the bearer for the window's lifetime, so before the bearer goes anywhere the server must answer
// the HMAC challenge (`verifyDaemonIdentity`, packages/client-runtime/src/auth/identity.ts) — over a plain fetch that
// carries NO credential. A proof is NEVER reused: every credentialed send re-proves first (concurrent sends share one
// in-flight check; on loopback it costs ~1 ms). Live-tested 2026-10-04: with a 30 s proof cache, a squatter that took
// the port 2 s after the daemon stopped received the bearer on the next graph-status poll.

export class PrimaryHostIdentityError extends Error {
  override readonly name = "PrimaryHostIdentityError";
}

type IdentityVerifier = (input: {
  readonly httpBaseUrl: string;
  readonly secret: string;
}) => Promise<void>;

// A plain fetch client: never the bearer-adding primaryHostHttpLayer.
const identityHttpLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit", cache: "no-store" }),
  ),
);

const defaultIdentityVerifier: IdentityVerifier = (input) =>
  Effect.runPromise(verifyDaemonIdentity(input).pipe(Effect.provide(identityHttpLayer)));

let identityVerifier: IdentityVerifier = defaultIdentityVerifier;
let inFlight: {
  readonly origin: string;
  readonly token: string;
  readonly promise: Promise<void>;
} | null = null;

/** Drop any in-flight check: the next credentialed request starts a new proof. */
export function invalidatePrimaryHostIdentity(): void {
  inFlight = null;
}

async function ensurePrimaryHostIdentity(
  token: string,
  options: { readonly fresh: boolean },
): Promise<void> {
  const origin = primaryHostOrigin();
  if (origin === null) throw new PrimaryHostIdentityError("No primary host to verify.");
  if (options.fresh) invalidatePrimaryHostIdentity();
  // Only a check that is still running is shared — a finished proof says nothing about who holds the port now.
  if (inFlight !== null && inFlight.origin === origin && inFlight.token === token) {
    return inFlight.promise;
  }
  const promise = identityVerifier({ httpBaseUrl: `${origin}/`, secret: token }).then(
    () => {
      if (inFlight?.promise === promise) inFlight = null;
    },
    (cause: unknown) => {
      if (inFlight?.promise === promise) inFlight = null;
      throw new PrimaryHostIdentityError(
        cause instanceof Error
          ? cause.message
          : `Kora daemon identity check failed: ${String(cause)}`,
      );
    },
  );
  inFlight = { origin, token, promise };
  return promise;
}

/**
 * The bearer, released only after the primary host proved it is this Mac's daemon. `null` when there is no bearer
 * (browser: the Vite dev proxy authenticates). Rejects with `PrimaryHostIdentityError` when the proof fails or the
 * daemon is unreachable — the caller must then not send anything credentialed.
 *
 * `fresh: true` discards any cached proof first (socket connects and reconnects).
 */
export async function readVerifiedShellPrimaryBearerToken(
  options: { readonly fresh?: boolean } = {},
): Promise<string | null> {
  const token = await readShellPrimaryBearerToken();
  if (!token) return null;
  await ensurePrimaryHostIdentity(token, { fresh: options.fresh ?? false });
  return token;
}

/**
 * `fetch` against the primary host with the desktop bearer attached: the daemon refuses `/api/*` without its UI
 * secret. In the browser preview there is no bridge, and the Vite dev proxy adds the credential instead.
 */
export async function fetchPrimaryHost(url: string, init: RequestInit = {}): Promise<Response> {
  // Only ever to the primary host's own origin: another host must never see this machine's credential.
  if (!isPrimaryHostUrl(url)) return fetch(url, init);
  const token = await readShellPrimaryBearerToken().catch(() => null);
  if (!token) return fetch(url, init);
  // Throws when the server cannot prove it is the daemon: nothing is sent to it.
  await ensurePrimaryHostIdentity(token, { fresh: false });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    // The daemon went away (or the network did): re-prove before the next credentialed send.
    invalidatePrimaryHostIdentity();
    throw error;
  }
}

export function __resetShellPrimaryAuthForTests(): void {
  shellBearerTokenPromise = null;
  invalidatePrimaryHostIdentity();
  identityVerifier = defaultIdentityVerifier;
}

export function __setPrimaryIdentityForTests(options: {
  readonly verifier?: IdentityVerifier;
}): void {
  if (options.verifier) identityVerifier = options.verifier;
}

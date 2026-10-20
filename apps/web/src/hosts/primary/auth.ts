import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { PRIMARY_LOCAL_HOST_ID, type DaemonSessionState } from "@kora/contracts";

import { PrimaryHostHttpClient } from "./httpClient";
import { runPrimaryHttp } from "../../util/runtime";
import { clearBootWaiting, showBootWaiting } from "../../util/bootError";

type Operation =
  | "fetch-session-state"
  | "exchange-bootstrap-credential"
  | "fetch-environment-descriptor";

type DaemonAuthGateState =
  | { status: "authenticated" }
  | { status: "requires-auth"; auth: DaemonSessionState["auth"]; errorMessage?: string };

// Declared API errors carry their HTTP status; anything else answers from the transport layer.
const STATUS_BY_TAG: Record<string, number> = {
  HostRequestInvalidError: 400,
  HostAuthInvalidError: 401,
  HostScopeRequiredError: 403,
  HostOperationForbiddenError: 403,
  HostResourceNotFoundError: 404,
  HostInternalError: 500,
};

function readHttpApiStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const marker = (cause as { _tag?: unknown })._tag;
  if (typeof marker === "string" && marker in STATUS_BY_TAG) return STATUS_BY_TAG[marker]!;
  const phase = (cause as { response?: { status?: unknown } }).response?.status;
  return typeof phase === "number" ? phase : null;
}

export class PrimaryHostRequestError extends Schema.TaggedError<PrimaryHostRequestError>()(
  "PrimaryHostRequestError",
  {
    cause: Schema.Defect(),
    status: Schema.Number,
    operation: Schema.Literals([
      "fetch-environment-descriptor",
      "exchange-bootstrap-credential",
      "fetch-session-state",
    ]),
  },
) {
  static fromCause(args: { operation: Operation; cause: unknown }): PrimaryHostRequestError {
    return new PrimaryHostRequestError({
      operation: args.operation,
      status: readHttpApiStatus(args.cause) ?? 500,
      cause: args.cause,
    });
  }

  override get message() {
    return `Primary environment request failed during ${this.operation} (HTTP ${this.status}).`;
  }
}

export class PrimaryHostCredentialRejectedError extends Schema.TaggedError<PrimaryHostCredentialRejectedError>()(
  "PrimaryHostCredentialRejectedError",
  { providedLength: Schema.Number, cause: Schema.Defect() },
) {
  override get message() {
    return "The daemon rejected this app's credential. Restart the daemon: kora server stop && kora server start.";
  }
}

export class PrimaryHostAuthSessionTimeoutError extends Schema.TaggedError<PrimaryHostAuthSessionTimeoutError>()(
  "PrimaryHostAuthSessionTimeoutError",
  { timeoutMs: Schema.Number, elapsedMs: Schema.Number },
) {
  override get message() {
    return "Timed out waiting for authenticated session after bootstrap.";
  }
}

// ---------- waiting out a daemon that is still starting ----------

const RETRY_DELAY_MS = 500;
const WAITING_RETRY_DELAY_MS = 2000;
const WAITING_NOTICE_AFTER_MS = 3000;
const GATEWAY_STATUSES = new Set([502, 503, 504]);

const isPrimaryHostRequestError = Schema.is(PrimaryHostRequestError);

function isTransient(err: unknown): boolean {
  if (isPrimaryHostRequestError(err)) {
    if (GATEWAY_STATUSES.has(err.status)) return true;
    const cause = err.cause as { reason?: { _tag?: string } } | undefined;
    return err.cause instanceof TypeError || cause?.reason?._tag === "TransportError";
  }
  if (err instanceof TypeError) return true; // fetch network failure
  return (
    typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"
  );
}

/** A daemon that is down is a wait, not a failure: retry until it answers or fails for real. */
export async function retryTransientBootstrap<Item>(
  operation1: () => Promise<Item>,
  hooks: {
    onWaiting?: () => void;
    onAnswered?: () => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<Item> {
  const onWaiting = hooks.onWaiting ?? showBootWaiting;
  const onAnswered = hooks.onAnswered ?? clearBootWaiting;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const clock = hooks.now ?? Date.now;

  const startedAt = clock();
  let waiting = false;
  for (;;) {
    try {
      const result = await operation1();
      if (waiting) onAnswered();
      return result;
    } catch (err) {
      if (!isTransient(err)) {
        if (waiting) onAnswered();
        throw err;
      }
      if (!waiting && clock() - startedAt >= WAITING_NOTICE_AFTER_MS) {
        waiting = true;
        onWaiting();
      }
      await sleep(waiting ? WAITING_RETRY_DELAY_MS : RETRY_DELAY_MS);
    }
  }
}

// ---------- the gate ----------

const SESSION_POLL_MS = 100;
const SESSION_TIMEOUT_MS = 2000;

const fetchSession = () =>
  retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryHostHttpClient.pipe(
          Effect.flatMap((client) => client.auth.session({ headers: {} })),
        ),
      );
    } catch (cause) {
      throw PrimaryHostRequestError.fromCause({ operation: "fetch-session-state", cause });
    }
  });

function readBootstrapCredential(): string | null {
  if (typeof window === "undefined") return null;
  const tok = window.shellBridge
    ?.getLocalHostBootstraps?.()
    .find((rec) => rec.id === PRIMARY_LOCAL_HOST_ID)?.bootstrapToken;
  return typeof tok === "string" && tok !== "" ? tok : null;
}

const isRejectedCredential = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  (err as { _tag?: unknown })._tag === "HostAuthInvalidError" &&
  (err as { reason?: unknown }).reason === "invalid_credential";

const exchangeCredential = (credential: string) =>
  retryTransientBootstrap(async () => {
    try {
      await runPrimaryHttp(
        PrimaryHostHttpClient.pipe(
          Effect.flatMap((client) => client.auth.browserSession({ payload: { credential } })),
        ),
      );
    } catch (cause) {
      // Only the length is reported: the credential itself never leaves this function.
      if (isRejectedCredential(cause)) {
        throw new PrimaryHostCredentialRejectedError({ providedLength: credential.length, cause });
      }
      throw PrimaryHostRequestError.fromCause({
        operation: "exchange-bootstrap-credential",
        cause,
      });
    }
  });

async function waitForAuthenticatedSession(): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if ((await fetchSession()).authenticated) return;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SESSION_TIMEOUT_MS) {
      throw new PrimaryHostAuthSessionTimeoutError({ timeoutMs: SESSION_TIMEOUT_MS, elapsedMs });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SESSION_POLL_MS));
  }
}

async function resolveGate(): Promise<DaemonAuthGateState> {
  const sess = await fetchSession();
  if (sess.authenticated) return { status: "authenticated" };

  const credential = readBootstrapCredential();
  if (credential === null) return { status: "requires-auth", auth: sess.auth };

  try {
    await exchangeCredential(credential);
    await waitForAuthenticatedSession();
    return { status: "authenticated" };
  } catch (err) {
    return {
      status: "requires-auth",
      auth: sess.auth,
      errorMessage: err instanceof Error && err.message ? err.message : "Authentication failed.",
    };
  }
}

let inFlightGate: Promise<DaemonAuthGateState> | null = null;
let authenticatedGate: DaemonAuthGateState | null = null;

export function resolveInitialDaemonAuthGateState(): Promise<DaemonAuthGateState> {
  if (authenticatedGate) return Promise.resolve(authenticatedGate);
  inFlightGate ??= resolveGate()
    .then((gate) => {
      if (gate.status === "authenticated") authenticatedGate = gate;
      return gate;
    })
    .finally(() => {
      inFlightGate = null;
    });
  return inFlightGate;
}

export function __resetDaemonAuthBootstrapForTests(): void {
  inFlightGate = null;
  authenticatedGate = null;
}

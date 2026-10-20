import type { ClientLinkMethod, HostId } from "@kora/contracts";
import type { RemoteHostAuthError } from "../auth/remote.ts";
import { LinkBlockedError, type LinkAttemptError, LinkTransientError } from "./model.ts";

export function hostMismatchError(input: {
  readonly expected: HostId;
  readonly actual: HostId;
}): LinkBlockedError {
  return new LinkBlockedError({
    reason: "configuration",
    detail: `Connected environment ${input.actual} does not match ${input.expected}.`,
  });
}

export function mapRemoteHostError(
  error: RemoteHostAuthError,
  _connectionMethod: ClientLinkMethod = "direct",
): LinkAttemptError {
  switch (error._tag) {
    case "HostAuthInvalidError":
      return new LinkBlockedError({
        traceId: error.traceId,
        detail: "The environment credential is invalid.",
        reason: "authentication",
      });
    case "HostScopeRequiredError":
    case "HostOperationForbiddenError":
      return new LinkBlockedError({
        traceId: error.traceId,
        detail: "The environment credential does not grant the required access.",
        reason: "permission",
      });
    case "HostRequestInvalidError":
      return new LinkBlockedError({
        traceId: error.traceId,
        detail: "The environment rejected the authentication request.",
        reason: "configuration",
      });
    case "HostResourceNotFoundError":
      // Not expected during connection authorization, but the shared request
      // error type now includes it (used by resource fetches like the thread
      // snapshot). Treat it as a configuration issue with the endpoint.
      return new LinkBlockedError({
        traceId: error.traceId,
        detail: "The environment endpoint could not be found.",
        reason: "configuration",
      });
    case "RemoteHostAuthTimeoutError":
      return new LinkTransientError({
        reason: "timeout",
        detail: error.message,
      });
    case "RemoteHostAuthFetchError":
      return new LinkTransientError({
        reason: "network",
        detail: error.message,
      });
    case "HostInternalError":
      return new LinkTransientError({
        reason: "endpoint-unavailable",
        detail: "The environment could not authorize the connection.",
        traceId: error.traceId,
      });
    case "RemoteHostAuthInvalidJsonError":
    case "RemoteHostAuthUndeclaredStatusError":
      return new LinkTransientError({
        reason: "endpoint-unavailable",
        detail: error.message,
      });
  }
}

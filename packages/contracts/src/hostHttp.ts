import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";

import {
  AuthAccessTokenResult,
  AuthHostScope,
  AuthTokenExchangeRequest,
  AuthWebSocketTicketResult,
  BrowserAuthSessionRequest,
  BrowserAuthSessionResult,
  DaemonAuthSessionMethod,
  DaemonSessionState,
} from "./daemonAccess.ts";
import { DaemonSessionId, NonblankString, ThreadId } from "./primitives.ts";
import { ChatThreadDetailSnapshot } from "./chat.ts";
import { HostDescriptor } from "./host.ts";

// ---------------------------------------------------------------------------
// Typed errors. Clients match on the tag, so tags and statuses are part of the API.
// ---------------------------------------------------------------------------

export const HostRequestInvalidReason = Schema.Literals([
  ...(["invalid_scope", "scope_not_granted"] as const),
  "invalid_command",
]);
export type HostRequestInvalidReason = typeof HostRequestInvalidReason.Type;

export const HostAuthInvalidReason = Schema.Literals(["missing_credential", "invalid_credential"]);
export type HostAuthInvalidReason = typeof HostAuthInvalidReason.Type;

export const HostOperationForbiddenReason = Schema.Literals(["current_session_revoke_not_allowed"]);
export type HostOperationForbiddenReason = typeof HostOperationForbiddenReason.Type;

export const HostInternalErrorReason = Schema.Literals([
  ...(["bootstrap_validation_failed", "browser_session_issuance_failed"] as const),
  ...(["browser_session_cookie_failed", "access_token_issuance_failed"] as const),
  "websocket_ticket_issuance_failed",
  "chat_snapshot_failed",
  "chat_thread_snapshot_failed",
  "chat_dispatch_failed",
  "internal_error",
]);
export type HostInternalErrorReason = typeof HostInternalErrorReason.Type;

export const HostResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type HostResourceNotFoundReason = typeof HostResourceNotFoundReason.Type;

export class HostRequestInvalidError extends Schema.TaggedError<HostRequestInvalidError>()(
  "HostRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: HostRequestInvalidReason,
    traceId: NonblankString,
  },
  { httpApiStatus: 400 },
) {
  override get message() {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class HostAuthInvalidError extends Schema.TaggedError<HostAuthInvalidError>()(
  "HostAuthInvalidError",
  { code: Schema.Literal("auth_invalid"), reason: HostAuthInvalidReason, traceId: NonblankString },
  { httpApiStatus: 401 },
) {
  override get message() {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class HostScopeRequiredError extends Schema.TaggedError<HostScopeRequiredError>()(
  "HostScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthHostScope,
    traceId: NonblankString,
  },
  { httpApiStatus: 403 },
) {
  override get message() {
    return `This request needs the ${this.requiredScope} scope, which this client does not have.`;
  }
}

export class HostOperationForbiddenError extends Schema.TaggedError<HostOperationForbiddenError>()(
  "HostOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: HostOperationForbiddenReason,
    traceId: NonblankString,
  },
  { httpApiStatus: 403 },
) {
  override get message() {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class HostInternalError extends Schema.TaggedError<HostInternalError>()(
  "HostInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: HostInternalErrorReason,
    traceId: NonblankString,
  },
  { httpApiStatus: 500 },
) {
  override get message() {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export class HostResourceNotFoundError extends Schema.TaggedError<HostResourceNotFoundError>()(
  "HostResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: HostResourceNotFoundReason,
    traceId: NonblankString,
  },
  { httpApiStatus: 404 },
) {
  override get message() {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const HostHttpCommonError = Schema.Union([
  HostRequestInvalidError,
  HostAuthInvalidError,
  HostScopeRequiredError,
  HostOperationForbiddenError,
  HostInternalError,
  HostResourceNotFoundError,
]);
export type HostHttpCommonError = typeof HostHttpCommonError.Type;

const messageOnly = { message: Schema.String };

export class HostHttpBadRequestError extends Schema.TaggedError<HostHttpBadRequestError>()(
  "HostHttpBadRequestError",
  messageOnly,
  { httpApiStatus: 400 },
) {}
export class HostHttpUnauthorizedError extends Schema.TaggedError<HostHttpUnauthorizedError>()(
  "HostHttpUnauthorizedError",
  messageOnly,
  { httpApiStatus: 401 },
) {}
export class HostHttpForbiddenError extends Schema.TaggedError<HostHttpForbiddenError>()(
  "HostHttpForbiddenError",
  messageOnly,
  { httpApiStatus: 403 },
) {}
export class HostHttpInternalServerError extends Schema.TaggedError<HostHttpInternalServerError>()(
  "HostHttpInternalServerError",
  messageOnly,
  { httpApiStatus: 500 },
) {}
export class HostHttpConflictError extends Schema.TaggedError<HostHttpConflictError>()(
  "HostHttpConflictError",
  messageOnly,
  { httpApiStatus: 409 },
) {}

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

export interface HostSessionPrincipalShape {
  readonly sessionId: DaemonSessionId;
  readonly subject: string;
  readonly method: DaemonAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthHostScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class HostAuthenticatedPrincipal extends Context.Service<
  HostAuthenticatedPrincipal,
  HostSessionPrincipalShape
>()("@kora/contracts/hostHttp/HostAuthenticatedPrincipal") {}

export class HostAuthenticatedAuth extends HttpApiMiddleware.Service<
  HostAuthenticatedAuth,
  { provides: HostAuthenticatedPrincipal }
>()("HostAuthenticatedAuth", {
  error: [HostAuthInvalidError, HostInternalError],
}) {}

// ---------------------------------------------------------------------------
// The API. The bearer header is optional in the schema because a cookie session may
// authenticate the request instead.
// ---------------------------------------------------------------------------

const optionalAuthorization = { authorization: Schema.optional(Schema.String) };

const MetadataGroup = HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/kora/host", { success: HostDescriptor }),
);

const AuthGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("session", "/api/auth/session", {
    headers: optionalAuthorization,
    success: DaemonSessionState,
    error: [HostInternalError],
  }),
  HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
    payload: BrowserAuthSessionRequest,
    success: BrowserAuthSessionResult,
    error: [HostAuthInvalidError, HostInternalError],
  }),
  HttpApiEndpoint.post("token", "/oauth/token", {
    payload: AuthTokenExchangeRequest,
    success: AuthAccessTokenResult,
    error: [HostRequestInvalidError, HostAuthInvalidError, HostInternalError],
  }),
  HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
    headers: optionalAuthorization,
    success: AuthWebSocketTicketResult,
    error: [HostInternalError],
  }).middleware(HostAuthenticatedAuth),
);

const ChatGroup = HttpApiGroup.make("chat").add(
  HttpApiEndpoint.get("threadSnapshot", "/api/chat/threads/:threadId", {
    headers: optionalAuthorization,
    params: { threadId: ThreadId },
    // Omit both keys for the full snapshot; paging is opt-in per request.
    query: {
      turnLimit: Schema.optional(
        Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      ),
      beforeCursor: Schema.optional(NonblankString),
    },
    success: ChatThreadDetailSnapshot,
    error: [HostScopeRequiredError, HostResourceNotFoundError, HostInternalError],
  }).middleware(HostAuthenticatedAuth),
);

export class HostHttpApi extends HttpApi.make("environment")
  .add(MetadataGroup)
  .add(AuthGroup)
  .add(ChatGroup) {}

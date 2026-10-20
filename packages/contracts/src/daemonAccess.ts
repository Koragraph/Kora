import * as Schema from "effect/Schema";
import { HttpApiSchema } from "effect/unstable/httpapi";

import {
  ClientSurface,
  ClientWebDeployment,
  DaemonSessionId,
  NonblankString,
} from "./primitives.ts";

/** How a daemon expects clients to authenticate. */
export const DaemonAuthPolicy = Schema.Literals([
  ...(["desktop-managed-local", "loopback-browser"] as const),
  ...(["remote-reachable", "unsafe-no-auth"] as const),
]);
export type DaemonAuthPolicy = (typeof DaemonAuthPolicy)["Type"];

export const DaemonAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type DaemonAuthBootstrapMethod = typeof DaemonAuthBootstrapMethod.Type;

export const DaemonAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-access-token",
]);
export type DaemonAuthSessionMethod = typeof DaemonAuthSessionMethod.Type;

export const AuthHostScope = Schema.Literals([
  "chat:read",
  "chat:operate",
  ...(["terminal:operate", "review:write"] as const),
  ...(["access:read", "access:write"] as const),
]);
export type AuthHostScope = typeof AuthHostScope.Type;

export const AuthHostScopes = Schema.Array(AuthHostScope);
export type AuthHostScopes = typeof AuthHostScopes.Type;

export const AuthStandardClientScopes = [
  "chat:read",
  "chat:operate",
  "terminal:operate",
  "review:write",
] as const satisfies ReadonlyArray<AuthHostScope>;

export const AuthTokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
export const AccessTokenKind = "urn:ietf:params:oauth:token-type:access_token";
export const AuthHostBootstrapTokenType = "urn:kora:params:oauth:token-type:environment-bootstrap";

export const DaemonAuthDescriptor = Schema.Struct({
  policy: DaemonAuthPolicy,
  bootstrapMethods: Schema.Array(DaemonAuthBootstrapMethod),
  sessionMethods: Schema.Array(DaemonAuthSessionMethod),
  sessionCookieName: NonblankString,
});
export type DaemonAuthDescriptor = typeof DaemonAuthDescriptor.Type;

export const BrowserAuthSessionRequest = Schema.Struct({ credential: NonblankString });
export type BrowserAuthSessionRequest = typeof BrowserAuthSessionRequest.Type;

export const BrowserAuthSessionResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  scopes: AuthHostScopes,
  sessionMethod: DaemonAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type BrowserAuthSessionResult = typeof BrowserAuthSessionResult.Type;

const PHONE_SIZED_DEVICES = ["mobile", "tablet"] as const;
export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  ...PHONE_SIZED_DEVICES,
  ...(["bot", "unknown"] as const),
]);
export type AuthClientMetadataDeviceType = (typeof AuthClientMetadataDeviceType)["Type"];

const optionalNonblank = Schema.optionalKey(NonblankString);

export const AuthClientDisplayMetadata = Schema.Struct({
  webDeployment: Schema.optionalKey(ClientWebDeployment),
  surface: Schema.optionalKey(ClientSurface),
  appVersion: optionalNonblank,
  browser: optionalNonblank,
  deviceModel: optionalNonblank,
  osMajorVersion: Schema.optionalKey(Schema.Int),
  os: optionalNonblank,
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  label: optionalNonblank,
});
export type AuthClientDisplayMetadata = (typeof AuthClientDisplayMetadata)["Type"];

/** OAuth token exchange (form-encoded): a bootstrap token in, a bearer access token out. */
export const AuthTokenExchangeRequest = Schema.Struct({
  ...{
    grant_type: Schema.Literal(AuthTokenExchangeGrantType),
    subject_token: NonblankString,
  },
  // Key order is the form-encoded body order on the wire.
  subject_token_type: Schema.Literal(AuthHostBootstrapTokenType),
  requested_token_type: Schema.Literal(AccessTokenKind),
  ...{ scope: optionalNonblank, client_label: optionalNonblank },
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: optionalNonblank,
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = (typeof AuthTokenExchangeRequest)["Type"];

export const AuthAccessTokenResult = Schema.Struct({
  scope: NonblankString,
  expires_in: Schema.Number,
  token_type: Schema.Literal("Bearer"),
  issued_token_type: Schema.Literal(AccessTokenKind),
  access_token: NonblankString,
});
export type AuthAccessTokenResult = (typeof AuthAccessTokenResult)["Type"];

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: NonblankString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(NonblankString),
  ipAddress: Schema.optionalKey(NonblankString),
  userAgent: Schema.optionalKey(NonblankString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(NonblankString),
  browser: Schema.optionalKey(NonblankString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: DaemonSessionId,
  subject: NonblankString,
  scopes: AuthHostScopes,
  method: DaemonAuthSessionMethod,
  current: Schema.Boolean,
  connected: Schema.Boolean,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  expiresAt: Schema.DateTimeUtc,
  issuedAt: Schema.DateTimeUtc,
  client: AuthClientMetadata,
});
export type AuthClientSession = (typeof AuthClientSession)["Type"];

export class HostAuthorizationError extends Schema.TaggedError<HostAuthorizationError>()(
  "HostAuthorizationError",
  { message: Schema.String, requiredScope: AuthHostScope },
) {}

export const AuthRevokeClientSessionInput = Schema.Struct({ sessionId: DaemonSessionId });
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const DaemonSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: DaemonAuthDescriptor,
  scopes: Schema.optionalKey(AuthHostScopes),
  sessionMethod: Schema.optionalKey(DaemonAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type DaemonSessionState = typeof DaemonSessionState.Type;

import {
  type ClientLinkMethod,
  type AuthHostScope,
  type AuthClientDisplayMetadata,
  AuthTokenExchangeGrantType,
  AuthHostBootstrapTokenType,
  AccessTokenKind,
} from "@kora/contracts";
import { encodeOAuthScope } from "@kora/shared/oauthScopes";
import * as Effect from "effect/Effect";

import { hostEndpointUrl } from "../host/endpoint.ts";
import {
  type RemoteHostRequestError,
  makeHostHttpApiGroupClient,
  executeHostHttpRequest,
} from "../wire/http.ts";

export { RemoteHostAuthInvalidJsonError, RemoteHostAuthTimeoutError } from "../wire/http.ts";
export type RemoteHostAuthError = RemoteHostRequestError;

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

const bearerHeaders = (bearerToken: string) => ({ authorization: `Bearer ${bearerToken}` });

/**
 * Query parameters the server reads at the /ws upgrade. All optional: old servers ignore
 * unknown ones, and old clients never send them.
 */
export const appendClientLinkParams = (
  url: URL,
  clientMetadata: AuthClientDisplayMetadata | undefined,
  connectionMethod?: ClientLinkMethod,
): void => {
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined) url.searchParams.set(key, value);
  };

  set("clientSurface", clientMetadata?.surface);
  set("clientAppVersion", clientMetadata?.appVersion);
  if (clientMetadata?.deviceType !== undefined) {
    const deviceType = clientMetadata.deviceType;
    set(
      "clientDeviceType",
      deviceType === "mobile"
        ? "phone"
        : deviceType === "desktop" || deviceType === "tablet"
          ? deviceType
          : "unknown",
    );
  }
  set("clientOs", clientMetadata?.os);

  if (clientMetadata?.surface === "web") {
    set("clientWebDeployment", clientMetadata.webDeployment);
    set("clientBrowser", clientMetadata.browser);
  }
  if (clientMetadata?.surface === "mobile") {
    set(
      "clientOsMajorVersion",
      clientMetadata.osMajorVersion === undefined
        ? undefined
        : String(clientMetadata.osMajorVersion),
    );
    set("clientDeviceModel", clientMetadata.deviceModel);
  }
  set("connectionMethod", connectionMethod);
};

interface BearerCall {
  readonly timeoutMs?: number;
  readonly bearerToken: string;
  readonly httpBaseUrl: string;
}

type BootstrapRequest = Readonly<{
  credential: string;
  httpBaseUrl: string;
  scopes?: ReadonlyArray<AuthHostScope>;
  clientMetadata?: AuthClientDisplayMetadata;
  timeoutMs?: number;
}>;

const BOOTSTRAP_SPAN = "clientRuntime.authorization.bootstrapRemoteBearerSession";

export const bootstrapRemoteBearerSession = Effect.fn(BOOTSTRAP_SPAN)(function* (
  input: BootstrapRequest,
) {
  const client = yield* makeHostHttpApiGroupClient(input.httpBaseUrl, "auth");
  const metadata = input.clientMetadata;
  const os = metadata?.os;
  return yield* executeHostHttpRequest(
    hostEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.token({
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.credential,
        subject_token_type: AuthHostBootstrapTokenType,
        requested_token_type: AccessTokenKind,
        ...(input.scopes ? { scope: encodeOAuthScope(input.scopes) } : {}),
        ...(metadata?.label ? { client_label: metadata.label } : {}),
        ...(metadata?.deviceType ? { client_device_type: metadata.deviceType } : {}),
        ...(os && os !== "unknown" && os !== "other" ? { client_os: os } : {}),
      },
    }),
  );
});

export const fetchRemoteSessionState = Effect.fn(
  "clientRuntime.authorization.fetchRemoteSessionState",
)(function* (input: BearerCall) {
  const client = yield* makeHostHttpApiGroupClient(input.httpBaseUrl, "auth");
  return yield* executeHostHttpRequest(
    hostEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.session({ headers: bearerHeaders(input.bearerToken) }),
  );
});

export const issueRemoteWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteWebSocketTicket",
)(function* (input: BearerCall) {
  const client = yield* makeHostHttpApiGroupClient(input.httpBaseUrl, "auth");
  return yield* executeHostHttpRequest(
    hostEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.webSocketTicket({ headers: bearerHeaders(input.bearerToken) }),
  );
});

export const resolveRemoteWebSocketLinkUrl = Effect.fn(
  "clientRuntime.authorization.resolveRemoteWebSocketLinkUrl",
)(function* (
  input: BearerCall & {
    readonly wsBaseUrl: string;
    readonly clientMetadata?: AuthClientDisplayMetadata;
    readonly connectionMethod?: ClientLinkMethod;
  },
) {
  const ticket = yield* issueRemoteWebSocketTicket({
    bearerToken: input.bearerToken,
    httpBaseUrl: input.httpBaseUrl,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket.ticket);
  appendClientLinkParams(url, input.clientMetadata, input.connectionMethod);
  return url.toString();
});

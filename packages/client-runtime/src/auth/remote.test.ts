import { describe, expect, it } from "@effect/vitest";
import { HostAuthInvalidError } from "@kora/contracts";
import { Duration, Effect, Fiber, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { fetchRemoteHostDescriptor } from "../host/descriptor.ts";
import { remoteHttpClientLayer } from "../wire/http.ts";
import * as Remote from "./remote.ts";
import { RemoteHostAuthInvalidJsonError, RemoteHostAuthTimeoutError } from "./remote.ts";

const { appendClientLinkParams, resolveRemoteWebSocketLinkUrl } = Remote;
const { issueRemoteWebSocketTicket, fetchRemoteSessionState, bootstrapRemoteBearerSession } =
  Remote;

const isHostAuthInvalidError = Schema.is(HostAuthInvalidError);

const BASE = "https://remote.example.com/";
const FULL_SCOPE = "chat:read chat:operate terminal:operate review:write";

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

/** A fetch stand-in that logs each call and lets `answer` decide the reply to call n. */
const recordingFetch = (answer: (index: number) => Promise<Response>) => {
  const calls: Array<FetchCall> = [];
  const fetchFn: typeof fetch = (input, init) => answer(calls.push([input, init ?? {}]) - 1);
  return { calls, fetchFn };
};

/** Plays back `responses` in order; a call past the end rejects. */
const scriptedFetch = (...responses: ReadonlyArray<Response>) =>
  recordingFetch((index) =>
    index < responses.length
      ? Promise.resolve(responses[index]!)
      : Promise.reject(new Error("Unexpected fetch call")),
  );

/** A fetch that never answers. */
const stalledFetch = () => recordingFetch(() => new Promise<Response>(() => undefined));

const overFetch = (fetchFn: typeof fetch) => Effect.provide(remoteHttpClientLayer(fetchFn));

const jsonOk = (body: unknown) => Response.json(body, { status: 200 });

const tokenReply = (overrides: Record<string, unknown> = {}) =>
  jsonOk({
    scope: FULL_SCOPE,
    expires_in: 3600,
    token_type: "Bearer",
    access_token: "bearer-token",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    ...overrides,
  });

/** The urlencoded token-exchange body the client is expected to post. */
const exchangeBody = (...extraPairs: ReadonlyArray<string>) =>
  [
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
    "subject_token=pairing-token",
    "subject_token_type=urn%3Akora%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap",
    "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
    ...extraPairs,
  ].join("&");

const tokenRequest = { httpBaseUrl: BASE, credential: "pairing-token" } as const;

type ExpectedCall = Readonly<
  Record<"method" | "url", string> & Partial<{ body: string; headers: Record<string, string> }>
>;

function expectCall(calls: ReadonlyArray<FetchCall>, position: number, expected: ExpectedCall) {
  const call = calls[position - 1];
  expect(call).toBeDefined();
  if (!call) return;

  const [url, init] = call;
  expect(String(url)).toBe(expected.url);
  expect(init).toEqual(expect.objectContaining({ method: expected.method }));
  expect(init.headers).toEqual(expect.objectContaining(expected.headers ?? {}));

  if ("body" in expected) {
    const sent = init.body;
    if (typeof sent === "string") {
      expect(sent).toBe(expected.body);
    } else if (sent instanceof Uint8Array) {
      expect(new TextDecoder().decode(sent)).toBe(expected.body);
    } else {
      throw new Error("Expected fetch request body");
    }
  }
}

describe("remote environment authorization", () => {
  describe("token exchange", () => {
    it.effect("exchanges a pairing token for a bearer session", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(tokenReply());

        const session = yield* bootstrapRemoteBearerSession(tokenRequest).pipe(
          overFetch(http.fetchFn),
        );

        expect(session).toMatchObject({
          token_type: "Bearer",
          access_token: "bearer-token",
          scope: FULL_SCOPE,
        });
        expectCall(http.calls, 1, {
          url: `${BASE}oauth/token`,
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: exchangeBody(),
        });
      }),
    );

    it.effect("includes the client display metadata when it is given", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(tokenReply());

        yield* bootstrapRemoteBearerSession({
          ...tokenRequest,
          clientMetadata: { label: "Kora Mobile", deviceType: "mobile", os: "iOS" },
        }).pipe(overFetch(http.fetchFn));

        expectCall(http.calls, 1, {
          url: `${BASE}oauth/token`,
          method: "POST",
          body: exchangeBody(
            "client_label=Kora+Mobile",
            "client_device_type=mobile",
            "client_os=iOS",
          ),
        });
      }),
    );

    it.effect("sends OS sentinels to telemetry only, never as display metadata", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(
          tokenReply({ scope: "chat:read" }),
          tokenReply({ scope: "chat:read" }),
        );

        for (const os of ["unknown", "other"] as const) {
          yield* bootstrapRemoteBearerSession({
            ...tokenRequest,
            clientMetadata: { label: "Kora Web", deviceType: "desktop", os },
          }).pipe(overFetch(http.fetchFn));
        }

        for (const [, init] of http.calls) {
          expect(String(init.body)).not.toContain("client_os=");
        }

        const socketUrl = new URL("wss://remote.example.com/ws");
        appendClientLinkParams(socketUrl, { surface: "web", deviceType: "desktop", os: "unknown" });
        expect(socketUrl.searchParams.get("clientOs")).toBe("unknown");
      }),
    );

    it.effect("lets the client ask for a narrower grant than the pairing allows", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(
          tokenReply({ access_token: "read-only-token", scope: "chat:read" }),
        );

        yield* bootstrapRemoteBearerSession({ ...tokenRequest, scopes: ["chat:read"] }).pipe(
          overFetch(http.fetchFn),
        );

        expectCall(http.calls, 1, {
          url: `${BASE}oauth/token`,
          method: "POST",
          body: exchangeBody("scope=chat%3Aread"),
        });
      }),
    );

    it.effect("reports a well-formed but invalid token reply as an invalid response", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(tokenReply({ access_token: "" }));

        const error = yield* bootstrapRemoteBearerSession(tokenRequest).pipe(
          overFetch(http.fetchFn),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(RemoteHostAuthInvalidJsonError);
        expect(error.message).toBe(
          "Remote environment endpoint returned an invalid response from https://remote.example.com/oauth/token.",
        );
      }),
    );

    it.effect("turns a declared typed error in a 401 body back into that error", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(
          Response.json(
            {
              traceId: "trace-auth-test",
              reason: "missing_credential",
              _tag: "HostAuthInvalidError",
              code: "auth_invalid",
            },
            { status: 401 },
          ),
        );

        const expired = { bearerToken: "expired-token", httpBaseUrl: BASE };
        const error = yield* Effect.flip(
          issueRemoteWebSocketTicket(expired).pipe(overFetch(http.fetchFn)),
        );

        expect(isHostAuthInvalidError(error)).toBe(true);
        if (isHostAuthInvalidError(error)) {
          expect(error.reason).toBe("missing_credential");
          expect(error.traceId).toBe("trace-auth-test");
        }
      }),
    );
  });

  describe("session endpoints", () => {
    it.effect("reads the host descriptor, session and ws ticket with bearer auth", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(
          jsonOk({
            capabilities: { repositoryIdentity: true },
            serverVersion: "0.0.0-test",
            platform: { arch: "x64", os: "linux" },
            label: "Remote environment",
            hostId: "environment-remote",
          }),
          jsonOk({
            auth: {
              sessionCookieName: "kora_session",
              sessionMethods: ["browser-session-cookie", "bearer-access-token"],
              bootstrapMethods: ["one-time-token"],
              policy: "remote-reachable",
            },
            authenticated: true,
            scopes: FULL_SCOPE.split(" "),
            sessionMethod: "bearer-access-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
          }),
          jsonOk({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
        );
        const run = overFetch(http.fetchFn);
        const bearer = { httpBaseUrl: BASE, bearerToken: "bearer-token" } as const;

        const descriptor = yield* fetchRemoteHostDescriptor({ httpBaseUrl: BASE }).pipe(run);
        expect(descriptor).toMatchObject({
          hostId: "environment-remote",
          label: "Remote environment",
        });

        const session = yield* fetchRemoteSessionState(bearer).pipe(run);
        expect(session).toMatchObject({ authenticated: true, scopes: FULL_SCOPE.split(" ") });

        const ticket = yield* issueRemoteWebSocketTicket(bearer).pipe(run);
        expect(ticket).toMatchObject({ ticket: "ws-ticket" });

        const authorized = { authorization: "Bearer bearer-token" };
        expectCall(http.calls, 1, { url: `${BASE}.well-known/kora/host`, method: "GET" });
        expectCall(http.calls, 2, {
          url: `${BASE}api/auth/session`,
          method: "GET",
          headers: authorized,
        });
        expectCall(http.calls, 3, {
          url: `${BASE}api/auth/websocket-ticket`,
          method: "POST",
          headers: authorized,
        });
      }),
    );

    it.effect("fails a request that hangs once the configured timeout passes", () =>
      Effect.gen(function* () {
        const http = stalledFetch();

        const pending = yield* fetchRemoteHostDescriptor({
          httpBaseUrl: "http://remote.example.com/",
          timeoutMs: 25,
        }).pipe(overFetch(http.fetchFn), Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(25));
        const error = yield* Fiber.join(pending);

        expect(error).toBeInstanceOf(RemoteHostAuthTimeoutError);
        expect(error.message).toBe(
          "Remote environment endpoint http://remote.example.com/.well-known/kora/host timed out after 25ms.",
        );
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("builds a websocket url on the rpc route with a short-lived ticket", () =>
      Effect.gen(function* () {
        const http = scriptedFetch(
          jsonOk({ ticket: "ws-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
        );

        const url = yield* resolveRemoteWebSocketLinkUrl({
          wsBaseUrl: "wss://remote.example.com/",
          httpBaseUrl: BASE,
          bearerToken: "bearer-token",
          clientMetadata: {
            deviceModel: "Pixel 9",
            os: "Android",
            osMajorVersion: 15,
            deviceType: "mobile",
            surface: "mobile",
            appVersion: "1.2.3",
          },
          connectionMethod: "direct",
        }).pipe(overFetch(http.fetchFn));

        expect(url).toBe(
          "wss://remote.example.com/ws?wsTicket=ws-ticket&clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+9&connectionMethod=direct",
        );
      }),
    );
  });
});

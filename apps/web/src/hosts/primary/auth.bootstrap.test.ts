import {
  HostAuthInvalidError,
  type BrowserAuthSessionResult,
  type DaemonSessionState,
  type ShellBridge,
} from "@kora/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installHostHttpTest } from "../../../test/hostHttpTest";
import { __setPrimaryHttpRunnerForTests, type PrimaryHttpEffectRunner } from "../../util/runtime";

type AuthInfo = DaemonSessionState["auth"];
interface StubWindow {
  location: URL;
  history: { replaceState: (data: unknown, unused: string, url: string) => void };
  shellBridge?: ShellBridge;
}

const loopbackAuth = {
  policy: "loopback-browser",
  sessionCookieName: "kora_sess",
  sessionMethods: ["browser-session-cookie"],
  bootstrapMethods: ["one-time-token"],
} as AuthInfo;
const desktopAuth = {
  policy: "desktop-managed-local",
  sessionCookieName: "kora_sess",
  sessionMethods: ["browser-session-cookie"],
  bootstrapMethods: ["desktop-bootstrap"],
} as AuthInfo;

const sessionExpiry = DateTime.makeUnsafe("2026-06-10T00:00:00.000Z");
const loggedOut = (auth: AuthInfo): DaemonSessionState => ({ authenticated: false, auth });
const loggedIn = (auth: AuthInfo): DaemonSessionState => ({
  authenticated: true,
  auth,
  sessionMethod: "browser-session-cookie",
  expiresAt: sessionExpiry,
});
const exchangeOk = (scopes: BrowserAuthSessionResult["scopes"]): BrowserAuthSessionResult => ({
  authenticated: true,
  scopes,
  sessionMethod: "browser-session-cookie",
  expiresAt: sessionExpiry,
});
const allScopes = ["chat:read", "access:write"] as BrowserAuthSessionResult["scopes"];

/** Returns each value in turn from a call counter, then keeps returning the last. */
function sequence<T>(...values: T[]): () => T {
  let next = 0;
  return () => values[Math.min(next++, values.length - 1)]!;
}

function openPage(url: string): StubWindow {
  const page: StubWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data, _unused, target) =>
        void (page.location = new URL(target, page.location.href)),
    },
  };
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { title: "Kora" });
  return page;
}

interface ShellHost {
  httpBaseUrl: string;
  wsBaseUrl: string;
  bootstrapToken?: string;
}

/** A desktop shell offering one local host. */
function openDesktopShell(host: ShellHost) {
  const page = openPage(
    host.httpBaseUrl.includes("6200") ? "http://127.0.0.1:6200/" : "http://localhost/",
  );
  page.shellBridge = {
    getLocalHostBootstraps: () => [{ id: "primary", label: "Local", ...host }],
  } as unknown as ShellBridge;
}
const tokenHost: ShellHost = {
  bootstrapToken: "shell-token-xyz",
  httpBaseUrl: "http://localhost:4100",
  wsBaseUrl: "ws://localhost:4100",
};

let teardownDaemon: (() => Promise<void>) | undefined;
async function startDaemon(script: {
  session?: () => DaemonSessionState;
  exchange?: (credential: string) => Effect.Effect<BrowserAuthSessionResult, HostAuthInvalidError>;
}) {
  const daemon = await installHostHttpTest({
    ...(script.session ? { session: () => Effect.succeed(script.session!()) } : {}),
    ...(script.exchange ? { browserSession: (body) => script.exchange!(body.credential) } : {}),
  });
  teardownDaemon = daemon.dispose;
  return daemon;
}
const loadPrimary = () => import(".");

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  openPage("http://localhost/");
});

afterEach(async () => {
  await teardownDaemon?.();
  teardownDaemon = undefined;
  (await loadPrimary()).__resetDaemonAuthBootstrapForTests();
  __setPrimaryHttpRunnerForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("initial auth gate: no bootstrap needed", () => {
  it("lets an already signed-in page through without exchanging anything", async () => {
    const daemon = await startDaemon({
      session: () => loggedIn(loopbackAuth),
      exchange: () => Effect.succeed(exchangeOk(["chat:read"])),
    });
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    await expect(resolveInitialDaemonAuthGateState()).resolves.toEqual({ status: "authenticated" });
    expect(daemon.calls.browserSession).toEqual([]);
  });

  it("remembers a successful authenticated read instead of asking again", async () => {
    const daemon = await startDaemon({
      session: sequence(loggedIn(loopbackAuth), loggedOut(loopbackAuth)),
    });
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    await resolveInitialDaemonAuthGateState();
    await expect(resolveInitialDaemonAuthGateState()).resolves.toEqual({ status: "authenticated" });
    expect(daemon.calls.session).toBe(1);
  });

  it("answers requires-auth (not an exception) when signed out and nothing to exchange", async () => {
    await startDaemon({ session: () => loggedOut(loopbackAuth) });
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    await expect(resolveInitialDaemonAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: loopbackAuth,
    });
  });
});

describe("initial auth gate: desktop token exchange", () => {
  it("keeps polling the session until it reports authenticated", async () => {
    vi.useFakeTimers();
    const daemon = await startDaemon({
      session: sequence(loggedOut(desktopAuth), loggedOut(desktopAuth), loggedIn(desktopAuth)),
      exchange: () => Effect.succeed(exchangeOk(allScopes)),
    });
    openDesktopShell(tokenHost);
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    const outcome = resolveInitialDaemonAuthGateState();
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toEqual({ status: "authenticated" });
    expect(daemon.calls.session).toBe(3);
  });

  it("gives up with a timeout message when the session never turns authenticated", async () => {
    vi.useFakeTimers();
    const daemon = await startDaemon({
      session: () => loggedOut(desktopAuth),
      exchange: () => Effect.succeed(exchangeOk(allScopes)),
    });
    openDesktopShell(tokenHost);
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    const outcome = resolveInitialDaemonAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toEqual({
      status: "requires-auth",
      auth: desktopAuth,
      errorMessage: "Timed out waiting for authenticated session after bootstrap.",
    });
    expect(daemon.calls.browserSession).toEqual([{ credential: "shell-token-xyz" }]);
  });

  it("runs a single exchange for callers that overlap", async () => {
    const daemon = await startDaemon({
      session: sequence(loggedOut(desktopAuth), loggedIn(desktopAuth)),
      exchange: () => Effect.succeed(exchangeOk(allScopes)),
    });
    openDesktopShell(tokenHost);
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    await Promise.all([resolveInitialDaemonAuthGateState(), resolveInitialDaemonAuthGateState()]);

    expect(daemon.calls.session).toBe(2);
    expect(daemon.calls.browserSession).toEqual([{ credential: "shell-token-xyz" }]);
  });
});

describe("retries and base URLs", () => {
  it("retries a session request that keeps failing with 502 until it succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const gatewayResponse = HttpClientResponse.fromWeb(
      request,
      new Response("Bad Gateway", { status: 502 }),
    );
    const flakyRunner: PrimaryHttpEffectRunner = async <A>() => {
      attempt += 1;
      if (attempt < 4) {
        throw new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({ request, response: gatewayResponse }),
        });
      }
      return loggedOut(loopbackAuth) as A;
    };
    __setPrimaryHttpRunnerForTests(flakyRunner);
    const { resolveInitialDaemonAuthGateState } = await loadPrimary();

    const outcome = resolveInitialDaemonAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toEqual({ status: "requires-auth", auth: loopbackAuth });
    expect(attempt).toBe(4);
  });

  it("uses the Vite dev server as the base for a desktop-managed host in local dev", async () => {
    await startDaemon({ session: () => loggedOut(desktopAuth) });
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:6200");
    openDesktopShell({ httpBaseUrl: "http://127.0.0.1:6200", wsBaseUrl: "ws://127.0.0.1:4100" });
    const { resolveInitialDaemonAuthGateState, resolvePrimaryHostHttpUrl } = await loadPrimary();

    await expect(resolveInitialDaemonAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: desktopAuth,
    });
    expect(resolvePrimaryHostHttpUrl("/api/auth/session")).toBe(
      "http://127.0.0.1:6200/api/auth/session",
    );
  });

  it("uses the page origin as the base when a browser is served from a dev port", async () => {
    await startDaemon({ session: () => loggedOut(loopbackAuth) });
    openPage("http://localhost:6300/");
    const { resolveInitialDaemonAuthGateState, resolvePrimaryHostHttpUrl } = await loadPrimary();

    await expect(resolveInitialDaemonAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: loopbackAuth,
    });
    expect(resolvePrimaryHostHttpUrl("/api/auth/session")).toBe(
      "http://localhost:6300/api/auth/session",
    );
  });

  it("turns a wss primary host into https request URLs", async () => {
    await startDaemon({ session: () => loggedOut(loopbackAuth) });
    vi.stubEnv("VITE_HTTP_URL", "https://daemon.example.net");
    vi.stubEnv("VITE_WS_URL", "wss://daemon.example.net");
    const { resolveInitialDaemonAuthGateState, resolvePrimaryHostHttpUrl } = await loadPrimary();

    await resolveInitialDaemonAuthGateState();

    expect(resolvePrimaryHostHttpUrl("/api/auth/session")).toBe(
      "https://daemon.example.net/api/auth/session",
    );
  });
});

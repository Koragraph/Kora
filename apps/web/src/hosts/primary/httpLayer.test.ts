import { makeHostHttpApiClient } from "@kora/client-runtime/wire";
import type { ShellBridge } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";

// In every case below the primary host is the daemon on 127.0.0.1:3773.
vi.mock("./target", () => ({
  resolvePrimaryHostHttpUrl: (pathname: string) => new URL(pathname, "http://127.0.0.1:3773").href,
}));

import { isPrimaryRequestUrl, makePrimaryHostHttpLayer } from "./httpLayer";
import { __resetShellPrimaryAuthForTests, __setPrimaryIdentityForTests } from "./shellAuth";

const DAEMON = "http://127.0.0.1:3773";
const BEARER = "desktop-bearer-token";

/** Stub `fetch` and a `window` that behaves like the desktop app (or a plain browser when `shell` is false). */
function stubTransport(opts: { shell: boolean }) {
  const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  const win = opts.shell
    ? {
        location: { origin: "kora://app" },
        shellBridge: {
          getLocalHostBearerToken: vi.fn().mockResolvedValue(BEARER),
          getLocalHostBootstrap: () => ({
            bootstrapToken: "desktop-bootstrap-token",
            httpBaseUrl: DAEMON,
            wsBaseUrl: "ws://127.0.0.1:3773",
            label: "Local environment",
          }),
        } as unknown as ShellBridge,
      }
    : { location: { origin: DAEMON, href: `${DAEMON}/settings` } };
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  return fetchSpy;
}
/** The request that fetch was last (or nth) called with. */
const sent = (spy: ReturnType<typeof vi.fn>, n = 0) =>
  new Request(spy.mock.calls[n]?.[0], spy.mock.calls[n]?.[1]);

describe.sequential("primary host HTTP layer", () => {
  beforeEach(() => {
    __setPrimaryIdentityForTests({ verifier: () => Promise.resolve() });
  });
  afterEach(() => {
    __resetShellPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it("only the daemon's own URLs (absolute or relative) count as primary requests", () => {
    for (const url of ["/api/auth/session", "api/x", `${DAEMON}/api/x`]) {
      expect(isPrimaryRequestUrl(url), url).toBe(true);
    }
    for (const url of [
      "//evil.example/x",
      "https://evil.example/x",
      "http://localhost:3773/api/x",
    ]) {
      expect(isPrimaryRequestUrl(url), url).toBe(false);
    }
  });

  // HttpApiClient prepends its base URL AFTER the bearer mapper runs, so its calls arrive relative. Treating
  // those as foreign sent every API call unauthenticated and the desktop app never got past session fetch (401).
  it.effect("API-client calls, which arrive relative, still get the bearer", () => {
    const spy = stubTransport({ shell: true });
    return Effect.gen(function* () {
      const client = yield* makeHostHttpApiClient(`${DAEMON}/`);
      yield* Effect.exit(client.auth.session({ headers: {} }));
      const request = sent(spy);
      expect(request.url).toBe(`${DAEMON}/api/auth/session`);
      expect(request.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    }).pipe(Effect.provide(makePrimaryHostHttpLayer()));
  });

  it.effect("desktop-managed primaries use the bearer and no cookies", () => {
    const spy = stubTransport({ shell: true });
    return Effect.gen(function* () {
      yield* HttpClient.get(`${DAEMON}/api/connect/link-state`);
      const request = sent(spy);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
    }).pipe(Effect.provide(makePrimaryHostHttpLayer()));
  });

  it.effect("browser primaries use cookie credentials and no bearer", () => {
    const spy = stubTransport({ shell: false });
    return Effect.gen(function* () {
      yield* HttpClient.get(`${DAEMON}/api/auth/session`);
      const request = sent(spy);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(makePrimaryHostHttpLayer()));
  });

  it.effect("the bearer is never sent to another origin", () => {
    const spy = stubTransport({ shell: true });
    return Effect.gen(function* () {
      for (const url of [
        "https://evil.example/collect",
        "http://127.0.0.1:3774/api/x",
        "http://localhost:3773/api/x",
      ]) {
        spy.mockClear();
        yield* HttpClient.get(url);
        expect(sent(spy).headers.get("authorization"), url).toBeNull();
      }
    }).pipe(Effect.provide(makePrimaryHostHttpLayer()));
  });

  it.effect("nothing is sent with the bearer when the daemon cannot prove its identity", () => {
    const spy = stubTransport({ shell: true });
    __setPrimaryIdentityForTests({ verifier: () => Promise.reject(new Error("mismatch")) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(HttpClient.get(`${DAEMON}/api/x`));
      expect(exit._tag).toBe("Failure");
      expect(spy).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makePrimaryHostHttpLayer()));
  });
});

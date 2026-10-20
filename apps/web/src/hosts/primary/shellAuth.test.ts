import {
  readVerifiedShellPrimaryBearerToken,
  readShellPrimaryBearerToken,
  invalidatePrimaryHostIdentity,
  fetchPrimaryHost,
  __setPrimaryIdentityForTests,
  __resetShellPrimaryAuthForTests,
  PrimaryHostIdentityError,
} from "./shellAuth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ShellBridge } from "@kora/contracts";

vi.mock("./target", () => ({
  resolvePrimaryHostHttpUrl: (pathname: string) => new URL(pathname, "http://127.0.0.1:8797").href,
}));

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    // Default: the daemon proves its identity.
    __setPrimaryIdentityForTests({ verifier: () => Promise.resolve() });
  });

  afterEach(() => {
    __resetShellPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  describe("daemon identity gate", () => {
    const bridgeWithToken = () => {
      window.shellBridge = {
        getLocalHostBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
      } as unknown as ShellBridge;
    };

    it("needs no proof in a browser (no bearer; the Vite dev proxy authenticates)", async () => {
      const verifier = vi.fn(() => Promise.resolve());
      __setPrimaryIdentityForTests({ verifier });
      await expect(readVerifiedShellPrimaryBearerToken({ fresh: true })).resolves.toBeNull();
      expect(verifier).not.toHaveBeenCalled();
    });

    it("shares one in-flight proof between concurrent requests", async () => {
      bridgeWithToken();
      let release!: () => void;
      const verifier = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      __setPrimaryIdentityForTests({ verifier });
      const first = readVerifiedShellPrimaryBearerToken();
      const second = readVerifiedShellPrimaryBearerToken();
      await Promise.resolve();
      await Promise.resolve();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([
        "desktop-bearer-token",
        "desktop-bearer-token",
      ]);
      expect(verifier).toHaveBeenCalledTimes(1);
    });

    it("a port taken over after a good proof never receives the bearer", async () => {
      bridgeWithToken();
      let daemonUp = true;
      __setPrimaryIdentityForTests({
        verifier: () => (daemonUp ? Promise.resolve() : Promise.reject(new Error("mismatch"))),
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        await fetchPrimaryHost("http://127.0.0.1:8797/api/graph/status");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        daemonUp = false; // the daemon stopped and something else bound the port
        await expect(fetchPrimaryHost("http://127.0.0.1:8797/api/graph/status")).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("never reuses a finished proof: every credentialed send re-proves; concurrent sends share one check", async () => {
      bridgeWithToken();
      const verifier = vi.fn(() => Promise.resolve());
      __setPrimaryIdentityForTests({ verifier });

      await readVerifiedShellPrimaryBearerToken();
      await readVerifiedShellPrimaryBearerToken();
      expect(verifier).toHaveBeenCalledTimes(2);

      await Promise.all([
        readVerifiedShellPrimaryBearerToken(),
        readVerifiedShellPrimaryBearerToken(),
      ]);
      expect(verifier).toHaveBeenCalledTimes(3);

      await expect(readVerifiedShellPrimaryBearerToken({ fresh: true })).resolves.toBe(
        "desktop-bearer-token",
      );
      expect(verifier).toHaveBeenCalledTimes(4);
    });

    it("sends nothing to a server that fails the proof (port squatter)", async () => {
      bridgeWithToken();
      __setPrimaryIdentityForTests({
        verifier: () => Promise.reject(new Error("could not prove it is this Mac's Kora daemon")),
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(fetchPrimaryHost("http://127.0.0.1:8797/api/x")).rejects.toBeInstanceOf(
          PrimaryHostIdentityError,
        );
        await expect(readVerifiedShellPrimaryBearerToken()).rejects.toBeInstanceOf(
          PrimaryHostIdentityError,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("verifies over a credential-free check before the bearer is ever sent", async () => {
      bridgeWithToken();
      const order: string[] = [];
      const verifier = vi.fn(async (input: { httpBaseUrl: string; secret: string }) => {
        order.push(`verify ${input.httpBaseUrl}`);
      });
      __setPrimaryIdentityForTests({ verifier });
      const fetchMock = vi.fn(async (url: string) => {
        order.push(`fetch ${url}`);
        return new Response("{}");
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        await fetchPrimaryHost("http://127.0.0.1:8797/api/x");
        expect(order).toEqual([
          "verify http://127.0.0.1:8797/",
          "fetch http://127.0.0.1:8797/api/x",
        ]);
        expect(verifier).toHaveBeenCalledWith({
          secret: "desktop-bearer-token",
          httpBaseUrl: "http://127.0.0.1:8797/",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("attaches the desktop bearer to primary-host fetches only", async () => {
    window.shellBridge = {
      getLocalHostBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
    } as unknown as ShellBridge;
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchPrimaryHost("http://127.0.0.1:8797/api/graph/status?cwd=/r", { method: "POST" });
      const [, primaryInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new Headers(primaryInit.headers).get("authorization")).toBe(
        "Bearer desktop-bearer-token",
      );
      expect(primaryInit.method).toBe("POST");

      await fetchPrimaryHost("http://other-host.test:8797/api/graph/status");
      const [, otherInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(new Headers(otherInit.headers).get("authorization")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readShellPrimaryBearerToken()).resolves.toBeNull();
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalHostBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.shellBridge = {
      getLocalHostBearerToken,
    } as unknown as ShellBridge;

    await expect(readShellPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readShellPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalHostBearerToken).toHaveBeenCalledTimes(1);
  });
});

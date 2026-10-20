import { HostId, type HostDescriptor } from "@kora/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installHostHttpTest } from "../../../test/hostHttpTest";
import {
  getPrimaryKnownHost,
  isPrimaryHostProtocolUnsupportedError,
  isPrimaryHostUrlInvalidError,
  isShellHostBootstrapIncompleteError,
  readPrimaryHostTarget,
  resetPrimaryHostDescriptorForTests,
  resolveInitialPrimaryHostDescriptor,
  resolvePrimaryHostHttpUrl,
  writePrimaryHostDescriptor,
} from ".";

const hostDescriptor = {
  hostId: HostId.make("host-main"),
  label: "Main host",
  serverVersion: "9.9.9-test",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: { repositoryIdentity: true },
} satisfies HostDescriptor;

const WELL_KNOWN_PATH = "/.well-known/kora/host";
const REMOTE_ORIGIN = "https://daemon.example.net";
const REMOTE_PAIR = { httpBaseUrl: `${REMOTE_ORIGIN}/`, wsBaseUrl: "wss://daemon.example.net/" };

let teardownDaemon: (() => Promise<void>) | undefined;

/** An in-process daemon that answers the descriptor request. */
async function startDaemon() {
  const daemon = await installHostHttpTest({ descriptor: () => Effect.succeed(hostDescriptor) });
  teardownDaemon = daemon.dispose;
  return daemon;
}

const openPage = (url: string) =>
  vi.stubGlobal("window", { history: { replaceState: vi.fn() }, location: new URL(url) });

/** A desktop shell that reports one local host built from `fields`. */
function openShellPage(fields: Record<string, unknown>, url: string) {
  vi.stubGlobal("window", {
    shellBridge: {
      getLocalHostBootstraps: () => [{ id: "primary", label: "Main host", ...fields }],
    },
    history: { replaceState: vi.fn() },
    location: new URL(url),
  });
}

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  throw new Error("the call did not throw");
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  openPage("http://localhost/");
});

afterEach(async () => {
  await teardownDaemon?.();
  teardownDaemon = undefined;
  resetPrimaryHostDescriptorForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readPrimaryHostTarget failures", () => {
  it("rejects a window origin whose protocol is not http(s)", () => {
    vi.stubGlobal("window", {
      history: { replaceState: vi.fn() },
      location: { origin: "file:///var/app/" },
    });

    const failure = catchError(readPrimaryHostTarget);

    expect(isPrimaryHostProtocolUnsupportedError(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "The window-origin primary environment target uses unsupported protocol file:.",
    );
    expect(failure).toMatchObject({ protocol: "file:", source: "window-origin" });
  });

  it("names the endpoint a half-filled desktop bootstrap lacks", () => {
    openShellPage(
      { bootstrapToken: "tok", httpBaseUrl: "http://127.0.0.1:4100" },
      "http://127.0.0.1:6200/",
    );

    const failure = catchError(readPrimaryHostTarget);

    expect(isShellHostBootstrapIncompleteError(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "Desktop bootstrap is missing wsBaseUrl for the local environment.",
    );
    expect(failure).toMatchObject({ hasWsBaseUrl: false, hasHttpBaseUrl: true });
  });

  it("wraps the parser's error for a malformed configured URL without echoing the URL", () => {
    vi.stubEnv("VITE_HTTP_URL", "http://[");

    const failure = catchError(readPrimaryHostTarget) as Error;

    expect(isPrimaryHostUrlInvalidError(failure)).toBe(true);
    expect(failure.message).toBe(
      "Could not parse http-base-url for the configured primary environment target.",
    );
    expect(failure).toMatchObject({ urlKind: "http-base-url", source: "configured" });
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(failure.message).not.toContain("http://[");
  });
});

describe("readPrimaryHostTarget scheme handling", () => {
  it.each([
    ["VITE_HTTP_URL", "HTTPS://daemon.example.net"],
    ["VITE_WS_URL", "WSS://daemon.example.net"],
  ])("normalises an upper-case scheme in %s", (variable, value) => {
    vi.stubEnv(variable, value);
    expect(readPrimaryHostTarget()?.target).toEqual(REMOTE_PAIR);
  });
});

describe("descriptor resolution", () => {
  it.each([
    ["an http URL", { VITE_HTTP_URL: REMOTE_ORIGIN }],
    ["a ws URL", { VITE_WS_URL: "wss://daemon.example.net" }],
    ["both URLs", { VITE_HTTP_URL: REMOTE_ORIGIN, VITE_WS_URL: "wss://daemon.example.net" }],
  ])("derives the missing half when configured with %s", async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await startDaemon();

    await expect(resolveInitialPrimaryHostDescriptor()).resolves.toEqual(hostDescriptor);

    expect(resolvePrimaryHostHttpUrl(WELL_KNOWN_PATH)).toBe(`${REMOTE_ORIGIN}${WELL_KNOWN_PATH}`);
    expect(getPrimaryKnownHost()?.target).toEqual(REMOTE_PAIR);
  });

  it("sends a desktop-managed loopback host through the dev server's proxy", async () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:6200");
    openShellPage(
      {
        bootstrapToken: "tok",
        httpBaseUrl: "http://127.0.0.1:4100",
        wsBaseUrl: "ws://127.0.0.1:4100",
      },
      "http://127.0.0.1:6200/",
    );
    await startDaemon();

    await expect(resolveInitialPrimaryHostDescriptor()).resolves.toEqual(hostDescriptor);

    expect(resolvePrimaryHostHttpUrl(WELL_KNOWN_PATH)).toBe(
      `http://127.0.0.1:6200${WELL_KNOWN_PATH}`,
    );
  });

  it("falls back to the page's own origin in a plain dev browser", async () => {
    openPage("http://localhost:6300/");
    await startDaemon();

    await expect(resolveInitialPrimaryHostDescriptor()).resolves.toEqual(hostDescriptor);

    expect(resolvePrimaryHostHttpUrl(WELL_KNOWN_PATH)).toBe(
      `http://localhost:6300${WELL_KNOWN_PATH}`,
    );
  });

  it("issues a single request for simultaneous callers", async () => {
    const daemon = await startDaemon();

    await Promise.all([
      resolveInitialPrimaryHostDescriptor(),
      resolveInitialPrimaryHostDescriptor(),
    ]);

    expect(daemon.calls.descriptor).toBe(1);
  });
});

describe("resolvePrimaryHostHttpUrl", () => {
  beforeEach(() => openPage("http://127.0.0.1:9000/"));

  it("adds a query object as search params", () => {
    expect(resolvePrimaryHostHttpUrl("/api/things/clear", { thingId: "t_7" })).toBe(
      "http://127.0.0.1:9000/api/things/clear?thingId=t_7",
    );
  });

  it("splits a '?' out of the path instead of encoding it, merging with the query object", () => {
    expect(resolvePrimaryHostHttpUrl("/api/things/clear?thingId=a%20b", { extra: "1" })).toBe(
      "http://127.0.0.1:9000/api/things/clear?thingId=a+b&extra=1",
    );
  });

  it("leaves a bare path alone", () => {
    expect(resolvePrimaryHostHttpUrl("/api/plain")).toBe("http://127.0.0.1:9000/api/plain");
  });
});

describe("writePrimaryHostDescriptor", () => {
  it("attaches the descriptor to the host known from the window origin", () => {
    vi.stubGlobal("window", {
      shellBridge: undefined,
      location: { origin: "http://localhost:4100" },
    });

    writePrimaryHostDescriptor({ ...hostDescriptor, label: "Seeded host" });

    expect(getPrimaryKnownHost()).toEqual({
      id: "host-main",
      hostId: "host-main",
      label: "Seeded host",
      source: "window-origin",
      target: { httpBaseUrl: "http://localhost:4100/", wsBaseUrl: "ws://localhost:4100/" },
    });
  });
});

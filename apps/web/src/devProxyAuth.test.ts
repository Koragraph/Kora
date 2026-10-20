// @effect-diagnostics nodeBuiltinImport:off -- exercises Vite dev-server config code (plain Node) with a throwaway KORA_HOME.
import { authorizeDevProxy, isLoopbackRemoteAddress } from "../vite/devProxyAuth";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

describe("authorizeDevProxy", () => {
  // A throwaway KORA_HOME: the test must never read the real ~/.kora secret.
  let home: string;
  const previousHome = process.env.KORA_HOME;
  beforeAll(() => {
    home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-devproxy-"));
    NodeFS.writeFileSync(NodePath.join(home, "ui-token"), "test-secret\n");
    process.env.KORA_HOME = home;
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env.KORA_HOME;
    else process.env.KORA_HOME = previousHome;
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const run = (remoteAddress: string, headers: Record<string, string>) => {
    let handler: ((proxyReq: unknown, req: unknown) => void) | undefined;
    authorizeDevProxy({
      on: (event, fn) => {
        if (event === "proxyReq") handler = fn as never;
      },
    });
    const set: string[] = [];
    handler!(
      { setHeader: (name: string) => set.push(name), removeHeader: () => undefined },
      { headers: { host: "100.64.0.1:5733", ...headers }, socket: { remoteAddress } },
    );
    return set;
  };

  it("still authorizes the developer's own browser", () => {
    expect(run("127.0.0.1", { origin: "http://100.64.0.1:5733" })).toEqual(["x-kora-ui-token"]);
    expect(run("::1", { "sec-fetch-site": "same-origin" })).toEqual(["x-kora-ui-token"]);
  });

  it("never hands the daemon secret to a peer on another machine", () => {
    // A no-Origin request (curl from the LAN) used to be treated as trusted.
    expect(run("192.168.1.20", {})).toEqual([]);
    expect(run("100.64.0.9", { origin: "http://100.64.0.1:5733" })).toEqual([]);
  });
});

describe("isLoopbackRemoteAddress", () => {
  it("accepts only this machine", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackRemoteAddress(address), address).toBe(true);
    }
    for (const address of ["192.168.1.20", "100.64.0.7", "::ffff:10.0.0.2", "fe80::1", undefined]) {
      expect(isLoopbackRemoteAddress(address), String(address)).toBe(false);
    }
  });
});

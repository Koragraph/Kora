// @effect-diagnostics nodeBuiltinImport:off -- binds a real local socket (or Windows named pipe) and checks its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type ShellLaunchRequest,
  type ShellLaunchResponse,
} from "@kora/contracts";
import { MachinePlatform, MachineUserId } from "@kora/shared/hostMachine";
import { resolveShellAppControlAddress } from "@kora/shared/shellAppControl";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import { startShellAppControlSocket } from "./ShellLaunch.ts";

type Server = Awaited<ReturnType<typeof startShellAppControlSocket>>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

/** A private state folder and the control address the app would use inside it on this machine. */
async function controlSpot(platform: NodeJS.Platform, userId: number | undefined) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kora-control-"));
  cleanup.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  return resolveShellAppControlAddress({
    stateDir: NodePath.join(root, "state"),
    platform,
    userId,
    tempDir: NodeOS.tmpdir(),
    joinPath: NodePath.join,
  });
}

const openRequest = (requestId: string, platform: NodeJS.Platform): ShellLaunchRequest => ({
  version: 1,
  requestId,
  type: "open-workspace",
  workspaceRoot: NodePath.join(NodeOS.tmpdir(), "acme"),
  platform: platform === "darwin" || platform === "win32" ? platform : "linux",
});

/** Writes one JSON line, resolves with the first JSON line back. */
const ask = (address: string, body: ShellLaunchRequest) =>
  new Promise<ShellLaunchResponse>((resolve, reject) => {
    const conn = NodeNet.connect(address, () => conn.end(`${JSON.stringify(body)}\n`));
    let text = "";
    conn.setEncoding("utf8").on("data", (part: string) => {
      text += part;
      const end = text.indexOf("\n");
      if (end < 0) return;
      conn.destroy();
      resolve(JSON.parse(text.slice(0, end)));
    });
    conn.on("error", reject);
  });

const machine = Effect.all([MachinePlatform, MachineUserId]);

describe("the app control socket (`kora open` talks to the running app)", () => {
  it.effect("answers a request, then removes its socket file when closed", () =>
    Effect.flatMap(machine, ([platform, userId]) =>
      Effect.promise(async () => {
        const spot = await controlSpot(platform, userId);
        const seen: string[] = [];
        const server: Server = await startShellAppControlSocket({
          ...spot,
          userId,
          cancel: () => undefined,
          handle: async (req) => {
            seen.push(req.requestId);
            return {
              version: 1,
              requestId: req.requestId,
              ok: true,
              projectId: ProjectId.make("p"),
              threadId: ThreadId.make("t"),
            };
          },
        });
        cleanup.push(() => server.close());

        expect(await ask(spot.address, openRequest("open-1", platform))).toMatchObject({
          ok: true,
          requestId: "open-1",
        });
        expect(seen).toEqual(["open-1"]);
        await server.close();
        if (spot.directory !== null)
          await expect(NodeFSP.stat(spot.address)).rejects.toMatchObject({ code: "ENOENT" });
      }),
    ),
  );

  it.effect("a client that hangs up before the answer cancels its request", () =>
    Effect.flatMap(machine, ([platform, userId]) =>
      Effect.promise(async () => {
        const spot = await controlSpot(platform, userId);
        let cancelled!: (id: string) => void;
        const whichCancelled = new Promise<string>((r) => (cancelled = r));
        const server = await startShellAppControlSocket({
          ...spot,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: (id) => cancelled(id),
        });
        cleanup.push(() => server.close());

        await new Promise<void>((resolve, reject) => {
          const conn = NodeNet.connect(spot.address, () =>
            conn.write(`${JSON.stringify(openRequest("open-gone", platform))}\n`, () => {
              conn.destroy();
              resolve();
            }),
          );
          conn.on("error", reject);
        });
        expect(await whichCancelled).toBe("open-gone");
      }),
    ),
  );
});

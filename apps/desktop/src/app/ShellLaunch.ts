// @effect-diagnostics nodeBuiltinImport:off -- the control socket is a raw node:net server with its own cleanup.
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import type * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { resolveShellAppControlAddress } from "@kora/shared/shellAppControl";
import { MachineUserId } from "@kora/shared/hostMachine";
import {
  type ShellLaunchResponse,
  type ShellLaunchFailure,
  ShellLaunchRequest,
  SHELL_LAUNCH_PROTOCOL_VERSION,
} from "@kora/contracts";

import * as ShellTracing from "./ShellTracing.ts";
import { ShellLaunchBroker } from "./ShellLaunchBroker.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellWindow from "../window/ShellWindow.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import { IPC_SHELL_LAUNCH_REQUEST } from "../ipc/channelNames.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_LINE_TIMEOUT_MS = 5_000;
const BROKER_TIMEOUT_MS = 15_000;
const SOCKET_DIRECTORY_MODE = 0o700;
const SOCKET_FILE_MODE = 0o600;

const { logWarning } = ShellTracing.makeScopedLogger("desktop-app-activation");

export class ShellLaunchStartError extends Schema.TaggedError<ShellLaunchStartError>()(
  "ShellLaunchStartError",
  { address: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

const refusal = (
  reqKey: string,
  code: ShellLaunchFailure["code"],
  msg: string,
): ShellLaunchFailure => ({
  version: SHELL_LAUNCH_PROTOCOL_VERSION,
  requestId: reqKey,
  ok: false,
  code: code,
  message: msg,
});

const decodeRequest = Schema.decodeUnknownOption(ShellLaunchRequest);

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Create the socket's private folder, refusing symlinks and folders owned by someone else. */
async function preparePrivateDirectory(directory: string, userId: number | undefined) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: SOCKET_DIRECTORY_MODE });
  const meta = await NodeFSP.lstat(directory);
  if (!meta.isDirectory()) throw new Error(`${directory} is not a directory.`);
  if (userId !== undefined && meta.uid !== userId)
    throw new Error(`${directory} is owned by another user.`);
  await NodeFSP.chmod(directory, SOCKET_DIRECTORY_MODE);
}

export async function startShellAppControlSocket(options: {
  readonly cancel: (reqKey: string) => void;
  readonly handle: (req: ShellLaunchRequest) => Promise<ShellLaunchResponse>;
  readonly userId: number | undefined;
  readonly directory: string | null;
  readonly address: string;
}): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<NodeNet.Socket>();

  const server = NodeNet.createServer((socket) => {
    socket.setTimeout(REQUEST_LINE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    sockets.add(socket);

    let received = "";
    let handled = false;
    let answered = false;
    let activeRequestId: string | null = null;

    const reply = (resp: ShellLaunchResponse) => {
      answered = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(resp)}\n`);
    };

    for (const failure of ["timeout", "error"] as const) {
      socket.on(failure, () => socket.destroy());
    }
    socket.on("close", () => {
      sockets.delete(socket);
      if (!answered && activeRequestId !== null) options.cancel(activeRequestId);
    });
    socket.on("data", (piece: string) => {
      if (handled) return;
      received += piece;
      if (Buffer.byteLength(received) > MAX_REQUEST_BYTES) {
        handled = true;
        reply(
          refusal("invalid-request", "invalid-request", "The desktop app request is too large."),
        );
        return;
      }
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      socket.setTimeout(0);
      handled = true;

      let decoded: unknown;
      try {
        decoded = JSON.parse(received.slice(0, newline));
      } catch {
        reply(
          refusal(
            "invalid-request",
            "invalid-request",
            "The desktop app request is not valid JSON.",
          ),
        );
        return;
      }
      const req = decodeRequest(decoded);
      if (Option.isNone(req)) {
        const claimed = (decoded as { requestId?: unknown } | null)?.requestId;
        reply(
          refusal(
            typeof claimed === "string" && claimed.trim() !== "" ? claimed : "invalid-request",
            "invalid-request",
            "The desktop app request is invalid.",
          ),
        );
        return;
      }
      activeRequestId = req.value.requestId;
      options
        .handle(req.value)
        .then(reply, () =>
          reply(
            refusal(
              req.value.requestId,
              "invalid-request",
              "Kora could not process the desktop app request.",
            ),
          ),
        );
    });
  });

  if (options.directory !== null) {
    await preparePrivateDirectory(options.directory, options.userId);
    await NodeFSP.unlink(options.address).catch((err) => {
      if (!isMissing(err)) throw err;
    });
  }

  await new Promise<void>((resolve, fail) => {
    server.once("error", fail);
    server.listen(options.address, () => {
      server.off("error", fail);
      resolve();
    });
  });

  const removeSocketFile = () =>
    options.directory === null
      ? Promise.resolve()
      : NodeFSP.unlink(options.address).catch((err) => {
          if (!isMissing(err)) throw err;
        });

  const closeServer = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  if (options.directory !== null) {
    try {
      await NodeFSP.chmod(options.address, SOCKET_FILE_MODE);
    } catch (err) {
      await closeServer();
      throw err;
    }
  }

  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await closeServer();
        server.removeAllListeners();
        await removeSocketFile();
      })()),
  };
}

export class ShellLaunch extends Context.Service<
  ShellLaunch,
  {
    /** Open the control socket for the life of the scope. */
    readonly start: Effect.Effect<void, ShellLaunchStartError, Scope.Scope>;
    /** The renderer says whether it can take launch requests right now. */
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    /** The renderer's answer to a request it was handed. */
    readonly complete: (resp: ShellLaunchResponse) => Effect.Effect<void>;
  }
>()("@kora/desktop/app/ShellLaunch") {}

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const shellWindow = yield* ShellWindow.ShellWindow;
  const nativeWindow = yield* NativeWindow.NativeWindow;
  const loc = yield* Path.Path;
  const userId = yield* MachineUserId;
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);

  const broker = new ShellLaunchBroker({
    requestTimeoutMs: BROKER_TIMEOUT_MS,
    activate: () => {
      void runPromise(
        shellWindow.activate.pipe(
          Effect.catch((err) => logWarning("failed to focus the desktop window", { error: err })),
        ),
      );
    },
  });

  // The renderer that currently receives requests, and the listeners that watch for it going away.
  let attached: { readonly contents: Electron.WebContents; readonly detach: () => void } | null =
    null;

  const detachRenderer = () => {
    attached?.detach();
    attached = null;
    broker.clearRenderer();
  };

  const attachRenderer = Effect.gen(function* () {
    const main = yield* nativeWindow.main;
    if (Option.isNone(main)) return;
    const inner = main.value.webContents;
    if (inner.isDestroyed()) return;

    if (attached?.contents !== inner) {
      detachRenderer();
      const onNavigationDetails = (
        detailInfo: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (detailInfo.isMainFrame && !detailInfo.isSameDocument) detachRenderer();
      };
      inner.on("did-start-navigation", onNavigationDetails);
      inner.once("destroyed", detachRenderer);
      attached = {
        contents: inner,
        detach: () => {
          inner.removeListener("did-start-navigation", onNavigationDetails);
          inner.removeListener("destroyed", detachRenderer);
        },
      };
    }

    broker.registerRenderer((req) => {
      if (!inner.isDestroyed()) inner.send(IPC_SHELL_LAUNCH_REQUEST, req);
    });
  });

  const dest = resolveShellAppControlAddress({
    stateDir: loc.resolve(envVars.stateDir),
    platform: envVars.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: loc.join,
  });

  const begin = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        startShellAppControlSocket({
          ...dest,
          userId,
          handle: (req) => broker.request(req),
          cancel: (reqKey) => broker.cancel(reqKey),
        }),
      catch: (reason) => new ShellLaunchStartError({ address: dest.address, cause: reason }),
    }),
    (socket) =>
      Effect.tryPromise(() => socket.close()).pipe(
        Effect.catch((err) =>
          logWarning("failed to close the desktop app control socket", { error: err }),
        ),
        Effect.ensuring(Effect.sync(() => broker.close())),
      ),
  ).pipe(Effect.asVoid);

  return ShellLaunch.of({
    start: begin,
    setRendererReady: (ready) =>
      ready ? attachRenderer.pipe(Effect.orDie) : Effect.sync(detachRenderer),
    complete: (resp) => Effect.sync(() => broker.complete(resp)),
  });
});

export const layer = Layer.effect(ShellLaunch, make);

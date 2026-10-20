// @effect-diagnostics globalConsoleInEffect:off globalConsole:off -- logs go to the host daemon's stdout (server.log when detached), not through a Logger.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the host kora daemon, which is not Effect code.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type { Duplex } from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KoraRpcGroup } from "@kora/contracts";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { HOST_ID } from "./config.ts";
import { buildHandlers } from "./handlers.ts";
import { HttpRoutesLayer } from "./http.ts";
import { blobBrowserLiveRoute } from "./handlers/blobs-browser.ts";
import { host } from "./host.ts";
import { noteCurrentRequest } from "./currentRequest.ts";
import { desktopClientCount, wsClientClosed, wsClientOpened } from "./wsClients.ts";
import {
  setLocalAuth,
  makeLocalAuth,
  envAllowedOrigins,
  ensureUiToken,
  defaultKoraHome,
  UI_TOKEN_HEADER,
  type LocalAuth,
  APP_ORIGINS,
} from "./localAuth.ts";

/**
 * The KoraRpcGroup handler context. The record is dynamically built (140 keys),
 * so it can't line up with `HandlersFrom` structurally — we cast at this single
 * boundary. Runtime shape is guaranteed by `buildHandlers` covering every entry
 * of `KoraRpcGroup.requests`.
 */
const RpcHandlersLayer = KoraRpcGroup.toLayer(Effect.sync(() => buildHandlers()) as never);

/**
 * `GET /ws` — upgrade to a WebSocket and run the Effect RPC server over it with
 * JSON framing. The client pins `RpcSerialization.layerJson`, so JSON framing is
 * mandatory. Authorization (Host, Origin, secret or single-use ticket) happens
 * before the router ever sees the upgrade: see `guardedDaemon` / `localAuth.ts`.
 */
const wsRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    console.log("[kora-ui] ws client connected");
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fromDesktop = APP_ORIGINS.includes(request.headers["origin"] ?? "");
    wsClientOpened(fromDesktop);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        wsClientClosed(fromDesktop);
        console.log("[kora-ui] ws client disconnected");
      }),
    );
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(KoraRpcGroup, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped,
    );
    // Run the upgrade effect to hijack the socket and produce the (empty) HTTP
    // response. Returning `httpEffect` itself would hand the router an Effect in
    // place of a response (its `.cookies` is then undefined → 500 on upgrade).
    return yield* httpEffect;
  }).pipe(Effect.provide(RpcHandlersLayer.pipe(Layer.provideMerge(RpcSerialization.layerJson)))),
);

/**
 * CORS — the packaged desktop renderer is served from the `kora://app` custom
 * scheme, so every call it makes to our `http://127.0.0.1:8797` backend is
 * cross-origin and the browser sends a preflight `OPTIONS`. Without this the
 * preflight 404s and the client's auth + WebSocket never proceed. Credentialed,
 * so the origins must be explicit (no wildcard). CORS only governs what a page
 * may READ; it blocks nothing (and never applies to WebSocket upgrades) — the
 * access control proper is the node-level guard below.
 */
const makeRoutes = (extraOrigins: ReadonlyArray<string>) =>
  Layer.mergeAll(
    wsRouteLayer,
    HttpRoutesLayer,
    blobBrowserLiveRoute(() => host().blobs?.browserLive),
  ).pipe(
    Layer.provide(
      HttpRouter.cors({
        allowedOrigins: [...APP_ORIGINS, ...extraOrigins],
        credentials: true,
        allowedMethods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["authorization", "b3", "traceparent", "content-type", UI_TOKEN_HEADER],
        maxAge: 600,
      }),
    ),
  );

/**
 * The largest HTTP request body any route reads. Every `/api/*` POST carries a few hundred bytes of JSON and
 * `/oauth/token` one form field; uploads travel over `/ws`. Without a cap, `/oauth/token` — reachable before
 * authentication — buffered whatever a local process streamed at it (a multi-GB body = the daemon's heap).
 * Enforced twice: a declared `Content-Length` is refused at the node layer (413, nothing read), and a chunked body
 * stops reading at the cap (`MaxBodySize`; the route then sees an unreadable body).
 */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

let rejections = 0;
function logRejection(kind: string, req: NodeHttp.IncomingMessage, reason: string): void {
  // Throttled: a hostile page can retry in a loop, and stdout is the daemon's server.log.
  rejections += 1;
  if (rejections <= 20 || rejections % 500 === 0) {
    const origin = req.headers.origin ?? "-";
    const path = (req.url ?? "/").split("?")[0];
    console.warn(
      `[kora-ui] refused ${kind} ${req.method} ${path} (origin ${origin}): ${reason} [#${rejections}]`,
    );
  }
}

/**
 * The node:http server with the access check in front of BOTH the `request` and
 * the `upgrade` event, so no route (present or future, `/ws` included) runs for a
 * request that fails it. Effect's server subscribes to those events after this.
 */
function guardedDaemon(auth: LocalAuth): NodeHttp.Server {
  const server = NodeHttp.createServer();
  const emit = server.emit.bind(server) as (event: string, ...args: unknown[]) => boolean;
  server.emit = ((event: string, ...args: unknown[]) => {
    if (event === "request") {
      const [req, res] = args as [NodeHttp.IncomingMessage, NodeHttp.ServerResponse];
      const verdict = auth.check(req);
      if (!verdict.ok) {
        logRejection("request", req, verdict.reason);
        const origin = req.headers.origin;
        const cors: Record<string, string> =
          verdict.status === 401 && typeof origin === "string"
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-credentials": "true",
                vary: "Origin",
              }
            : {};
        const body =
          verdict.status === 401
            ? {
                _tag: "HostAuthInvalidError",
                code: "auth_invalid",
                reason: "missing_credential",
                traceId: "kora-local",
                detail: verdict.reason,
              }
            : { error: "forbidden", detail: verdict.reason };
        res.writeHead(verdict.status, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify(body));
        return true;
      }
      noteCurrentRequest(`HTTP ${req.method} ${(req.url ?? "/").split("?")[0]}`);
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
        logRejection("request", req, `body of ${declared} bytes is over the limit`);
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "payload_too_large", limit: MAX_HTTP_BODY_BYTES }));
        req.destroy();
        return true;
      }
    } else if (event === "upgrade") {
      const [req, socket] = args as [NodeHttp.IncomingMessage, Duplex];
      noteCurrentRequest(`WS upgrade ${(req.url ?? "/").split("?")[0]}`);
      const verdict = auth.check(req);
      if (!verdict.ok) {
        logRejection("websocket", req, verdict.reason);
        const text = verdict.status === 401 ? "Unauthorized" : "Forbidden";
        socket.end(
          `HTTP/1.1 ${verdict.status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return true;
      }
    }
    return emit(event, ...args);
  }) as typeof server.emit;
  return server;
}

export interface UiServerHandle {
  port: number;
  close(): Promise<void>;
  /** Desktop app windows connected right now (only they have the in-app browser). */
  desktopClients(): number;
}

/**
 * Serve the UI API (`/ws` RPC + `/api/*`) on `host:port` inside the calling process. Resolves once the port is
 * listening; rejects if the server cannot come up (e.g. the port is taken). `close()` interrupts the server fiber,
 * which closes the listener and every open websocket. `koraHome` holds the UI secret (`ui-token`, see localAuth.ts).
 */
export function serveUi(opts: {
  host: string;
  port: number;
  koraHome?: string;
}): Promise<UiServerHandle> {
  // The Effect HTTP layer reported "listening" before the bind and only then died on EADDRINUSE: the daemon logged
  // "chat UI server on :8797", `kora server status` showed it, and the app waited on another program's port forever
  // (found 2026-10-04). Claim the port first, so a taken port is a clear startup error.
  // Loopback only, whatever a caller passes: the API drives agents, and its Host allow-list (localAuth.ts) only
  // names loopback anyway — a LAN bind would be reachable by every machine on the network for no use.
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    return Promise.reject(
      new Error(`the Kora UI server only listens on loopback (127.0.0.1 / ::1), not ${opts.host}`),
    );
  }
  return portFree(opts.host, opts.port).then(() => serveUiOnFreePort(opts));
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** Resolves when `host:port` can be bound right now; rejects with a plain reason when another program holds it. */
export function portFree(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${port} on ${host} is already in use by another program — quit that program, then restart Kora (\`${process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`}\` shows which one)`,
            )
          : err,
      ),
    );
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

function serveUiOnFreePort(opts: {
  host: string;
  port: number;
  koraHome?: string;
}): Promise<UiServerHandle> {
  const extraOrigins = envAllowedOrigins();
  const auth = makeLocalAuth({
    token: ensureUiToken(opts.koraHome ?? defaultKoraHome()),
    port: opts.port,
    extraOrigins,
  });
  setLocalAuth(auth);
  const routes = makeRoutes(extraOrigins);
  return new Promise<UiServerHandle>((resolve, reject) => {
    let ready = false;
    const HttpServerLive = NodeHttpServer.layer(() => guardedDaemon(auth), {
      host: opts.host,
      port: opts.port,
      websocket: { perMessageDeflate: true },
    });
    const readyLayer = Layer.effectDiscard(
      Effect.sync(() => {
        ready = true;
        console.log(
          `[kora-ui] listening on http://${opts.host}:${opts.port} ` +
            `(ws://${opts.host}:${opts.port}/ws, hostId="${HOST_ID}")`,
        );
        resolve({
          port: opts.port,
          close: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
          desktopClients: desktopClientCount,
        });
      }),
    );
    // No per-request / listen logging: stdout is the daemon's server.log, and the graph chip polls /api/graph/status.
    const app = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(HttpServerLive),
      Layer.provideMerge(readyLayer),
    );
    const fiber = Effect.runFork(
      Layer.launch(app).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          FileSystem.Size(MAX_HTTP_BODY_BYTES),
        ),
      ),
    );
    void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        const why = Cause.pretty(exit.cause);
        if (!ready) reject(new Error(`ui server on ${opts.host}:${opts.port} failed: ${why}`));
        else console.error(`[kora-ui] server stopped: ${why}`);
      }
    });
  });
}

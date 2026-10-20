/**
 * TCP port probing for startup code: can a port be bound, is anything already
 * listening there, and which loopback port should we use.
 */
import * as NodeNet from "node:net";

import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Context from "effect/Context";

export class NetError extends Data.TaggedError("NetError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export interface NetServiceShape {
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
  /** Ask the OS for a free port on `host`, then release it. */
  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;
  /** True when something accepts a TCP connection at `host:port`. */
  readonly hasListenerOnHost: (port: number, host: string) => Effect.Effect<boolean>;
  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;
  /** True when a server can bind `host:port`. A host that lacks the address (no IPv6, say) counts as bindable. */
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;
}

export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@kora/shared/netService",
) {}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const CONNECT_TIMEOUT_MS = 250;

const errorCode = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "code") && typeof error.code === "string" ? error.code : undefined;

const closeQuietly = (server: NodeNet.Server): void => {
  try {
    server.close();
  } catch {
    // already closed
  }
};

const canListen = (port: number, host: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    let done = false;
    const server = NodeNet.createServer();
    server.unref();
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      resume(Effect.succeed(value));
    };

    server.once("error", (error) => {
      // EADDRNOTAVAIL: this machine has no such address, so nothing can be in the way.
      finish(errorCode(error) === "EADDRNOTAVAIL");
    });
    server.listen({ host, port }, () => {
      server.close(() => finish(true));
    });

    return Effect.sync(() => closeQuietly(server));
  });

const hasListener = (port: number, host: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    socket.unref();
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    return Effect.sync(() => {
      socket.destroy();
    });
  });

const portOf = (server: NodeNet.Server): number => {
  const info = server.address();
  return info !== null && typeof info === "object" ? info.port : 0;
};

const reserveFailure = (cause?: unknown) =>
  cause === undefined
    ? new NetError({ message: "Failed to reserve loopback port" })
    : new NetError({ message: "Failed to reserve loopback port", cause });

const reservePort = (host: string): Effect.Effect<number, NetError> =>
  Effect.callback<number, NetError>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    let outcome: Effect.Effect<number, NetError> | undefined;
    const settleOnce = (effect: Effect.Effect<number, NetError>) => {
      if (outcome !== undefined) return;
      outcome = effect;
      resume(effect);
    };
    const onListening = () => {
      const port = portOf(server);
      const result = port > 0 ? Effect.succeed(port) : Effect.fail(reserveFailure());
      server.close(() => settleOnce(result));
    };

    server.once("error", (cause) => settleOnce(Effect.fail(reserveFailure(cause))));
    server.listen(0, host, onListening);
    return Effect.sync(() => closeQuietly(server));
  });

function make(): NetServiceShape {
  const isPortAvailableOnLoopback = Effect.fn("Net.isPortAvailableOnLoopback")(function* (
    port: number,
  ) {
    const listeners = yield* Effect.forEach(LOOPBACK_HOSTS, (host) => hasListener(port, host));
    if (listeners.some(Boolean)) return false;
    const bindable = yield* Effect.forEach(LOOPBACK_HOSTS, (host) => canListen(port, host));
    return bindable.every(Boolean);
  });

  const reserveLoopbackPort = (host = "127.0.0.1") => reservePort(host);

  const findAvailablePort = Effect.fn("Net.findAvailablePort")(function* (preferred: number) {
    if (preferred > 0 && (yield* isPortAvailableOnLoopback(preferred))) return preferred;
    return yield* reservePort("127.0.0.1");
  });

  return {
    canListenOnHost: canListen,
    isPortAvailableOnLoopback,
    hasListenerOnHost: hasListener,
    reserveLoopbackPort,
    findAvailablePort,
  };
}

export const layer = Layer.sync(NetService, make);

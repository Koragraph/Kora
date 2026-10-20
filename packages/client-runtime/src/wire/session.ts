import {
  type SubscribeDaemonConfigRpc,
  type DaemonConfigStreamEvent,
  type DaemonConfig,
  RPC_METHODS,
  HostAuthorizationError,
  DaemonPrefsError,
} from "@kora/contracts";
import * as Arr from "effect/Array";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { hostMismatchError } from "../link/errors.ts";
import {
  type PreparedLink,
  type LinkAttemptError,
  LinkTransientError,
  LinkBlockedError,
} from "../link/model.ts";
import {
  type DaemonConfigProjection,
  withoutHostThemes,
  applyDaemonConfigProjection,
} from "../store/daemonConfigProjection.ts";
import { makeKoraRpcClient, type KoraRpcClient } from "./protocol.ts";

type DaemonConfigSubscriptionInput = Rpc.Payload<typeof SubscribeDaemonConfigRpc>;

type ConfigStreamError =
  | Rpc.ErrorExit<typeof SubscribeDaemonConfigRpc>
  | RpcClientError.RpcClientError;
/** Settles when the link check it stands for passes; fails with the reason the link is unusable. */
type LinkSignal<A> = Effect.Effect<A, LinkAttemptError>;

/** One connected RPC session: the typed client plus readiness and lifetime signals. */
export interface RpcSession {
  /** Resolves once the server has answered the first round trip. */
  readonly ready: LinkSignal<void>;
  /** A cheap round trip used to check the link is still alive. */
  readonly probe: LinkSignal<void>;
  /** Never succeeds; fails when the session ends. */
  readonly closed: LinkSignal<never>;
  readonly initialConfig: LinkSignal<DaemonConfig>;
  readonly subscribeDaemonConfig: (
    input: DaemonConfigSubscriptionInput,
  ) => Stream.Stream<DaemonConfigStreamEvent, ConfigStreamError>;
  readonly client: KoraRpcClient;
}

/** Server features this session should use when the server offers them. */
export type RpcSessionOptions = Readonly<
  Partial<Record<"hostThemes" | "usageLimitSources" | "usageLimitsCommand", boolean>>
>;

type SessionConnector = (
  link: PreparedLink,
) => Effect.Effect<RpcSession, LinkAttemptError, Scope.Scope>;

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  { readonly connect: SessionConnector }
>()("@kora/client-runtime/wire/session/RpcSessionFactory") {}

const OPEN_TIMEOUT = Duration.seconds(15);
const BROADCAST_CAPACITY = 64;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const transportError = (detail: string) => new LinkTransientError({ reason: "transport", detail });

const isLinkBlocked = Schema.is(LinkBlockedError);
const isLinkTransient = Schema.is(LinkTransientError);
const isHostAuthorization = Schema.is(HostAuthorizationError);
const isDaemonPrefs = Schema.is(DaemonPrefsError);

const mapSessionRpcError = (error: unknown): LinkAttemptError => {
  if (isLinkBlocked(error) || isLinkTransient(error)) return error;
  if (isHostAuthorization(error)) {
    return new LinkBlockedError({ reason: "permission", detail: error.message });
  }
  if (isDaemonPrefs(error)) {
    return new LinkTransientError({ reason: "endpoint-unavailable", detail: error.message });
  }
  return transportError(error instanceof Error ? error.message : String(error));
};

/** Config failures reach durable subscribers as transport-shaped errors so they wait for the next session. */
const asClientDefect = (message: string, cause: unknown): RpcClientError.RpcClientError =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message, cause }),
  });

// ---------------------------------------------------------------------------
// The shared daemon-config view
// ---------------------------------------------------------------------------

/** What every subscriber needs to rebuild the current picture. */
interface ConfigState {
  readonly projection: DaemonConfigProjection;
  readonly themes: Option.Option<DaemonConfigStreamEvent>;
  readonly sources: Option.Option<DaemonConfigStreamEvent>;
}

interface ConfigUpdate {
  readonly event: DaemonConfigStreamEvent;
  readonly state: ConfigState;
  readonly revision: number;
}

/** The events that reproduce `state` for a new (or catching-up) subscriber. */
const replayEvents = (state: ConfigState): ReadonlyArray<DaemonConfigStreamEvent> => [
  { version: 1, type: "snapshot", config: withoutHostThemes(state.projection.config) },
  ...Option.toArray(state.themes),
  ...Option.toArray(state.sources),
];

const wantedInput = (options: RpcSessionOptions): DaemonConfigSubscriptionInput => ({
  ...(options.hostThemes === true ? { hostThemes: true } : {}),
  ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
  ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
});

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

const make = Effect.fn("RpcSessionFactory.make")(function* (options: RpcSessionOptions = {}) {
  const webSocket = yield* Socket.WebSocketConstructor;
  const handshakeInput = wantedInput(options);

  const connect = Effect.fn("RpcSessionFactory.connect")(function* (connection: PreparedLink) {
    const label = connection.label;
    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, LinkAttemptError>();

    // The raw socket, with open/close reported so the session can tell "never connected"
    // from "dropped". No retry here: reconnecting is the supervisor's job.
    const rawSocket = yield* Socket.makeWebSocket(connection.socketUrl, {
      openTimeout: OPEN_TIMEOUT,
    }).pipe(
      Effect.withSpan("environment.websocket.connect"),
      Effect.provideService(Socket.WebSocketConstructor, webSocket),
    );
    const reportExit = <A, E, R>(run: Effect.Effect<A, E, R>) =>
      Effect.onExit(run, () =>
        Effect.gen(function* () {
          const wasConnected = yield* Deferred.isDone(connected);
          yield* Deferred.fail(
            disconnected,
            transportError(
              wasConnected
                ? `${label} disconnected.`
                : `${label} could not establish a WebSocket connection.`,
            ),
          );
        }),
      );
    const onOpen = (opened?: Effect.Effect<void>) =>
      (opened ?? Effect.void).pipe(Effect.andThen(Deferred.succeed(connected, undefined)));
    const socket = Socket.make({
      runRaw: (handler, runOptions) =>
        rawSocket.runRaw(handler, { onOpen: onOpen(runOptions?.onOpen) }).pipe(reportExit),
      run: (handler, runOptions) =>
        rawSocket.run(handler, { onOpen: onOpen(runOptions?.onOpen) }).pipe(reportExit),
      runString: (handler, runOptions) =>
        rawSocket.runString(handler, { onOpen: onOpen(runOptions?.onOpen) }).pipe(reportExit),
      writer: rawSocket.writer,
    });

    const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(
        Layer.mergeAll(Layer.succeed(Socket.Socket, socket), RpcSerialization.layerJson),
      ),
    );
    const context = yield* Layer.build(protocol);
    const client = yield* makeKoraRpcClient.pipe(Effect.provide(context));

    // -- the handshake subscription and the state it feeds -----------------
    const snapshotConfig = yield* Deferred.make<DaemonConfig>();
    const configEnded = yield* Deferred.make<void>();
    const configSubscriptionClosed = yield* Deferred.make<never, LinkAttemptError>();
    const configFailure = yield* Deferred.make<Cause.Cause<unknown>>();
    const state = yield* Ref.make<{
      readonly current: Option.Option<ConfigState>;
      readonly revision: number;
    }>({
      current: Option.none(),
      revision: 0,
    });
    const broadcast = yield* PubSub.sliding<ConfigUpdate>(BROADCAST_CAPACITY);

    const accept = (event: DaemonConfigStreamEvent) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(state);
        const projection = applyDaemonConfigProjection(
          Option.map(before.current, (current) => current.projection),
          event,
        );
        if (Option.isNone(projection)) return;

        const capabilities = projection.value.config.environment.capabilities;
        // A fresh snapshot from a server without a capability drops what it can no longer publish.
        const carry = (
          kept: Option.Option<DaemonConfigStreamEvent>,
          supported: boolean | undefined,
        ) => (event.type === "snapshot" && supported !== true ? Option.none() : kept);
        const next: ConfigState = {
          projection: projection.value,
          themes:
            event.type === "hostThemesUpdated"
              ? Option.some(event)
              : carry(
                  Option.flatMap(before.current, (c) => c.themes),
                  capabilities.hostThemes,
                ),
          sources:
            event.type === "usageLimitSourcesUpdated"
              ? Option.some(event)
              : carry(
                  Option.flatMap(before.current, (c) => c.sources),
                  capabilities.usageLimitSources,
                ),
        };
        const revision = before.revision + 1;
        yield* Ref.set(state, { current: Option.some(next), revision });
        if (event.type === "snapshot")
          yield* Deferred.succeed(snapshotConfig, projection.value.config);
        yield* PubSub.publish(broadcast, { event, state: next, revision });
      });

    const finishConfig = (exit: Exit.Exit<void, unknown>) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) {
          const ended = transportError("config subscription ended.");
          yield* Deferred.succeed(configEnded, undefined);
          yield* Deferred.fail(
            configSubscriptionClosed,
            new LinkTransientError({
              reason: "endpoint-unavailable",
              detail: `${label} config subscription ended.`,
            }),
          );
          void ended;
          return;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return;
        yield* Deferred.succeed(configFailure, exit.cause);
        yield* Deferred.failCause(
          configSubscriptionClosed,
          Cause.map(exit.cause, mapSessionRpcError),
        );
      });

    yield* client[RPC_METHODS.subscribeDaemonConfig](handshakeInput).pipe(
      Stream.runForEach(accept),
      Effect.onExit(finishConfig),
      Effect.forkScoped,
    );

    // The first snapshot, validated against the host this link was meant for.
    const initialConfig: RpcSession["initialConfig"] = Effect.gen(function* () {
      const config = yield* Effect.raceFirst(
        Deferred.await(snapshotConfig),
        Effect.raceFirst(
          Deferred.await(configEnded).pipe(
            Effect.andThen(
              Effect.fail(
                new LinkTransientError({
                  reason: "endpoint-unavailable",
                  detail: `${label} config subscription ended.`,
                }),
              ),
            ),
          ),
          Deferred.await(configFailure).pipe(
            Effect.flatMap((cause) =>
              Effect.fail(
                Option.match(Cause.findErrorOption(cause), {
                  onSome: mapSessionRpcError,
                  onNone: () => transportError(`${label} config subscription failed.`),
                }),
              ),
            ),
          ),
        ),
      );
      if (config.environment.hostId !== connection.hostId) {
        return yield* Effect.fail(
          hostMismatchError({ expected: connection.hostId, actual: config.environment.hostId }),
        );
      }
      return config;
    }).pipe(Effect.withSpan("environment.initialSync"));

    // -- subscribers ------------------------------------------------------------
    const rawSubscription = (input: DaemonConfigSubscriptionInput) =>
      client[RPC_METHODS.subscribeDaemonConfig](input);

    const sharedStream: Effect.Effect<
      Stream.Stream<DaemonConfigStreamEvent, RpcClientError.RpcClientError>,
      never,
      Scope.Scope
    > = Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(broadcast);
      const current = yield* Ref.get(state);
      if (Option.isNone(current.current)) {
        return Stream.empty as Stream.Stream<
          DaemonConfigStreamEvent,
          RpcClientError.RpcClientError
        >;
      }
      const snapshotRevision = current.revision;
      let lastRevision = snapshotRevision;

      // A clean end of the feed ends this stream; a failed feed fails it like a lost transport.
      const terminated = Effect.raceFirst(
        Deferred.await(configEnded),
        Deferred.await(configFailure).pipe(
          Effect.flatMap((cause) =>
            Effect.fail(
              asClientDefect(`${label} config subscription failed.`, Cause.squash(cause)),
            ),
          ),
        ),
      ).pipe(Effect.flatMap(() => Cause.done()));

      const toEvents = (updates: ReadonlyArray<ConfigUpdate>): DaemonConfigStreamEvent[] => {
        const events: DaemonConfigStreamEvent[] = [];
        for (const update of updates) {
          if (update.revision <= snapshotRevision) continue;
          const missed = update.revision !== lastRevision + 1;
          lastRevision = update.revision;
          // Dropped updates cannot be recovered one by one; rebuild from the state at this one.
          if (missed) events.push(...replayEvents(update.state));
          else events.push(update.event);
        }
        return events;
      };

      // Pulled explicitly, one batch at a time, so a slow consumer falls behind the broadcast
      // (and is rebuilt from state) instead of holding a read-ahead buffer.
      const pullLive = Effect.gen(function* () {
        for (;;) {
          const updates = yield* Effect.raceFirst(PubSub.takeAll(subscription), terminated);
          const events = toEvents(updates);
          if (Arr.isReadonlyArrayNonEmpty(events)) return events;
        }
      });

      return Stream.concat(
        Stream.fromIterable(replayEvents(current.current.value)),
        Stream.fromPull(Effect.succeed(pullLive)),
      ).pipe(
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Stream.failCause(cause)
            : Stream.fail(
                asClientDefect(`${label} config subscription failed.`, Cause.squash(cause)),
              ),
        ),
      );
    });

    const subscribeDaemonConfig: RpcSession["subscribeDaemonConfig"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* initialConfig.pipe(
            Effect.mapError((error) =>
              asClientDefect(`${label} config subscription failed.`, error),
            ),
          );
          return Equal.equals(input, handshakeInput) ? yield* sharedStream : rawSubscription(input);
        }),
      );

    const probe: RpcSession["probe"] = Effect.gen(function* () {
      const config = yield* initialConfig;
      if (config.environment.capabilities.connectionProbe === true) {
        yield* client[RPC_METHODS.daemonProbe]({});
      } else {
        yield* client[RPC_METHODS.daemonConfigGet]({});
      }
    }).pipe(
      Effect.mapError(mapSessionRpcError),
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    const ready: RpcSession["ready"] = Effect.raceFirst(
      Deferred.await(connected).pipe(Effect.andThen(initialConfig), Effect.asVoid),
      Deferred.await(disconnected),
    );

    const closed: RpcSession["closed"] = Effect.raceFirst(
      Deferred.await(disconnected),
      Deferred.await(configSubscriptionClosed),
    );

    const session: RpcSession = {
      ready,
      probe,
      closed,
      initialConfig,
      subscribeDaemonConfig,
      client,
    };
    return session;
  });

  const factory = RpcSessionFactory.of({ connect });
  return factory;
});

/** The session factory, using the given optional server features. */
export function layerWithOptions(options: RpcSessionOptions) {
  return Layer.effect(RpcSessionFactory)(make(options));
}

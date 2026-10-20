import { describe, expect, it } from "@effect/vitest";
import * as Contracts from "@kora/contracts";
import type { DaemonConfig, DaemonConfigStreamEvent } from "@kora/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import * as Link from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import * as Persistence from "../embedder/hostCache.ts";
import { applyDaemonConfigProjection } from "../store/daemonConfigProjection.ts";
import { makeHostDaemonConfigState } from "../store/server.ts";
import * as RpcSession from "./session.ts";

// ---------------------------------------------------------------------------
// A fake WebSocket the RPC client talks through
// ---------------------------------------------------------------------------

type Kind = "open" | "message" | "close" | "error";
type FakeEvent = {
  readonly type: Kind;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

const OPEN = 1;
const CLOSED = 3;

class FakeSocket {
  /** Built through `at` so the constructor stays argument-free. */
  static at(url: string): FakeSocket {
    const socket = new FakeSocket();
    socket.url = url;
    return socket;
  }

  url = "";
  readyState = 0;
  readonly outbox: string[] = [];
  private readonly handlers: Record<Kind, Array<(event: FakeEvent) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  addEventListener(kind: Kind, handler: (event: FakeEvent) => void) {
    this.handlers[kind].push(handler);
  }

  removeEventListener(kind: Kind, handler: (event: FakeEvent) => void) {
    this.handlers[kind] = this.handlers[kind].filter((h) => h !== handler);
  }

  send(frame: string) {
    this.outbox.push(frame);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit({ type: "close", code, reason });
  }

  accept() {
    this.readyState = OPEN;
    this.emit({ type: "open" });
  }

  deliver(data: string) {
    this.emit({ type: "message", data });
  }

  private emit(event: FakeEvent) {
    for (const handler of [...this.handlers[event.type]]) handler(event);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST = new Link.LocalLinkTarget({
  hostId: Contracts.HostId.make("h-session"),
  httpBaseUrl: "https://session.host.test",
  wsBaseUrl: "wss://session.host.test",
  label: "Session host",
});
const LINK: Link.PreparedLink = {
  target: HOST,
  hostId: HOST.hostId,
  label: HOST.label,
  httpBaseUrl: HOST.httpBaseUrl,
  socketUrl: "wss://session.host.test/ws?wsTicket=t-1",
  httpAuthorization: null,
};

const CONFIG: DaemonConfig = {
  cwd: "/home/dev/project",
  settings: Contracts.DEFAULT_DAEMON_PREFS,
  providers: [],
  availableEditors: [],
  environment: {
    hostId: HOST.hostId,
    label: HOST.label,
    serverVersion: "9.9.9-test",
    platform: { arch: "x64", os: "linux" },
    capabilities: { connectionProbe: true, repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    sessionCookieName: "kora_session",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  },
  observability: {
    logsDirectoryPath: "/home/dev/logs",
    otlpMetricsEnabled: false,
    otlpTracesEnabled: false,
    localTracingEnabled: false,
  },
};

const withCaps = (
  config: DaemonConfig,
  caps: Partial<DaemonConfig["environment"]["capabilities"]>,
): DaemonConfig => ({
  ...config,
  environment: {
    ...config.environment,
    capabilities: { ...config.environment.capabilities, ...caps },
  },
});
const THEMED = withCaps(CONFIG, { hostThemes: true });
const SOURCED = withCaps(THEMED, { usageLimitSources: true });

const wireConfig = Schema.encodeSync(Contracts.DaemonConfig);
const wireEvent = Schema.encodeSync(Contracts.DaemonConfigStreamEvent);
const wireDefect = Schema.encodeSync(Schema.Defect());
const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const WIRE = wireConfig(CONFIG);
const WIRE_THEMED = wireConfig(THEMED);
/** What a server from before the probe capability sends. */
const WIRE_LEGACY = {
  ...WIRE,
  environment: { ...WIRE.environment, capabilities: { repositoryIdentity: true } },
};

const isRequest = Schema.is(
  Schema.TaggedStruct("Request", {
    tag: Schema.String,
    payload: Schema.Unknown,
    id: Schema.Union([Schema.String, Schema.Number]),
  }),
);
const isPing = Schema.is(Schema.Struct({ _tag: Schema.Literal("Ping") }));

const sourcesEvent = (sources: ReadonlyArray<unknown>): DaemonConfigStreamEvent =>
  ({
    version: 1,
    type: "usageLimitSourcesUpdated",
    payload: { sources },
  }) as DaemonConfigStreamEvent;
const ONE_SOURCE = sourcesEvent([
  {
    id: Contracts.QuotaSourceId.make("relay"),
    kind: "cliproxy",
    label: "Relay",
    accounts: [],
    checkedAt: "2025-05-05T00:00:00Z",
  },
]);
const NO_SOURCES = sourcesEvent([]);

type Theme = { id: string; name: string; appearance: "dark"; canvas: string; accent: string };
const theme = (id: string, name: string, canvas: string, accent: string): Theme => ({
  id,
  name,
  canvas,
  accent,
  appearance: "dark",
});
const themesEvent = (themes: ReadonlyArray<Theme>): DaemonConfigStreamEvent => ({
  version: 1,
  type: "hostThemesUpdated",
  payload: { themes },
});
const snapshotEvent = (config: DaemonConfig): DaemonConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});
const providersEvent = (providers: ReadonlyArray<unknown>) =>
  ({ version: 1, type: "providerStatuses", payload: { providers } }) as DaemonConfigStreamEvent;
const settingsEvent = (settings: unknown) =>
  ({ version: 1, type: "settingsUpdated", payload: { settings } }) as DaemonConfigStreamEvent;

/** Fold events on top of a first snapshot the way the client store does. */
const fold = (first: DaemonConfigStreamEvent, ...rest: ReadonlyArray<DaemonConfigStreamEvent>) =>
  Option.getOrThrow(
    rest.reduce(
      (state, event) => applyDaemonConfigProjection(state, event),
      applyDaemonConfigProjection(Option.none(), first),
    ),
  );

// ---------------------------------------------------------------------------
// Playing the server
// ---------------------------------------------------------------------------

const factoryWith = Effect.fn("SessionTest.factory")(function* (
  options: RpcSession.RpcSessionOptions = {},
) {
  const sockets: FakeSocket[] = [];
  const constructSocket = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = FakeSocket.at(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const factory = yield* Effect.provide(
    RpcSession.RpcSessionFactory,
    RpcSession.layerWithOptions(options).pipe(Layer.provide(constructSocket)),
  );
  return { factory, sockets };
});

/** Poll briefly for something the client is about to do. */
const eventually = <A>(look: () => A | undefined, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = look();
      if (found !== undefined) return found;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

const requests = (socket: FakeSocket) =>
  socket.outbox.map((frame) => fromJson(frame)).filter(isRequest);
const nthSocket = (sockets: ReadonlyArray<FakeSocket>, n = 0) =>
  eventually(() => sockets[n], "a websocket");
const nthRequest = (socket: FakeSocket, n = 0) =>
  eventually(() => requests(socket)[n], "an RPC request");

/** Server-side helpers for one socket. */
const serverOn = (socket: FakeSocket) => ({
  chunk: (requestId: string | number, values: unknown[]) =>
    socket.deliver(toJson({ _tag: "Chunk", requestId, values })),
  exit: (requestId: string | number, exit: unknown) =>
    socket.deliver(toJson({ _tag: "Exit", requestId, exit })),
  defect: (message: string) =>
    socket.deliver(toJson({ _tag: "Defect", defect: wireDefect(new Error(message)) })),
  /** Answer the config subscription (first request) with a snapshot, checking its payload. */
  snapshot: (config: unknown = WIRE, payload: unknown = {}) =>
    Effect.gen(function* () {
      const request = yield* nthRequest(socket);
      expect(request).toMatchObject({
        _tag: "Request",
        tag: Contracts.RPC_METHODS.subscribeDaemonConfig,
        payload,
      });
      serverOn(socket).chunk(request.id, [{ version: 1, type: "snapshot", config }]);
    }),
  /** Push events down the config subscription. */
  push: (...events: DaemonConfigStreamEvent[]) =>
    Effect.gen(function* () {
      const request = yield* nthRequest(socket);
      serverOn(socket).chunk(
        request.id,
        events.map((event) => wireEvent(event)),
      );
    }),
});

/** A session that has started connecting; nothing is answered yet. */
const connecting = Effect.gen(function* () {
  const { factory, sockets } = yield* factoryWith();
  return { sockets, session: yield* factory.connect(LINK) };
});

/** A connected, ready session. */
const ready = Effect.fn("SessionTest.ready")(function* (
  options: RpcSession.RpcSessionOptions = {},
  config: unknown = WIRE,
  payload: unknown = {},
) {
  const { factory, sockets } = yield* factoryWith(options);
  const session = yield* factory.connect(LINK);
  const waiting = yield* Effect.forkChild(session.ready);
  const socket = yield* nthSocket(sockets);
  socket.accept();
  yield* serverOn(socket).snapshot(config, payload);
  yield* Fiber.join(waiting);
  return { factory, sockets, session, socket, server: serverOn(socket) };
});

// ---------------------------------------------------------------------------

describe("RPC session", () => {
  describe("lifecycle", () => {
    it.effect("opens one socket, reads the config, answers probes and reports closure", () =>
      Effect.gen(function* () {
        const { session, socket, sockets, server } = yield* ready();
        expect(socket.url).toBe(LINK.socketUrl);
        expect(yield* session.initialConfig).toEqual(CONFIG);
        expect(requests(socket).length).toBe(1);

        const probing = yield* Effect.forkChild(session.probe);
        const probe = yield* nthRequest(socket, 1);
        expect(probe).toMatchObject({
          _tag: "Request",
          tag: Contracts.RPC_METHODS.daemonProbe,
          payload: {},
        });
        server.exit(probe.id, { _tag: "Success", value: {} });
        yield* Fiber.join(probing);
        expect(requests(socket).map(({ tag }) => tag)).toEqual([
          Contracts.RPC_METHODS.subscribeDaemonConfig,
          Contracts.RPC_METHODS.daemonProbe,
        ]);

        socket.close(1012, "service restart");
        const reason = yield* Effect.flip(session.closed);
        expect(reason).toBeInstanceOf(Link.LinkTransientError);
        expect(reason).toMatchObject({
          reason: "transport",
          message: "Session host disconnected.",
        });
        const streamError = yield* Effect.flip(Stream.runDrain(session.subscribeDaemonConfig({})));
        expect(streamError).toMatchObject({ _tag: "RpcClientError" });
        yield* Effect.yieldNow;
        expect(sockets.length).toBe(1);
      }),
    );

    it.effect("closes its socket when the scope it was opened in ends", () =>
      Effect.gen(function* () {
        const { factory, sockets } = yield* factoryWith();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* factory.connect(LINK);
            const waiting = yield* Effect.forkChild(session.ready);
            const socket = yield* nthSocket(sockets);
            socket.accept();
            yield* serverOn(socket).snapshot();
            yield* Fiber.join(waiting);
          }),
        );
        expect(sockets[0]?.readyState).toBe(CLOSED);
      }),
    );

    it.effect("ends with a defect when the config stream dies", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { session, server } = yield* ready();
          const ending = yield* Effect.forkChild(Effect.exit(session.closed));
          server.defect("config source crashed");
          const exit = yield* Fiber.join(ending);
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        }),
      ),
    );

    it.effect("gives up after two missed pong windows, not earlier", () =>
      Effect.gen(function* () {
        const { sockets, session } = yield* connecting;
        const waiting = yield* Effect.forkChild(session.ready);
        const ending = yield* Effect.forkChild(Effect.flip(session.closed));
        const socket = yield* nthSocket(sockets);
        socket.accept();
        yield* serverOn(socket).snapshot();
        yield* Fiber.join(waiting);

        yield* TestClock.adjust("15 seconds");
        expect(ending.pollUnsafe()).toBeUndefined();
        const pings = socket.outbox.map((frame) => fromJson(frame)).filter(isPing);
        expect(pings.length).toBe(3);

        yield* TestClock.adjust("5 seconds");
        const reason = yield* Fiber.join(ending);
        expect(reason).toBeInstanceOf(Link.LinkTransientError);
        expect(reason).toMatchObject({ reason: "transport" });
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  });

  describe("first config", () => {
    it.effect("rejects a config that names another host, failing ready and every subscriber", () =>
      Effect.gen(function* () {
        const { sockets, session } = yield* connecting;
        const readiness = yield* Effect.forkChild(Effect.flip(session.ready));
        const subscriberError = (options: { hostThemes?: boolean }) =>
          Effect.forkChild(Effect.flip(Stream.runHead(session.subscribeDaemonConfig(options))));
        const plain = yield* subscriberError({});
        const themed = yield* subscriberError({ hostThemes: true });
        const socket = yield* nthSocket(sockets);
        socket.accept();
        yield* serverOn(socket).snapshot({
          ...WIRE,
          environment: { ...WIRE.environment, hostId: "h-somebody-else" },
        });

        expect(yield* Fiber.join(readiness)).toMatchObject({
          reason: "configuration",
          message: "Connected environment h-somebody-else does not match h-session.",
        });
        for (const subscriber of [plain, themed])
          expect((yield* Fiber.join(subscriber))._tag).toBe("RpcClientError");
      }),
    );

    it.effect("ignores fields and values from newer or older servers", () =>
      Effect.gen(function* () {
        const { sockets, session } = yield* connecting;
        const waiting = yield* Effect.forkChild(session.ready);
        const socket = yield* nthSocket(sockets);
        socket.accept();
        yield* serverOn(socket).snapshot({
          ...WIRE,
          // Keybinding fields an older server still sends, and values from the future.
          keybindings: [],
          keybindingsConfigPath: "/home/dev/keybindings.json",
          issues: [{ kind: "keybindings.something-new", message: "from the future" }],
          availableEditors: ["zed", "editor-of-tomorrow"],
        });
        yield* Fiber.join(waiting);
        const config = yield* session.initialConfig;
        expect("keybindings" in config).toBe(false);
        expect(config.availableEditors).toEqual(["zed"]);
      }),
    );

    it.effect("probes with the old config RPC when the server cannot be probed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { session, socket, server } = yield* ready({}, WIRE_LEGACY);
          const probing = yield* Effect.forkChild(session.probe);
          const probe = yield* nthRequest(socket, 1);
          expect(probe).toMatchObject({
            tag: Contracts.RPC_METHODS.daemonConfigGet,
            payload: {},
            _tag: "Request",
          });
          server.exit(probe.id, { _tag: "Success", value: WIRE_LEGACY });
          yield* Fiber.join(probing);
          expect(requests(socket).map(({ tag }) => tag)).toEqual([
            Contracts.RPC_METHODS.subscribeDaemonConfig,
            Contracts.RPC_METHODS.daemonConfigGet,
          ]);
        }),
      ),
    );
  });

  describe("config fan-out", () => {
    it.effect("gives every subscriber the current config and then each update", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { session, server } = yield* ready();
          const firstTwo = Stream.runCollect(Stream.take(session.subscribeDaemonConfig({}), 2));
          const [a, b] = [yield* Effect.forkChild(firstTwo), yield* Effect.forkChild(firstTwo)];
          yield* Effect.yieldNow;
          yield* server.push(
            settingsEvent({ ...Contracts.DEFAULT_DAEMON_PREFS, enableProviderUpdateChecks: false }),
          );

          const seenA = [...(yield* Fiber.join(a))];
          expect(seenA.map(({ type }) => type)).toEqual(["snapshot", "settingsUpdated"]);
          expect([...(yield* Fiber.join(b))]).toEqual(seenA);

          const late = yield* Stream.runHead(session.subscribeDaemonConfig({}));
          expect(late).toMatchObject({
            _tag: "Some",
            value: {
              type: "snapshot",
              config: { settings: { enableProviderUpdateChecks: false } },
            },
          });
        }),
      ),
    );

    for (const optIns of [
      { hostThemes: true },
      { usageLimitSources: true },
      { hostThemes: true, usageLimitSources: true },
    ]) {
      it.effect(
        `shares the upstream subscription only with identical opt-ins (${Object.keys(optIns).join("+")})`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const { session, socket, server } = yield* ready(optIns, WIRE_THEMED, optIns);
              expect(yield* Stream.runHead(session.subscribeDaemonConfig(optIns))).toMatchObject({
                _tag: "Some",
                value: { type: "snapshot" },
              });
              expect(requests(socket).length).toBe(1);

              const plain = yield* Effect.forkChild(
                Stream.runHead(session.subscribeDaemonConfig({})),
              );
              const second = yield* nthRequest(socket, 1);
              expect(second).toMatchObject({
                tag: Contracts.RPC_METHODS.subscribeDaemonConfig,
                payload: {},
              });
              server.chunk(second.id, [{ version: 1, type: "snapshot", config: WIRE_THEMED }]);
              expect(yield* Fiber.join(plain)).toMatchObject({
                _tag: "Some",
                value: { type: "snapshot" },
              });
            }),
          ),
      );
    }

    const codexStatus = {
      instanceId: Contracts.AgentProfileId.make("codex"),
      driver: Contracts.AgentId.make("codex"),
      status: "ready",
      auth: { status: "authenticated" },
      version: "3.1.0",
      enabled: true,
      installed: true,
      checkedAt: "2025-05-05T00:00:00.000Z",
      models: [],
      skills: [],
      slashCommands: [],
    };
    const flippedPrefs = {
      ...Contracts.DEFAULT_DAEMON_PREFS,
      newWorktreesStartFromOrigin: !Contracts.DEFAULT_DAEMON_PREFS.newWorktreesStartFromOrigin,
    };

    it.effect.each([
      { event: providersEvent([codexStatus]), folded: { providers: [codexStatus] } },
      { event: settingsEvent(flippedPrefs), folded: { settings: flippedPrefs } },
    ])(
      "forwards $event.type and folds it into the snapshot later subscribers get",
      ({ event, folded }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { session, server } = yield* ready();
            const listener = yield* Effect.forkChild(
              Stream.runCollect(Stream.take(session.subscribeDaemonConfig({}), 2)),
            );
            yield* Effect.yieldNow;
            yield* server.push(event);
            expect([...(yield* Fiber.join(listener))][1]).toEqual(event);
            expect(yield* Stream.runHead(session.subscribeDaemonConfig({}))).toMatchObject({
              _tag: "Some",
              value: { type: "snapshot", config: folded },
            });
          }),
        ),
    );
  });

  describe("host themes and usage sources", () => {
    it.effect.each([{ usageLimitSources: true }, { hostThemes: true, usageLimitSources: true }])(
      "replays sources, their removal and a capability downgrade to late subscribers (%j)",
      (optIns) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { session, socket, server } = yield* ready(optIns, wireConfig(SOURCED), optIns);
            const live = yield* Queue.unbounded<DaemonConfigStreamEvent>();
            yield* Effect.forkChild(
              Stream.runForEach(session.subscribeDaemonConfig(optIns), (event) =>
                Queue.offer(live, event),
              ),
            );
            expect((yield* Queue.take(live)).type).toBe("snapshot");

            const prelude = optIns.hostThemes ? [themesEvent([])] : [];
            for (const event of prelude) {
              yield* server.push(event);
              expect(yield* Queue.take(live)).toEqual(event);
            }

            // A live end marker makes a missing or stale replay fail fast instead of hanging.
            const marker = providersEvent([]);
            for (const event of [ONE_SOURCE, NO_SOURCES, ONE_SOURCE, snapshotEvent(THEMED)]) {
              yield* server.push(event);
              expect(yield* Queue.take(live)).toEqual(event);

              const started = yield* Deferred.make<void>();
              const late = yield* Effect.forkChild(
                session.subscribeDaemonConfig(optIns).pipe(
                  Stream.tap(() => Deferred.succeed(started, undefined)),
                  Stream.takeUntil((item) => item.type === "providerStatuses"),
                  Stream.runCollect,
                ),
              );
              yield* Deferred.await(started);
              yield* server.push(marker);
              expect(yield* Queue.take(live)).toEqual(marker);

              const replay = [...(yield* Fiber.join(late))];
              expect(replay.slice(1)).toEqual([
                ...prelude,
                ...(event.type === "snapshot" ? [] : [event]),
                marker,
              ]);
              const sources = fold(snapshotEvent(SOURCED), ONE_SOURCE, ...replay).config
                .usageLimitSources;
              const expected =
                event.type === "usageLimitSourcesUpdated" && event.payload.sources.length > 0
                  ? event.payload.sources
                  : undefined;
              expect(sources).toEqual(expected);
            }
            expect(requests(socket).length).toBe(1);
          }),
        ),
    );

    it.effect("replays only the latest theme list, an empty one included", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const optIns = { hostThemes: true };
          const { session, server } = yield* ready(optIns, WIRE_THEMED, optIns);
          const dusk = [theme("dusk", "Dusk", "#202124", "#8ab4f8")];
          const ink = [theme("ink", "Ink", "#000000", "#f2f2f4")];

          const listening = yield* Deferred.make<void>();
          const listener = yield* Effect.forkChild(
            session.subscribeDaemonConfig(optIns).pipe(
              Stream.mapEffect((event) => Effect.as(Deferred.succeed(listening, undefined), event)),
              Stream.take(4),
              Stream.runCollect,
            ),
          );
          yield* Deferred.await(listening);
          yield* server.push(themesEvent(dusk), themesEvent(ink), themesEvent([]));

          const seen = [...(yield* Fiber.join(listener))];
          expect(seen.map(({ type }) => type)).toEqual([
            "snapshot",
            "hostThemesUpdated",
            "hostThemesUpdated",
            "hostThemesUpdated",
          ]);
          expect(seen[2]).toMatchObject({ payload: { themes: ink } });

          const replay = [
            ...(yield* Stream.runCollect(Stream.take(session.subscribeDaemonConfig(optIns), 2))),
          ];
          expect(replay.map(({ type }) => type)).toEqual(["snapshot", "hostThemesUpdated"]);
          expect(replay[1]).toMatchObject({ payload: { themes: [] } });
          expect(
            fold(snapshotEvent(THEMED), themesEvent(dusk), ...replay).config.hostThemes,
          ).toBeUndefined();
        }),
      ),
    );

    it.effect("brings a subscriber that fell behind back with the deletions it missed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const optIns = { hostThemes: true, usageLimitSources: true };
          const { session, server } = yield* ready(optIns, wireConfig(SOURCED), optIns);

          // The slow subscriber blocks on its first item until released.
          const blocked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let held = false;
          const holdFirst = (event: DaemonConfigStreamEvent) => {
            const wait = held
              ? Effect.void
              : Effect.andThen(Deferred.succeed(blocked, undefined), Deferred.await(release));
            held = true;
            return Effect.map(wait, () => event);
          };
          const delayed = Stream.mapEffect(session.subscribeDaemonConfig(optIns), holdFirst);
          const slow = yield* Effect.forkChild(Stream.runCollect(Stream.take(delayed, 4)));
          yield* Deferred.await(blocked);

          const dusk = [theme("dusk", "Dusk", "#202124", "#8ab4f8")];
          const themeChanges = [
            themesEvent(dusk),
            themesEvent([{ ...dusk[0]!, name: "Dusk 2" }]),
            themesEvent([]),
          ];
          // More than the broadcast buffer holds, so the slow subscriber is lapped.
          const flood = Array.from({ length: 65 }, () =>
            settingsEvent(Contracts.DEFAULT_DAEMON_PREFS),
          );
          const fast = yield* Queue.unbounded<DaemonConfigStreamEvent>();
          yield* Effect.forkChild(
            Stream.runForEach(session.subscribeDaemonConfig(optIns), (event) =>
              Queue.offer(fast, event),
            ),
          );
          expect((yield* Queue.take(fast)).type).toBe("snapshot");
          for (const event of [...themeChanges, ONE_SOURCE, NO_SOURCES, ...flood]) {
            yield* server.push(event);
            expect(yield* Queue.take(fast)).toEqual(event);
          }
          yield* Deferred.succeed(release, undefined);

          const caughtUp = [...(yield* Fiber.join(slow))];
          expect(caughtUp.map(({ type }) => type)).toEqual([
            "snapshot",
            "snapshot",
            "hostThemesUpdated",
            "usageLimitSourcesUpdated",
          ]);
          expect(caughtUp[2]).toMatchObject({ payload: { themes: [] } });
          expect(caughtUp[3]).toMatchObject({ payload: { sources: [] } });
          const config = fold(
            snapshotEvent(SOURCED),
            themeChanges[0]!,
            ONE_SOURCE,
            ...caughtUp.slice(1),
          ).config;
          expect([config.hostThemes, config.usageLimitSources]).toEqual([undefined, undefined]);
        }),
      ),
    );

    it.effect.each([{ failure: "defect" as const }, { failure: "typed" as const }])(
      "keeps the durable config state across a $failure failure of the owning session",
      (row) => {
        const { failure } = row;
        const run = Effect.gen(function* () {
          const optIns = { hostThemes: true };
          const first = yield* ready(optIns, WIRE_THEMED, optIns);
          const current = yield* SubscriptionRef.make(Option.some(first.session));
          const supervisor = HostSupervisor.HostSupervisor.of({
            target: HOST,
            session: current,
            state: yield* SubscriptionRef.make(Link.AVAILABLE_LINK_STATE),
            prepared: yield* SubscriptionRef.make(Option.some(LINK)),
            retryNow: Effect.void,
            disconnect: Effect.void,
            connect: Effect.void,
          } satisfies HostSupervisor.HostSupervisor["Service"]);
          const none = () => Effect.succeed(Option.none());
          const cache = Persistence.HostCacheStore.of({
            loadThread: none,
            loadShell: none,
            loadDaemonConfig: none,
            saveThread: () => Effect.void,
            saveShell: () => Effect.void,
            saveDaemonConfig: () => Effect.void,
            removeThread: () => Effect.void,
            clear: () => Effect.void,
          });
          const state = yield* makeHostDaemonConfigState(optIns).pipe(
            Effect.provideService(Persistence.HostCacheStore, cache),
            Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
          );
          const nextConfig = (matches: (config: DaemonConfig) => boolean) =>
            Effect.forkChild(
              SubscriptionRef.changes(state).pipe(
                Stream.filter(Option.isSome),
                Stream.map(({ value }) => value.config),
                Stream.filter(matches),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              ),
            );

          const before = [theme("before", "Before", "#111111", "#fafafa")];
          const sawBefore = yield* nextConfig((config) => config.hostThemes?.[0]?.id === "before");
          yield* first.server.push(themesEvent(before));
          expect((yield* Fiber.join(sawBefore)).hostThemes).toEqual(before);

          const ended = yield* Effect.forkChild(Effect.exit(first.session.closed));
          const configRequest = yield* nthRequest(first.socket);
          if (failure === "defect") {
            first.server.defect("config source crashed");
          } else {
            first.server.exit(configRequest.id, {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "HostAuthorizationError",
                    requiredScope: "chat:read",
                    message: "subscription refused",
                  },
                },
              ],
            });
          }
          const exit = yield* Fiber.join(ended);
          expect(Exit.isFailure(exit)).toBe(true);
          if (failure === "typed" && Exit.isFailure(exit)) {
            const squashed = Cause.squash(exit.cause);
            expect(squashed).toBeInstanceOf(Link.LinkBlockedError);
            expect(squashed).toMatchObject({ reason: "permission" });
          }
          yield* SubscriptionRef.set(current, Option.none());

          const renamed: DaemonConfig = {
            ...THEMED,
            environment: { ...THEMED.environment, label: "Back again" },
          };
          const second = yield* first.factory.connect(LINK);
          const secondReady = yield* Effect.forkChild(second.ready);
          const secondSocket = yield* nthSocket(first.sockets, 1);
          secondSocket.accept();
          yield* serverOn(secondSocket).snapshot(wireConfig(renamed), optIns);
          yield* Fiber.join(secondReady);

          // The new session's snapshot does not carry themes, but the state remembers them.
          const sawBack = yield* nextConfig((config) => config.environment.label === "Back again");
          yield* SubscriptionRef.set(current, Option.some(second));
          expect((yield* Fiber.join(sawBack)).hostThemes).toEqual(before);

          const after = [theme("after", "After", "#000000", "#e0e0e0")];
          const sawAfter = yield* nextConfig((config) => config.hostThemes?.[0]?.id === "after");
          yield* serverOn(secondSocket).push(themesEvent(after));
          expect((yield* Fiber.join(sawAfter)).hostThemes).toEqual(after);
        });
        return Effect.scoped(run);
      },
    );
  });
});

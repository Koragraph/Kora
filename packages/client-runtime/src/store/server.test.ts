import { describe, expect, it } from "@effect/vitest";
import {
  HostId,
  RPC_METHODS,
  type DaemonConfig,
  type DaemonConfigStreamEvent,
  type DaemonLifecycleWelcomePayload,
} from "@kora/contracts";
import { Deferred, Effect, Fiber, Option, Queue, Stream, SubscriptionRef } from "effect";

import { AVAILABLE_LINK_STATE, LocalLinkTarget, type PreparedLink } from "../link/model.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import * as Persistence from "../embedder/hostCache.ts";
import type { KoraRpcClient } from "../wire/protocol.ts";
import type { RpcSession } from "../wire/session.ts";
import { applyDaemonConfigProjection } from "./daemonConfigProjection.ts";
import {
  applyDaemonWelcomeEvent,
  makeHostDaemonConfigState,
  makeHostDaemonWelcomeState,
  resolveDaemonConfigValue,
  resolveDaemonWelcomeState,
} from "./server.ts";

const BASE_CONFIG = {
  settings: {},
  providers: [],
  availableEditors: [],
  observability: null,
  // Capabilities drive version-skew behaviour in the projection, so the
  // fixture carries them rather than leaving the field absent.
  environment: { capabilities: { hostThemes: true } },
} as unknown as DaemonConfig;

const snapshotOf = (config: DaemonConfig): DaemonConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new LocalLinkTarget({
  wsBaseUrl: "wss://host-one.test",
  httpBaseUrl: "https://host-one.test",
  hostId: HostId.make("environment-1"),
  label: "Host one",
});

const sessionOver = (client: KoraRpcClient): RpcSession => {
  const lifecycle = { closed: Effect.never, probe: Effect.void, ready: Effect.void };
  return {
    ...lifecycle,
    client,
    subscribeDaemonConfig: (input) => client.subscribeDaemonConfig(input),
    initialConfig: Effect.succeed(BASE_CONFIG),
  };
};

const bareClient = {} as KoraRpcClient;
const clientWith = (methods: Record<string, () => unknown>) => methods as unknown as KoraRpcClient;
const lifecycleClient = (stream: () => unknown) =>
  clientWith({ [RPC_METHODS.subscribeDaemonLifecycle]: stream });

/** Completes `subscribed` as soon as the stream is pulled, then continues with `rest`. */
const announceThen = <A>(subscribed: Deferred.Deferred<void>, rest: Stream.Stream<A>) =>
  Stream.concat(Stream.drain(Stream.fromEffect(Deferred.succeed(subscribed, undefined))), rest);

type LifecycleEvent = { readonly type: "welcome" | "ready"; readonly payload: unknown };

const welcomeFor = (cwd: string, projectName = cwd.slice(1)) =>
  ({
    environment: {} as DaemonLifecycleWelcomePayload["environment"],
    cwd,
    projectName,
  }) as DaemonLifecycleWelcomePayload;

/** A supervisor whose active session can be swapped through the returned ref. */
const supervisorOver = (initial: RpcSession | null) =>
  Effect.gen(function* () {
    const sessionSlot = yield* SubscriptionRef.make(Option.fromNullishOr(initial));
    const [state, prepared] = yield* Effect.all([
      SubscriptionRef.make(AVAILABLE_LINK_STATE),
      SubscriptionRef.make(Option.none<PreparedLink>()),
    ]);
    const service: HostSupervisor.HostSupervisor["Service"] = {
      session: sessionSlot,
      state,
      prepared,
      target: TARGET,
      retryNow: Effect.void,
      disconnect: Effect.void,
      connect: Effect.void,
    };
    return { sessionSlot, supervisor: HostSupervisor.HostSupervisor.of(service) };
  });

const nothing = () => Effect.void;
const missing = () => Effect.succeed(Option.none());

const emptyCache = (overrides: Partial<Persistence.HostCacheStore["Service"]> = {}) =>
  Persistence.HostCacheStore.of({
    clear: nothing,
    loadDaemonConfig: missing,
    saveDaemonConfig: nothing,
    loadShell: missing,
    loadThread: missing,
    removeThread: nothing,
    saveShell: nothing,
    saveThread: nothing,
    ...overrides,
  });

const NIGHTFALL = [
  { appearance: "dark", accent: "#7aa2f7", canvas: "#1a1b26", name: "Nightfall", id: "nightfall" },
] as const;

const projectAll = (...events: ReadonlyArray<DaemonConfigStreamEvent>) =>
  events.reduce(
    (state, event) => applyDaemonConfigProjection(state, event),
    Option.none() as ReturnType<typeof applyDaemonConfigProjection>,
  );

const themesUpdated = (
  themes: ReadonlyArray<(typeof NIGHTFALL)[number]>,
): DaemonConfigStreamEvent => ({
  version: 1,
  type: "hostThemesUpdated",
  payload: { themes },
});

type WelcomeRef = SubscriptionRef.SubscriptionRef<Parameters<typeof resolveDaemonWelcomeState>[0]>;

/** Forks a watcher for the first value of the stream that passes `keep`. */
const firstMatch = <A>(values: Stream.Stream<A>, keep: (value: A) => boolean) =>
  Effect.forkChild(Effect.map(Stream.runHead(Stream.filter(values, keep)), Option.getOrThrow));

/** Builds the welcome state against the given supervisor. */
const welcomeStateUnder = (supervisor: HostSupervisor.HostSupervisor["Service"]) =>
  Effect.provideService(makeHostDaemonWelcomeState(), HostSupervisor.HostSupervisor, supervisor);

/** Resolved welcome payloads as they change. */
const resolvedWelcomes = (state: WelcomeRef) =>
  Stream.map(SubscriptionRef.changes(state), resolveDaemonWelcomeState);

describe("server state projection", () => {
  describe("config projection", () => {
    it("lets every config category update the projected snapshot", () => {
      const settings = { ...BASE_CONFIG.settings };
      const update: DaemonConfigStreamEvent = {
        payload: { settings },
        type: "settingsUpdated",
        version: 1,
      };
      const { config, latestEvent } = Option.getOrThrow(
        projectAll(snapshotOf(BASE_CONFIG), update),
      );
      expect([config.settings, latestEvent.type]).toEqual([settings, "settingsUpdated"]);
      expect(config.settings).toBe(settings);
    });

    it("adds published environment themes to the snapshot and removes them again", () => {
      const published = projectAll(snapshotOf(BASE_CONFIG), themesUpdated(NIGHTFALL));
      expect(Option.getOrThrow(published).config.hostThemes).toEqual(NIGHTFALL);

      // A machine that stops publishing has to clear the palettes, not freeze
      // clients on the last set it sent.
      const unpublished = applyDaemonConfigProjection(published, themesUpdated([]));
      expect(Option.getOrThrow(unpublished).config.hostThemes).toBeUndefined();
    });

    // A snapshot never carries published themes, so taking it wholesale would
    // clear them on every reconnect and repaint anyone wearing one.
    it("holds on to published themes through a reconnect snapshot", () => {
      const withThemes = projectAll(snapshotOf(BASE_CONFIG), themesUpdated(NIGHTFALL));
      expect(Option.getOrThrow(withThemes).config.hostThemes).toEqual(NIGHTFALL);

      const reconnected = applyDaemonConfigProjection(withThemes, snapshotOf(BASE_CONFIG));
      expect(Option.getOrThrow(reconnected).config.hostThemes).toEqual(NIGHTFALL);

      // A server older than the feature never sends another theme event, so
      // carrying the set forward would leave a palette nothing can update.
      const olderServer = applyDaemonConfigProjection(
        withThemes,
        snapshotOf({
          ...BASE_CONFIG,
          environment: { capabilities: {} },
        } as unknown as DaemonConfig),
      );
      expect(Option.getOrThrow(olderServer).config.hostThemes).toBeUndefined();
    });

    it("prefers the live session's config over the cache until a live event arrives", () => {
      const configFrom = (source: string, serverVersion: string) =>
        ({
          ...BASE_CONFIG,
          environment: { serverVersion },
          settings: { source },
        }) as unknown as DaemonConfig;
      const cached = configFrom("cache", "0.0.29");
      const staleLive = configFrom("stale-live", "0.0.29");
      const fromSession = configFrom("session", "0.0.30");
      const freshLive = configFrom("live", "0.0.30");
      const resolveWith = (config: DaemonConfig, source: "cache" | "live") =>
        resolveDaemonConfigValue({ config, latestEvent: snapshotOf(config), source }, fromSession);

      expect(resolveWith(cached, "cache")).toBe(fromSession);
      expect(resolveWith(staleLive, "live")).toBe(fromSession);
      expect(resolveWith(freshLive, "live")).toBe(freshLive);
    });
  });

  describe("welcome state", () => {
    it("holds a current welcome through ready and ignores a buffered one from the old session", () => {
      const firstSession = sessionOver(bareClient);
      const secondSession = sessionOver(bareClient);
      const welcome = welcomeFor("/repo", "repo");
      const initial: Parameters<typeof resolveDaemonWelcomeState>[0] = {
        welcome: null,
        welcomeSession: firstSession,
        currentSession: firstSession,
      };

      const from = (state: typeof initial, type: LifecycleEvent["type"], payload: unknown) =>
        applyDaemonWelcomeEvent(state, firstSession, { payload, type });
      const afterWelcome = from(initial, "welcome", welcome);
      const afterReady = from(afterWelcome, "ready", {});
      const afterSwitch = { ...afterReady, currentSession: secondSession };
      const afterOldWelcome = from(afterSwitch, "welcome", welcomeFor("/stale", "repo"));

      expect(afterReady).toBe(afterWelcome);
      expect(resolveDaemonWelcomeState(afterReady)).toBe(welcome);
      expect(afterOldWelcome).toBe(afterSwitch);
      expect(resolveDaemonWelcomeState(afterOldWelcome)).toBeNull();
    });

    it.effect("asks which session is authoritative before accepting a buffered welcome", () =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<LifecycleEvent>();
        const firstSubscribed = yield* Deferred.make<void>();
        const firstSession = sessionOver(
          lifecycleClient(() => announceThen(firstSubscribed, Stream.fromQueue(firstEvents))),
        );
        const secondSession = sessionOver(bareClient);
        const { supervisor, sessionSlot } = yield* supervisorOver(firstSession);
        const staleWelcome = welcomeFor("/stale");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* welcomeStateUnder(supervisor);
            yield* Deferred.await(firstSubscribed);

            // The slot is swapped directly: the ref holds the new session while neither
            // subscriber has seen the change yet.
            sessionSlot.value = Option.some(secondSession);
            const settled = yield* firstMatch(
              SubscriptionRef.changes(state),
              ({ currentSession, welcome }) =>
                welcome === staleWelcome || currentSession === secondSession,
            );
            yield* Queue.offer(firstEvents, { payload: staleWelcome, type: "welcome" });

            const landed = yield* Fiber.join(settled);
            expect(resolveDaemonWelcomeState(landed)).toBeNull();
            expect(landed.currentSession).toBe(secondSession);
          }),
        );
      }),
    );

    it.effect("looks up the authoritative session only after the welcome lock is free", () =>
      Effect.gen(function* () {
        const firstSubscribed = yield* Deferred.make<void>();
        const firstSession = sessionOver(
          lifecycleClient(() => announceThen(firstSubscribed, Stream.empty)),
        );
        const secondSession = sessionOver(lifecycleClient(() => Stream.never));
        const thirdSession = sessionOver(bareClient);
        const { supervisor, sessionSlot } = yield* supervisorOver(firstSession);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* welcomeStateUnder(supervisor);
            yield* Deferred.await(firstSubscribed);
            const switched = yield* firstMatch(
              SubscriptionRef.changes(state),
              (value) => value.currentSession !== firstSession,
            );

            yield* state.semaphore.withPermit(
              Effect.gen(function* () {
                yield* SubscriptionRef.set(sessionSlot, Option.some(secondSession));
                for (let n = 0; n < 3; n += 1) yield* Effect.yieldNow;
                sessionSlot.value = Option.some(thirdSession);
              }),
            );

            expect((yield* Fiber.join(switched)).currentSession).toBe(thirdSession);
          }),
        );
      }),
    );

    it.effect("clears the welcome until the reconnected session sends its own", () =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<LifecycleEvent>();
        const secondEvents = yield* Queue.unbounded<LifecycleEvent>();
        const firstSession = sessionOver(lifecycleClient(() => Stream.fromQueue(firstEvents)));
        const secondSession = sessionOver(lifecycleClient(() => Stream.fromQueue(secondEvents)));
        const { supervisor, sessionSlot } = yield* supervisorOver(firstSession);
        const firstWelcome = welcomeFor("/first");
        const secondWelcome = welcomeFor("/second");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* welcomeStateUnder(supervisor);
            const watchFor = (want: DaemonLifecycleWelcomePayload | null) =>
              firstMatch(resolvedWelcomes(state), (value) => value === want);

            const sawFirst = yield* watchFor(firstWelcome);
            yield* Queue.offer(firstEvents, { type: "welcome", payload: firstWelcome });
            expect(yield* Fiber.join(sawFirst)).toBe(firstWelcome);

            const sawCleared = yield* watchFor(null);
            yield* SubscriptionRef.set(sessionSlot, Option.some(secondSession));
            expect(yield* Fiber.join(sawCleared)).toBeNull();
            expect(resolveDaemonWelcomeState(yield* SubscriptionRef.get(state))).toBeNull();

            const sawSecond = yield* watchFor(secondWelcome);
            yield* Queue.offer(secondEvents, { type: "welcome", payload: secondWelcome });
            expect(yield* Fiber.join(sawSecond)).toBe(secondWelcome);
          }),
        );
      }),
    );
  });

  describe("config state", () => {
    it.effect("starts from the cached config and saves the projection of live updates", () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<DaemonConfigStreamEvent>();
        const client = clientWith({
          [RPC_METHODS.subscribeDaemonConfig]: () => Stream.fromQueue(events),
        });
        const { supervisor } = yield* supervisorOver(sessionOver(client));
        const savedConfigs = yield* Queue.unbounded<DaemonConfig>();
        const cache = emptyCache({
          loadDaemonConfig: () => Effect.succeed(Option.some(BASE_CONFIG)),
          saveDaemonConfig: (_hostId, config) => Queue.offer(savedConfigs, config),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* makeHostDaemonConfigState({}).pipe(
              Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
              Effect.provideService(Persistence.HostCacheStore, cache),
            );
            expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(BASE_CONFIG);

            const providers: DaemonConfig["providers"] = [];
            const statuses: DaemonConfigStreamEvent = {
              payload: { providers },
              version: 1,
              type: "providerStatuses",
            };
            yield* Queue.offer(events, statuses);
            const projected = yield* Fiber.join(
              yield* firstMatch(SubscriptionRef.changes(state), (value) =>
                Option.exists(value, ({ latestEvent }) => latestEvent.type === "providerStatuses"),
              ),
            );
            expect(Option.getOrThrow(projected).config.providers).toBe(providers);
          }),
        );

        expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
      }),
    );

    it.effect("leaves the cached config untouched while no live update comes in", () =>
      Effect.gen(function* () {
        const client = clientWith({ [RPC_METHODS.subscribeDaemonConfig]: () => Stream.empty });
        const { supervisor } = yield* supervisorOver(sessionOver(client));
        const savedConfigs = yield* Queue.unbounded<DaemonConfig>();
        const cache = emptyCache({
          loadDaemonConfig: () => Effect.succeed(Option.some(BASE_CONFIG)),
          saveDaemonConfig: (_hostId, config) => Queue.offer(savedConfigs, config),
        });

        yield* Effect.scoped(
          makeHostDaemonConfigState({}).pipe(
            Effect.provideService(HostSupervisor.HostSupervisor, supervisor),
            Effect.provideService(Persistence.HostCacheStore, cache),
          ),
        );

        expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
      }),
    );
  });
});

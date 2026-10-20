import {
  type HostId,
  type DaemonLifecycleWelcomePayload,
  type DaemonConfigStreamEvent,
  type DaemonConfig,
  RPC_METHODS,
} from "@kora/contracts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { errorLogFields } from "../failures/logFields.ts";
import type { HostRegistry } from "../link/registry.ts";
import * as HostSupervisor from "../link/supervisor.ts";
import { HostCacheStore } from "../embedder/hostCache.ts";
import { subscribeDynamic, subscribeDynamicWithSession } from "../wire/client.ts";
import type { RpcSession } from "../wire/session.ts";
import {
  type DaemonConfigProjection,
  withoutHostThemes,
  applyDaemonConfigProjection,
} from "./daemonConfigProjection.ts";
import { createAtomActionScheduler, createHostRpcCommand, followStreamInHost } from "./runtime.ts";

export type { DaemonConfigProjection } from "./daemonConfigProjection.ts";

const SAVE_DEBOUNCE = Duration.millis(500);
const IDLE_TTL_MS = 5 * 60_000;

// ---- Daemon configuration ------------------------------------------------------------------

export interface DaemonConfigSubscriptionOptions {
  readonly hostThemes?: boolean;
  readonly usageLimitSources?: boolean;
  readonly usageLimitsCommand?: boolean;
}

const cachedProjection = (config: DaemonConfig): DaemonConfigProjection => {
  // An older build may have cached published themes; they are machine state, never cache state.
  const stripped = withoutHostThemes(config);
  return {
    config: stripped,
    latestEvent: { version: 1, type: "snapshot", config: stripped },
    source: "cache",
  };
};

export const makeHostDaemonConfigState = Effect.fn("clientRuntime.state.makeHostDaemonConfigState")(
  function* (subscription: DaemonConfigSubscriptionOptions) {
    const supervisor = yield* HostSupervisor.HostSupervisor;
    const cache = yield* HostCacheStore;
    const hostId = supervisor.target.hostId;

    const cached = yield* cache.loadDaemonConfig(hostId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.", {
          hostId,
          ...errorLogFields(error),
        }).pipe(Effect.as(Option.none<DaemonConfig>())),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<DaemonConfigProjection>>(
      Option.map(cached, cachedProjection),
    );

    // The newest live config not yet on disk; written after 500 ms without further changes.
    let unsaved: DaemonConfig | undefined;
    const save = (config: DaemonConfig) =>
      cache.saveDaemonConfig(hostId, withoutHostThemes(config)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (unsaved === config) unsaved = undefined;
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.", {
            hostId,
            ...errorLogFields(error),
          }),
        ),
      );

    const saveQueue = yield* Queue.sliding<DaemonConfig>(1);
    yield* Stream.fromQueue(saveQueue).pipe(
      Stream.debounce(SAVE_DEBOUNCE),
      Stream.runForEach(save),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => (unsaved === undefined ? Effect.void : save(unsaved)));

    const flags = {
      ...(subscription.hostThemes === true ? { hostThemes: true as const } : {}),
      ...(subscription.usageLimitSources === true ? { usageLimitSources: true as const } : {}),
      ...(subscription.usageLimitsCommand === true ? { usageLimitsCommand: true as const } : {}),
    };

    yield* subscribeDynamic(RPC_METHODS.subscribeDaemonConfig, () => Effect.succeed(flags)).pipe(
      Stream.runForEach((event: DaemonConfigStreamEvent) =>
        Effect.gen(function* () {
          const next = applyDaemonConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) return;
          unsaved = next.value.config;
          yield* SubscriptionRef.set(state, next);
          Queue.offerUnsafe(saveQueue, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

/** The config to show: a live projection of this server, else the session's bootstrap, else cache. */
export function resolveDaemonConfigValue(
  projection: DaemonConfigProjection | null,
  initialConfig: DaemonConfig | null,
): DaemonConfig | null {
  const liveProjection = projection?.source === "live" ? projection : null;
  const sameServer =
    initialConfig === null ||
    liveProjection?.config.environment.serverVersion === initialConfig.environment.serverVersion;
  if (liveProjection && sameServer) return liveProjection.config;
  return initialConfig ?? projection?.config ?? null;
}

// ---- Welcome payload ---------------------------------------------------------------------------

type SessionSlots = Record<"currentSession" | "welcomeSession", RpcSession | null>;

export type HostDaemonWelcomeState = Readonly<
  SessionSlots & { welcome: DaemonLifecycleWelcomePayload | null }
>;

type LifecycleEvent = { readonly type: "welcome" | "ready"; readonly payload: unknown };

export function applyDaemonWelcomeEvent(
  current: HostDaemonWelcomeState,
  session: RpcSession,
  event: LifecycleEvent,
): HostDaemonWelcomeState {
  // Only a welcome from the session in charge replaces the payload.
  const counts = event.type === "welcome" && session === current.currentSession;
  return counts ? { ...current, welcome: event.payload as DaemonLifecycleWelcomePayload } : current;
}

/** A welcome only counts while it belongs to the session that is current; older payloads are hidden. */
export function resolveDaemonWelcomeState(
  state: HostDaemonWelcomeState,
): DaemonLifecycleWelcomePayload | null {
  return state.currentSession === state.welcomeSession ? state.welcome : null;
}

export const makeHostDaemonWelcomeState = Effect.fn(
  "clientRuntime.state.makeHostDaemonWelcomeState",
)(function* () {
  const supervisor = yield* HostSupervisor.HostSupervisor;
  const sessionNow = SubscriptionRef.get(supervisor.session).pipe(
    Effect.map((session) => Option.getOrNull(session)),
  );
  const state = yield* SubscriptionRef.make<HostDaemonWelcomeState>({
    currentSession: yield* sessionNow,
    welcomeSession: null,
    welcome: null,
  });

  // Every change re-reads the supervisor from inside the state's lock: a publication seen here
  // may already be stale by the time the lock is free.
  const refresh = (change: (current: HostDaemonWelcomeState) => HostDaemonWelcomeState) =>
    SubscriptionRef.updateEffect(state, (current) =>
      sessionNow.pipe(Effect.map((currentSession) => change({ ...current, currentSession }))),
    );

  yield* SubscriptionRef.changes(supervisor.session).pipe(
    Stream.runForEach(() => refresh((current) => current)),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* subscribeDynamicWithSession(RPC_METHODS.subscribeDaemonLifecycle, (session) =>
    refresh((current) => ({
      ...current,
      welcomeSession: session,
      welcome: current.currentSession === session ? null : current.welcome,
    })).pipe(Effect.as({})),
  ).pipe(
    Stream.runForEach(([session, event]) =>
      refresh((current) => applyDaemonWelcomeEvent(current, session, event)),
    ),
    Effect.forkScoped,
  );

  return state;
});

// ---- Atoms -----------------------------------------------------------------------------------------

export function createDaemonHostAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | HostCacheStore | R, E>,
  options: {
    readonly initialConfigValueAtom: (hostId: HostId) => Atom.Atom<DaemonConfig | null>;
    readonly hostThemes?: boolean;
    readonly usageLimitSources?: boolean;
    readonly usageLimitsCommand?: boolean;
  },
) {
  const subscription: DaemonConfigSubscriptionOptions = {
    ...(options.hostThemes === undefined ? {} : { hostThemes: options.hostThemes }),
    ...(options.usageLimitSources === undefined
      ? {}
      : { usageLimitSources: options.usageLimitSources }),
    ...(options.usageLimitsCommand === undefined
      ? {}
      : { usageLimitsCommand: options.usageLimitsCommand }),
  };

  const projectionByHost = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const config = yield* makeHostDaemonConfigState(subscription);
              return SubscriptionRef.changes(config).pipe(Stream.map(Option.getOrNull));
            }),
          ),
        ),
        { initialValue: null as DaemonConfigProjection | null },
      )
      .pipe(
        Atom.setIdleTTL(IDLE_TTL_MS),
        Atom.withLabel(`environment-data:server:config-projection:${hostId}`),
      ),
  );
  const configProjection = (target: { readonly hostId: HostId; readonly input?: unknown }) =>
    projectionByHost(target.hostId);

  const noConfigAtom = Atom.make<DaemonConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:none"),
  );
  const configByHost = Atom.family((hostId: HostId) =>
    Atom.make((get): DaemonConfig | null => {
      const projection = Option.getOrNull(AsyncResult.value(get(projectionByHost(hostId))));
      return resolveDaemonConfigValue(projection, get(options.initialConfigValueAtom(hostId)));
    }).pipe(Atom.withLabel(`environment-data:server:config:${hostId}`)),
  );
  const configValueAtom = (hostId: HostId | null) =>
    hostId === null ? noConfigAtom : configByHost(hostId);

  const configField = <Field extends "settings" | "providers">(field: Field) =>
    Atom.family((hostId: HostId) => {
      const read = Atom.make((get) => {
        const config = get(configValueAtom(hostId));
        return config === null ? null : config[field];
      });
      return read.pipe(Atom.withLabel(`environment-data:server:${field}:${hostId}`));
    });
  const settingsValueAtom = configField("settings");
  const providersValueAtom = configField("providers");

  const welcomeStateByHost = Atom.family((hostId: HostId) =>
    runtime
      .atom(
        followStreamInHost(
          hostId,
          Stream.unwrap(
            Effect.gen(function* () {
              const welcome = yield* makeHostDaemonWelcomeState();
              return SubscriptionRef.changes(welcome).pipe(Stream.map(resolveDaemonWelcomeState));
            }),
          ),
        ),
        { initialValue: null as DaemonLifecycleWelcomePayload | null },
      )
      .pipe(
        Atom.setIdleTTL(IDLE_TTL_MS),
        Atom.withLabel(`environment-data:server:welcome-state:${hostId}`),
      ),
  );
  const welcomeByHost = Atom.family((hostId: HostId) =>
    Atom.make((get): AsyncResult.AsyncResult<DaemonLifecycleWelcomePayload, never> => {
      const payload = Option.flatten(
        AsyncResult.value(get(welcomeStateByHost(hostId))).pipe(Option.map(Option.fromNullishOr)),
      );
      return Option.isSome(payload) ? AsyncResult.success(payload.value) : AsyncResult.initial();
    }).pipe(Atom.withLabel(`environment-data:server:welcome:${hostId}`)),
  );
  const welcome = (target: { readonly hostId: HostId; readonly input?: unknown }) =>
    welcomeByHost(target.hostId);

  const scheduler = createAtomActionScheduler();
  const updateSettings = createHostRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: RPC_METHODS.daemonPrefsUpdate,
    scheduler,
    concurrency: { mode: "serial", key: (target) => target.hostId },
  });

  return {
    welcome,
    configProjection,
    updateSettings,
    configValueAtom,
    providersValueAtom,
    settingsValueAtom,
  };
}

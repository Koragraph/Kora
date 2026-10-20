/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import * as Struct from "effect/Struct";
import {
  type UnifiedPrefs,
  type HostIdentificationMode,
  DEFAULT_CLIENT_PREFS,
  type ClientPrefs,
  type ClientPrefsPatch,
} from "@kora/contracts/clientPrefs";
import {
  type DaemonPrefsPatch,
  DaemonPrefs,
  type HostId,
  DEFAULT_DAEMON_PREFS,
} from "@kora/contracts";
import {
  supportsSharedPrefsSync,
  splitSharedDaemonPatch,
  filterSharedDaemonPatch,
} from "@kora/client-runtime/store/shared-prefs";
import { errorLogFields } from "@kora/client-runtime/failures";
import { useAtomValue } from "@effect/atom-react";

import { localApiOrThrow } from "~/localApi";
import { toastManager } from "~/components/ui/toast";
import { useAtomAction } from "~/atoms/use-atom-command";
import { primaryDaemonPrefsAtom, daemonHost } from "~/atoms/server";
import { useHosts, usePrimaryHost } from "~/atoms/hosts";

type UnifiedPrefsPatch = DaemonPrefsPatch & ClientPrefsPatch;

const logPersistence = (operation: "hydrate" | "persist", err: unknown) =>
  console.error(`[client prefs] ${operation} failed`, { operation, ...errorLogFields(err) });

type LoadState = "pending" | "ready" | "failed" | "retrying";

/**
 * The client's own preferences (stored by the shell or in browser storage), loaded once and kept in memory.
 *
 * Until the saved preferences have loaded, the schema defaults stand in; a write made before then waits for the load
 * and is applied on top of it, so defaults never overwrite what the user saved. Writes are persisted one at a time,
 * each saving the whole current document.
 */
class ClientPrefsStore {
  value: ClientPrefs = DEFAULT_CLIENT_PREFS;
  state: LoadState = "pending";
  private loading: Promise<void> | null = null;
  /** Bumped by test resets, so a load started before a reset cannot land after it. */
  private epoch = 0;
  private saves: Promise<void> = Promise.resolve();
  /** Writes waiting for the load (or for an earlier waiting write); later writes queue behind them. */
  private waitingWrites = 0;
  readonly valueListeners = new Set<() => void>();
  readonly stateListeners = new Set<() => void>();

  private replace(next: ClientPrefs): void {
    this.value = next;
    for (const listener of this.valueListeners) listener();
  }

  private setState(next: LoadState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) listener();
  }

  /** Loads the saved preferences (once; a failed load can be retried and never applies defaults over them). */
  load(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    this.setState(this.state === "failed" || this.state === "retrying" ? "retrying" : "pending");
    // Through a promise, so a missing local API rejects instead of throwing out of a subscriber.
    const run = new Promise<ClientPrefs | null>((resolve) =>
      resolve(localApiOrThrow().persistence.getClientPrefs()),
    ).then(
      (saved) => {
        if (epoch !== this.epoch) return;
        if (saved) this.replace({ ...DEFAULT_CLIENT_PREFS, ...saved });
        this.setState("ready");
      },
      (err: unknown) => {
        if (epoch === this.epoch) this.setState("failed");
        logPersistence("hydrate", err);
        throw err;
      },
    );
    const tracked: Promise<void> = run.finally(() => {
      if (this.loading === tracked) this.loading = null;
    });
    this.loading = tracked;
    return tracked;
  }

  write(patch: ClientPrefsPatch, persist: (prefs: ClientPrefs) => Promise<void>): Promise<void> {
    const mustWait = this.state !== "ready" || this.waitingWrites > 0;
    if (mustWait) this.waitingWrites += 1;
    else this.replace({ ...this.value, ...patch });
    const job = this.saves.then(async () => {
      if (mustWait) {
        try {
          if (this.state !== "ready") await this.load();
          this.replace({ ...this.value, ...patch });
        } finally {
          this.waitingWrites -= 1;
        }
      }
      await persist(this.value);
    });
    this.saves = job.then(
      () => undefined,
      () => undefined,
    );
    return job.catch((err: unknown) => logPersistence("persist", err));
  }

  /** Back to a fresh, unloaded store (tests). */
  reset(value: ClientPrefs = DEFAULT_CLIENT_PREFS, state: LoadState = "pending"): void {
    this.epoch += 1;
    this.value = value;
    this.state = state;
    this.loading = null;
    if (state === "pending") {
      this.saves = Promise.resolve();
      this.waitingWrites = 0;
      this.valueListeners.clear();
      this.stateListeners.clear();
    }
  }
}

const clientPrefs = new ClientPrefsStore();

/** `listener` for changes in `set`, starting a load if none has happened yet. */
const listenAndLoad = (set: Set<() => void>) => (listener: () => void) => {
  set.add(listener);
  void clientPrefs.load().catch(() => undefined);
  return () => void set.delete(listener);
};
const subscribeClientPrefs = listenAndLoad(clientPrefs.valueListeners);
const subscribeClientPrefsHydration = listenAndLoad(clientPrefs.stateListeners);

export function persistClientPrefsPatch(
  delta: ClientPrefsPatch,
  persist: (conf: ClientPrefs) => Promise<void> = (prefs) =>
    localApiOrThrow().persistence.setClientPrefs(prefs),
): Promise<void> {
  return clientPrefs.write(delta, persist);
}

// ── Key sets for routing patches ─────────────────────────────────────

const DAEMON_PREFS_KEYS = new Set<string>(Struct.keys(DaemonPrefs.fields));

function splitPatch(delta: UnifiedPrefsPatch): {
  serverPatch: DaemonPrefsPatch;
  clientPatch: ClientPrefsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delta)) {
    if (DAEMON_PREFS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as DaemonPrefsPatch,
    clientPatch: clientPatch as ClientPrefsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientPrefs(): ClientPrefs {
  return clientPrefs.value;
}

/**
 * Resolves after settings load or storage confirms no saved settings exist.
 * Failed reads reject and remain retryable. They must not allow defaults to
 * overwrite saved preferences.
 *
 * The pre-hydration snapshot is just the schema defaults, so imperative paths
 * that open a preview must await this or they bake the built-in viewport, zoom
 * and appearance into a tab that never picks up the user's saved values.
 */
export function ensureClientPrefsHydrated(): Promise<void> {
  return clientPrefs.load();
}

export function useClientPrefsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientPrefsHydration,
    () => clientPrefs.state === "ready",
    () => false,
  );
}

function useClientPrefsValue(): ClientPrefs {
  return useSyncExternalStore(
    subscribeClientPrefs,
    () => clientPrefs.value,
    () => DEFAULT_CLIENT_PREFS,
  );
}

export function mergeHostPrefs(daemonPrefs: DaemonPrefs, clientPrefs: ClientPrefs): UnifiedPrefs {
  // Decode drops retired client keys, but older untyped persistence adapters
  // can still return them. Server-owned values must always win.
  return { ...clientPrefs, ...daemonPrefs };
}

function useMergedPrefs<Item>(
  daemonPrefs: DaemonPrefs,
  select: ((conf: UnifiedPrefs) => Item) | undefined,
): Item {
  const clientPrefs = useClientPrefsValue();

  const combined = useMemo<UnifiedPrefs>(
    () => mergeHostPrefs(daemonPrefs, clientPrefs),
    [clientPrefs, daemonPrefs],
  );

  return useMemo(() => (select ? select(combined) : (combined as Item)), [combined, select]);
}

export function useClientPrefs<Item = ClientPrefs>(select?: (conf: ClientPrefs) => Item): Item {
  const conf = useClientPrefsValue();
  return useMemo(() => (select ? select(conf) : (conf as Item)), [select, conf]);
}

export function resolveHostIdentificationMode(args: {
  paletteThemeAllowsArtwork?: boolean;
  paletteThemeActive?: boolean;
  settingsHydrated: boolean;
  mode: HostIdentificationMode;
}): HostIdentificationMode {
  // Avoid briefly rendering the default artwork before a persisted pill/none choice loads.
  if (!args.settingsHydrated) return "none";
  // Artwork palettes are maintained for built-ins only. Keep an explicit
  // "none", but use the theme-aware pill for user-controlled palettes.
  return args.paletteThemeActive && !args.paletteThemeAllowsArtwork && args.mode === "artwork"
    ? "pill"
    : args.mode;
}

export function useHostIdentificationMode(): HostIdentificationMode {
  const prefsHydrated = useClientPrefsHydrated();
  const flavor = useClientPrefsValue().hostIdentificationMode;
  return resolveHostIdentificationMode({ mode: flavor, settingsHydrated: prefsHydrated });
}

/** Read current settings for one environment, merged with client-local preferences. */
export function useHostPrefs<Item = UnifiedPrefs>(
  hostKey: HostId,
  select?: (conf: UnifiedPrefs) => Item,
): Item {
  const daemonPrefs = useAtomValue(daemonHost.settingsValueAtom(hostKey));
  return useMergedPrefs(daemonPrefs ?? DEFAULT_DAEMON_PREFS, select);
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimaryPrefs<Item = UnifiedPrefs>(select?: (conf: UnifiedPrefs) => Item): Item {
  return useMergedPrefs(useAtomValue(primaryDaemonPrefsAtom), select);
}

const PREFS_UNSAVED_MESSAGE = "The Kora daemon did not accept the change. Is it running?";

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Shared server keys (see `SHARED_DAEMON_SETTING_KEYS`)
 * are written to every eligible sync target, not only the selected target, so
 * a user preference does not silently drift between machines. Client keys go
 * through client persistence.
 */
function useUpdatePrefsTarget(hostKey: HostId | null) {
  const persistDaemonPrefs = useAtomAction(daemonHost.updateSettings, "server settings update");
  const { environments } = useHosts();
  return useCallback(
    (delta: UnifiedPrefsPatch) => {
      const { serverPatch, clientPatch } = splitPatch(delta);
      const send = (hostId: HostId, patch: DaemonPrefsPatch) =>
        void persistDaemonPrefs({ hostId, input: { patch } });
      // A write that goes nowhere must say so: the control would otherwise look saved.
      const notSaved = (description = PREFS_UNSAVED_MESSAGE) =>
        toastManager.add({ type: "warning", title: "Setting not saved", description });
      const { sharedPatch, localPatch } = splitSharedDaemonPatch(serverPatch);

      if (Object.keys(localPatch).length > 0) {
        if (hostKey) send(hostKey, localPatch);
        else notSaved();
      }
      if (Object.keys(sharedPatch).length > 0) {
        const hostOf = (id: HostId) => environments.find((env) => env.hostId === id);
        const fromSettings = hostKey ? hostOf(hostKey)?.daemonConfig?.settings : undefined;
        const targets = new Set(
          environments.filter(supportsSharedPrefsSync).map((env) => env.hostId),
        );
        if (hostKey) targets.add(hostKey);
        let sent = false;
        for (const id of targets) {
          const config = hostOf(id)?.daemonConfig;
          const patch = filterSharedDaemonPatch(
            sharedPatch,
            config?.environment.capabilities,
            config?.settings,
            fromSettings,
            id === hostKey,
          );
          if (Object.keys(patch).length === 0) continue;
          sent = true;
          send(id, patch);
        }
        if (!sent)
          notSaved(targets.size > 0 ? "Update older servers to save this setting." : undefined);
      }
      if (Object.keys(clientPatch).length > 0) void persistClientPrefsPatch(clientPatch);
    },
    [hostKey, environments, persistDaemonPrefs],
  );
}

export function useUpdateHostPrefs(hostKey: HostId) {
  return useUpdatePrefsTarget(hostKey);
}

export function useUpdatePrimaryPrefs() {
  return useUpdatePrefsTarget(usePrimaryHost()?.hostId ?? null);
}

export function useUpdateClientPrefs() {
  return useCallback((delta: ClientPrefsPatch) => {
    return persistClientPrefsPatch(delta);
  }, []);
}

export function __resetClientPrefsPersistenceForTests(): void {
  clientPrefs.reset();
}

export function __setClientPrefsForTests(conf: ClientPrefs): void {
  clientPrefs.reset(conf, "ready");
}

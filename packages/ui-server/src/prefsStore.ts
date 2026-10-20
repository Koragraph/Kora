// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
// @effect-diagnostics globalConsole:off -- the daemon logs to stdout for the desktop wrapper, not through a Logger.
import * as fs from "node:fs";
import * as path from "node:path";

import { DaemonPrefs, type DaemonPrefsPatch } from "@kora/contracts";
import { applyDaemonPrefsPatch } from "@kora/shared/daemonPrefs";
import * as Schema from "effect/Schema";

import { daemonConfig } from "./config.ts";
import { jsonSafe } from "./handlers/shared.ts";
import { defaultKoraHome } from "./localAuth.ts";

/**
 * The daemon's settings: `server.updateSettings` applies a patch here, persists it to
 * `<KORA_HOME>/settings.json` and tells every `subscribeDaemonConfig` stream (a
 * `settingsUpdated` frame). The client only learns a server setting changed from that
 * frame, so a no-op update left every server-backed control (Default permissions,
 * "Start new worktrees from origin", "Check provider versions", …) stuck.
 */
type Listener = (settings: DaemonPrefs) => void;

const listeners = new Set<Listener>();
const decodePrefs = Schema.decodeUnknownSync(DaemonPrefs);
const encodePrefs = Schema.encodeSync(DaemonPrefs);

let prefsFile = path.join(defaultKoraHome(), "settings.json");
let loaded = false;

/** The file the settings persist to. */
export function settingsPath(): string {
  return prefsFile;
}

function setCurrent(settings: DaemonPrefs): void {
  // daemonConfig is a decoded, non-frozen object (codexModels.ts patches it in place too);
  // the snapshot every new subscriber receives must carry the current settings.
  (daemonConfig as { settings: DaemonPrefs }).settings = settings;
}

/**
 * Read the persisted settings over the built-in ones. The built-in provider instances stay
 * registered unless the file overrides them. A missing or unreadable file keeps the defaults.
 */
export function loadPrefs(file: string = prefsFile): DaemonPrefs {
  prefsFile = file;
  loaded = true;
  const base = daemonConfig.settings;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return base;
  }
  try {
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    const persistedInstances =
      typeof persisted.providerInstances === "object" && persisted.providerInstances !== null
        ? (persisted.providerInstances as Record<string, unknown>)
        : {};
    const encodedBase = encodePrefs(base) as Record<string, unknown>;
    const next = wireSafe(
      decodePrefs({
        ...persisted,
        providerInstances: {
          ...(encodedBase.providerInstances as Record<string, unknown>),
          ...persistedInstances,
        },
      }),
    );
    setCurrent(next);
    return next;
  } catch (cause) {
    console.error(`[kora-ui] ignoring unreadable settings file ${file}:`, String(cause));
    return base;
  }
}

function persist(settings: DaemonPrefs): void {
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  const tmp = `${prefsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(encodePrefs(settings), null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, prefsFile);
}

/** Apply a patch, persist it, and notify every config subscriber. Throws when the write fails. */
export function updateSettings(patch: DaemonPrefsPatch): DaemonPrefs {
  if (!loaded) loadPrefs();
  const next = wireSafe(applyDaemonPrefsPatch(daemonConfig.settings, patch));
  persist(next);
  setCurrent(next);
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (cause) {
      console.error("[kora-ui] settings listener failed:", String(cause));
    }
  }
  return next;
}

/**
 * A removed project's per-project settings (model, permissions, Actions) go with it, instead of staying in
 * settings.json as an orphan (plv S3-5). No write when the project has none. Returns whether an entry was dropped.
 */
export function dropProjectPrefs(projectId: string): boolean {
  if (!loaded) loadPrefs();
  const overrides = daemonConfig.settings.projectSettingsOverrides as Readonly<
    Record<string, unknown>
  >;
  if (!Object.hasOwn(overrides, projectId)) return false;
  updateSettings({
    projectSettingsOverrides: { [projectId]: null },
  } as unknown as DaemonPrefsPatch);
  return true;
}

/** Listen for settings changes; returns the unsubscribe function. */
export function onPrefsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The RPC layer encodes the settings TYPE (Durations and all), so the frame carries decoded
 * settings — rebuilt from their JSON-sanitized encoding, so no nested `undefined` survives.
 */
function wireSafe(settings: DaemonPrefs): DaemonPrefs {
  return decodePrefs(jsonSafe(encodePrefs(settings)));
}

/** The `settingsUpdated` frame for the daemon-config stream. */
export function prefsUpdatedFrame(settings: DaemonPrefs) {
  return {
    version: 1 as const,
    type: "settingsUpdated" as const,
    payload: { settings: wireSafe(settings) },
  };
}

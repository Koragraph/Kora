import {
  DEFAULT_AGENT_HEALTH_REFRESH_INTERVAL,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  DEFAULT_BACKGROUND_ACTIVITY_PROFILE,
  type BackgroundActivityPrefs,
  type BackgroundActivityProfile,
  type DaemonPrefs,
} from "@kora/contracts";
import * as Duration from "effect/Duration";

export interface ResolvedBackgroundActivityPrefs {
  readonly pauseWhenOnBattery: boolean;
  readonly pauseWhenClientLowPower: boolean;
  readonly pauseWhenHostLowPower: boolean;
  readonly pauseWhenHostLocked: boolean;
  readonly idleClientTtl: Duration.Duration;
  readonly hostPowerMonitorIdleInterval: Duration.Duration;
  readonly hostPowerMonitorActiveInterval: Duration.Duration;
  readonly providerHealthRefreshInterval: Duration.Duration;
  readonly automaticGitFetchInterval: Duration.Duration;
  /** The base preset (never "custom"). */
  readonly profile: BackgroundActivityProfile;
}

type Settings = Omit<ResolvedBackgroundActivityPrefs, "profile">;
type DurationKey = {
  [K in keyof Settings]: Settings[K] extends Duration.Duration ? K : never;
}[keyof Settings];
type FlagKey = Exclude<keyof Settings, DurationKey>;

const DURATION_KEYS: ReadonlyArray<DurationKey> = [
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "hostPowerMonitorActiveInterval",
  "hostPowerMonitorIdleInterval",
  "idleClientTtl",
];
const FLAG_KEYS: ReadonlyArray<FlagKey> = [
  "pauseWhenHostLocked",
  "pauseWhenHostLowPower",
  "pauseWhenClientLowPower",
  "pauseWhenOnBattery",
];
const SETTING_KEYS: ReadonlyArray<keyof Settings> = [...DURATION_KEYS, ...FLAG_KEYS];

const IDLE_CLIENT_TTL = Duration.seconds(45);

function preset(
  fetch: Duration.Duration,
  health: Duration.Duration,
  powerActive: Duration.Duration,
  powerIdle: Duration.Duration,
  pauses: readonly [locked: boolean, hostLow: boolean, clientLow: boolean, battery: boolean],
): Settings {
  const [locked, hostLow, clientLow, battery] = pauses;
  return {
    idleClientTtl: IDLE_CLIENT_TTL,
    automaticGitFetchInterval: fetch,
    providerHealthRefreshInterval: health,
    hostPowerMonitorActiveInterval: powerActive,
    hostPowerMonitorIdleInterval: powerIdle,
    pauseWhenHostLocked: locked,
    pauseWhenHostLowPower: hostLow,
    pauseWhenClientLowPower: clientLow,
    pauseWhenOnBattery: battery,
  };
}

const PRESETS: Readonly<Record<BackgroundActivityProfile, Settings>> = {
  performance: preset(
    Duration.seconds(15),
    Duration.minutes(1),
    Duration.seconds(30),
    Duration.minutes(2),
    [true, false, false, false],
  ),
  balanced: preset(
    DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
    DEFAULT_AGENT_HEALTH_REFRESH_INTERVAL,
    Duration.seconds(30),
    Duration.minutes(5),
    [true, true, true, false],
  ),
  // Zero turns automatic fetching off.
  "battery-saver": preset(
    Duration.zero,
    Duration.minutes(15),
    Duration.minutes(1),
    Duration.minutes(10),
    [true, true, true, true],
  ),
};

const OTHER_PRESETS: ReadonlyArray<BackgroundActivityProfile> = [
  "balanced",
  "performance",
  "battery-saver",
];

type Overrides = BackgroundActivityPrefs["overrides"];

// Durations are compared by milliseconds, never by identity.
const sameValue = (key: keyof Settings, a: Settings, b: Settings): boolean =>
  (DURATION_KEYS as ReadonlyArray<keyof Settings>).includes(key)
    ? Duration.toMillis(a[key] as Duration.Duration) ===
      Duration.toMillis(b[key] as Duration.Duration)
    : a[key] === b[key];

const sameSettings = (a: Settings, b: Settings): boolean =>
  SETTING_KEYS.every((key) => sameValue(key, a, b));

const toSettings = (resolved: ResolvedBackgroundActivityPrefs): Settings => {
  const { profile: _profile, ...settings } = resolved;
  return settings;
};

const presetPrefs = (profile: BackgroundActivityProfile): BackgroundActivityPrefs => ({
  schemaVersion: 1,
  profile,
  overrides: {},
});

function getBackgroundActivityBaseProfile(
  prefs: BackgroundActivityPrefs,
): BackgroundActivityProfile {
  return prefs.profile === "custom"
    ? (prefs.baseProfile ?? DEFAULT_BACKGROUND_ACTIVITY_PROFILE)
    : prefs.profile;
}

export function resolveBackgroundActivityPrefs(
  prefs: BackgroundActivityPrefs,
): ResolvedBackgroundActivityPrefs {
  const profile = getBackgroundActivityBaseProfile(prefs);
  const merged: Record<string, unknown> = { ...PRESETS[profile] };
  if (prefs.profile === "custom") {
    for (const key of SETTING_KEYS) {
      const override = prefs.overrides[key];
      if (override !== undefined) merged[key] = override;
    }
  }
  return { profile, ...(merged as Settings) };
}

/** The smallest stored form: a preset when the values match one, else only the differences from the base. */
export function normalizeBackgroundActivityPrefs(
  prefs: BackgroundActivityPrefs,
): BackgroundActivityPrefs {
  if (prefs.profile !== "custom") return presetPrefs(prefs.profile);

  const base = getBackgroundActivityBaseProfile(prefs);
  const resolved = toSettings(resolveBackgroundActivityPrefs(prefs));
  const matching = [base, ...OTHER_PRESETS].find((name) => sameSettings(resolved, PRESETS[name]));
  if (matching !== undefined) return presetPrefs(matching);

  const overrides: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (!sameValue(key, resolved, PRESETS[base])) overrides[key] = resolved[key];
  }
  return {
    overrides: overrides as Overrides,
    baseProfile: base,
    profile: "custom",
    schemaVersion: 1,
  };
}

const isUntouchedDefault = (prefs: BackgroundActivityPrefs): boolean =>
  prefs.profile === DEFAULT_BACKGROUND_ACTIVITY_PROFILE &&
  prefs.baseProfile === undefined &&
  Object.keys(prefs.overrides).length === 0;

/** Older settings kept the profile and the two intervals as flat fields; honour them until the new field is touched. */
const prefsFromDaemonSettings = (settings: DaemonPrefs): BackgroundActivityPrefs => {
  const stored = settings.backgroundActivity;
  const differs = (a: Duration.Duration, b: Duration.Duration) =>
    Duration.toMillis(a) !== Duration.toMillis(b);
  const legacyChanged =
    settings.backgroundActivityProfile !== DEFAULT_BACKGROUND_ACTIVITY_PROFILE ||
    differs(settings.automaticGitFetchInterval, DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) ||
    differs(settings.providerHealthRefreshInterval, DEFAULT_AGENT_HEALTH_REFRESH_INTERVAL);
  if (!isUntouchedDefault(stored) || !legacyChanged) return stored;

  const base = settings.backgroundActivityProfile;
  const presetValues = PRESETS[base];
  const overrides: Record<string, unknown> = {};
  for (const key of ["automaticGitFetchInterval", "providerHealthRefreshInterval"] as const) {
    if (differs(settings[key], presetValues[key])) overrides[key] = settings[key];
  }
  if (Object.keys(overrides).length === 0) return presetPrefs(base);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: base,
    overrides: overrides as Overrides,
  };
};

export function resolveDaemonBackgroundActivityPrefs(
  settings: DaemonPrefs,
): ResolvedBackgroundActivityPrefs {
  return resolveBackgroundActivityPrefs(prefsFromDaemonSettings(settings));
}

export function normalizeDaemonBackgroundActivityPrefs(
  settings: DaemonPrefs,
): BackgroundActivityPrefs {
  const resolved = resolveDaemonBackgroundActivityPrefs(settings);
  const overrides: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) overrides[key] = resolved[key];
  return normalizeBackgroundActivityPrefs({
    overrides: overrides as Overrides,
    baseProfile: resolved.profile,
    profile: "custom",
    schemaVersion: 1,
  });
}

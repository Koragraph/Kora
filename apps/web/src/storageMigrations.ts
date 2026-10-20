/**
 * One-time rewrite of this app's localStorage documents after the "environment" → "host"
 * vocabulary rename: persisted UI state, drafts and settings keep their values under the renamed
 * keys (`environmentId` → `hostId`, …). Runs from the entry module before any store reads storage;
 * a marker key makes it a no-op afterwards. Failures leave the document as it was (its reader then
 * falls back to defaults, exactly as for any undecodable entry).
 *
 * Deliberately dependency-free: it runs in the entry chunk (bootstrap.ts), ahead of the app's
 * module graph. The key rule mirrors `migrateLegacyHostKeys` in @kora/contracts (host.ts).
 */
const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LEGACY_HOST_WORD = /Environment|environment|ENVIRONMENT/;
const KEPT_ENV_KEY =
  /^(environment|environments)$|ShellEnvironment|EnvironmentVariable|environmentVariable|ENVIRONMENT_VARIABLE/;

/**
 * The legacy vocabulary only ever lived in camelCase keys (`environmentId`). An all-caps key is a
 * user's environment-variable name (`MY_ENVIRONMENT`) and is never renamed.
 */
const ENV_VAR_NAME = /^[A-Z0-9_$]+$/;
/** User-defined env-var maps: their keys are user data, so the walk does not descend into them. */
const USER_ENV_MAP_KEY = /^(env|envVars|environmentVariables|shellEnvironment)$/;

function migrateKey(key: string): string {
  if (
    !IDENTIFIER_KEY.test(key) ||
    !LEGACY_HOST_WORD.test(key) ||
    KEPT_ENV_KEY.test(key) ||
    ENV_VAR_NAME.test(key)
  ) {
    return key;
  }
  return key
    .replaceAll("ENVIRONMENT", "HOST")
    .replaceAll("Environment", "Host")
    .replaceAll("environment", "host");
}

function migrateLegacyHostKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const migrated = migrateLegacyHostKeys(item);
      if (migrated !== item) changed = true;
      return migrated;
    });
    return changed ? next : value;
  }
  if (typeof value !== "object" || value === null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const migratedKey = migrateKey(key);
    const migratedItem = USER_ENV_MAP_KEY.test(key) ? item : migrateLegacyHostKeys(item);
    if (migratedKey !== key || migratedItem !== item) changed = true;
    if (migratedKey !== key && Object.hasOwn(value, migratedKey)) continue;
    next[migratedKey] = migratedItem;
  }
  return changed ? next : value;
}

/**
 * Storage keys renamed on 2026-10-02 (the last upstream-named keys). A value moves to its new key once and the
 * old key is removed; when both exist the new key's value wins. Prefix entries cover keyed families
 * (`kora:web-panel-width:<thread>`).
 */
export const RENAMED_STORAGE_KEYS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["kora:client-settings:v1", "kora:client-prefs:v1"],
  ["kora:composer-drafts:v1", "kora:prompt-drafts:v1"],
  ["kora:right-panel-state:v2", "kora:dock-state:v2"],
  ["kora:composer-agent-mode:v1", "kora:prompt-agent-mode:v1"],
  ["kora:browser-favicons:v1", "kora:web-icons:v1"],
  ["kora:browser-history:v1", "kora:web-history:v1"],
  ["kora:preview-panel-width", "kora:web-panel-width"],
  ["kora:typography-advanced", "kora:type-advanced"],
  ["kora:last-editor", "kora:editor-last"],
  ["chat_thread_sidebar_width", "kora:nav-width"],
];
const RENAMED_STORAGE_KEY_PREFIXES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["kora:preview-panel-width:", "kora:web-panel-width:"],
];

function moveStorageValue(storage: Storage, from: string, to: string): void {
  const value = storage.getItem(from);
  if (value === null) return;
  if (storage.getItem(to) === null) storage.setItem(to, value);
  storage.removeItem(from);
}

function renameLegacyStorageKeys(storage: Storage): void {
  for (const [from, to] of RENAMED_STORAGE_KEYS) moveStorageValue(storage, from, to);
  const prefixed: Array<readonly [string, string]> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    for (const [from, to] of RENAMED_STORAGE_KEY_PREFIXES) {
      if (key.startsWith(from)) prefixed.push([key, to + key.slice(from.length)]);
    }
  }
  for (const [from, to] of prefixed) moveStorageValue(storage, from, to);
}

const MIGRATION_MARKER = "kora:storage-migration:host-keys";
const APP_KEY = /^kora[:.]/;

export function runStorageMigrations(given?: Storage): void {
  try {
    // Read inside the try: with site storage blocked, touching `localStorage` itself throws,
    // and a throw here would stop bootstrap before the app (or its boot error) can load.
    const storage = given ?? globalThis.localStorage;
    if (!storage) return;
    renameLegacyStorageKeys(storage);
    if (storage.getItem(MIGRATION_MARKER) === "1") return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && APP_KEY.test(key) && key !== MIGRATION_MARKER) keys.push(key);
    }
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const migrated = migrateLegacyHostKeys(parsed);
      if (migrated !== parsed) storage.setItem(key, JSON.stringify(migrated));
    }
    storage.setItem(MIGRATION_MARKER, "1");
  } catch {
    // Storage unavailable (private mode, quota): nothing to migrate.
  }
}

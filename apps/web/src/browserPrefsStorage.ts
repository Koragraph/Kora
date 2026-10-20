import { ClientPrefsSchema, migrateLegacyClientPrefsKeys, type ClientPrefs } from "@kora/contracts";

import { getMigratedLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_PREFS_STORAGE_KEY = "kora:client-prefs:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientPrefs(): ClientPrefs | null {
  if (!hasWindow()) {
    return null;
  }

  return getMigratedLocalStorageItem(
    CLIENT_PREFS_STORAGE_KEY,
    ClientPrefsSchema,
    migrateLegacyClientPrefsKeys,
  );
}

export function writeBrowserClientPrefs(settings: ClientPrefs): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_PREFS_STORAGE_KEY, settings, ClientPrefsSchema);
}

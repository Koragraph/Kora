// The Kora | Code top-level surface switcher's persisted state (client-only — see chatSurface.ts
// for the server-derived per-project surface this stays in sync with).
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export const AppSurfaceSchema = Schema.Literals(["blobs", "code"]);
export type AppSurface = typeof AppSurfaceSchema.Type;

const SURFACE_STORAGE_KEY = "kora.surface.v1";

/**
 * The retired Chat surface may still be the stored choice ("chat"); it reads as Kora, and an unreadable value is
 * dropped so the default applies. Pure so it is tested; `migrateStoredSurface` applies it to localStorage once at load.
 */
export function normalizeStoredSurface(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === "blobs" || v === "code") return raw;
    return v === "chat" ? JSON.stringify("blobs") : null;
  } catch {
    return null;
  }
}

export function migrateStoredSurface(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  try {
    const raw = storage.getItem(SURFACE_STORAGE_KEY);
    const next = normalizeStoredSurface(raw);
    if (next === raw) return;
    if (next === null) storage.removeItem(SURFACE_STORAGE_KEY);
    else storage.setItem(SURFACE_STORAGE_KEY, next);
  } catch {
    /* storage unavailable: the default applies */
  }
}
if (typeof window !== "undefined") migrateStoredSurface(window.localStorage);

/** A new user lands on Code (the first launch ships Kora Code; the Kora tab is coming soon, branding.ts KORA_SURFACE);
 *  after the first switch the last surface used is remembered (localStorage). */
export const DEFAULT_APP_SURFACE: AppSurface = "code";

const LAST_BLOB_STORAGE_KEY = "kora.blobs.last.v1";

/** The blob the user was last in (null = never picked one): switching back to Blobs, and a reload that lands on the
 *  Blobs surface, return to it instead of the Chief. Persisted like the surface itself. */
export function useLastBlobStore(): [string | null, (value: string | null) => void] {
  return useLocalStorage<string | null, string | null>(
    LAST_BLOB_STORAGE_KEY,
    null,
    Schema.NullOr(Schema.String),
  );
}

/** Persisted active surface + setter, shared by every mount via localStorage + the cross-tab/
 *  same-tab change event `useLocalStorage` already wires up. */
export function useAppSurfaceStore(): [AppSurface, (value: AppSurface) => void] {
  return useLocalStorage<AppSurface, string>(
    SURFACE_STORAGE_KEY,
    DEFAULT_APP_SURFACE,
    AppSurfaceSchema,
  );
}

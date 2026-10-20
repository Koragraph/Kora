// A tiny shared cache of "what is connected" for the chips (proposal / gallery / blob cards). Many chips show at once;
// they share one status + accounts read (20 s fresh) instead of one each. `refreshAppsBrief` forces a re-read after a
// connect / disconnect / key change.
import { useEffect, useSyncExternalStore } from "react";

import { useAppsApi, type AppAccountWire, type AppsApi, type AppsStatus } from "./appsApi";
import { isActive, isNotSetUp } from "./appsModel";

export interface AppsBrief {
  readonly loaded: boolean;
  readonly status: AppsStatus | null;
  readonly accounts: ReadonlyArray<AppAccountWire>;
  readonly notSetUp: boolean;
}

const FRESH_MS = 20_000;
const EMPTY: AppsBrief = { loaded: false, status: null, accounts: [], notSetUp: false };

let state: AppsBrief = EMPTY;
let at = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(api: AppsApi): Promise<void> {
  const s = await api.status();
  if (!s.ok) {
    state = { loaded: true, status: null, accounts: [], notSetUp: s.code === "not_configured" };
    at = s.code === "not_configured" ? Date.now() : 0; // a failed read is retried by the next chip / api change, not cached for 20 s
    emit();
    return;
  }
  const notSetUp = isNotSetUp(s.value);
  const a = notSetUp
    ? { ok: true as const, value: [] as ReadonlyArray<AppAccountWire> }
    : await api.accounts(null);
  state = { loaded: true, status: s.value, accounts: a.ok ? a.value : [], notSetUp };
  at = Date.now();
  emit();
}

export function refreshAppsBrief(api: AppsApi, force = true): Promise<void> {
  if (!force && Date.now() - at < FRESH_MS) return Promise.resolve();
  inflight ??= load(api).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Reset (tests, and when the daemon changes). */
export function resetAppsBrief(): void {
  state = EMPTY;
  at = 0;
  inflight = null;
  emit();
}

export function useAppsBrief(): AppsBrief & { refresh: () => Promise<void> } {
  const api = useAppsApi();
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => EMPTY,
  );
  useEffect(() => {
    void refreshAppsBrief(api, false);
  }, [api]);
  return { ...snap, refresh: () => refreshAppsBrief(api, true) };
}

/** Active accounts of one app. */
export function activeAccountsOf(brief: AppsBrief, toolkit: string): AppAccountWire[] {
  return brief.accounts.filter(
    (a) => a.toolkit.toLowerCase() === toolkit.toLowerCase() && isActive(a),
  );
}

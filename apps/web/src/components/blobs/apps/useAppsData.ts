// The Apps page's data: the status (mode, key, usage), the catalog (search is the daemon's), the connected accounts.
// Refreshes when the window regains focus (you come back from the browser after connecting) and on a slow timer.
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppsApi, type AppAccountWire, type AppToolkitWire, type AppsStatus } from "./appsApi";
import { isNotSetUp } from "./appsModel";

export interface AppsError {
  readonly code: string | null;
  readonly message: string;
}

const SLOW_MS = 30_000;
/** After a failed read: 1.5 s, 3 s, 6 s, then every 15 s. A page opened while the connection is still coming up must not sit on an error. */
const retryDelay = (failures: number): number =>
  Math.min(15_000, 1_500 * 2 ** Math.max(0, failures - 1));

export function useAppsStatus(): {
  status: AppsStatus | null;
  error: AppsError | null;
  refresh: () => Promise<AppsStatus | null>;
  set: (s: AppsStatus) => void;
} {
  const api = useAppsApi();
  const [status, setStatus] = useState<AppsStatus | null>(null);
  const [error, setError] = useState<AppsError | null>(null);
  const alive = useRef(true);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    const r = await api.status();
    if (!alive.current) return null;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    if (r.ok) {
      failures.current = 0;
      setStatus(r.value);
      setError(null);
      return r.value;
    }
    failures.current += 1;
    // "not connected yet" (no code, or `unavailable`) is not news: stay quiet for the first tries, then say it
    if ((r.code !== null && r.code !== "unavailable") || failures.current > 3)
      setError({ code: r.code, message: r.message });
    retry.current = setTimeout(() => void refresh(), retryDelay(failures.current));
    return null;
  }, [api]);
  useEffect(() => {
    alive.current = true;
    failures.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), SLOW_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearInterval(timer);
      if (retry.current) clearTimeout(retry.current);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { status, error, refresh, set: setStatus };
}

export function useAppsAccounts(enabled: boolean): {
  accounts: ReadonlyArray<AppAccountWire> | null;
  error: AppsError | null;
  refresh: () => Promise<void>;
} {
  const api = useAppsApi();
  const [accounts, setAccounts] = useState<ReadonlyArray<AppAccountWire> | null>(null);
  const [error, setError] = useState<AppsError | null>(null);
  const alive = useRef(true);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const r = await api.accounts(null);
    if (!alive.current) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    if (r.ok) {
      failures.current = 0;
      setAccounts(r.value);
      setError(null);
    } else {
      failures.current += 1;
      setError({ code: r.code, message: r.message });
      retry.current = setTimeout(() => void refresh(), retryDelay(failures.current));
    }
  }, [api, enabled]);
  useEffect(() => {
    alive.current = true;
    failures.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), SLOW_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      clearInterval(timer);
      if (retry.current) clearTimeout(retry.current);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return { accounts, error, refresh };
}

/** The catalog for a search text (debounced). `loadMore` follows the daemon's cursor. */
export function useAppsCatalog(
  enabled: boolean,
  search: string,
): {
  toolkits: ReadonlyArray<AppToolkitWire>;
  loading: boolean;
  error: AppsError | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Read the catalog again (after a reset, or the Retry button). */
  reload: () => void;
} {
  const api = useAppsApi();
  const [toolkits, setToolkits] = useState<ReadonlyArray<AppToolkitWire>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppsError | null>(null);
  const gen = useRef(0);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (q: string, from: string | null, append: boolean) => {
      const mine = ++gen.current;
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
      setLoading(true);
      const r = await api.toolkits(q.trim() ? q.trim() : null, from);
      if (gen.current !== mine) return;
      setLoading(false);
      if (!r.ok) {
        failures.current += 1;
        setError({ code: r.code, message: r.message });
        // a failed read tries again by itself (the connection was still coming up, the broker blinked)
        retry.current = setTimeout(() => void load(q, from, append), retryDelay(failures.current));
        return;
      }
      failures.current = 0;
      setError(null);
      setCursor(r.value.nextCursor);
      setToolkits((prev) =>
        append
          ? [...prev, ...r.value.toolkits.filter((t) => !prev.some((p) => p.slug === t.slug))]
          : r.value.toolkits,
      );
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) {
      setToolkits([]);
      return;
    }
    failures.current = 0;
    const timer = setTimeout(() => void load(search, null, false), search ? 250 : 0);
    return () => {
      clearTimeout(timer);
      if (retry.current) clearTimeout(retry.current);
    };
  }, [enabled, search, load]);

  return {
    toolkits,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore: () => {
      if (cursor !== null) void load(search, cursor, true);
    },
    reload: () => {
      failures.current = 0;
      void load(search, null, false);
    },
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPrimaryHost } from "../hosts/primary/shellAuth";

/**
 * Freshness of the code graph for a repo, from the daemon's `GET /api/graph/status?cwd=`
 * (apps/ui-server/src/graph.ts#buildGraphStatus). Drives the composer's graph chip: is this
 * repo indexed, is the index current with the checkout's HEAD, and is an ingest running
 * right now? Polls on a slow timer and on window focus — the value barely moves between
 * ingests — and exposes `refetch` so an action (Re-index) can refresh immediately.
 */
export interface GraphFreshness {
  /** The daemon's graph reader did not answer in time: not a verdict, keep what the chip last showed. */
  readonly busy?: boolean;
  readonly indexed: boolean;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly indexedSha: string | null;
  readonly headSha: string | null;
  readonly stale: boolean;
  readonly nodes: number;
  readonly files: number;
  readonly indexing: { readonly pct: number | null; readonly finalizing?: boolean } | null;
  /** A full index died or failed part-way: the store holds a partial graph (`indexed` is false). */
  readonly incomplete?: boolean;
  /** The project's folder no longer exists on disk. */
  readonly folderMissing?: boolean;
  /** The graph store file is damaged (not a database): re-indexing moves it aside and rebuilds. */
  readonly storeDamaged?: boolean;
  /** Matched only by name to an index built from another folder (the repo moved): never re-indexed on its own. */
  readonly indexedFrom?: string;
  /** The last index of this checkout failed (cleared by the next successful one). */
  readonly ingestError?: { readonly message: string; readonly at: string };
  /** Where an explicit "Index" would point, and whether that's a sane target (not ~, /, a non-repo). */
  readonly indexRoot?: string | null;
  readonly safeToIndex?: boolean;
  readonly isGitRepo?: boolean;
  /** The target is ~, a parent of it, / or a shallow mount: never indexed from the UI. */
  readonly systemFolder?: boolean;
  /** A bare git repository (no working files): nothing to index. */
  readonly bareRepo?: boolean;
  /** The folder exists but this user may not read it. */
  readonly folderUnreadable?: boolean;
}

const POLL_MS = 20_000;

// Every mounted chip (and the graph panel) polls the same cwd; on a project switch that was 8 identical requests in
// one frame. Share an in-flight/just-finished request per URL for a moment.
const shared = new Map<string, { at: number; promise: Promise<GraphFreshness | null> }>();
const SHARE_MS = 1_500;
function fetchShared(
  url: string,
  run: () => Promise<GraphFreshness | null>,
): Promise<GraphFreshness | null> {
  const hit = shared.get(url);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.promise;
  const promise = run();
  shared.set(url, { at: Date.now(), promise });
  if (shared.size > 64) shared.delete(shared.keys().next().value as string);
  return promise;
}

// Every load result goes to every mounted hook for the same URL: the chip that started an index refetches at once,
// and the line under the composer (or any other reader) must flip with it, not 20 s later on its own poll.
const listeners = new Map<string, Set<(value: GraphFreshness | null) => void>>();
function publish(url: string, value: GraphFreshness | null): void {
  for (const listener of listeners.get(url) ?? []) listener(value);
}
function subscribe(url: string, listener: (value: GraphFreshness | null) => void): () => void {
  let set = listeners.get(url);
  if (!set) listeners.set(url, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(url);
  };
}

export function useGraphFreshness(
  httpBaseUrl: string | null,
  cwd: string | null,
): { freshness: GraphFreshness | null; refetch: () => void } {
  const [state, setState] = useState<GraphFreshness | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const indexing = !!state?.indexing;

  useEffect(() => {
    if (!httpBaseUrl || !cwd) {
      setState(null);
      return;
    }
    let cancelled = false;
    const statusUrl = new URL("/api/graph/status", httpBaseUrl);
    statusUrl.searchParams.set("cwd", cwd);
    const key = statusUrl.toString();
    const unsubscribe = subscribe(key, (value) => {
      if (!cancelled) setState(value);
    });
    const load = async () => {
      try {
        const json = await fetchShared(key, async () => {
          const res = await fetchPrimaryHost(key);
          return res.ok ? ((await res.json()) as GraphFreshness) : null;
        });
        // A busy graph reader is not an answer: keep the previous state instead of flashing "Not indexed".
        if (json?.busy) return;
        publish(key, json);
      } catch {
        publish(key, null);
      }
    };
    loadRef.current = () => void load();
    void load();
    // Poll faster while an ingest is in flight so the chip's progress feels live.
    const timer = window.setInterval(load, indexing ? 3_000 : POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // Keyed on the BOOLEAN: `state.indexing` is a fresh object on every poll, so depending on it re-ran this effect
    // (an immediate load) after every load — a ~1.5 s fetch loop against the daemon for as long as an ingest ran.
  }, [httpBaseUrl, cwd, indexing]);

  const refetch = useCallback(() => loadRef.current(), []);
  return { freshness: state, refetch };
}

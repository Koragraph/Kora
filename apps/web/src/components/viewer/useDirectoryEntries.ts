import { koraAtomRegistry } from "~/wire/atomRegistry";
import { projectHost } from "~/atoms/projects";
import type { WorkspaceEntry, HostId } from "@kora/contracts";
import { executeAtomQuery } from "@kora/client-runtime/store/runtime";
import { useCallback, useEffect, useState, useRef } from "react";
import * as Cause from "effect/Cause";

const MAX_CONCURRENT_LOADS = 4;

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** Runs at most `limit` async jobs at once; the rest wait in arrival order. */
function createGate(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await job();
    } finally {
      release();
    }
  };
}

type Listing = {
  entriesByDirectory: Map<string, WorkspaceEntry[]>;
  errors: Map<string, string>;
};

export function useDirectoryEntries(hostId: HostId, cwd: string) {
  const [listing, setListing] = useState<Listing>(() => ({
    entriesByDirectory: new Map(),
    errors: new Map(),
  }));
  const [pending, setPending] = useState(0);

  // Per-scope bookkeeping that must survive renders without causing them.
  const scope = useRef({
    active: false,
    loaded: new Set<string>(),
    requested: new Set<string>(),
    inFlight: new Map<string, Promise<void>>(),
    gate: createGate(MAX_CONCURRENT_LOADS),
  });

  const load = useCallback(
    (directoryPath: string, refresh = false): Promise<void> => {
      const state = scope.current;
      const existing = state.inFlight.get(directoryPath);
      if (existing) {
        if (!refresh) return existing;
        return existing.then(() => load(directoryPath, true));
      }
      if (state.loaded.has(directoryPath) && !refresh) return Promise.resolve();

      state.requested.add(directoryPath);
      state.loaded.add(directoryPath);
      setPending((count) => count + 1);

      const request = state
        .gate(async () => {
          if (!state.active) return;
          const atom = projectHost.listEntries({
            hostId,
            input: { cwd, ...(directoryPath ? { directoryPath } : {}) },
          });
          const result = await executeAtomQuery(koraAtomRegistry, atom, {
            reportFailure: false,
            reportDefect: false,
            refresh: true,
          });
          if (!state.active) return;

          if (result._tag === "Success") {
            const children = result.value.entries.filter(
              (entry) => parentOf(entry.path) === directoryPath,
            );
            setListing((previous) => {
              const entriesByDirectory = new Map(previous.entriesByDirectory);
              entriesByDirectory.set(directoryPath, children);
              const errors = new Map(previous.errors);
              errors.delete(directoryPath);
              return { entriesByDirectory, errors };
            });
          } else {
            state.loaded.delete(directoryPath);
            const failure = Cause.squash(result.cause);
            const message = failure instanceof Error ? failure.message : "Unable to load folder.";
            setListing((previous) => {
              const errors = new Map(previous.errors);
              errors.set(directoryPath, message);
              return { ...previous, errors };
            });
          }
        })
        .finally(() => {
          state.inFlight.delete(directoryPath);
          if (state.active) setPending((count) => count - 1);
        });
      state.inFlight.set(directoryPath, request);
      return request;
    },
    [hostId, cwd],
  );

  useEffect(() => {
    const state = {
      active: true,
      loaded: new Set<string>(),
      requested: new Set<string>(),
      inFlight: new Map<string, Promise<void>>(),
      gate: createGate(MAX_CONCURRENT_LOADS),
    };
    scope.current = state;
    setListing({ entriesByDirectory: new Map(), errors: new Map() });
    setPending(0);
    void load("");
    return () => {
      state.active = false;
    };
  }, [load]);

  // Depth-first walk of everything loaded so far.
  const entries: WorkspaceEntry[] = [];
  const reachable = new Set<string>([""]);
  const visit = (directoryPath: string) => {
    for (const entry of listing.entriesByDirectory.get(directoryPath) ?? []) {
      entries.push(entry);
      if (entry.kind === "directory") {
        reachable.add(entry.path);
        visit(entry.path);
      }
    }
  };
  visit("");

  const refresh = useCallback(() => {
    const state = scope.current;
    const queue = [...state.requested].filter((path) => reachableRef.current.has(path));
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        await load(path, true);
      }
    };
    void Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_LOADS, queue.length) }, worker));
  }, [load]);
  const reachableRef = useRef(reachable);
  reachableRef.current = reachable;

  let error: string | null = null;
  for (const [path, message] of listing.errors) {
    if (reachable.has(path)) {
      error = message;
      break;
    }
  }

  return {
    entries,
    load,
    refresh,
    isPending: pending > 0,
    ready: listing.entriesByDirectory.has(""),
    error,
  };
}

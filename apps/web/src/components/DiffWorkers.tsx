import { PREFERRED_HIGHLIGHTER } from "../util/syntaxHighlighting";
import { resolveDiffThemeName } from "../util/diffRendering";
import { useTheme } from "../hooks/useTheme";
import { useSyncExternalStore, type ReactNode, useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { WorkerPoolContext } from "@pierre/diffs/react";

type DiffThemeName = "pierre-light" | "pierre-dark";
type DiffWorkerOperation = "create-worker" | "get-render-options" | "set-render-options";

export class DiffWorkerError extends Schema.TaggedError<DiffWorkerError>()("DiffWorkerError", {
  cause: Schema.Defect(),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

// Keep a released pool warm briefly so closing and reopening a panel does not respawn every worker.
const POOL_IDLE_TTL_MS = 30_000;

function workerPoolSize(): number {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.min(6, Math.max(2, Math.floor(cores / 2)));
}
const POOL_SIZE = workerPoolSize();

interface SharedPool {
  pool: WorkerPoolManager | undefined;
  consumers: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}
const shared: SharedPool = { pool: undefined, consumers: 0, idleTimer: undefined };
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function createPool(themeName: DiffThemeName): WorkerPoolManager {
  return new WorkerPoolManager(
    {
      poolSize: POOL_SIZE,
      workerFactory: () => {
        let worker: Worker;
        try {
          worker = new DiffsWorker();
        } catch (cause) {
          throw new DiffWorkerError({ cause, operation: "create-worker", themeName });
        }
        return worker;
      },
      totalASTLRUCacheSize: 240,
    },
    {
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: true,
      theme: themeName,
    },
  );
}

function acquirePool(themeName: DiffThemeName) {
  if (shared.idleTimer !== undefined) {
    clearTimeout(shared.idleTimer);
    shared.idleTimer = undefined;
  }
  shared.pool ??= createPool(themeName);
  shared.consumers += 1;
}

function releasePool() {
  shared.consumers = Math.max(0, shared.consumers - 1);
  if (shared.consumers > 0) return;
  shared.idleTimer = setTimeout(() => {
    shared.idleTimer = undefined;
    if (shared.consumers > 0) return;
    shared.pool?.terminate();
    shared.pool = undefined;
    notifyListeners();
  }, POOL_IDLE_TTL_MS);
}

let initialThemeName: DiffThemeName = "pierre-dark";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(onChange);
  acquirePool(initialThemeName);
  onChange();
  return () => {
    listeners.delete(onChange);
    releasePool();
  };
}
const getSnapshot = () => shared.pool;
const getServerSnapshot = () => undefined;

function DiffWorkerThemeSync({
  pool,
  themeName,
}: {
  readonly pool: WorkerPoolManager;
  readonly themeName: DiffThemeName;
}) {
  useEffect(() => {
    let step: DiffWorkerOperation = "get-render-options";
    void (async () => {
      try {
        const current = pool.getDiffRenderOptions();
        if (current.theme === themeName) return;
        step = "set-render-options";
        await pool.setRenderOptions({ ...current, theme: themeName });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation: step, themeName, cause }));
      }
    })();
  }, [pool, themeName]);
  return null;
}

function DiffWorkerReady({
  pool,
  children,
}: {
  readonly pool: WorkerPoolManager | undefined;
  readonly children: ReactNode;
}) {
  const [readyPool, setReadyPool] = useState<WorkerPoolManager | undefined>(undefined);

  const ready =
    (pool === undefined && typeof window === "undefined") ||
    pool === readyPool ||
    pool?.isInitialized() === true ||
    // Plain-text views never queue a highlight task that could retry a blank first render.
    pool?.isWorkingPool() === false;

  useEffect(() => {
    if (!pool || ready) return;
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReadyPool(pool);
    };
    // A pool that fails to start falls back to Pierre's main-thread highlighter, so both outcomes unblock.
    pool.initialize().then(markReady, markReady);
    return () => {
      cancelled = true;
    };
  }, [pool, ready]);

  if (!ready) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-muted-foreground"
        role="status"
      >
        Loading code...
      </div>
    );
  }
  return <>{children}</>;
}

export function DiffWorkerPoolProvider({ children }: { readonly children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  initialThemeName = themeName;
  const pool = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <WorkerPoolContext.Provider value={pool}>
      {pool ? <DiffWorkerThemeSync pool={pool} themeName={themeName} /> : null}
      <DiffWorkerReady pool={pool}>{children}</DiffWorkerReady>
    </WorkerPoolContext.Provider>
  );
}

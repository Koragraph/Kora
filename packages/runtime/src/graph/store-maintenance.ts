// Coordinated close of the shared graph store (`~/.koragraph/graph.db`) before it is renamed, replaced or vacuumed.
//
// Windows refuses to rename or delete a file any process holds open (EBUSY / EPERM / EACCES), and the store is held by
// several: the ui-server's graph reader children (packages/ui-server graph.ts + graphReader.ts), the daemon's own
// connection through `UiHost.openGraphDb`, and koragraph's pool in the daemon. macOS does not care: a rename under an
// open handle just works, and every holder notices the swapped file (graph.ts `storeMoved`).
//
// The protocol, on Windows only:
//   1. the maintainer writes `<db>.maintenance` (pid, op, time) and calls this process's own holders (`onStoreMaintenance`
//      listeners: the ui-server bundle registers its resetDb, which a sleeping event loop could not run from a timer);
//   2. every holder sees the marker (graph.ts checks it before each read and polls it while a connection is open), closes
//      its handle and answers "busy" until the marker is gone;
//   3. the maintainer retries its operation with backoff while it is refused, up to `timeoutMs`, then removes the marker;
//      holders reopen on their next read. A marker older than MARKER_STALE_MS is ignored (a maintainer that died).
// On macOS/Linux `withStoreMaintenance` runs the operation once, exactly as before: no marker, no retry.
// The holder side is mirrored in packages/ui-server/src/graph.ts (separate bundle) — keep the two in step.
import fs from 'node:fs';
import { graphDbPath } from './embedded';

export const MARKER_STALE_MS = 60_000;
const LISTENERS = Symbol.for('kora.graph-store-maintenance.listeners');

export const maintenanceMarker = (dbFile: string): string => `${dbFile}.maintenance`;

/** Is a maintainer asking holders of `dbFile` to close? (A marker older than MARKER_STALE_MS does not count.) */
export function maintenanceActive(dbFile: string, now: number = Date.now(), fsx: Pick<typeof fs, 'statSync'> = fs): boolean {
  try { return now - fsx.statSync(maintenanceMarker(dbFile)).mtimeMs < MARKER_STALE_MS; } catch { return false; }
}

type Listener = (dbFile: string) => void;
function listeners(): Set<Listener> {
  const g = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  return (g[LISTENERS] ??= new Set<Listener>());
}
/** Register a holder in THIS process (any bundle: the registry lives on globalThis). Returns the unregister function. */
export function onStoreMaintenance(fn: Listener): () => void {
  listeners().add(fn);
  return () => { listeners().delete(fn); };
}
function notifyLocal(dbFile: string): void {
  for (const fn of listeners()) { try { fn(dbFile); } catch { /* a holder that cannot close is retried around */ } }
}

/** A refusal that a closed handle cures: Windows' open-file errors, SQLite's lock errors. */
export function isHolderRefusal(e: unknown): boolean {
  const code = String((e as { code?: unknown } | null)?.code ?? '');
  return /^(EBUSY|EPERM|EACCES|SQLITE_BUSY|SQLITE_LOCKED)/.test(code);
}

export interface MaintenanceDeps {
  platform: NodeJS.Platform;
  fs: Pick<typeof fs, 'writeFileSync' | 'rmSync'>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
}
const defaultDeps: MaintenanceDeps = {
  platform: process.platform,
  fs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  timeoutMs: 10_000,
};

export interface MaintenanceOptions {
  /** 'first': close every holder before the first try (VACUUM). 'on-refusal' (default): try first; ask only if refused. */
  announce?: 'first' | 'on-refusal';
  /** Called before each retry, after the holders were asked (e.g. drop this process's koragraph pool). */
  onRefused?: () => void;
}

/**
 * Run `op` (a rename, a replace, a VACUUM) on the store with every holder's handle closed. Windows only; elsewhere it
 * is `op()` once.
 */
export async function withStoreMaintenance<T>(
  what: string, op: () => T, opts: MaintenanceOptions = {},
  dbFile: string = graphDbPath(), deps: Partial<MaintenanceDeps> = {},
): Promise<T> {
  const d = { ...defaultDeps, ...deps };
  if (d.platform !== 'win32') return op();
  const marker = maintenanceMarker(dbFile);
  let announced = false;
  const announce = () => {
    try { d.fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, op: what, at: new Date(d.now()).toISOString() })); } catch { /* the store's folder is gone: nothing holds it */ }
    announced = true;
    notifyLocal(dbFile);
  };
  if (opts.announce === 'first') announce();
  const deadline = d.now() + d.timeoutMs;
  try {
    for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
      try { return op(); } catch (e) {
        if (!isHolderRefusal(e) || d.now() >= deadline) throw e;
        announce(); // also refreshes the marker's mtime, so a long wait never reads as stale
        opts.onRefused?.();
        await d.sleep(wait);
      }
    }
  } finally {
    if (announced) { try { d.fs.rmSync(marker, { force: true }); } catch { /* holders ignore it once stale */ } }
  }
}

/**
 * Daemon side: while the daemon runs on Windows, release this process's koragraph pool when ANOTHER process asks for
 * maintenance (a `kora ingest` child quarantining a damaged store, `kora graph prune --vacuum`). The next kg() call
 * reopens. A no-op elsewhere. Returns the stop function.
 */
export function watchStoreMaintenance(
  release: () => void, dbFile: string = graphDbPath(), platform: NodeJS.Platform = process.platform, everyMs = 500,
): () => void {
  if (platform !== 'win32') return () => {};
  let held = false;
  const t = setInterval(() => {
    const active = maintenanceActive(dbFile);
    if (active && !held) { try { release(); } catch { /* already closed */ } }
    held = active;
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

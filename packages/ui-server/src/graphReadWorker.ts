// @effect-diagnostics globalConsole:off -- a child process: it speaks to its parent over IPC and to the log through stderr.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node: a standalone child process, not Effect code.
/**
 * The graph reader child process (graphReader.ts forks this file). It owns the ONLY SQLite connection the UI server
 * reads the shared graph store with, so a query that goes pathological (the 2026-10-14 daemon freeze: a one-hour table
 * scan on the daemon's main thread) can be killed with SIGKILL by its parent instead of freezing the daemon.
 *
 * The daemon forks its own bundle (ui-server.cjs) with KORA_GRAPH_READER_CHILD=1 and index.ts calls
 * runGraphReaderChild(); in development and tests the parent forks graphReadWorkerMain.ts. Protocol (IPC, advanced serialization):
 *   parent -> child  {id, op: "status" | "snapshot" | "target" | "report", ...args}
 *   child  -> parent {ready: true} | {id, ok: true, result} | {id, ok: false, error} | {log: string}
 */
import { buildGraphSnapshot, buildGraphStatus, gitTarget, setSlowSqlSink } from "./graph.ts";
import { buildRepoReportForCwd } from "./repoReport.ts";

const send = (m: Record<string, unknown>): void => {
  try {
    process.send?.(m);
  } catch {
    /* parent gone */
  }
};

// SQLite here is node:sqlite (graph.ts's default), not the daemon's better-sqlite3: this is its own PROCESS, so the "two
// SQLite copies in one process" hazard (graph.ts, pl3 S1-1) cannot apply, and POSIX locks between processes are sound.

export function runGraphReaderChild(): void {
  setSlowSqlSink((line) => send({ log: line }));

  process.on("disconnect", () => process.exit(0));
  process.on("message", (m: Record<string, unknown>) => {
    const id = m.id;
    try {
      let result: unknown;
      switch (m.op) {
        case "status":
          result = buildGraphStatus(m.cwd as string | undefined);
          break;
        case "snapshot":
          result = buildGraphSnapshot({
            ...(m.cwd ? { cwd: m.cwd as string } : {}),
            ...(typeof m.limit === "number" ? { limit: m.limit } : {}),
          });
          break;
        case "target":
          result = gitTarget(m.cwd as string);
          break;
        case "report":
          // The repo code map (repoReport.ts): the heaviest read here, cached per branch + index generation in this child.
          result = buildRepoReportForCwd(m.cwd as string);
          break;
        case "ping":
          result = "pong";
          break;
        default:
          throw new Error(`unknown op ${String(m.op)}`);
      }
      send({ id, ok: true, result: result ?? null });
    } catch (error) {
      // Store maintenance (Windows: the store is being renamed/vacuumed) is "busy", never a verdict.
      const busy = (error as Error)?.name === "StoreMaintenanceError";
      send({ id, ok: false, busy, error: String((error as Error)?.message ?? error) });
    }
  });
  send({ ready: true });
}

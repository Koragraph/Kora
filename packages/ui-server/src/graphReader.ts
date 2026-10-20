// @effect-diagnostics globalConsole:off -- the daemon logs to stdout/stderr for the desktop wrapper, not through a Logger.
// @effect-diagnostics globalDate:off globalTimers:off -- plain timestamps outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node: this module is the boundary to a child process.
/**
 * The daemon's guard around the shared graph store (`~/.koragraph/graph.db`, ~2 GB, every repo ever indexed).
 *
 * Root cause of the 2026-10-14 freeze: /api/graph/status ran a better-sqlite3 query on the daemon's MAIN thread; one plan
 * went pathological (a table scan per row), the thread sat at 98% CPU for an hour and nothing — not even the desktop's
 * launch — got an answer. A synchronous native call cannot be interrupted or timed out in-process, so the reads live in a
 * CHILD PROCESS (graphReadWorker.ts) that the daemon can kill:
 *
 *   - three lanes (status/target, the heavy explorer snapshot, and the repo code map report), each its own child, so a slow
 *     snapshot or report never starves the composer chip's polls;
 *   - requests in a lane run one at a time; the timeout (status 3 s, snapshot 8 s, report 20 s) starts when the child gets the
 *     request, not while it waits in line;
 *   - on a timeout the child is SIGKILLed (exact handle, never a pattern), the whole lane's queue is answered "busy",
 *     and the next request starts a fresh child. Three timeouts in a row put the lane in a 30 s cooldown (all busy)
 *     instead of respawning into the same wall;
 *   - "busy" is never a verdict: status answers the last known value flagged `busy`, the explorer says "graph busy".
 *
 * Without a runnable child script (a daemon bundle that predates it) the reads fall back to running in-process, with
 * one loud log line — the old behaviour, without the guard.
 */
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildGraphSnapshot,
  buildGraphStatus,
  gitTarget,
  StoreMaintenanceError,
  type GraphSnapshot,
  type GraphStatus,
} from "./graph.ts";
import type { RepoReport } from "@kora/shared/repoReport";

import { buildRepoReportForCwd, type ReportResult } from "./repoReport.ts";

type Target = ReturnType<typeof gitTarget>;

export type SnapshotResult =
  | { readonly kind: "ok"; readonly snapshot: GraphSnapshot }
  | { readonly kind: "none" }
  | { readonly kind: "busy" };

export interface GraphReaderOptions {
  /** Absolute path of the child script; default: next to this bundle, else the .ts source. */
  readonly script?: ReaderScript | string | null;
  readonly statusTimeoutMs?: number;
  readonly snapshotTimeoutMs?: number;
  readonly reportTimeoutMs?: number;
  /** Longest a request may wait in line before it is answered busy. */
  readonly queueWaitMs?: number;
  readonly cooldownMs?: number;
  readonly log?: (line: string) => void;
}

export interface GraphReader {
  status(cwd: string | undefined): Promise<GraphStatus>;
  snapshot(opts: { cwd?: string; limit?: number }): Promise<SnapshotResult>;
  target(cwd: string): Promise<Target | null>;
  /** The repo code map for the repo a cwd belongs to (repoReport.ts); busy = the reader did not answer in time. */
  report(cwd: string): Promise<ReportResult>;
  /** Counters for tests and the doctor. */
  stats(): { spawns: number; kills: number; timeouts: number; inProcess: boolean };
  stop(): void;
}

declare const __filename: string | undefined;

export interface ReaderScript {
  readonly file: string;
  readonly env?: Record<string, string>;
}

/**
 * The reader child: `KORA_GRAPH_READER_SCRIPT` (tests), else this very bundle run as a child (KORA_GRAPH_READER_CHILD=1,
 * see index.ts), else the .ts source in development. Null when none exists.
 */
export function resolveReaderScript(): ReaderScript | null {
  const env = process.env.KORA_GRAPH_READER_SCRIPT;
  if (env) return fs.existsSync(env) ? { file: env } : null;
  if (typeof __filename === "string" && __filename.endsWith(".cjs") && fs.existsSync(__filename))
    return { file: __filename, env: { KORA_GRAPH_READER_CHILD: "1" } };
  try {
    const src = fileURLToPath(new URL("./graphReadWorkerMain.ts", import.meta.url));
    if (fs.existsSync(src)) return { file: src };
  } catch {
    /* no import.meta.url */
  }
  return null;
}

interface Job {
  readonly msg: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly enqueuedAt: number;
  readonly resolve: (value: { ok: true; result: unknown } | { ok: false; busy: boolean }) => void;
}

class Lane {
  private child: ChildProcess | null = null;
  private ready = false;
  private queue: Job[] = [];
  private current: { job: Job; id: number; timer: NodeJS.Timeout } | null = null;
  private seq = 0;
  private consecutiveTimeouts = 0;
  private cooldownUntil = 0;
  spawns = 0;
  kills = 0;
  timeouts = 0;

  private readonly name: string;
  private readonly script: ReaderScript;
  private readonly o: Required<Pick<GraphReaderOptions, "queueWaitMs" | "cooldownMs">> & {
    log: (line: string) => void;
  };

  constructor(
    name: string,
    script: ReaderScript,
    o: Required<Pick<GraphReaderOptions, "queueWaitMs" | "cooldownMs">> & {
      log: (line: string) => void;
    },
  ) {
    this.name = name;
    this.script = script;
    this.o = o;
  }

  run(
    msg: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: true; result: unknown } | { ok: false; busy: boolean }> {
    if (Date.now() < this.cooldownUntil) return Promise.resolve({ ok: false, busy: true });
    if (this.queue.length >= 64) return Promise.resolve({ ok: false, busy: true });
    return new Promise((resolve) => {
      this.queue.push({ msg, timeoutMs, enqueuedAt: Date.now(), resolve });
      this.pump();
    });
  }

  private spawn(): ChildProcess {
    const child = fork(this.script.file, [], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // node:sqlite prints an ExperimentalWarning on load: once per child would be noise in server.log.
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...this.script.env },
    });
    this.spawns += 1;
    this.ready = false;
    this.hold(child, true); // referenced while a caller waits (queue / startup); idle children never keep the daemon alive
    child.on("message", (m: Record<string, unknown>) => this.onMessage(child, m));
    const startup = setTimeout(() => {
      if (this.child === child && !this.ready) {
        this.o.log(`[graph] reader (${this.name}) did not start in 10 s; killing pid ${child.pid}`);
        this.kill(child);
        this.startFailed();
      }
    }, 10_000);
    startup.unref();
    const gone = (why: string) => {
      clearTimeout(startup);
      if (this.child !== child) return;
      const wasReady = this.ready;
      this.child = null;
      this.ready = false;
      if (!wasReady) this.startFailed();
      this.failCurrent(false, `graph reader (${this.name}) ${why}`);
      this.pump();
    };
    child.on("exit", (code, signal) => gone(`exited (${signal ?? code})`));
    child.on("error", (e) => gone(`failed: ${e.message}`));
    this.child = child;
    return child;
  }

  /** A child that never became ready: after three in a row stop respawning for a while. */
  private startFailed(): void {
    this.consecutiveTimeouts += 1;
    if (this.consecutiveTimeouts >= 3) {
      this.cooldownUntil = Date.now() + this.o.cooldownMs;
      this.consecutiveTimeouts = 0;
      for (const j of this.queue.splice(0)) j.resolve({ ok: false, busy: true });
      this.o.log(
        `[graph] reader (${this.name}) failed to start 3 times; answering busy for ${Math.round(this.o.cooldownMs / 1000)} s`,
      );
    }
  }

  private hold(child: ChildProcess | null, on: boolean): void {
    if (!child) return;
    if (on) {
      child.ref();
      child.channel?.ref?.();
    } else {
      child.unref();
      child.channel?.unref?.();
    }
  }

  private settle(): void {
    if (!this.current && this.queue.length === 0) this.hold(this.child, false);
  }

  private onMessage(child: ChildProcess, m: Record<string, unknown>): void {
    if (this.child !== child) return;
    if (m.log) {
      this.o.log(String(m.log));
      return;
    }
    if (m.ready) {
      this.ready = true;
      this.pump();
      this.settle();
      return;
    }
    const cur = this.current;
    if (!cur || m.id !== cur.id) return;
    clearTimeout(cur.timer);
    this.current = null;
    this.consecutiveTimeouts = 0;
    if (m.ok) cur.job.resolve({ ok: true, result: m.result });
    else if (m.busy === true)
      cur.job.resolve({ ok: false, busy: true }); // store maintenance (Windows)
    else {
      this.o.log(`[graph] reader (${this.name}) error: ${String(m.error)}`);
      cur.job.resolve({ ok: false, busy: false });
    }
    this.pump();
    this.settle();
  }

  private failCurrent(busy: boolean, why: string): void {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    this.o.log(`[graph] ${why}`);
    cur.job.resolve({ ok: false, busy });
  }

  private pump(): void {
    if (this.current) return;
    // Anything that waited too long is answered busy rather than run late.
    const now = Date.now();
    while (this.queue.length && now - this.queue[0]!.enqueuedAt > this.o.queueWaitMs) {
      this.queue.shift()!.resolve({ ok: false, busy: true });
    }
    const job = this.queue.shift();
    if (!job) return;
    const child = this.child ?? this.spawn();
    if (!this.ready) {
      this.queue.unshift(job);
      return;
    }
    const id = ++this.seq;
    this.hold(child, true);
    const timer = setTimeout(() => this.onTimeout(child, id), job.timeoutMs);
    timer.unref();
    this.current = { job, id, timer };
    try {
      child.send({ id, ...job.msg });
    } catch {
      this.failCurrent(false, `graph reader (${this.name}) send failed`);
      this.kill(child);
    }
  }

  private onTimeout(child: ChildProcess, id: number): void {
    const cur = this.current;
    if (!cur || cur.id !== id) return;
    this.timeouts += 1;
    this.consecutiveTimeouts += 1;
    this.failCurrent(
      true,
      `reader (${this.name}) did not answer ${String(cur.job.msg.op)} in ${cur.job.timeoutMs} ms (cwd ${String(cur.job.msg.cwd ?? "-")}); killing pid ${child.pid} and restarting it`,
    );
    this.kill(child);
    // Everything queued behind the stuck query would only hit the same wall.
    for (const j of this.queue.splice(0)) j.resolve({ ok: false, busy: true });
    if (this.consecutiveTimeouts >= 3) {
      this.cooldownUntil = Date.now() + this.o.cooldownMs;
      this.consecutiveTimeouts = 0;
      this.o.log(
        `[graph] reader (${this.name}) timed out 3 times in a row; answering busy for ${Math.round(this.o.cooldownMs / 1000)} s`,
      );
    }
  }

  private kill(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.ready = false;
    }
    this.kills += 1;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    this.ready = false;
    for (const j of this.queue.splice(0)) j.resolve({ ok: false, busy: true });
    this.failCurrent(true, `graph reader (${this.name}) stopped`);
    if (c) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

const NOT_INDEXED_BUSY: GraphStatus = {
  indexed: false,
  repo: null,
  branch: null,
  repoRoot: null,
  indexedSha: null,
  headSha: null,
  stale: false,
  nodes: 0,
  files: 0,
  indexing: null,
  indexRoot: null,
  safeToIndex: false,
  isGitRepo: false,
  systemFolder: false,
  busy: true,
};

export function createGraphReader(options: GraphReaderOptions = {}): GraphReader {
  const log = options.log ?? ((line: string) => console.error(line));
  const script: ReaderScript | null =
    options.script === undefined
      ? resolveReaderScript()
      : typeof options.script === "string"
        ? { file: options.script }
        : options.script;
  const statusTimeoutMs = options.statusTimeoutMs ?? 3000;
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? 8000;
  const reportTimeoutMs = options.reportTimeoutMs ?? 20_000;
  const laneOpts = {
    queueWaitMs: options.queueWaitMs ?? 10_000,
    cooldownMs: options.cooldownMs ?? 30_000,
    log,
  };

  if (!script) {
    log(
      "[graph] no graph reader script found; graph reads run on the daemon's main thread (no stall guard)",
    );
    return {
      // StoreMaintenanceError (Windows: the store is being renamed/vacuumed) answers busy, as the children do.
      status: async (cwd) => {
        try {
          return buildGraphStatus(cwd);
        } catch (e) {
          if (e instanceof StoreMaintenanceError) return NOT_INDEXED_BUSY;
          throw e;
        }
      },
      snapshot: async (o) => {
        let s: GraphSnapshot | null;
        try {
          s = buildGraphSnapshot(o);
        } catch (e) {
          if (e instanceof StoreMaintenanceError) return { kind: "busy" };
          throw e;
        }
        return s ? { kind: "ok", snapshot: s } : { kind: "none" };
      },
      target: async (cwd) => gitTarget(cwd),
      report: async (cwd) => {
        let r: ReturnType<typeof buildRepoReportForCwd>;
        try {
          r = buildRepoReportForCwd(cwd);
        } catch (e) {
          if (e instanceof StoreMaintenanceError) return { kind: "busy" };
          throw e;
        }
        return r ? { kind: "ok", report: r } : { kind: "none" };
      },
      stats: () => ({ spawns: 0, kills: 0, timeouts: 0, inProcess: true }),
      stop: () => {},
    };
  }

  const statusLane = new Lane("status", script, laneOpts);
  const snapshotLane = new Lane("snapshot", script, laneOpts);
  const reportLane = new Lane("report", script, laneOpts);
  const lastStatus = new Map<string, GraphStatus>();
  const inFlight = new Map<string, Promise<GraphStatus>>();

  const statusFor = (cwd: string | undefined): Promise<GraphStatus> => {
    const key = cwd ?? "";
    const existing = inFlight.get(key);
    if (existing) return existing; // many threads poll one cwd: one read answers them all
    const p = statusLane
      .run({ op: "status", cwd }, statusTimeoutMs)
      .then((r): GraphStatus => {
        if (r.ok) {
          const st = r.result as GraphStatus;
          lastStatus.set(key, st);
          if (lastStatus.size > 256) lastStatus.delete(lastStatus.keys().next().value as string);
          return st;
        }
        const last = lastStatus.get(key);
        if (last) return { ...last, busy: true };
        return r.busy ? NOT_INDEXED_BUSY : { ...NOT_INDEXED_BUSY, busy: false };
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };

  return {
    status: statusFor,
    snapshot: async (opts) => {
      const r = await snapshotLane.run(
        { op: "snapshot", cwd: opts.cwd, limit: opts.limit },
        snapshotTimeoutMs,
      );
      if (!r.ok) return r.busy ? { kind: "busy" } : { kind: "none" };
      return r.result ? { kind: "ok", snapshot: r.result as GraphSnapshot } : { kind: "none" };
    },
    target: async (cwd) => {
      const r = await statusLane.run({ op: "target", cwd }, statusTimeoutMs);
      return r.ok ? (r.result as Target) : null;
    },
    report: async (cwd) => {
      const r = await reportLane.run({ op: "report", cwd }, reportTimeoutMs);
      if (!r.ok) return r.busy ? { kind: "busy" } : { kind: "none" };
      return r.result ? { kind: "ok", report: r.result as RepoReport } : { kind: "none" };
    },
    stats: () => ({
      spawns: statusLane.spawns + snapshotLane.spawns + reportLane.spawns,
      kills: statusLane.kills + snapshotLane.kills + reportLane.kills,
      timeouts: statusLane.timeouts + snapshotLane.timeouts + reportLane.timeouts,
      inProcess: false,
    }),
    stop: () => {
      statusLane.stop();
      snapshotLane.stop();
      reportLane.stop();
    },
  };
}

let shared: GraphReader | null = null;
/** The daemon's one reader (lazy: a test that never reads the graph never forks). */
export function graphReader(): GraphReader {
  return (shared ??= createGraphReader());
}
/** Test seam. */
export function setGraphReaderForTests(r: GraphReader | null): void {
  shared?.stop();
  shared = r;
}

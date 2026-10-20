// @effect-diagnostics globalConsole:off -- the daemon logs to stdout for `vp run` / the desktop wrapper, not through a Logger.
// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics globalTimers:off -- raw callback-boundary timers around the in-process kora runtime.
// FleetService — the daemon-side read model + actions behind the chat client's fleet panel, and the
// terminal.* RPCs backed by REAL kora PTY panes.
//
// Two kinds of terminal live here:
//   • worker terminals — `terminalId = "worker:<paneId>"`: the PTY of a worker agent an orchestrator
//     thread spawned (a real `claude`/`codex` CLI). The client attaches its Ghostty surface to it, and
//     typing into it goes through `runtime.humanWrite`, which is kora' steer provenance: a submitted
//     line from a human is detected there and the owning orchestrator is told out of band.
//   • shell terminals — any other terminalId the client allocates (`term-N`): a login shell pane
//     spawned in the thread's cwd, exactly what the "Terminal" surface expects.
//
// The fleet snapshot (`fleet.subscribe`) is derived on demand from the runtime's panes for the
// orchestrator id `chat:<kora thread id>` and re-emitted whole on every change (small, debounced).
import { EventEmitter } from "node:events";

import type {
  PtySummary,
  PtySessionSnapshot,
  PtyMetaStreamEvent,
  PtyAttachStreamEvent,
  FleetWorkerTokens,
  FleetWorker,
  FleetSwarmWorker,
  FleetSwarmForeman,
  FleetSwarmVerify,
  FleetStreamEvent,
  FleetSwarmActivity,
  FleetSnapshot,
  FleetReadReportResult,
  FleetMergeVerdict,
  FleetEvent,
  WorkerFeedItem,
  WorkerFeedStreamEvent,
} from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { jsonSafe } from "./handlers/shared.ts";
import { SwarmTokenReader } from "./swarm-tokens.ts";
import { OutputSeam } from "./output-seam.ts";

// ── the slice of kora we drive (typed locally; the dist is CJS, loaded by the chat engine) ──
export interface KoraPaneLike {
  id: string;
  agent: string;
  name: string;
  state: "working" | "blocked" | "idle" | "unknown";
  blocker: string | null;
  exited: boolean;
  exitCode: number | null;
  pid: number | null;
  cwd: string;
  liveCwd?: string | null;
  cols: number;
  rows: number;
  role?: "orchestrator" | "worker" | null;
  orchestratorId?: string | null;
  steeredAt?: number | null;
  account?: string | null;
  createdAt: number;
  lastOutputAt: number;
  worktree: {
    path: string;
    branch: string;
    mainRoot: string;
    dirty?: number;
    ahead?: number;
  } | null;
  ledger?: { costUsd?: number; lastContext?: number; contextWindow?: number } | null;
  /** A swarm worker's meta (runtime `SwarmWorkerMeta` = `FleetSwarmWorker` + `reportPath`); null/absent otherwise. */
  swarm?: (FleetSwarmWorker & { reportPath: string }) | null;
  on(event: string, fn: (...a: unknown[]) => void): unknown;
  off(event: string, fn: (...a: unknown[]) => void): unknown;
  /** Kora is closing it to put it to sleep: not "the worker exited". */
  sleeping?: boolean;
  /** Its first prompt is still on its way in (start-up, or parked behind a trust dialog): an idle now is not "done". */
  promptPending?: boolean;
  /** Kora closed it after its branch was merged: remembered as exited, but no EXITED note to the lead. */
  retired?: boolean;
  /** Its agent stopped on a transient API error (runtime error-stall.ts); `retrying` = kora's "continue" is on its way. */
  errorStall?: { line: string; at: number; retries: number; retrying: boolean } | null;
  /** A GUI worker's tool call is running right now (a long build or test is quiet, not hung). */
  toolRunning?: boolean;
  /** The human stopped it from the fleet panel (fleet.kill). */
  stoppedByUser?: boolean;
  /** Its worktree branch has landed in the main checkout (runtime Pane.branchMerged). */
  branchMerged?: boolean;
  // ---- worker boxes (runtime DriverPane / PaneInfo; docs/fleet/WORKER-BOXES.md) ----
  info?(): {
    surface?: "gui" | "terminal";
    model?: string | null;
    costUsd?: number | null;
    contextPct?: number | null;
    pendingApproval?: { requestId: string; title: string } | null;
    retrying?: { attempt: number; max: number; message: string; nextAt: number | null } | null;
    turnEndedAt?: number | null;
  };
  /** Set on a pane that takes text as messages, not keystrokes (DriverPane, Koragent). */
  steerSink?: unknown;
  read(
    source: "screen" | "detection" | "scrollback",
    format: "text" | "ansi",
    lines?: number,
  ): string;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  /** Screen history serialized at an exact stream offset (runtime Pane.snapshotAt); absent on older runtimes. */
  snapshotAt?(lines: number): Promise<{ history: string; at: number; cols: number; rows: number }>;
}

export interface KoraRuntimeLike {
  /** A worker's record + CLI transcript, and Wake (runtime worker-sleep.ts); absent on older runtimes. */
  workerTranscript?(
    recordId: string,
  ): { record: unknown; entries: Array<{ role: string; text: string; at?: string }> } | null;
  wakeWorker?(recordId: string): Promise<{ paneId: string }>;
  /** The runtime's worker sleeper (records of chat leads' CLI workers); absent on older runtimes. */
  workerSleeper?(): {
    list(orchestratorId?: string): Array<{
      recordId: string;
      paneId: string;
      orchestratorId: string;
      agent: string;
      title: string;
      cwd: string;
      status: string;
      createdAt: number;
      sleptAt: number | null;
      finalReport: string | null;
      branchKept: boolean;
      worktree: { path: string; branch: string; mainRoot: string } | null;
      changes: { ahead: number; files: string[] } | null;
      session: { id: string | null; transcriptPath: string | null };
    }>;
  };
  panes: Map<string, KoraPaneLike>;
  requirePane(id: string): KoraPaneLike;
  /** A GUI worker's feed snapshot (runtime workerFeed); null for a terminal-only pane. */
  workerFeed?(paneId: string): unknown[] | null;
  /** The human answered a GUI worker's approval card. */
  respondWorkerApproval?(
    paneId: string,
    requestId: string,
    decision: "accept" | "acceptForSession" | "decline",
  ): Promise<void>;
  /** The worker box's steer field: a message to the engine (stop the turn, then this). */
  humanSteer?(paneId: string, text: string): Promise<void>;
  /** A worker's report (its last answer). */
  report?(paneId: string, turns?: number): string;
  off?(event: "notify", fn: (method: string, params: unknown) => void): unknown;
  humanWrite(paneId: string, data: string | Buffer): void;
  spawnPane(
    params: {
      command?: string;
      args?: string[];
      cwd?: string;
      agent?: string;
      name?: string;
      cols?: number;
      rows?: number;
      env?: Record<string, string>;
      enforce?: boolean;
      workspaceId?: string;
    },
    opts?: Record<string, unknown>,
  ): Promise<{ id: string }>;
  /** The daemon's ephemeral "chat" workspace: chat panes stay out of the TUI's active workspace and out of restore. */
  chatWorkspaceId?(): string;
  killPane(id: string, signal?: string): void;
  restartPane(id: string, mode?: string): Promise<unknown>;
  prompt(
    paneId: string,
    text: string,
    submit?: boolean,
    waitIdle?: boolean,
    timeoutMs?: number,
  ): Promise<{ state: string }>;
  fleetGet(orchestratorId: string): {
    plan: string;
    events: Array<{ at: number; kind: string; text: string; workerId?: string }>;
  };
  fleetSet(orchestratorId: string, patch: { plan?: string }): unknown;
  mergeVerify(params: {
    paneIds?: string[];
  }): Promise<{ pairs: FleetMergeVerdict["pairs"]; order: string[] }>;
  worktreeMerge(params: { paneId?: string; into?: string; commitFirst?: boolean }): Promise<{
    ok: boolean;
    merged: string | null;
    into: string | null;
    conflicts: string[];
    message: string;
    commitsMerged: number;
  }>;
  on(event: "notify", fn: (method: string, params: unknown) => void): unknown;
  /** The runtime's SwarmService slice the fleet panel needs (absent on a runtime without swarm). */
  swarm?: {
    readReport(
      paneId: string,
    ): Promise<{ text: string; truncated: boolean; updatedAt: number } | null>;
    taskForPane(paneId: string): { orchestratorId: string; taskId: string } | null;
    /** `fleet.retry`: fail the worker's task over to a different model (reason 'stalled'). null = not retryable. */
    retryWorker(paneId: string): Promise<{ taskId: string; newPaneId: string } | null>;
    /** `fleet.extend`: postpone the task's watchdog deadlines by `minutes`. null = not extendable. */
    extendWorker(paneId: string, minutes: number): { taskId: string } | null;
    /** `fleet.kill` on a swarm worker: record that the human stopped it (the lead must not respawn it). */
    userStopped?(paneId: string): { taskId: string } | null;
    cancelQueued?(orchestratorId: string): string[];
    /** Tasks restored from tasks.json whose panes died with the previous daemon (finished / failed / stopped). */
    restoredTasks?(orchestratorId: string): RestoredSwarmTask[];
  };
}

export interface RestoredSwarmTask {
  taskId: string;
  title: string;
  status: string;
  userStopped: boolean;
  model: string;
  provider: string;
  attempt: number;
  paneIds: string[];
  worktree: { path: string; branch: string; mainRoot: string } | null;
  report: { bytes: number; updatedAt: number; preview: string } | null;
}

const RESTORED_PHASES = new Set<string>(["exhausted", "failed", "done"]);
const SWARM_PROVIDERS = new Set<string>(["zen", "openrouter", "cerebras", "ollama", "lmstudio"]);

/**
 * A swarm task from before a daemon restart, as a remembered (exited) tile: the Tasks list kept losing every finished
 * or human-stopped task at a restart (Swarm QA 2026-10-02 #5). The id is the task id (`s3`): pane ids restart at p1
 * per daemon, and every kora tool accepts a task id. No worktree, so no merge button on a tile no pane backs
 * (kora_merge still takes the task id).
 */
function restoredTaskWorker(t: RestoredSwarmTask, cwd: string): FleetWorker {
  const at = t.report?.updatedAt ?? 0;
  const phase = (RESTORED_PHASES.has(t.status) ? t.status : "failed") as FleetSwarmWorker["phase"];
  return {
    paneId: t.taskId,
    terminalId: `restored:${t.taskId}`,
    agent: "opencode",
    account: null,
    title: t.title,
    state: "exited",
    blocker: null,
    steered: false,
    steeredAt: null,
    cwd: t.worktree?.path ?? cwd,
    worktree: null,
    costUsd: null,
    contextPct: null,
    exitCode: null,
    createdAt: at,
    lastOutputAt: at,
    ...(t.userStopped ? { stoppedByUser: true } : {}),
    swarm: {
      taskId: t.taskId,
      provider: (SWARM_PROVIDERS.has(t.provider)
        ? t.provider
        : "zen") as FleetSwarmWorker["provider"],
      model: t.model,
      modelLabel:
        t.model
          .split("/")
          .slice(-1)[0]
          ?.replace(/:free$/, "") || "unknown model",
      phase,
      attempt: Math.max(1, t.attempt),
      attempts: [],
      report: t.report,
      supersededBy: null,
      previousPaneIds: [],
      verify: null,
    },
  };
}

/** Runtime `SwarmWorkerMeta` → wire `FleetSwarmWorker`: exactly `reportPath` dropped (the path never rides the wire). */
export function toFleetSwarmWorker(
  meta: FleetSwarmWorker & { reportPath?: string },
): FleetSwarmWorker {
  return {
    taskId: meta.taskId,
    provider: meta.provider,
    model: meta.model,
    modelLabel: meta.modelLabel,
    phase: meta.phase,
    attempt: meta.attempt,
    attempts: meta.attempts.map((a) => ({
      paneId: a.paneId,
      provider: a.provider,
      model: a.model,
      outcome: a.outcome,
      at: a.at,
    })),
    report: meta.report
      ? { bytes: meta.report.bytes, updatedAt: meta.report.updatedAt, preview: meta.report.preview }
      : null,
    supersededBy: meta.supersededBy ?? null,
    previousPaneIds: [...meta.previousPaneIds],
    verify: meta.verify
      ? {
          state: meta.verify.state,
          bounces: meta.verify.bounces,
          summary: meta.verify.summary ?? null,
        }
      : null,
    // The foreman's attempts/verdict: plain JSON built by the runtime; the round trip keeps a stray undefined off the wire.
    ...(meta.foreman
      ? { foreman: JSON.parse(JSON.stringify(meta.foreman)) as FleetSwarmForeman }
      : {}),
    // Present only once the runtime has set it (older snapshots omit the key); null (never undefined — the
    // toJsonValue/CLAUDE.md wire hazard) once it is, meaning "no step yet" rather than "unknown".
    ...(meta.step !== undefined ? { step: meta.step } : {}),
  };
}

/** The Claude leader's measured tokens in a thread (summed settled-turn usage). */
export type LeaderTokens = NonNullable<FleetSwarmActivity["leaderTokens"]>;

/** The honest, measured swarm counts for the chip (PLAN X5), derived from the workers. Null without swarm workers. */
export function swarmActivity(
  workers: readonly FleetWorker[],
  leaderTokens: LeaderTokens | null = null,
): FleetSwarmActivity | null {
  const swarm = workers.filter((w) => w.swarm);
  if (!swarm.length) return null;
  // One task can span several panes (failovers): count it once, from its most recent attempt.
  const byTask = new Map<string, FleetSwarmWorker>();
  for (const w of swarm) {
    const s = w.swarm!;
    const prev = byTask.get(s.taskId);
    if (!prev || s.attempt >= prev.attempt) byTask.set(s.taskId, s);
  }
  const tasks = [...byTask.values()];
  const models = new Map<
    string,
    {
      -readonly [
        K in keyof FleetSwarmActivity["byModel"][number]
      ]: FleetSwarmActivity["byModel"][number][K];
    }
  >();
  for (const w of swarm) {
    const s = w.swarm!;
    if (s.supersededBy || w.state === "exited") continue;
    const m = models.get(s.model) ?? {
      provider: s.provider,
      model: s.model,
      modelLabel: s.modelLabel,
      workers: 0,
    };
    m.workers += 1;
    models.set(s.model, m);
  }
  return {
    delegated: tasks.length,
    reportsReturned: tasks.filter((t) => t.report).length,
    respawns: tasks.reduce((n, t) => n + Math.max(0, t.attempt - 1), 0),
    passedFirstTry: tasks.filter((t) => t.verify?.state === "passed" && t.verify.bounces === 0)
      .length,
    bounced: tasks.filter((t) => (t.verify?.bounces ?? 0) > 0).length,
    byModel: [...models.values()],
    exhausted: tasks.some((t) => t.phase === "exhausted"),
    ...workerTokenTotals(swarm),
    ...(leaderTokens ? { leaderTokens } : {}),
  };
}

/** Measured worker tokens: each task counted once (its attempts share one worktree, and so one token total). */
function workerTokenTotals(
  swarm: readonly FleetWorker[],
): { workerTokens: NonNullable<FleetSwarmActivity["workerTokens"]> } | Record<string, never> {
  const byTask = new Map<string, FleetWorkerTokens>();
  for (const w of swarm) {
    if (!w.tokens) continue;
    const prev = byTask.get(w.swarm!.taskId);
    // The newest reading of a task is the largest (session totals only grow).
    if (!prev || w.tokens.input + w.tokens.output >= prev.input + prev.output)
      byTask.set(w.swarm!.taskId, w.tokens);
  }
  if (byTask.size === 0) return {};
  const total = { input: 0, cached: 0, output: 0, tasks: byTask.size };
  for (const t of byTask.values()) {
    total.input += t.input;
    total.cached += t.cached;
    total.output += t.output;
  }
  return { workerTokens: total };
}

/** What the chat engine tells the fleet service about threads, and what it wants to hear back. */
export interface FleetEngineHooks {
  /** `chat:<kora id>` → the owning Kora thread, or null when no thread owns that orchestrator id. */
  threadForOrchestrator(orchestratorId: string): { threadId: string; cwd: string } | null;
  /** The orchestrator id a Kora thread's workers carry, or null for an unknown thread. */
  orchestratorIdFor(threadId: string): string | null;
  /** A worker-side happening the transcript + orchestrator should hear about. */
  onWorkerEvent(threadId: string, event: WorkerEventForEngine): void;
  /** The thread leader's measured tokens so far (swarm value meter); null/absent when none are recorded. */
  leaderTokensFor?(threadId: string): LeaderTokens | null;
}

/** Where swarm workers' measured tokens come from (OpenCode's session DB by default; a fake in tests). */
export interface SwarmTokenSource {
  forWorktree(worktree: string): FleetWorkerTokens | null;
}

export type WorkerEventForEngine =
  | { kind: "steered"; paneId: string; text: string }
  | { kind: "blocked"; paneId: string; blocker: string | null }
  | { kind: "done"; paneId: string; exitCode: number | null; title: string }
  /** The human stopped this worker from the fleet panel (fleet.kill) — a decision, not a crash. */
  | { kind: "stopped"; paneId: string; title: string; taskId: string | null }
  /** A CLI worker finished a turn (working → idle) and is waiting; `problem` = an error line it stopped on. */
  | {
      kind: "idle";
      paneId: string;
      title: string;
      tail: string;
      problem: string | null;
      idleSince: number;
    }
  | { kind: "spawned"; paneId: string; agent: string; title: string }
  /** A CLI worker says "working" but has written nothing for WORKER_STALL_MS (a hang, a dropped stream, a missed modal). */
  | {
      kind: "stalled";
      paneId: string;
      title: string;
      quietMs: number;
      tail: string;
      lastOutputAt: number;
    }
  // Swarm (from the runtime's `swarm.worker` notification). Types only in W0; S2 emits them, S1 turns them into
  // activities (worker.report / worker.respawned / worker.rate-limited / worker.bounced) and [kora] notes.
  | { kind: "swarm-report"; paneId: string; taskId: string; verify: FleetSwarmVerify | null }
  | {
      kind: "swarm-failover";
      paneId: string;
      taskId: string;
      newPaneId: string;
      fromModel: string;
      toModel: string;
    }
  | { kind: "swarm-exhausted"; paneId: string; taskId: string; tried: string[] }
  | { kind: "swarm-bounced"; paneId: string; taskId: string; verify: FleetSwarmVerify };

const WORKER_PREFIX = "worker:";
const STEERED_WINDOW_MS = 4000;
const BLOCKED_GRACE_MS = 2500;
/** working → idle must hold this long before it counts as "finished" (a CLI flickers idle between tool calls). */
const IDLE_GRACE_MS = 3000;
/** Same threshold as the runtime's `STALL_MS` (fleet-ops.ts): "working" with no output this long is reported. */
export const WORKER_STALL_MS = 5 * 60 * 1000;
/** The same check while a tool call runs: builds and test suites are legitimately quiet for minutes. */
export const WORKER_TOOL_STALL_MS = 20 * 60 * 1000;
const STALL_SWEEP_MS = 60_000;
const ERROR_STALL_RETRIES = 3;

/** Lines a worker CLI prints when it stopped on something it cannot fix itself (usage limit, auth, quota, crash). */
const WORKER_PROBLEM =
  /usage limit|rate[ -]?limit|quota|insufficient (credit|balance)|billing|unauthori[sz]ed|not logged in|please (log ?in|run \/login)|invalid api key|authentication|overloaded|\bAPI Error\b|\b5\d\d\b.*error|panicked|Traceback/i;

/** The end of a worker's screen (non-empty lines) and the error line it stopped on, if any. */
export function workerScreenTail(
  screen: string,
  lines = 10,
): { tail: string; problem: string | null } {
  const rows = screen
    .split("\n")
    .map((l) => l.replace(/[│┃╭╮╰╯─]+/g, " ").trimEnd())
    .filter((l) => l.trim().length > 0);
  const tail = rows.slice(-lines).join("\n");
  const problem =
    [...rows]
      .reverse()
      .find((l) => WORKER_PROBLEM.test(l))
      ?.trim() ?? null;
  return { tail, problem };
}
const MAX_EVENTS = 60;
const HISTORY_LINES = 1500;
const SNAPSHOT_SLOW_MS = 2000;
const SNAPSHOT_GIVE_UP_MS = 15_000;
const now = (): string => new Date().toISOString();

const key = (threadId: string, terminalId: string): string => `${threadId}\u0000${terminalId}`;

function ctxPct(p: KoraPaneLike): number | null {
  const l = p.ledger;
  if (
    !l ||
    typeof l.lastContext !== "number" ||
    typeof l.contextWindow !== "number" ||
    l.contextWindow <= 0
  )
    return null;
  return Math.max(0, Math.min(100, Math.round((l.lastContext / l.contextWindow) * 100)));
}

/** A blocker reduced to what a human would call "the same prompt": spinner/blink prefixes and punctuation dropped. */
function blockerKey(blocker: string | null): string | null {
  if (!blocker) return null;
  return blocker
    .replace(/^\s*\[\s*[.!*+\-]?\s*\]\s*/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
}

function workerLabel(p: KoraPaneLike): string {
  const state = p.exited ? "exited" : p.state;
  return `${p.name || p.agent} · ${state}`.slice(0, 120);
}

/** "opencode/ling-3.0-flash-fin-free" → "ling-3.0-flash-fin" (the provider prefix and free suffix say nothing to a user). */
function shortModel(id: unknown): string {
  const s = typeof id === "string" && id ? id : "?";
  return s
    .split("/")
    .pop()!
    .replace(/(-free|:free)$/, "");
}

export class FleetService {
  private readonly runtime: KoraRuntimeLike;
  private readonly hooks: FleetEngineHooks;
  private readonly shells = new Map<
    string,
    { threadId: string; terminalId: string; paneId: string }
  >();
  private readonly shellByPane = new Map<string, { threadId: string; terminalId: string }>();
  private readonly bus = new EventEmitter();
  /** Workers that already exited and were reaped by the runtime, kept so the panel can still show them. */
  private readonly exitedWorkers = new Map<string, Map<string, FleetWorker>>();
  private readonly localEvents = new Map<string, FleetEvent[]>();
  private readonly verdicts = new Map<string, FleetMergeVerdict>();
  private readonly fleetTouchTimers = new Map<string, NodeJS.Timeout>();
  /** Last known owner thread per worker pane, so a `pane.closed` (pane already gone) can still be routed. */
  private readonly workerOwner = new Map<
    string,
    { threadId: string; title: string; agent: string }
  >();
  /**
   * The blocker each worker was last reported on. Claude re-renders its dialog on every keystroke, so
   * `agent.state → blocked` fires many times for ONE prompt; the real user runs got 11 "needs attention"
   * rows for a single worker. One row + one orchestrator note per distinct blocker, reset when it clears.
   */
  private readonly notifiedBlocker = new Map<string, string | null>();
  /** Last state seen per worker pane, and whether it has worked at all (an idle before its first turn is not "done"). */
  private readonly workerState = new Map<
    string,
    { state: string; worked: boolean; idleAt: number | null }
  >();
  /**
   * What an exited worker's terminal showed, kept after the runtime reaps the pane (30s): the tile otherwise
   * blanks to "[terminal] Process exited" and `kora_read` answers "no worker", so nobody — human or
   * orchestrator — can see WHY it died (a codex worker that exited on a bad model id was diagnosed as a
   * "CLI self-update" for exactly this reason).
   */
  private readonly exitedScreens = new Map<string, { history: string; screen: string }>();
  /** The last FleetWorker view of each live worker pane (kept so a killed worker can still be listed). */
  private readonly lastSeenWorker = new Map<string, FleetWorker>();
  /** The quiet episode (its lastOutputAt) each worker was last reported stalled for: one note per episode. */
  private readonly notifiedStall = new Map<string, number>();
  /** The error stall (at:retries) each worker was last reported for: one note when kora's auto-continue is spent. */
  private readonly notifiedErrorStall = new Map<string, string>();

  private readonly tokens: SwarmTokenSource;
  /** How long a worker must stay idle before its box reads "Done" (tests shorten it). */
  doneGraceMs = IDLE_GRACE_MS;

  constructor(
    runtime: KoraRuntimeLike,
    hooks: FleetEngineHooks,
    opts: { tokens?: SwarmTokenSource } = {},
  ) {
    this.runtime = runtime;
    this.hooks = hooks;
    this.tokens = opts.tokens ?? new SwarmTokenReader();
    this.bus.setMaxListeners(200);
    // Nothing changes on a hung worker, so no notification ever says so: look for them once a minute.
    const sweep = setInterval(() => {
      try {
        this.sweepStalls();
      } catch {
        /* next minute */
      }
    }, STALL_SWEEP_MS);
    sweep.unref?.();
    runtime.on("notify", (method, params) => {
      try {
        this.onRuntimeNotify(method, params as Record<string, unknown>);
      } catch (e) {
        console.error(
          "[kora-daemon] fleet notify handler failed:",
          String((e as Error)?.message ?? e).slice(0, 300),
        );
      }
    });
  }

  // ── runtime → fleet/terminal fan-out ────────────────────────────────────────────────
  private onRuntimeNotify(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "pane.created":
      case "pane.updated":
      case "agent.state":
      case "ledger.updated": {
        const paneId = String(
          (p.paneId as string | undefined) ?? (p.id as string | undefined) ?? "",
        );
        const pane = this.runtime.panes.get(paneId);
        if (!pane) return;
        this.onPaneChanged(pane, method);
        return;
      }
      case "pane.closed": {
        const paneId = String(p.paneId ?? "");
        // Per-worker bookkeeping dies with the pane (it only ever grew, for the daemon's whole life).
        this.workerState.delete(paneId);
        this.notifiedStall.delete(paneId);
        this.notifiedErrorStall.delete(paneId);
        this.notifiedBlocker.delete(paneId);
        const shell = this.shellByPane.get(paneId);
        if (shell) {
          this.shellByPane.delete(paneId);
          this.shells.delete(key(shell.threadId, shell.terminalId));
          this.bus.emit("terminal", {
            type: "remove",
            threadId: shell.threadId,
            terminalId: shell.terminalId,
          } satisfies PtyMetaStreamEvent);
        }
        const owner = this.workerOwner.get(paneId);
        if (owner) {
          this.workerOwner.delete(paneId);
          // Swarm QA 2026-10-02: after the lead's kora_kill the Workers panel read "No workers yet" for a job that
          // had just run two workers. A closed worker stays listed as exited, like one that exited on its own.
          const last = this.lastSeenWorker.get(paneId);
          this.lastSeenWorker.delete(paneId);
          const remembered =
            this.exitedWorkers.get(owner.threadId) ?? new Map<string, FleetWorker>();
          // A swarm pane replaced by a failover is on its way out, not a worker that ended (journey d).
          const replaced =
            !!last?.swarm && (!!last.swarm.supersededBy || last.swarm.phase === "respawning");
          if (last && !replaced && !remembered.has(paneId)) {
            remembered.set(paneId, {
              ...last,
              state: "exited",
              blocker: null,
              ...(last.swarm && last.swarm.phase !== "done"
                ? { swarm: { ...last.swarm, phase: "failed" as const } }
                : {}),
            });
            while (remembered.size > 12)
              remembered.delete(remembered.keys().next().value as string);
            this.exitedWorkers.set(owner.threadId, remembered);
          }
          this.bus.emit("terminal", {
            type: "remove",
            threadId: owner.threadId,
            terminalId: WORKER_PREFIX + paneId,
          } satisfies PtyMetaStreamEvent);
          this.touchFleet(owner.threadId);
        }
        return;
      }
      case "pane.steered": {
        const paneId = String(p.paneId ?? "");
        const owner = this.hooks.threadForOrchestrator(String(p.orchestratorId ?? ""));
        if (!owner) return;
        this.pushLocalEvent(owner.threadId, {
          at: Date.now(),
          kind: "human-steered",
          text: `${paneId}: ${String(p.text ?? "")}`,
          workerId: paneId,
        });
        this.hooks.onWorkerEvent(owner.threadId, {
          kind: "steered",
          paneId,
          text: String(p.text ?? ""),
        });
        this.touchFleet(owner.threadId);
        return;
      }
      case "swarm.worker": {
        const owner = this.hooks.threadForOrchestrator(String(p.orchestratorId ?? ""));
        const e = p.event as
          | {
              kind: string;
              paneId: string;
              taskId: string;
              newPaneId?: string;
              fromModel?: string;
              toModel?: string;
              tried?: string[];
              verify?: FleetSwarmVerify;
            }
          | undefined;
        if (!owner || !e) return;
        const paneId = String(e.paneId ?? "");
        const taskId = String(e.taskId ?? "");
        let ev: WorkerEventForEngine | null = null;
        let line = "";
        if (e.kind === "report") {
          ev = { kind: "swarm-report", paneId, taskId, verify: e.verify ?? null };
          line = `Worker ${paneId} reported (task ${taskId})${e.verify ? ` · checks ${e.verify.state}` : ""}`;
        } else if (e.kind === "failover" && e.newPaneId) {
          ev = {
            kind: "swarm-failover",
            paneId,
            taskId,
            newPaneId: e.newPaneId,
            fromModel: String(e.fromModel ?? ""),
            toModel: String(e.toModel ?? ""),
          };
          // Plain words for the timeline (it read "P1 → p2: opencode/x-free → opencode/y-free" to a first-time user).
          line = `Task ${taskId} moved to another free model: ${shortModel(e.fromModel)} → ${shortModel(e.toModel)} (worker ${paneId} → ${e.newPaneId})`;
          // The old pane was replaced, not finished: never remember it as an exited worker.
          this.exitedWorkers.get(owner.threadId)?.delete(paneId);
        } else if (e.kind === "exhausted") {
          ev = { kind: "swarm-exhausted", paneId, taskId, tried: [...(e.tried ?? [])] };
          line = `Task ${taskId}: every free model is busy or rate-limited right now`;
        } else if (e.kind === "bounced" && e.verify) {
          ev = { kind: "swarm-bounced", paneId, taskId, verify: e.verify };
          line = `Worker ${paneId}'s change was sent back by the merge check (task ${taskId}, bounce ${e.verify.bounces})`;
        }
        if (!ev) return;
        this.pushLocalEvent(owner.threadId, {
          at: Date.now(),
          kind: "note",
          text: line,
          workerId: paneId,
        });
        this.hooks.onWorkerEvent(owner.threadId, jsonSafe(ev));
        this.touchFleet(owner.threadId);
        return;
      }
      case "worker.slept":
      case "worker.woke":
      case "fleet.plan":
      case "fleet.roster":
      case "fleet.event": {
        const owner = this.hooks.threadForOrchestrator(String(p.orchestratorId ?? ""));
        if (owner) this.touchFleet(owner.threadId);
        return;
      }
      default:
        return;
    }
  }

  private onPaneChanged(pane: KoraPaneLike, method: string): void {
    const shell = this.shellByPane.get(pane.id);
    if (shell) {
      this.bus.emit("terminal", {
        type: "upsert",
        terminal: this.summary(pane, shell.threadId, shell.terminalId),
      } satisfies PtyMetaStreamEvent);
      return;
    }
    if (pane.role !== "worker" || !pane.orchestratorId) return;
    const owner = this.hooks.threadForOrchestrator(pane.orchestratorId);
    if (!owner) return;
    const known = this.workerOwner.get(pane.id);
    if (!known) {
      this.workerOwner.set(pane.id, {
        threadId: owner.threadId,
        title: pane.name,
        agent: pane.agent,
      });
      this.pushLocalEvent(owner.threadId, {
        at: Date.now(),
        kind: "worker-spawned",
        text: `${pane.id} (${pane.agent}) "${pane.name}"`,
        workerId: pane.id,
      });
      this.hooks.onWorkerEvent(owner.threadId, {
        kind: "spawned",
        paneId: pane.id,
        agent: pane.agent,
        title: pane.name,
      });
    } else if (known.title !== pane.name) {
      known.title = pane.name;
    }
    if (pane.state !== "blocked" && this.notifiedBlocker.has(pane.id))
      this.notifiedBlocker.delete(pane.id);
    // The last view of every live worker: a kill (lead's kora_kill, the human's stop) removes the pane before it
    // exits, so `pane.closed` is all we hear — this keeps its tile (and swarm task row) listed as exited.
    if (!pane.exited) {
      this.lastSeenWorker.set(pane.id, this.worker(pane));
      while (this.lastSeenWorker.size > 64)
        this.lastSeenWorker.delete(this.lastSeenWorker.keys().next().value as string);
    }
    // working → idle on a CLI worker = it finished its turn (or stopped on an error) and is now waiting. The lead must
    // hear that at once: a worker that died on a usage limit used to sit idle while the lead waited minutes for it.
    // Swarm workers report through their own report / failover events.
    const prev = this.workerState.get(pane.id) ?? {
      state: "unknown",
      worked: false,
      idleAt: null,
    };
    const idleAt = pane.state !== "idle" ? null : prev.state === "idle" ? prev.idleAt : Date.now();
    this.workerState.set(pane.id, {
      state: pane.state,
      worked: prev.worked || pane.state === "working",
      // When it last arrived at idle: the end of its turn (the box's "Done" and frozen clock).
      idleAt,
    });
    // "Done" is reported only after IDLE_GRACE_MS of idle (turnFields): refresh the snapshot when that grace ends, so a
    // short mid-turn idle never flashes the box to Done and back.
    if (idleAt !== null && prev.idleAt === null && !pane.exited) {
      const threadId = owner.threadId;
      const t = setTimeout(
        () => this.touchFleet(threadId),
        Math.max(0, idleAt + this.doneGraceMs - Date.now()) + 50,
      );
      t.unref();
    }
    // Any arrival at idle after the worker has worked counts — not only working → idle: a worker whose last step was a
    // dialog (working → blocked → idle) or whose first state read came late (unknown → idle) used to finish silently
    // after the lead's turn had ended, and the lead never heard of it.
    if (
      method === "agent.state" &&
      pane.state === "idle" &&
      prev.state !== "idle" &&
      (prev.state === "working" || prev.worked) &&
      !pane.swarm &&
      !pane.exited &&
      // A worker that has not taken its first prompt yet (Claude starting up after its trust dialog was answered) is
      // not "finished its turn": that false note woke the lead, which re-sent the task (pl5 S2-2).
      !pane.promptPending
    ) {
      const threadId = owner.threadId;
      const idleSince = Date.now();
      const t = setTimeout(() => {
        const live = this.runtime.panes.get(pane.id);
        if (!live || live.exited || live.state !== "idle" || live.promptPending) return;
        // Kora is auto-continuing it after a transient API error: the next state says how that went.
        if (live.errorStall?.retrying) return;
        if (live.errorStall) {
          this.notifyErrorStall(threadId, live);
          return;
        }
        let screen = "";
        try {
          screen = live.read("screen", "text");
        } catch {
          /* gone */
        }
        const { tail, problem } = workerScreenTail(screen);
        this.hooks.onWorkerEvent(threadId, {
          kind: "idle",
          paneId: live.id,
          title: live.name,
          tail,
          problem,
          idleSince,
        });
      }, IDLE_GRACE_MS);
      t.unref();
    }
    // The auto-continue after a transient API error did not take (no state change follows): tell the lead now.
    if (
      !pane.exited &&
      !pane.swarm &&
      pane.state === "idle" &&
      pane.errorStall &&
      !pane.errorStall.retrying &&
      prev.worked
    )
      this.notifyErrorStall(owner.threadId, pane);
    if (pane.state === "working") this.notifiedErrorStall.delete(pane.id);
    if (method === "agent.state" && pane.state === "blocked") {
      // Trust / permission dialogs the runtime auto-answers clear within a second; only a prompt that is
      // still up after the grace window is worth a transcript row and an orchestrator note — and only once
      // per distinct blocker, however many times the agent redraws it.
      const threadId = owner.threadId;
      const t = setTimeout(() => {
        const live = this.runtime.panes.get(pane.id);
        if (!live || live.exited || live.state !== "blocked") return;
        // Same prompt, different frame: Codex's title blinks "[ . ] Action Required" / "[ ! ] Action Required" every
        // second, Claude re-renders its dialog per keystroke. Compare a normalised key, not the raw text.
        const key = blockerKey(live.blocker);
        if (this.notifiedBlocker.has(live.id) && this.notifiedBlocker.get(live.id) === key) return;
        this.notifiedBlocker.set(live.id, key);
        this.hooks.onWorkerEvent(threadId, {
          kind: "blocked",
          paneId: live.id,
          blocker: live.blocker,
        });
      }, BLOCKED_GRACE_MS);
      t.unref();
    }
    // A swarm pane replaced by a failover is on its way out, not done: no EXITED note, no exited tile (journey d).
    const superseded =
      !!pane.swarm && (!!pane.swarm.supersededBy || pane.swarm.phase === "respawning");
    // Put to sleep by Kora (worker-sleep.ts): it reappears as an asleep worker from its record — no EXITED note/tile.
    if (pane.exited && !superseded && !pane.sleeping) {
      const remembered = this.exitedWorkers.get(owner.threadId) ?? new Map<string, FleetWorker>();
      if (!remembered.has(pane.id)) {
        this.notifiedBlocker.delete(pane.id);
        try {
          this.exitedScreens.set(pane.id, {
            history: pane.read("scrollback", "ansi", HISTORY_LINES),
            screen: pane.read("screen", "text"),
          });
          while (this.exitedScreens.size > 24)
            this.exitedScreens.delete(this.exitedScreens.keys().next().value as string);
        } catch {
          /* the PTY buffer may already be gone */
        }
        remembered.set(pane.id, this.worker(pane));
        while (remembered.size > 12) remembered.delete(remembered.keys().next().value as string);
        this.exitedWorkers.set(owner.threadId, remembered);
        if (!pane.retired)
          this.hooks.onWorkerEvent(owner.threadId, {
            kind: "done",
            paneId: pane.id,
            exitCode: pane.exitCode,
            title: pane.name,
          });
      }
    }
    this.bus.emit("terminal", {
      type: "upsert",
      terminal: this.summary(pane, owner.threadId, WORKER_PREFIX + pane.id),
    } satisfies PtyMetaStreamEvent);
    this.touchFleet(owner.threadId);
  }

  /** One note per error stall the auto-continue could not clear: the lead must re-dispatch or prompt it. */
  private notifyErrorStall(threadId: string, pane: KoraPaneLike): void {
    const es = pane.errorStall;
    if (!es) return;
    const key = `${es.at}:${es.retries}`;
    if (this.notifiedErrorStall.get(pane.id) === key) return;
    this.notifiedErrorStall.set(pane.id, key);
    let screen = "";
    try {
      screen = pane.read("screen", "text");
    } catch {
      /* gone */
    }
    this.hooks.onWorkerEvent(threadId, {
      kind: "idle",
      paneId: pane.id,
      title: pane.name,
      tail: workerScreenTail(screen).tail,
      problem: `error-stalled on a transient API error: ${es.line} (kora sent "continue" ${es.retries}/${ERROR_STALL_RETRIES} times; kora_prompt it "continue" to try again)`,
      idleSince: Date.now(),
    });
  }

  /**
   * CLI workers that say "working" but have written nothing for WORKER_STALL_MS: one `stalled` note per quiet
   * episode (a later write starts a new one). Swarm workers have their own health checks. `now` is for tests.
   */
  sweepStalls(now = Date.now()): void {
    for (const pane of this.runtime.panes.values()) {
      if (pane.role !== "worker" || !pane.orchestratorId || pane.swarm || pane.exited) continue;
      if (pane.state !== "working") continue;
      // Kora is already getting it past an error or a dead stream: the retry pill shows it, the lead hears if it fails.
      if (pane.errorStall?.retrying || pane.info?.()?.retrying) continue;
      const quietMs = now - (pane.lastOutputAt || pane.createdAt);
      if (quietMs < (pane.toolRunning ? WORKER_TOOL_STALL_MS : WORKER_STALL_MS)) continue;
      if (this.notifiedStall.get(pane.id) === pane.lastOutputAt) continue;
      const owner = this.hooks.threadForOrchestrator(pane.orchestratorId);
      if (!owner) continue;
      this.notifiedStall.set(pane.id, pane.lastOutputAt);
      let screen = "";
      try {
        screen = pane.read("screen", "text");
      } catch {
        /* gone */
      }
      this.hooks.onWorkerEvent(owner.threadId, {
        kind: "stalled",
        paneId: pane.id,
        title: pane.name,
        quietMs,
        tail: workerScreenTail(screen).tail,
        lastOutputAt: pane.lastOutputAt,
      });
    }
  }

  /** Re-emit a thread's snapshot (e.g. the leader's measured tokens changed when a turn settled). */
  refresh(threadId: string): void {
    this.touchFleet(threadId);
  }

  /** Debounced whole-snapshot re-emit for one thread's fleet subscribers. */
  private touchFleet(threadId: string): void {
    if (this.fleetTouchTimers.has(threadId)) return;
    const t = setTimeout(() => {
      this.fleetTouchTimers.delete(threadId);
      const snapshot = this.snapshot(threadId);
      if (snapshot)
        this.bus.emit(`fleet:${threadId}`, {
          type: "snapshot",
          snapshot,
        } satisfies FleetStreamEvent);
    }, 40);
    t.unref();
    this.fleetTouchTimers.set(threadId, t);
  }

  private pushLocalEvent(threadId: string, event: FleetEvent): void {
    const list = this.localEvents.get(threadId) ?? [];
    list.push(event);
    while (list.length > MAX_EVENTS) list.shift();
    this.localEvents.set(threadId, list);
  }

  // ── fleet read model ─────────────────────────────────────────────────────────────────
  private worker(p: KoraPaneLike): FleetWorker {
    const tokens = p.swarm && p.worktree ? this.tokens.forWorktree(p.worktree.path) : null;
    const recordId = (
      this.runtime.workerSleeper?.() as
        | { recordForPane?(id: string): { recordId: string } | null }
        | undefined
    )?.recordForPane?.(p.id)?.recordId;
    return {
      ...(recordId ? { recordId } : {}),
      paneId: p.id,
      terminalId: WORKER_PREFIX + p.id,
      agent: p.agent,
      account: p.account ?? null,
      title: p.name || p.agent,
      state: p.exited ? "exited" : p.state,
      blocker: p.blocker,
      steered: typeof p.steeredAt === "number" && Date.now() - p.steeredAt < STEERED_WINDOW_MS,
      steeredAt: p.steeredAt ?? null,
      cwd: p.liveCwd || p.cwd,
      worktree: p.worktree
        ? {
            path: p.worktree.path,
            branch: p.worktree.branch,
            mainRoot: p.worktree.mainRoot,
            ...(typeof p.worktree.dirty === "number" ? { dirty: p.worktree.dirty } : {}),
            ...(typeof p.worktree.ahead === "number" ? { ahead: p.worktree.ahead } : {}),
          }
        : null,
      costUsd: p.swarm ? null : typeof p.ledger?.costUsd === "number" ? p.ledger.costUsd : null,
      contextPct: ctxPct(p),
      exitCode: p.exitCode,
      createdAt: p.createdAt,
      lastOutputAt: p.lastOutputAt,
      ...(p.branchMerged ? { branchMerged: true } : {}),
      ...(p.swarm ? { swarm: toFleetSwarmWorker(p.swarm) } : {}),
      ...(tokens ? { tokens } : {}),
      ...boxFields(p),
      ...this.turnFields(p),
    };
  }

  /** "Done" (a finished turn, answer ready) and "stopped on an error" for a live, idle worker. */
  private turnFields(p: KoraPaneLike, now = Date.now()): Partial<FleetWorker> {
    if (p.exited || p.swarm || p.state !== "idle") return {};
    const es = p.errorStall;
    const ws = this.workerState.get(p.id);
    // Stopped: the clock stops too (the box's elapsed time ends at turnEndedAt).
    if (es && !es.retrying) return { stoppedOnError: es.line, turnEndedAt: ws?.idleAt ?? es.at };
    if (p.promptPending || es?.retrying) return {};
    // A GUI worker knows its own last turn end (survives a ui-server restart); a terminal worker's is what we saw.
    const own = p.info?.()?.turnEndedAt;
    const ended =
      typeof own === "number" ? own : ws?.worked && ws.idleAt !== null ? ws.idleAt : null;
    if (ended === null) return {};
    // A short idle inside a turn is not Done: wait out the same grace the lead's idle note waits.
    if (now - ended < this.doneGraceMs) return {};
    return { turnEndedAt: ended };
  }

  snapshot(threadId: string): FleetSnapshot | null {
    const orchestratorId = this.hooks.orchestratorIdFor(threadId);
    if (!orchestratorId) return null;
    const live = [...this.runtime.panes.values()].filter(
      (p) => p.orchestratorId === orchestratorId,
    );
    const liveIds = new Set(live.map((p) => p.id));
    // Chat leads' CLI workers that went to sleep: shown (dimmed) from their records, readable, wakeable.
    const sleeping = (this.runtime.workerSleeper?.().list(orchestratorId) ?? []).filter(
      (r) => r.status === "asleep",
    );
    // A worker with a sleep record is shown once, as asleep — never a second "exited" tile beside it.
    const asleepPanes = new Set(sleeping.map((r) => r.paneId));
    const remembered = [...(this.exitedWorkers.get(threadId)?.values() ?? [])].filter(
      (w) => !liveIds.has(w.paneId) && !asleepPanes.has(w.paneId),
    );
    const asleep: FleetWorker[] = sleeping.map((r) => ({
      paneId: r.recordId,
      terminalId: `asleep:${r.recordId}`,
      agent: r.agent,
      account: null,
      title: r.title,
      state: "asleep" as const,
      blocker: null,
      steered: false,
      steeredAt: null,
      cwd: r.cwd,
      worktree: r.worktree && r.branchKept ? { ...r.worktree, ahead: r.changes?.ahead ?? 0 } : null,
      costUsd: null,
      contextPct: null,
      exitCode: null,
      createdAt: r.createdAt,
      lastOutputAt: r.sleptAt ?? r.createdAt,
      recordId: r.recordId,
      asleep: {
        sleptAt: r.sleptAt ?? r.createdAt,
        finalReport: r.finalReport ? r.finalReport.slice(0, 4000) : null,
        ahead: r.changes?.ahead ?? 0,
        files: (r.changes?.files ?? []).slice(0, 50),
        branchKept: r.branchKept,
        canResume: !!r.session.id,
      },
    }));
    const known = new Set(
      [...live.map((p) => p.swarm?.taskId), ...remembered.map((w) => w.swarm?.taskId)].filter(
        (x): x is string => !!x,
      ),
    );
    const restored = (this.runtime.swarm?.restoredTasks?.(orchestratorId) ?? [])
      .filter((t) => !known.has(t.taskId))
      .map((t) => restoredTaskWorker(t, live[0]?.cwd ?? ""));
    const workers = [
      ...live.map((p) => this.worker(p)),
      ...remembered,
      ...asleep,
      ...restored,
    ].sort((a, b) => a.createdAt - b.createdAt);
    const fleet = this.runtime.fleetGet(orchestratorId);
    const activity = swarmActivity(workers, this.hooks.leaderTokensFor?.(threadId) ?? null);
    const runtimeEvents: FleetEvent[] = fleet.events
      .filter(
        (e) =>
          e.kind === "worker-done" ||
          e.kind === "blocked" ||
          e.kind === "plan" ||
          e.kind === "human-steered" ||
          // the runtime saw a worker's branch merged by hand (outside kora_merge)
          e.kind === "merged",
      )
      .map((e) => ({
        at: e.at,
        kind: e.kind as FleetEvent["kind"],
        text: e.text,
        ...(e.workerId ? { workerId: e.workerId } : {}),
      }));
    const seen = new Set<string>();
    const events = [...(this.localEvents.get(threadId) ?? []), ...runtimeEvents]
      .filter((e) => {
        const k = `${e.at}|${e.kind}|${e.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_EVENTS);
    return jsonSafe({
      threadId: threadId as FleetSnapshot["threadId"],
      orchestratorId,
      workers,
      plan: fleet.plan ?? "",
      events,
      lastVerdict: this.verdicts.get(threadId) ?? null,
      updatedAt: now(),
      ...(activity ? { swarm: activity } : {}),
    });
  }

  subscribe(threadId: string): Stream.Stream<FleetStreamEvent> {
    const self = this;
    return Stream.callback<FleetStreamEvent>((queue) =>
      Effect.gen(function* () {
        const listener = (item: FleetStreamEvent) => Queue.offerUnsafe(queue, item);
        self.bus.on(`fleet:${threadId}`, listener);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => self.bus.off(`fleet:${threadId}`, listener)),
        );
        const snapshot = self.snapshot(threadId);
        if (snapshot) Queue.offerUnsafe(queue, { type: "snapshot", snapshot });
        return yield* Effect.never;
      }),
    );
  }

  /**
   * One worker box's feed (`fleet.subscribeWorker`): a snapshot, then every item that changes. A terminal-only pane
   * gets an empty snapshot (the box hosts its terminal instead). Every value is JSON-sanitised (wire hazard).
   */
  subscribeWorker(threadId: string, paneId: string): Stream.Stream<WorkerFeedStreamEvent> {
    const self = this;
    return Stream.callback<WorkerFeedStreamEvent>((queue) =>
      Effect.gen(function* () {
        const owned = self.ownedWorker(threadId, paneId);
        const listener = (method: string, params: unknown) => {
          if (method !== "pane.feed") return;
          const p = params as { paneId: string; item: WorkerFeedItem };
          if (p.paneId !== paneId) return;
          // Only this thread's worker streams to it (pane ids restart per daemon; another thread's p3 is not ours).
          if (!self.ownedWorker(threadId, paneId)) return;
          Queue.offerUnsafe(
            queue,
            jsonSafe({ type: "upsert", paneId, item: p.item }) as WorkerFeedStreamEvent,
          );
        };
        self.runtime.on("notify", listener);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => void self.runtime.off?.("notify", listener)),
        );
        const items = owned ? (self.runtime.workerFeed?.(paneId) ?? []) : [];
        Queue.offerUnsafe(
          queue,
          jsonSafe({ type: "snapshot", paneId, items }) as WorkerFeedStreamEvent,
        );
        return yield* Effect.never;
      }),
    );
  }

  /** The box's approval card (Allow / Allow always / Deny). false = not this thread's worker. */
  async respondApproval(
    threadId: string,
    paneId: string,
    requestId: string,
    decision: "accept" | "acceptForSession" | "decline",
  ): Promise<boolean> {
    const pane = this.ownedWorker(threadId, paneId);
    if (!pane || !this.runtime.respondWorkerApproval) return false;
    await this.runtime.respondWorkerApproval(paneId, requestId, decision);
    return true;
  }

  /**
   * A swarm worker's report for `fleet.readReport` (capped at 256 KB; the text never rides in the snapshot).
   * null = unknown thread / worker (or no report written yet). Routed to the runtime's SwarmService.readReport.
   */
  async readReport(threadId: string, paneId: string): Promise<FleetReadReportResult | null> {
    const orchestratorId = this.hooks.orchestratorIdFor(threadId);
    const gui = this.runtime.panes.get(paneId);
    if (
      orchestratorId &&
      gui &&
      !gui.swarm &&
      gui.orchestratorId === orchestratorId &&
      gui.info?.().surface === "gui" &&
      this.runtime.report
    ) {
      const text = this.runtime.report(paneId, 1);
      return text ? jsonSafe({ text, truncated: false, updatedAt: gui.lastOutputAt }) : null;
    }
    const swarm = this.runtime.swarm;
    if (!orchestratorId || !swarm) return null;
    // The worker may be live, reaped, or pre-restart: ownership comes from the pane or the task registry.
    const live = this.runtime.panes.get(paneId);
    const owned = live
      ? live.orchestratorId === orchestratorId
      : swarm.taskForPane(paneId)?.orchestratorId === orchestratorId;
    if (!owned) return null;
    const r = await swarm.readReport(paneId);
    return r ? jsonSafe({ text: r.text, truncated: r.truncated, updatedAt: r.updatedAt }) : null;
  }

  /** An exited-and-reaped worker as the panel remembers it (null while its pane is still live). */
  rememberedWorker(paneId: string): FleetWorker | null {
    if (this.runtime.panes.has(paneId)) return null;
    for (const m of this.exitedWorkers.values()) {
      const w = m.get(paneId);
      if (w) return w;
    }
    return null;
  }

  /** The last screen of an exited-and-reaped worker, for `kora_read` after the runtime dropped the pane. */
  rememberedScreen(paneId: string): string | null {
    return this.exitedScreens.get(paneId)?.screen ?? null;
  }

  // ── fleet actions (the human's buttons) ──────────────────────────────────────────────
  private ownedWorker(threadId: string, paneId: string): KoraPaneLike | null {
    const orchestratorId = this.hooks.orchestratorIdFor(threadId);
    const pane = this.runtime.panes.get(paneId);
    if (!orchestratorId || !pane || pane.orchestratorId !== orchestratorId) return null;
    return pane;
  }

  /** Type as the human (steer provenance) and submit. */
  async steer(threadId: string, paneId: string, text: string, submit: boolean): Promise<boolean> {
    const pane = this.ownedWorker(threadId, paneId);
    if (!pane || pane.exited) return false;
    // A GUI worker (DriverPane) takes the box's text as a message, never as keystrokes.
    if (pane.steerSink && this.runtime.humanSteer && pane.info?.().surface === "gui") {
      if (!submit || !text.trim()) return true;
      await this.runtime.humanSteer(paneId, text);
      return true;
    }
    this.runtime.humanWrite(paneId, text);
    if (submit) {
      await new Promise((r) => setTimeout(r, 60));
      this.runtime.humanWrite(paneId, "\r");
    }
    return true;
  }

  kill(threadId: string, paneId: string): boolean {
    const pane = this.ownedWorker(threadId, paneId);
    if (!pane) return false;
    // Swarm QA 2026-10-02: a stopped worker vanished from the panel (killPane removes the pane before it exits, so
    // no exited tile was remembered) and the lead heard "EXITED … continue the plan", read the task as failed and
    // respawned it — overriding the human. Remember it as stopped, tell SwarmService, and send the lead a decision.
    const task = pane.swarm ? (this.runtime.swarm?.userStopped?.(paneId) ?? null) : null;
    const before = this.worker(pane);
    const remembered = this.exitedWorkers.get(threadId) ?? new Map<string, FleetWorker>();
    remembered.set(paneId, {
      ...before,
      state: "exited",
      blocker: null,
      stoppedByUser: true,
      ...(before.swarm ? { swarm: { ...before.swarm, phase: "failed" as const } } : {}),
    });
    while (remembered.size > 12) remembered.delete(remembered.keys().next().value as string);
    this.exitedWorkers.set(threadId, remembered);
    pane.stoppedByUser = true;
    try {
      this.runtime.killPane(paneId);
    } catch {
      /* already gone (exited between the click and here): it is recorded as stopped all the same */
    }
    this.pushLocalEvent(threadId, {
      at: Date.now(),
      kind: "note",
      text: `${paneId} stopped by you`,
      workerId: paneId,
    });
    this.hooks.onWorkerEvent(threadId, {
      kind: "stopped",
      paneId,
      title: pane.name,
      taskId: task?.taskId ?? pane.swarm?.taskId ?? null,
    });
    this.touchFleet(threadId);
    return true;
  }

  /**
   * `fleet.retry`: move a swarm worker to a different model (SwarmService.failover, reason 'stalled'). Throws a
   * plain Error (the handler turns it into `FleetOperationError`) for a worker that is not a swarm worker or that
   * already ended; `null` means paneId is not owned by this thread at all (→ `FleetWorkerNotFoundError`).
   */
  async retry(threadId: string, paneId: string): Promise<{ newPaneId: string } | null> {
    const pane = this.ownedWorker(threadId, paneId);
    if (!pane) return null;
    if (!pane.swarm) throw new Error(`${paneId} is not a swarm worker`);
    if (!this.runtime.swarm) throw new Error("swarm is not available");
    const r = await this.runtime.swarm.retryWorker(paneId);
    if (!r) throw new Error(`swarm worker ${paneId} cannot be retried (already done or exhausted)`);
    this.pushLocalEvent(threadId, {
      at: Date.now(),
      kind: "note",
      text: `${paneId} moved to another model by you (${r.newPaneId})`,
      workerId: paneId,
    });
    this.touchFleet(threadId);
    return { newPaneId: r.newPaneId };
  }

  /**
   * `fleet.extend`: give a swarm worker's watchdog `minutes` more before its next nudge/reassign. Same error shape
   * as `retry`.
   */
  async extend(threadId: string, paneId: string, minutes: number): Promise<boolean> {
    const pane = this.ownedWorker(threadId, paneId);
    if (!pane) return false;
    if (!pane.swarm) throw new Error(`${paneId} is not a swarm worker`);
    if (!this.runtime.swarm) throw new Error("swarm is not available");
    const r = this.runtime.swarm.extendWorker(paneId, minutes);
    if (!r)
      throw new Error(`swarm worker ${paneId} cannot be extended (already done or exhausted)`);
    this.pushLocalEvent(threadId, {
      at: Date.now(),
      kind: "note",
      text: `${paneId} given ${minutes} more minute${minutes === 1 ? "" : "s"} by you`,
      workerId: paneId,
    });
    this.touchFleet(threadId);
    return true;
  }

  async mergeVerify(
    threadId: string,
    paneIds?: readonly string[],
  ): Promise<FleetMergeVerdict | null> {
    const orchestratorId = this.hooks.orchestratorIdFor(threadId);
    if (!orchestratorId) return null;
    const ids = paneIds?.length
      ? [...paneIds]
      : [...this.runtime.panes.values()]
          .filter((p) => p.orchestratorId === orchestratorId && p.worktree)
          .map((p) => p.id);
    const r = await this.runtime.mergeVerify({ paneIds: ids });
    const verdict: FleetMergeVerdict = jsonSafe({
      pairs: r.pairs,
      order: r.order,
      verifiedAt: now(),
    });
    this.recordVerdict(threadId, verdict);
    return verdict;
  }

  /** Also called when the ORCHESTRATOR verifies through its own tool, so the panel shows the same verdict. */
  recordVerdict(threadId: string, verdict: FleetMergeVerdict): void {
    this.verdicts.set(threadId, verdict);
    const semantic = verdict.pairs.filter((p) => p.status !== "clean").length;
    this.pushLocalEvent(threadId, {
      at: Date.now(),
      kind: "merge-verified",
      text:
        verdict.pairs.length === 0
          ? "merge verified: nothing to cross-check"
          : semantic
            ? `merge verified: ${semantic} conflicting pair(s) — ${verdict.pairs
                .filter((p) => p.status !== "clean")
                .map((p) => `${p.a}×${p.b}`)
                .join(", ")}`
            : `merge verified: ${verdict.pairs.length} pair(s) clean · order ${verdict.order.join(" → ")}`,
    });
    this.touchFleet(threadId);
  }

  async merge(
    threadId: string,
    paneId: string,
    commitFirst: boolean,
  ): Promise<{
    ok: boolean;
    branch: string;
    into: string;
    message: string;
    conflicts: string[];
  } | null> {
    const pane =
      this.ownedWorker(threadId, paneId) ??
      (this.workerOwner.get(paneId)?.threadId === threadId
        ? (this.runtime.panes.get(paneId) ?? null)
        : null);
    if (!pane) return null;
    if (!pane.worktree)
      return {
        ok: true,
        branch: "",
        into: "",
        message: "works in the shared checkout — nothing to merge",
        conflicts: [],
      };
    // A worker mid-turn (or waiting on a question) has a half-finished tree: commitFirst would commit and merge it.
    if (!pane.exited && (pane.state === "working" || pane.state === "blocked"))
      return {
        ok: false,
        branch: pane.worktree.branch,
        into: "",
        message: `${pane.name || paneId} is still ${pane.state === "blocked" ? "waiting for an answer" : "working"} — merge it once it is done (or stop it first)`,
        conflicts: [],
      };
    const r = await this.runtime.worktreeMerge({ paneId, commitFirst });
    this.recordMerge(threadId, paneId, r);
    return {
      ok: r.ok,
      branch: r.merged ?? pane.worktree.branch,
      into: r.into ?? "",
      message: r.message,
      conflicts: r.conflicts,
    };
  }

  recordMerge(
    threadId: string,
    paneId: string,
    r: {
      ok: boolean;
      merged: string | null;
      into: string | null;
      message: string;
      conflicts: string[];
    },
  ): void {
    this.pushLocalEvent(threadId, {
      at: Date.now(),
      kind: "merged",
      text: `${paneId}: ${r.ok ? "merged" : "NOT merged"} — ${r.message}${r.conflicts.length ? ` (${r.conflicts.join(", ")})` : ""}`,
      workerId: paneId,
    });
    this.touchFleet(threadId);
  }

  setPlan(threadId: string, plan: string): boolean {
    const orchestratorId = this.hooks.orchestratorIdFor(threadId);
    if (!orchestratorId) return false;
    this.runtime.fleetSet(orchestratorId, { plan });
    this.touchFleet(threadId);
    return true;
  }

  // ── terminals backed by panes ─────────────────────────────────────────────────────────
  private resolve(
    threadId: string,
    terminalId: string,
  ): { kind: "worker" | "shell"; pane: KoraPaneLike } | null {
    if (terminalId.startsWith(WORKER_PREFIX)) {
      const pane = this.runtime.panes.get(terminalId.slice(WORKER_PREFIX.length));
      return pane ? { kind: "worker", pane } : null;
    }
    const shell = this.shells.get(key(threadId, terminalId));
    if (!shell) return null;
    const pane = this.runtime.panes.get(shell.paneId);
    return pane ? { kind: "shell", pane } : null;
  }

  private terminalStatus(pane: KoraPaneLike): PtySessionSnapshot["status"] {
    return pane.exited ? "exited" : "running";
  }

  private sessionSnapshot(
    pane: KoraPaneLike | null,
    threadId: string,
    terminalId: string,
    fallbackCwd: string,
    historyOverride?: string,
  ): PtySessionSnapshot {
    if (!pane) {
      const gone = terminalId.startsWith(WORKER_PREFIX)
        ? this.exitedScreens.get(terminalId.slice(WORKER_PREFIX.length))
        : undefined;
      return jsonSafe({
        threadId,
        terminalId,
        cwd: fallbackCwd || process.cwd(),
        worktreePath: null,
        status: "exited" as const,
        pid: null,
        history: gone?.history ?? "",
        exitCode: 0,
        exitSignal: null,
        label: terminalId.startsWith(WORKER_PREFIX) ? "worker · closed" : "shell",
        updatedAt: now(),
      });
    }
    let history = historyOverride ?? "";
    if (historyOverride === undefined) {
      try {
        history = pane.read("scrollback", "ansi", HISTORY_LINES);
      } catch {
        history = "";
      }
    }
    return jsonSafe({
      threadId,
      terminalId,
      cwd: pane.liveCwd || pane.cwd,
      worktreePath: pane.worktree?.path ?? null,
      status: this.terminalStatus(pane),
      pid: pane.pid && pane.pid > 0 ? pane.pid : null,
      history,
      exitCode: pane.exited ? (pane.exitCode ?? 0) : null,
      exitSignal: null,
      label: terminalId.startsWith(WORKER_PREFIX) ? workerLabel(pane) : pane.name || "shell",
      updatedAt: now(),
    });
  }

  private summary(pane: KoraPaneLike, threadId: string, terminalId: string): PtySummary {
    const isWorker = terminalId.startsWith(WORKER_PREFIX);
    return jsonSafe({
      threadId,
      terminalId,
      cwd: pane.liveCwd || pane.cwd,
      worktreePath: pane.worktree?.path ?? null,
      status: this.terminalStatus(pane),
      pid: pane.pid && pane.pid > 0 ? pane.pid : null,
      exitCode: pane.exited ? (pane.exitCode ?? 0) : null,
      exitSignal: null,
      hasRunningSubprocess: !pane.exited && (isWorker ? pane.state === "working" : false),
      label: isWorker ? workerLabel(pane) : pane.name || "shell",
      updatedAt: now(),
    });
  }

  async open(input: {
    cwd: string;
    terminalId: string;
    threadId: string;
    worktreePath?: string | null;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }): Promise<PtySessionSnapshot> {
    const existing = this.resolve(input.threadId, input.terminalId);
    if (existing && !existing.pane.exited)
      return this.sessionSnapshot(existing.pane, input.threadId, input.terminalId, input.cwd);
    if (input.terminalId.startsWith(WORKER_PREFIX))
      return this.sessionSnapshot(
        existing?.pane ?? null,
        input.threadId,
        input.terminalId,
        input.cwd,
      );
    const cwd = input.worktreePath || input.cwd;
    const workspaceId = this.runtime.chatWorkspaceId?.();
    const info = await this.runtime.spawnPane({
      cwd,
      ...(workspaceId ? { workspaceId } : {}),
      name: input.terminalId,
      cols: input.cols ?? 120,
      rows: input.rows ?? 30,
      ...(input.env ? { env: input.env } : {}),
    });
    this.shells.set(key(input.threadId, input.terminalId), {
      threadId: input.threadId,
      terminalId: input.terminalId,
      paneId: info.id,
    });
    this.shellByPane.set(info.id, { threadId: input.threadId, terminalId: input.terminalId });
    const pane = this.runtime.panes.get(info.id) ?? null;
    if (pane)
      this.bus.emit("terminal", {
        type: "upsert",
        terminal: this.summary(pane, input.threadId, input.terminalId),
      } satisfies PtyMetaStreamEvent);
    return this.sessionSnapshot(pane, input.threadId, input.terminalId, cwd);
  }

  attach(input: {
    threadId: string;
    terminalId: string;
    cwd?: string;
    worktreePath?: string | null;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    restartIfNotRunning?: boolean;
  }): Stream.Stream<PtyAttachStreamEvent> {
    const self = this;
    return Stream.callback<PtyAttachStreamEvent>((queue) =>
      Effect.gen(function* () {
        let resolved = self.resolve(input.threadId, input.terminalId);
        if (
          (!resolved || resolved.pane.exited) &&
          !input.terminalId.startsWith(WORKER_PREFIX) &&
          input.cwd
        ) {
          // A shell the client expects to exist (fresh open, or a daemon restart lost it): spawn it.
          yield* Effect.promise(() =>
            self
              .open({
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd!,
                ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
                ...(input.cols !== undefined ? { cols: input.cols } : {}),
                ...(input.rows !== undefined ? { rows: input.rows } : {}),
                ...(input.env !== undefined ? { env: input.env } : {}),
              })
              .catch(() => null),
          );
          resolved = self.resolve(input.threadId, input.terminalId);
        }
        const pane = resolved?.pane ?? null;
        if (!pane) {
          Queue.offerUnsafe(queue, {
            type: "snapshot",
            snapshot: self.sessionSnapshot(null, input.threadId, input.terminalId, input.cwd ?? ""),
          });
          return yield* Effect.never;
        }
        const base = { threadId: input.threadId, terminalId: input.terminalId };
        // Live output is held behind the snapshot, then spliced on at the snapshot's exact stream offset.
        const seam = new OutputSeam((data) =>
          Queue.offerUnsafe(queue, { ...base, type: "output", data }),
        );
        const onOutput = (d: unknown, end: unknown) =>
          seam.push(String(d), typeof end === "number" ? end : undefined);
        let closed = false;
        let resyncTimer: ReturnType<typeof setTimeout> | undefined;
        const emitSnapshot = (history?: string) => {
          if (closed) return;
          Queue.offerUnsafe(queue, {
            type: "snapshot",
            snapshot: self.sessionSnapshot(
              pane,
              input.threadId,
              input.terminalId,
              input.cwd ?? "",
              history,
            ),
          });
        };
        // Output is held from `seam.begin()` until the snapshot lands; a snapshot request is never dropped, and a newer
        // one retires older ones (see OutputSeam), so overlapping resyncs cannot lose or repeat output.
        const takeSnapshot = async (seq: number = seam.begin()) => {
          if (!pane.snapshotAt) {
            // No exact offset: the fresh read already contains every held chunk.
            seam.complete(seq, Number.POSITIVE_INFINITY, () => emitSnapshot());
            return;
          }
          const exact = pane.snapshotAt(HISTORY_LINES).catch(() => null);
          const within = (ms: number) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<"late">((resolve) => {
              timer = setTimeout(() => resolve("late"), ms);
            });
            return Promise.race([exact, late]).finally(() => clearTimeout(timer));
          };
          let snap = await within(SNAPSHOT_SLOW_MS);
          if (snap === "late") {
            // The mirror is behind (a flood). Show a stand-in now but keep holding output for the exact snapshot:
            // releasing against a plain read() would drop whatever the mirror has not parsed yet.
            if (!closed && seam.isOpen(seq)) emitSnapshot();
            snap = await within(SNAPSHOT_GIVE_UP_MS);
          }
          if (closed) return;
          if (snap && snap !== "late")
            seam.complete(seq, snap.at, () => emitSnapshot(snap.history));
          else if (snap === "late") seam.complete(seq, Number.NEGATIVE_INFINITY, () => {});
          else seam.complete(seq, Number.POSITIVE_INFINITY, () => emitSnapshot());
        };
        // After the PTY changes size the app redraws; resend the mirror so the client never keeps a mismatched grid.
        const onResize = () => {
          if (resyncTimer) clearTimeout(resyncTimer);
          resyncTimer = setTimeout(() => {
            resyncTimer = undefined;
            if (!closed) void takeSnapshot();
          }, 150);
        };
        const firstSeq = seam.begin();
        pane.on("output", onOutput);
        pane.on("resize", onResize);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
            if (resyncTimer) clearTimeout(resyncTimer);
            pane.off("output", onOutput);
            pane.off("resize", onResize);
          }),
        );
        yield* Effect.promise(() => takeSnapshot(firstSeq));
        const onExit = (code: unknown) =>
          Queue.offerUnsafe(queue, {
            ...base,
            type: "exited",
            exitCode: typeof code === "number" ? code : null,
            exitSignal: null,
          });
        const onState = () =>
          Queue.offerUnsafe(queue, {
            ...base,
            type: "activity",
            hasRunningSubprocess: !pane.exited && pane.state === "working",
            label: input.terminalId.startsWith(WORKER_PREFIX)
              ? workerLabel(pane)
              : pane.name || "shell",
          });
        pane.on("exit", onExit);
        pane.on("state", onState);
        const onClosed = (method: string, p: unknown) => {
          if (method === "pane.closed" && (p as { paneId?: string })?.paneId === pane.id)
            Queue.offerUnsafe(queue, { ...base, type: "closed" });
        };
        self.runtime.on("notify", onClosed as never);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pane.off("output", onOutput);
            pane.off("exit", onExit);
            pane.off("state", onState);
            (self.runtime as unknown as EventEmitter).off("notify", onClosed);
          }),
        );
        if (pane.exited)
          Queue.offerUnsafe(queue, {
            ...base,
            type: "exited",
            exitCode: pane.exitCode,
            exitSignal: null,
          });
        return yield* Effect.never;
      }),
    );
  }

  write(threadId: string, terminalId: string, data: string): boolean {
    const r = this.resolve(threadId, terminalId);
    if (!r || r.pane.exited) return false;
    if (r.kind === "worker") this.runtime.humanWrite(r.pane.id, data);
    else r.pane.write(data);
    return true;
  }

  resize(threadId: string, terminalId: string, cols: number, rows: number): boolean {
    const r = this.resolve(threadId, terminalId);
    if (!r || r.pane.exited) return false;
    r.pane.resize(cols, rows);
    return true;
  }

  clear(threadId: string, terminalId: string): void {
    const r = this.resolve(threadId, terminalId);
    if (!r) return;
    // A shell can be asked to clear itself; a worker agent owns its screen, so only the client view resets.
    if (r.kind === "shell" && !r.pane.exited) r.pane.write("\x0c");
  }

  /** Closing a WORKER tab never kills the agent (that is an explicit fleet.kill); a shell is torn down. */
  close(threadId: string, terminalId: string | undefined): void {
    if (terminalId === undefined) {
      for (const [k, s] of [...this.shells])
        if (s.threadId === threadId) {
          this.shells.delete(k);
          this.shellByPane.delete(s.paneId);
          try {
            this.runtime.killPane(s.paneId);
          } catch {
            /* gone */
          }
          this.bus.emit("terminal", {
            type: "remove",
            threadId,
            terminalId: s.terminalId,
          } satisfies PtyMetaStreamEvent);
        }
      return;
    }
    if (terminalId.startsWith(WORKER_PREFIX)) return;
    const shell = this.shells.get(key(threadId, terminalId));
    if (!shell) return;
    this.shells.delete(key(threadId, terminalId));
    this.shellByPane.delete(shell.paneId);
    try {
      this.runtime.killPane(shell.paneId);
    } catch {
      /* already gone */
    }
    this.bus.emit("terminal", {
      type: "remove",
      threadId,
      terminalId,
    } satisfies PtyMetaStreamEvent);
  }

  async restart(input: {
    cwd: string;
    terminalId: string;
    threadId: string;
    worktreePath?: string | null;
    cols: number;
    rows: number;
    env?: Record<string, string>;
  }): Promise<PtySessionSnapshot> {
    const r = this.resolve(input.threadId, input.terminalId);
    if (r && input.terminalId.startsWith(WORKER_PREFIX)) {
      await this.runtime.restartPane(r.pane.id, "resume").catch(() => undefined);
      return this.sessionSnapshot(
        this.runtime.panes.get(r.pane.id) ?? null,
        input.threadId,
        input.terminalId,
        input.cwd,
      );
    }
    if (r) {
      const shell = this.shells.get(key(input.threadId, input.terminalId));
      if (shell) {
        this.shells.delete(key(input.threadId, input.terminalId));
        this.shellByPane.delete(shell.paneId);
      }
      try {
        this.runtime.killPane(r.pane.id);
      } catch {
        /* gone */
      }
    }
    return this.open(input);
  }

  metadata(): Stream.Stream<PtyMetaStreamEvent> {
    const self = this;
    return Stream.callback<PtyMetaStreamEvent>((queue) =>
      Effect.gen(function* () {
        const listener = (item: PtyMetaStreamEvent) => Queue.offerUnsafe(queue, item);
        self.bus.on("terminal", listener);
        yield* Effect.addFinalizer(() => Effect.sync(() => self.bus.off("terminal", listener)));
        Queue.offerUnsafe(queue, { type: "snapshot", terminals: self.allSummaries() });
        return yield* Effect.never;
      }),
    );
  }

  private allSummaries(): PtySummary[] {
    const out: PtySummary[] = [];
    for (const s of this.shells.values()) {
      const pane = this.runtime.panes.get(s.paneId);
      if (pane) out.push(this.summary(pane, s.threadId, s.terminalId));
    }
    for (const pane of this.runtime.panes.values()) {
      if (pane.role !== "worker" || !pane.orchestratorId) continue;
      const owner = this.hooks.threadForOrchestrator(pane.orchestratorId);
      if (owner) out.push(this.summary(pane, owner.threadId, WORKER_PREFIX + pane.id));
    }
    return out;
  }
}

/** The worker-box fields of a runtime pane (DriverPane info): absent on a terminal-only pane. */
function boxFields(p: KoraPaneLike): Partial<FleetWorker> {
  const i = p.info?.();
  if (!i || i.surface !== "gui") return {};
  return {
    surface: "gui",
    model: i.model ?? null,
    pendingApproval: i.pendingApproval ? { ...i.pendingApproval } : null,
    retrying: i.retrying ? { ...i.retrying } : null,
    ...(typeof i.costUsd === "number" ? { costUsd: i.costUsd } : {}),
    ...(typeof i.contextPct === "number" ? { contextPct: i.contextPct } : {}),
  };
}

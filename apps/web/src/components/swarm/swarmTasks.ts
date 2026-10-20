import type { FleetSnapshot, FleetSwarmActivity, FleetWorker } from "@kora/contracts";

import { formatContextWindowTokens } from "~/util/contextWindow";

/**
 * Swarm TASKS as the human reads them (pure; no React). One task can span several worker panes (a model
 * failover respawns it), so the panel groups workers by `swarm.taskId` and shows the newest attempt.
 * Copy is plain language and measured-only: no estimates, no dollar figures (PLAN X5).
 */

/** What the task is doing, in one word. */
export type SwarmTaskState =
  | "queued"
  | "running"
  | "checking"
  | "retrying"
  | "cooling-down"
  | "passed"
  | "done"
  | "stopped"
  | "failed";

export const SWARM_TASK_STATE_LABEL: Record<SwarmTaskState, string> = {
  queued: "Queued",
  running: "Running",
  checking: "Checking",
  retrying: "Retrying",
  "cooling-down": "Cooling down",
  passed: "Passed",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

/**
 * The foreman stage (done-check, auto-retry, reviewer) — added to the wire by the foreman work; read
 * defensively so this panel lights up once it lands and works the same without it.
 */
interface ForemanLike {
  readonly state?: "working" | "checking" | "retrying" | "passed" | "escalated";
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly verdicts?: ReadonlyArray<{ readonly failure?: string | null }>;
  readonly result?: {
    readonly kind?: "pass" | "escalation";
    readonly diffStat?: string | null;
    readonly lastFailure?: string | null;
  } | null;
}

function foremanOf(worker: FleetWorker): ForemanLike | null {
  const f = (worker.swarm as { foreman?: ForemanLike | null } | undefined)?.foreman;
  return f && typeof f === "object" ? f : null;
}

export interface SwarmTask {
  readonly taskId: string;
  readonly title: string;
  /** The newest attempt's worker (the one to steer, merge, read). */
  readonly worker: FleetWorker;
  /** Every pane this task ran on, oldest first. */
  readonly paneIds: ReadonlyArray<string>;
  readonly state: SwarmTaskState;
  /** `zen · big-pickle` */
  readonly model: string;
  /** 1-based attempt, and the most attempts the task may take (null when unbounded / unknown). */
  readonly attempt: number;
  readonly maxAttempts: number | null;
  /** One calm line: what is happening now, or why it stopped. */
  readonly activity: string;
  /** The task needs the human (a question, no free models, a failure). */
  readonly needsYou: boolean;
  readonly startedAt: number;
  /** null while the task is still going (elapsed then runs to now). */
  readonly endedAt: number | null;
}

/** The first meaningful line: prose before a bare heading ("## Done" says less than what follows it). */
function firstLine(text: string, max = 140): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const prose = lines.find((l) => !l.startsWith("#"));
  const line = (prose ?? lines[0] ?? "").replace(/^#+\s*/, "").replace(/^[-*]\s+/, "");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const FAILURE_WORDS: Record<string, string> = {
  check: "the done-check failed",
  gate: "the merge check found problems",
  "no-report": "it stopped without writing a report",
  crashed: "the worker crashed",
  reviewer: "the reviewer rejected it",
  report: "the worker reported it did not finish",
  "no-change": "it changed nothing",
};

export function deriveSwarmTask(workers: ReadonlyArray<FleetWorker>): SwarmTask | null {
  const swarmWorkers = workers.filter((w) => w.swarm);
  if (swarmWorkers.length === 0) return null;
  // Newest attempt: the highest attempt number that is not superseded, then the newest pane.
  const worker = swarmWorkers.toSorted((a, b) => {
    const sa = a.swarm!;
    const sb = b.swarm!;
    if ((sa.supersededBy === null) !== (sb.supersededBy === null))
      return sa.supersededBy === null ? -1 : 1;
    if (sa.attempt !== sb.attempt) return sb.attempt - sa.attempt;
    return b.createdAt - a.createdAt;
  })[0]!;
  const s = worker.swarm!;
  const foreman = foremanOf(worker);
  const v = s.verify;

  let state: SwarmTaskState;
  let activity: string;
  let needsYou = false;
  let ended = false;
  switch (s.phase) {
    case "starting":
      state = worker.state === "working" ? "running" : "queued";
      activity = state === "queued" ? "Starting OpenCode…" : "Working";
      break;
    case "running":
      state = "running";
      activity = "Working";
      break;
    case "rate-limited":
      state = "cooling-down";
      activity = `${s.modelLabel} is rate-limited; waiting or switching to another free model`;
      break;
    case "respawning":
      state = "cooling-down";
      activity = "Switching to another free model…";
      break;
    case "exhausted":
      state = "cooling-down";
      activity = "Every free model is rate-limited. It resumes when one cools down, or add a key";
      needsYou = true;
      break;
    case "failed":
      if (worker.stoppedByUser === true) {
        // The human's own decision: not a failure, nothing needs them (its branch is kept).
        state = "stopped";
        activity = "Stopped by you · its branch is kept";
        ended = true;
        break;
      }
      state = "failed";
      activity =
        worker.exitCode !== null && worker.exitCode !== 0
          ? `OpenCode stopped (exit code ${worker.exitCode})`
          : "OpenCode stopped before finishing";
      needsYou = true;
      ended = true;
      break;
    case "done":
      state = "done";
      activity = s.report ? firstLine(s.report.preview) || "Report written" : "Finished";
      ended = true;
      break;
  }

  // The merge check (verify-and-bounce) refines a running or finished task.
  if (v && s.phase !== "failed") {
    if (v.state === "pending") {
      state = "checking";
      activity = "Checking the change (merge gate)…";
      ended = false;
    } else if (v.state === "bounced") {
      state = "retrying";
      activity = v.summary
        ? `Sent back to fix: ${firstLine(v.summary)}`
        : "Sent back to fix what the check found";
      ended = false;
    } else if (v.state === "failed" && s.phase === "done") {
      state = "failed";
      activity = v.summary
        ? `The change failed its check: ${firstLine(v.summary)}`
        : "The change failed its check";
      needsYou = true;
    } else if (v.state === "passed" && s.phase === "done") {
      state = "passed";
    }
  }

  // The foreman stage, when present, is the most specific answer.
  if (foreman?.state && state !== "stopped") {
    const lastFailure = foreman.verdicts?.at(-1)?.failure ?? null;
    switch (foreman.state) {
      case "checking":
        state = "checking";
        activity = "Running the done-check…";
        ended = false;
        break;
      case "retrying":
        state = "retrying";
        activity = lastFailure
          ? `Retrying: ${FAILURE_WORDS[lastFailure] ?? lastFailure}`
          : "Retrying with what went wrong";
        ended = false;
        break;
      case "passed":
        state = "passed";
        ended = true;
        if (foreman.result?.diffStat) activity = foreman.result.diffStat;
        break;
      case "escalated":
        state = "failed";
        needsYou = true;
        ended = true;
        activity = foreman.result?.lastFailure
          ? `Gave up: ${firstLine(foreman.result.lastFailure)}`
          : lastFailure
            ? `Gave up: ${FAILURE_WORDS[lastFailure] ?? lastFailure}`
            : "Gave up after its retries";
        break;
      case "working":
        break;
    }
  }

  // A live question from the worker always wins: it is waiting on a human.
  if (worker.state === "blocked") {
    needsYou = true;
    activity = worker.blocker ? `Asking: ${firstLine(worker.blocker)}` : "Waiting for an answer";
  }

  const attemptTimes = s.attempts.map((a) => a.at).filter((at) => Number.isFinite(at));
  const startedAt = attemptTimes.length > 0 ? Math.min(...attemptTimes) : worker.createdAt;
  const endedAt = ended ? (s.report?.updatedAt ?? worker.lastOutputAt) : null;
  const paneIds = [...s.previousPaneIds, worker.paneId].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return {
    taskId: s.taskId,
    title: worker.title,
    worker,
    paneIds,
    state,
    model: `${s.provider} · ${s.modelLabel}`,
    attempt: Math.max(foreman?.attempt ?? 1, s.attempt, 1),
    maxAttempts: typeof foreman?.maxAttempts === "number" ? foreman.maxAttempts : null,
    activity,
    needsYou,
    startedAt,
    endedAt: endedAt === null ? null : Math.max(endedAt, startedAt),
  };
}

/** The thread's swarm tasks, in the order they were delegated. */
export function deriveSwarmTasks(snapshot: FleetSnapshot | null): SwarmTask[] {
  if (!snapshot) return [];
  const byTask = new Map<string, FleetWorker[]>();
  for (const w of snapshot.workers) {
    if (!w.swarm) continue;
    const list = byTask.get(w.swarm.taskId) ?? [];
    list.push(w);
    byTask.set(w.swarm.taskId, list);
  }
  return [...byTask.values()]
    .map((ws) => deriveSwarmTask(ws))
    .filter((t): t is SwarmTask => t !== null)
    .toSorted((a, b) => a.startedAt - b.startedAt);
}

export function isSwarmTaskSettled(task: SwarmTask): boolean {
  return (
    task.state === "passed" ||
    task.state === "done" ||
    task.state === "failed" ||
    task.state === "stopped"
  );
}

/** `42s`, `3m 05s`, `1h 02m` */
export function formatTaskElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every model the swarm ran on is a free-tier one (the same rule `kora swarm usage` uses). */
function allFree(activity: FleetSwarmActivity): boolean {
  return activity.byModel.every(
    (m) => m.provider === "zen" || m.provider === "cerebras" || /:free$/.test(m.model),
  );
}

const LEAD_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The swarm lead's name for copy ("Claude", "Codex", "OpenCode"): the thread's live driver, else its provider pick. */
export function leadName(
  shell: {
    readonly session?: { readonly providerName?: string | null } | null;
    readonly modelSelection?: { readonly instanceId?: string | null } | null;
  } | null,
): string {
  const id = shell?.session?.providerName ?? shell?.modelSelection?.instanceId ?? "claude";
  return LEAD_NAMES[id] ?? "The lead";
}

/**
 * The thread's value meter: "Claude used 14k new tokens (+300k cached) · workers did 3 tasks (410k tokens, free)".
 * Measured numbers only. Each part is left out when the daemon has not measured it; never estimated.
 * The lead's new-token count excludes the cached context (reads + writes), named beside it.
 */
export function formatSwarmValueMeter(
  activity: FleetSwarmActivity | null,
  lead = "Claude",
): {
  readonly summary: string;
  readonly detail: ReadonlyArray<string>;
} {
  const parts: string[] = [];
  const detail: string[] = [];
  const leader = activity?.leaderTokens;
  if (leader && leader.turns > 0) {
    // The cached context is most of what a lead turn costs (live, 2026-10-02: 970 new tokens vs 89k cached, 23k of
    // them cache WRITES), so the summary names it instead of reading as "<lead> used 970 tokens".
    parts.push(
      `${lead} used ${formatContextWindowTokens(leader.input + leader.output)} new tokens${
        leader.cached > 0 ? ` (+${formatContextWindowTokens(leader.cached)} cached)` : ""
      }`,
    );
    detail.push(
      `${lead}: ${formatContextWindowTokens(leader.input)} in · ${formatContextWindowTokens(leader.output)} out · ${formatContextWindowTokens(leader.cached)} cached context (reads + writes) over ${plural(leader.turns, "turn", "turns")}`,
    );
  }
  const delegated = activity?.delegated ?? 0;
  const workers = activity?.workerTokens;
  const free = activity ? allFree(activity) : true;
  if (workers && workers.tasks > 0) {
    const total = workers.input + workers.cached + workers.output;
    parts.push(
      `workers did ${plural(delegated, "task", "tasks")} (${formatContextWindowTokens(total)} tokens${free ? ", free" : ""})`,
    );
    detail.push(
      `Workers: ${formatContextWindowTokens(workers.input)} in · ${formatContextWindowTokens(workers.output)} out · ${formatContextWindowTokens(workers.cached)} cache reads, measured by OpenCode for ${plural(workers.tasks, "task", "tasks")}`,
    );
  } else {
    parts.push(
      `workers did ${plural(delegated, "task", "tasks")}${free && delegated > 0 ? " (free)" : ""}`,
    );
  }
  return { summary: parts.join(" · "), detail };
}

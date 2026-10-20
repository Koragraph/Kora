// Pure parts of the worker boxes (docs/fleet/WORKER-BOXES.md): the Side-grid layout, the state pill, per-agent
// identity (shape language + brand edge/mark), elapsed time and the strip's "last action". No React, no store.
import type { FleetWorker, WorkerFeedItem } from "@kora/contracts";
import { swarmPhaseChrome } from "~/util/swarm";
import { finishedTone } from "./finishedWorkers";

// ── layout ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Boxes the grid shows at once; the rest become strips (the 2×2 of the spec). */
export const MAX_OPEN_BOXES = 4;

export interface WorkerBoxLayout {
  /** Boxes in the grid, in roster order. */
  readonly open: ReadonlyArray<string>;
  /** Minimized strips stacked under the grid, in roster order. */
  readonly strips: ReadonlyArray<string>;
  readonly columns: 1 | 2;
  readonly rows: number;
  /** 3 boxes in a 2×2: the last one spans both columns so the grid has no hole. */
  readonly spanLast: boolean;
  /** The one box filling the dock (⤢), or null. */
  readonly expanded: string | null;
}

/**
 * Side grid: 1 box = full height, 2 = two rows, 3–4 = 2×2, 5+ = the first four in the 2×2 and the rest as strips.
 * A minimized box is a strip whatever the count. `narrow` (a thin dock) stacks the boxes in one column.
 */
export function workerBoxLayout(input: {
  readonly paneIds: ReadonlyArray<string>;
  readonly minimized: ReadonlySet<string>;
  readonly expanded?: string | null;
  readonly narrow?: boolean;
}): WorkerBoxLayout {
  const { paneIds, minimized } = input;
  if (input.expanded && paneIds.includes(input.expanded)) {
    return {
      open: [input.expanded],
      strips: [],
      columns: 1,
      rows: 1,
      spanLast: false,
      expanded: input.expanded,
    };
  }
  const wanted = paneIds.filter((id) => !minimized.has(id));
  const open = wanted.slice(0, MAX_OPEN_BOXES);
  const openSet = new Set(open);
  const strips = paneIds.filter((id) => !openSet.has(id));
  const columns: 1 | 2 = !input.narrow && open.length >= 3 ? 2 : 1;
  const rows = columns === 2 ? Math.ceil(open.length / 2) : Math.max(1, open.length);
  return {
    open,
    strips,
    columns,
    rows,
    spanLast: columns === 2 && open.length % 2 === 1,
    expanded: null,
  };
}

/**
 * Finished boxes start as strips so the live ones get the room (a done turn too, while another worker still works) — unless there is still something to do with them
 * (a done branch with commits that is not merged yet shows its Merge card).
 */
export function defaultMinimized(
  worker: FleetWorker,
  merged: boolean,
  othersWorking = false,
): boolean {
  // A worker whose turn is done (answer ready, process still up) gives its room to the ones still working —
  // unless its branch still has commits to merge: then it keeps its Merge card in view.
  if (isDoneTurn(worker)) {
    const unmergedCommits = !merged && (worker.worktree?.ahead ?? 0) > 0;
    return othersWorking && !unmergedCommits;
  }
  if (worker.state !== "exited") return false;
  if (worker.stoppedByUser || merged || !worker.worktree) return true;
  if (finishedTone(worker) === "failed") return false;
  return worker.worktree.ahead === 0;
}

/** Live, idle, and its last turn ended normally (the box reads "Done"). */
export function isDoneTurn(worker: FleetWorker): boolean {
  return worker.state === "idle" && worker.turnEndedAt !== undefined && !worker.stoppedOnError;
}

export interface SettledDefault {
  readonly turnEndedAt: number;
  readonly minimized: boolean;
}

/**
 * A done box's default is decided once, when its turn ends, and kept until its next turn ends — so a worker
 * starting or finishing elsewhere never collapses or expands the boxes the human is reading. Workers that are not
 * in a done turn drop out of the map (their default does not depend on the others).
 */
export function settleDoneDefaults(
  previous: ReadonlyMap<string, SettledDefault>,
  workers: ReadonlyArray<FleetWorker>,
  merged: ReadonlySet<string>,
): Map<string, SettledDefault> {
  const othersWorking = workers.some((w) => w.state === "working");
  const next = new Map<string, SettledDefault>();
  for (const w of workers) {
    if (!isDoneTurn(w)) continue;
    const kept = previous.get(w.paneId);
    if (kept && kept.turnEndedAt === w.turnEndedAt) {
      next.set(w.paneId, kept);
      continue;
    }
    next.set(w.paneId, {
      turnEndedAt: w.turnEndedAt!,
      minimized: defaultMinimized(w, merged.has(w.paneId), othersWorking),
    });
  }
  return next;
}

// ── body ───────────────────────────────────────────────────────────────────────────────────────────────────

export type WorkerBodyMode = "history" | "feed" | "terminal";

/**
 * A GUI worker that also runs in a PTY (a swarm OpenCode pane) can show its terminal on demand. A DriverPane worker
 * has a feed only — its `worker:<id>` terminal id has no screen behind it — so it gets no toggle.
 */
export function workerHasTerminalToggle(worker: FleetWorker): boolean {
  return (
    worker.surface === "gui" &&
    !!worker.swarm &&
    worker.state !== "asleep" &&
    worker.terminalId.startsWith("worker:")
  );
}

/**
 * What the box body shows: an asleep worker's history; a GUI worker's feed (or its terminal when the human toggled
 * it and it has one); otherwise the terminal. Derived on every render, so a `surface` flip in the fleet snapshot
 * (pane.updated) swaps a terminal box to its feed live.
 */
export function workerBodyMode(worker: FleetWorker, preferTerminal: boolean): WorkerBodyMode {
  if (worker.state === "asleep") return "history";
  if (worker.surface !== "gui") return "terminal";
  return preferTerminal && workerHasTerminalToggle(worker) ? "terminal" : "feed";
}

// ── state pill ─────────────────────────────────────────────────────────────────────────────────────────────

export type WorkerPillKind =
  | "working"
  | "needs"
  | "retrying"
  | "waiting"
  | "starting"
  | "idle"
  | "done"
  | "failed"
  | "stopped"
  | "asleep";

export interface WorkerPill {
  readonly kind: WorkerPillKind;
  readonly label: string;
}

/** The sub row's pill. Order: stopped › retrying › needs you › asleep › done/failed › swarm phase › working › idle. */
export function workerStatePill(worker: FleetWorker): WorkerPill {
  if (worker.stoppedByUser) return { kind: "stopped", label: "Stopped" };
  if (worker.retrying) {
    return {
      kind: "retrying",
      label: `Retrying ${worker.retrying.attempt}/${worker.retrying.max}`,
    };
  }
  if (worker.state === "blocked" || worker.pendingApproval)
    return { kind: "needs", label: "Needs you" };
  if (worker.state === "asleep") return { kind: "asleep", label: "Asleep" };
  if (worker.state === "exited") {
    if (finishedTone(worker) === "failed") {
      return {
        kind: "failed",
        label:
          typeof worker.exitCode === "number" && worker.exitCode !== 0
            ? `Failed (exit ${worker.exitCode})`
            : "Failed",
      };
    }
    return { kind: "done", label: "Done" };
  }
  if (worker.swarm) {
    const phase = swarmPhaseChrome(worker.swarm.phase);
    if (phase.state === "needs-you") return { kind: "needs", label: "Needs you" };
    if (phase.state === "waiting")
      return { kind: "waiting", label: capitalize(phase.label ?? "waiting") };
    if (phase.state === "exited")
      return { kind: "failed", label: capitalize(phase.label ?? "failed") };
    if (worker.swarm.phase === "starting" && worker.state !== "working") {
      return { kind: "starting", label: "Starting" };
    }
  }
  if (worker.state === "working") return { kind: "working", label: "Working" };
  // Live but idle: why it is idle is what the human needs (an "Idle" that is really "done" read as a stall).
  if (worker.stoppedOnError) return { kind: "failed", label: "Stopped on error" };
  if (worker.turnEndedAt !== undefined) return { kind: "done", label: "Done" };
  return { kind: "idle", label: "Idle" };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

// ── identity ───────────────────────────────────────────────────────────────────────────────────────────────

export type AgentFamily = "claude" | "codex" | "agy" | "swarm" | "acp";

export interface AgentIdentity {
  readonly family: AgentFamily;
  /** Display name in the header ("Claude", "codex", …). */
  readonly name: string;
  readonly radius: number;
  /** Brand colour for the 2px top edge only (the one approved hue exception; the logo is fleet/AgentIcon). */
  readonly brand: string;
}

const NEUTRAL_BRAND = "#8b8d95";

export function agentIdentity(agent: string): AgentIdentity {
  switch (agent) {
    case "claude":
      return {
        family: "claude",
        name: "Claude",
        radius: 18,
        brand: "#d97757",
      };
    case "codex":
      return {
        family: "codex",
        name: "codex",
        radius: 6,
        brand: "#f2f2f4",
      };
    case "antigravity":
    case "agy":
      return {
        family: "agy",
        name: "Antigravity",
        radius: 12,
        brand: "#6ea0ff",
      };
    case "opencode":
      return {
        family: "swarm",
        name: "OpenCode",
        radius: 10,
        brand: "#e3b341",
      };
    case "koragent":
      // Kora's own agent: Stone (no accent).
      return {
        family: "swarm",
        name: "Koragent",
        radius: 10,
        brand: "#d6d3d1",
      };
    case "gemini":
      return {
        family: "acp",
        name: "Gemini",
        radius: 14,
        brand: "#8ab4f8",
      };
    default:
      return {
        family: "acp",
        name: agent.length > 0 ? capitalize(agent) : "Worker",
        radius: 14,
        brand: NEUTRAL_BRAND,
      };
  }
}

// ── time, cost, last action ────────────────────────────────────────────────────────────────────────────────

/** When the clock stops: a finished worker's last output (or the moment it went to sleep); null while live. */
export function elapsedEnd(worker: FleetWorker): number | null {
  if (worker.state === "asleep") return worker.asleep?.sleptAt ?? worker.lastOutputAt;
  if (worker.state === "exited") return worker.lastOutputAt;
  if (worker.state === "idle" && worker.turnEndedAt !== undefined) return worker.turnEndedAt;
  // Stopped on an error: nothing runs, so the clock stops at its last output.
  if (worker.state === "idle" && worker.stoppedOnError) return worker.lastOutputAt;
  return null;
}

/** `42s`, `4m 12s`, `1h 04m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function workerElapsed(worker: FleetWorker, now: number): string {
  return formatElapsed((elapsedEnd(worker) ?? now) - worker.createdAt);
}

/** Seconds until an automatic retry, never negative; null when no retry is scheduled. */
export function retryCountdown(nextAt: number | null | undefined, now: number): number | null {
  if (nextAt === null || nextAt === undefined) return null;
  return Math.max(0, Math.ceil((nextAt - now) / 1000));
}

export function workerCostText(worker: FleetWorker): string | null {
  if (worker.swarm) return "free";
  const v = worker.costUsd;
  if (typeof v !== "number") return null;
  return v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** The strip's muted "last action": the newest feed item that says something, else what the roster knows. */
export function lastActionText(worker: FleetWorker, items: ReadonlyArray<WorkerFeedItem>): string {
  if (worker.pendingApproval) return worker.pendingApproval.title;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    switch (item.kind) {
      case "tool":
        return item.title;
      case "assistant":
      case "notice":
      case "error":
        if (item.text.trim()) return firstLine(item.text);
        break;
      case "approval":
        return item.title;
      case "user":
        break;
    }
  }
  if (worker.blocker) return worker.blocker;
  if (worker.swarm?.step) return worker.swarm.step.text;
  if (worker.asleep?.finalReport) return firstLine(worker.asleep.finalReport);
  return "";
}

/**
 * The sprite window's title line after the logo: what the worker is doing, in a few words. Working: its latest step.
 * Otherwise the state first ("Needs you", "Done", "Stopped on error" …), then the step or reason. Amber only when it
 * needs the human, red only when it failed or stopped — the model never appears here.
 */
export function workerDoingLine(
  worker: FleetWorker,
  items: ReadonlyArray<WorkerFeedItem>,
): { readonly text: string; readonly tone: "attn" | "bad" | null } {
  const pill = workerStatePill(worker);
  const last = lastActionText(worker, items);
  const join = (head: string, tail: string | null | undefined) =>
    tail ? `${head} · ${tail}` : head;
  switch (pill.kind) {
    case "working":
      return { text: last || "Working", tone: null };
    case "needs":
      return { text: join(pill.label, last || worker.blocker), tone: "attn" };
    case "retrying":
      return { text: join(pill.label, worker.retrying?.message), tone: null };
    case "failed":
    case "stopped":
      return { text: join(pill.label, worker.stoppedOnError), tone: "bad" };
    default:
      return { text: join(pill.label, last), tone: null };
  }
}

/** Short name for a `kora/…` worktree branch. */
export function shortBranch(branch: string): string {
  return branch.replace(/^kora\//, "");
}

// ── window chrome (docs/fleet/worker-panes-v2-mock.html, approved "A · Grid of windows") ─────────────────────

export type LightAct = "stop" | "minimize" | "zoom";
export type PaneVariant = "box" | "window";

export interface TrafficLight {
  readonly act: LightAct;
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
}

/**
 * The pane's three macOS lights, the same in the grid and in the sprite's window: red stops the worker (two clicks,
 * branch kept), yellow tucks the pane away (the grid's shelf / back into its sprite), green zooms (fills the dock /
 * maximizes the window). Red is dead once nothing runs.
 */
export function trafficLights(
  worker: FleetWorker,
  opts: { readonly variant: PaneVariant; readonly zoomed: boolean; readonly stopArmed: boolean },
): ReadonlyArray<TrafficLight> {
  const live = worker.state !== "exited" && worker.state !== "asleep";
  const win = opts.variant === "window";
  return [
    {
      act: "stop",
      label: "Stop worker",
      hint: !live
        ? "Not running"
        : opts.stopArmed
          ? "Click again to stop this worker"
          : "Stop this worker (its branch is kept)",
      disabled: !live,
    },
    {
      act: "minimize",
      label: win ? "Minimize worker window" : "Minimize",
      hint: win ? "Back into its sprite (Esc)" : "Minimize to the shelf",
      disabled: false,
    },
    {
      act: "zoom",
      label: win
        ? opts.zoomed
          ? "Restore worker window"
          : "Maximize worker window"
        : opts.zoomed
          ? "Back to the grid"
          : "Expand",
      hint: win
        ? opts.zoomed
          ? "Restore"
          : "Maximize"
        : opts.zoomed
          ? "Back to the grid (Esc)"
          : "Fill the dock",
      disabled: false,
    },
  ];
}

/** The title bar's second line: `Claude · claude-sonnet-5-5 · @work`. */
export function workerSubline(worker: FleetWorker, model: string | null): string {
  return [agentIdentity(worker.agent).name, model, worker.account ? `@${worker.account}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** A tool that runs a shell command: Codex shows these as `$ command` blocks, like its own CLI. */
export function isExecTool(tool: string): boolean {
  return /^(bash|shell|exec|command|run|terminal|local_shell|exec_command)/i.test(tool.trim());
}

type ApprovalItem = Extract<WorkerFeedItem, { kind: "approval" }>;

/**
 * Open approvals leave the scrolling feed and sit pinned above the steer box, so Allow / Deny can never scroll away
 * or be clipped by a short pane. Answered ones stay in the feed where they happened. `pending` (the roster's own
 * copy) is pinned when the feed has not caught up with it yet.
 */
export function splitPinnedApprovals(
  items: ReadonlyArray<WorkerFeedItem>,
  pending: { readonly requestId: string; readonly title: string } | null | undefined,
): {
  readonly feed: ReadonlyArray<WorkerFeedItem>;
  readonly pinned: ReadonlyArray<Pick<ApprovalItem, "requestId" | "title" | "detail">>;
} {
  const pinned: Array<Pick<ApprovalItem, "requestId" | "title" | "detail">> = [];
  const feed: WorkerFeedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind === "approval") seen.add(item.requestId);
    if (item.kind === "approval" && item.status === "open") {
      pinned.push({ requestId: item.requestId, title: item.title, detail: item.detail });
    } else feed.push(item);
  }
  // A later "accepted" copy of the same request closes it (the feed upserts by id; tolerate both orders).
  const closed = new Set(
    items
      .filter((i) => i.kind === "approval" && i.status !== "open")
      .map((i) => (i as ApprovalItem).requestId),
  );
  const open = pinned.filter((p) => !closed.has(p.requestId));
  if (pending && !seen.has(pending.requestId)) {
    open.push({ requestId: pending.requestId, title: pending.title, detail: null });
  }
  return { feed, pinned: open };
}

export type WindowTab = "activity" | "terminal" | "report" | "transcript";

/** The sprite window's tabs: Activity always; Terminal only where a real PTY sits behind the worker. */
export function workerWindowTabs(worker: FleetWorker): ReadonlyArray<WindowTab> {
  const tabs: WindowTab[] = ["activity"];
  if (workerHasTerminalToggle(worker)) tabs.push("terminal");
  if (worker.swarm?.report) tabs.push("report");
  if (worker.recordId && worker.state !== "asleep") tabs.push("transcript");
  return tabs;
}

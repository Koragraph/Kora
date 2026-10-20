/**
 * Fleet right-panel surface: an ORCHESTRATOR thread's workers as worker boxes (docs/fleet/WORKER-BOXES.md).
 *
 * Each worker is a GUI box in the Side grid (fleet/WorkerBoxGrid): its chat-like feed when the runtime drives it
 * (`surface: "gui"`), otherwise its live terminal inside the same chrome. Steering from a box is tagged as the
 * human and the orchestrator is told out of band. Around the grid this panel keeps the fleet-level parts: the
 * roster summary, the graph merge gate (Verify / Merge clean + verdict), the swarm task view and the event feed.
 */

import { cn } from "~/util/utils";
import { swarmPhaseChrome } from "~/util/swarm";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { TooltipTrigger, TooltipPopup, Tooltip } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { useAtomAction } from "~/atoms/use-atom-command";
import { useHostQuery } from "~/atoms/query";
import { fleetHost } from "~/atoms/fleet";
import { useThreadSummary } from "~/atoms/entities";
import { deriveSwarmTasks, leadName } from "./swarm/swarmTasks";
import { SwarmTaskDetail, SwarmTaskList } from "./swarm/SwarmTaskList";
import { formatReportBytes } from "./swarm/SwarmReportView";
import type { PaneChromeState } from "./fleet/PaneChrome";
import { WorkerBoxGrid } from "./fleet/WorkerBoxGrid";
import type { WorkerStanding } from "./fleet/WorkerBox";
import {
  mergeFailureOf,
  mergeCleanBlocked,
  mergeCleanNote,
  mergeCleanPlan,
  paneDisplayName,
  type MergeCleanPlan,
} from "./fleet/mergePlan.logic";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearance/appearanceFonts";
import { type HostThreadRef, type FleetSnapshot, type FleetWorker } from "@kora/contracts";
import { useCallback, useEffect, useState, useMemo, useRef, memo } from "react";
import {
  ChevronRightIcon,
  LoaderCircleIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  WaypointsIcon,
  GitMergeIcon,
  XIcon,
  CheckIcon,
} from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";

/** Worker state → the pane chrome's state word. */
const CHROME_STATE: Record<FleetWorker["state"], PaneChromeState> = {
  working: "running",
  idle: "idle",
  blocked: "needs-you",
  exited: "exited",
  unknown: "idle",
  asleep: "idle",
};

interface FleetPanelProps {
  threadRef: HostThreadRef;
  visible: boolean;
  /** Code surface: swap this pane grid back for the blob dock. Omitted hides the button. */
  onBlobMode?: () => void;
}

export function useFleetSnapshot(threadRef: HostThreadRef | null): FleetSnapshot | null {
  const query = useHostQuery(
    threadRef === null
      ? null
      : fleetHost.snapshot({
          hostId: threadRef.hostId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return query.data?.snapshot ?? null;
}

/** Workers the human would want to glance at: working or waiting on a human. */
export function liveWorkerCount(snapshot: FleetSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.workers.filter((w) => w.state === "working" || w.state === "blocked").length;
}

function formatUsd(v: number | null): string | null {
  if (v === null) return null;
  return v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`;
}

function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How a worker tile reads: chrome state + word, the cost cell, the swarm verify cell, the report button. */
export interface WorkerTileInfo {
  readonly chromeState: PaneChromeState;
  readonly stateLabel: string | null;
  /** `$0.12` for a paid agent; "free tier" for a swarm worker (never a dollar figure); null when unknown. */
  readonly costText: string | null;
  readonly verifyText: string | null;
  readonly verifyTone: "ok" | "warn" | "bad" | "muted" | null;
  /** "Report · 2.1 KB" when a swarm worker has written its report. */
  readonly reportLabel: string | null;
}

export function workerTileInfo(worker: FleetWorker): WorkerTileInfo {
  const base = CHROME_STATE[worker.state];
  const swarm = worker.swarm;
  if (!swarm) {
    return {
      chromeState: base,
      stateLabel: null,
      costText: formatUsd(worker.costUsd),
      verifyText: null,
      verifyTone: null,
      reportLabel: null,
    };
  }
  const phase = swarmPhaseChrome(swarm.phase);
  // A live dialog (blocked) or an exit always wins over a phase that would otherwise mask it.
  const forced = worker.state === "blocked" || worker.state === "exited" ? null : phase.state;
  const starting =
    swarm.phase === "starting" && (worker.state === "unknown" || worker.state === "idle");
  let verifyText: string | null = null;
  let verifyTone: WorkerTileInfo["verifyTone"] = null;
  const v = swarm.verify;
  if (v) {
    switch (v.state) {
      case "passed":
        verifyText =
          v.bounces > 0 ? `verified · ${plural(v.bounces, "bounce", "bounces")}` : "verified";
        verifyTone = "ok";
        break;
      case "bounced":
        verifyText = `bounced ${v.bounces}`;
        verifyTone = "warn";
        break;
      case "failed":
        verifyText =
          v.bounces > 0
            ? `verify failed · ${plural(v.bounces, "bounce", "bounces")}`
            : "verify failed";
        verifyTone = "bad";
        break;
      case "pending":
        verifyText = "verifying…";
        verifyTone = "muted";
        break;
      case "skipped":
        break;
    }
  }
  return {
    chromeState: forced ?? base,
    stateLabel: forced !== null ? phase.label : starting ? phase.label : null,
    costText: "free tier",
    verifyText,
    verifyTone,
    reportLabel: swarm.report ? `Report · ${formatReportBytes(swarm.report.bytes)}` : null,
  };
}

/** Header roster line; swarm fleets add the rate-limited count. */
export function fleetHeaderSummary(workers: ReadonlyArray<FleetWorker>): string {
  if (workers.length === 0) return "no workers yet";
  const live = workers.filter((w) => w.state !== "exited").length;
  const working = workers.filter((w) => w.state === "working").length;
  const blocked = workers.filter((w) => w.state === "blocked").length;
  const limited = workers.filter((w) => w.swarm?.phase === "rate-limited").length;
  return `${live} live · ${working} working · ${blocked} need you${limited > 0 ? ` · ${limited} rate-limited` : ""}`;
}

type Verdict = NonNullable<FleetSnapshot["lastVerdict"]>;
type VerdictPair = Verdict["pairs"][number];

/** A worker's standing in the last verdict: which pairs it sits in, and the worst status among them. */
function standingOf(
  verdict: Verdict | null,
  paneId: string,
): { status: "clean" | "semantic" | "needs-human"; with: string[]; pairs: VerdictPair[] } | null {
  if (!verdict) return null;
  const pairs = verdict.pairs.filter((p) => p.a === paneId || p.b === paneId);
  if (pairs.length === 0) return null;
  const bad = pairs.filter((p) => p.status !== "clean");
  const status = bad.some((p) => p.status === "semantic")
    ? "semantic"
    : bad.length > 0
      ? "needs-human"
      : "clean";
  return {
    status,
    with: bad.map((p) => (p.a === paneId ? p.b : p.a)),
    pairs,
  };
}

/** What "Merge clean" would merge now, given the verdict (null: none yet, so nothing is flagged). */
function mergeCleanPlanOf(snapshot: FleetSnapshot | null, verdict: Verdict | null): MergeCleanPlan {
  const flagged = new Set<string>();
  for (const p of verdict?.pairs ?? [])
    if (p.status !== "clean") (flagged.add(p.a), flagged.add(p.b));
  return mergeCleanPlan({
    workers: snapshot?.workers ?? [],
    merged: mergedPaneIds(snapshot),
    flagged,
    order: verdict?.order ?? [],
  });
}

/** Pane ids merged into the main checkout: the worker's durable flag, or the activity feed (older runtimes). */
export function mergedPaneIds(snapshot: FleetSnapshot | null): Set<string> {
  const out = new Set<string>();
  for (const w of snapshot?.workers ?? []) if (w.branchMerged) out.add(w.paneId);
  for (const e of snapshot?.events ?? []) {
    if (e.kind === "merged" && e.workerId && /^\S+: merged\b/.test(e.text)) out.add(e.workerId);
  }
  return out;
}

/** True when something happened after the verdict was computed: a merge, or a worker producing output. */
function verdictIsStale(snapshot: FleetSnapshot | null): boolean {
  const v = snapshot?.lastVerdict;
  if (!snapshot || !v) return false;
  const at = Date.parse(v.verifiedAt);
  if (!Number.isFinite(at)) return false;
  const merged = mergedPaneIds(snapshot);
  const pending = snapshot.workers.filter((w) => w.worktree && !merged.has(w.paneId));
  if (pending.length < 2) return false; // nothing left to cross-check — a re-verify would say nothing new
  if (snapshot.events.some((e) => e.kind === "merged" && e.at > at)) return true;
  return pending.some((w) => w.lastOutputAt > at + 1500);
}

const AUTO_VERIFY_SETTLE_MS = 20_000;

export const FleetPanel = memo(function FleetPanel({
  threadRef,
  visible,
  onBlobMode,
}: FleetPanelProps) {
  const snapshot = useFleetSnapshot(threadRef);
  const threadShell = useThreadSummary(threadRef);
  const swarmMode = threadShell?.agentMode === "swarm" || snapshot?.swarm !== undefined;
  const typographyStorage = useLocalStorage(TYPOGRAPHY_ADVANCED_STORAGE_KEY, false, Schema.Boolean);
  const advancedTypography = typographyStorage[0];
  const runMergeVerify = useAtomAction(fleetHost.mergeVerify, { reportFailure: true });
  const runMerge = useAtomAction(fleetHost.merge, { reportFailure: true });
  const runKill = useAtomAction(fleetHost.kill, { reportFailure: true });
  const runSteer = useAtomAction(fleetHost.steer, { reportFailure: true });

  // Swarm threads open on the task list (one calm row per task); the worker boxes are one click away.
  const [swarmView, setSwarmView] = useState<"tasks" | "workers">("tasks");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // "Open terminal" from the task view: fill the dock with that worker's box.
  const [focusPane, setFocusPane] = useState<{ paneId: string; epoch: number } | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [mergingAll, setMergingAll] = useState<string | null>(null); // progress label while "Merge clean" runs
  // Why "Merge clean" stopped (a conflict, a dirty main checkout), shown until the next run.
  const [mergeCleanError, setMergeCleanError] = useState<{
    text: string;
    conflicts: ReadonlyArray<string>;
  } | null>(null);
  const autoVerifiedFor = useRef<string>("");

  const workers = snapshot?.workers ?? [];

  const verify = useCallback(async (): Promise<Verdict | null> => {
    setVerifying(true);
    try {
      const r = await runMergeVerify({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId },
      });
      return AsyncResult.isSuccess(r) ? (r.value as Verdict) : null;
    } finally {
      setVerifying(false);
    }
  }, [runMergeVerify, threadRef.hostId, threadRef.threadId]);

  const mergeOne = useCallback(
    (paneId: string) =>
      runMerge({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, paneId },
      }),
    [runMerge, threadRef.hostId, threadRef.threadId],
  );
  const merge = useCallback((paneId: string) => void mergeOne(paneId), [mergeOne]);

  /**
   * The no-brainer button: (re)verify if the verdict is missing or stale, then merge every worker
   * that is not in a flagged pair, in the suggested order. Flagged workers are left for the human.
   */
  const mergeClean = useCallback(async () => {
    if (mergingAll) return;
    setMergingAll("Verifying…");
    setMergeCleanError(null);
    try {
      let verdict = snapshot?.lastVerdict ?? null;
      if (!verdict || verdictIsStale(snapshot)) verdict = await verify();
      if (!verdict) return;
      // Working, blocked and empty workers are left out: merging them would commit a half-finished tree.
      const { ordered } = mergeCleanPlanOf(snapshot, verdict);
      let i = 0;
      for (const paneId of ordered) {
        i += 1;
        setMergingAll(`Merging ${i}/${ordered.length}…`);
        const r = await mergeOne(paneId);
        // a git-level conflict, a dirty main checkout, or an RPC failure: stop here and say why
        const failure = mergeFailureOf(r);
        if (failure) {
          const who = paneDisplayName(snapshot?.workers ?? [], paneId);
          setMergeCleanError({ text: `${who}: ${failure.text}`, conflicts: failure.conflicts });
          break;
        }
      }
    } finally {
      setMergingAll(null);
    }
  }, [mergeOne, mergingAll, snapshot, verify]);
  const kill = useCallback(
    (paneId: string) => {
      void runKill({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, paneId },
      });
    },
    [runKill, threadRef.hostId, threadRef.threadId],
  );
  const steer = useCallback(
    (paneId: string, text: string) =>
      runSteer({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, paneId, text, submit: true },
      }),
    [runSteer, threadRef.hostId, threadRef.threadId],
  );

  const verdict = snapshot?.lastVerdict ?? null;
  const conflicting = verdict ? verdict.pairs.filter((p) => p.status !== "clean") : [];
  const semanticPairs = conflicting.filter((p) => p.status === "semantic").length;
  const stale = verdictIsStale(snapshot);
  const merged = useMemo(() => mergedPaneIds(snapshot), [snapshot]);
  const standing = useCallback(
    (paneId: string): WorkerStanding | null => {
      const s = standingOf(verdict, paneId);
      return s
        ? { status: s.status, with: s.with.map((id) => paneDisplayName(workers, id)) }
        : null;
    },
    [verdict, workers],
  );
  const name = useCallback((paneId: string) => paneDisplayName(workers, paneId), [workers]);
  const cleanPlan = mergeCleanPlanOf(snapshot, verdict && !stale ? verdict : null);
  const cleanNote = mergeCleanNote(cleanPlan);
  const worktreeWorkers = workers.filter((w) => w.worktree);
  const unmerged = worktreeWorkers.filter((w) => !merged.has(w.paneId));
  const allSettled =
    worktreeWorkers.length >= 2 &&
    worktreeWorkers.every((w) => w.state === "idle" || w.state === "exited");
  // Auto-verify: once every worktree worker has settled and the verdict is missing or stale, run the
  // gate after a quiet period — so the verdict is already there when the human looks. One run per settle.
  useEffect(() => {
    if (!visible || verifying || mergingAll || !allSettled || unmerged.length < 2) return;
    if (verdict && !stale) return;
    const signature = worktreeWorkers.map((w) => `${w.paneId}@${w.lastOutputAt}`).join(",");
    if (autoVerifiedFor.current === signature) return;
    const t = window.setTimeout(() => {
      autoVerifiedFor.current = signature;
      void verify();
    }, AUTO_VERIFY_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [
    visible,
    verifying,
    mergingAll,
    allSettled,
    unmerged.length,
    verdict,
    stale,
    worktreeWorkers,
    verify,
  ]);
  const tasks = useMemo(() => (swarmMode ? deriveSwarmTasks(snapshot) : []), [snapshot, swarmMode]);
  const openTask = openTaskId ? (tasks.find((t) => t.taskId === openTaskId) ?? null) : null;
  const showTasks = swarmMode && swarmView === "tasks" && tasks.length > 0;
  const openTerminal = useCallback((paneId: string) => {
    setSwarmView("workers");
    setFocusPane((prev) => ({ paneId, epoch: (prev?.epoch ?? 0) + 1 }));
  }, []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [visible]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* ── header: roster summary + merge gate ── */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {onBlobMode ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1.5"
            onClick={onBlobMode}
            aria-label="Close workers panel"
          >
            <XIcon className="size-3.5" aria-hidden />
            Close
          </Button>
        ) : null}
        {swarmMode && tasks.length > 0 ? (
          <div
            role="radiogroup"
            aria-label="Swarm view"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 p-px"
          >
            {(["tasks", "workers"] as const).map((view) => (
              <Button
                key={view}
                size="xs"
                variant={swarmView === view ? "secondary" : "ghost"}
                role="radio"
                aria-checked={swarmView === view}
                className="h-5 px-1.5"
                onClick={() => setSwarmView(view)}
              >
                {view === "tasks" ? "Tasks" : "Workers"}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {fleetHeaderSummary(workers)}
        </div>
        {worktreeWorkers.length > 0 ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    className="gap-1.5"
                    disabled={verifying || !!mergingAll || unmerged.length < 2}
                    onClick={() => void verify()}
                  />
                }
              >
                {verifying ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <WaypointsIcon className="size-3.5" aria-hidden />
                )}
                {verdict ? "Re-verify" : "Verify"}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Checks the workers' changes against each other with the code graph (catching
                conflicts git would miss) and works out a safe order to merge them. Runs by itself
                once every worker is done.
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    className="gap-1.5"
                    disabled={
                      verifying ||
                      !!mergingAll ||
                      unmerged.length === 0 ||
                      mergeCleanBlocked(cleanPlan)
                    }
                    onClick={() => void mergeClean()}
                  />
                }
              >
                {mergingAll ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <GitMergeIcon className="size-3.5" aria-hidden />
                )}
                {mergingAll ??
                  (unmerged.length === 0 && worktreeWorkers.length > 0
                    ? "All merged"
                    : cleanNote !== null
                      ? cleanNote
                      : unmerged.length === 1
                        ? "Merge"
                        : `Merge clean${verdict && !stale ? ` (${cleanPlan.ordered.length})` : ""}`)}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Checks first if needed, then merges every finished worker's changes that passed into
                your project, in a safe order. Workers still working and anything flagged are left
                for you.
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
      </div>

      {/* ── verdict strip: the gate's answer, expandable to every pair and its blame ── */}
      {verdict ? (
        <div
          className={cn(
            "shrink-0 border-b border-border/60 text-xs",
            conflicting.length > 0 ? "text-warning" : "text-success",
          )}
        >
          <button
            type="button"
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left"
            onClick={() => setVerdictOpen((o) => !o)}
            aria-expanded={verdictOpen}
          >
            {conflicting.length > 0 ? (
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            ) : (
              <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              {verdict.pairs.length === 0
                ? "Merge verified — nothing to cross-check."
                : semanticPairs > 0
                  ? `${semanticPairs} semantic conflict${semanticPairs === 1 ? "" : "s"} git would merge clean${conflicting.length > semanticPairs ? ` · ${conflicting.length - semanticPairs} to look at` : ""}`
                  : conflicting.length > 0
                    ? `${conflicting.length} pair${conflicting.length === 1 ? "" : "s"} need a look — the graph could not rule out a hidden edge`
                    : `All ${verdict.pairs.length} pair${verdict.pairs.length === 1 ? "" : "s"} clean — safe to merge.`}
              {verdict.order.length > 1 ? (
                <span className="ms-1 text-muted-foreground">
                  order {verdict.order.map(name).join(" → ")}
                </span>
              ) : null}
              {stale ? (
                <span className="ms-1 text-muted-foreground">· changed since — re-verify</span>
              ) : null}
            </span>
            {verdict.pairs.length > 0 ? (
              verdictOpen ? (
                <ChevronDownIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <ChevronRightIcon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )
            ) : null}
          </button>
          {verdictOpen && verdict.pairs.length > 0 ? (
            <ScrollArea className="max-h-48">
              <ul className="px-3 pb-2 text-[11.5px] leading-snug">
                {verdict.pairs.map((p) => (
                  <li key={`${p.a}-${p.b}`} className="py-1">
                    <div
                      className={cn(
                        "flex items-center gap-1.5 font-medium",
                        p.status === "semantic"
                          ? "text-warning"
                          : p.status === "needs-human"
                            ? "text-muted-foreground"
                            : "text-success",
                      )}
                    >
                      {p.status === "semantic" ? (
                        <CircleAlertIcon className="size-3 shrink-0" aria-hidden />
                      ) : p.status === "needs-human" ? (
                        <CircleHelpIcon className="size-3 shrink-0" aria-hidden />
                      ) : (
                        <CheckIcon className="size-3 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 truncate">
                        {name(p.a)} × {name(p.b)}
                      </span>
                      <span className="font-normal">
                        {p.status === "semantic"
                          ? "semantic conflict"
                          : p.status === "needs-human"
                            ? "needs a look"
                            : "clean"}
                      </span>
                    </div>
                    {p.reason ? (
                      <div className="ps-4.5 pt-0.5 text-muted-foreground">{p.reason}</div>
                    ) : null}
                    {p.blame && p.blame.length > 0 ? (
                      <ul className="ps-4.5 pt-0.5 font-mono text-[11px] text-muted-foreground">
                        {p.blame.slice(0, 8).map((b, i) => (
                          <li key={`${b.file}:${b.line}:${b.symbol}:${i}`} className="truncate">
                            {b.file}:{b.line} <span className="text-foreground">{b.symbol}</span>{" "}
                            <span className="font-sans">
                              {b.removed ? "removed" : "changed"} by {name(b.byWorker)}
                              {b.kind === "reference" ? " · new reference" : ""}
                              {b.inHunk ? " · edited line" : ""}
                              {b.compatible ? " · call matches new signature" : ""}
                            </span>
                          </li>
                        ))}
                        {p.blame.length > 8 ? (
                          <li className="font-sans">… {p.blame.length - 8} more</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}

      {mergeCleanError ? (
        <div
          role="alert"
          className="shrink-0 border-b border-border/60 px-3 py-1.5 text-xs text-destructive"
          data-merge-clean-error=""
        >
          <div className="flex items-start gap-2">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Merge stopped. {mergeCleanError.text}</span>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setMergeCleanError(null)}
            >
              Dismiss
            </button>
          </div>
          {mergeCleanError.conflicts.length > 0 ? (
            <ul className="ps-5 pt-0.5 font-mono text-[11px]">
              {mergeCleanError.conflicts.slice(0, 8).map((f) => (
                <li key={f} className="truncate">
                  {f}
                </li>
              ))}
              {mergeCleanError.conflicts.length > 8 ? (
                <li className="font-sans">… {mergeCleanError.conflicts.length - 8} more</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ── worker boxes ── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {workers.length === 0 ? (
          <EmptyFleet swarm={swarmMode} />
        ) : showTasks && openTask ? (
          <SwarmTaskDetail
            task={openTask}
            threadRef={threadRef}
            merged={merged.has(openTask.worker.paneId)}
            onBack={() => setOpenTaskId(null)}
            onMerge={() => merge(openTask.worker.paneId)}
            onDiscard={() => kill(openTask.worker.paneId)}
            onOpenTerminal={() => openTerminal(openTask.worker.paneId)}
          />
        ) : showTasks ? (
          <SwarmTaskList
            tasks={tasks}
            activity={snapshot?.swarm ?? null}
            lead={leadName(threadShell)}
            merged={merged}
            onOpen={setOpenTaskId}
          />
        ) : (
          <WorkerBoxGrid
            threadRef={threadRef}
            workers={workers}
            visible={visible}
            advancedTypography={advancedTypography}
            merged={merged}
            standing={standing}
            focusPaneId={focusPane?.paneId ?? null}
            focusEpoch={focusPane?.epoch ?? 0}
            onKill={kill}
            onMerge={mergeOne}
            onSteer={steer}
          />
        )}
      </div>

      {/* ── events feed ── */}
      {snapshot && snapshot.events.length > 0 ? (
        <div className="shrink-0 border-t border-border/60">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-secondary-label hover:text-foreground"
            onClick={() => setEventsOpen((o) => !o)}
            aria-expanded={eventsOpen}
          >
            {eventsOpen ? (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            ) : (
              <ChevronRightIcon className="size-3.5" aria-hidden />
            )}
            Activity
            <span className="ms-auto truncate font-normal text-muted-foreground">
              {snapshot.events[0]?.text}
            </span>
          </button>
          {eventsOpen ? (
            <ScrollArea className="max-h-36">
              <ul className="px-3 pb-2 text-[11.5px] leading-snug">
                {snapshot.events.slice(0, 30).map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex gap-2 py-0.5">
                    <span className="w-8 shrink-0 tabular-nums text-muted-foreground/70">
                      {relativeTime(event.at, now)}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        event.kind === "blocked"
                          ? "text-destructive"
                          : event.kind === "human-steered"
                            ? "text-warning"
                            : event.kind === "worker-done" || event.kind === "merged"
                              ? "text-success"
                              : "text-muted-foreground",
                      )}
                    >
                      {event.text}
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export function EmptyFleet({ swarm = false }: { swarm?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <WaypointsIcon className="size-6 text-muted-foreground/60" aria-hidden />
      <p className="text-sm font-medium">No workers yet</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        {swarm
          ? "With Stretch on, your agent hands self-contained tasks to workers: free models first, then cheap Haiku or GPT Luna. Each one shows up here as a box you can watch and steer; its report goes back to the agent."
          : "When your agent hands part of a task to a worker agent (you approve each one), it shows up here as a box you can watch and steer."}
      </p>
    </div>
  );
}

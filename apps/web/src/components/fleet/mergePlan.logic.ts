// Pure parts of the fleet merge flow: what is ready to merge, what "Merge clean" will do, and how a worker is named
// to the human (task titles, never pane ids). No React, no store.
import type { FleetMergeResult, FleetWorker } from "@kora/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { agentIdentity } from "./workerBoxes.logic";

/**
 * True when the worker's worktree holds something to merge: commits ahead or uncommitted files. When the roster
 * does not know either count (older runtimes), assume there may be.
 */
export function hasSomethingToMerge(worker: FleetWorker): boolean {
  const tree = worker.worktree;
  if (!tree) return false;
  const ahead = tree.ahead ?? worker.asleep?.ahead;
  if (ahead === undefined && tree.dirty === undefined) return true;
  return (ahead ?? 0) > 0 || (tree.dirty ?? 0) > 0;
}

/** Still producing changes, or waiting on the human: merging now would commit a half-finished tree. */
export function isStillWorking(worker: FleetWorker): boolean {
  return worker.state === "working" || worker.state === "blocked" || !!worker.pendingApproval;
}

export interface MergeCleanPlan {
  /** Pane ids to merge, in the verdict's order first. */
  readonly ordered: ReadonlyArray<string>;
  /** Unmerged worktree workers left out because they are still working or need the human. */
  readonly stillWorking: number;
  /** Unmerged worktree workers left out because the graph flagged them. */
  readonly flagged: number;
}

/** What "Merge clean" merges: unmerged, settled, unflagged workers that have something to merge. */
export function mergeCleanPlan(input: {
  readonly workers: ReadonlyArray<FleetWorker>;
  readonly merged: ReadonlySet<string>;
  readonly flagged: ReadonlySet<string>;
  readonly order: ReadonlyArray<string>;
}): MergeCleanPlan {
  let stillWorking = 0;
  let flagged = 0;
  const eligible: string[] = [];
  for (const w of input.workers) {
    if (!w.worktree || input.merged.has(w.paneId) || !hasSomethingToMerge(w)) continue;
    if (isStillWorking(w)) stillWorking += 1;
    else if (input.flagged.has(w.paneId)) flagged += 1;
    else eligible.push(w.paneId);
  }
  const ordered = [
    ...input.order.filter((id) => eligible.includes(id)),
    ...eligible.filter((id) => !input.order.includes(id)),
  ];
  return { ordered, stillWorking, flagged };
}

/** "2 still working, merging 3", "2 flagged" when nothing is left to merge — or null when nothing is held back. */
export function mergeCleanNote(plan: MergeCleanPlan): string | null {
  const flagged = plan.ordered.length === 0 && plan.flagged > 0 ? `${plan.flagged} flagged` : null;
  if (plan.stillWorking === 0) return flagged;
  const waiting = `${plan.stillWorking} still working`;
  if (plan.ordered.length > 0) return `${waiting}, merging ${plan.ordered.length}`;
  return flagged ? `${waiting}, ${flagged}` : waiting;
}

/** Nothing "Merge clean" may merge: every unmerged worker is still working or flagged by the graph. */
export function mergeCleanBlocked(plan: MergeCleanPlan): boolean {
  return plan.ordered.length === 0 && plan.stillWorking + plan.flagged > 0;
}

/** `Claude · Add auth tests` (the agent alone when the title just repeats it). */
export function workerDisplayName(worker: FleetWorker): string {
  const agent = agentIdentity(worker.agent).name;
  const title = worker.title.trim();
  if (!title || title.toLowerCase() === worker.agent.toLowerCase()) return agent;
  return `${agent} · ${title}`;
}

/** Resolves a pane id to the worker's display name; an unknown id stays as it is. */
export function paneDisplayName(workers: ReadonlyArray<FleetWorker>, paneId: string): string {
  const worker = workers.find((w) => w.paneId === paneId);
  return worker ? workerDisplayName(worker) : paneId;
}

/** The red line a failed merge leaves on its card / in the header. */
export function mergeFailureText(result: Pick<FleetMergeResult, "message" | "conflicts">): string {
  const message = result.message.trim() || "The merge did not go through.";
  return result.conflicts.length > 0
    ? `${message} Conflicts in ${result.conflicts.length === 1 ? "1 file" : `${result.conflicts.length} files`}.`
    : message;
}

/** A merge that did not go through: why, and the files git stopped on. */
export interface MergeFailure {
  readonly text: string;
  readonly conflicts: ReadonlyArray<string>;
}

/** Reads a `fleet.merge` command result; null when it merged (or nothing is known). */
export function mergeFailureOf(result: unknown): MergeFailure | null {
  if (!AsyncResult.isAsyncResult(result)) return null;
  if (AsyncResult.isFailure(result)) {
    return { text: "The merge request failed. Kora's service may be down.", conflicts: [] };
  }
  if (!AsyncResult.isSuccess(result)) return null;
  const value = result.value as { ok?: boolean; message?: string; conflicts?: string[] } | null;
  if (!value || value.ok !== false) return null;
  const conflicts = value.conflicts ?? [];
  return { text: mergeFailureText({ message: value.message ?? "", conflicts }), conflicts };
}

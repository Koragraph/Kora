/** The agent's to-do list (its latest `turn.plan.updated`) and the plan it proposed for approval. */
import type { ChatThreadActivity, TurnId } from "@kora/contracts";

import type { PlanProposal } from "../../types";
import { byActivityOrder } from "./order";
import { fields } from "./read";

type StepStatus = "pending" | "inProgress" | "completed";

export interface ActivePlanState {
  /** `durationMs` is set on completed steps whose start and finish the activity stream shows. */
  steps: Array<{ step: string; status: StepStatus; durationMs?: number }>;
  explanation?: string | null;
  turnId: TurnId | null;
  createdAt: string;
}

/** The fields of a proposal the plan card needs. */
export type LatestPlanProposalState = Pick<
  PlanProposal,
  | "id"
  | "turnId"
  | "planMarkdown"
  | "createdAt"
  | "updatedAt"
  | "implementedAt"
  | "implementationThreadId"
>;

/** The plan one activity carries; null when it carries none (an empty list clears the plan). */
function planOf(activity: ChatThreadActivity): ActivePlanState | null {
  const payload = fields(activity.payload);
  if (!Array.isArray(payload?.plan)) return null;
  const steps: ActivePlanState["steps"] = [];
  for (const raw of payload.plan) {
    const item = fields(raw);
    if (typeof item?.step !== "string") continue;
    const status: StepStatus =
      item.status === "completed" || item.status === "inProgress" ? item.status : "pending";
    steps.push({ step: item.step, status });
  }
  if (steps.length === 0) return null;
  const plan: ActivePlanState = { createdAt: activity.createdAt, turnId: activity.turnId, steps };
  if ("explanation" in payload) plan.explanation = payload.explanation as string | null;
  return plan;
}

/** Steps keyed by text and occurrence ("Run tests" twice is two steps). */
function keyed(steps: ActivePlanState["steps"]) {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const n = seen.get(step.step) ?? 0;
    seen.set(step.step, n + 1);
    return { key: `${step.step}#${n}`, step };
  });
}

/**
 * How long each completed step took, from the plan updates of its turn: from when it went in progress (or, if it
 * never showed as in progress, from when the step before it finished, or the plan appeared) to when it completed.
 */
function withDurations(
  plan: ActivePlanState,
  updates: ReadonlyArray<ChatThreadActivity>,
): ActivePlanState {
  const seen = new Map<string, { started?: number; done?: number }>();
  let planShown: number | undefined;
  for (const update of updates) {
    const at = Date.parse(update.createdAt);
    const snapshot = planOf(update);
    if (!snapshot || Number.isNaN(at)) continue;
    planShown ??= at;
    for (const { key, step } of keyed(snapshot.steps)) {
      const times = seen.get(key) ?? {};
      if (step.status === "inProgress") times.started ??= at;
      if (step.status === "completed") times.done ??= at;
      seen.set(key, times);
    }
  }
  const durations = new Map<string, number>();
  let lastDone = planShown;
  const inFinishOrder = [...seen].toSorted(
    ([, a], [, b]) => (a.done ?? Infinity) - (b.done ?? Infinity),
  );
  for (const [key, { started, done }] of inFinishOrder) {
    if (done === undefined) continue;
    const from = started ?? lastDone;
    if (from !== undefined && done > from) durations.set(key, done - from);
    lastDone = done;
  }
  return {
    ...plan,
    steps: keyed(plan.steps).map(({ key, step }) => {
      const durationMs = step.status === "completed" ? durations.get(key) : undefined;
      return durationMs === undefined ? step : { ...step, durationMs };
    }),
  };
}

/**
 * The plan to show: the latest from the current turn, else the latest from any turn (a to-do list outlives the
 * follow-up message), with step durations counted from its last clear.
 */
export function deriveActivePlanState(
  activities: ReadonlyArray<ChatThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const updates = activities
    .filter((a) => a.kind === "turn.plan.updated")
    .toSorted(byActivityOrder);
  const latest =
    (latestTurnId ? updates.findLast((a) => a.turnId === latestTurnId) : undefined) ??
    updates.at(-1);
  const plan = latest ? planOf(latest) : null;
  if (!latest || !plan) return null;
  const sameTurn = updates.filter((a) => a.turnId === latest.turnId);
  const sinceClear = sameTurn.slice(sameTurn.findLastIndex((a) => planOf(a) === null) + 1);
  return withDurations(plan, sinceClear);
}

const byUpdate = (a: PlanProposal, b: PlanProposal) =>
  a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);

/** The most recently updated proposal of the latest turn, or else of the whole thread. */
export function findLatestPlanProposal(
  proposedPlans: ReadonlyArray<PlanProposal>,
  latestTurnId: TurnId | string | null | undefined,
): LatestPlanProposalState | null {
  const ofTurn = latestTurnId ? proposedPlans.filter((p) => p.turnId === latestTurnId) : [];
  const pick = (ofTurn.length > 0 ? ofTurn : proposedPlans).toSorted(byUpdate).at(-1);
  if (!pick) return null;
  const { id, createdAt, updatedAt, turnId, planMarkdown, implementedAt, implementationThreadId } =
    pick;
  return { id, createdAt, updatedAt, turnId, planMarkdown, implementedAt, implementationThreadId };
}

/** A proposal that has not been carried out yet. */
export const hasActionableProposedPlan = (
  proposal: LatestPlanProposalState | Pick<PlanProposal, "implementedAt"> | null,
): boolean => proposal !== null && proposal.implementedAt === null;

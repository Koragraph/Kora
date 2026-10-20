/**
 * The work log: the rows between messages that say what the agent did.
 *
 * It stays quiet by design. The parent's narrative gets rows; each subagent gets at most one (what it does inside
 * lives in the Agents panel); anything with a live surface of its own (approvals, questions, the plan, the context
 * meter) gets none.
 */
import type { ChatThreadActivity } from "@kora/contracts";
import { approvalDetailFromArgs } from "@kora/client-runtime/approvals";
import { isBackgroundTaskActivity } from "@kora/client-runtime/store/subagentRuntime";
import { isWorktreeSetupActivity } from "@kora/client-runtime/worklog/presentation";
import { foldUserInputActivities } from "@kora/client-runtime/worklog/user-input";

import {
  BLOB_HELPER_KINDS,
  approvalOutcomes,
  blobApprovalEntry,
  blobHelpersEntry,
  collectBlobCards,
  collectBlobHelpers,
} from "./blobRows";
import { canonicalKind, rowFromActivity, stampOf, type Row, type WorkLogEntry } from "./entries";
import { foldRows } from "./fold";
import { adaptKoraToolActivities } from "./koraTools";
import { byActivityOrder } from "./order";
import { fields, text } from "./read";

/** Kinds that never become rows here. */
const NO_ROW = new Set<string>([
  // Fold input only: the steps of something whose other rows show it.
  ...["tool.started", "tool.progress", "task.updated"],
  // Shown live elsewhere: the approval banner and the question panel...
  ...["requested", "resolved"].flatMap((stage) => [`approval.${stage}`, `user-input.${stage}`]),
  ...["approval", "user-input"].map((what) => `provider.${what}.respond.failed`),
  // ...the plan card and the context meter.
  ...["turn.plan.updated", "context-window.updated"],
  // Retired telemetry still present in older threads (token usage, the old savings chip).
  ...["usage", "savings"],
]);

const isTaskKind = (kind: string) => /^task\.(?:started|progress|updated|completed)$/.test(kind);

/** A subagent (not a background shell or monitor) task row. Its start anchors the batch's row. */
function isAgentTask(activity: ChatThreadActivity): boolean {
  const payload = fields(activity.payload);
  return typeof payload?.taskId === "string" && !isBackgroundTaskActivity(payload);
}

const ownedByAgent = (payload: Record<string, unknown>) =>
  typeof payload.agentId === "string" && payload.agentId.trim() !== "";

/**
 * Work a subagent did inside its own run, which belongs to the Agents panel. For task rows the server's stamp
 * decides: a subagent's own background shell is internal, a nested agent is not (its rows anchor a batch row).
 * Rows marked `timelineBypass` (Codex children, workflow members) are internal unless they are an agent's
 * lifecycle, which folds into its batch row.
 */
function isInsideAgent(activity: ChatThreadActivity): boolean {
  const payload = fields(activity.payload);
  if (!payload) return false;
  if (isTaskKind(activity.kind)) {
    if (!ownedByAgent(payload) && payload.timelineBypass !== true) return false;
    const agentLifecycle = activity.kind !== "task.updated" && isAgentTask(activity);
    return !agentLifecycle;
  }
  return payload.timelineBypass === true || ownedByAgent(payload);
}

/** Unknown SDK messages forwarded as warnings with nothing to show (the adapter's "(no displayable text content)"). */
const isEmptyWarning = (activity: ChatThreadActivity) =>
  canonicalKind(activity.kind) === "runtime.warning" &&
  activity.summary.endsWith("(no displayable text content)");

/** The ExitPlanMode tool call: the plan card shows it. */
const isPlanExit = (activity: ChatThreadActivity) =>
  (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
  text(fields(activity.payload)?.detail)?.startsWith("ExitPlanMode:") === true;

const DENIED = new Set(["decline", "cancel"]);

export function deriveActivityRows(activities: ReadonlyArray<ChatThreadActivity>): WorkLogEntry[] {
  const ordered = adaptKoraToolActivities(activities.toSorted(byActivityOrder));

  // An agent launch tool and the agent's own task rows are the same run: the launch's tool row goes once an
  // agent row stands for it.
  const launchesWithAgentRow = new Set<string>();
  for (const activity of ordered) {
    if (activity.kind === "task.updated" || !isTaskKind(activity.kind) || !isAgentTask(activity))
      continue;
    const toolUseId = text(fields(activity.payload)?.toolUseId);
    if (toolUseId) launchesWithAgentRow.add(toolUseId);
  }

  const cards = collectBlobCards(ordered);
  const helpers = collectBlobHelpers(ordered);
  const outcomes = approvalOutcomes(ordered);
  const helperTurnsShown = new Set<string>();
  /** What each approval asked for, so a denial row can say what was refused. */
  const asked = new Map<string, string>();
  const blobRequests = new Set<string>();
  const rows: Row[] = [];

  for (const activity of foldUserInputActivities(ordered)) {
    const payload = fields(activity.payload);
    const requestId = text(payload?.requestId);

    // An assistant's helpers: one row per turn, however many worker events.
    if (helpers && BLOB_HELPER_KINDS.has(activity.kind) && payload?.blobThread === true) {
      const turn = activity.turnId ?? "none";
      if (!helperTurnsShown.has(turn)) {
        helperTurnsShown.add(turn);
        rows.push(blobHelpersEntry(helpers.get(turn)!));
      }
      continue;
    }
    if (activity.kind === "blob.card") {
      const card = cards?.entryFor(activity);
      if (card) rows.push(card);
      continue;
    }
    // Worktree setup shows only when it failed (and its summary row always).
    if (
      isWorktreeSetupActivity(activity.kind) &&
      (activity.tone !== "error" || activity.kind === "worktree-setup")
    ) {
      continue;
    }
    // A subagent's start is its batch's anchor (kept for folding); other task starts say nothing.
    if (activity.kind === "task.started" && !isAgentTask(activity)) continue;

    if (activity.kind === "approval.requested") {
      // An assistant's request is a card in the transcript, so the composer stays free.
      const card = blobApprovalEntry(activity, requestId ? outcomes.get(requestId) : undefined);
      if (card) {
        rows.push(card);
        if (requestId) blobRequests.add(requestId);
        continue;
      }
      const what =
        text(payload?.detail) ?? approvalDetailFromArgs(payload?.args) ?? activity.summary;
      if (requestId && what) asked.set(requestId, what);
    }
    // A refusal stays in the history as one line; the model's prose is otherwise its only trace.
    if (activity.kind === "approval.resolved" && requestId && !blobRequests.has(requestId)) {
      if (DENIED.has(text(payload?.decision) ?? "")) {
        const what = (asked.get(requestId) ?? "").split("\n")[0]!.trim();
        rows.push({
          ...stampOf(activity),
          label: what ? `Denied: ${what}` : "Denied a request",
          tone: "info",
          sourceActivityKind: "approval.resolved",
        });
        continue;
      }
    }

    if (NO_ROW.has(activity.kind) || activity.summary === "Checkpoint captured") continue;
    if (isEmptyWarning(activity) || isPlanExit(activity) || isInsideAgent(activity)) continue;

    const row = rowFromActivity(activity);
    const isUpdate = activity.kind === "tool.updated" || activity.kind === "tool.completed";
    // A native agent launch still running: its row comes from the agent's task.started instead.
    const toolName = fields(payload?.data)?.toolName;
    const pendingLaunch =
      activity.kind === "tool.updated" &&
      row.itemType === "collab_agent_tool_call" &&
      row.toolLifecycleStatus === "inProgress" &&
      row.tone !== "error" &&
      (toolName === "Agent" || toolName === "Task");
    const replacedByAgentRow =
      isUpdate &&
      row.toolCallId !== undefined &&
      launchesWithAgentRow.has(row.toolCallId) &&
      row.tone !== "error" &&
      row.toolLifecycleStatus !== "failed";
    if (!pendingLaunch && !replacedByAgentRow) rows.push(row);
  }
  return foldRows(rows);
}

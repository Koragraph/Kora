/**
 * Folding rows that describe the same thing into one.
 *
 * - A tool call's updates (started, progress, finished) become one row, the newest data winning field by field.
 * - Subagents become one "Kicked off N subagents" row per batch: a workflow run, or the agents one turn spawned
 *   directly. The row stays where the batch started, however its agents' updates interleave with other rows.
 */
import { foldKey, toolLabel, type Row } from "./entries";

/** Fields where the newer row's value wins only when it has one. */
const WHEN_TRUTHY = [
  "detail",
  "command",
  "rawCommand",
  "toolTitle",
  "toolSurface",
  "toolIcon",
  "toolSource",
  "itemType",
  "requestKind",
  "toolCallId",
  "viewedImagePath",
  "readWindow",
] as const satisfies ReadonlyArray<keyof Row>;
const WHEN_DEFINED = ["toolLifecycleStatus", "toolData"] as const satisfies ReadonlyArray<
  keyof Row
>;

/** `older` updated by `newer`: newer wins, but an empty field never erases what the older row knew. */
export function mergeRows(older: Row, newer: Row): Row {
  const merged: Row = { ...older, ...newer };
  const out = merged as unknown as Record<string, unknown>;
  for (const name of WHEN_TRUTHY) {
    const value = newer[name] ?? older[name];
    if (value) out[name] = value;
  }
  for (const name of WHEN_DEFINED) {
    const value = newer[name] ?? older[name];
    if (value !== undefined) out[name] = value;
  }
  const key = newer[foldKey] ?? older[foldKey];
  if (key) merged[foldKey] = key;
  const files = new Set([...(older.changedFiles ?? []), ...(newer.changedFiles ?? [])]);
  if (files.size > 0) merged.changedFiles = [...files];
  return merged;
}

const isToolUpdate = (row: Row) =>
  row.sourceActivityKind === "tool.updated" || row.sourceActivityKind === "tool.completed";

/**
 * Does `next` continue `open`? Both are tool updates of the same turn and `open` has not finished; then either they
 * share a fold key, or `next` is an id-less update of the same kind and label as `open`.
 */
function continues(open: Row, next: Row): boolean {
  if (!isToolUpdate(open) || !isToolUpdate(next)) return false;
  if (open.turnId !== next.turnId || open.sourceActivityKind === "tool.completed") return false;
  if (open[foldKey] !== undefined && open[foldKey] === next[foldKey]) return true;
  return (
    open.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    open.itemType === next.itemType &&
    toolLabel(open.toolTitle ?? open.label) === toolLabel(next.toolTitle ?? next.label)
  );
}

/** The key under which a tool call's row can be found again by later updates of the same call. */
const callKey = (row: Row): string | undefined =>
  isToolUpdate(row) && row.toolCallId
    ? `tool:${row.turnId ?? "no-turn"}:${row.toolCallId}`
    : undefined;

const isAgentRow = (row: Row): row is Row & { taskId: string } =>
  row.taskId !== undefined &&
  !row.isBackgroundTask &&
  (row.sourceActivityKind === "task.started" ||
    row.sourceActivityKind === "task.progress" ||
    row.sourceActivityKind === "task.completed");

/**
 * The batch a subagent belongs to: its workflow run ("wf:..."), or the turn that spawned it ("direct:..."). With no
 * turn at all each agent is its own batch, so unrelated turn-less agents never pile into one row.
 */
function batchOf(row: Row & { taskId: string }): string {
  const workflow = row.taskId.indexOf(":wf:");
  if (workflow >= 0) return `wf:${row.taskId.slice(0, workflow)}`;
  if (row.agentSpawn?.workflowId) return `wf:${row.agentSpawn.workflowId}`;
  if (row.isWorkflowCoordinator) return `wf:${row.taskId}`;
  return row.turnId ? `direct:${row.turnId}` : `direct:task:${row.taskId}`;
}

export function foldRows(rows: ReadonlyArray<Row>): Row[] {
  const out: Row[] = [];
  /** Where each batch's row is. */
  const batchRow = new Map<string, number>();
  /**
   * Each agent's batch, fixed by its first row: background agents finish between turns, under new turn ids, and
   * re-batching by those split one batch into many rows.
   */
  const agentBatch = new Map<string, string>();
  /** Where each still-foldable tool call's row is. */
  const callRow = new Map<string, number>();

  const addAgent = (row: Row & { taskId: string }) => {
    const batch = agentBatch.get(row.taskId) ?? batchOf(row);
    agentBatch.set(row.taskId, batch);
    const workflowId = batch.startsWith("wf:") ? batch.slice("wf:".length) : null;
    const at = batchRow.get(batch);
    if (at === undefined) {
      batchRow.set(batch, out.length);
      out.push({ ...row, agentSpawn: { workflowId, agentTaskIds: [row.taskId] } });
      return;
    }
    const first = out[at]!;
    const members = first.agentSpawn?.agentTaskIds ?? [];
    // The batch row keeps its first row's identity and place (id, time, turn, label); the rest follows the agents.
    out[at] = {
      ...mergeRows(first, row),
      id: first.id,
      createdAt: first.createdAt,
      turnId: first.turnId ?? null,
      label: first.label,
      ...(first.taskId === undefined ? {} : { taskId: first.taskId }),
      agentSpawn: {
        workflowId,
        agentTaskIds: members.includes(row.taskId) ? members : [...members, row.taskId],
      },
    };
  };

  for (const row of rows) {
    if (isAgentRow(row)) {
      addAgent(row);
      continue;
    }
    const key = callKey(row);
    if (key !== undefined) {
      const at = callRow.get(key);
      if (at !== undefined && continues(out[at]!, row)) {
        out[at] = mergeRows(out[at]!, row);
        continue;
      }
      callRow.delete(key);
    }
    const last = out.at(-1);
    if (last && continues(last, row)) {
      const lastKey = callKey(last);
      if (lastKey !== undefined) callRow.delete(lastKey);
      const merged = mergeRows(last, row);
      out[out.length - 1] = merged;
      const mergedKey = callKey(merged);
      if (mergedKey !== undefined) callRow.set(mergedKey, out.length - 1);
      continue;
    }
    out.push(row);
    if (key !== undefined) callRow.set(key, out.length - 1);
  }
  return out;
}

/** One work-log row, and how a single activity becomes one. */
import {
  AskAttachmentAnswerPayload,
  isToolLifecycleItemType,
  type ChatThreadActivity,
  type ToolLifecycleItemType,
  type ToolTraceIcon,
  type ToolTraceSource,
  type ToolTraceSurface,
  type TurnId,
} from "@kora/contracts";
import { requestKindFromRequestType, type PendingApproval } from "@kora/client-runtime/approvals";
import { isBackgroundTaskActivity } from "@kora/client-runtime/store/subagentRuntime";
import {
  commandDetailRepeatsCommand,
  extractActivityLogToolLifecycleStatus,
  workEntryIndicatesToolFailure,
  activityRowSucceeded,
  activityRowIsToolLike,
  type ActivityLogToolLifecycleStatus,
} from "@kora/client-runtime/worklog/presentation";
import { extractToolActivityPresentation } from "@kora/client-runtime/worklog/tool-presentation";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { friendlyAgentErrorCopy } from "~/util/agentErrorCopy";
import { isGraphActivityKind } from "~/util/graphActivity";
import { isWorkerActivityKind } from "~/util/workerActivity";
import { rawOutputSummary, splitExitCode, toolCommand, toolOutput } from "./commands";
import { fields, text, type Fields } from "./read";

export interface WorkLogEntry {
  /** What the row says, its colour, and an optional body. */
  label: string;
  tone: "thinking" | "tool" | "info" | "error";
  detail?: string;
  /** The activity it came from: id, time and turn. */
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  /** The activity kind the row came from (`user-input.requested`, `tool.completed`, ...), for its chrome. */
  sourceActivityKind?: ChatThreadActivity["kind"];

  // Tool calls
  /** The provider's id for the call, the same on its in-progress and finished updates. */
  toolCallId?: string;
  itemType?: ToolLifecycleItemType;
  /** From the item's or task's `status` when it has one. */
  toolLifecycleStatus?: ActivityLogToolLifecycleStatus;
  toolTitle?: string;
  toolSurface?: ToolTraceSurface;
  toolIcon?: ToolTraceIcon;
  toolSource?: ToolTraceSource;
  toolData?: unknown;
  changedFiles?: ReadonlyArray<string>;
  command?: string;
  /** The command as given, when it was a shell wrapper around `command`. */
  rawCommand?: string;
  viewedImagePath?: string;
  /** Kora showed only part of a file (the daemon's read bounding): the card says "lines a-b of N". */
  readWindow?: {
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
  };
  requestKind?: PendingApproval["requestKind"];
  questionAnswer?: AskAttachmentAnswerPayload;

  // Kora's own rows
  /** Payload of a graph / savings / worker activity, for its own row rendering. */
  graphActivityPayload?: Record<string, unknown> | null;
  /** A `blob.card` (memory receipt, job, approval, ...): its own row, always the newest version of the card. */
  blobCard?: BlobCardRef;

  // Subagents
  /** One row per agent: the rows of one task fold together. */
  taskId?: string;
  agentRole?: string;
  /** On the "Kicked off N subagents" row: the workflow run (or null for a turn's direct spawns) and its agents. */
  agentSpawn?: { workflowId: string | null; agentTaskIds: ReadonlyArray<string> };
}

/** The newest version of one `blob.card`: its payload, checked by the card renderers. */
export interface BlobCardRef {
  readonly cardId: string;
  readonly version: number;
  readonly payload: Record<string, unknown>;
}

/** What rows of the same call or task share; rows with the same key fold into one. */
export const foldKey = Symbol("foldKey");

/** A row while the work log is built; the extra fields never leave this module group. */
export interface Row extends WorkLogEntry {
  sourceActivityKind: ChatThreadActivity["kind"];
  [foldKey]?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell, monitor and plan tasks: ordinary rows, never part of a subagent row. */
  isBackgroundTask?: boolean;
}

/** Severe: the turn or a core side effect broke (a runtime error, any `*.failed`), not just a command's exit code. */
export const activityRowSignalsSevereFailure = (entry: WorkLogEntry): boolean =>
  entry.sourceActivityKind === "runtime.error" ||
  entry.sourceActivityKind?.endsWith(".failed") === true;

/**
 * A tool row that shows neither success nor failure (in progress, empty, ...). Subagent rows and Kora's graph rows
 * never count: they render their own state, and hiding them mid-run hid exactly what was happening.
 */
export function activityRowIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  if (entry.agentSpawn !== undefined || isGraphActivityKind(entry.sourceActivityKind)) return false;
  const settled = workEntryIndicatesToolFailure(entry) || activityRowSucceeded(entry);
  return activityRowIsToolLike(entry) && !settled;
}

/** The daemon writes `runtime_error` / `runtime_warning`; older threads and the client use the dotted names. */
export function canonicalKind(kind: ChatThreadActivity["kind"]): ChatThreadActivity["kind"] {
  if (kind === "runtime_error") return "runtime.error" as ChatThreadActivity["kind"];
  if (kind === "runtime_warning") return "runtime.warning" as ChatThreadActivity["kind"];
  return kind;
}

/** "mcp__kora-blob__browser_click" or "Browser_navigate" read as words ("Browser click"); other labels as given. */
function wordsForToolId(label: string): string {
  const id = label.replace(/^mcp__[\w-]+__/, "");
  if (!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(id)) return label;
  const words = id.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A tool label without a trailing "complete(d)", tool ids as words: rows of one call read the same. */
export const toolLabel = (label: string): string =>
  wordsForToolId(label.replace(/\s+(?:complete|completed)\s*$/i, "").trim());

/** For "is this the same text?": whitespace collapsed, label rules applied, lowercased. */
function comparable(value: string | null | undefined): string | null {
  const t = text(value);
  return t === null ? null : toolLabel(t.replace(/\s+/g, " ").trim()).toLowerCase();
}

const itemTypeOf = (payload: Fields | null): ToolLifecycleItemType | undefined =>
  typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)
    ? payload.itemType
    : undefined;

function requestKindOf(payload: Fields | null): PendingApproval["requestKind"] | undefined {
  const kind = payload?.requestKind;
  if (kind === "command" || kind === "file-read" || kind === "file-change") return kind;
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

const PATH_FIELDS = ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"] as const;
const NESTED_FIELDS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
];
const MAX_FILES = 12;

/** The files a tool says it touched, found anywhere a few levels into its data (at most 12, in order, once each). */
function changedFilesIn(payload: Fields | null): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || found.size >= MAX_FILES) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
        if (found.size >= MAX_FILES) return;
      }
      return;
    }
    const obj = fields(value);
    if (!obj) return;
    for (const key of PATH_FIELDS) {
      const path = text(obj[key]);
      if (path) found.add(path);
    }
    for (const key of NESTED_FIELDS) {
      if (!(key in obj)) continue;
      visit(obj[key], depth + 1);
      if (found.size >= MAX_FILES) return;
    }
  };
  visit(fields(payload?.data), 0);
  return [...found];
}

const COMMAND_TITLES = new Set(["terminal", "ran command"]);

/** Does this row run a shell command? (Its output is then the body.) */
function isCommandTool(payload: Fields | null, heading: string): boolean {
  const kind = text(fields(payload?.data)?.kind)?.toLowerCase();
  const title = text(payload?.title ?? heading)?.toLowerCase();
  return (
    itemTypeOf(payload) === "command_execution" ||
    kind === "execute" ||
    COMMAND_TITLES.has(title ?? "")
  );
}

/**
 * The body of a tool row: a command's output; else the detail the tool gave, unless it only repeats the heading
 * (or, for a command, the command itself); else for other tools a summary of what they returned.
 */
function toolBody(payload: Fields | null, heading: string): string | null {
  const given = text(payload?.detail);
  const detail = given ? splitExitCode(given).output : null;
  const command = isCommandTool(payload, heading);
  const ran = command ? toolCommand(payload) : { command: null, rawCommand: null };
  if (command && ran.command) {
    const output = toolOutput(payload);
    if (output) return output;
  }
  const data = fields(payload?.data);
  const repeatsCommand =
    detail !== null &&
    commandDetailRepeatsCommand({ detail, ...ran, toolName: data?.toolName, data });
  if (detail && comparable(detail) !== comparable(heading) && !(command && repeatsCommand))
    return detail;
  if (command) return null;
  const summary = rawOutputSummary(payload);
  return summary && comparable(summary) !== comparable(heading) ? summary : null;
}

/** The fold key a row gets: per task for subagent progress, per call id, else by type + label + body. */
function foldKeyOf(row: Row): string | undefined {
  const kind = row.sourceActivityKind;
  if (row.taskId && (kind === "task.progress" || kind === "task.completed"))
    return `task${row.taskId}`;
  if (kind !== "tool.updated" && kind !== "tool.completed") return undefined;
  if (row.toolCallId) return `tool:${row.turnId ?? "no-turn"}:${row.toolCallId}`;
  const parts = [
    row.itemType ?? "",
    toolLabel(row.toolTitle ?? row.label),
    row.detail?.trim() ?? "",
  ];
  return parts.some((part) => part !== "") ? parts.join("\u001f") : undefined;
}

const TASK_KINDS = new Set(["task.started", "task.progress", "task.completed"]);
const decodeAnswer = Schema.decodeUnknownOption(AskAttachmentAnswerPayload);
const rowOfActivity = new WeakMap<ChatThreadActivity, Row>();

/** Where a row sits: its activity's id, time and turn. */
export const stampOf = ({ id, createdAt, turnId }: ChatThreadActivity) => ({
  id,
  createdAt,
  turnId,
});

/** Subagent progress reads as thinking; an approval as plain info; the rest as the activity says. */
function toneOf(activity: ChatThreadActivity): WorkLogEntry["tone"] {
  if (activity.kind === "task.progress") return "thinking";
  return activity.tone === "approval" ? "info" : activity.tone;
}

/** A non-empty string field. */
const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** The row for one activity (cached per activity object: an unchanged activity gives the same row). */
export function rowFromActivity(activity: ChatThreadActivity): Row {
  const cached = rowOfActivity.get(activity);
  if (cached) return cached;
  const payload = fields(activity.payload);
  const kind = canonicalKind(activity.kind);
  const isTask = TASK_KINDS.has(activity.kind);
  const title = text(payload?.title);

  // A task row is labelled by its summary, or its detail when there is no summary (then the detail is not repeated).
  const taskSummary = isTask ? nonEmpty(payload?.summary) : null;
  const detailAsLabel = isTask && !taskSummary ? nonEmpty(payload?.detail) : null;
  const taskDetail = isTask && !detailAsLabel ? nonEmpty(payload?.detail) : null;
  const body = isTask
    ? taskDetail && splitExitCode(taskDetail).output
    : toolBody(payload, title ?? activity.summary);

  const row: Row = {
    ...stampOf(activity),
    label:
      taskSummary ||
      detailAsLabel ||
      (kind === "runtime.error" ? friendlyAgentErrorCopy(activity.summary) : null) ||
      activity.summary,
    tone: toneOf(activity),
    sourceActivityKind: kind,
  };

  if (body) row.detail = body;
  else if (kind === "runtime.error" || kind === "runtime.warning") {
    const message = text(payload?.message);
    if (message && comparable(message) !== comparable(activity.summary)) row.detail = message;
  }
  // A signed-out agent's error gets calm copy as its label; the raw error stays as the detail.
  if (!row.detail && kind === "runtime.error" && row.label !== activity.summary)
    row.detail = activity.summary;

  if (activity.kind === "user-input.answer-submitted") {
    const answer = decodeAnswer(payload);
    if (Option.isSome(answer)) row.questionAnswer = answer.value;
  }
  if (isGraphActivityKind(activity.kind) || isWorkerActivityKind(activity.kind))
    row.graphActivityPayload = payload;

  const data = fields(payload?.data);
  const { command, rawCommand } = toolCommand(payload);
  const changedFiles = changedFilesIn(payload);
  const look = extractToolActivityPresentation(payload);
  const viewedImagePath = text(data?.imagePath);
  if (viewedImagePath) row.viewedImagePath = viewedImagePath;
  if (command) row.command = command;
  if (rawCommand) row.rawCommand = rawCommand;
  if (changedFiles.length > 0) row.changedFiles = changedFiles;
  if (title) row.toolTitle = title;
  if (look.toolSurface) row.toolSurface = look.toolSurface;
  if (look.toolIcon) row.toolIcon = look.toolIcon;
  if (look.toolSource) row.toolSource = look.toolSource;

  const window = fields(fields(data?.item)?.bounded);
  const { path, offset, limit, total } = window ?? {};
  if (typeof path === "string" && [offset, limit, total].every(Number.isInteger)) {
    row.readWindow = {
      path,
      offset: offset as number,
      limit: limit as number,
      total: total as number,
    };
  }

  const itemType = itemTypeOf(payload);
  if (itemType === "mcp_tool_call") {
    // The MCP call's own data: the item when the data names a tool, else whatever item there is.
    const toolData = typeof data?.toolName === "string" ? (data.item ?? data) : data?.item;
    if (toolData !== undefined) row.toolData = toolData;
  }
  if (itemType) row.itemType = itemType;
  const requestKind = requestKindOf(payload);
  if (requestKind) row.requestKind = requestKind;
  const toolCallId = isTask ? null : (text(payload?.toolCallId) ?? text(data?.toolCallId));
  if (toolCallId) row.toolCallId = toolCallId;
  const status =
    extractActivityLogToolLifecycleStatus(payload) ||
    (activity.kind === "tool.completed" ? "completed" : undefined);
  if (status) row.toolLifecycleStatus = status;

  if (isTask) {
    const taskId = nonEmpty(payload?.taskId);
    const role = nonEmpty(payload?.role);
    if (taskId) row.taskId = taskId;
    if (role) row.agentRole = role;
    if (payload?.taskType === "local_workflow" || nonEmpty(payload?.workflowName))
      row.isWorkflowCoordinator = true;
    if (payload && isBackgroundTaskActivity(payload)) row.isBackgroundTask = true;
  }

  const key = foldKeyOf(row);
  if (key) row[foldKey] = key;
  rowOfActivity.set(activity, row);
  return row;
}

import {
  type ToolTraceSource,
  type ToolLifecycleItemType,
  type RuntimeItemStatus,
  isToolLifecycleItemType,
} from "@kora/contracts";
import { parseChangeRequestUrl } from "@kora/shared/mergeRequestUrl";

import type { MediaSourceResource } from "../media/source.ts";

const WORKTREE_SETUP_KINDS: ReadonlySet<string> = new Set([
  "worktree-setup",
  "setup-script.started",
  "setup-script.requested",
]);

export function isWorktreeSetupActivity(kind: string): boolean {
  return WORKTREE_SETUP_KINDS.has(kind);
}

export type ActivityLogToolLifecycleStatus = RuntimeItemStatus | "stopped";

/** What the row shows. */
type EntryDisplay = {
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly label: string;
  readonly changedFiles?: ReadonlyArray<string>;
} & Partial<Readonly<Record<"command" | "viewedImagePath" | "detail", string>>>;

/** Where the row came from and which tool call it tracks. */
type EntryOrigin = Partial<
  Readonly<
    Record<
      | "sourceActivityKind"
      | "toolLifecycleStatus"
      | "requestKind"
      | "toolCallId"
      | "toolTitle"
      | "taskId",
      string
    >
  >
> & {
  readonly itemType?: ToolLifecycleItemType;
  readonly toolSource?: ToolTraceSource;
  readonly toolData?: unknown;
  readonly turnId?: string | null;
};

export interface WorkLogPresentationEntry extends EntryDisplay, EntryOrigin {}

export type ToolGroupAction =
  | "update"
  | "other"
  | "search"
  | "code-search"
  | "device"
  | "browser"
  | "command"
  | "edit"
  | "read"
  | "list-prs"
  | "unlink-pr"
  | "link-pr";

export type ToolGroupSummaryKind =
  | "mixed"
  | "tone-tool"
  | "agent-tool"
  | "dynamic-tool"
  | ToolGroupAction
  | "pull-request";

export interface ViewedImageAsset {
  readonly resource: MediaSourceResource;
  readonly alt: string;
  readonly srcFragment: string;
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s*\bcomplete(?:d)?\s*$/i, "").trim();
}

// ---- Kora's own MCP tools -------------------------------------------------------------------

/**
 * One row per tool: name | action | running form | completed form | what it acts on.
 * Parsed once at load.
 */
const KORA_TOOL_TABLE = `
link_pull_request         | Link | Linking | Linked | a pull request
unlink_pull_request       | Unlink | Unlinking | Unlinked | a pull request
list_thread_pull_requests | Check | Checking | Checked | linked pull requests
orchestrator_capabilities | Get | Getting | Got | orchestrator capabilities
delegate_task             | Delegate | Delegating | Delegated | a child task
task_status               | Get | Getting | Got | delegated task status
task_cancel               | Cancel | Canceling | Canceled | delegated task
schedule_task             | Schedule | Scheduling | Scheduled | a recurring task
list_scheduled_tasks      | List | Listing | Listed | scheduled tasks
update_scheduled_task     | Update | Updating | Updated | a scheduled task
delete_scheduled_task     | Delete | Deleting | Deleted | a scheduled task
create_threads            | Create | Creating | Created | Kora threads
kora_thread_start         | Start | Starting | Started | a Kora thread
kora_thread_list          | List | Listing | Listed | Kora threads
kora_thread_read          | Read | Reading | Read | a Kora thread
kora_thread_send          | Send | Sending | Sent | to a Kora thread
kora_thread_wait          | Wait | Waiting | Waited | for a Kora thread
kora_thread_interrupt     | Interrupt | Interrupting | Interrupted | a Kora thread
kora_worktree_handoff     | Hand off | Handing off | Handed off | thread to a git worktree
kora_worktree_status      | Get | Getting | Got | thread worktree status
preview_status            | Get | Getting | Got | preview browser status
preview_open              | Open | Opening | Opened | a page in the preview browser
preview_navigate          | Navigate | Navigating | Navigated | the preview browser
preview_snapshot          | Take a snapshot of | Taking a snapshot of | Took a snapshot of | the preview page
preview_click             | Click | Clicking | Clicked | in the preview browser
preview_press             | Press | Pressing | Pressed | a key in the preview browser
preview_type              | Type | Typing | Typed | in the preview browser
preview_scroll            | Scroll | Scrolling | Scrolled | the preview browser
preview_resize            | Resize | Resizing | Resized | the preview browser
preview_evaluate          | Evaluate | Evaluating | Evaluated | script in the preview browser
preview_wait_for          | Wait | Waiting | Waited | for the preview page
preview_set_appearance    | Set | Setting | Set | preview browser appearance
preview_recording_start   | Start | Starting | Started | recording the preview browser
preview_recording_stop    | Stop | Stopping | Stopped | recording the preview browser
device_list               | List | Listing | Listed | simulators and emulators
device_open               | Open | Opening | Opened | a device in the Device panel
device_screenshot         | Take a screenshot of | Taking a screenshot of | Took a screenshot of | the device
device_close              | Close | Closing | Closed | a device
`;

type ToolWording = readonly [action: string, running: string, completed: string, target: string];

const KORA_TOOLS: ReadonlyMap<string, ToolWording> = new Map(
  KORA_TOOL_TABLE.trim()
    .split("\n")
    .map((line) => {
      const [name, ...wording] = line.split("|").map((cell) => cell.trim());
      return [name!, wording as unknown as ToolWording] as const;
    }),
);

/** Kora's pull-request tools, by the group action they count as. */
const PR_ACTIONS: ReadonlyMap<string, ToolGroupAction> = new Map([
  ["list_thread_pull_requests", "list-prs"],
  ["unlink_pull_request", "unlink-pr"],
  ["link_pull_request", "link-pr"],
]);

const KORA_PREFIX =
  /^(?:mcp__kora-code__|mcp__kora_code__|mcp__kora__|(?:kora-code|kora_code|kora)(?:[.:/]| · ))/i;

export function liveActivityToolStatus(
  status: string | undefined,
  presentTense: boolean,
): "failed" | "declined" | "stopped" | "inProgress" | "completed" {
  if (status === "failed" || status === "declined" || status === "stopped") return status;
  return presentTense || status === "inProgress" ? "inProgress" : "completed";
}

interface KoraToolMatch {
  readonly name: string;
  readonly row: ToolWording;
}

const matchKoraTool = (label: string): KoraToolMatch | null => {
  const name = normalizeCompactToolLabel(label).replace(KORA_PREFIX, "");
  const row = KORA_TOOLS.get(name);
  return row === undefined ? null : { name, row };
};

const firstRecord = (...candidates: unknown[]): UnknownRecord | undefined =>
  candidates.find(isRecord);

const pullRequestNumber = (data: unknown): number | undefined => {
  if (!isRecord(data)) return undefined;
  const input = firstRecord(data.arguments, data.input, data.rawInput);
  if (!input) return undefined;
  if (typeof input.url === "string") {
    const parsed = parseChangeRequestUrl(input.url);
    if (parsed) return parsed.number;
  }
  const { number } = input;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
};

type PresentationInput = Pick<
  WorkLogPresentationEntry,
  "toolLifecycleStatus" | "toolData" | "toolTitle" | "label"
>;

export function activityRowToolLook(
  source: PresentationInput,
  assumedStatus?: "inProgress" | "completed",
): {
  displayName: string;
  icon: "pull-request" | "browser" | "device" | "kora-code";
  action?: ToolGroupAction;
} | null {
  const entry = source;
  const status = entry.toolLifecycleStatus ?? assumedStatus;
  const data = entry.toolData;

  let match: KoraToolMatch | null;
  if (isRecord(data)) {
    if (typeof data.server === "string" && typeof data.tool === "string") {
      match = matchKoraTool(`${data.server}.${data.tool}`);
    } else if (typeof data.toolName === "string") {
      match = matchKoraTool(data.toolName);
    } else {
      match =
        (entry.toolTitle !== undefined ? matchKoraTool(entry.toolTitle) : null) ??
        matchKoraTool(entry.label);
    }
  } else {
    match =
      (entry.toolTitle !== undefined ? matchKoraTool(entry.toolTitle) : null) ??
      matchKoraTool(entry.label);
  }
  if (match === null) return null;

  const [action, running, completed, detail] = match.row;
  const prAction = PR_ACTIONS.get(match.name);
  const prNumber = prAction === "list-prs" ? undefined : pullRequestNumber(data);
  const target = prAction !== undefined && prNumber !== undefined ? `PR #${prNumber}` : detail;

  let verb: string;
  switch (status) {
    case "completed":
      verb = completed;
      break;
    case "failed":
      verb = `Failed to ${lowerFirst(action)}`;
      break;
    case "declined":
      verb = `Declined to ${lowerFirst(action)}`;
      break;
    case "stopped":
      verb = `Stopped ${lowerFirst(running)}`;
      break;
    default:
      verb = running;
  }

  const icon = prAction
    ? "pull-request"
    : match.name.startsWith("preview_")
      ? "browser"
      : match.name.startsWith("device_")
        ? "device"
        : "kora-code";
  return { displayName: `${verb} ${target}`, icon, ...(prAction ? { action: prAction } : {}) };
}

// ---- Command output ---------------------------------------------------------------------------

const textOfList = (items: readonly unknown[]): string | null => {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim() !== "") parts.push(item);
    } else if (isRecord(item) && typeof item.text === "string" && item.text.trim() !== "") {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
};

const candidateText = (candidate: unknown): string | null => {
  if (typeof candidate === "string") return candidate.trim() !== "" ? candidate : null;
  if (Array.isArray(candidate)) return textOfList(candidate);
  if (!isRecord(candidate)) return null;
  const { content } = candidate;
  if (typeof content === "string") return content.trim() !== "" ? content : null;
  return Array.isArray(content) ? textOfList(content) : null;
};

export function extractCommandOutputText(dataValue: unknown): string | null {
  if (!isRecord(dataValue)) return null;
  const item = isRecord(dataValue.item) ? dataValue.item : undefined;
  const raw = dataValue.rawOutput;
  const rawRecord = isRecord(raw) ? raw : undefined;

  const streams = rawRecord
    ? [rawRecord.stdout, rawRecord.stderr].filter(
        (stream): stream is string => typeof stream === "string" && stream.trim() !== "",
      )
    : [];
  const acp = Array.isArray(dataValue.content)
    ? textOfList(
        dataValue.content.flatMap((entry) =>
          isRecord(entry) && entry.type === "content" && isRecord(entry.content)
            ? [entry.content]
            : [],
        ),
      )
    : null;

  const candidates: unknown[] = [
    item?.aggregatedOutput,
    isRecord(item?.result) ? item.result.content : undefined,
    raw,
    rawRecord?.content,
    streams.length > 0 ? streams.join("\n") : undefined,
    rawRecord?.output,
    acp,
    dataValue.result,
  ];
  for (const candidate of candidates) {
    const text = candidateText(candidate);
    if (text !== null) return text;
  }
  return null;
}

const echoesCommand = (text: string, command: string | null): boolean => {
  if (command === null) return false;
  const full = command.trim();
  const shown = text.trim();
  if (full === shown) return true;
  // Ingestion truncates long details to a prefix plus an ellipsis.
  const ellipsis = shown.endsWith("...") ? 3 : shown.endsWith("…") ? 1 : 0;
  if (ellipsis === 0) return false;
  const prefix = shown.slice(0, -ellipsis);
  return prefix !== "" && full.length > prefix.length && full.startsWith(prefix);
};

const hasStructuredCommand = (data: unknown): boolean => {
  const present = (value: unknown): boolean =>
    typeof value === "string"
      ? value.trim() !== ""
      : Array.isArray(value) &&
        value.some((part) => typeof part === "string" && part.trim() !== "");
  if (!isRecord(data)) return false;
  const item = isRecord(data.item) ? data.item : undefined;
  return (
    present(item?.command) ||
    present(isRecord(item?.input) ? item.input.command : undefined) ||
    present(isRecord(item?.result) ? item.result.command : undefined) ||
    present(data.command)
  );
};

export function commandDetailRepeatsCommand(input: {
  detail: string;
  command: string | null;
  rawCommand: string | null;
  toolName: unknown;
  data: unknown;
}): boolean {
  const { detail, command, rawCommand, toolName, data } = input;
  const echoes = (text: string) => echoesCommand(text, command) || echoesCommand(text, rawCommand);

  const name = nonEmptyString(toolName);
  if (name !== undefined) {
    const prefix = `${name}:`;
    if (
      detail.toLowerCase().startsWith(prefix.toLowerCase()) &&
      echoes(detail.slice(prefix.length))
    ) {
      return true;
    }
  }
  if (!echoes(detail)) return false;

  // Some providers keep the real output in `detail`, so a bare echo only counts when the payload
  // shows it was synthesised from the command.
  if (!hasStructuredCommand(data)) return true;
  if (!isRecord(data)) return false;
  return data.item !== undefined && data.item !== null
    ? true
    : data.toolCallId !== undefined ||
        (typeof data.kind === "string" && data.kind.toLowerCase() === "execute");
}

// ---- Classifying entries ------------------------------------------------------------------------

export function activityRowIsToolLike(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.tone !== "info" ||
    (entry.command !== undefined && entry.command.trim() !== "") ||
    entry.requestKind !== undefined ||
    (entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType))
  );
}

/** Lifecycle statuses providers report, mapped onto the work log's own. */
const LIFECYCLE_BY_STATUS: ReadonlyMap<unknown, ActivityLogToolLifecycleStatus> = new Map<
  unknown,
  ActivityLogToolLifecycleStatus
>([
  ["pending", "inProgress"],
  ["running", "inProgress"],
  ["waiting", "inProgress"],
  ["cancelled", "stopped"],
  ["interrupted", "stopped"],
  ...(["inProgress", "completed", "failed", "declined", "stopped"] as const).map(
    (same) => [same, same] as const,
  ),
]);

export function extractActivityLogToolLifecycleStatus(
  payload: unknown,
): ActivityLogToolLifecycleStatus | undefined {
  if (!isRecord(payload)) return undefined;
  // An idle batch has stopped reporting per-agent status; an idle anything else says nothing.
  if (payload.status === "idle")
    return payload.taskType === "subagent_batch" ? "stopped" : undefined;
  return LIFECYCLE_BY_STATUS.get(payload.status);
}

const FAILURE_PHRASES = [
  "file not found",
  "no files found",
  "enoent",
  "no such file or directory",
  "no such file",
  "commandnotfoundexception",
  "command not found",
  "is not recognized as the name of a cmdlet",
  "a parameter cannot be found that matches parameter name",
];
const EXIT_CODE = /exit(?:ed)? with exit code\s*(-?\d+)|exit code[:\s]\s*(-?\d+)/gi;

const looksLikeFailure = (text: string): boolean => {
  const lower = text.toLowerCase();
  if (FAILURE_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  if (lower.includes("cannot find path") && lower.includes("because it does not exist"))
    return true;
  if (lower.includes("is not recognized") && lower.includes("the term '")) return true;
  for (const match of text.matchAll(EXIT_CODE)) {
    if (Number(match[1] ?? match[2]) !== 0) return true;
  }
  return false;
};

const failureOf = (entry: WorkLogPresentationEntry, includeCommand: boolean): boolean => {
  if (entry.tone === "error") return true;
  if (entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "declined")
    return true;
  if (!activityRowIsToolLike(entry)) return false;
  const text = (includeCommand ? [entry.detail, entry.command] : [entry.detail])
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join("\n");
  return text !== "" && looksLikeFailure(text);
};

export const workEntryIndicatesToolFailure = (entry: WorkLogPresentationEntry): boolean =>
  failureOf(entry, true);

export const activityRowShowsFailure = (entry: WorkLogPresentationEntry): boolean =>
  failureOf(entry, false);

export function activityRowSucceeded(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "thinking") return false;
  const unfinished =
    entry.toolLifecycleStatus === "inProgress" || entry.toolLifecycleStatus === "stopped";
  return activityRowIsToolLike(entry) && !workEntryIndicatesToolFailure(entry) && !unfinished;
}

const asIs = <T>(value: T): T => value;

// ---- Grouping -----------------------------------------------------------------------------------

const APPROVAL_KINDS: ReadonlySet<string> = new Set(
  ["requested", "resolved"]
    .map((step) => `approval.${step}`)
    .concat("provider.approval.respond.failed"),
);

const titleOf = (entry: WorkLogPresentationEntry): string =>
  normalizeCompactToolLabel(entry.toolTitle ?? entry.label).toLowerCase();

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.sourceActivityKind !== undefined && APPROVAL_KINDS.has(entry.sourceActivityKind)) {
    return "update";
  }
  const presentation = activityRowToolLook(entry);
  if (presentation?.action) return presentation.action;
  if (presentation?.icon === "browser" || presentation?.icon === "device") return presentation.icon;

  const hasText = (value: string | undefined) => value !== undefined && value.trim() !== "";
  const reads =
    entry.viewedImagePath !== undefined ||
    entry.itemType === "image_view" ||
    entry.requestKind === "file-read" ||
    (entry.itemType === "dynamic_tool_call" && titleOf(entry).trim() === "read file");
  if (reads) return "read";
  const edits =
    (entry.changedFiles?.length ?? 0) > 0 ||
    entry.itemType === "file_change" ||
    entry.requestKind === "file-change";
  if (edits) return "edit";
  const runs =
    hasText(entry.command) ||
    entry.itemType === "command_execution" ||
    entry.requestKind === "command";
  if (runs) return "command";
  if (entry.itemType === "web_search")
    return /\bgrep\b/.test(titleOf(entry)) ? "code-search" : "search";
  return activityRowIsToolLike(entry) ? "other" : "update";
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  count === 1 ? singular : pluralForm;

const baseName = (path: string): string =>
  path
    .split(/[/\\]/)
    .filter((part) => part !== "")
    .pop() ?? path;

function describeEdits(entries: readonly WorkLogPresentationEntry[]): string {
  const files = new Set<string>();
  let withoutFiles = 0;
  for (const entry of entries) {
    if (entry.changedFiles && entry.changedFiles.length > 0) {
      for (const file of entry.changedFiles) files.add(file);
    } else {
      withoutFiles += 1;
    }
  }
  const count = files.size + withoutFiles;

  if (withoutFiles === 0 && files.size === 1) {
    const name = baseName([...files][0]!);
    const previews = entries.map((entry) => entry.detail);
    if (previews.every((detail) => detail !== undefined && !detail.endsWith("more characters)"))) {
      let added = 0;
      let removed = 0;
      for (const detail of previews) {
        for (const line of detail!.split("\n")) {
          if (line.startsWith("+ ")) added += 1;
          else if (line.startsWith("- ")) removed += 1;
        }
      }
      if (added > 0 || removed > 0) return `Changed ${name} (+${added} -${removed})`;
    }
    return `Changed ${name}`;
  }
  return `Changed ${count} ${plural(count, "file")}`;
}

function describeAction(
  action: ToolGroupAction,
  entries: readonly WorkLogPresentationEntry[],
): string {
  const n = entries.length;
  switch (action) {
    case "link-pr":
      return `Linked ${n} ${plural(n, "pull request")}`;
    case "unlink-pr":
      return `Unlinked ${n} ${plural(n, "pull request")}`;
    case "list-prs":
      return n === 1 ? "Checked linked pull requests" : `Checked linked pull requests ${n} times`;
    case "read":
      return `Read ${n} ${plural(n, "file")}`;
    case "edit":
      return describeEdits(entries);
    case "command":
      return `Ran ${n} ${plural(n, "command")}`;
    case "device":
      return `Used device controls ${n} ${plural(n, "time")}`;
    case "browser":
      return `Used browser ${n} ${plural(n, "time")}`;
    case "search":
      return `Searched the web ${n} ${plural(n, "time")}`;
    case "code-search":
      return `Searched code ${n} ${plural(n, "time")}`;
    case "other":
      return `Used ${n} ${plural(n, "tool")}`;
    case "update":
      return `Received ${n} ${plural(n, "update")}`;
  }
}

const joinWithAnd = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : parts.length === 2
      ? `${parts[0]} and ${parts[1]}`
      : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;

/** "Used X and Y integrations" for rows that came from named tool sources. */
function describeSources(sources: ReadonlyArray<ToolTraceSource>): string {
  const names = joinWithAnd(sources.map(({ name }) => name));
  const allIntegrations = sources.every(({ kind }) => kind === "integration");
  const suffix = allIntegrations ? plural(sources.length, " integration", " integrations") : "";
  return `Used ${names}${suffix}`;
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  // Rows with a named source (other than Kora's pull-request tools) are summarised by source;
  // the rest by what they did, in first-seen order.
  const sourceByKey = new Map<string, ToolTraceSource>();
  const rowsByAction = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  omitSupersededLifecycleMarkers(entries, asIs).forEach((entry) => {
    const source = entry.toolSource;
    if (source && activityRowToolLook(entry)?.icon !== "pull-request") {
      sourceByKey.set(source.key, source);
      return;
    }
    const action = toolGroupAction(entry);
    rowsByAction.set(action, [...(rowsByAction.get(action) ?? []), entry]);
  });

  const phrases = [
    ...(sourceByKey.size > 0 ? [describeSources([...sourceByKey.values()])] : []),
    ...[...rowsByAction].map(([action, rows]) => describeAction(action, rows)),
  ];
  return joinWithAnd(phrases.map((phrase, index) => (index > 0 ? lowerFirst(phrase) : phrase)));
}

/** Rows that start or update a tool without an id or status; a later finish makes them noise. */
const isBareLifecycleMarker = (entry: WorkLogPresentationEntry) =>
  !entry.toolCallId &&
  !entry.toolLifecycleStatus &&
  (entry.sourceActivityKind === "tool.started" || entry.sourceActivityKind === "tool.updated");

const finishesTool = (entry: WorkLogPresentationEntry) =>
  entry.sourceActivityKind === "tool.completed" ||
  (entry.toolLifecycleStatus !== undefined && entry.toolLifecycleStatus !== "inProgress");

const toolIdentity = (entry: WorkLogPresentationEntry) =>
  [
    entry.turnId ?? "no-turn",
    entry.itemType ?? "",
    normalizeCompactToolLabel(entry.toolTitle ?? entry.label),
  ].join("\u0000");

/** Drop start/update markers of tools that later finished; everything else is kept in order. */
export function omitSupersededLifecycleMarkers<T>(
  items: readonly T[],
  toEntry: (item: T) => WorkLogPresentationEntry,
): T[] {
  // Walk newest first so a finish is known before the markers that precede it.
  const finishedTools = new Set<string>();
  const survivors = items.reduceRight<T[]>((kept, item) => {
    const entry = toEntry(item);
    const key = toolIdentity(entry);
    if (isBareLifecycleMarker(entry) && finishedTools.has(key)) return kept;
    kept.push(item);
    if (finishesTool(entry)) finishedTools.add(key);
    return kept;
  }, []);
  return survivors.reverse();
}

const isPullRequestEntry = (entry: WorkLogPresentationEntry): boolean =>
  activityRowToolLook(entry)?.icon === "pull-request";

/** How a lone "other" row is drawn: by item type first, then by its tone. */
function otherRowKind(entry: WorkLogPresentationEntry): ToolGroupSummaryKind {
  switch (entry.itemType) {
    case "mcp_tool_call":
      return "other";
    case "dynamic_tool_call":
      return "dynamic-tool";
    case "collab_agent_tool_call":
      return "agent-tool";
  }
  if (entry.taskId !== undefined || entry.tone === "thinking") return "agent-tool";
  return entry.tone === "tool" ? "tone-tool" : "other";
}

const singleOr = <T>(values: ReadonlySet<T>, fallback: T): T =>
  values.size === 1 ? (values.values().next().value as T) : fallback;

export function toolGroupSummaryKind(
  rows: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  if (rows.length > 0 && rows.every(isPullRequestEntry)) return "pull-request";
  const actions = new Set(rows.map(toolGroupAction));
  if (actions.size === 0) return "other";
  const action = singleOr<ToolGroupSummaryKind>(actions, "mixed");
  if (action !== "other") return action;
  return singleOr(new Set(rows.map(otherRowKind)), "mixed");
}

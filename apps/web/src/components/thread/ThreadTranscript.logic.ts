import { formatWorkspaceRelativePath } from "../../workspace/filePathDisplay";
import type { PlanProposal, ChatMessage } from "../../types";
import {
  activityRowShowsFailure,
  activityRowIndicatesToolNeutralStatus,
  activityRowSucceeded,
  isStreamingMessageTextUpdate,
  activityRowIsToolLike,
  type TranscriptItem,
  formatDuration,
  type WorkLogEntry,
  type BlobCardRef,
} from "../../thread/timeline";
import type { QueuedPromptMessage } from "../../stores/queuedMessageStore";
import type { ThreadAgentMode, ChatLatestTurn, TurnId } from "@kora/contracts";
import {
  activityRowToolLook,
  omitSupersededLifecycleMarkers,
  normalizeCompactToolLabel,
  liveActivityToolStatus,
  type ToolGroupSummaryKind,
  toolGroupSummaryKind,
  summarizeToolGroup,
  toolGroupAction,
} from "@kora/client-runtime/worklog/presentation";
import { commandProgramName } from "@kora/client-runtime/worklog/command-label";
import { renderCodexDirectivesForCopy } from "@kora/client-runtime/codex/markdown-directives";
import { shallow } from "zustand/vanilla/shallow";
import * as Equal from "effect/Equal";

export { normalizeCompactToolLabel };

// ---------------------------------------------------------------------------
// Labels

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function compactLabel(entry: WorkLogEntry): string {
  return capitalize(normalizeCompactToolLabel(entry.toolTitle || entry.label));
}

/** One finished call, worded as a settled sentence. */
function singleToolCallLabel(entry: WorkLogEntry): string {
  const presentation = activityRowToolLook(
    { ...entry, toolLifecycleStatus: "completed" },
    "completed",
  );
  if (presentation) return presentation.displayName;
  const command = entry.command?.trim();
  return command ? command : compactLabel(entry);
}

export function activityRowLabel(entry: WorkLogEntry, workspaceRoot: string | undefined): string {
  const presentation = activityRowToolLook(entry, "completed");
  if (presentation) return presentation.displayName;

  const command = entry.command?.trim();
  if (command) return command;

  const firstChangedFile = entry.changedFiles?.[0];
  const fileChangeWithFile = entry.itemType === "file_change" && firstChangedFile !== undefined;
  if (entry.detail && !fileChangeWithFile) return entry.detail;

  if (firstChangedFile !== undefined) {
    const shown = formatWorkspaceRelativePath(firstChangedFile, workspaceRoot);
    const extra = (entry.changedFiles?.length ?? 1) - 1;
    return extra > 0 ? `${shown} +${extra} more` : shown;
  }
  return compactLabel(entry);
}

const COMMAND_VERB_BY_STATUS: Record<string, string | undefined> = {
  stopped: "Stopped",
  declined: "Declined",
  failed: "Failed",
  inProgress: "Running",
};

export function liveWorkEntryLabel(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
  turnActive: boolean,
): string {
  const liveStatus = liveActivityToolStatus(workEntry.toolLifecycleStatus, turnActive);
  const presentation = activityRowToolLook({
    ...workEntry,
    toolLifecycleStatus: liveStatus,
  });
  if (presentation) return presentation.displayName;

  const command = workEntry.command?.trim();
  if (!command) {
    return activityRowLabel(workEntry, workspaceRoot);
  }
  const verb = (liveStatus && COMMAND_VERB_BY_STATUS[liveStatus]) || "Ran";
  return `${verb} ${commandProgramName(command) ?? "command"}`;
}

export function workEntryIsVisibleInGroup(
  logEntry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (!activityRowIndicatesToolNeutralStatus(logEntry)) {
    return true;
  }
  const showsLiveProgress =
    logEntry.toolLifecycleStatus === "inProgress" ||
    logEntry.sourceActivityKind === "task.progress";
  return expandedToolGroupEntry && showsLiveProgress;
}

// ---------------------------------------------------------------------------
// Scroll helpers

export interface WorkGroupScrollAnchor {
  readonly offset: number;
  readonly entryId: string;
}

export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { viewOffset: number; index: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index === -1 ? undefined : { index, viewOffset: -anchor.offset };
}

/** Only newly appended calls follow the end; status and output updates never do. */
export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ id: string }>,
  entries: ReadonlyArray<{ id: string }>,
  distanceFromEnd: number,
): boolean {
  if (previous.length === 0 || entries.length <= previous.length) return false;
  if (!(distanceFromEnd <= 1)) return false;
  return previous.every((entry, index) => entries[index]?.id === entry.id);
}

export interface TranscriptEndState {
  readonly contentLength?: number;
  readonly scrollLength?: number;
  readonly isAtEnd?: boolean;
  readonly scroll?: number;
}

const FOLLOW_REARM_BAND_PX = 40;

export function resolveTranscriptIsAtEnd(
  state: TranscriptEndState | undefined,
): boolean | undefined {
  if (!state) return undefined;
  const { contentLength, scrollLength, scroll } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  return contentLength - scroll - scrollLength <= FOLLOW_REARM_BAND_PX;
}

// ---------------------------------------------------------------------------
// Prose heuristics

const INSIGHT_BANNER = /^★ Insight[\s─]/m;
const NON_VERSE_LINE_START = /^(?:[-*+>#|]|\d+[.)]\s)/;

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  if (INSIGHT_BANNER.test(text)) return true;
  if (text.includes("```")) return false;
  return text.split(/\n[ \t]*\n/).some((paragraph) => {
    const lines = paragraph.split("\n");
    if (lines.length < 2 || lines.length > 12) return false;
    return lines.every((raw) => {
      const line = raw.trim();
      return line.length > 0 && line.length <= 72 && !NON_VERSE_LINE_START.test(line);
    });
  });
}

// ---------------------------------------------------------------------------
// Row model

export interface TranscriptDurationMessage {
  role: "user" | "assistant" | "system";
  streaming: boolean;
  updatedAt: string;
  createdAt: string;
  id: string;
}

export type TranscriptLatestTurn = Pick<
  ChatLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

type WorkToggleToolIcon = "browser" | "device" | "kora-code" | "pull-request";

export type TranscriptRowEntry =
  | {
      id: string;
      kind: "work";
      createdAt: string;
      displayLabel?: string;
      isExpandedToolGroup: boolean;
      groupedEntries: WorkLogEntry[];
    }
  | {
      groupedEntries: WorkLogEntry[];
      entry: WorkLogEntry;
      kind: "work-live";
      expanded: boolean;
      createdAt: string;
      groupId: string;
      active: boolean;
      id: string;
    }
  | {
      toolSurface?: WorkLogEntry["toolSurface"];
      summaryToolIcon?: WorkToggleToolIcon;
      toolIcon?: WorkLogEntry["toolIcon"];
      summaryKind: ToolGroupSummaryKind;
      turnId?: TurnId | null;
      kind: "work-toggle";
      hiddenCount: number;
      hasFailure: boolean;
      expanded: boolean;
      createdAt: string;
      summary: string;
      groupId: string;
      id: string;
    }
  | {
      kind: "turn-fold";
      expanded: boolean;
      createdAt: string;
      turnId: TurnId;
      label: string;
      id: string;
    }
  | { kind: "context-compaction"; id: string; createdAt: string; label: string }
  | {
      kind: "mode-notice";
      id: string;
      createdAt: string;
      noticeKind: NonNullable<ChatMessage["notice"]>["kind"] | "group-note";
      from: ThreadAgentMode | null;
      to: ThreadAgentMode | null;
      text: string;
    }
  | {
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      showAssistantMeta: boolean;
      durationStart: string;
      message: ChatMessage;
      createdAt: string;
      kind: "message";
      id: string;
    }
  | {
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      kind: "assistant-meta";
      message: ChatMessage;
      createdAt: string;
      id: string;
    }
  | { kind: "proposed-plan"; id: string; createdAt: string; proposedPlan: PlanProposal }
  | { kind: "blob-card"; id: string; createdAt: string; card: BlobCardRef; label: string }
  | { kind: "working"; id: string; createdAt: string | null; showBlob?: boolean }
  | { kind: "thinking"; id: string; createdAt: string | null }
  | {
      kind: "queued-message";
      id: string;
      createdAt: string;
      queuedMessage: QueuedPromptMessage;
      isNext: boolean;
    };

type Row<K extends TranscriptRowEntry["kind"]> = Extract<TranscriptRowEntry, { kind: K }>;

export interface StableTranscriptRowsState {
  byId: Map<string, TranscriptRowEntry>;
  result: TranscriptRowEntry[];
}

type DeriveInput = {
  timelineEntries: ReadonlyArray<TranscriptItem>;
  latestTurn?: TranscriptLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  liveAgentTaskIds?: ReadonlySet<string> | undefined;
  queuedMessages?: ReadonlyArray<QueuedPromptMessage>;
};

export interface TranscriptRowsProjection {
  readonly input: DeriveInput;
  readonly rows: TranscriptRowEntry[];
}

// ---------------------------------------------------------------------------
// Message helpers

export function computeMessageDurationStart(
  messages: ReadonlyArray<TranscriptDurationMessage>,
): Map<string, string> {
  const starts = new Map<string, string>();
  let boundary: string | null = null;
  for (const message of messages) {
    if (message.role === "user") boundary = message.createdAt;
    starts.set(message.id, boundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) boundary = message.updatedAt;
  }
  return starts;
}

export function resolveAssistantMessageCopyState(args: {
  showCopyButton: boolean;
  text: string | null;
  streaming: boolean;
}): { text: string | null; visible: boolean } {
  const hasText = args.text !== null && args.text.trim().length > 0;
  const visible = args.showCopyButton && hasText && !args.streaming;
  if (!hasText || args.text === null) return { text: null, visible };
  return { text: visible ? renderCodexDirectivesForCopy(args.text) : args.text, visible };
}

// ---------------------------------------------------------------------------
// Derivation

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";
const WORKING_ROW_ID = "working-indicator-row";

function isWorkItem(item: TranscriptItem): item is Extract<TranscriptItem, { kind: "work" }> {
  return item.kind === "work";
}

function itemTurnId(item: TranscriptItem): TurnId | null {
  switch (item.kind) {
    case "message":
      return item.message.turnId ?? null;
    case "proposed-plan":
      return item.proposedPlan.turnId ?? null;
    case "work":
      return item.entry.turnId ?? null;
  }
}

/** Work that always gets its own row: it never joins a group and never folds away. */
function standsAlone(entry: WorkLogEntry): boolean {
  return (
    entry.agentSpawn !== undefined ||
    entry.questionAnswer !== undefined ||
    entry.blobCard !== undefined ||
    entry.sourceActivityKind === "context-compaction" ||
    entry.tone === "error"
  );
}

function isCompaction(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "context-compaction";
}

function groupIdentity(entry: WorkLogEntry, transcriptId: string): string {
  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : transcriptId;
}

function spawnTaskIds(entry: WorkLogEntry): string[] {
  const spawn = entry.agentSpawn;
  if (!spawn) return [];
  return spawn.workflowId ? [spawn.workflowId, ...spawn.agentTaskIds] : [...spawn.agentTaskIds];
}

function elapsedMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function toolIconKind(entry: WorkLogEntry): WorkToggleToolIcon | undefined {
  return activityRowToolLook(entry, "completed")?.icon;
}

function visibleGroupEntries(
  group: ReadonlyArray<{ entry: WorkLogEntry; expandedVariant: boolean }>,
): WorkLogEntry[] {
  const visible = group
    .filter(({ entry, expandedVariant }) => workEntryIsVisibleInGroup(entry, expandedVariant))
    .map(({ entry }) => entry);
  return omitSupersededLifecycleMarkers(visible, (entry) => entry);
}

function toggleRow(args: {
  transcriptId: string;
  createdAt: string;
  entries: WorkLogEntry[];
  groupId: string;
  expanded: boolean;
}): Row<"work-toggle"> {
  const { entries } = args;
  const toolLike = entries.filter((entry) => activityRowIsToolLike(entry));
  const single = entries.length === 1 ? entries[0]! : null;
  const singleAction = single && activityRowIsToolLike(single) ? toolGroupAction(single) : null;

  let summary: string;
  if (single && singleAction && singleAction !== "edit") {
    summary = singleToolCallLabel(single);
  } else if (single && !activityRowIsToolLike(single)) {
    summary = single.label;
  } else {
    summary = summarizeToolGroup(entries);
  }

  const sourced = entries.find((entry) => entry.toolSource !== undefined);
  const lastDefined = <K extends "toolSurface" | "toolIcon">(key: K) => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const value = entries[index]![key];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const toolSurface = sourced?.toolSurface ?? lastDefined("toolSurface");
  const sourceKey = sourced?.toolSource?.key;
  const toolIcon =
    (sourceKey !== undefined
      ? entries.find((entry) => entry.toolSource?.key === sourceKey && entry.toolIcon !== undefined)
          ?.toolIcon
      : undefined) ?? lastDefined("toolIcon");

  const lastToolLike = toolLike.at(-1);
  const summaryToolIcon =
    single && singleAction && singleAction !== "edit" ? toolIconKind(single) : undefined;

  const first = entries[0]!;
  return {
    kind: "work-toggle",
    id: `work-toggle:${args.transcriptId}`,
    createdAt: args.createdAt,
    turnId: first.turnId ?? null,
    groupId: args.groupId,
    hiddenCount: entries.length,
    expanded: args.expanded,
    summary,
    summaryKind: toolGroupSummaryKind(entries),
    ...(toolSurface !== undefined ? { toolSurface } : {}),
    ...(toolIcon !== undefined ? { toolIcon } : {}),
    ...(summaryToolIcon !== undefined ? { summaryToolIcon } : {}),
    hasFailure: lastToolLike ? activityRowShowsFailure(lastToolLike) : false,
  };
}

export function deriveTranscriptRows(input: DeriveInput): TranscriptRowEntry[] {
  const items = input.timelineEntries;
  const count = items.length;
  const expandedTurns = input.expandedTurnIds;
  const expandedGroups = input.expandedWorkGroupIds;
  const { latestTurn, isWorking } = input;

  // ---- who is the user's latest prompt, who is terminal ----
  let lastUserIndex = -1;
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items[index]!;
    if (item.kind !== "message") continue;
    messages.push(item.message);
    if (item.message.role === "user") lastUserIndex = index;
  }
  const durationStarts = computeMessageDurationStart(messages);

  const terminalAssistantIds = new Set<string>();
  {
    const lastByKey = new Map<string, string>();
    let unkeyed = 0;
    for (const item of items) {
      if (item.kind !== "message") continue;
      const { message } = item;
      if (message.role === "user") {
        if (message.turnId === null) unkeyed += 1;
        continue;
      }
      if (message.role !== "assistant") continue;
      lastByKey.set(message.turnId ?? `unkeyed:${unkeyed}`, message.id);
    }
    for (const id of lastByKey.values()) terminalAssistantIds.add(id);
  }

  // ---- which turn is still live ----
  const latestSettled =
    latestTurn != null && latestTurn.completedAt != null && latestTurn.state !== "running";
  const unsettledTurnId: TurnId | null =
    input.runningTurnId ?? (latestTurn && !latestSettled ? latestTurn.turnId : null);

  const headerIndex = isWorking ? lastUserIndex + 1 : -1;

  const activeVisualTurnIds = new Set<TurnId>();
  if (unsettledTurnId !== null) {
    activeVisualTurnIds.add(unsettledTurnId);
    if (isWorking) {
      for (let index = lastUserIndex + 1; index < count; index += 1) {
        const turnId = itemTurnId(items[index]!);
        if (turnId !== null) activeVisualTurnIds.add(turnId);
      }
    }
  }

  const inActiveTurn = (index: number): boolean =>
    isWorking &&
    index >= headerIndex &&
    (unsettledTurnId === null || itemTurnId(items[index]!) === unsettledTurnId);

  // ---- turn folds ----
  type Fold = { turnId: TurnId; anchorIndex: number; label: string; expanded: boolean };
  const foldAtIndex = new Map<number, Fold>();
  const collapsedIndexes = new Set<number>();
  {
    const byTurn = new Map<TurnId, number[]>();
    for (let index = 0; index < count; index += 1) {
      const item = items[index]!;
      const turnId = itemTurnId(item);
      if (turnId === null) continue;
      if (item.kind === "proposed-plan") continue;
      if (item.kind === "message" && item.message.role !== "assistant") continue;
      const list = byTurn.get(turnId);
      if (list) list.push(index);
      else byTurn.set(turnId, [index]);
    }

    for (const [turnId, indexes] of byTurn) {
      if (activeVisualTurnIds.has(turnId)) continue;
      if (
        indexes.some((i) => {
          const item = items[i]!;
          return item.kind === "message" && item.message.streaming;
        })
      ) {
        continue;
      }

      const terminalIndex = indexes.find((i) => {
        const item = items[i]!;
        return item.kind === "message" && terminalAssistantIds.has(item.message.id);
      });
      const hidden = indexes.filter((i) => {
        if (i === terminalIndex) return false;
        const item = items[i]!;
        if (isWorkItem(item)) {
          const entry = item.entry;
          if (entry.questionAnswer || entry.agentSpawn || entry.blobCard) return false;
        }
        return true;
      });
      if (hidden.length === 0) continue;
      const hiddenHasMessage = hidden.some((i) => items[i]!.kind === "message");
      if (
        !hiddenHasMessage &&
        hidden.every((i) => {
          const item = items[i]!;
          return isWorkItem(item) && isCompaction(item.entry);
        })
      ) {
        continue;
      }

      const isLatest = latestTurn?.turnId === turnId;
      const interrupted = isLatest && latestTurn?.state === "interrupted";
      let elapsed: number | null = null;
      if (isLatest && latestTurn?.startedAt && latestTurn.completedAt) {
        elapsed = elapsedMs(latestTurn.startedAt, latestTurn.completedAt);
      } else {
        const firstIndex = indexes[0]!;
        let boundary: string | null = null;
        for (let index = firstIndex - 1; index >= 0; index -= 1) {
          const item = items[index]!;
          if (item.kind === "message" && item.message.role === "user") {
            boundary = item.message.createdAt;
            break;
          }
        }
        const start = boundary ?? items[firstIndex]!.createdAt;
        let end = start;
        for (const i of indexes) {
          const item = items[i]!;
          const itemEnd = item.kind === "message" ? item.message.updatedAt : item.createdAt;
          if (Date.parse(itemEnd) > Date.parse(end)) end = itemEnd;
        }
        elapsed = elapsedMs(start, end);
      }
      const duration = elapsed !== null && elapsed >= 0 ? formatDuration(elapsed) : null;
      let label = duration ? `Worked for ${duration}` : "Worked";
      if (interrupted) {
        label = duration ? `You stopped after ${duration}` : "You stopped this response";
      }

      const expanded = expandedTurns?.has(turnId) ?? false;
      const anchorIndex = hidden[0]!;
      foldAtIndex.set(anchorIndex, { turnId, anchorIndex, label, expanded });
      if (!expanded) for (const i of hidden) collapsedIndexes.add(i);
    }
  }

  // ---- the live tool run at the tail of the active turn ----
  const activeRun: number[] = [];
  if (isWorking) {
    for (let index = count - 1; index >= headerIndex; index -= 1) {
      const item = items[index]!;
      if (!isWorkItem(item) || !inActiveTurn(index)) break;
      const entry = item.entry;
      if (entry.questionAnswer || entry.blobCard || isCompaction(entry) || entry.tone === "error") {
        break;
      }
      activeRun.push(index);
    }
    activeRun.reverse();
  }
  const activeRunSet = new Set(activeRun);

  type LiveActivity = {
    at: number;
    entry: WorkLogEntry;
    entries: WorkLogEntry[];
    groupId: string;
    keepsLive: boolean;
    active: boolean;
  };
  let live: LiveActivity | null = null;
  let latestToolFailed = false;
  if (activeRun.length > 0) {
    const visibleIndexes = activeRun.filter((index) =>
      workEntryIsVisibleInGroup(
        (items[index] as Extract<TranscriptItem, { kind: "work" }>).entry,
        true,
      ),
    );
    const visibleEntries = omitSupersededLifecycleMarkers(
      visibleIndexes.map(
        (index) => (items[index] as Extract<TranscriptItem, { kind: "work" }>).entry,
      ),
      (entry) => entry,
    );
    const latestVisible = visibleEntries.at(-1);
    if (latestVisible) {
      const liveTaskIds = input.liveAgentTaskIds;
      const isRunning = (entry: WorkLogEntry): boolean => {
        if (entry.agentSpawn) {
          return (
            entry === latestVisible &&
            liveTaskIds !== undefined &&
            spawnTaskIds(entry).some((id) => liveTaskIds.has(id))
          );
        }
        if (entry.toolLifecycleStatus === "inProgress") return true;
        return (
          entry.toolLifecycleStatus === undefined &&
          (entry.sourceActivityKind === "task.progress" || activityRowIsToolLike(entry))
        );
      };
      let latestRunning: WorkLogEntry | undefined;
      for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
        if (isRunning(visibleEntries[index]!)) {
          latestRunning = visibleEntries[index]!;
          break;
        }
      }
      latestToolFailed =
        latestRunning === undefined &&
        latestVisible.toolLifecycleStatus !== "declined" &&
        activityRowShowsFailure(latestVisible);
      const keepsLive =
        latestRunning !== undefined ||
        (latestVisible.agentSpawn === undefined &&
          (activityRowSucceeded(latestVisible) ||
            (latestVisible.toolLifecycleStatus === "completed" &&
              !activityRowShowsFailure(latestVisible))));

      if (!latestToolFailed) {
        const anchorItem = items[activeRun[0]!] as Extract<TranscriptItem, { kind: "work" }>;
        const latestIndex = activeRun.findLast(
          (index) =>
            (items[index] as Extract<TranscriptItem, { kind: "work" }>).entry === latestVisible,
        )!;
        live = {
          at: latestIndex,
          entry: latestRunning ?? latestVisible,
          entries: visibleEntries,
          groupId: `work-group:${groupIdentity(anchorItem.entry, anchorItem.id)}`,
          keepsLive,
          active: keepsLive,
        };
      }
    }
  }

  const rows: TranscriptRowEntry[] = [];
  const working: { row: Row<"working"> | null } = { row: null };

  const pushWorking = () => {
    if (working.row) return;
    const spansMany = activeVisualTurnIds.size > 1;
    const latestUser = lastUserIndex >= 0 ? items[lastUserIndex]!.createdAt : null;
    working.row = {
      kind: "working",
      id: WORKING_ROW_ID,
      createdAt: spansMany && latestUser ? latestUser : input.activeTurnStartedAt,
      showBlob: true,
    };
    rows.push(working.row);
  };

  const pushDetails = (groupId: string, createdAt: string, entries: WorkLogEntry[]) => {
    rows.push({
      kind: "work",
      id: `${groupId}:details`,
      createdAt,
      groupedEntries: entries,
      isExpandedToolGroup: true,
    });
  };

  const pushLive = (args: {
    id: string;
    createdAt: string;
    entry: WorkLogEntry;
    entries: WorkLogEntry[];
    groupId: string;
    active: boolean;
  }) => {
    const expanded = expandedGroups?.has(args.groupId) ?? false;
    rows.push({
      kind: "work-live",
      id: args.id,
      createdAt: args.createdAt,
      entry: args.entry,
      groupedEntries: args.entries,
      groupId: args.groupId,
      expanded,
      active: args.active,
    });
    if (expanded && !args.entry.agentSpawn) pushDetails(args.groupId, args.createdAt, args.entries);
  };

  for (let index = 0; index < count; index += 1) {
    if (isWorking && index === headerIndex) pushWorking();

    if (live && live.at === index) {
      const at = items[index]!.createdAt;
      const identity = live.groupId.slice("work-group:".length);
      pushLive({
        id: live.keepsLive ? LIVE_ACTIVITY_ROW_ID : `work-live:${identity}`,
        createdAt: at,
        entry: live.entry,
        entries: live.entries,
        groupId: live.groupId,
        active: live.active,
      });
    }

    const fold = foldAtIndex.get(index);
    if (fold) {
      rows.push({
        kind: "turn-fold",
        id: `turn-fold:${fold.turnId}`,
        createdAt: items[index]!.createdAt,
        turnId: fold.turnId,
        label: fold.label,
        expanded: fold.expanded,
      });
    }

    if (collapsedIndexes.has(index) || activeRunSet.has(index)) continue;

    const item = items[index]!;

    if (item.kind === "proposed-plan") {
      rows.push({
        kind: "proposed-plan",
        id: item.id,
        createdAt: item.createdAt,
        proposedPlan: item.proposedPlan,
      });
      continue;
    }

    if (item.kind === "message") {
      const { message } = item;
      if (message.kind === "note") {
        rows.push({
          kind: "mode-notice",
          id: item.id,
          createdAt: item.createdAt,
          noticeKind: "group-note",
          from: null,
          to: null,
          text: message.text,
        });
        continue;
      }
      if (message.role === "user" && message.notice) {
        rows.push({
          kind: "mode-notice",
          id: item.id,
          createdAt: item.createdAt,
          noticeKind: message.notice.kind,
          from: (message.notice.from as ThreadAgentMode | undefined) ?? null,
          to: (message.notice.to as ThreadAgentMode | undefined) ?? null,
          text: message.text,
        });
        continue;
      }
      const inActiveResponse = message.turnId !== null && activeVisualTurnIds.has(message.turnId);
      const showMeta =
        message.role === "assistant" && terminalAssistantIds.has(message.id) && !inActiveResponse;
      rows.push({
        kind: "message",
        id: item.id,
        createdAt: item.createdAt,
        message,
        durationStart: durationStarts.get(message.id) ?? message.createdAt,
        showAssistantMeta: showMeta,
        showAssistantCopyButton: showMeta,
        assistantCopyStreaming: message.streaming || inActiveResponse,
      });
      continue;
    }

    // ---- work entries ----
    const entry = item.entry;

    if (entry.blobCard) {
      rows.push({
        kind: "blob-card",
        id: item.id,
        createdAt: item.createdAt,
        card: entry.blobCard,
        label: entry.label,
      });
      continue;
    }

    const midTurn = inActiveTurn(index);
    const runningInActiveRun = midTurn && entry.toolLifecycleStatus === "inProgress";
    if (midTurn && !standsAlone(entry) && !runningInActiveRun) continue;

    if (isCompaction(entry)) {
      rows.push({
        kind: "context-compaction",
        id: item.id,
        createdAt: item.createdAt,
        label: entry.label,
      });
      continue;
    }

    if (standsAlone(entry)) {
      rows.push({
        kind: "work",
        id: item.id,
        createdAt: item.createdAt,
        groupedEntries: [entry],
        isExpandedToolGroup: false,
      });
      continue;
    }

    // Group the plain work that follows.
    const group: Array<{ entry: WorkLogEntry; expandedVariant: boolean; transcriptId: string }> =
      [];
    let end = index;
    for (; end < count; end += 1) {
      const next = items[end]!;
      if (!isWorkItem(next)) break;
      if (end > index) {
        if (
          end === headerIndex ||
          standsAlone(next.entry) ||
          activeRunSet.has(end) ||
          collapsedIndexes.has(end) ||
          foldAtIndex.has(end)
        ) {
          break;
        }
        const nextMid = inActiveTurn(end);
        if (nextMid && next.entry.toolLifecycleStatus !== "inProgress") break;
      }
      group.push({
        entry: next.entry,
        expandedVariant: inActiveTurn(end) && next.entry.toolLifecycleStatus === "inProgress",
        transcriptId: next.id,
      });
    }
    index = end - 1;

    const visible = visibleGroupEntries(group);
    if (visible.length === 0) continue;

    const anchor = group[0]!;
    const identity = groupIdentity(anchor.entry, anchor.transcriptId);
    const groupId = `work-group:${identity}`;

    const runningEntries = visible.filter(
      (candidate) =>
        candidate.toolLifecycleStatus === "inProgress" &&
        group.some((member) => member.entry === candidate && member.expandedVariant),
    );
    if (runningEntries.length > 0) {
      pushLive({
        id: `work-live:${identity}`,
        createdAt: item.createdAt,
        entry: runningEntries.at(-1)!,
        entries: visible,
        groupId,
        active: true,
      });
      continue;
    }

    const first = visible[0]!;
    if (visible.length === 1 && activityRowIsToolLike(first)) {
      rows.push({
        kind: "work",
        id: anchor.transcriptId,
        createdAt: item.createdAt,
        groupedEntries: visible,
        isExpandedToolGroup: false,
        displayLabel:
          toolGroupAction(first) === "edit"
            ? summarizeToolGroup([first])
            : singleToolCallLabel(first),
      });
      continue;
    }

    const expanded = expandedGroups?.has(groupId) ?? false;
    rows.push(
      toggleRow({
        transcriptId: anchor.transcriptId,
        createdAt: item.createdAt,
        entries: visible,
        groupId,
        expanded,
      }),
    );
    if (expanded) pushDetails(groupId, item.createdAt, visible);
  }

  if (isWorking && headerIndex >= count) pushWorking();

  if (isWorking && rows.at(-1) !== working.row) {
    const hasLiveActivityRow = rows.some((row) => row.id === LIVE_ACTIVITY_ROW_ID);
    if (!hasLiveActivityRow || latestToolFailed) {
      rows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt,
      });
    }
  }

  // The blob only bounces at the tail.
  const lastRow = rows.at(-1);
  const finalRows = rows.map((row) =>
    row === working.row && lastRow !== row ? { ...row, showBlob: false } : row,
  );

  const withMeta = attachTrailingToolGroups(finalRows);

  input.queuedMessages?.forEach((queued, position) => {
    withMeta.push({
      kind: "queued-message",
      id: `queued-message:${queued.id}`,
      createdAt: queued.createdAt,
      queuedMessage: queued,
      isNext: position === 0,
    });
  });
  return withMeta;
}

/**
 * When tool groups trail an assistant answer, the copy/meta footer belongs after them so it covers
 * the prose and the tools as one response.
 */
function attachTrailingToolGroups(rows: TranscriptRowEntry[]): TranscriptRowEntry[] {
  const replaced = new Map<number, TranscriptRowEntry>();
  const footerAfter = new Map<number, TranscriptRowEntry>();

  rows.forEach((row, index) => {
    if (row.kind !== "message" || !row.showAssistantMeta || row.message.turnId === null) return;
    const turnId = row.message.turnId;
    let lastTrailing = -1;
    for (let next = index + 1; next < rows.length; next += 1) {
      const candidate = rows[next]!;
      if (candidate.kind === "message") break;
      const trailsTools =
        (candidate.kind === "work-toggle" && candidate.turnId === turnId) ||
        (candidate.kind === "work" &&
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) => entry.turnId === turnId && activityRowIsToolLike(entry),
          ));
      if (trailsTools) lastTrailing = next;
    }
    if (lastTrailing === -1) return;
    replaced.set(index, { ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    footerAfter.set(lastTrailing, {
      createdAt: rows[lastTrailing]!.createdAt ?? row.createdAt,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
      id: `assistant-meta:${row.message.id}`,
      kind: "assistant-meta",
      message: row.message,
    });
  });

  if (replaced.size === 0) return rows;
  const result: TranscriptRowEntry[] = [];
  rows.forEach((row, index) => {
    result.push(replaced.get(index) ?? row);
    const footer = footerAfter.get(index);
    if (footer) result.push(footer);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Streaming reuse

function sameContext(a: DeriveInput, b: DeriveInput): boolean {
  return (
    a.isWorking === b.isWorking &&
    a.activeTurnStartedAt === b.activeTurnStartedAt &&
    a.runningTurnId === b.runningTurnId &&
    a.queuedMessages === b.queuedMessages &&
    shallow(a.latestTurn ?? null, b.latestTurn ?? null) &&
    shallow(a.expandedTurnIds ?? null, b.expandedTurnIds ?? null) &&
    shallow(a.expandedWorkGroupIds ?? null, b.expandedWorkGroupIds ?? null) &&
    shallow(a.liveAgentTaskIds ?? null, b.liveAgentTaskIds ?? null)
  );
}

export function deriveTranscriptRowsWithState(
  input: DeriveInput,
  previous?: TranscriptRowsProjection | null,
): TranscriptRowsProjection {
  if (previous && previous.input.timelineEntries.length === input.timelineEntries.length) {
    const replacements = reuseableMessageReplacements(previous.input, input);
    if (replacements) {
      if (replacements.size === 0) return { input, rows: previous.rows };
      let changed = false;
      const rows = previous.rows.map((row) => {
        if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
        const replacement = replacements.get(row.message);
        if (!replacement) return row;
        changed = true;
        return { ...row, message: replacement };
      });
      return { input, rows: changed ? rows : previous.rows };
    }
  }
  return { input, rows: deriveTranscriptRows(input) };
}

/** Old message -> new message when only streaming text grew; null when anything else moved. */
function reuseableMessageReplacements(
  previous: DeriveInput,
  next: DeriveInput,
): Map<ChatMessage, ChatMessage> | null {
  if (!sameContext(previous, next)) return null;
  const replacements = new Map<ChatMessage, ChatMessage>();
  for (let index = 0; index < next.timelineEntries.length; index += 1) {
    const before = previous.timelineEntries[index]!;
    const after = next.timelineEntries[index]!;
    if (before === after) continue;
    if (
      before.kind !== "message" ||
      after.kind !== "message" ||
      before.id !== after.id ||
      before.createdAt !== after.createdAt ||
      !isStreamingMessageTextUpdate(before.message, after.message)
    ) {
      return null;
    }
    replacements.set(before.message, after.message);
  }
  return replacements;
}

// ---------------------------------------------------------------------------
// Row identity

function isRowUnchanged(previous: TranscriptRowEntry, next: TranscriptRowEntry): boolean {
  if (previous === next) return true;
  if (previous.kind !== next.kind || previous.id !== next.id) return false;
  switch (previous.kind) {
    case "working": {
      const other = next as Row<"working">;
      return previous.createdAt === other.createdAt && previous.showBlob === other.showBlob;
    }
    case "thinking":
      return previous.createdAt === next.createdAt;
    case "assistant-meta": {
      const other = next as Row<"assistant-meta">;
      return (
        previous.createdAt === other.createdAt &&
        previous.message === other.message &&
        previous.showAssistantCopyButton === other.showAssistantCopyButton &&
        previous.assistantCopyStreaming === other.assistantCopyStreaming
      );
    }
    case "turn-fold": {
      const other = next as Row<"turn-fold">;
      return (
        previous.createdAt === other.createdAt &&
        previous.label === other.label &&
        previous.expanded === other.expanded
      );
    }
    case "context-compaction": {
      const other = next as Row<"context-compaction">;
      return previous.createdAt === other.createdAt && previous.label === other.label;
    }
    case "mode-notice": {
      const other = next as Row<"mode-notice">;
      return (
        previous.createdAt === other.createdAt &&
        previous.noticeKind === other.noticeKind &&
        previous.from === other.from &&
        previous.to === other.to &&
        previous.text === other.text
      );
    }
    case "proposed-plan":
      return previous.proposedPlan === (next as Row<"proposed-plan">).proposedPlan;
    case "blob-card": {
      const other = next as Row<"blob-card">;
      return (
        previous.createdAt === other.createdAt &&
        previous.label === other.label &&
        previous.card.version === other.card.version &&
        previous.card.payload === other.card.payload
      );
    }
    case "queued-message": {
      const other = next as Row<"queued-message">;
      return previous.queuedMessage === other.queuedMessage && previous.isNext === other.isNext;
    }
    case "work": {
      const other = next as Row<"work">;
      return (
        previous.isExpandedToolGroup === other.isExpandedToolGroup &&
        previous.displayLabel === other.displayLabel &&
        Equal.equals(previous.groupedEntries, other.groupedEntries)
      );
    }
    case "work-live": {
      const other = next as Row<"work-live">;
      return (
        previous.createdAt === other.createdAt &&
        previous.groupId === other.groupId &&
        previous.expanded === other.expanded &&
        previous.active === other.active &&
        Equal.equals(previous.entry, other.entry) &&
        Equal.equals(previous.groupedEntries, other.groupedEntries)
      );
    }
    case "work-toggle": {
      const other = next as Row<"work-toggle">;
      return (
        previous.createdAt === other.createdAt &&
        previous.turnId === other.turnId &&
        previous.groupId === other.groupId &&
        previous.hiddenCount === other.hiddenCount &&
        previous.expanded === other.expanded &&
        previous.summary === other.summary &&
        previous.summaryKind === other.summaryKind &&
        previous.toolSurface === other.toolSurface &&
        Equal.equals(previous.toolIcon, other.toolIcon) &&
        previous.hasFailure === other.hasFailure
      );
    }
    case "message": {
      const other = next as Row<"message">;
      return (
        previous.message === other.message &&
        previous.durationStart === other.durationStart &&
        previous.showAssistantMeta === other.showAssistantMeta &&
        previous.showAssistantCopyButton === other.showAssistantCopyButton &&
        previous.assistantCopyStreaming === other.assistantCopyStreaming
      );
    }
  }
}

export function computeStableTranscriptRows(
  rows: TranscriptRowEntry[],
  previous: StableTranscriptRowsState,
): StableTranscriptRowsState {
  const byId = new Map<string, TranscriptRowEntry>();
  const result: TranscriptRowEntry[] = [];
  let identical = previous.result.length === rows.length;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const old = previous.byId.get(row.id);
    const stable = old && isRowUnchanged(old, row) ? old : row;
    byId.set(row.id, stable);
    result.push(stable);
    if (previous.result[index] !== stable) identical = false;
  }
  return identical ? previous : { byId, result };
}

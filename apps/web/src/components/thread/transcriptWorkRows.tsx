import { isWorkerActivityKind } from "~/util/workerActivity";
import { cn } from "~/util/utils";
import { isGraphActivityKind } from "~/util/graphActivity";
import {
  resolveToolIconImageUrl,
  iconNameForSummaryKind,
  resolveEntryIcon,
  ToolIconImage,
  iconTakesTint,
  type WorkIconName,
  WorkGlyph,
} from "./transcriptWorkIcons";
import { useTranscriptActivity, useTranscriptShared } from "./transcriptContext";
import { deriveAgentSpawnSummary } from "./agentSpawnSummary";
import { useThreadSummary } from "~/atoms/entities";
import { leadName } from "../swarm/swarmTasks";
import { WorkerActivityRow } from "./WorkerActivityRow";
import {
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  workEntryIsVisibleInGroup,
  activityRowLabel,
  type TranscriptRowEntry,
  liveWorkEntryLabel,
} from "./ThreadTranscript.logic";
import { LeadBlob } from "./LeadBlob";
import { TurnTimer } from "./TurnTimer";
import { GraphActivityRow } from "./GraphActivityRow";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { formatWorkspaceRelativePath } from "../../workspace/filePathDisplay";
import {
  type WorkLogEntry,
  activityRowSignalsSevereFailure,
  activityRowIsToolLike,
  activityRowShowsFailure,
  formatDuration,
} from "../../thread/timeline";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  hasQuestionAnswer,
} from "@kora/client-runtime/worklog/user-input";
import { resolveWorkGroupScrollAnchor } from "@kora/client-runtime/worklog/scroll-anchor";
// Tool-activity rows of the transcript: the live line, the collapsed-group summary, plain entries (expandable
// to their command / output), subagent spawn batches, and the inner scroller that lists an expanded group.
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@kora/client-runtime/store/subagentRuntime";
import {
  type MouseEvent,
  useState,
  useRef,
  memo,
  useEffect,
  useMemo,
  type KeyboardEvent,
  useCallback,
  type ReactNode,
  useLayoutEffect,
} from "react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";
import { LegendList } from "@legendapp/list/react";

type Row<K extends TranscriptRowEntry["kind"]> = Extract<TranscriptRowEntry, { kind: K }>;

const ROW_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";
const GLYPH_CLASS = "size-4 stroke-[1.8]";
const MUTED_GLYPH_CLASS = "opacity-70 not-dark:brightness-[.6]";

// ---------------------------------------------------------------------------
// Small shared pieces

function FailedMark() {
  return <XIcon className="size-3 shrink-0 text-tool-error-icon/40" aria-hidden />;
}

function IconBox(props: {
  readonly tone: string;
  readonly failed?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn("relative flex size-6 shrink-0 items-center justify-center", props.tone)}
      {...(props.failed ? { role: "img", "aria-label": "Tool call failed" } : {})}
    >
      {props.children}
    </span>
  );
}

/** A work entry's glyph: its tool's favicon / logo when it has one, otherwise the resolved icon. */
function EntryGlyph(props: {
  readonly name: WorkIconName;
  readonly imageUrl: string | null;
  readonly muted: boolean;
}) {
  const glyph = (
    <WorkGlyph name={props.name} className={cn(GLYPH_CLASS, props.muted && MUTED_GLYPH_CLASS)} />
  );
  if (props.imageUrl === null) return glyph;
  return <ToolIconImage url={props.imageUrl} muted={props.muted} fallback={glyph} />;
}

function entryImageUrl(entry: WorkLogEntry, theme: "light" | "dark"): string | null {
  if (entry.sourceActivityKind === "runtime.warning") return null;
  return resolveToolIconImageUrl(entry.toolIcon ?? entry.toolSource?.icon, theme);
}

/** The shared "activity" line: icon (or the bouncing lead while it runs), label, optional elapsed timer. */
function LiveActivityRow(props: {
  readonly icon: ReactNode;
  readonly hasIcon: boolean;
  readonly label: ReactNode;
  readonly active: boolean;
  readonly failed: boolean;
  readonly startedAt: string | null;
  readonly iconTone: string;
  readonly trailing?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animated = props.active && !props.failed;
  // The turn's start time seeds the lead's working animation: one pick per turn, kept across tool rows.
  const turnSeed = useTranscriptActivity().activeTurnStartedAt;

  return (
    <div
      ref={containerRef}
      className="relative min-h-6 w-fit max-w-full overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <div
        className={cn(
          "flex min-h-6 items-center gap-1.5 py-0.5 text-secondary-label",
          props.hasIcon || animated ? "px-0.5" : "px-1",
        )}
      >
        {animated ? (
          <span className="flex size-6 shrink-0 items-center justify-center">
            <LeadBlob mood="working" seed={turnSeed} />
          </span>
        ) : props.hasIcon ? (
          <IconBox tone={props.iconTone} failed={props.failed}>
            {props.icon}
          </IconBox>
        ) : null}
        <span className="min-w-0 truncate">{props.label}</span>
        {animated ? <TurnTimer startedAt={props.startedAt} /> : null}
        {props.trailing}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live row (the tool call that is running right now)

function questionAnswerPreview(entry: WorkLogEntry): string {
  return entry.questionAnswer && hasQuestionAnswer(entry.questionAnswer)
    ? getQuestionAnswerPreview(entry.questionAnswer)
    : "";
}

export const LiveWorkRow = memo(function LiveWorkRow({ row }: { row: Row<"work-live"> }) {
  const shared = useTranscriptShared();
  const activity = useTranscriptActivity();
  const { entry } = row;

  if (entry.agentSpawn !== undefined) {
    return <AgentSpawnRow entry={entry} active={row.active} rowId={row.id} />;
  }

  const failed = activityRowShowsFailure(entry);
  const baseLabel = liveWorkEntryLabel(entry, shared.workspaceRoot, row.active);
  const answer = questionAnswerPreview(entry);
  const warning = entry.sourceActivityKind === "runtime.warning";
  const icon = warning
    ? { name: "circle-alert" as const, tone: "foreground" as const }
    : resolveEntryIcon(entry);
  const imageUrl = entryImageUrl(entry, shared.resolvedTheme);
  const tintable = iconTakesTint(icon.name, imageUrl !== null);

  const label: ReactNode = answer ? (
    <>
      {baseLabel}
      <span className={cn("ms-1.5", row.expanded ? "text-muted-foreground" : "text-foreground")}>
        {answer}
      </span>
    </>
  ) : (
    baseLabel
  );

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      aria-label={failed ? `${baseLabel}, tool call failed` : undefined}
      onClick={() => shared.actions.toggleWorkGroup(row.groupId, row.id)}
      className={cn(
        "flex min-h-6 w-full cursor-pointer items-center rounded-md text-left",
        ROW_FOCUS_RING,
      )}
    >
      <LiveActivityRow
        icon={<EntryGlyph name={icon.name} imageUrl={imageUrl} muted={icon.tone === "muted"} />}
        hasIcon
        label={label}
        active={row.active}
        failed={failed}
        startedAt={activity.activeTurnStartedAt}
        iconTone={failed && tintable ? "text-tool-error-icon/40" : "text-icon-muted"}
        trailing={failed && !tintable ? <FailedMark /> : null}
      />
    </button>
  );
});

// ---------------------------------------------------------------------------
// Collapsed-group summary

export const WorkToggleRow = memo(function WorkToggleRow({ row }: { row: Row<"work-toggle"> }) {
  const shared = useTranscriptShared();
  const name: WorkIconName =
    row.summaryToolIcon ?? row.toolSurface ?? iconNameForSummaryKind(row.summaryKind);
  const imageUrl = resolveToolIconImageUrl(row.toolIcon, shared.resolvedTheme);

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      onClick={() => shared.actions.toggleWorkGroup(row.groupId, row.id)}
      className={cn(
        "flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20",
        ROW_FOCUS_RING,
      )}
    >
      <span className="relative flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <EntryGlyph name={name} imageUrl={imageUrl} muted />
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{row.summary}</span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// Plain entries

/** The text shown when an entry is opened, without repeating what its one-line label already says. */
function buildToolCallExpandedBody(
  entry: WorkLogEntry,
  visibleLabel: string,
  workspaceRoot: string | undefined,
): string {
  const blocks: string[] = [];
  const add = (text: string | undefined) => {
    const trimmed = text?.trim();
    if (!trimmed || trimmed === visibleLabel.trim() || blocks.includes(trimmed)) return;
    blocks.push(trimmed);
  };

  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    let pretty: string | undefined;
    try {
      pretty = JSON.stringify(entry.toolData, null, 2);
    } catch {
      pretty = undefined;
    }
    if (pretty !== undefined) add(`MCP call\n${pretty}`);
  }

  const command = entry.command?.trim();
  const rawCommand = entry.rawCommand?.trim();
  if (rawCommand && rawCommand !== command) add(rawCommand);
  else add(command);

  add(entry.detail);

  const seen = new Set<string>();
  for (const file of entry.changedFiles ?? []) {
    const relative = formatWorkspaceRelativePath(file, workspaceRoot);
    if (seen.has(relative) || relative === entry.detail?.trim()) continue;
    seen.add(relative);
    add(relative);
  }
  return blocks.join("\n\n");
}

function entryIsExpandable(entry: WorkLogEntry, failed: boolean): boolean {
  if (entry.questionAnswer && hasQuestionAnswer(entry.questionAnswer)) return true;
  if (failed && entry.detail?.trim()) return true;
  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) return true;
  return Boolean(
    entry.rawCommand?.trim() ||
    entry.command?.trim() ||
    entry.detail?.trim() ||
    (entry.changedFiles && entry.changedFiles.length > 0),
  );
}

/** A click that ends a text selection should not fold the row; a plain click must still reach it. */
function withholdClickWhileSelecting(event: MouseEvent<HTMLElement>) {
  const selection = event.currentTarget.ownerDocument.getSelection?.();
  if (selection && !selection.isCollapsed) event.stopPropagation();
}

function QuestionHistory({ entry }: { entry: WorkLogEntry }) {
  const answer = entry.questionAnswer;
  if (!answer) return null;
  const questionIds = Object.keys(answer.answers);
  return (
    <div className="ms-7 mt-2 space-y-2">
      {questionIds.map((id) => (
        <div key={id}>
          {answer.questionTextById?.[id] ? (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {answer.questionTextById[id]}
            </p>
          ) : null}
          <p className="ms-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {getQuestionAnswerText(answer.answers[id]) || "—"}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The quiet note on a Read card Kora bounded: which lines the agent got, and a way to ask for the rest. */
export function boundedReadLabel(w: { offset: number; limit: number; total: number }): string {
  const end = Math.min(w.total, w.offset + w.limit - 1);
  return `read lines ${w.offset.toLocaleString()}\u2013${end.toLocaleString()} of ${w.total.toLocaleString()}`;
}
function BoundedReadChip(props: {
  readonly window: NonNullable<WorkLogEntry["readWindow"]>;
  readonly onShowAll: ((path: string, total: number) => void) | undefined;
}) {
  const { window: w, onShowAll } = props;
  return (
    <span
      className="flex shrink-0 items-baseline gap-1 text-xs text-muted-foreground"
      data-testid="bounded-read-chip"
    >
      <span>{boundedReadLabel(w)}</span>
      {onShowAll ? (
        <>
          <span aria-hidden>{"\u00b7"}</span>
          <button
            type="button"
            className="cursor-pointer rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
            aria-label={`Ask for all ${w.total} lines of this file`}
            onClick={(event) => {
              event.stopPropagation();
              onShowAll(w.path, w.total);
            }}
          >
            show all
          </button>
        </>
      ) : null}
    </span>
  );
}

const PlainActivityRow = memo(function PlainActivityRow(props: {
  readonly entry: WorkLogEntry;
  /** Row id of the transcript row this entry lives in (anchor for disclosure scroll-settling). */
  readonly rowId: string;
  readonly label?: string | undefined;
  /** Inside an expanded group's own list: tighter padding, and open/closed state outlives remounts. */
  readonly inGroup?: boolean;
}) {
  const { entry, rowId, inGroup = false } = props;
  const shared = useTranscriptShared();
  const leadShell = useThreadSummary(shared.threadRef ?? null);
  const view = shared.workGroupView;
  const [expanded, setExpanded] = useState(() => inGroup && view.expandedEntryIds.has(entry.id));

  if (entry.agentSpawn !== undefined) {
    return <AgentSpawnRow entry={entry} active={false} rowId={rowId} />;
  }
  if (isGraphActivityKind(entry.sourceActivityKind)) {
    return (
      <GraphActivityRow
        kind={entry.sourceActivityKind}
        summary={props.label ?? entry.label}
        payload={entry.graphActivityPayload}
      />
    );
  }
  if (isWorkerActivityKind(entry.sourceActivityKind)) {
    return (
      <WorkerActivityRow
        kind={entry.sourceActivityKind}
        summary={props.label ?? entry.label}
        payload={entry.graphActivityPayload}
        onOpenFleet={shared.onOpenFleet ?? undefined}
        lead={leadName(leadShell)}
      />
    );
  }

  const label = props.label ?? activityRowLabel(entry, shared.workspaceRoot);
  const failed = activityRowShowsFailure(entry);
  const toolLike = activityRowIsToolLike(entry);
  const warning = entry.sourceActivityKind === "runtime.warning";
  const destructive = failed && (activityRowSignalsSevereFailure(entry) || !toolLike);
  const icon = warning
    ? { name: "circle-alert" as const, tone: "foreground" as const }
    : resolveEntryIcon(entry);
  const imageUrl = entryImageUrl(entry, shared.resolvedTheme);
  const tintable = iconTakesTint(icon.name, imageUrl !== null);
  const expandable = entryIsExpandable(entry, failed);
  const answer = questionAnswerPreview(entry);

  const iconTone = warning
    ? "text-warning"
    : destructive
      ? "text-destructive"
      : failed
        ? "text-tool-error-icon/40"
        : icon.tone === "muted" || entry.tone === "tool"
          ? "text-icon-muted"
          : "text-foreground";
  const labelTone = warning
    ? "font-medium text-warning"
    : destructive
      ? "font-medium text-destructive"
      : toolLike
        ? "text-secondary-label"
        : "text-foreground/80";

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (inGroup) {
      if (next) view.expandedEntryIds.add(entry.id);
      else view.expandedEntryIds.delete(entry.id);
    }
    shared.actions.settleDisclosure(rowId, !next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    toggle();
  };

  const accessibleName = `${label}${answer ? `: ${answer}` : ""}${failed ? ", tool call failed" : ""}`;
  const body = expanded ? buildToolCallExpandedBody(entry, label, shared.workspaceRoot) : "";

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5",
        inGroup ? "py-0" : "py-0.5",
        expanded && "mb-1",
        expandable && cn("cursor-pointer hover:bg-accent/20", ROW_FOCUS_RING),
      )}
      {...(expandable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": accessibleName,
            "aria-expanded": expanded,
            onClick: toggle,
            onKeyDown,
          }
        : {})}
    >
      <div className="flex select-none items-center gap-1.5">
        <IconBox tone={iconTone}>
          <EntryGlyph name={icon.name} imageUrl={imageUrl} muted={icon.tone === "muted"} />
        </IconBox>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span
            className={cn(
              labelTone,
              expanded ? "cursor-text break-words whitespace-normal select-text" : "truncate",
            )}
            onClick={expanded ? withholdClickWhileSelecting : undefined}
          >
            {label}
          </span>
          {answer ? (
            <span
              className={cn(
                "min-w-0 truncate",
                !expanded ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {answer}
            </span>
          ) : null}
          {entry.readWindow ? (
            <BoundedReadChip
              window={entry.readWindow}
              onShowAll={shared.onAskWholeFile ?? undefined}
            />
          ) : null}
        </p>
        {failed && !destructive && !tintable ? <FailedMark /> : null}
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            !expandable && "invisible",
          )}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 text-icon-muted/70 transition-transform duration-200",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </span>
      </div>
      {expanded && expandable ? (
        entry.questionAnswer && hasQuestionAnswer(entry.questionAnswer) ? (
          <div onClick={(event) => event.stopPropagation()}>
            <QuestionHistory entry={entry} />
          </div>
        ) : body ? (
          <div
            className="ms-7 mt-1 cursor-text rounded-md bg-muted/40 px-3 py-2"
            onClick={(event) => event.stopPropagation()}
          >
            <pre className="max-h-64 overflow-auto font-mono text-[length:var(--font-size-code,0.6875rem)] leading-relaxed whitespace-pre-wrap text-secondary-label select-text">
              {body}
            </pre>
          </div>
        ) : null
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Subagent spawn batches

const STATUS_WORD: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

function memberMetrics(member: RuntimeSubagent): string {
  const parts: string[] = [];
  if (member.startedAt && member.completedAt) {
    const ms = Date.parse(member.completedAt) - Date.parse(member.startedAt);
    if (Number.isFinite(ms) && ms >= 0) parts.push(formatDuration(ms));
  }
  const tokens = member.usage?.totalTokens;
  if (tokens !== undefined && tokens > 0) parts.push(`${formatSubagentTokenCount(tokens)} tok`);
  return parts.join(" · ");
}

function memberStatusLabel(member: RuntimeSubagent): string {
  const word = STATUS_WORD[member.status];
  const metrics = memberMetrics(member);
  if (isActiveSubagentStatus(member.status) || metrics === "") return word;
  return member.status === "completed" ? metrics : `${word} · ${metrics}`;
}

function memberActivityText(member: RuntimeSubagent): string {
  if (isActiveSubagentStatus(member.status)) {
    return member.progress ?? (member.lastToolName ? `▸ ${member.lastToolName}` : "");
  }
  return member.error ?? member.result ?? member.progress ?? "";
}

function AgentMemberRow({ member }: { member: RuntimeSubagent }) {
  const [expanded, setExpanded] = useState(false);
  const activity = memberActivityText(member).trim();
  const expandable = activity.length > 0;
  const failed = member.status === "failed";
  const statusLabel = memberStatusLabel(member);
  const showRole = member.role !== null && member.role.toLowerCase() !== member.title.toLowerCase();
  const firstLine = activity.split("\n").find((line) => line.trim().length > 0) ?? "";
  const modelLabel = formatSubagentModelLabel(member.model, member.effort);

  const toggle = () => setExpanded((open) => !open);
  return (
    <div
      className={cn("rounded-md px-1 py-0.5", expandable && cn("cursor-pointer", ROW_FOCUS_RING))}
      {...(expandable
        ? {
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              toggle();
            },
            "aria-label": `${member.title}, ${statusLabel}`,
            "aria-expanded": expanded,
            onClick: toggle,
            role: "button",
            tabIndex: 0,
          }
        : {})}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            failed ? "text-tool-error-icon" : "text-foreground/80",
          )}
        >
          {member.title}
        </span>
        {showRole ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[0.65rem] text-muted-foreground">
            {member.role}
          </span>
        ) : null}
        <span className="ms-auto shrink-0 font-mono text-[0.7rem] tabular-nums text-muted-foreground">
          {statusLabel}
        </span>
      </div>
      {!expanded && firstLine ? (
        <p className="truncate text-xs text-muted-foreground">{firstLine}</p>
      ) : null}
      {expanded ? (
        <div
          className="mt-1 cursor-text rounded-md bg-muted/40 px-3 py-2"
          onClick={(event) => event.stopPropagation()}
        >
          <pre className="max-h-64 overflow-auto font-mono text-[length:var(--font-size-code,0.6875rem)] leading-relaxed whitespace-pre-wrap text-secondary-label select-text">
            {modelLabel ? `${activity}\n\n${modelLabel}` : activity}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function resolveSpawnMembers(
  entry: WorkLogEntry,
  model: ReturnType<typeof useTranscriptShared>["agentPanelModel"],
): {
  members: ReadonlyArray<RuntimeSubagent>;
  coordinator: RuntimeSubagent | undefined;
  name: string | null;
} {
  const spawn = entry.agentSpawn!;
  if (spawn.workflowId !== null) {
    const group = model.workflows.find((candidate) => candidate.workflow.id === spawn.workflowId);
    if (group) {
      return {
        members: [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers],
        coordinator: group.workflow,
        name: group.workflow.workflowName,
      };
    }
    return { members: [], coordinator: undefined, name: null };
  }
  const wanted = new Set(spawn.agentTaskIds);
  return {
    members: model.directAgents.filter((agent) => wanted.has(agent.id)),
    coordinator: undefined,
    name: null,
  };
}

function AgentSpawnRow(props: {
  readonly entry: WorkLogEntry;
  readonly active: boolean;
  readonly rowId: string;
}) {
  const shared = useTranscriptShared();
  const { entry } = props;
  const { members, coordinator, name } = resolveSpawnMembers(entry, shared.agentPanelModel);
  const summary = deriveAgentSpawnSummary({
    agents: members,
    agentCount: entry.agentSpawn!.agentTaskIds.length,
    coordinatorStatus: coordinator?.status,
  });
  const expanded = shared.expandedSpawnEntryIds.has(entry.id);
  const label = name ? `${summary.lead} · ${name}` : summary.lead;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => shared.actions.toggleSpawn(entry.id, props.rowId)}
        className={cn(
          "w-full cursor-pointer rounded-md text-left select-none hover:bg-accent/20",
          ROW_FOCUS_RING,
        )}
      >
        <LiveActivityRow
          icon={<WorkGlyph name="bot" className={GLYPH_CLASS} />}
          hasIcon
          label={label}
          active={summary.live && props.active}
          failed={summary.tone === "failed"}
          startedAt={null}
          iconTone="text-icon-muted"
          trailing={<span className="shrink-0 text-muted-foreground/70">· {summary.status}</span>}
        />
      </button>
      {expanded && members.length > 0 ? (
        <div className="mt-0.5 ms-7 flex flex-col">
          {members.map((member) => (
            <AgentMemberRow key={member.id} member={member} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups

function ExpandedWorkGroupEntries(props: {
  readonly row: Row<"work">;
  readonly entries: ReadonlyArray<WorkLogEntry>;
}) {
  const { row, entries } = props;
  const shared = useTranscriptShared();
  const view = shared.workGroupView;
  const listRef = useRef<LegendListRef | null>(null);

  // Where the reader left this list last time (kept per thread, outside React state).
  const restore = useMemo(
    () => resolveWorkGroupScrollIndex(entries, view.scrollAnchors.get(row.id)),
    // Only the mount-time position matters.
    [],
  );
  const [restoring, setRestoring] = useState(restore !== undefined);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [fades, setFades] = useState({ top: false, bottom: false });

  // Calls appended while the reader sits at the bottom keep following the bottom.
  const followRef = useRef({ entries, follow: false });
  if (followRef.current.entries !== entries) {
    const state = viewportHeight !== null ? listRef.current?.getState?.() : undefined;
    const distance = state
      ? state.contentLength - state.scroll - state.scrollLength
      : Number.POSITIVE_INFINITY;
    followRef.current = {
      entries,
      follow: shouldFollowWorkGroupAppend(followRef.current.entries, entries, distance),
    };
  }
  const follow = followRef.current.follow;

  const measure = useCallback(() => {
    const node = listRef.current?.getScrollableNode?.();
    if (!node) return;
    setViewportHeight((current) => (current === node.clientHeight ? current : node.clientHeight));
    const top = node.scrollTop > 1;
    const bottom = node.scrollHeight - node.scrollTop - node.clientHeight > 1;
    setFades((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, []);

  useLayoutEffect(() => {
    const node = listRef.current?.getScrollableNode?.();
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [measure]);

  const onScroll = useCallback(() => {
    measure();
    const state = listRef.current?.getState?.();
    if (!state) return;
    const anchor = resolveWorkGroupScrollAnchor(state);
    if (anchor)
      view.scrollAnchors.set(row.id, { entryId: anchor.rowId, offset: anchor.offsetWithinRow });
  }, [measure, row.id, view]);

  const onLoad = useCallback(() => {
    if (restore) {
      void listRef.current?.scrollToIndex?.({
        index: restore.index,
        viewOffset: restore.viewOffset,
        animated: false,
      });
    }
    setRestoring(false);
    measure();
  }, [measure, restore]);

  return (
    <LegendList
      ref={listRef}
      role="region"
      aria-label="Tool calls"
      tabIndex={0}
      data-tool-group-scroll=""
      className={cn(
        "max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden rounded-md [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 focus-visible:outline-none",
        getVirtualizedScrollFadeClassName(fades),
      )}
      data={entries as WorkLogEntry[]}
      keyExtractor={(entry: WorkLogEntry) => entry.id}
      estimatedItemSize={24}
      drawDistance={240}
      recycleItems
      maintainVisibleContentPosition
      {...(restore
        ? { initialScrollIndex: { index: restore.index, viewOffset: restore.viewOffset } }
        : {})}
      {...(restoring && restore ? { alwaysRender: { indices: [restore.index] } } : {})}
      {...(follow && viewportHeight
        ? {
            maintainScrollAtEnd: { animated: false, on: { dataChange: true } },
            maintainScrollAtEndThreshold: 1 / viewportHeight,
          }
        : {})}
      onLoad={onLoad}
      onScroll={onScroll}
      renderItem={({ item }: { item: WorkLogEntry }) => (
        <PlainActivityRow entry={item} rowId={row.id} inGroup />
      )}
    />
  );
}

export const WorkGroupSection = memo(function WorkGroupSection({ row }: { row: Row<"work"> }) {
  const entries = useMemo(
    () =>
      row.groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, row.isExpandedToolGroup),
      ),
    [row.groupedEntries, row.isExpandedToolGroup],
  );
  if (entries.length === 0) return null;

  if (row.isExpandedToolGroup) {
    return <ExpandedWorkGroupEntries row={row} entries={entries} />;
  }

  const railed = entries.length > 1;
  return (
    <section
      aria-label="Activity"
      className={cn("relative -mx-1 flex flex-col gap-px py-0.5", railed ? "pr-1 pl-3" : "px-1")}
    >
      {railed ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 left-1 w-px bg-border/70"
        />
      ) : null}
      {entries.map((entry) => (
        <PlainActivityRow
          key={entry.id}
          entry={entry}
          rowId={row.id}
          label={entries.length === 1 ? row.displayLabel : undefined}
        />
      ))}
    </section>
  );
});

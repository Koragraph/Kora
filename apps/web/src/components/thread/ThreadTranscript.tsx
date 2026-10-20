import { agentModeLabel } from "~/util/workerActivity";
import { watchVisibleAnimation } from "~/util/visibleAnimation";
import { cn } from "~/util/utils";
import {
  selectedMessageContextFragment,
  resolveUserMessageContext,
} from "~/util/contextChipRecords";
import { CLAUDE_NOT_SIGNED_IN_COPY, friendlyAgentErrorCopy } from "~/util/agentErrorCopy";
import { useReplyFootnoteTarget, type FootnoteHistoryPage } from "./useReplyFootnoteTarget";
import { WorkGroupSection, WorkToggleRow, LiveWorkRow } from "./transcriptWorkRows";
import { TurnTimer } from "./TurnTimer";
import {
  transcriptContentOverflowsViewport,
  CHAT_TRANSCRIPT_ANCHOR_OFFSET,
} from "./transcriptScrollAnchoring";
import {
  type UserContextChipEnvironment,
  handleUserMessageCopy,
  UserContextChip,
} from "./transcriptContextChips";
import {
  TranscriptActivityContext,
  TranscriptSharedContext,
  useTranscriptActivity,
  createWorkGroupView,
  useTranscriptShared,
  type TranscriptActivity,
  type TranscriptActions,
  type TranscriptShared,
} from "./transcriptContext";
import {
  shouldPreserveAssistantLineBreaks,
  resolveAssistantMessageCopyState,
  deriveTranscriptRowsWithState,
  computeStableTranscriptRows,
  type StableTranscriptRowsState,
  type TranscriptRowsProjection,
  resolveTranscriptIsAtEnd,
  type TranscriptLatestTurn,
  type TranscriptRowEntry,
} from "./ThreadTranscript.logic";
import { type ReplyFootnoteRequest, ReplyFootnoteSource } from "./ReplyFootnoteSource";
import { PlanProposalCard } from "./PlanProposalCard";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageAttachments } from "./MessageAttachments";
import { LeadBlob } from "./LeadBlob";
import { GraphTraceGlyph } from "./GraphTraceGlyph";
import type { ExpandedImageView } from "./ExpandedImageView";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Hint } from "../ui/hint";
import { Button } from "../ui/button";
import { SignedOutLoginAction } from "../onboarding/SignedOutLoginAction";
import { SetupCheck } from "../onboarding/SetupCheck";
import { bubbleShapeClassName, blobRowClassName } from "../blobs/transcript/skinClasses";
import { quietNoticeLabel } from "../blobs/transcript/quietNotice";
import {
  deriveBubbleGroups,
  sameBubbleGroups,
  type BubbleGroups,
} from "../blobs/transcript/grouping";
import {
  BlobAssistantFrame,
  BlobMessageMeta,
  BlobTypingRow,
  BlobBubble,
} from "../blobs/transcript/BlobBubbles";
import { BlobOutputCardGroup } from "../blobs/previews/BlobOutputCards";
import { useGroupThread } from "../blobs/groups/groupThreadContext";
import { deriveAuthorBubbleGroups, skinForAuthor } from "../blobs/groups/groupAuthors";
import { RoutedTo } from "../blobs/groups/RoutedTo";
import { GroupAssistantFrame } from "../blobs/groups/GroupAuthorFrame";
import { useBlobSkin, type BlobSkin } from "../blobs/chat/blobSkin";
import { BlobCardRow } from "../blobs/cards/BlobCardRow";
import {
  extractOutputPathsFromWorkLogEntry,
  extractOutputPathsFromMarkdown,
  dedupeOutputPaths,
} from "../assistant/outputs";
import { OutputCardGroup } from "../assistant/OutputCard";
import ReplyMarkdown from "../ReplyMarkdown";
import type { ChatMessage } from "../../types";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timeFormat";
import { deriveTranscriptEntries, type WorkLogEntry } from "../../thread/timeline";
import type { QueuedPromptMessage } from "../../stores/queuedMessageStore";
import { replaceContextChipReferences } from "@kora/shared/contextChipReferences";
import { resolveChatListAnchoredEndSpace } from "@kora/shared/transcriptAnchor";
import type { ClockFormat } from "@kora/contracts/clientPrefs";
import { CONTEXT_CHIP_CLIPBOARD_MIME } from "@kora/contracts";
import type { HostThreadRef, ReplyFootnote, HostId, ItemId, TurnId } from "@kora/contracts";
import type { AgentSkill } from "@kora/contracts";
// The chat transcript: a virtualised list of rows derived from the thread timeline. This file owns the list
// (scroll-follow, anchoring, disclosure state, footnote navigation) and the message-shaped rows; tool-activity
// rows live in transcriptWorkRows.tsx and the chips a user message carries in transcriptContextChips.tsx.
import {
  isTerminalSubagentStatus,
  isActiveSubagentStatus,
  emptyAgentPanelModel,
  type AgentPanelModel,
} from "@kora/client-runtime/store/subagentRuntime";
import { parseHostThreadKey } from "@kora/client-runtime/host";
import type { CodexArtifactTemplate } from "@kora/client-runtime/codex/artifact-templates";
import {
  useState,
  useLayoutEffect,
  useMemo,
  memo,
  type ReactNode,
  useCallback,
  useRef,
  type RefObject,
  useEffect,
} from "react";
import { RotateCcwIcon, WaypointsIcon, MinimizeIcon, HexagonIcon, ClockIcon } from "lucide-react";
import { type LegendListRef, LegendList } from "@legendapp/list/react";

export interface TranscriptInlineError {
  readonly messageId: string;
  readonly onRetry: (() => void) | null;
}

interface TranscriptProps {
  onCiteAssistantText?: (
    citation: ReplyFootnote,
    sourceAnchor: Parameters<
      NonNullable<React.ComponentProps<typeof AssistantSelectionToolbar>["onCite"]>
    >[1],
  ) => boolean;
  /** False when the thread's model does not need Claude: the Claude login card would mislead. Default true. */
  showSetupCheck?: boolean;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  skills?: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">>;
  timelineEntries: ReturnType<typeof deriveTranscriptEntries>;
  onAnchorReady: (id: ItemId, anchorIndex: number) => void;
  onContentOverflowChange?: (overflows: boolean) => void;
  queuedMessages?: ReadonlyArray<QueuedPromptMessage>;
  onImageExpand: (preview: ExpandedImageView) => void;
  citationRequest?: ReplyFootnoteRequest | null;
  onRemoveQueuedMessage?: (id: string) => void;
  onSteerQueuedMessage?: (id: string) => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  inlineError?: TranscriptInlineError | null;
  loadEarlier?: FootnoteHistoryPage | null;
  listRef: RefObject<LegendListRef | null>;
  onToolOutputCollapsedAtEnd?: () => void;
  latestTurn: TranscriptLatestTurn | null;
  activeTurnStartedAt: string | null;
  workspaceRoot: string | undefined;
  onOpenFleet?: (() => void) | null;
  onAskWholeFile?: ((path: string, total: number) => void) | null;
  contentInsetEndAdjustment: number;
  agentPanelModel?: AgentPanelModel;
  citationHistoryLoading?: boolean;
  resolvedTheme: "light" | "dark";
  markdownCwd: string | undefined;
  liveStatusLabel?: string | null;
  onManualNavigation: () => void;
  hideEmptyPlaceholder?: boolean;
  anchorMessageId: ItemId | null;
  timestampFormat: ClockFormat;
  runningTurnId: TurnId | null;
  isAssistantThread?: boolean;
  liveFollowEnabled: boolean;
  activeThreadHostId: HostId;
  displayThreadKey?: string;
  topFadeEnabled?: boolean;
  topBannerInset?: boolean;
  routeThreadKey: string;
  isCompacting?: boolean;
  isWorking: boolean;
}

type Row<K extends TranscriptRowEntry["kind"]> = Extract<TranscriptRowEntry, { kind: K }>;

const NO_SKILLS: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">> = [];
const NO_QUEUED: ReadonlyArray<QueuedPromptMessage> = [];
const NO_OUTPUT_PATHS: ReadonlyMap<string, ReadonlyArray<string>> = new Map();
const noop = () => {};
const TITLEBAR_FADE_HEIGHT = "var(--workspace-titlebar-scroll-fade-height)";
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;
const ASLEEP_AFTER_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Disclosure state (which turns / tool groups / spawn batches the reader opened)

interface Disclosure {
  readonly identity: string;
  readonly turnIds: ReadonlySet<TurnId>;
  readonly workGroupIds: ReadonlySet<string>;
  readonly spawnEntryIds: ReadonlySet<string>;
}

const emptyDisclosure = (identity: string): Disclosure => ({
  identity,
  turnIds: new Set(),
  workGroupIds: new Set(),
  spawnEntryIds: new Set(),
});

function withToggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Ids of subagents that can still change, as one stable set (so the row projection input keeps its identity). */
function useLiveAgentTaskIds(model: AgentPanelModel | undefined): ReadonlySet<string> | undefined {
  const key = useMemo(() => {
    if (model === undefined) return undefined;
    const ids: string[] = [];
    for (const agent of model.directAgents) {
      if (isActiveSubagentStatus(agent.status)) ids.push(agent.id);
    }
    for (const group of model.workflows) {
      if (!isTerminalSubagentStatus(group.workflow.status)) ids.push(group.workflow.id);
      const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
      for (const member of members) {
        if (isActiveSubagentStatus(member.status)) ids.push(member.id);
      }
    }
    return ids.sort().join("\n");
  }, [model]);
  return useMemo(
    () => (key === undefined ? undefined : new Set(key.split("\n").filter(Boolean))),
    [key],
  );
}

// ---------------------------------------------------------------------------
// Small row building blocks

function MessageTime(props: {
  readonly iso: string;
  readonly format: ClockFormat;
  readonly className?: string;
}) {
  const label = formatDayAwareTimestamp(props.iso, props.format);
  if (label === "") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span data-message-time className={cn("text-muted-foreground/80", props.className)} />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{formatChatTimestampTooltip(props.iso, props.format)}</TooltipPopup>
    </Tooltip>
  );
}

function RestingLeadBlob({ updatedAt }: { updatedAt: string }) {
  const quietFor = () => Date.now() - Date.parse(updatedAt);
  const [asleep, setAsleep] = useState(() => quietFor() >= ASLEEP_AFTER_MS);
  useEffect(() => {
    if (asleep) return;
    const remaining = ASLEEP_AFTER_MS - quietFor();
    if (!Number.isFinite(remaining)) return;
    const timer = setTimeout(() => setAsleep(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [asleep, updatedAt]);
  return <LeadBlob mood={asleep ? "asleep" : "attentive"} />;
}

/** Fades its content in when it mounts (and again whenever `contentKey` changes); instant under reduced motion. */
function FadeIn(props: { readonly contentKey: string; readonly children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [props.contentKey]);
  return (
    <div
      key={props.contentKey}
      className={cn(
        "transition-opacity duration-150 motion-reduce:opacity-100 motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      {props.children}
    </div>
  );
}

/** "Compacting…" with the graph-trace glyph (no underline). */
function LiveStatusLine({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => watchVisibleAnimation(ref.current), []);
  return (
    <span ref={ref} className="inline-flex items-center gap-1.5">
      <GraphTraceGlyph />
      <span>{children}</span>
    </span>
  );
}

/**
 * The lead's working sprite with the turn's seconds counter right beside it, from the moment the message is sent (no
 * "Thinking" word: a live status label, when the turn has one, sits between the sprite and the counter).
 */
function LiveLeadLine(props: { readonly label: string | null; readonly startedAt: string | null }) {
  const turnSeed = useTranscriptActivity().activeTurnStartedAt;
  // Until the server's turn start arrives, count from when this row appeared (the send).
  const [shownAt] = useState(() => new Date().toISOString());
  const at = props.startedAt ?? shownAt;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex size-6 shrink-0 items-center justify-center">
        <LeadBlob mood="working" seed={turnSeed} />
      </span>
      {props.label ? (
        <>
          <span data-live-status-label>{props.label}</span>
          <TurnTimer startedAt={at} />
        </>
      ) : (
        <TurnTimer bare startedAt={at} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rows

function QueuedMessageRow({ row }: { row: Row<"queued-message"> }) {
  const shared = useTranscriptShared();
  const { queuedMessage: queued, isNext } = row;
  const text = queued.prompt.trim();
  const contextCount =
    queued.terminalContexts.length +
    queued.previewAnnotations.length +
    queued.reviewComments.length;
  const attachmentCount = queued.attachments.length;
  const status = queued.holdUntilUserAction
    ? "Waits for Send now"
    : isNext
      ? "Sends after the next tool call or when the turn ends"
      : "Sends after the messages above it";
  const keepComposerFocus = (event: { preventDefault: () => void }) => event.preventDefault();

  return (
    <div data-queued-message-id={queued.id} className="flex flex-col items-end">
      <div className="max-w-[80%] rounded-2xl border border-dashed border-border p-3 text-message-foreground/80">
        {text ? <p className="text-sm break-words whitespace-pre-wrap">{text}</p> : null}
        {contextCount > 0 ? (
          <p className={cn("text-xs text-secondary-label", text && "mt-1.5")}>
            {contextCount} context item{contextCount === 1 ? "" : "s"}
          </p>
        ) : null}
        {attachmentCount > 0 ? (
          <p
            data-queued-attachments
            className={cn("text-xs text-secondary-label", (text || contextCount > 0) && "mt-1.5")}
          >
            {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
      <div
        data-scroll-anchor-ignore
        className="mt-2 flex w-full items-center gap-4 text-xs text-secondary-label"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={`Queued. ${status}.`}
                className="inline-flex h-6 items-center gap-1"
              />
            }
          >
            <ClockIcon className="size-3.5" aria-hidden />
            Queued
          </TooltipTrigger>
          <TooltipPopup side="bottom">{status}</TooltipPopup>
        </Tooltip>
        <div className="ml-auto flex items-center gap-0.5">
          <Hint label="Send now">
            <Button
              variant="ghost-muted"
              size="icon-micro"
              className="size-6"
              aria-label="Send now"
              onPointerDown={keepComposerFocus}
              onClick={() => shared.onSteerQueuedMessage(queued.id)}
            >
              <ArrowUpGlyph />
            </Button>
          </Hint>
          <Hint label="Cancel and return to the composer">
            <Button
              variant="ghost-muted"
              size="icon-micro"
              className="size-6"
              aria-label="Cancel and return to the composer"
              onPointerDown={keepComposerFocus}
              onClick={() => shared.onRemoveQueuedMessage(queued.id)}
            >
              <CloseGlyph />
            </Button>
          </Hint>
        </div>
      </div>
    </div>
  );
}

function ArrowUpGlyph() {
  return (
    <svg
      strokeLinejoin="round"
      strokeLinecap="round"
      stroke="currentColor"
      className="size-3.5"
      viewBox="0 0 24 24"
      strokeWidth={2}
      fill="none"
      aria-hidden
    >
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      strokeLinejoin="round"
      strokeLinecap="round"
      stroke="currentColor"
      className="size-3.5"
      viewBox="0 0 24 24"
      strokeWidth={2}
      fill="none"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function CompactionRow({ row }: { row: Row<"context-compaction"> }) {
  return (
    <div
      role="separator"
      aria-label={row.label}
      className="flex items-center gap-3 py-1 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="inline-flex items-center gap-1.5">
        <MinimizeIcon className="size-3" aria-hidden />
        {row.label}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

const NOTICE_BODY_CLASS =
  "mt-1 rounded-md bg-muted/30 px-2 py-1.5 font-sans text-xs whitespace-pre-wrap text-muted-foreground";

function firstLine(text: string): string {
  return (
    text
      .replace(/^\[kora\]\s*/i, "")
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function noticeHeadline(row: Row<"mode-notice">): string {
  if (row.noticeKind === "agent-mode-switched" && row.to !== null) {
    if (row.to === "swarm")
      return "Stretch on · your agent leads, free then cheap models do the legwork";
    if (row.from === "swarm") return `Stretch off · now ${agentModeLabel(row.to)}`;
    return `Switched to ${agentModeLabel(row.to)}`;
  }
  return "Worker updates";
}

function ModeNoticeRow({ row }: { row: Row<"mode-notice"> }) {
  const shared = useTranscriptShared();
  const [open, setOpen] = useState(false);

  if (row.noticeKind === "group-note") {
    return (
      <div
        data-group-note
        className="px-2 py-1 text-center text-xs leading-snug text-muted-foreground"
      >
        {row.text}
      </div>
    );
  }

  const skin = shared.blobSkin;
  if (skin !== null) {
    return (
      <div data-blob-notice>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground opacity-80 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:text-foreground focus-visible:opacity-100"
        >
          <WaypointsIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{quietNoticeLabel(row.text, skin.name)}</span>
        </button>
        {open ? <pre className={NOTICE_BODY_CLASS}>{row.text}</pre> : null}
      </div>
    );
  }

  const Icon = row.noticeKind === "agent-mode-switched" ? HexagonIcon : WaypointsIcon;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{noticeHeadline(row)}</span>
        <span className="truncate opacity-80">Kora → Claude: {firstLine(row.text)}</span>
      </button>
      {open ? <pre className={NOTICE_BODY_CLASS}>{row.text}</pre> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User message

function isLongUserMessage(text: string): boolean {
  if (text.trim() === "") return false;
  return text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES;
}

function UserMessageRow({ row }: { row: Row<"message"> }) {
  const shared = useTranscriptShared();
  const { message } = row;
  const resolved = useMemo(
    () => resolveUserMessageContext({ text: message.text, context: message.context }),
    [message.text, message.context],
  );
  const [expanded, setExpanded] = useState(false);
  const skin = shared.blobSkin;
  const position = shared.bubbleGroups?.get(row.id);
  const collapsible = isLongUserMessage(resolved.text);
  const collapsed = collapsible && !expanded;
  const hasRecords = resolved.records.length > 0;

  const chipEnv = useMemo<UserContextChipEnvironment>(
    () => ({
      records: resolved.recordsById,
      resolvedTheme: shared.resolvedTheme,
      workspaceRoot: shared.workspaceRoot,
      threadRef: shared.threadRef,
      skills: shared.skills,
    }),
    [
      resolved.recordsById,
      shared.resolvedTheme,
      shared.workspaceRoot,
      shared.threadRef,
      shared.skills,
    ],
  );
  const renderContextReference = useCallback(
    (reference: Parameters<typeof UserContextChip>[0]["reference"]) => (
      <UserContextChip reference={reference} env={chipEnv} />
    ),
    [chipEnv],
  );

  const copy = useMemo(() => {
    if (!hasRecords) {
      return {
        text: replaceContextChipReferences(resolved.text, (occurrence) => occurrence.label),
        flavors: undefined,
      };
    }
    const fragment = selectedMessageContextFragment({
      markdown: resolved.text,
      records: resolved.records,
      hostId: shared.hostId,
      ...(shared.threadRef ? { threadId: shared.threadRef.threadId } : {}),
      messageId: message.id,
    });
    return {
      text: resolved.text,
      flavors: fragment === null ? undefined : { [CONTEXT_CHIP_CLIPBOARD_MIME]: fragment },
    };
  }, [hasRecords, resolved, shared.hostId, shared.threadRef, message.id]);

  const recipients = useMemo(() => {
    if (!shared.groupThread || message.to === undefined) return null;
    return message.to.flatMap((id) => {
      const member = shared.groupThread!.membersById.get(id);
      return member ? [member] : [];
    });
  }, [shared.groupThread, message.to]);

  const toggleExpanded = () => {
    setExpanded((value) => !value);
    shared.actions.settleDisclosure(row.id, expanded);
  };

  return (
    <div className="flex flex-col">
      <h3 className="sr-only select-none">You</h3>
      <div className="group flex items-end justify-end gap-2">
        <div className="flex shrink-0 items-center gap-1.5 pb-1.5 text-[11px] tabular-nums opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <MessageTime iso={message.createdAt} format={shared.timestampFormat} />
          {resolved.text.trim() !== "" ? (
            <MessageCopyButton
              text={copy.text}
              label="Copy message"
              variant="ghost"
              size="icon-xs"
              {...(copy.flavors ? { extraFlavors: copy.flavors } : {})}
            />
          ) : null}
        </div>
        <div
          className={cn(
            skin !== null
              ? cn(
                  "relative max-w-[76%] bg-message px-4 py-2.5 text-message-foreground",
                  bubbleShapeClassName("right", position),
                )
              : "relative max-w-[76%] rounded-[1.375rem] rounded-br-md bg-message px-4 py-2.5 text-message-foreground",
          )}
        >
          <div
            data-user-message-body
            data-user-message-collapsed={collapsed ? "true" : "false"}
            data-user-message-collapsible={collapsible ? "true" : "false"}
            data-user-message-fade={collapsed ? "true" : "false"}
            className={cn(collapsed && "max-h-44 overflow-hidden")}
            style={
              collapsed
                ? {
                    maskImage:
                      "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)",
                    WebkitMaskImage:
                      "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)",
                  }
                : undefined
            }
            onCopy={(event) =>
              handleUserMessageCopy(event, {
                records: resolved.records,
                hostId: shared.hostId,
                threadId: shared.threadRef?.threadId,
                messageId: message.id,
              })
            }
          >
            <ReplyMarkdown
              text={resolved.text}
              cwd={shared.markdownCwd}
              lineBreaks
              parseRawHtml={false}
              extraRemarkPlugins={USER_REMARK_PLUGINS}
              className="text-message-foreground"
              headingLevelOffset={3}
              skills={shared.skills}
              renderContextReference={renderContextReference}
              onImageExpand={shared.onImageExpand}
            />
          </div>
          {collapsible ? (
            <div data-user-message-footer="true" className="mt-1.5 flex gap-2">
              <button
                type="button"
                aria-expanded={expanded}
                data-scroll-anchor-ignore
                onClick={toggleExpanded}
                className="-ml-1 h-6 cursor-pointer rounded-md px-1.5 text-xs text-secondary-label hover:bg-muted/55 hover:text-message-foreground"
              >
                {expanded ? "Show less" : "Show full message"}
              </button>
            </div>
          ) : null}
          {message.attachments && message.attachments.length > 0 ? (
            <MessageAttachments
              attachments={message.attachments}
              hostId={shared.hostId}
              threadId={shared.threadRef?.threadId ?? null}
            />
          ) : null}
        </div>
      </div>
      {recipients !== null ? (
        <RoutedTo
          recipients={recipients}
          {...(message.routeWhy ? { why: message.routeWhy } : {})}
        />
      ) : null}
      {message.via ? (
        <div data-via className="mt-1 pr-1 text-right text-[11px] text-muted-foreground">
          via {message.via}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant message

function AssistantMessageMeta(props: {
  readonly message: ChatMessage;
  readonly alwaysVisible: boolean;
  readonly showCopyButton: boolean;
  readonly copyStreaming: boolean;
  readonly skin: BlobSkin | null;
  readonly inGroup: boolean;
}) {
  const shared = useTranscriptShared();
  const activity = useTranscriptActivity();
  const { message, skin } = props;
  const resting = activity.restingMessageId === message.id;
  const copyState = resolveAssistantMessageCopyState({
    text: message.text,
    showCopyButton: props.showCopyButton,
    streaming: props.copyStreaming,
  });
  const turnId = message.turnId;
  const toggleSteps = turnId ? () => shared.actions.toggleTurn(turnId) : null;

  const time = message.streaming ? null : (
    <MessageTime
      iso={message.updatedAt}
      format={shared.timestampFormat}
      className="text-[11px] tabular-nums"
    />
  );
  const copy =
    copyState.visible && copyState.text !== null ? (
      <MessageCopyButton
        text={copyState.text}
        label="Copy message"
        variant="ghost"
        size="icon-xs"
      />
    ) : null;

  if (skin !== null) {
    return (
      <BlobMessageMeta
        skin={skin}
        resting={props.alwaysVisible || resting}
        time={time}
        copy={copy}
        onToggleSteps={props.inGroup ? null : toggleSteps}
      />
    );
  }

  const visible = props.alwaysVisible || resting;
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        visible
          ? "opacity-100"
          : "opacity-0 group-hover/assistant:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {turnId ? (
        <Hint label="Show what the agent did">
          <button
            type="button"
            aria-label="Show what the agent did"
            data-scroll-anchor-ignore
            onClick={() => shared.actions.toggleTurn(turnId)}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            {resting ? (
              <RestingLeadBlob updatedAt={message.updatedAt} />
            ) : (
              <LeadBlob mood="still" />
            )}
          </button>
        </Hint>
      ) : null}
      {copy}
      {time}
    </div>
  );
}

function AssistantMessageRow({ row }: { row: Row<"message"> }) {
  const shared = useTranscriptShared();
  const { message } = row;
  const group = shared.groupThread;
  const skin: BlobSkin | null = group
    ? skinForAuthor(message.authorBlobId ?? null, group.membersById)
    : shared.blobSkin;
  const position = shared.bubbleGroups?.get(row.id);

  const friendly = message.streaming ? null : friendlyAgentErrorCopy(message.text);
  const displayText =
    friendly ??
    (message.text === "" ? (message.streaming ? "" : "(empty response)") : message.text);

  const outputPaths = useMemo(() => {
    if (
      !shared.isAssistantThread ||
      message.streaming ||
      !shared.workspaceRoot ||
      !shared.threadRef
    ) {
      return [];
    }
    const fromTurn = message.turnId ? (shared.outputPathsByTurn.get(message.turnId) ?? []) : [];
    return dedupeOutputPaths([
      ...fromTurn,
      ...extractOutputPathsFromMarkdown(message.text, shared.workspaceRoot, shared.markdownCwd),
    ]);
  }, [
    shared.isAssistantThread,
    shared.workspaceRoot,
    shared.threadRef,
    shared.markdownCwd,
    shared.outputPathsByTurn,
    message.streaming,
    message.turnId,
    message.text,
  ]);

  if (group && message.text.trim() === "" && !message.streaming) return null;
  if (skin !== null && message.streaming && displayText === "") {
    return <BlobTypingRow skin={skin} label={group ? `${skin.name} is thinking` : null} />;
  }

  const retry =
    shared.inlineError && shared.inlineError.messageId === message.id && shared.inlineError.onRetry
      ? shared.inlineError.onRetry
      : null;

  const content = (
    <div className={cn("relative min-w-0", skin === null && "px-1 py-0.5")}>
      <h3 className="sr-only select-none">Agent</h3>
      <BlobBubble skin={skin} position={position}>
        <ReplyFootnoteSource
          messageId={message.id}
          {...(shared.threadRef ? { threadRef: shared.threadRef } : {})}
          itemKey={row.id}
          request={shared.footnoteTarget}
          listRef={shared.listRef}
        >
          <ReplyMarkdown
            text={displayText}
            cwd={shared.markdownCwd}
            {...(shared.threadRef ? { threadRef: shared.threadRef } : {})}
            hostId={shared.hostId}
            isStreaming={message.streaming}
            lineBreaks={shouldPreserveAssistantLineBreaks(displayText)}
            skills={shared.skills}
            headingLevelOffset={3}
            onUseArtifactTemplate={shared.onUseArtifactTemplate}
            onImageExpand={shared.onImageExpand}
          />
        </ReplyFootnoteSource>
      </BlobBubble>
      {outputPaths.length > 0 && shared.workspaceRoot && shared.threadRef ? (
        skin !== null ? (
          <BlobOutputCardGroup
            hostId={shared.hostId}
            cwd={shared.workspaceRoot}
            threadRef={shared.threadRef}
            relativePaths={outputPaths}
            blobId={skin.blobId}
          />
        ) : (
          <OutputCardGroup
            hostId={shared.hostId}
            cwd={shared.workspaceRoot}
            threadRef={shared.threadRef}
            relativePaths={outputPaths}
          />
        )
      ) : null}
      {friendly === CLAUDE_NOT_SIGNED_IN_COPY ? (
        <SignedOutLoginAction threadRef={shared.threadRef} />
      ) : null}
      {retry ? (
        <div data-inline-error-retry className="mt-1">
          <Button variant="ghost" size="xs" onClick={retry}>
            <RotateCcwIcon className="size-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
      {friendly ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-1 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap">
            {message.text}
          </pre>
        </details>
      ) : null}
      {row.showAssistantMeta ? (
        <div className="mt-1.5">
          <AssistantMessageMeta
            message={message}
            alwaysVisible={false}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
            skin={skin}
            inGroup={group !== null}
          />
        </div>
      ) : null}
    </div>
  );

  if (group && skin !== null) {
    return (
      <GroupAssistantFrame
        skin={skin}
        position={position}
        lead={group.group.leadId === skin.blobId}
      >
        {content}
      </GroupAssistantFrame>
    );
  }
  return (
    <BlobAssistantFrame skin={skin} position={position}>
      {content}
    </BlobAssistantFrame>
  );
}

function AssistantMetaRow({ row }: { row: Row<"assistant-meta"> }) {
  const shared = useTranscriptShared();
  const group = shared.groupThread;
  const skin: BlobSkin | null = group
    ? skinForAuthor(row.message.authorBlobId ?? null, group.membersById)
    : shared.blobSkin;
  return (
    <div className="px-1">
      <div className="mt-0.5">
        <AssistantMessageMeta
          message={row.message}
          alwaysVisible
          showCopyButton={row.showAssistantCopyButton}
          copyStreaming={row.assistantCopyStreaming}
          skin={skin}
          inGroup={group !== null}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live rows

function WorkingRow({ row }: { row: Row<"working"> }) {
  const shared = useTranscriptShared();
  const activity = useTranscriptActivity();
  if (shared.groupThread) return null;
  const skin = shared.blobSkin;
  const showBlob = row.showBlob !== false;
  if (skin !== null && !activity.isCompacting && showBlob) {
    return <BlobTypingRow skin={skin} label={activity.liveStatusLabel} />;
  }
  return (
    <div className="min-h-6 px-1 py-1 text-sm leading-relaxed tabular-nums text-muted-foreground">
      {activity.isCompacting ? (
        <FadeIn contentKey="compacting">
          <LiveStatusLine>Compacting…</LiveStatusLine>
        </FadeIn>
      ) : showBlob ? (
        <FadeIn contentKey="working">
          <LiveLeadLine label={null} startedAt={activity.activeTurnStartedAt} />
        </FadeIn>
      ) : null}
    </div>
  );
}

function ThinkingRow() {
  const shared = useTranscriptShared();
  const activity = useTranscriptActivity();
  if (shared.groupThread) return null;
  const skin = shared.blobSkin;
  if (skin !== null) return <BlobTypingRow skin={skin} label={activity.liveStatusLabel} />;
  return (
    <div className="min-h-7 px-1 py-1 text-sm leading-relaxed tabular-nums text-muted-foreground">
      {activity.isCompacting ? (
        <LiveStatusLine>Compacting…</LiveStatusLine>
      ) : (
        <LiveLeadLine label={activity.liveStatusLabel} startedAt={activity.activeTurnStartedAt} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row dispatch and wrapper

const TranscriptRowView = memo(function TranscriptRowView({ row }: { row: TranscriptRowEntry }) {
  const shared = useTranscriptShared();
  switch (row.kind) {
    case "work":
      return <WorkGroupSection row={row} />;
    case "work-live":
      return <LiveWorkRow row={row} />;
    case "work-toggle":
      return <WorkToggleRow row={row} />;
    case "turn-fold":
      // The fold toggle lives on the lead blob under the reply.
      return null;
    case "context-compaction":
      return <CompactionRow row={row} />;
    case "mode-notice":
      return <ModeNoticeRow row={row} />;
    case "message":
      return row.message.role === "user" ? (
        <UserMessageRow row={row} />
      ) : (
        <AssistantMessageRow row={row} />
      );
    case "assistant-meta":
      return <AssistantMetaRow row={row} />;
    case "proposed-plan":
      return (
        <div className="px-1 py-0.5">
          <PlanProposalCard
            planMarkdown={row.proposedPlan.planMarkdown}
            hostId={shared.hostId}
            threadRef={shared.threadRef ?? undefined}
            cwd={shared.markdownCwd}
            workspaceRoot={shared.workspaceRoot}
          />
        </div>
      );
    case "blob-card":
      return <BlobCardRow card={row.card} label={row.label} />;
    case "working":
      return <WorkingRow row={row} />;
    case "thinking":
      return <ThinkingRow />;
    case "queued-message":
      return <QueuedMessageRow row={row} />;
  }
});

function rowBottomPadding(row: TranscriptRowEntry): string {
  switch (row.kind) {
    case "work":
      return row.isExpandedToolGroup ? "pb-1" : "pb-2";
    case "work-toggle":
    case "work-live":
      return row.expanded ? "pb-0" : "pb-2";
    case "turn-fold":
      return "pb-0";
    case "working":
      return "pb-1.5";
    case "thinking":
      return "pb-2";
    case "message":
      return row.message.role === "assistant" && !row.showAssistantMeta ? "pb-2" : "pb-4";
    default:
      return "pb-4";
  }
}

function TranscriptRowShell({ row }: { row: TranscriptRowEntry }) {
  const shared = useTranscriptShared();
  const isAssistantRow =
    row.kind === "assistant-meta" || (row.kind === "message" && row.message.role === "assistant");
  return (
    <div
      data-transcript-row-id={row.id}
      data-transcript-row-kind={row.kind}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      className={cn(
        rowBottomPadding(row),
        isAssistantRow && "group/assistant",
        blobRowClassName(row, shared.blobSkin, shared.bubbleGroups),
      )}
    >
      <TranscriptRowView row={row} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list

function LoadEarlierHeader(props: { readonly page: FootnoteHistoryPage; readonly fade: boolean }) {
  return (
    <div
      className={cn(!props.fade && "pt-3 sm:pt-4")}
      style={props.fade ? { paddingTop: TITLEBAR_FADE_HEIGHT } : undefined}
    >
      <div className="mx-auto w-full max-w-3xl pb-2">
        <button
          type="button"
          disabled={props.page.loading}
          onClick={props.page.onLoadEarlier}
          className="w-full cursor-pointer py-1.5 text-xs text-muted-foreground/60 hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground/60"
        >
          {props.page.loading ? "Loading earlier turns…" : "Load earlier turns"}
        </button>
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// Raw HTML in a user's message is text they typed, not markup: show its source instead of dropping it.
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
const PHRASING_PARENTS = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "tableCell",
]);
function remarkRawHtmlAsText() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child.type !== "html") {
          visit(child);
          return child;
        }
        const text: MarkdownNode = { type: "text", value: child.value ?? "" };
        return PHRASING_PARENTS.has(node.type) ? text : { type: "paragraph", children: [text] };
      });
    };
    visit(tree);
  };
}
const USER_REMARK_PLUGINS = [remarkRawHtmlAsText];

function userMessageIdOfRow(row: TranscriptRowEntry): ItemId | null {
  return row.kind === "message" && row.message.role === "user" ? row.message.id : null;
}

function lastRestingMessageId(rows: ReadonlyArray<TranscriptRowEntry>): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "assistant-meta") return row.message.id;
    if (row.kind === "message" && row.message.role === "assistant" && row.showAssistantMeta) {
      return row.message.id;
    }
  }
  return null;
}

export const ThreadTranscript = memo(function ThreadTranscript(props: TranscriptProps) {
  const {
    showSetupCheck = true,
    markdownCwd,
    onRemoveQueuedMessage = noop,
    onToolOutputCollapsedAtEnd,
    onUseArtifactTemplate = noop,
    latestTurn,
    onImageExpand,
    listRef,
    onContentOverflowChange,
    onCiteAssistantText,
    timestampFormat,
    isWorking,
    queuedMessages = NO_QUEUED,
    onOpenFleet = null,
    onAskWholeFile = null,
    timelineEntries,
    isAssistantThread = false,
    topBannerInset = false,
    inlineError = null,
    workspaceRoot,
    agentPanelModel,
    onSteerQueuedMessage = noop,
    contentInsetEndAdjustment,
    onManualNavigation,
    topFadeEnabled = false,
    skills = NO_SKILLS,
    resolvedTheme,
    citationRequest = null,
    onAnchorReady,
    anchorMessageId,
    activeThreadHostId,
    citationHistoryLoading = false,
    displayThreadKey,
    liveFollowEnabled,
    liveStatusLabel = null,
    onIsAtEndChange,
    hideEmptyPlaceholder = false,
    runningTurnId,
    routeThreadKey,
    activeTurnStartedAt,
    loadEarlier = null,
    isCompacting = false,
  } = props;

  const identity = displayThreadKey ?? routeThreadKey;
  const threadRef = useMemo(() => parseHostThreadKey(routeThreadKey), [routeThreadKey]);
  const reducedMotion = prefersReducedMotion();
  const blobSkin = useBlobSkin();
  const groupThread = useGroupThread();
  const panelModel = agentPanelModel ?? emptyAgentPanelModel();

  // ---- disclosure state, reset whenever the list changes identity ----
  const [disclosure, setDisclosure] = useState(() => emptyDisclosure(identity));
  const [settlingIdentity, setSettlingIdentity] = useState<string | null>(null);
  let currentDisclosure = disclosure;
  if (disclosure.identity !== identity) {
    currentDisclosure = emptyDisclosure(identity);
    setDisclosure(currentDisclosure);
    setSettlingIdentity(identity);
  }
  const disclosureRef = useRef(currentDisclosure);
  disclosureRef.current = currentDisclosure;
  const workGroupView = useMemo(() => {
    void identity;
    return createWorkGroupView();
  }, [identity]);

  // The first end-pin on a new thread must snap, not glide: hold that for two frames.
  useEffect(() => {
    if (settlingIdentity === null) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettlingIdentity(null));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== 0) cancelAnimationFrame(second);
    };
  }, [settlingIdentity]);

  // A turn the reader interrupted stays open where they left it; moving on to a new turn folds the old one.
  const previousLatestRef = useRef<{ identity: string; turn: TranscriptLatestTurn | null }>({
    identity,
    turn: latestTurn,
  });
  useEffect(() => {
    const previous = previousLatestRef.current;
    previousLatestRef.current = { identity, turn: latestTurn };
    if (previous.identity !== identity || !previous.turn || !latestTurn) return;
    if (previous.turn.turnId === latestTurn.turnId) {
      if (previous.turn.state === "running" && latestTurn.state === "interrupted") {
        setDisclosure((current) =>
          current.turnIds.has(latestTurn.turnId)
            ? current
            : { ...current, turnIds: new Set(current.turnIds).add(latestTurn.turnId) },
        );
      }
      return;
    }
    const folded = previous.turn.turnId;
    setDisclosure((current) => {
      if (!current.turnIds.has(folded)) return current;
      const turnIds = new Set(current.turnIds);
      turnIds.delete(folded);
      return { ...current, turnIds };
    });
  }, [identity, latestTurn]);

  // ---- rows ----
  const liveAgentTaskIds = useLiveAgentTaskIds(agentPanelModel);
  const projectionRef = useRef<{
    identity: string;
    workspaceRoot: string | undefined;
    projection: TranscriptRowsProjection;
  } | null>(null);
  const rawRows = useMemo(() => {
    const previous = projectionRef.current;
    const reusable =
      previous && previous.identity === identity && previous.workspaceRoot === workspaceRoot
        ? previous.projection
        : null;
    const projection = deriveTranscriptRowsWithState(
      {
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds: currentDisclosure.turnIds,
        expandedWorkGroupIds: currentDisclosure.workGroupIds,
        isWorking,
        activeTurnStartedAt,
        liveAgentTaskIds,
        queuedMessages,
      },
      reusable,
    );
    projectionRef.current = { identity, workspaceRoot, projection };
    return projection.rows;
  }, [
    timelineEntries,
    latestTurn,
    runningTurnId,
    currentDisclosure.turnIds,
    currentDisclosure.workGroupIds,
    isWorking,
    activeTurnStartedAt,
    liveAgentTaskIds,
    queuedMessages,
    identity,
    workspaceRoot,
  ]);

  const stableRef = useRef<{ identity: string; state: StableTranscriptRowsState }>({
    identity,
    state: { byId: new Map(), result: [] },
  });
  const rows = useMemo(() => {
    if (stableRef.current.identity !== identity) {
      stableRef.current = { identity, state: { byId: new Map(), result: [] } };
    }
    const next = computeStableTranscriptRows(rawRows, stableRef.current.state);
    stableRef.current.state = next;
    return next.result;
  }, [rawRows, identity]);

  // ---- bubble groups (Blobs skin / group threads only) ----
  const bubbleGroupsRef = useRef<BubbleGroups | null>(null);
  const bubbleGroups = useMemo(() => {
    if (blobSkin === null && groupThread === null) {
      bubbleGroupsRef.current = null;
      return null;
    }
    let next: BubbleGroups;
    if (groupThread !== null) {
      const authors = new Map<string, string | null>();
      for (const row of rows) {
        if (row.kind === "message") authors.set(row.id, row.message.authorBlobId ?? null);
      }
      next = deriveAuthorBubbleGroups(rows, (messageId, role) =>
        role === "user" ? "user" : (authors.get(messageId) ?? null),
      );
    } else {
      next = deriveBubbleGroups(rows);
    }
    const previous = bubbleGroupsRef.current;
    if (previous && sameBubbleGroups(previous, next)) return previous;
    bubbleGroupsRef.current = next;
    return next;
  }, [rows, blobSkin, groupThread]);

  // ---- disclosure settling ----
  const [disclosureAnchor, setDisclosureAnchor] = useState<string | null>(null);
  const settleFramesRef = useRef<number[]>([]);
  const latestRef = useRef({ onToolOutputCollapsedAtEnd });
  latestRef.current = { onToolOutputCollapsedAtEnd };
  useEffect(
    () => () => {
      for (const frame of settleFramesRef.current) cancelAnimationFrame(frame);
    },
    [],
  );

  const settleDisclosure = useCallback(
    (anchorKey: string, collapsed = false) => {
      for (const frame of settleFramesRef.current) cancelAnimationFrame(frame);
      settleFramesRef.current = [];
      setDisclosureAnchor(anchorKey);
      const first = requestAnimationFrame(() => {
        const second = requestAnimationFrame(() => {
          setDisclosureAnchor(null);
          if (!collapsed) return;
          const atEnd = resolveTranscriptIsAtEnd(listRef.current?.getState?.());
          if (atEnd) latestRef.current.onToolOutputCollapsedAtEnd?.();
        });
        settleFramesRef.current.push(second);
      });
      settleFramesRef.current.push(first);
    },
    [listRef],
  );

  const actions = useMemo<TranscriptActions>(
    () => ({
      settleDisclosure,
      toggleTurn: (turnId) => {
        setDisclosure((current) => ({ ...current, turnIds: withToggled(current.turnIds, turnId) }));
        settleDisclosure(`turn-fold:${turnId}`);
      },
      toggleWorkGroup: (groupId, rowId) => {
        const wasExpanded = disclosureRef.current.workGroupIds.has(groupId);
        setDisclosure((current) => ({
          ...current,
          workGroupIds: withToggled(current.workGroupIds, groupId),
        }));
        settleDisclosure(rowId, wasExpanded);
      },
      toggleSpawn: (entryId, rowId) => {
        setDisclosure((current) => ({
          ...current,
          spawnEntryIds: withToggled(current.spawnEntryIds, entryId),
        }));
        settleDisclosure(rowId);
      },
    }),
    [settleDisclosure],
  );

  // ---- footnote navigation ----
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const expandTurn = useCallback((turnId: TurnId) => {
    setDisclosure((current) =>
      current.turnIds.has(turnId)
        ? current
        : { ...current, turnIds: new Set(current.turnIds).add(turnId) },
    );
  }, []);
  const footnote = useReplyFootnoteTarget({
    request: citationRequest,
    entries: timelineEntries,
    rows,
    listRef,
    viewport,
    historyLoading: citationHistoryLoading,
    loadEarlier,
    onExpandTurn: expandTurn,
    onManualNavigation,
  });

  // ---- output cards (assistant lane) ----
  const outputPathsByTurn = useMemo(() => {
    if (!isAssistantThread || !workspaceRoot) return NO_OUTPUT_PATHS;
    const byTurn = new Map<string, string[]>();
    const add = (turnId: string | null | undefined, paths: string[]) => {
      if (!turnId || paths.length === 0) return;
      byTurn.set(turnId, [...(byTurn.get(turnId) ?? []), ...paths]);
    };
    for (const item of timelineEntries) {
      if (item.kind === "message") {
        if (item.message.role === "assistant" && !item.message.streaming) {
          add(
            item.message.turnId,
            extractOutputPathsFromMarkdown(item.message.text, workspaceRoot, markdownCwd),
          );
        }
      } else if (item.kind === "work") {
        add(
          item.entry.turnId,
          extractOutputPathsFromWorkLogEntry(item.entry as WorkLogEntry, workspaceRoot),
        );
      }
    }
    return new Map([...byTurn].map(([turnId, paths]) => [turnId, dedupeOutputPaths(paths)]));
  }, [isAssistantThread, workspaceRoot, timelineEntries, markdownCwd]);

  // ---- scroll bookkeeping ----
  const positioning = footnote.positioning;
  const anchored = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(rows, anchorMessageId, userMessageIdOfRow, {
        anchorOffset: CHAT_TRANSCRIPT_ANCHOR_OFFSET,
      }),
    [rows, anchorMessageId],
  );

  const overflowFrameRef = useRef<number | null>(null);
  const reportOverflow = useCallback(() => {
    if (!onContentOverflowChange) return;
    const state = listRef.current?.getState?.();
    if (!state || !Array.isArray(state.data)) return;
    onContentOverflowChange(
      transcriptContentOverflowsViewport(state, {
        composerInset: contentInsetEndAdjustment,
        anchorOffset: CHAT_TRANSCRIPT_ANCHOR_OFFSET,
      }),
    );
  }, [listRef, onContentOverflowChange, contentInsetEndAdjustment]);
  const scheduleOverflowReport = useCallback(() => {
    if (!onContentOverflowChange || overflowFrameRef.current !== null) return;
    overflowFrameRef.current = requestAnimationFrame(() => {
      overflowFrameRef.current = null;
      reportOverflow();
    });
  }, [onContentOverflowChange, reportOverflow]);
  useLayoutEffect(() => {
    if (overflowFrameRef.current !== null) {
      cancelAnimationFrame(overflowFrameRef.current);
      overflowFrameRef.current = null;
    }
    reportOverflow();
  }, [rows.length, reportOverflow]);
  useEffect(
    () => () => {
      if (overflowFrameRef.current !== null) cancelAnimationFrame(overflowFrameRef.current);
    },
    [],
  );

  const handleScroll = useCallback(() => {
    if (!positioning) {
      const atEnd = resolveTranscriptIsAtEnd(listRef.current?.getState?.());
      if (atEnd !== undefined) onIsAtEndChange(atEnd);
    }
    scheduleOverflowReport();
  }, [positioning, listRef, onIsAtEndChange, scheduleOverflowReport]);
  const handleScrollRef = useRef(handleScroll);
  handleScrollRef.current = handleScroll;
  useEffect(() => {
    const frame = requestAnimationFrame(() => handleScrollRef.current());
    return () => cancelAnimationFrame(frame);
  }, [rows.length]);

  // The viewport can resize without the list scrolling (window resize, composer growth).
  useEffect(() => {
    const node = listRef.current?.getScrollableNode?.();
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleOverflowReport);
    observer.observe(node);
    return () => observer.disconnect();
  }, [listRef, scheduleOverflowReport, rows.length === 0]);

  // ---- context values ----
  const restingMessageId = isWorking ? null : lastRestingMessageId(rows);
  const activity = useMemo<TranscriptActivity>(
    () => ({
      isWorking,
      isCompacting,
      latestTurnId: latestTurn?.turnId ?? null,
      activeTurnStartedAt,
      restingMessageId,
      liveStatusLabel,
    }),
    [
      isWorking,
      isCompacting,
      latestTurn?.turnId,
      activeTurnStartedAt,
      restingMessageId,
      liveStatusLabel,
    ],
  );
  const shared = useMemo<TranscriptShared>(
    () => ({
      hostId: activeThreadHostId,
      threadRef,
      markdownCwd,
      workspaceRoot,
      resolvedTheme,
      timestampFormat,
      skills,
      agentPanelModel: panelModel,
      isAssistantThread,
      inlineError,
      outputPathsByTurn,
      expandedSpawnEntryIds: currentDisclosure.spawnEntryIds,
      workGroupView,
      listRef,
      footnoteTarget: footnote.target,
      blobSkin,
      bubbleGroups,
      groupThread,
      onImageExpand,
      onUseArtifactTemplate,
      onOpenFleet,
      onAskWholeFile,
      onSteerQueuedMessage,
      onRemoveQueuedMessage,
      actions,
    }),
    [
      activeThreadHostId,
      threadRef,
      markdownCwd,
      workspaceRoot,
      resolvedTheme,
      timestampFormat,
      skills,
      panelModel,
      isAssistantThread,
      inlineError,
      outputPathsByTurn,
      currentDisclosure.spawnEntryIds,
      workGroupView,
      listRef,
      footnote.target,
      blobSkin,
      bubbleGroups,
      groupThread,
      onImageExpand,
      onUseArtifactTemplate,
      onOpenFleet,
      onAskWholeFile,
      onSteerQueuedMessage,
      onRemoveQueuedMessage,
      actions,
    ],
  );

  // ---- empty states ----
  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      return <div className="h-full bg-background" data-transcript-loading="true" />;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-sm text-placeholder">Send a message to start the conversation.</p>
        {showSetupCheck ? (
          <SetupCheck problemsOnly requireClaude className="mt-4 w-full max-w-md" />
        ) : null}
      </div>
    );
  }

  const settling = settlingIdentity !== null;
  const followEnd =
    !positioning && anchored === undefined && liveFollowEnabled && disclosureAnchor === null;
  const maintainScrollAtEnd = followEnd
    ? {
        animated: isWorking && !reducedMotion && !settling,
        on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
      }
    : false;

  const header = topBannerInset ? (
    <div className="h-24" data-transcript-banner-inset="true" />
  ) : loadEarlier ? (
    <LoadEarlierHeader page={loadEarlier} fade={topFadeEnabled} />
  ) : topFadeEnabled ? (
    <div style={{ height: TITLEBAR_FADE_HEIGHT }} />
  ) : (
    <div className="h-3 sm:h-4" />
  );

  const footer = (
    <div aria-hidden>
      <div style={{ height: anchored ? 0 : contentInsetEndAdjustment }} />
      <div className="h-3 sm:h-4" />
    </div>
  );

  return (
    <TranscriptSharedContext.Provider value={shared}>
      <TranscriptActivityContext.Provider value={activity}>
        <div
          ref={setViewport}
          className="relative h-full min-h-0"
          data-reply-footnote-viewport="true"
        >
          <LegendList
            ref={listRef}
            className={cn(
              "h-full overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            data={rows as TranscriptRowEntry[]}
            dataVersion={citationRequest?.key ?? 0}
            keyExtractor={(row: TranscriptRowEntry) => row.id}
            getItemType={(row: TranscriptRowEntry) =>
              row.kind === "message" ? `message:${row.message.role}` : row.kind
            }
            extraData={`${identity}:${rows.length}`}
            estimatedItemSize={90}
            recycleItems={false}
            initialScrollAtEnd={citationRequest === null}
            maintainScrollAtEnd={maintainScrollAtEnd}
            maintainScrollAtEndThreshold={1}
            maintainVisibleContentPosition={{
              data: true,
              size: true,
              shouldRestorePosition: (row: TranscriptRowEntry) =>
                disclosureAnchor === null || row.id === disclosureAnchor,
            }}
            {...(anchored
              ? {
                  anchoredEndSpace: {
                    anchorIndex: anchored.anchorIndex,
                    anchorOffset: anchored.anchorOffset,
                    onReady: (info: { anchorIndex?: number | undefined }) => {
                      if (anchorMessageId !== null) {
                        onAnchorReady(anchorMessageId, info.anchorIndex ?? anchored.anchorIndex);
                      }
                    },
                  },
                }
              : {})}
            contentInsetEndAdjustment={anchored ? contentInsetEndAdjustment : 0}
            {...(footnote.alwaysRender ? { alwaysRender: footnote.alwaysRender } : {})}
            onLoad={footnote.onListLoad}
            onScroll={handleScroll}
            onItemSizeChanged={scheduleOverflowReport}
            ListHeaderComponent={header}
            ListFooterComponent={footer}
            renderItem={({ item }: { item: TranscriptRowEntry }) => (
              <div
                data-transcript-root="true"
                className="mx-auto w-full max-w-3xl min-w-0 overflow-x-clip"
              >
                <TranscriptRowShell row={item} />
              </div>
            )}
          />
          {onCiteAssistantText && threadRef ? (
            <AssistantSelectionToolbar
              viewport={viewport}
              threadRef={threadRef}
              onCite={onCiteAssistantText}
            />
          ) : null}
        </div>
      </TranscriptActivityContext.Provider>
    </TranscriptSharedContext.Provider>
  );
});

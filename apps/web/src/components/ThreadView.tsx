import { closeWebSession } from "./web/closeWebSession";
import { addBrowserSurface } from "./web/addBrowserSurface";
import { TooltipTrigger, TooltipPopup, Tooltip } from "./ui/tooltip";
import { threadToast, toastManager } from "./ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyText";
import { Button } from "./ui/button";
import {
  AlertDialogTitle,
  AlertDialogPopup,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialog,
  AlertDialogHeader,
  AlertDialogFooter,
} from "./ui/alert-dialog";
import { derivePendingWorkerPicker } from "./thread/workerPicker.logic";
import {
  CHAT_TRANSCRIPT_ANCHOR_OFFSET,
  getAnchoredTurnMetrics,
  type TranscriptScrollMode,
} from "./thread/transcriptScrollAnchoring";
import { createPageScrollController, type PageScrollKey } from "./thread/pageScrollController";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
} from "./thread/draftHeroTransition";
import { WorkerPickerPanel } from "./thread/WorkerPickerPanel";
import { resolveTranscriptIsAtEnd } from "./thread/ThreadTranscript.logic";
import { type TranscriptInlineError, ThreadTranscript } from "./thread/ThreadTranscript";
import {
  isThreadErrorBannerDismissedForSession,
  dismissThreadErrorBannerForSession,
  shouldShowThreadErrorBanner,
  getThreadErrorBannerKey,
  ThreadErrorBanner,
} from "./thread/ThreadErrorBanner";
import { type ReplyFootnoteRequest } from "./thread/ReplyFootnoteSource";
import { PromptSurface } from "./thread/PromptSurface";
import { PromptBannerStackItem } from "./thread/PromptBannerStack";
import { GraphStatusChip } from "./thread/GraphStatusChip";
import { type ExpandedImageView, expandedImageKey } from "./thread/ExpandedImageView";
import { ExpandedImageDialog } from "./thread/ExpandedImageDialog";
import { DraftProjectChip } from "./thread/DraftProjectChip";
import { DraftStageHeadline } from "./thread/DraftStageHeadline";
import {
  agentSupportsManualCompaction,
  hasDismissedResumeCompaction,
  hasAvailableCompactionAgent,
  shouldOfferResumeCompaction,
} from "./thread/ContextWindowMeter.logic";
import { type ChatPromptHandle, ChatPrompt } from "./thread/ChatPrompt";
import { ChatHeader } from "./thread/ChatHeader";
import {
  shouldShowAgentStatusBanner,
  getAgentStatusBannerKey,
  AgentStatusBanner,
} from "./thread/AgentStatusBanner";
import { SwarmSetupDialog } from "./swarm/SwarmSetupDialog";
import { readPastedContextChip } from "./prompt-editor/clipboard";
import {
  resetPromptTranscriptInset,
  resolvePromptTranscriptInset,
  resolveScrollToEndClearance,
} from "./promptFooterLayout";
import { useFirstRunChecks, claudeStep } from "./onboarding/firstRunChecks";
import { SetupCheck } from "./onboarding/SetupCheck";
import { DraftFreshStart } from "./onboarding/DraftFreshStart";
import { resolveDockSelection, dockGroupOf, type DockGroup } from "./dock/rightDock.logic";
import { RightDockPanel } from "./dock/RightDockPanel";
import { DockToggleButton, type DockRailItem } from "./dock/DockControls";
import {
  BUILD_ME_A_BLOB_TEXT,
  KoraFirstRunGate,
  useKoraWelcome,
  isKoraThread,
} from "./blobs/welcome/KoraFirstRunGate";
import { useBlobRoster } from "./blobs/shell/useBlobRoster";
import { blobAccessMode } from "./blobs/shell/blobPosture";
import { RoutineRunBannerHost } from "./blobs/routines/RoutineRunBannerHost";
import { BlobSidePanel } from "./blobs/panel/BlobSidePanel";
import { useGroupMembers, useGroupsState, useGroupsApi } from "./blobs/groups/useGroups";
import { GroupThreadProvider } from "./blobs/groups/groupThreadContext";
import { groupMembers } from "./blobs/groups/groupModel";
import { GroupHeaderIdentity, GroupHeaderActions } from "./blobs/groups/GroupHeader";
import { CreateGroupDialog } from "./blobs/groups/CreateGroupDialog";
import { BlobSkinProvider, useBlobSkinFor } from "./blobs/chat/blobSkin";
import { useBlobPanel } from "./blobs/chat/blobPanelStore";
import { usePipStore } from "./blobs/browser/pip/pipStore";
import { useBlobBrowserAutoOpen } from "./blobs/chat/blobBrowserAutoOpen";
import { useBlobSendGuard } from "./blobs/chat/BlobConcurrencyGuard";
import { BlobHeaderIdentity, BlobHeaderActions } from "./blobs/chat/BlobChatHeader";
import { BlobApprovalProvider, type BlobApprovalApi } from "./blobs/cards/ApprovalCard";
import { useLastBlobStore } from "./assistant/surfaceStore";
import {
  SWARM_DOCK_GUTTER_PX,
  swarmDockGutterFor,
  swarmDockOverlapsColumn,
  useSwarmDockVisible,
  SwarmBlobDock,
} from "./assistant/SwarmBlobDock";
import { ChatHero } from "./assistant/ChatHero";
import {
  shouldReleaseTranscriptAnchorForToolActivity,
  shouldWriteThreadErrorToCurrentDaemonThread,
  agentControlledBrowserCloseConfirmation,
  getStartedThreadModelChangeBlockReason,
  resolveBackgroundDraftWorkspaceOptions,
  resolveThreadMetadataUpdateForNextTurn,
  buildExpiredTerminalContextToastCopy,
  buildRunningThreadTurnInterruptInput,
  codexArtifactTemplatePromptToAppend,
  hasHostReconnectWarningGraceElapsed,
  hasDaemonAcknowledgedLocalDispatch,
  toolGroupConsumesUpwardNavigation,
  shouldDockDraftHeroForSubmission,
  shouldRefocusPromptOnWindowFocus,
  peekRememberedThreadTranscript,
  buildThreadTurnInterruptInput,
  rememberReadyThreadTranscript,
  resolveThreadSwitchTranscript,
  scheduleHostReconnectWarning,
  shouldShowPlanFollowUpPrompt,
  buildLoadingThreadFromShell,
  createLocalDispatchSnapshot,
  isPaintOnlyThreadTranscript,
  resolvePromptAgentSelection,
  waitForStartedDaemonThread,
  restorePlanFollowUpPrompt,
  latestTurnStartFailureId,
  peekHeldThreadTranscript,
  threadNeedsClaudeLogin,
  type LocalDispatchSnapshot,
  buildLocalDraftThread,
  derivePromptSendState,
  deriveThreadAgentLock,
  resolveDraftHeroState,
  resolvePromptTurnMode,
} from "./ThreadView.logic";
import ThreadTerminalPanel from "../terminal/ShellDock";
import { SurfacePageHeader } from "./SurfacePageHeader";
import { NoActiveThreadState } from "./EmptyThreadView";
import { useFleetSnapshot, liveWorkerCount, FleetPanel } from "./FleetPanel";
import { DockSheet } from "./DockSheet";
import {
  deriveLogicalProjectKeyFromPrefs,
  selectProjectGroupingPrefs,
  derivePhysicalProjectKey,
} from "../workspace/logicalProject";
import { sanitizeThreadErrorMessage } from "../wire/transportError";
import { formatWorkspaceRelativePath } from "../workspace/filePathDisplay";
import { webRuntimeTabId } from "../webview/webRuntimeTabId";
import { useAgentWebOpens } from "../webview/useAgentWebOpens";
import { BrowserPrefsReadError } from "../webview/openFileInWeb";
import { newMessageId, newThreadId, cn } from "../util/utils";
import { terminalFocusOwner } from "../util/terminalFocus";
import {
  formatTerminalExcerptLabel,
  type TerminalExcerptSelection,
  type TerminalExcerptDraft,
} from "../util/terminalContext";
import { confirmTerminalClose } from "../util/terminalCloseConfirm";
import { helperWaitLabel } from "../util/swarm";
import { replyFootnoteFromLocation } from "../util/replyFootnoteNavigation";
import {
  pendingPromptAttachmentToOptimistic,
  pendingPromptAttachmentToUpload,
  capRestoredAttachments,
  type PendingPromptAttachment,
} from "../util/promptAttachments";
import { formatResetPhrase, activePlanLimit } from "../util/planUsage";
import { latestContextWindowSnapshot, formatContextWindowTokens } from "../util/contextWindow";
import {
  stripInlineContextLinks,
  ensureInlineContextLinks,
  removeInlineContextLink,
} from "../util/contextChipReferences";
import {
  reviewCommentContextLabel,
  webMarkupContextReference,
  terminalExcerptReference,
  webMarkupContextLabel,
  buildMessageContext,
} from "../util/contextChipRecords";
import type { ReplyFootnoteSourceAnchor } from "../util/assistantTextSelection";
import { inlineAgentErrorMessageId } from "../util/agentErrorCopy";
import {
  MAX_TERMINALS_PER_GROUP,
  DEFAULT_ACCESS_MODE,
  DEFAULT_TURN_MODE,
  type ChatMessage,
  type Thread,
} from "../types";
import type { ThreadLoadPhase } from "../thread/threadSync";
import {
  deriveTranscriptEntriesWithState,
  type TranscriptEntriesProjection,
  deriveActiveWorkStartedAt,
  findLatestPlanProposal,
  deriveActivePlanState,
  deriveActivityRows,
  isLatestTurnSettled,
  derivePhase,
} from "../thread/timeline";
import type { ReviewCommentContext } from "../thread/reviewCommentContext";
import {
  togglePendingQuestionOptionSelection,
  setPendingQuestionCustomAnswer,
  derivePendingQuestionProgress,
  buildPendingQuestionAnswers,
  type PendingQuestionDraftAnswer,
  writePendingUserInputDrafts,
  readPendingUserInputDrafts,
} from "../thread/pendingUserInput";
import {
  isWebSupportedInRuntime,
  useThreadWebState,
  setActiveWebTab,
} from "../stores/webStateStore";
import { registerFaviconProjectForThread } from "../stores/webIconStore";
import { useBrowserHistoryStore } from "../stores/webHistoryStore";
import { useViewStateStore } from "../stores/uiStateStore";
import {
  latestCompletedToolActivityId,
  useQueuedMessageStore,
  type QueuedPromptMessage,
  isQueuedMessageDue,
  useQueuedMessages,
} from "../stores/queuedMessageStore";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  restoreFailedBackgroundDraftThread,
  finalizePromotedDraftByRef,
  markDraftPromoted,
  promptDraftHasUserContent,
  promptTargetKey,
  usePromptDraftStore,
  type DraftId,
} from "../stores/promptDraftStore";
import { usePromptAttachmentStore } from "../stores/promptAttachmentStore";
import {
  selectActiveDockSurface,
  selectThreadDockState,
  useDockStore,
  type DockSurface,
} from "../stores/dockStore";
import { selectDraftAgentMode, useAgentModeStore } from "../stores/agentModeStore";
import { usePromptHandleContext } from "../promptHandleContext";
import {
  parseStandalonePromptSlashCommand,
  collapseExpandedPromptCursor,
  type PromptSubmissionIntent,
} from "../prompt-logic";
import {
  resolvePlanFollowUpSubmission,
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../planProposal";
import { buildPhysicalToLogicalProjectKeyMap } from "../navProjectGrouping";
import { resolveAppModelPickForInstance } from "../modelPick";
import { readLocalApi } from "../localApi";
import { hostCatalog } from "../link/catalog";
import { useTheme } from "../hooks/useTheme";
import { useStartNewThread } from "../hooks/useStartThread";
import { useHostHttpBaseUrl } from "../atoms/hosts";
import { useTaskBoundaryItems } from "./thread/TaskBoundaryBanner";
import { useQuickAnswer, type QuickAnswerApi } from "./thread/QuickAnswerCard";
import {
  GRAPH_ASK_EVENT,
  GRAPH_OPEN_FILE_EVENT,
  type GraphAskDetail,
  type GraphOpenFileDetail,
} from "./graph/repoReportBridge";
import { useClientPrefsHydrated, useClientPrefs, useHostPrefs } from "../hooks/usePrefs";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isNative } from "../env";
import { DOCK_INLINE_LAYOUT_MEDIA_QUERY, BLOB_PANEL_SHEET_MEDIA_QUERY } from "../dockLayout";
import { isAssistantSurfaceProject, isBlobsSurfaceProject } from "../chatSurface";
import { useAtomAction } from "../atoms/use-atom-command";
import { useHostThread, threadHost } from "../atoms/threads";
import { useKnownTerminalSessions } from "../atoms/terminalSessions";
import { terminalHost } from "../atoms/terminal";
import { primaryDaemonAvailableEditorsAtom } from "../atoms/server";
import { webHost } from "../atoms/preview";
import { usePrimaryHostId, usePrimaryHost, useHosts } from "../atoms/hosts";
import {
  useAllHostShellsBootstrapped,
  useDaemonConfigs,
  useThreadSummary,
  useProjects,
  useProject,
  useThread,
} from "../atoms/entities";
import { usePanelAnimationPrefs, usePanelPresence } from "../appearance/panelAnimations";
import {
  deriveAgentProfileEntries,
  sortAgentProfileEntries,
  applyAgentProfilePrefs,
  NO_AGENT_MODEL_PICK,
} from "../agentProfiles";
import { getAgentModelCapabilities } from "../agentModels";
import { resolveTerminalSessionLabel, nextTerminalId } from "@kora/shared/ptyLabels";
import { projectCommandEnv, projectScriptCwd } from "@kora/shared/projectCommands";
import { resolveProjectPrefs } from "@kora/shared/projectPrefs";
import {
  prefixClaudeEffort,
  resolvePromptInjectedEffort,
  createModelPick,
} from "@kora/shared/modelOptions";
import { assistantFootnotesToPlainText } from "@kora/shared/assistantFootnotes";
import { truncate } from "@kora/shared/text";
import {
  type AgentApprovalDecision,
  type ChatThreadActivity,
  type WebMarkupPayload,
  isFleetAgentMode,
  type HostThreadRef,
  type ThreadAgentMode,
  type AgentProfileId,
  type AgentTurnMode,
  DEFAULT_MODEL,
  type ReplyFootnote,
  type AgentStatus,
  type AccessMode,
  type AgentModel,
  type ModelPick,
  type RequestId,
  type ThreadId,
  type AgentId,
  type HostId,
  type ItemId,
  type TurnId,
} from "@kora/contracts";
import { requestOlderThreadTurns, threadHasOlderTurns } from "@kora/client-runtime/store/threads";
import { effectiveSnoozed, threadWokeAt } from "@kora/client-runtime/store/thread-settled";
import {
  foldSubagentActivities,
  deriveAgentPanelModel,
} from "@kora/client-runtime/store/subagentRuntime";
import {
  squashAtomActionFailure,
  type AtomActionResult,
  isAtomActionInterrupted,
} from "@kora/client-runtime/store/runtime";
import { derivePendingRequests } from "@kora/client-runtime/approvals";
import {
  hostProjectRef,
  parseHostThreadKey,
  hostThreadRef,
  hostThreadKey,
} from "@kora/client-runtime/host";
import { wasBootstrapThreadDeleted } from "@kora/client-runtime/failures";
import type { CodexArtifactTemplate } from "@kora/client-runtime/codex/artifact-templates";
import { resolveAgentSkillsForCwd } from "@kora/client-runtime/agentSkills";
import { flushSync } from "react-dom";
import {
  useLayoutEffect,
  useCallback,
  useEffect,
  Suspense,
  useState,
  useMemo,
  useRef,
  lazy,
  memo,
} from "react";
import {
  ArrowDownToLineIcon,
  CheckCircle2Icon,
  AlarmClockIcon,
  Minimize2Icon,
  WifiOffIcon,
  GaugeIcon,
} from "lucide-react";
import { Schema } from "effect";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Debouncer } from "@tanstack/react-pacer";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

const WebPanel = lazy(() => import("./web/WebPanel").then((mod) => ({ default: mod.WebPanel })));
const FileViewerPanel = lazy(() => import("./viewer/FileViewerPanel"));

// ---------------------------------------------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------------------------------------------

type ThreadViewProps =
  | {
      threadSyncPhase?: ThreadLoadPhase | null;
      reserveTitleBarControlInset?: boolean;
      onDiffPanelOpen?: () => void;
      routeKind: "server";
      threadId: ThreadId;
      draftId?: never;
      hostId: HostId;
    }
  | {
      reserveTitleBarControlInset?: boolean;
      onDiffPanelOpen?: () => void;
      threadSyncPhase?: never;
      threadId: ThreadId;
      routeKind: "draft";
      draftId: DraftId;
      hostId: HostId;
    };

// ---------------------------------------------------------------------------------------------------------------
// Draft hero layout transition
// ---------------------------------------------------------------------------------------------------------------

type PromptRect = { left: number; top: number };

/** Slides the composer from the hero position to its docked one (or back) when the hero state flips. */
function useDraftStageLayoutTransition(isDraftHeroState: boolean) {
  const groupRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const previousRect = useRef<PromptRect | null>(null);
  const previousState = useRef(isDraftHeroState);
  const animation = useRef<Animation | null>(null);

  const readRect = (): PromptRect | null => {
    const rect = anchorRef.current?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top } : null;
  };

  const capture = useCallback(() => {
    previousRect.current = readRect();
  }, []);

  useLayoutEffect(() => {
    if (previousState.current === isDraftHeroState) return;
    previousState.current = isDraftHeroState;
    animation.current?.cancel();
    animation.current = null;
    const before = previousRect.current;
    const next = readRect();
    previousRect.current = next;
    const group = groupRef.current;
    if (!before || !next || !group || typeof group.animate !== "function") return;
    const dx = before.left - next.left;
    const dy = before.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animation.current = group.animate(
      [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      {
        id: DRAFT_HERO_TRANSITION_ANIMATION_ID,
        duration: DRAFT_HERO_TRANSITION_DURATION_MS,
        easing: DRAFT_HERO_TRANSITION_EASING,
      },
    );
  }, [isDraftHeroState]);

  const attachGroup = useCallback((node: HTMLElement | null) => {
    groupRef.current = node;
  }, []);
  const attachAnchor = useCallback((node: HTMLElement | null) => {
    anchorRef.current = node;
    if (node) previousRect.current = readRect();
  }, []);
  return [attachGroup, attachAnchor, capture] as const;
}

// ---------------------------------------------------------------------------------------------------------------
// Type-to-focus / paste-to-focus
// ---------------------------------------------------------------------------------------------------------------

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="checkbox"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"]';
const FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"][data-open]',
  '[data-slot="alert-dialog-popup"][data-ending-style]',
  '[data-slot="command-dialog-popup"][data-open]',
  '[data-slot="command-dialog-popup"][data-ending-style]',
  '[data-slot="dialog-popup"][data-open]',
  '[data-slot="dialog-popup"][data-ending-style]',
  '[data-slot="sheet-popup"][data-open]',
  '[data-slot="sheet-popup"][data-ending-style]',
  '[data-slot="menu-popup"], [data-slot="select-popup"], [data-slot="popover-popup"]',
  '[data-slot="combobox-popup"], [data-slot="autocomplete-popup"]',
].join(", ");

function shouldRedirectInputToPrompt(event: Event): boolean {
  if (event.defaultPrevented) return false;
  const path = event.composedPath();
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (node.matches(EDITABLE_SELECTOR) || node.matches(INTERACTIVE_SELECTOR)) return false;
  }
  return document.querySelector(FLOATING_LAYER_SELECTOR) === null;
}

function shouldTypeToFocusPrompt(event: KeyboardEvent): boolean {
  return (
    !event.isComposing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.length === 1 &&
    shouldRedirectInputToPrompt(event)
  );
}

function pasteTextToFocusPrompt(event: ClipboardEvent): string | null {
  const data = event.clipboardData;
  if (!data || data.files.length > 0 || !shouldRedirectInputToPrompt(event)) return null;
  const text = data.getData("text/plain");
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------

function formatOutgoingPrompt(input: {
  models: ReadonlyArray<AgentModel>;
  effort: string | null;
  provider: AgentId;
  model: string;
  text: string;
}): string {
  const caps = getAgentModelCapabilities(input.models, input.model, input.provider);
  return prefixClaudeEffort(input.text, resolvePromptInjectedEffort(caps, input.effort));
}

function isCompactCommandMessage(message: {
  role: string;
  text: string;
  attachments?: ReadonlyArray<unknown> | undefined;
}): boolean {
  return (
    message.role === "user" &&
    /^\/compact(\s|$)/i.test(message.text.trim()) &&
    (message.attachments?.length ?? 0) === 0
  );
}

function releaseChatTranscriptAnchor<T extends { messageId: ItemId | null } | null>(current: T): T {
  // Anchored end space keeps LegendList's end-follow off for as long as it is installed, so every return to
  // the live edge has to release it or the timeline settles into "following-end" with nothing following.
  return current ? ({ ...current, messageId: null } as T) : current;
}

const EMPTY_ACTIVITIES: ReadonlyArray<ChatThreadActivity> = [];
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------------------------------------------
// Local dispatch: "the daemon has not acknowledged this send yet"
// ---------------------------------------------------------------------------------------------------------------

function useLocalDispatchState(input: {
  latestTurn: Thread["latestTurn"] | null;
  threadError: string | null | undefined;
  phase: ReturnType<typeof derivePhase>;
  latestUserMessageId: string | null;
  session: Thread["session"] | null;
  activeThread: Thread | undefined;
  hasPendingUserInput: boolean;
  hasPendingApproval: boolean;
}) {
  const [snapshot, setSnapshot] = useState<LocalDispatchSnapshot | null>(null);
  const failureId = latestTurnStartFailureId(
    input.activeThread,
    (input.latestUserMessageId ?? null) as never,
  );

  const acknowledged = hasDaemonAcknowledgedLocalDispatch({
    localDispatch: snapshot,
    phase: input.phase,
    latestTurn: input.latestTurn,
    latestUserMessageId: (input.latestUserMessageId ?? null) as never,
    session: input.session,
    hasPendingApproval: input.hasPendingApproval,
    hasPendingUserInput: input.hasPendingUserInput,
    latestTurnStartFailureId: failureId,
    threadError: input.threadError,
  });

  // Acknowledgement ends the dispatch; the state drops it on the next commit.
  useEffect(() => {
    if (snapshot && acknowledged) setSnapshot(null);
  }, [acknowledged, snapshot]);

  const beginLocalDispatch = useCallback(
    (options?: { submissionIntent?: PromptSubmissionIntent }) => {
      setSnapshot((current) => {
        if (current && !acknowledged) {
          const intent = options?.submissionIntent;
          return intent && intent !== current.submissionIntent
            ? { ...current, submissionIntent: intent }
            : current;
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [acknowledged, input.activeThread],
  );
  const resetLocalDispatch = useCallback(() => setSnapshot(null), []);

  const pending = snapshot !== null && !acknowledged;
  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: pending ? snapshot.startedAt : null,
    isSendBusy: pending,
    backgroundSubmissionPending: pending && snapshot.submissionIntent === "background",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The dock's terminal surface stays mounted while other surfaces are shown
// ---------------------------------------------------------------------------------------------------------------

type TerminalDockSurface = Extract<DockSurface, { kind: "terminal" }>;

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel(props: {
  onAddTerminalContext: Parameters<typeof ThreadTerminalPanel>[0]["onAddTerminalContext"];
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onSplitTerminalVertical: () => void;
  surface: TerminalDockSurface;
  onSplitTerminal: () => void;
  threadRef: HostThreadRef;
  onNewTerminal: () => void;
  focusRequestId: number;
  visible: boolean;
}) {
  const { threadRef, surface } = props;
  const draftThread = usePromptDraftStore((state) => state.getDraftSessionByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const project = useProject(projectId ? hostProjectRef(threadRef.hostId, projectId) : null);
  const sessions = useKnownTerminalSessions({
    hostId: threadRef.hostId,
    threadId: threadRef.threadId,
  });

  const summaryFor = useCallback(
    (terminalId: string) =>
      sessions.find((session) => session.target.terminalId === terminalId)?.state.summary ?? null,
    [sessions],
  );
  const activeSummary = summaryFor(surface.activeTerminalId);
  const threadWorktree = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const workspaceRoot = project?.workspaceRoot ?? null;

  const cwd =
    activeSummary?.cwd ??
    (workspaceRoot
      ? projectScriptCwd({ project: { cwd: workspaceRoot }, worktreePath: threadWorktree })
      : null);
  const worktreePath = activeSummary?.worktreePath ?? threadWorktree;
  const runtimeEnv = useMemo(
    () =>
      workspaceRoot
        ? projectCommandEnv({ project: { cwd: workspaceRoot }, worktreePath })
        : undefined,
    [workspaceRoot, worktreePath],
  );

  const labelsById = useMemo(
    () =>
      new Map(
        surface.terminalIds.map(
          (id) => [id, resolveTerminalSessionLabel(id, summaryFor(id))] as const,
        ),
      ),
    [summaryFor, surface.terminalIds],
  );
  const launchLocationsById = useMemo(() => {
    if (!workspaceRoot) return undefined;
    return new Map(
      surface.terminalIds.map((id) => {
        const summary = summaryFor(id);
        const worktree = summary?.worktreePath ?? threadWorktree;
        return [
          id,
          {
            cwd:
              summary?.cwd ??
              projectScriptCwd({ project: { cwd: workspaceRoot }, worktreePath: worktree }),
            worktreePath: worktree,
            runtimeEnv: projectCommandEnv({
              project: { cwd: workspaceRoot },
              worktreePath: worktree,
            }),
          },
        ] as const;
      }),
    );
  }, [summaryFor, surface.terminalIds, threadWorktree, workspaceRoot]);

  const groups = useMemo(
    () => [
      {
        ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        terminalIds: surface.terminalIds,
        id: surface.id,
      },
    ],
    [surface.id, surface.splitDirection, surface.terminalIds],
  );

  if (!project || !cwd) return null;
  return (
    <ThreadTerminalPanel
      threadId={threadRef.threadId}
      worktreePath={worktreePath}
      threadRef={threadRef}
      cwd={cwd}
      {...(runtimeEnv ? { runtimeEnv } : {})}
      visible={props.visible}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={groups}
      activeTerminalGroupId={surface.id}
      focusRequestId={props.focusRequestId}
      onSplitTerminal={props.onSplitTerminal}
      onSplitTerminalVertical={props.onSplitTerminalVertical}
      onNewTerminal={props.onNewTerminal}
      onActiveTerminalChange={props.onActiveTerminalChange}
      onCloseTerminal={props.onCloseTerminal}
      onAddTerminalContext={props.onAddTerminalContext}
      terminalLabelsById={labelsById}
      {...(launchLocationsById ? { terminalLaunchLocationsById: launchLocationsById } : {})}
    />
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Timestamped local errors (draft-keyed and thread-keyed maps race around promotion; the latest write wins)
// ---------------------------------------------------------------------------------------------------------------

interface StampedError {
  readonly message: string;
  readonly at: number;
}

type OptimisticMessage = ChatMessage;

const EMPTY_QUEUED: ReadonlyArray<QueuedPromptMessage> = [];
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_DRAFT_ANSWERS: Record<string, PendingQuestionDraftAnswer> = {};
const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_SKILLS: AgentStatus["skills"] = [];
const EMPTY_AGENT_STATUSES: ReadonlyArray<AgentStatus> = [];

/** Toast a failed thread action, unless the command was merely interrupted. */
function reportThreadActionFailure(
  result: Extract<AtomActionResult<unknown, unknown>, { _tag: "Failure" }>,
  title: string,
): void {
  if (isAtomActionInterrupted(result)) return;
  const description = errorMessageOf(squashAtomActionFailure(result));
  toastManager.add(threadToast({ title, description, type: "error" }));
}

/** The clipboard is only written when the user asks: a failed send offers "Copy prompt". */
function showUnsentPromptToast(text: string, title: string, description: string): void {
  toastManager.add({
    type: "warning",
    title,
    description,
    timeout: 0,
    actionProps: {
      children: "Copy prompt",
      onClick: () =>
        void writeTextToClipboard(text, "prompt").then(
          () => toastManager.add({ type: "success", title: "Prompt copied" }),
          () => toastManager.add({ type: "error", title: "Couldn't copy the prompt" }),
        ),
    },
  });
}

function errorMessageOf(cause: unknown, fallback = "An error occurred."): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

function hasPastedContextChips(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false;
  return (readPastedContextChip(clipboardData)?.records.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// ThreadView
// ---------------------------------------------------------------------------------------------------------------

const RF = { reportFailure: false } as const;
const WORKER_PICKER_NO_ANSWERS = {} as const;

export default function ThreadView(props: ThreadViewProps) {
  const { hostId, threadId, routeKind } = props;
  const draftId: DraftId | null = props.routeKind === "draft" ? props.draftId : null;
  const reserveTitleBarControlInset = props.reserveTitleBarControlInset ?? true;
  const routeSyncPhase: ThreadLoadPhase | null =
    props.routeKind === "server" ? (props.threadSyncPhase ?? null) : null;

  const navigate = useNavigate();
  const locationState = useLocation({
    select: (location) => ({
      href: location.href,
      stateKey:
        (location.state as { __TSR_key?: string; key?: string } | undefined)?.__TSR_key ?? "",
    }),
  });

  // ---- identity -----------------------------------------------------------------------------------------------
  const routeThreadRef = useMemo(() => hostThreadRef(hostId, threadId), [hostId, threadId]);
  const routeThreadKey = hostThreadKey(routeThreadRef);
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  // Async completions compare against this to tell whether the route moved while they were in flight.
  useEffect(
    () => () => {
      routeThreadKeyRef.current = "";
    },
    [],
  );

  // ---- commands -----------------------------------------------------------------------------------------------
  const openTerminal = useAtomAction(terminalHost.open, { label: "terminal open", ...RF });
  const closeTerminal = useAtomAction(terminalHost.close, { label: "terminal close", ...RF });
  const createThread = useAtomAction(threadHost.create, RF);
  const deleteThread = useAtomAction(threadHost.delete, RF);
  const updateMetadata = useAtomAction(threadHost.updateMetadata, RF);
  const setRuntimeMode = useAtomAction(threadHost.setRuntimeMode, RF);
  const setInteractionMode = useAtomAction(threadHost.setInteractionMode, RF);
  const setAgentModeCommand = useAtomAction(threadHost.setAgentMode, RF);
  const startTurn = useAtomAction(threadHost.startTurn, RF);
  const interruptTurn = useAtomAction(threadHost.interruptTurn, RF);
  const respondToApproval = useAtomAction(threadHost.respondToApproval, RF);
  const respondToUserInput = useAtomAction(threadHost.respondToUserInput, RF);
  const dismissUserInput = useAtomAction(threadHost.dismissUserInput, RF);
  const unsettleThread = useAtomAction(threadHost.unsettle, RF);
  const unsnoozeThread = useAtomAction(threadHost.unsnooze, RF);
  const openPreview = useAtomAction(webHost.open, RF);
  const closePreview = useAtomAction(webHost.close, { label: "preview close", ...RF });
  const retryHostNow = useAtomAction(hostCatalog.retryNow, RF);

  // ---- data ---------------------------------------------------------------------------------------------------
  const { environments } = useHosts();
  const primaryHost = usePrimaryHost();
  const activeHost = useMemo(
    () => environments.find((environment) => environment.hostId === hostId) ?? null,
    [environments, hostId],
  );
  const hostPrefs = useHostPrefs(hostId);
  const clientPrefsHydrated = useClientPrefsHydrated();
  const resolvedThemeValue = useTheme().resolvedTheme;

  const draftThread = usePromptDraftStore((state) =>
    routeKind === "server"
      ? state.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? state.getDraftSession(draftId)
        : null,
  );
  const shell = useThreadSummary(routeThreadRef);
  const serverThread = useThread(routeThreadRef, { waitForShell: draftThread !== null });
  const threadDetailLoading = routeSyncPhase === "loading";
  const loadingServerThread = useMemo(
    () => (threadDetailLoading && shell ? buildLoadingThreadFromShell(shell) : null),
    [shell, threadDetailLoading],
  );
  const activeServerThread: Thread | null = (serverThread as Thread | null) ?? loadingServerThread;
  const isServerThread = activeServerThread !== null;

  // Older turns: the loaded window can be a suffix of the conversation.
  // A draft id is unknown to the server until its first send: do not subscribe before its shell exists.
  const awaitingShell = draftThread !== null && shell === null;
  const hostThreadState = useHostThread(
    awaitingShell ? null : hostId,
    awaitingShell ? null : threadId,
  );
  const hasOlderTurns = threadHasOlderTurns(hostThreadState);
  const olderPage = hostThreadState.page._tag === "Some" ? hostThreadState.page.value : null;
  const loadEarlier = useMemo(
    () =>
      hasOlderTurns
        ? {
            loading: olderPage?.loadingOlder ?? false,
            cursor: olderPage?.beforeCursor ?? null,
            onLoadEarlier: () => void requestOlderThreadTurns(hostId, threadId),
          }
        : null,
    [hasOlderTurns, hostId, olderPage?.beforeCursor, olderPage?.loadingOlder, threadId],
  );

  // ---- draft store accessors (granular: never subscribe to prompt text) ----------------------------------------
  const composerDraftTarget: HostThreadRef | DraftId = draftId ?? routeThreadRef;
  const promptAccessMode = usePromptDraftStore(
    (state) => state.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const promptTurnMode = usePromptDraftStore(
    (state) => state.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const promptActiveProvider = usePromptDraftStore(
    (state) => state.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const draftActions = usePromptDraftStore.getState;
  const setStickyPromptModelPick = usePromptDraftStore((state) => state.setStickyModelSelection);
  const attachmentStore = usePromptAttachmentStore;
  /** Puts attachments back into the composer, never past the per-message limit (overflow is toasted). */
  const restoreAttachmentsToComposer = useCallback(
    (attachments: ReadonlyArray<PendingPromptAttachment>) => {
      const state = attachmentStore.getState();
      const existing = state.attachmentsByThreadKey[promptTargetKey(composerDraftTarget)] ?? [];
      const { kept, rejections } = capRestoredAttachments(attachments, existing.length);
      state.addAttachments(composerDraftTarget, kept);
      for (const rejection of rejections) {
        toastManager.add({
          type: "error",
          title: rejection.title,
          description: rejection.description,
        });
      }
    },
    [attachmentStore, composerDraftTarget],
  );

  // ---- footnote navigation ------------------------------------------------------------------------------------
  const footnoteRequest = useMemo<ReplyFootnoteRequest | null>(() => {
    const citation = replyFootnoteFromLocation(locationState.href);
    if (!citation || citation.hostId !== hostId || citation.threadId !== threadId) return null;
    return { citation, key: locationState.stateKey || locationState.href };
  }, [hostId, locationState.href, locationState.stateKey, threadId]);

  // ---- composer handle ----------------------------------------------------------------------------------------
  const contextHandle = usePromptHandleContext();
  const localComposerRef = useRef<ChatPromptHandle | null>(null);
  const composerRef = contextHandle ?? localComposerRef;
  const promptRef = useRef("");
  const composerTerminalContextsRef = useRef<TerminalExcerptDraft[]>([]);
  const citeAssistantText = useCallback(
    (citation: ReplyFootnote, anchor: ReplyFootnoteSourceAnchor): boolean => {
      const inserted = composerRef.current?.citeAssistantText(citation, anchor) ?? false;
      if (!inserted) {
        toastManager.add({
          description:
            "Try citing the selection after the connection or pending input is resolved.",
          title: "The composer is not ready",
          type: "warning",
        });
      }
      return inserted;
    },
    [composerRef],
  );

  // ---- local UI state -----------------------------------------------------------------------------------------
  const [restingControlsHost, setRestingControlsHost] = useState<HTMLDivElement | null>(null);
  const [restingControlsVisible, setRestingControlsVisible] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImageView | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const optimisticMessagesRef = useRef(optimisticMessages);
  optimisticMessagesRef.current = optimisticMessages;
  const [draftErrors, setDraftErrors] = useState<Record<string, StampedError>>({});
  const [threadErrors, setThreadErrors] = useState<Record<string, StampedError>>({});
  const [isConnecting] = useState(false);
  const [maximizedDockThreadKey, setMaximizedDockThreadKey] = useState<string | null>(null);
  const [respondingRequestIds, setRespondingRequestIds] = useState<RequestId[]>([]);
  const [respondingUserInputIds, setRespondingUserInputIds] = useState<RequestId[]>([]);
  const userInputInFlight = useRef(new Set<string>());
  const [workerPickerBusyId, setWorkerPickerBusyId] = useState<string | null>(null);
  const [pendingDraftAnswers, setPendingDraftAnswers] = useState<
    Record<string, Record<string, PendingQuestionDraftAnswer>>
  >(() => readPendingUserInputDrafts().answers);
  const [pendingQuestionIndex, setPendingQuestionIndex] = useState<Record<string, number>>(
    () => readPendingUserInputDrafts().indexes,
  );
  useEffect(() => {
    writePendingUserInputDrafts({ answers: pendingDraftAnswers, indexes: pendingQuestionIndex });
  }, [pendingDraftAnswers, pendingQuestionIndex]);
  const [errorDismissTick, setErrorDismissTick] = useState(0);
  const [dismissedAgentBannerKey, setDismissedAgentBannerKey] = useState<string | null>(null);
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [swarmLeaveConfirm, setSwarmLeaveConfirm] = useState<{ count: number } | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [backgroundStopPending, setBackgroundStopPending] = useState<string | null>(null);
  const [resumeDismissalTick, setResumeDismissalTick] = useState(0);
  const [pendingUnsettle, setPendingUnsettle] = useState<string | null>(null);
  const [pendingUnsnooze, setPendingUnsnooze] = useState<string | null>(null);
  const [wakeAcknowledgedTick, setWakeAcknowledgedTick] = useState(0);
  const [hostReconnectWarningHostId, setHostReconnectWarningHostId] = useState<HostId | null>(null);
  const sendInFlightRef = useRef(false);
  const hostUnavailableToastSlot = useRef(0);

  // ---- project, draft thread and surface classification ----------------------------------------------------------
  const projectRef = useMemo(
    () =>
      activeServerThread
        ? hostProjectRef(hostId, activeServerThread.projectId)
        : draftThread
          ? hostProjectRef(draftThread.hostId, draftThread.projectId)
          : null,
    [activeServerThread, draftThread, hostId],
  );
  const project = useProject(projectRef);
  const projectPrefs = useMemo(
    () => (project ? resolveProjectPrefs(hostPrefs, project.id, project) : null),
    [hostPrefs, project],
  );
  const projectDefaultModelChoice = projectPrefs?.settings.defaultModelSelection ?? null;
  const draftFallbackPick = projectDefaultModelChoice ?? NO_AGENT_MODEL_PICK;
  const localDraftThread = useMemo(
    () =>
      draftThread ? buildLocalDraftThread(threadId, draftThread, draftFallbackPick) : undefined,
    [draftThread, draftFallbackPick, threadId],
  );
  const activeThread: Thread | undefined = activeServerThread ?? localDraftThread;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const activeThreadKey = activeThread ? routeThreadKey : null;

  const isAssistantLane = isAssistantSurfaceProject(project);
  const blobsProjectId = isBlobsSurfaceProject(project) && project ? String(project.id) : null;
  const groupId = blobsProjectId?.startsWith("group_") ? blobsProjectId : null;
  const blobId = blobsProjectId !== null && groupId === null ? blobsProjectId : null;

  const groupsState = useGroupsState();
  const group = useMemo(
    () =>
      groupId ? (groupsState.groups.find((candidate) => candidate.id === groupId) ?? null) : null,
    [groupId, groupsState.groups],
  );
  const groupMemberLookup = useGroupMembers();
  const groupMemberList = useMemo(
    () => (group ? groupMembers(group, groupMemberLookup.byId) : []),
    [group, groupMemberLookup.byId],
  );
  const groupThreadInfo = useMemo(
    () => (group ? { group, membersById: groupMemberLookup.byId } : null),
    [group, groupMemberLookup.byId],
  );
  const blobRoster = useBlobRoster();
  const blobEntry = blobId ? (blobRoster.entries.get(blobId) ?? null) : null;
  const blobSkinForBlob = useBlobSkinFor(blobId);
  // A group thread is a shared transcript: the thread-level skin only turns the messenger look on.
  const blobSkin = useMemo(
    () =>
      group
        ? { blobId: group.id, name: group.name, title: "", outfit: {}, chief: false }
        : blobSkinForBlob,
    [blobSkinForBlob, group],
  );
  const blobPersona = blobEntry ? { name: blobEntry.blob.name, chief: blobEntry.chief } : null;

  // The Kora surface returns to the blob you were in after a switch or reload.
  const [, setLastBlob] = useLastBlobStore();
  useEffect(() => {
    if (blobId) setLastBlob(blobId);
  }, [blobId, setLastBlob]);

  const blobPanel = useBlobPanel();
  const blobPanelSheet = useMediaQuery(BLOB_PANEL_SHEET_MEDIA_QUERY);
  const shouldUseDockSheet = useMediaQuery(DOCK_INLINE_LAYOUT_MEDIA_QUERY);
  const lastBlobPanelBlob = useRef<string | null>(blobId);
  useEffect(() => {
    // A sheet overlays the chat and the Send button; a remembered "open" must not greet a switched blob.
    if (blobPanelSheet && blobPanel.open && lastBlobPanelBlob.current !== blobId)
      blobPanel.setOpen(false);
    lastBlobPanelBlob.current = blobId;
  }, [blobId, blobPanelSheet]);

  // ---- errors ---------------------------------------------------------------------------------------------------
  const draftErrorKey = draftId ?? String(threadId);
  const threadErrorEntry = threadErrors[String(threadId)];
  const draftErrorEntry = draftErrors[draftErrorKey];

  // When the server thread appears for a draft, a pending draft-keyed error moves to the thread-keyed map unless
  // the thread-keyed entry is newer or says the same thing.
  useEffect(() => {
    if (!isServerThread || !draftErrorEntry) return;
    setThreadErrors((current) => {
      const existing = current[String(threadId)];
      if (
        existing &&
        (existing.at >= draftErrorEntry.at || existing.message === draftErrorEntry.message)
      ) {
        return current;
      }
      return { ...current, [String(threadId)]: draftErrorEntry };
    });
    setDraftErrors((current) => {
      const { [draftErrorKey]: _moved, ...rest } = current;
      return rest;
    });
  }, [draftErrorEntry, draftErrorKey, isServerThread, threadId]);

  const threadError: string | null = isServerThread
    ? (threadErrorEntry?.message ?? activeServerThread?.session?.lastError ?? null)
    : (draftErrorEntry?.message ?? null);
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const inlineReplyErrorMessageId = threadError
    ? inlineAgentErrorMessageId(activeThread?.messages ?? [], threadError)
    : null;
  void errorDismissTick;
  const errorBannerDismissed = isThreadErrorBannerDismissedForSession(threadErrorBannerKey);
  const showThreadErrorBanner =
    inlineReplyErrorMessageId === null &&
    shouldShowThreadErrorBanner(routeThreadKey, threadError, errorBannerDismissed);

  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      const target = targetThreadId ?? threadId;
      const message = error === null ? null : sanitizeThreadErrorMessage(error);
      const toServer = shouldWriteThreadErrorToCurrentDaemonThread({
        activeServerThread: activeServerThread
          ? { hostId: activeServerThread.hostId, id: activeServerThread.id }
          : null,
        routeThreadRef,
        targetThreadId: target,
      });
      const write = (current: Record<string, StampedError>, key: string) => {
        if ((current[key]?.message ?? null) === message) return current;
        if (message === null) {
          const { [key]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [key]: { message, at: Date.now() } };
      };
      if (toServer) setThreadErrors((current) => write(current, String(target)));
      else setDraftErrors((current) => write(current, draftId ?? String(target)));
    },
    [activeServerThread, draftId, routeThreadRef, threadId],
  );

  // ---- surface-aware modes -------------------------------------------------------------------------------------
  const defaultAccessMode: AccessMode = blobEntry
    ? blobAccessMode(blobEntry.blob.permission, blobEntry.blob.engine.instanceId)
    : (projectPrefs?.settings.defaultRuntimeMode ??
      hostPrefs.defaultRuntimeMode ??
      DEFAULT_ACCESS_MODE);
  const accessMode: AccessMode =
    blobEntry && activeServerThread
      ? activeServerThread.runtimeMode
      : (promptAccessMode ?? activeServerThread?.runtimeMode ?? defaultAccessMode);

  const storedAgentMode = useAgentModeStore((state) =>
    selectDraftAgentMode(state, composerDraftTarget),
  );
  const agentMode: ThreadAgentMode = isAssistantLane
    ? "swarm"
    : isServerThread
      ? (storedAgentMode ?? activeServerThread?.agentMode ?? "chat")
      : (storedAgentMode ?? "chat");

  // ---- terminals -----------------------------------------------------------------------------------------------
  const knownTerminals = useKnownTerminalSessions({ hostId, threadId });
  const dockStoreState = useDockStore((state) => state.byThreadKey);
  const dockState = selectThreadDockState(dockStoreState, routeThreadRef);
  const activeDockSurface = selectActiveDockSurface(dockStoreState, routeThreadRef);
  const dockOpen = dockState.isOpen;
  const allocatableTerminalIds = useMemo(() => {
    const ids = new Set<string>(knownTerminals.map((session) => session.target.terminalId));
    for (const surface of dockState.surfaces) {
      if (surface.kind === "terminal") for (const id of surface.terminalIds) ids.add(id);
    }
    return [...ids];
  }, [dockState.surfaces, knownTerminals]);

  // ---- send anchor and transcript state ------------------------------------------------------------------------
  const [transcriptAnchor, setTranscriptAnchor] = useState<{
    threadKey: string;
    messageId: ItemId | null;
  }>({
    threadKey: routeThreadKey,
    messageId: null,
  });
  useEffect(() => {
    setTranscriptAnchor((current) =>
      current.threadKey === routeThreadKey
        ? current
        : { threadKey: routeThreadKey, messageId: null },
    );
  }, [routeThreadKey]);
  const anchorMessageId =
    transcriptAnchor.threadKey === routeThreadKey ? transcriptAnchor.messageId : null;

  // ---- fleet / swarm ---------------------------------------------------------------------------------------------
  const fleetAvailable = isServerThread && isFleetAgentMode(agentMode);
  const fleetSnapshot = useFleetSnapshot(isServerThread ? routeThreadRef : null);
  const liveWorkers = liveWorkerCount(fleetSnapshot);
  const totalWorkers = fleetSnapshot?.workers.length ?? 0;
  const liveSwarmWorkers = useMemo(
    () =>
      (fleetSnapshot?.workers ?? []).filter((worker) => worker.swarm && worker.state !== "exited")
        .length,
    [fleetSnapshot],
  );
  const paneModeActive = !isAssistantLane && activeDockSurface?.kind === "fleet";
  const blobDockActive =
    isServerThread &&
    blobId === null &&
    groupId === null &&
    (isAssistantLane || (fleetAvailable && !paneModeActive));
  const swarmDockVisible = useSwarmDockVisible(isServerThread ? routeThreadRef : null);
  // The dock pushes the transcript aside only when the column would actually run under it, by the dock's measured
  // width (an open pile can make it wider than the bare sprites). The dock is absolute, so the padding never changes
  // what is measured.
  const [timelineEl, setTimelineEl] = useState<HTMLDivElement | null>(null);
  const [swarmDockGutterPx, setSwarmDockGutterPx] = useState<number | null>(null);
  useEffect(() => {
    if (!timelineEl || !swarmDockVisible || !blobDockActive) return;
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const dock = timelineEl.querySelector<HTMLElement>(".swarm-blob-dock");
    const check = () => {
      const gutter = dock
        ? swarmDockGutterFor(timelineEl.getBoundingClientRect(), dock.getBoundingClientRect())
        : SWARM_DOCK_GUTTER_PX;
      setSwarmDockGutterPx(
        swarmDockOverlapsColumn(timelineEl.clientWidth, remPx, gutter) ? gutter : null,
      );
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(timelineEl);
    if (dock) observer.observe(dock);
    return () => observer.disconnect();
  }, [timelineEl, swarmDockVisible, blobDockActive]);
  const liveStatusLabel =
    agentMode === "swarm" && isServerThread ? helperWaitLabel(fleetSnapshot?.workers ?? []) : null;

  // ---- browser / web state --------------------------------------------------------------------------------------
  const webState = useThreadWebState(routeThreadRef);
  useEffect(() => {
    useDockStore
      .getState()
      .reconcileBrowserSurfaces(routeThreadRef, Object.keys(webState.sessions));
  }, [routeThreadRef, webState.sessions]);
  const allShellsBootstrapped = useAllHostShellsBootstrapped();
  useEffect(() => {
    if (!allShellsBootstrapped) return;
    useDockStore.getState().reconcileFileSurfaces(routeThreadRef, project !== null);
  }, [allShellsBootstrapped, project, routeThreadRef]);
  const [pendingFileSurfaces, setPendingFileSurfaces] = useState<
    Record<string, ReadonlySet<string>>
  >({});
  const projectKey = project ? `${project.hostId}:${project.workspaceRoot}` : "";
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      setPendingFileSurfaces((current) => {
        const existing = current[projectKey] ?? new Set<string>();
        const next = new Set(existing);
        if (pending) next.add(`file:${relativePath}`);
        else next.delete(`file:${relativePath}`);
        return { ...current, [projectKey]: next };
      });
    },
    [projectKey],
  );
  const pendingFileSurfaceIds = pendingFileSurfaces[projectKey] ?? EMPTY_ID_SET;

  // ---- dock presence ---------------------------------------------------------------------------------------------
  const panelAnimations = usePanelAnimationPrefs();
  const dockPresence = usePanelPresence(
    dockOpen && !!activeThread,
    { activeSurface: activeDockSurface, surfaces: dockState.surfaces },
    panelAnimations.active,
    routeThreadKey,
    panelAnimations.durationMs,
  );
  const blobPanelOpen = blobId !== null && blobPanel.open && !dockOpen;
  const blobPresence = usePanelPresence(
    blobPanelOpen,
    blobId,
    panelAnimations.active,
    routeThreadKey,
    panelAnimations.durationMs,
  );
  const canMaximizeDock = dockOpen && !shouldUseDockSheet;
  const dockMaximized = canMaximizeDock && maximizedDockThreadKey === routeThreadKey;
  const inlineDockOwnsTitleBar =
    (dockOpen && !shouldUseDockSheet) || (blobPanelOpen && !blobPanelSheet);

  // ---- visiting ------------------------------------------------------------------------------------------------
  const markThreadVisitedAction = useViewStateStore((state) => state.markThreadVisited);
  const lastVisitedAtById = useViewStateStore((state) => state.threadLastVisitedAtById);
  const latestCompletedAt = activeServerThread?.latestTurn?.completedAt ?? null;
  useEffect(() => {
    // Stamped at completion time, not now: a later wake or completion still signals, and it never moves back.
    if (latestCompletedAt) markThreadVisitedAction(routeThreadKey, latestCompletedAt);
  }, [latestCompletedAt, markThreadVisitedAction, routeThreadKey]);

  // ---- session facts ---------------------------------------------------------------------------------------------
  const session = activeThread?.session ?? null;
  const phase = derivePhase(session);
  const latestTurn = activeThread?.latestTurn ?? null;
  const runningTurnId: TurnId | null =
    session?.status === "running" && session.activeTurnId
      ? session.activeTurnId
      : latestTurn?.state === "running"
        ? latestTurn.turnId
        : null;
  const latestTurnSettled = isLatestTurnSettled(latestTurn, session);

  // ---- browser history -------------------------------------------------------------------------------------------
  useEffect(() => {
    if (projectRef) registerFaviconProjectForThread(routeThreadRef, projectRef);
  }, [projectRef, routeThreadRef]);
  const primaryHostId = usePrimaryHostId();
  const allProjects = useProjects();
  const groupingPrefs = useClientPrefs(selectProjectGroupingPrefs);
  const physicalToLogicalKeys = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects: allProjects,
        settings: groupingPrefs,
        primaryHostId,
      }),
    [allProjects, groupingPrefs, primaryHostId],
  );
  useEffect(() => {
    if (!clientPrefsHydrated || !project) return;
    // The key the sidebar shows for this project, including the identity a duplicate row borrows from its siblings.
    const logicalKey =
      physicalToLogicalKeys.get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromPrefs(project, groupingPrefs);
    useBrowserHistoryStore.getState().registerThreadProject(routeThreadRef, logicalKey);
  }, [clientPrefsHydrated, groupingPrefs, physicalToLogicalKeys, project, routeThreadRef]);

  // ---- host connection -----------------------------------------------------------------------------------------
  const activeHostConnectionPhase = activeHost?.connection.phase ?? "available";
  const activeHostUnavailable = activeHost !== null && activeHostConnectionPhase !== "connected";
  const reconnectingHostId =
    activeHost !== null &&
    (activeHostConnectionPhase === "connecting" || activeHostConnectionPhase === "reconnecting")
      ? hostId
      : null;
  useEffect(() => {
    setHostReconnectWarningHostId(null);
    if (reconnectingHostId === null) return;
    return scheduleHostReconnectWarning(() => setHostReconnectWarningHostId(reconnectingHostId));
  }, [reconnectingHostId]);
  const reconnectWarningElapsed = hasHostReconnectWarningGraceElapsed(
    reconnectingHostId,
    hostReconnectWarningHostId,
  );
  const hostUnavailableState = useMemo(
    () =>
      activeHost && activeHostUnavailable
        ? { hostId, label: activeHost.label, connection: activeHost.connection }
        : null,
    [activeHost, activeHostUnavailable, hostId],
  );
  const retryHost = useCallback(
    async (target: HostId) => {
      const result = await retryHostNow(target);
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        toastManager.add(
          threadToast({
            // The raw cause is a transport error; Diagnostics carries the detail.
            description:
              "Kora couldn't reach it. Check Settings › Diagnostics, or quit and reopen Kora.",
            title: "Kora's local service isn't responding",
            type: "error",
          }),
        );
      }
    },
    [retryHostNow],
  );

  // ---- provider / agent selection, banners ----------------------------------------------------------------------
  const daemonConfigs = useDaemonConfigs();
  // Once a thread has chosen an environment, never substitute the primary environment's config while it loads.
  const daemonConfig =
    (activeThread ? daemonConfigs.get(hostId) : undefined) ??
    (activeThread ? null : (primaryHost?.daemonConfig ?? null));
  const providerStatuses = useMemo(
    () => daemonConfig?.providers ?? EMPTY_AGENT_STATUSES,
    [daemonConfig],
  );
  const providerCatalogKnown = daemonConfig !== null && daemonConfig !== undefined;
  const threadModelInstanceId =
    activeThread?.modelSelection?.instanceId ?? projectDefaultModelChoice?.instanceId ?? null;
  const agentLock = deriveThreadAgentLock({
    thread: activeThread,
    selectedProvider: promptActiveProvider,
    threadProvider: threadModelInstanceId,
    providers: providerStatuses,
  });
  const agentEntries = useMemo(
    () =>
      sortAgentProfileEntries(
        applyAgentProfilePrefs(deriveAgentProfileEntries(providerStatuses), hostPrefs),
      ),
    [hostPrefs, providerStatuses],
  );
  const sessionInstanceId = activeThread?.session?.providerInstanceId ?? null;
  const agentSelection = resolvePromptAgentSelection({
    entries: agentEntries,
    candidateInstanceIds: [
      promptActiveProvider as AgentProfileId | null,
      sessionInstanceId,
      activeThread?.modelSelection?.instanceId,
      projectDefaultModelChoice?.instanceId,
    ],
    lockedProvider: agentLock,
    lockedInstanceId: sessionInstanceId ?? activeThread?.modelSelection?.instanceId,
  });
  const selectedAgentEntry = agentSelection.selectedProviderEntry;
  const selectedDriverKind = selectedAgentEntry?.driverKind ?? agentSelection.requestedDriverKind;
  const activeProfileId = selectedAgentEntry?.instanceId ?? null;
  const activeAgentStatus = selectedAgentEntry?.snapshot ?? null;
  const turnModeResolution = resolvePromptTurnMode({
    // The Plan toggle is always offered (its old setting has no switch left; a stored `false` hid it for good).
    planModeEnabled: true,
    provider: activeAgentStatus,
    interactionMode: promptTurnMode ?? activeThread?.interactionMode ?? DEFAULT_TURN_MODE,
  });
  const turnMode: AgentTurnMode = turnModeResolution.interactionMode;
  const turnModeEnabled = turnModeResolution.enabled;

  const activities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  useAgentWebOpens(isServerThread ? routeThreadRef : null, activities);
  const liveTurnId = runningTurnId;
  useBlobBrowserAutoOpen({
    blobId,
    threadKey: routeThreadKey,
    activities,
    liveTurnId,
    // the blob's browser pops up as the floating mini-window; its green light opens the full pane (Computer tab)
    show: (_tab: unknown, turn: string) => {
      if (blobId)
        usePipStore.getState().signal({
          blobId,
          thread: isServerThread
            ? { hostId: routeThreadRef.hostId, threadId: routeThreadRef.threadId }
            : null,
          turn,
        });
    },
  } as never);

  const workspaceMutationId = useMemo(() => {
    let latestMutation: string | null = null;
    for (const activity of activities) {
      if (activity.kind === "workspace.mutation") latestMutation = activity.id;
    }
    const checkpoints = activeThread?.checkpoints ?? [];
    const latestCheckpoint = checkpoints.at(-1)?.completedAt ?? null;
    return latestMutation === null && latestCheckpoint === null
      ? null
      : JSON.stringify([latestMutation, latestCheckpoint]);
  }, [activeThread?.checkpoints, activities]);
  const contextWindow = useMemo(() => latestContextWindowSnapshot(activities), [activities]);
  const activityRows = useMemo(() => deriveActivityRows(activities), [activities]);
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: foldSubagentActivities(activities, { sessionLive: phase !== "disconnected" }),
      }),
    [activities, phase],
  );

  // ---- pending requests, plan state ---------------------------------------------------------------------------
  const pendingRequests = useMemo(() => derivePendingRequests(activities), [activities]);
  const allApprovals = pendingRequests.approvals;
  const composerApprovals = useMemo(
    () => allApprovals.filter((request) => request.blobThread !== true),
    [allApprovals],
  );
  const activePendingApproval = composerApprovals[0] ?? null;
  const pendingUserInputs = pendingRequests.userInputs;
  const activePendingQuestion = pendingUserInputs[0] ?? null;
  const workerPicker = useMemo(() => derivePendingWorkerPicker(activities), [activities]);
  const activePendingKey = activePendingQuestion
    ? JSON.stringify([hostId, threadId, activePendingQuestion.requestId])
    : null;
  const activePendingDraftAnswers =
    (activePendingKey && pendingDraftAnswers[activePendingKey]) || EMPTY_DRAFT_ANSWERS;
  const activePendingQuestionIndex =
    (activePendingKey && pendingQuestionIndex[activePendingKey]) || 0;
  const activePendingQuestions = activePendingQuestion?.questions;
  const activePendingProgress = activePendingQuestions
    ? derivePendingQuestionProgress(
        activePendingQuestions,
        activePendingDraftAnswers,
        activePendingQuestionIndex,
      )
    : null;
  const activePendingResolvedAnswers = activePendingQuestion
    ? buildPendingQuestionAnswers(activePendingQuestion.questions, activePendingDraftAnswers)
    : null;
  const activePendingIsResponding = activePendingQuestion
    ? respondingUserInputIds.includes(activePendingQuestion.requestId)
    : false;

  const latestTurnId = latestTurn?.turnId ?? null;
  const activePlan = useMemo(
    () => deriveActivePlanState(activities, latestTurnId ?? undefined),
    [activities, latestTurnId],
  );
  const activeProposedPlan = useMemo(
    () =>
      latestTurnSettled
        ? findLatestPlanProposal(activeThread?.proposedPlans ?? [], latestTurnId ?? undefined)
        : null,
    [activeThread?.proposedPlans, latestTurnId, latestTurnSettled],
  );
  const offerPlanFollowUp = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode: turnMode,
    latestTurnSettled,
    hasActionableProposedPlan: activeProposedPlan !== null,
    hasComposerAttachments: false,
  });

  const activeTasksProgress = useMemo(() => {
    if (!activePlan || latestTurnSettled || !latestTurnId || activePlan.turnId !== latestTurnId)
      return null;
    const steps = activePlan.steps;
    const current =
      steps.find((step) => step.status === "inProgress") ??
      steps.find((step) => step.status === "pending");
    if (!current) return null;
    return {
      step: current.step,
      completedSteps: steps.filter((step) => step.status === "completed").length,
      totalSteps: steps.length,
    };
  }, [activePlan, latestTurnId, latestTurnSettled]);
  const activeTaskSteps = activeTasksProgress ? (activePlan?.steps ?? null) : null;

  // ---- compaction, working flags --------------------------------------------------------------------------------
  const serverMessages = activeThread?.messages ?? EMPTY_MESSAGES;
  const serverMessageIds = useMemo(
    () => new Set(serverMessages.map((message) => message.id)),
    [serverMessages],
  );
  const localDispatch = useLocalDispatchState({
    activeThread,
    phase,
    latestTurn,
    latestUserMessageId: serverMessages.findLast((message) => message.role === "user")?.id ?? null,
    session,
    hasPendingApproval: allApprovals.length > 0,
    hasPendingUserInput: pendingUserInputs.length > 0,
    threadError,
  });
  const {
    backgroundSubmissionPending,
    localDispatchStartedAt,
    resetLocalDispatch,
    beginLocalDispatch,
    isSendBusy,
  } = localDispatch;
  const latestUserMessageAt =
    serverMessages.findLast((message) => message.role === "user")?.createdAt ?? null;

  const compactPending = useMemo(() => {
    const lastOptimistic = optimisticMessages.at(-1);
    const candidate =
      isSendBusy && lastOptimistic && isCompactCommandMessage(lastOptimistic)
        ? lastOptimistic
        : serverMessages.findLast((message) => isCompactCommandMessage(message));
    if (!candidate) return { active: false, settled: true };
    const requestedAt = latestTurn?.requestedAt;
    const newer =
      requestedAt === undefined ||
      candidate.createdAt > requestedAt ||
      (candidate.createdAt === requestedAt && latestTurn?.state === "running");
    const failureId = latestTurnStartFailureId(activeThread, candidate.id as never);
    const compacted = activities.some(
      (activity) =>
        activity.kind === "context-compaction" &&
        (activity.payload as { requestId?: unknown } | null)?.requestId === candidate.id,
    );
    return { active: newer, settled: failureId !== null || compacted };
  }, [activeThread, activities, isSendBusy, latestTurn, optimisticMessages, serverMessages]);
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    compactPending.active &&
    !compactPending.settled;
  const isWorking = phase === "running" || isSendBusy || isConnecting || isCompacting;
  const workStartedAt = deriveActiveWorkStartedAt(
    latestTurn,
    session,
    localDispatchStartedAt,
    latestUserMessageAt,
  );

  // ---- transcript projection -------------------------------------------------------------------------------------
  const transcriptMessages = useMemo(
    () =>
      optimisticMessages.length === 0
        ? serverMessages
        : [
            ...serverMessages,
            ...optimisticMessages.filter((message) => !serverMessageIds.has(message.id)),
          ],
    [optimisticMessages, serverMessageIds, serverMessages],
  );
  const projectionRef = useRef<{ key: string; projection: TranscriptEntriesProjection | null }>({
    key: routeThreadKey,
    projection: null,
  });
  const timeline = useMemo(() => {
    const previous =
      projectionRef.current.key === routeThreadKey ? projectionRef.current.projection : null;
    const next = deriveTranscriptEntriesWithState(
      transcriptMessages,
      activeThread?.proposedPlans ?? [],
      activityRows,
      previous,
    );
    projectionRef.current = { key: routeThreadKey, projection: next };
    return next;
  }, [activeThread?.proposedPlans, routeThreadKey, transcriptMessages, activityRows]);
  const timelineEntries = timeline.entries;
  const switchTranscript = resolveThreadSwitchTranscript({
    loading: timelineEntries.length === 0 && routeSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTranscript<typeof timelineEntries>(activeThreadKey),
  });
  const displayThreadKey = switchTranscript.displayThreadKey;
  const paintOnly = isPaintOnlyThreadTranscript(displayThreadKey, activeThreadKey);
  const displayedEntries = switchTranscript.entries;
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const workspaceRootForUi = activeThread?.worktreePath ?? project?.workspaceRoot ?? undefined;
  useEffect(() => {
    if (activeThreadKey && timelineEntries.length > 0 && !threadDetailLoading) {
      rememberReadyThreadTranscript({
        markdownCwd: gitCwd,
        entries: timelineEntries,
        threadKey: activeThreadKey,
        workspaceRoot: project?.workspaceRoot ?? null,
      });
    }
  }, [activeThreadKey, gitCwd, project?.workspaceRoot, threadDetailLoading, timelineEntries]);
  const heldContext = paintOnly ? peekHeldThreadTranscript<typeof timelineEntries>() : null;
  const markdownCwd = paintOnly ? (heldContext?.markdownCwd ?? undefined) : (gitCwd ?? undefined);
  const transcriptWorkspaceRoot = paintOnly
    ? (heldContext?.workspaceRoot ?? undefined)
    : workspaceRootForUi;
  const displayedHostId = useMemo(() => {
    const parsed = displayThreadKey ? parseHostThreadKey(displayThreadKey) : null;
    return parsed?.hostId ?? hostId;
  }, [displayThreadKey, hostId]);

  const sessionStartBlocksSend =
    isServerThread && shell?.session?.status === "starting" && shell.latestTurn === null;

  // ---- draft hero / welcome ----------------------------------------------------------------------------------
  const draftHeroDockRequested = dockedDraftHeroThreadKey === activeThreadKey;
  const koraWelcome = useKoraWelcome(
    isKoraThread(blobId) && displayedEntries.length === 0 && !isWorking && !threadDetailLoading,
  );
  const firstRunChecks = useFirstRunChecks();
  const welcomeStep = claudeStep(firstRunChecks.checks, firstRunChecks.failed);
  // Only a thread whose model runs on Claude needs the Claude login; a blob on a free model, or a group, does not.
  const needsClaudeLogin = threadNeedsClaudeLogin({
    isGroup: groupId !== null,
    driverKind: selectedDriverKind,
  });
  const welcomeNeedsSetup =
    needsClaudeLogin &&
    koraWelcome.visible &&
    (welcomeStep.kind === "sign-in" || welcomeStep.kind === "fix");
  const isDraftHeroState =
    !koraWelcome.visible &&
    resolveDraftHeroState({
      isLocalDraftThread,
      hasTimelineEntries: displayedEntries.length > 0,
      isWorking,
      draftHeroDockRequested,
      backgroundSubmissionPending,
    });

  const availableEditors = useAtomValue(primaryDaemonAvailableEditorsAtom);

  // ---- banners (agent status, resume compaction, ...) --------------------------------------------------------------
  const agentBannerKey = getAgentStatusBannerKey(activeAgentStatus);
  useEffect(() => {
    if (agentBannerKey === null) setDismissedAgentBannerKey(null);
  }, [agentBannerKey]);
  const showAgentStatusBanner = shouldShowAgentStatusBanner(
    activeAgentStatus,
    dismissedAgentBannerKey,
  );
  const hasTranscriptTopBanner = showThreadErrorBanner || showAgentStatusBanner;

  // ---- scroll model: follow / anchor / free-scroll ---------------------------------------------------------------
  const listRef = useRef<LegendListRef | null>(null);
  const promptOverlayRef = useRef<HTMLDivElement | null>(null);
  const [promptOverlayElement, setPromptOverlayElement] = useState<HTMLDivElement | null>(null);
  const [promptTranscriptInset, setPromptTranscriptInset] = useState(0);
  const promptTranscriptInsetRef = useRef(0);
  promptTranscriptInsetRef.current = promptTranscriptInset;
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const promptRestingRef = useRef(false);
  const isAtEndRef = useRef(true);
  const transcriptOverflowsRef = useRef(false);
  const [transcriptOverflows, setTranscriptOverflows] = useState(false);
  const scrollModeRef = useRef<TranscriptScrollMode>("following-end");
  const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
  const scrollIntentRef = useRef<"toward-end" | "away-from-end" | null>(null);
  const pendingAnchorRef = useRef<ItemId | null>(null);
  const positionedAnchorRef = useRef<ItemId | null>(null);
  const settledAnchorRef = useRef<ItemId | null>(null);
  const anchorIndexRef = useRef<number | null>(null);
  const userScrollGeneration = useRef(0);
  const followArmedGeneration = useRef(0);
  const pillDebouncer = useRef<Debouncer<() => void> | null>(null);
  if (pillDebouncer.current === null) {
    pillDebouncer.current = new Debouncer(() => setShowScrollToBottom(true), { wait: 150 });
  }

  const armFollow = useCallback(() => {
    followArmedGeneration.current = userScrollGeneration.current;
  }, []);
  const isFollowArmed = useCallback(
    () => followArmedGeneration.current === userScrollGeneration.current,
    [],
  );
  const clearAnchorRefs = useCallback(() => {
    pendingAnchorRef.current = null;
    positionedAnchorRef.current = null;
    settledAnchorRef.current = null;
    anchorIndexRef.current = null;
  }, []);
  const hidePill = useCallback(() => {
    pillDebouncer.current?.cancel();
    setShowScrollToBottom(false);
  }, []);
  const isAtLogicalEnd = useCallback(
    () => resolveTranscriptIsAtEnd(listRef.current?.getState?.() as never) ?? isAtEndRef.current,
    [],
  );
  const getScrollNode = useCallback(
    () => (listRef.current?.getScrollableNode?.() as HTMLElement | null | undefined) ?? null,
    [],
  );

  /** Manual navigation stops live-follow but keeps the anchored end space (collapsing it would clamp the view). */
  const cancelLiveFollow = useCallback(() => {
    userScrollGeneration.current += 1;
    scrollModeRef.current = "free-scrolling";
    setLiveFollowEnabled(false);
    clearAnchorRefs();
  }, [clearAnchorRefs]);

  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      scrollModeRef.current = "following-end";
      armFollow();
      setLiveFollowEnabled(true);
      clearAnchorRefs();
      hidePill();
      setTranscriptAnchor((current) => releaseChatTranscriptAnchor(current));
      requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd?.({ animated });
      });
    },
    [armFollow, clearAnchorRefs, hidePill],
  );

  // A jump to another thread keeps the list mounted; pin the newly displayed one to its end.
  const previousDisplayKey = useRef(displayThreadKey);
  useEffect(() => {
    const before = previousDisplayKey.current;
    previousDisplayKey.current = displayThreadKey;
    if (before !== displayThreadKey && displayThreadKey === activeThreadKey) scrollToEnd();
  }, [activeThreadKey, displayThreadKey, scrollToEnd]);

  useEffect(() => {
    scrollModeRef.current = "following-end";
    isAtEndRef.current = true;
    scrollIntentRef.current = null;
    armFollow();
    setLiveFollowEnabled(true);
    clearAnchorRefs();
    hidePill();
    const overlayHeight = Math.ceil(promptOverlayRef.current?.getBoundingClientRect().height ?? 0);
    setPromptTranscriptInset((current) =>
      resetPromptTranscriptInset({
        currentInset: current,
        overlayHeight,
        isResting: promptRestingRef.current,
      }),
    );
  }, [armFollow, clearAnchorRefs, hidePill, threadId]);

  useEffect(
    () => () => {
      pillDebouncer.current?.cancel();
    },
    [],
  );

  // Hard pin: while the reader is following the end, a switch or a content resize puts the last row at the edge in
  // the same frame (no animation, no lag behind streaming bursts). Any manual scroll ends it (cancelLiveFollow).
  const pinWindowUntilRef = useRef(0);
  const pinToEnd = useCallback(() => {
    if (scrollModeRef.current !== "following-end" || !isFollowArmed()) return;
    const node = getScrollNode();
    if (!node) return;
    const target = node.scrollHeight - node.clientHeight;
    if (target - node.scrollTop > 1) node.scrollTop = target;
  }, [getScrollNode, isFollowArmed]);
  useEffect(() => {
    pinWindowUntilRef.current = performance.now() + 1500;
    let frame = 0;
    const tick = () => {
      pinToEnd();
      if (performance.now() < pinWindowUntilRef.current) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [displayThreadKey, pinToEnd, threadId]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    let attempts = 0;
    const attach = () => {
      const node = getScrollNode();
      const content = node?.firstElementChild;
      if (!node || !content) {
        if (attempts < 20) {
          attempts += 1;
          frame = requestAnimationFrame(attach);
        }
        return;
      }
      observer = new ResizeObserver(pinToEnd);
      observer.observe(content);
      observer.observe(node);
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [getScrollNode, pinToEnd, threadId]);

  // The first tool activity of the running turn ends the send-time framing.
  useEffect(() => {
    if (scrollModeRef.current !== "anchoring-new-turn") return;
    if (
      shouldReleaseTranscriptAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled,
        runningTurnId,
        timelineEntries,
      })
    ) {
      scrollToEnd();
    }
  }, [anchorMessageId, liveFollowEnabled, runningTurnId, scrollToEnd, timelineEntries]);

  // Opt-out gestures: break follow only when they can actually move the viewport off the live edge.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let frame = 0;
    let attempts = 0;
    const contentOverflows = (node: HTMLElement) => node.scrollHeight - node.clientHeight > 1;
    const farFromEnd = () => {
      const state = listRef.current?.getState?.() as never;
      return resolveTranscriptIsAtEnd(state) === false;
    };

    const attach = () => {
      const node = getScrollNode();
      if (!node) {
        if (attempts < 12) {
          attempts += 1;
          frame = requestAnimationFrame(attach);
        }
        return;
      }
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY > 0) {
          scrollIntentRef.current = "toward-end";
          if (isAtLogicalEnd()) composerRef.current?.restoreAtTimelineEnd();
        } else if (event.deltaY < 0) {
          scrollIntentRef.current = "away-from-end";
          if (contentOverflows(node) && !toolGroupConsumesUpwardNavigation(event.target))
            cancelLiveFollow();
        }
      };
      let touchStartY: number | null = null;
      const onTouchStart = (event: TouchEvent) => {
        touchStartY = event.touches[0]?.clientY ?? null;
      };
      const onTouchMove = () => {
        // Direction is not observable; only a drag that has carried the viewport off the end counts.
        if (touchStartY !== null && farFromEnd()) cancelLiveFollow();
      };
      const onPointerDown = (event: PointerEvent) => {
        if (event.target === node) {
          if (contentOverflows(node)) cancelLiveFollow();
          return;
        }
        if (farFromEnd()) cancelLiveFollow();
      };
      node.addEventListener("wheel", onWheel, { passive: true });
      node.addEventListener("touchstart", onTouchStart, { passive: true });
      node.addEventListener("touchmove", onTouchMove, { passive: true });
      node.addEventListener("pointerdown", onPointerDown);
      cleanup = () => {
        node.removeEventListener("wheel", onWheel);
        node.removeEventListener("touchstart", onTouchStart);
        node.removeEventListener("touchmove", onTouchMove);
        node.removeEventListener("pointerdown", onPointerDown);
      };
    };
    attach();

    const onKeyDown = (event: KeyboardEvent) => {
      const node = getScrollNode();
      const target = event.target instanceof Node ? event.target : null;
      const inScope =
        target !== null &&
        (node?.contains(target) === true ||
          target === document.body ||
          target === document.documentElement);
      if (!inScope || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (target instanceof Element && target.closest(EDITABLE_SELECTOR)) return;
      if (document.querySelector(FLOATING_LAYER_SELECTOR)) return;
      const key = event.key;
      if (key === "PageUp" || key === "Home" || key === "ArrowUp") {
        scrollIntentRef.current = "away-from-end";
        if (node && contentOverflows(node) && !toolGroupConsumesUpwardNavigation(event.target)) {
          cancelLiveFollow();
          composerRef.current?.collapseForTimelineScrollKey(key);
        }
      } else if (key === "PageDown" || key === "End" || key === "ArrowDown") {
        scrollIntentRef.current = "toward-end";
        if (farFromEnd()) cancelLiveFollow();
        composerRef.current?.collapseForTimelineScrollKey(key);
        if (isAtLogicalEnd()) composerRef.current?.restoreAtTimelineEnd();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      cleanup?.();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cancelLiveFollow, composerRef, getScrollNode, isAtLogicalEnd, threadId]);

  const pageScrollController = useMemo(
    () =>
      createPageScrollController({
        getContainer: () => getScrollNode(),
        getScrollPaddingBottomPx: () =>
          promptOverlayRef.current?.getBoundingClientRect().height ?? 0,
        onScrollStart: (key) => {
          scrollIntentRef.current = key === "PageUp" ? "away-from-end" : "toward-end";
          composerRef.current?.collapseForTimelineScrollKey(key);
          const node = getScrollNode();
          const overflows = node ? node.scrollHeight - node.clientHeight > 1 : false;
          if ((key === "PageUp" && overflows) || !isAtLogicalEnd()) cancelLiveFollow();
        },
      }),
    [cancelLiveFollow, composerRef, getScrollNode, isAtLogicalEnd],
  );
  useEffect(() => () => pageScrollController.dispose(), [pageScrollController]);

  const onTranscriptAnchorReady = useCallback((messageId: ItemId, anchorIndex: number) => {
    // Re-measuring the end space after a turn completes must not restart positioning once the user left.
    if (scrollModeRef.current !== "anchoring-new-turn") return;
    pendingAnchorRef.current = null;
    anchorIndexRef.current = anchorIndex;
    if (positionedAnchorRef.current === messageId) return;
    positionedAnchorRef.current = messageId;
    settledAnchorRef.current = null;
    let attempts = 0;
    const position = () => {
      const list = listRef.current;
      if (
        positionedAnchorRef.current !== messageId ||
        scrollModeRef.current !== "anchoring-new-turn"
      )
        return;
      if (!list && attempts < 12) {
        attempts += 1;
        requestAnimationFrame(position);
        return;
      }
      void Promise.resolve(
        list?.scrollToIndex?.({
          viewOffset: CHAT_TRANSCRIPT_ANCHOR_OFFSET,
          index: anchorIndex,
          viewPosition: 0,
          animated: true,
        }),
      ).then(() => {
        if (positionedAnchorRef.current === messageId) settledAnchorRef.current = messageId;
      });
    };
    requestAnimationFrame(position);
  }, []);

  // In anchor mode Kora, not LegendList, owns streaming scrolls.
  useEffect(() => {
    if (scrollModeRef.current !== "anchoring-new-turn" || !isFollowArmed()) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const list = listRef.current;
        const state = list?.getState?.();
        const anchorIndex = anchorIndexRef.current;
        if (
          !state ||
          anchorIndex === null ||
          pendingAnchorRef.current !== null ||
          positionedAnchorRef.current === null ||
          settledAnchorRef.current !== positionedAnchorRef.current
        ) {
          return;
        }
        const metrics = getAnchoredTurnMetrics({
          state: state as never,
          anchorIndex,
          composerOverlayHeight: promptTranscriptInsetRef.current,
          anchorOffset: CHAT_TRANSCRIPT_ANCHOR_OFFSET,
        });
        if (metrics && metrics.scrollDeltaToRevealEnd > 1) {
          void list?.scrollToOffset?.({
            offset: (state as { scroll: number }).scroll + metrics.scrollDeltaToRevealEnd,
            animated: false,
          });
        }
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [isFollowArmed, timelineEntries]);

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (!isAtEnd && isFollowArmed() && liveFollowEnabled) {
        // The end flickers false during streaming growth before the follow scroll catches up.
        hidePill();
        return;
      }
      if (isAtEnd === isAtEndRef.current && (isAtEnd || !showScrollToBottom)) return;
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        if (scrollIntentRef.current === "toward-end") composerRef.current?.restoreAtTimelineEnd();
        scrollModeRef.current = "following-end";
        armFollow();
        setLiveFollowEnabled(true);
        setTranscriptAnchor((current) => releaseChatTranscriptAnchor(current));
        hidePill();
      } else {
        scrollModeRef.current = "free-scrolling";
        userScrollGeneration.current += 1;
        setLiveFollowEnabled(false);
        // Debounced so the pill does not flash while a thread switch settles at its end.
        pillDebouncer.current?.maybeExecute();
      }
    },
    [armFollow, composerRef, hidePill, isFollowArmed, liveFollowEnabled, showScrollToBottom],
  );
  const onToolOutputCollapsedAtEnd = useCallback(
    () => composerRef.current?.restoreAtTimelineEnd(),
    [composerRef],
  );
  const onContentOverflowChange = useCallback((overflows: boolean) => {
    transcriptOverflowsRef.current = overflows;
    setTranscriptOverflows(overflows);
  }, []);

  // ---- composer overlay metrics ------------------------------------------------------------------------------------
  const publishOverlayMetrics = useCallback(() => {
    const overlay = promptOverlayRef.current;
    if (!overlay) return;
    const overlayHeight = Math.ceil(overlay.getBoundingClientRect().height);
    if (overlayHeight <= 0) return;
    setPromptTranscriptInset((current) =>
      resolvePromptTranscriptInset({
        currentInset: current,
        overlayHeight,
        isResting: promptRestingRef.current,
      }),
    );
    const mainSurface = overlay.querySelector<HTMLElement>('[data-prompt-main-surface="true"]');
    const button = overlay.parentElement?.querySelector<HTMLElement>(
      'button[aria-label="Jump to the latest message"]',
    );
    if (!mainSurface || !button) {
      setScrollToEndClearance(overlayHeight);
      return;
    }
    const buttonRect = button.getBoundingClientRect();
    setScrollToEndClearance(
      resolveScrollToEndClearance({
        overlayHeight,
        mainSurfaceTop: mainSurface.getBoundingClientRect().top,
        button: { left: buttonRect.left, right: buttonRect.right },
        attachments: Array.from(
          overlay.querySelectorAll<HTMLElement>('[data-prompt-banner-surface="attached"]'),
          (element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, left: rect.left, right: rect.right };
          },
        ),
      }),
    );
  }, []);
  const attachPromptOverlay = useCallback((node: HTMLDivElement | null) => {
    promptOverlayRef.current = node;
    setPromptOverlayElement(node);
  }, []);
  useLayoutEffect(() => {
    if (!promptOverlayElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => publishOverlayMetrics());
    observer.observe(promptOverlayElement);
    publishOverlayMetrics();
    return () => observer.disconnect();
  }, [promptOverlayElement, publishOverlayMetrics, showScrollToBottom]);
  const onRestingChange = useCallback((resting: boolean) => {
    promptRestingRef.current = resting;
  }, []);

  // ---- focus ----------------------------------------------------------------------------------------------------
  const focusPrompt = useCallback(() => composerRef.current?.focusAtEnd(), [composerRef]);
  const schedulePromptFocus = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  }, [composerRef]);
  useEffect(() => {
    if (!activeThreadKey) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focusAtEnd());
    return () => cancelAnimationFrame(frame);
  }, [activeThreadKey, composerRef]);
  useEffect(() => {
    let first = 0;
    let second = 0;
    const onFocus = () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      // The previously focused element regains focus after the window's own event; waiting two frames lets the
      // composer ignore that restore and treat what follows as a real request to expand.
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          if (shouldRefocusPromptOnWindowFocus(document.activeElement))
            composerRef.current?.focusAtEnd();
        });
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [composerRef]);

  // Type-to-focus and paste-to-focus: typing with nothing editable focused lands in the composer.
  useEffect(() => {
    if (!activeThreadKey) return;
    const guard = () => terminalFocusOwner() === null && !composerRef.current?.isModelPickerOpen();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !guard() || !shouldTypeToFocusPrompt(event)) return;
      if (composerRef.current?.insertTextAtEnd(event.key)) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !guard()) return;
      const text = pasteTextToFocusPrompt(event);
      if (text === null) return;
      const handle = composerRef.current;
      const handled =
        (!hasPastedContextChips(event.clipboardData) && handle?.pasteTextAtEnd(text)) ||
        handle?.insertTextAtEnd(text, { clipboardData: event.clipboardData! });
      if (handled) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, [activeThreadKey, composerRef]);

  // ---- optimistic messages and per-thread resets --------------------------------------------------------------------
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    if (!optimisticMessages.some((message) => serverMessageIds.has(message.id))) return;
    const timer = setTimeout(
      () =>
        setOptimisticMessages((current) =>
          current.filter((message) => !serverMessageIds.has(message.id)),
        ),
      0,
    );
    return () => clearTimeout(timer);
  }, [optimisticMessages, serverMessageIds]);
  useEffect(() => {
    setOptimisticMessages([]);
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, threadId]);

  // ---- snooze, settle, wake -------------------------------------------------------------------------------------
  const supportsSnooze = daemonConfig?.environment.capabilities.threadSnooze === true;
  const supportsSettlement = daemonConfig?.environment.capabilities.threadSettlement === true;
  const [snoozeTick, setSnoozeTick] = useState(0);
  void snoozeTick;
  void wakeAcknowledgedTick;
  const nowIso = new Date().toISOString();
  const snoozeShell = isServerThread && shell && supportsSnooze ? shell : null;
  const threadSnoozed = snoozeShell !== null && effectiveSnoozed(snoozeShell, { now: nowIso });
  const snoozedUntil = snoozeShell?.snoozedUntil ?? null;
  useEffect(() => {
    if (!threadSnoozed || !snoozedUntil) return;
    const delay = Math.min(Date.parse(snoozedUntil) - Date.now() + 50, MAX_TIMER_MS);
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => setSnoozeTick((tick) => tick + 1), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [snoozedUntil, threadSnoozed]);
  const wokeAt = snoozeShell ? threadWokeAt(snoozeShell, { now: nowIso }) : null;
  const wokeBanner = (() => {
    if (!wokeAt || !shell) return null;
    if (supportsSettlement && shell.settledOverride === "settled") return null;
    const visitedRaw = lastVisitedAtById[routeThreadKey];
    const visited = visitedRaw ? Date.parse(visitedRaw) : Number.NEGATIVE_INFINITY;
    const completed = latestCompletedAt ? Date.parse(latestCompletedAt) : Number.NEGATIVE_INFINITY;
    const baseline = Math.max(
      Number.isNaN(visited) ? Number.NEGATIVE_INFINITY : visited,
      Number.isNaN(completed) ? Number.NEGATIVE_INFINITY : completed,
    );
    return Date.parse(wokeAt) > baseline ? wokeAt : null;
  })();
  const acknowledgeWake = useCallback(() => {
    if (wokeBanner) markThreadVisitedAction(routeThreadKey, wokeBanner);
    setWakeAcknowledgedTick((tick) => tick + 1);
  }, [markThreadVisitedAction, routeThreadKey, wokeBanner]);
  const activeThreadSettled = supportsSettlement && shell?.settledOverride === "settled";
  const unsettleActiveThread = useCallback(async () => {
    const key = routeThreadKey;
    setPendingUnsettle(key);
    const result = await unsettleThread({ hostId, input: { threadId, reason: "user" } } as never);
    setPendingUnsettle((current) => (current === key ? null : current));
    if (result._tag === "Failure") reportThreadActionFailure(result, "Could not reopen the chat");
  }, [hostId, routeThreadKey, threadId, unsettleThread]);
  const unsnoozeActiveThread = useCallback(async () => {
    const key = routeThreadKey;
    setPendingUnsnooze(key);
    const result = await unsnoozeThread({ hostId, input: { threadId } } as never);
    setPendingUnsnooze((current) => (current === key ? null : current));
    if (result._tag === "Failure") {
      reportThreadActionFailure(result, "Could not bring the chat back");
    }
  }, [hostId, routeThreadKey, threadId, unsnoozeThread]);

  // ---- mode changes -----------------------------------------------------------------------------------------------
  const handleAccessModeChange = useCallback(
    (mode: AccessMode) => {
      if (mode === accessMode) return;
      const store = draftActions();
      store.setRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread)
        store.setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      if (blobEntry && isServerThread) {
        void setRuntimeMode({
          hostId,
          input: { threadId, runtimeMode: mode, createdAt: new Date().toISOString() },
        } as never);
      }
      schedulePromptFocus();
    },
    [
      accessMode,
      blobEntry,
      composerDraftTarget,
      draftActions,
      hostId,
      isLocalDraftThread,
      isServerThread,
      schedulePromptFocus,
      setRuntimeMode,
      threadId,
    ],
  );
  const handleTurnModeChange = useCallback(
    (mode: AgentTurnMode) => {
      if (mode === turnMode) return;
      const store = draftActions();
      store.setInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread)
        store.setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      schedulePromptFocus();
    },
    [composerDraftTarget, draftActions, isLocalDraftThread, schedulePromptFocus, turnMode],
  );
  const toggleTurnMode = useCallback(() => {
    if (!turnModeEnabled) return;
    handleTurnModeChange(turnMode === "plan" ? "default" : "plan");
  }, [handleTurnModeChange, turnMode, turnModeEnabled]);

  const applyAgentMode = useCallback(
    (mode: ThreadAgentMode, target: HostThreadRef | DraftId = composerDraftTarget) => {
      useAgentModeStore.getState().set(target, mode);
      const targetIsServerThread = typeof target !== "string" && isServerThread;
      if (targetIsServerThread) {
        void setAgentModeCommand({
          hostId: (target as HostThreadRef).hostId,
          input: { threadId: (target as HostThreadRef).threadId, agentMode: mode },
        } as never).then((result) => {
          if (result._tag === "Success") useAgentModeStore.getState().clear(target);
        });
      }
      schedulePromptFocus();
    },
    [composerDraftTarget, isServerThread, schedulePromptFocus, setAgentModeCommand],
  );
  const handleAgentModeChange = useCallback(
    (mode: ThreadAgentMode) => {
      // Decision D-a: leaving Swarm with workers still running asks first (Stop is the default).
      if (agentMode === "swarm" && mode === "chat" && liveSwarmWorkers > 0) {
        setSwarmLeaveConfirm({ count: liveSwarmWorkers });
        return;
      }
      applyAgentMode(mode);
    },
    [agentMode, applyAgentMode, liveSwarmWorkers],
  );
  const handleStartSwarm = useCallback(
    (target: HostThreadRef | DraftId) => applyAgentMode("swarm", target),
    [applyAgentMode],
  );

  const openAgentSetup = useCallback(
    (instanceId: AgentProfileId) => {
      void navigate({
        to: "/settings/providers" as never,
        search: { hostId, instanceId } as never,
      });
    },
    [hostId, navigate],
  );

  // ---- dock actions ------------------------------------------------------------------------------------------------
  const dock = useDockStore.getState;
  const openBrowserSurface = useCallback(
    async (profileId?: string) => {
      const result = await addBrowserSurface({
        threadRef: routeThreadRef,
        openPreview,
        ...(profileId ? { profileId } : {}),
      });
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        if (failure instanceof BrowserPrefsReadError) {
          toastManager.add(
            threadToast({
              title: "Unable to open browser",
              type: "error",
              description: errorMessageOf(failure),
            }),
          );
        }
      }
    },
    [openPreview, routeThreadRef],
  );
  const openFilesSurface = useCallback(() => {
    if (project) dock().open(routeThreadRef, "files");
  }, [dock, project, routeThreadRef]);
  const openFleetSurface = useCallback(
    () => dock().open(routeThreadRef, "fleet"),
    [dock, routeThreadRef],
  );
  const closeFleetSurface = useCallback(() => {
    const store = dock();
    const state = selectThreadDockState(store.byThreadKey, routeThreadRef);
    for (const surface of state.surfaces)
      if (surface.kind === "fleet") store.closeSurface(routeThreadRef, surface.id);
  }, [dock, routeThreadRef]);
  const openFileSurface = useCallback(
    (relativePath: string) => dock().openFile(routeThreadRef, relativePath),
    [dock, routeThreadRef],
  );
  const closePreviewPanel = useCallback(() => {
    setMaximizedDockThreadKey(null);
    dock().close(routeThreadRef);
  }, [dock, routeThreadRef]);

  const terminalOpenInput = useCallback(
    (terminalId: string) => {
      const cwd = gitCwd ?? project?.workspaceRoot;
      if (!cwd) return null;
      const worktreePath = activeThread?.worktreePath ?? null;
      return {
        hostId,
        input: {
          threadId,
          terminalId,
          cwd,
          ...(worktreePath ? { worktreePath } : {}),
          env: project
            ? projectCommandEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
            : undefined,
        },
      };
    },
    [activeThread?.worktreePath, gitCwd, hostId, project, threadId],
  );
  const startTerminal = useCallback(
    (terminalId: string) => {
      const input = terminalOpenInput(terminalId);
      if (input) void openTerminal(input as never);
    },
    [openTerminal, terminalOpenInput],
  );
  const newTerminal = useCallback(() => {
    const id = nextTerminalId(allocatableTerminalIds);
    dock().openTerminal(routeThreadRef, id);
    setTerminalFocusRequestId((value) => value + 1);
    startTerminal(id);
  }, [allocatableTerminalIds, dock, routeThreadRef, startTerminal]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (activeDockSurface?.kind !== "terminal") return;
      if (activeDockSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return;
      const id = nextTerminalId(allocatableTerminalIds);
      dock().splitTerminal(routeThreadRef, activeDockSurface.id, id, direction);
      setTerminalFocusRequestId((value) => value + 1);
      startTerminal(id);
    },
    [activeDockSurface, allocatableTerminalIds, dock, routeThreadRef, startTerminal],
  );
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (activeDockSurface?.kind !== "terminal") return;
      dock().activateTerminal(routeThreadRef, activeDockSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeDockSurface, dock, routeThreadRef],
  );
  const closeTerminalById = useCallback(
    (terminalId: string) => {
      if (activeDockSurface?.kind !== "terminal") return;
      void closeTerminal({ hostId, input: { threadId, terminalId, deleteHistory: true } } as never);
      dock().closeTerminal(routeThreadRef, activeDockSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeDockSurface, closeTerminal, dock, hostId, routeThreadRef, threadId],
  );
  const activateSurface = useCallback(
    (surface: DockSurface) => {
      dock().activateSurface(routeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId)
        setActiveWebTab(routeThreadRef, surface.resourceId);
      if (surface.kind === "terminal") setTerminalFocusRequestId((value) => value + 1);
    },
    [dock, routeThreadRef],
  );

  const closeSurfaces = useCallback(
    async (surfaces: readonly DockSurface[]) => {
      const terminalSurfaces = surfaces.filter(
        (surface): surface is TerminalDockSurface => surface.kind === "terminal",
      );
      if (terminalSurfaces.length > 0) {
        const labels = terminalSurfaces.flatMap((surface) =>
          surface.terminalIds.map((id) => {
            const summary = knownTerminals.find((s) => s.target.terminalId === id)?.state.summary;
            return resolveTerminalSessionLabel(id, summary);
          }),
        );
        if (labels.length > 0 && !(await confirmTerminalClose(labels as [string, ...string[]])))
          return;
      }
      const browserWarning = agentControlledBrowserCloseConfirmation(
        surfaces,
        webState.desktopByTabId,
      );
      if (browserWarning) {
        const api = readLocalApi();
        if (api && !(await api.dialogs.confirm(browserWarning, { variant: "destructive" }))) return;
      }
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          const snapshot = webState.sessions[surface.resourceId];
          if (snapshot) {
            await closeWebSession({
              closePreview,
              snapshot,
              tabId: surface.resourceId,
              threadRef: routeThreadRef,
            });
          }
        }
        if (surface.kind === "terminal") {
          for (const id of surface.terminalIds) {
            void closeTerminal({
              hostId,
              input: { threadId, terminalId: id, deleteHistory: true },
            } as never);
          }
        }
        dock().closeSurface(routeThreadRef, surface.id);
      }
      const remaining = selectActiveDockSurface(dock().byThreadKey, routeThreadRef);
      if (remaining?.kind === "preview" && remaining.resourceId)
        setActiveWebTab(routeThreadRef, remaining.resourceId);
    },
    [
      closePreview,
      closeTerminal,
      dock,
      hostId,
      knownTerminals,
      routeThreadRef,
      threadId,
      webState.desktopByTabId,
      webState.sessions,
    ],
  );
  const copyFilePath = useCallback(async (path: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable.");
      await navigator.clipboard.writeText(path);
      toastManager.add({ type: "success", title: "Path copied", description: path });
    } catch (cause) {
      toastManager.add(
        threadToast({
          description: errorMessageOf(cause),
          type: "error",
          title: "Failed to copy path",
        }),
      );
    }
  }, []);

  // The panel remembers which surface each group showed last, per thread.
  const lastSurfaceByGroup = useRef(new Map<string, Partial<Record<DockGroup, string>>>());
  useEffect(() => {
    if (!activeDockSurface) return;
    const memory = lastSurfaceByGroup.current.get(routeThreadKey) ?? {};
    memory[dockGroupOf(activeDockSurface)] = activeDockSurface.id;
    lastSurfaceByGroup.current.set(routeThreadKey, memory);
  }, [activeDockSurface, routeThreadKey]);
  const selectDockGroup = useCallback(
    (group: DockGroup) => {
      const selection = resolveDockSelection({
        group,
        panelOpen: dockOpen,
        surfaces: dockState.surfaces,
        activeSurfaceId: dockState.activeSurfaceId,
        lastSurfaceIdByGroup: lastSurfaceByGroup.current.get(routeThreadKey) ?? {},
      });
      if (selection.action === "close") closePreviewPanel();
      else if (selection.action === "activate") {
        const surface = dockState.surfaces.find(
          (candidate) => candidate.id === selection.surfaceId,
        );
        if (surface) activateSurface(surface);
        if (!dockOpen) dock().activateSurface(routeThreadRef, selection.surfaceId);
      } else if (group === "workers") openFleetSurface();
      else if (group === "files") openFilesSurface();
      else if (group === "browser") void openBrowserSurface();
      else newTerminal();
    },
    [
      activateSurface,
      closePreviewPanel,
      dock,
      dockOpen,
      dockState.activeSurfaceId,
      dockState.surfaces,
      newTerminal,
      openBrowserSurface,
      openFilesSurface,
      openFleetSurface,
      routeThreadKey,
      routeThreadRef,
    ],
  );
  const toggleDockPanel = useCallback(() => {
    if (dockOpen) {
      closePreviewPanel();
      return;
    }
    if (dockState.activeSurfaceId) {
      dock().activateSurface(routeThreadRef, dockState.activeSurfaceId);
      return;
    }
    if (fleetAvailable) openFleetSurface();
    else openFilesSurface();
  }, [
    closePreviewPanel,
    dock,
    dockOpen,
    dockState.activeSurfaceId,
    fleetAvailable,
    openFilesSurface,
    openFleetSurface,
    routeThreadRef,
  ]);
  const toggleDockMaximized = useCallback(() => {
    if (!canMaximizeDock) return;
    setMaximizedDockThreadKey((current) => (current === routeThreadKey ? null : routeThreadKey));
  }, [canMaximizeDock, routeThreadKey]);

  // ---- queued messages, thread preferences, interrupt ---------------------------------------------------------------
  const queuedMessages = useQueuedMessages(routeThreadKey);
  const sendGateClosed =
    activeHostUnavailable ||
    !clientPrefsHydrated ||
    threadDetailLoading ||
    activeAgentStatus === null;

  /** Puts queued messages back into the composer: prompts joined by blank lines, contexts appended. */
  const restoreQueuedMessagesToPrompt = useCallback(
    (messages: ReadonlyArray<QueuedPromptMessage>) => {
      if (messages.length === 0) return;
      const store = draftActions();
      const draft = store.getComposerDraft(composerDraftTarget);
      const parts = [promptRef.current, ...messages.map((message) => message.prompt)]
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const prompt = parts.join("\n\n");
      store.setPrompt(composerDraftTarget, prompt);
      promptRef.current = prompt;
      const terminalContexts = [
        ...(draft?.terminalContexts ?? []),
        ...messages.flatMap((message) => message.terminalContexts),
      ];
      store.setTerminalContexts(composerDraftTarget, terminalContexts);
      composerTerminalContextsRef.current = terminalContexts;
      store.setPreviewAnnotations(composerDraftTarget, [
        ...(draft?.previewAnnotations ?? []),
        ...messages.flatMap((message) => message.previewAnnotations),
      ]);
      store.setReviewComments(composerDraftTarget, [
        ...(draft?.reviewComments ?? []),
        ...messages.flatMap((message) => message.reviewComments),
      ]);
      restoreAttachmentsToComposer(messages.flatMap((message) => message.attachments));
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedPromptCursor(prompt, prompt.length),
        prompt,
        detectTrigger: true,
      });
    },
    [composerDraftTarget, composerRef, draftActions, restoreAttachmentsToComposer],
  );

  const persistThreadPrefsForNextTurn = useCallback(
    async (input: {
      branch?: string;
      createdAt: string;
      threadId: ThreadId;
      runtimeMode: AccessMode;
      modelSelection?: ModelPick;
      interactionMode: AgentTurnMode;
    }): Promise<AtomActionResult<unknown, unknown>> => {
      const success = { _tag: "Success" } as unknown as AtomActionResult<unknown, unknown>;
      if (!isServerThread || !activeServerThread) return success;
      const metadata = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: activeServerThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: activeServerThread.branch,
        ...(input.branch !== undefined ? { nextBranch: input.branch } : {}),
      });
      if (metadata) {
        const result = await updateMetadata({
          hostId,
          input: { threadId: input.threadId, ...metadata },
        } as never);
        if (result._tag === "Failure") return result;
      }
      if (input.runtimeMode !== activeServerThread.runtimeMode) {
        const result = await setRuntimeMode({
          input: {
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
            threadId: input.threadId,
          },
          hostId,
        } as never);
        if (result._tag === "Failure") return result;
      }
      if (input.interactionMode !== activeServerThread.interactionMode) {
        const result = await setInteractionMode({
          input: {
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
            threadId: input.threadId,
          },
          hostId,
        } as never);
        if (result._tag === "Failure") return result;
      }
      return success;
    },
    [
      activeServerThread,
      hostId,
      isServerThread,
      setInteractionMode,
      setRuntimeMode,
      updateMetadata,
    ],
  );

  // Latest-value mirrors keep the action callbacks below stable for the memoised children.
  const interruptRef = useRef({ activeThread, phase, routeThreadKey });
  interruptRef.current = { activeThread, phase, routeThreadKey };
  const restoreQueuedRef = useRef(restoreQueuedMessagesToPrompt);
  restoreQueuedRef.current = restoreQueuedMessagesToPrompt;
  const onInterrupt = useCallback(async () => {
    const { activeThread: thread, phase: currentPhase, routeThreadKey: key } = interruptRef.current;
    const input = buildRunningThreadTurnInterruptInput(thread, currentPhase);
    if (!input) return;
    // Stop wins over the queue: restore what was waiting instead of letting it start a turn when this one settles.
    restoreQueuedRef.current(useQueuedMessageStore.getState().drain(key));
    const result = await interruptTurn({ hostId, input } as never);
    if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
      setThreadError(
        input.threadId,
        errorMessageOf(squashAtomActionFailure(result), "Failed to interrupt the current turn."),
      );
    }
  }, [hostId, interruptTurn, setThreadError]);

  // ---- background work banner -------------------------------------------------------------------------------------
  const backgroundLiveness =
    !isWorking && isServerThread ? (shell?.backgroundLiveness ?? null) : null;
  useEffect(() => {
    setBackgroundStopPending(null);
  }, [routeThreadKey]);
  useEffect(() => {
    if (backgroundLiveness === null) setBackgroundStopPending(null);
  }, [backgroundLiveness]);
  const stopBackgroundWork = useCallback(async () => {
    if (!activeThread) return;
    const key = routeThreadKey;
    setBackgroundStopPending(key);
    const result = await interruptTurn({
      hostId,
      input: buildThreadTurnInterruptInput(activeThread),
    } as never);
    if (result._tag === "Failure") {
      setBackgroundStopPending((current) => (current === key ? null : current));
      if (!isAtomActionInterrupted(result))
        setThreadError(threadId, "Failed to stop background work.");
    }
    // On success "Stopping..." holds until liveness clears: the interrupt returning only means it was accepted.
  }, [activeThread, hostId, interruptTurn, routeThreadKey, setThreadError, threadId]);

  // ---- retry / starters / artifact templates ----------------------------------------------------------------------
  const lastRetryableUserMessage = useMemo(() => {
    for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
      const message = serverMessages[index]!;
      if (message.role !== "user") continue;
      return message.text.trim().length > 0 ? message : null;
    }
    return null;
  }, [serverMessages]);
  const onSendRef = useRef<(...args: never[]) => unknown>(() => undefined);
  const sendStarterPrompt = useCallback(
    (prompt: string) => {
      if (promptRef.current.trim().length > 0) {
        composerRef.current?.focusAtEnd();
        return;
      }
      if (!composerRef.current?.insertTextAtEnd(prompt)) return;
      requestAnimationFrame(() => {
        (onSendRef.current as (...args: unknown[]) => unknown)();
      });
    },
    [composerRef],
  );
  const insertStarterText = useCallback(
    (text: string) => {
      composerRef.current?.insertTextAtEnd(text);
      composerRef.current?.focusAtEnd();
    },
    [composerRef],
  );
  const useArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const addition = codexArtifactTemplatePromptToAppend(promptRef.current, template);
      const inserted =
        addition === null
          ? true
          : composerRef.current?.insertTextAtEnd(addition, { ensureLeadingBoundary: true });
      if (!inserted) {
        toastManager.add({
          description: "The composer is busy; try again once it is ready.",
          title: "Unable to add to chat",
          type: "error",
        });
        return;
      }
      composerRef.current?.focusAtEnd();
    },
    [composerRef],
  );
  // "show all" on a bounded Read: the request goes into the composer for the user to send (the word "whole" also tells
  // Kora's bounded-Read hook to hand the file over untouched).
  const askWholeFile = useCallback(
    (filePath: string, total: number) => {
      const shown = formatWorkspaceRelativePath(filePath, transcriptWorkspaceRoot);
      const inserted = composerRef.current?.insertTextAtEnd(
        `Read the whole of ${shown} (all ${total} lines).`,
        { ensureLeadingBoundary: true },
      );
      if (!inserted) {
        toastManager.add({
          description: "The composer is busy; try again once it is ready.",
          title: "Unable to add to chat",
          type: "error",
        });
        return;
      }
      composerRef.current?.focusAtEnd();
    },
    [composerRef, transcriptWorkspaceRoot],
  );
  const addTerminalExcerptToDraft = useCallback(
    (selection: TerminalExcerptSelection) => composerRef.current?.addTerminalContext(selection),
    [composerRef],
  );

  // ---- compact availability ---------------------------------------------------------------------------------------
  const hasRealUserMessage = useMemo(
    () =>
      serverMessages.some(
        (message) => message.role === "user" && !isCompactCommandMessage(message),
      ),
    [serverMessages],
  );
  const compactAgent =
    hasAvailableCompactionAgent({
      providers: agentEntries,
      driverKind: selectedDriverKind ?? ("claude" as AgentId),
      instanceId: activeProfileId,
      lockedInstanceId: (sessionInstanceId ??
        activeThread?.modelSelection?.instanceId ??
        null) as AgentProfileId | null,
    }) && agentSupportsManualCompaction(selectedAgentEntry);
  const compactUnavailable =
    !activeThread ||
    !hasRealUserMessage ||
    !project ||
    !isServerThread ||
    !compactAgent ||
    isWorking ||
    threadDetailLoading ||
    activeHostUnavailable ||
    allApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    offerPlanFollowUp;
  const compactDisabledReason = !compactUnavailable
    ? null
    : !project
      ? "Choose a project before compacting"
      : !compactAgent
        ? "Compaction is unavailable for this provider"
        : "Compacting is unavailable right now";

  // ---- banners ---------------------------------------------------------------------------------------------------------
  const nowMinute = new Date().toISOString().slice(0, 16);
  const resumeDismissalsRef = useRef(new Set<string>());
  const resumePermanentKey = `kora:resume-compaction-dismissed:${hostId}:${activeProfileId ?? "claude"}`;
  const [resumePermanentlyDismissed, setResumePermanentlyDismissed] = useLocalStorage(
    resumePermanentKey,
    false,
    Schema.Boolean,
  );
  void resumeDismissalTick;
  const resumeKey = contextWindow ? `${threadId}:${contextWindow.updatedAt}` : null;
  const nativeResumeDismissed = hasDismissedResumeCompaction(activities);
  useEffect(() => {
    if (nativeResumeDismissed && !resumePermanentlyDismissed) setResumePermanentlyDismissed(true);
  }, [nativeResumeDismissed, resumePermanentlyDismissed, setResumePermanentlyDismissed]);
  const showResumeBanner =
    contextWindow !== null &&
    resumeKey !== null &&
    !resumeDismissalsRef.current.has(resumeKey) &&
    !resumePermanentlyDismissed &&
    !nativeResumeDismissed &&
    pendingUserInputs.length === 0 &&
    phase !== "running" &&
    shouldOfferResumeCompaction({
      provider: selectedDriverKind ?? null,
      usedTokens: contextWindow.usedTokens,
      updatedAt: contextWindow.updatedAt,
      now: `${nowMinute}:00.000Z`,
    });

  const openUsageSettings = useCallback(() => {
    void navigate({ to: "/settings/usage" as never });
  }, [navigate]);
  const planLimit = activePlanLimit(activeAgentStatus?.usageLimits, Date.now());

  const bannerItems = useMemo<PromptBannerStackItem[]>(() => {
    const items: PromptBannerStackItem[] = [];

    if (hostUnavailableState) {
      const reconnecting = reconnectingHostId !== null;
      if (!reconnecting || reconnectWarningElapsed) {
        const isError = hostUnavailableState.connection.phase === "error";
        items.push({
          id: `host-unavailable:${hostUnavailableState.hostId}`,
          variant: isError ? "error" : "warning",
          priority: "urgent",
          icon: <WifiOffIcon className="size-4" />,
          title: reconnecting
            ? `${hostUnavailableState.label} is reconnecting`
            : `${hostUnavailableState.label} is offline`,
          ...(reconnecting
            ? {
                // A stopped daemon reconnects forever: say what that means and where to look.
                // There is no in-app restart: reopening Kora starts the service, and Diagnostics says why it stopped.
                description:
                  "Kora's local service isn't answering. Diagnostics shows why; quitting and reopening Kora starts it again.",
                actions: (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void navigate({ to: "/settings/diagnostics" as never })}
                  >
                    Diagnostics
                  </Button>
                ),
              }
            : {
                actions: (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void retryHost(hostUnavailableState.hostId)}
                  >
                    Reconnect
                  </Button>
                ),
              }),
        } as PromptBannerStackItem);
      }
    }

    if (planLimit) {
      const providerName = selectedAgentEntry?.displayName ?? "This provider";
      const reset =
        planLimit.resetsAt !== null ? formatResetPhrase(planLimit.resetsAt, Date.now()) : null;
      items.push({
        id: `plan-limit:${providerName}:${planLimit.resetsAt ?? "open"}`,
        variant: "warning",
        priority: "urgent",
        icon: <GaugeIcon className="size-4" />,
        title: `${providerName} usage limit reached${reset ? ` · ${reset}` : ""}`,
        description: "Pick another model or agent below to keep going in this chat.",
        actions: (
          <Button size="xs" variant="ghost" onClick={openUsageSettings}>
            Usage
          </Button>
        ),
      });
    }

    if (backgroundLiveness) {
      const stopping = backgroundStopPending === routeThreadKey;
      const working = backgroundLiveness === "working";
      items.push({
        id: `background-liveness:${threadId}`,
        variant: "default",
        priority: "activity",
        icon: (
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full bg-foreground", working && "animate-status-pulse")}
          />
        ),
        title: working
          ? liveWorkers > 0
            ? `${liveWorkers} ${liveWorkers === 1 ? "agent" : "agents"} working`
            : "Background work"
          : "Monitoring",
        actions: (
          <Button
            disabled={stopping}
            size="xs"
            variant="ghost"
            onClick={() => void stopBackgroundWork()}
          >
            {stopping ? "Stopping..." : "Stop"}
          </Button>
        ),
      });
    }

    if (showResumeBanner && contextWindow && resumeKey) {
      const button = (
        <Button
          disabled={compactUnavailable}
          size="xs"
          variant="ghost"
          onClick={() => composerRef.current?.compactContext()}
        >
          Compact
        </Button>
      );
      items.push({
        id: `resume-compaction:${resumeKey}`,
        variant: "info",
        icon: <Minimize2Icon className="size-4" />,
        title: "Resume with less context",
        description: `${formatContextWindowTokens(contextWindow.usedTokens)} tokens from earlier`,
        actions:
          compactUnavailable && compactDisabledReason ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
              <TooltipPopup side="top">{compactDisabledReason}</TooltipPopup>
            </Tooltip>
          ) : (
            button
          ),
        dismissLabel: "Keep full history",
        onDismiss: () => {
          resumeDismissalsRef.current.add(resumeKey);
          setResumeDismissalTick((tick) => tick + 1);
        },
      });
    }

    if (wokeBanner) {
      items.push({
        id: `thread-woke:${threadId}`,
        variant: "info",
        icon: <AlarmClockIcon className="size-4" />,
        title: "Back from snooze",
        description: "Pick up where you left off.",
        dismissLabel: "Dismiss the snooze notice",
        onDismiss: acknowledgeWake,
      });
    }

    if (threadSnoozed || activeThreadSettled) {
      const snoozed = threadSnoozed;
      const pending = snoozed
        ? pendingUnsnooze === routeThreadKey
        : pendingUnsettle === routeThreadKey;
      items.push({
        id: `${snoozed ? "thread-snoozed" : "thread-settled"}:${threadId}`,
        variant: "info",
        icon: snoozed ? (
          <AlarmClockIcon className="size-4" />
        ) : (
          <CheckCircle2Icon className="size-4" />
        ),
        title: snoozed ? "Snoozed" : "Marked done",
        description: snoozed
          ? "Sending a message brings it back."
          : "Sending a message reopens it.",
        actions: (
          <Button
            disabled={pending}
            size="xs"
            variant="ghost"
            onClick={() => void (snoozed ? unsnoozeActiveThread() : unsettleActiveThread())}
          >
            {snoozed
              ? pending
                ? "Bringing back…"
                : "Bring back now"
              : pending
                ? "Reopening…"
                : "Reopen"}
          </Button>
        ),
      });
    }
    return items;
  }, [
    acknowledgeWake,
    activeThreadSettled,
    backgroundLiveness,
    backgroundStopPending,
    compactDisabledReason,
    compactUnavailable,
    composerRef,
    contextWindow,
    hostUnavailableState,
    liveWorkers,
    navigate,
    openUsageSettings,
    pendingUnsettle,
    pendingUnsnooze,
    planLimit,
    reconnectWarningElapsed,
    reconnectingHostId,
    resumeKey,
    retryHost,
    routeThreadKey,
    selectedAgentEntry?.displayName,
    showResumeBanner,
    stopBackgroundWork,
    threadId,
    threadSnoozed,
    unsettleActiveThread,
    unsnoozeActiveThread,
    wokeBanner,
  ]);

  // ---- composer content helpers -----------------------------------------------------------------------------------------
  const clearComposerText = useCallback(() => {
    draftActions().setPrompt(composerDraftTarget, "");
    promptRef.current = "";
    composerRef.current?.resetCursorState({ cursor: 0, prompt: "", detectTrigger: false });
  }, [composerDraftTarget, composerRef, draftActions]);
  const clearComposerAfterSend = useCallback(() => {
    draftActions().clearComposerContent(composerDraftTarget);
    attachmentStore.getState().clearAttachments(composerDraftTarget);
    promptRef.current = "";
    composerTerminalContextsRef.current = [];
    composerRef.current?.resetCursorState({ cursor: 0, prompt: "", detectTrigger: false });
  }, [attachmentStore, composerDraftTarget, composerRef, draftActions]);

  // ---- approvals, user input, worker picker ---------------------------------------------------------------------------
  const onRespondToApproval = useCallback(
    async (requestId: RequestId, decision: AgentApprovalDecision) => {
      setRespondingRequestIds((current) =>
        current.includes(requestId) ? current : [...current, requestId],
      );
      const result = await respondToApproval({
        hostId,
        input: { threadId, requestId, decision },
      } as never);
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        setThreadError(threadId, "Failed to submit approval decision.");
      }
      setRespondingRequestIds((current) => current.filter((id) => id !== requestId));
      return result;
    },
    [hostId, respondToApproval, setThreadError, threadId],
  );
  const blobApprovalApi = useMemo<BlobApprovalApi | null>(
    () =>
      blobId !== null || groupId !== null
        ? {
            respond: (requestId, decision) =>
              onRespondToApproval(requestId as RequestId, decision as AgentApprovalDecision),
            responding: respondingRequestIds,
            live: isWorking,
          }
        : null,
    [blobId, groupId, isWorking, onRespondToApproval, respondingRequestIds],
  );

  const answerWorkerPicker = useCallback(
    async (requestId: RequestId, answers: Record<string, unknown>) => {
      if (workerPickerBusyId === requestId) return;
      setWorkerPickerBusyId(requestId);
      const result = await respondToUserInput({
        hostId,
        input: { threadId, requestId, answers },
      } as never);
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        setThreadError(threadId, "Failed to answer the worker picker.");
      }
      setWorkerPickerBusyId((current) => (current === requestId ? null : current));
    },
    [hostId, respondToUserInput, setThreadError, threadId, workerPickerBusyId],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: RequestId, answers: Record<string, string | string[]>) => {
      const key = JSON.stringify([hostId, threadId, requestId]);
      if (
        !activePendingQuestion ||
        respondingUserInputIds.includes(requestId) ||
        userInputInFlight.current.has(key)
      ) {
        return;
      }
      userInputInFlight.current.add(key);
      setRespondingUserInputIds((current) => [...current, requestId]);
      const result = await respondToUserInput({
        hostId,
        input: { threadId, requestId, answers },
      } as never);
      if (result._tag === "Failure") {
        if (!isAtomActionInterrupted(result))
          setThreadError(threadId, "Failed to submit user input.");
      } else {
        clearComposerText();
      }
      userInputInFlight.current.delete(key);
      setRespondingUserInputIds((current) => current.filter((id) => id !== requestId));
    },
    [
      activePendingQuestion,
      clearComposerText,
      hostId,
      respondToUserInput,
      respondingUserInputIds,
      setThreadError,
      threadId,
    ],
  );
  const onDismissActivePendingUserInput = useCallback(
    async (requestId: RequestId) => {
      const result = await dismissUserInput({ hostId, input: { threadId, requestId } } as never);
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        setThreadError(threadId, "Failed to dismiss the question.");
      } else if (result._tag === "Success") {
        clearComposerText();
      }
    },
    [clearComposerText, dismissUserInput, hostId, setThreadError, threadId],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (!activePendingQuestion || !activePendingKey) return;
      const question = activePendingQuestion.questions.find(
        (candidate) => candidate.id === questionId,
      );
      if (!question) return;
      setPendingDraftAnswers((current) => {
        const forRequest = current[activePendingKey] ?? {};
        return {
          ...current,
          [activePendingKey]: {
            ...forRequest,
            [questionId]: togglePendingQuestionOptionSelection(
              question,
              forRequest[questionId],
              optionValue,
            ),
          },
        };
      });
      clearComposerText();
    },
    [activePendingKey, activePendingQuestion, clearComposerText],
  );
  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      targetQuestionId: string,
      typed: string,
      caret: number,
      expandedCaret: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingQuestion || !activePendingKey) return;
      const question = activePendingQuestion.questions.find(
        (candidate) => candidate.id === targetQuestionId,
      );
      if (!question || question.allowCustomAnswer === false) return;
      setPendingDraftAnswers((current) => {
        const forRequest = current[activePendingKey] ?? {};
        return {
          ...current,
          [activePendingKey]: {
            ...forRequest,
            [targetQuestionId]: setPendingQuestionCustomAnswer(forRequest[targetQuestionId], typed),
          },
        };
      });
      promptRef.current = typed;
      const snapshot = composerRef.current?.readSnapshot();
      if (
        !snapshot ||
        snapshot.value !== typed ||
        snapshot.expandedCursor !== expandedCaret ||
        snapshot.cursor !== caret
      ) {
        composerRef.current?.focusAt(caret);
      }
    },
    [activePendingKey, activePendingQuestion, composerRef],
  );
  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingQuestion || !activePendingKey || !activePendingProgress) return;
    if (!activePendingProgress.canAdvance || activePendingIsResponding) return;
    if (activePendingProgress.isLastQuestion) {
      if (!activePendingResolvedAnswers) return;
      void onRespondToUserInput(activePendingQuestion.requestId, activePendingResolvedAnswers);
      return;
    }
    const nextIndex = activePendingProgress.questionIndex + 1;
    setPendingQuestionIndex((current) => ({ ...current, [activePendingKey]: nextIndex }));
    const nextQuestion = activePendingQuestion.questions[nextIndex];
    const nextCustom = nextQuestion
      ? (activePendingDraftAnswers[nextQuestion.id]?.customAnswer ?? "")
      : "";
    draftActions().setPrompt(composerDraftTarget, nextCustom);
    promptRef.current = nextCustom;
    composerRef.current?.resetCursorState({
      cursor: nextCustom.length,
      prompt: nextCustom,
      detectTrigger: false,
    });
  }, [
    activePendingResolvedAnswers,
    activePendingProgress,
    onRespondToUserInput,
    draftActions,
    activePendingIsResponding,
    activePendingKey,
    activePendingQuestion,
    activePendingDraftAnswers,
    composerDraftTarget,
    composerRef,
  ]);
  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingQuestion || !activePendingKey || !activePendingProgress) return;
    const previousIndex = Math.max(0, activePendingProgress.questionIndex - 1);
    setPendingQuestionIndex((current) => ({ ...current, [activePendingKey]: previousIndex }));
    const previousQuestion = activePendingQuestion.questions[previousIndex];
    const previousCustom = previousQuestion
      ? (activePendingDraftAnswers[previousQuestion.id]?.customAnswer ?? "")
      : "";
    draftActions().setPrompt(composerDraftTarget, previousCustom);
    promptRef.current = previousCustom;
    composerRef.current?.resetCursorState({
      cursor: previousCustom.length,
      prompt: previousCustom,
      detectTrigger: false,
    });
  }, [
    activePendingDraftAnswers,
    activePendingKey,
    activePendingProgress,
    activePendingQuestion,
    composerDraftTarget,
    composerRef,
    draftActions,
  ]);

  // ---- plan follow-up -------------------------------------------------------------------------------------------------
  const onSubmitPlanFollowUp = useCallback(
    async (input: {
      text: string;
      context: ReturnType<typeof buildMessageContext>;
      interactionMode: AgentTurnMode;
    }): Promise<boolean> => {
      const composer = composerRef.current;
      const sendContext = composer?.getSendContext();
      if (
        !activeServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current ||
        input.text.trim().length === 0 ||
        !sendContext?.providerAvailable ||
        !sendContext.interactionModeEnabled
      ) {
        return false;
      }
      sendInFlightRef.current = true;
      beginLocalDispatch({ submissionIntent: "foreground" });
      setThreadError(threadId, null);
      scrollToEnd();

      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      setOptimisticMessages((current) => [
        ...current,
        {
          id: messageId,
          role: "user",
          text: input.text,
          ...(input.context ? { context: input.context } : {}),
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        } as OptimisticMessage,
      ]);

      let turnStarted = false;
      try {
        const prefs = await persistThreadPrefsForNextTurn({
          threadId,
          createdAt,
          ...(sendContext.selectedModelSelection
            ? { modelSelection: sendContext.selectedModelSelection }
            : {}),
          runtimeMode: accessMode,
          interactionMode: input.interactionMode,
        });
        if (prefs._tag === "Failure") throw squashAtomActionFailure(prefs as never);
        // Keep the toggle and the follow-up banner in sync while the same-thread implementation turn starts.
        draftActions().setInteractionMode(composerDraftTarget, input.interactionMode);

        // The local daemon always understands inline context references.
        const text = input.text;
        const result = await startTurn({
          hostId,
          input: {
            threadId,
            message: {
              messageId,
              role: "user",
              text,
              attachments: [],
              ...(input.context ? { context: input.context } : {}),
            },
            modelSelection: sendContext.selectedModelSelection,
            titleSeed: activeServerThread.title,
            runtimeMode: accessMode,
            interactionMode: input.interactionMode,
            ...(input.interactionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread?.id ?? threadId,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt,
          },
        } as never);
        if (result._tag === "Failure") throw squashAtomActionFailure(result as never);
        turnStarted = true;
        acknowledgeWake();
        return true;
      } catch (cause) {
        setOptimisticMessages((current) => current.filter((message) => message.id !== messageId));
        if (!isAtomActionInterrupted(cause as never)) {
          setThreadError(threadId, errorMessageOf(cause, "Failed to send plan follow-up."));
        }
        return false;
      } finally {
        sendInFlightRef.current = false;
        if (!turnStarted) resetLocalDispatch();
      }
    },
    [
      acknowledgeWake,
      accessMode,
      activeProposedPlan,
      activeServerThread,
      activeThread?.id,
      beginLocalDispatch,
      composerDraftTarget,
      composerRef,
      daemonConfig,
      draftActions,
      hostId,
      isConnecting,
      isSendBusy,
      persistThreadPrefsForNextTurn,
      resetLocalDispatch,
      scrollToEnd,
      setThreadError,
      startTurn,
      threadId,
    ],
  );

  // ---- send ------------------------------------------------------------------------------------------------------------
  const openNewThread = useStartNewThread();
  const draftHeroRect = useDraftStageLayoutTransition(isDraftHeroState);
  const [attachTransitionGroup, attachPromptAnchor, capturePromptRect] = draftHeroRect;

  const attachAnnotationToDraft = useCallback(
    (annotation: WebMarkupPayload, description: string) => {
      draftActions().addPreviewAnnotation(composerDraftTarget, annotation);
      toastManager.add({ type: "info", title: "Annotation attached to draft", description });
    },
    [composerDraftTarget, draftActions],
  );

  // B17: the quick-answer card (set after the hook runs, below) and a prompt "Send to agent anyway" forces through the send path.
  const quickAnswerApiRef = useRef<QuickAnswerApi | null>(null);
  const forcedPromptRef = useRef<string | null>(null);
  const sendImpl = async (
    e?: { preventDefault(): void },
    submissionIntentInput: PromptSubmissionIntent = "foreground",
    directAnnotation?: { annotation: WebMarkupPayload },
    queuedMessage?: QueuedPromptMessage,
  ): Promise<void> => {
    e?.preventDefault();

    // 1. gates
    if (
      !activeThread ||
      isConnecting ||
      isSendBusy ||
      !clientPrefsHydrated ||
      sendInFlightRef.current ||
      threadDetailLoading
    ) {
      if (directAnnotation) {
        attachAnnotationToDraft(
          directAnnotation.annotation,
          "Sending is unavailable right now. Finish the current action, then send.",
        );
      }
      return;
    }

    // 2. host unavailable
    if (activeHostUnavailable) {
      const slot = hostUnavailableToastSlot.current;
      hostUnavailableToastSlot.current = (slot + 1) % 3;
      toastManager.add({
        ...threadToast({
          description: "Kora is reconnecting. Try again in a moment.",
          title: "Not connected: message not sent",
          type: "warning",
        }),
        id: `chat-send-environment-unavailable:${slot}`,
      });
      return;
    }

    // 3. a pending question owns the send action
    if (activePendingProgress) {
      if (directAnnotation) {
        attachAnnotationToDraft(
          directAnnotation.annotation,
          "Answer the question first, then send.",
        );
        return;
      }
      if (queuedMessage) return;
      onAdvanceActivePendingUserInput();
      return;
    }

    // 4. what the composer holds
    const composer = composerRef.current;
    const sendContext = composer?.getSendContext();
    if (!composer || !sendContext || !sendContext.providerAvailable) return;
    const forcedPrompt = queuedMessage ? null : forcedPromptRef.current;
    forcedPromptRef.current = null;
    const promptText: string = queuedMessage
      ? queuedMessage.prompt
      : (forcedPrompt ?? sendContext.prompt);
    const terminalContexts: TerminalExcerptDraft[] = queuedMessage
      ? queuedMessage.terminalContexts
      : sendContext.terminalContexts;
    let previewAnnotations: WebMarkupPayload[] = queuedMessage
      ? queuedMessage.previewAnnotations
      : sendContext.previewAnnotations;
    const reviewComments: ReviewCommentContext[] = queuedMessage
      ? queuedMessage.reviewComments
      : sendContext.reviewComments;
    const attachments: PendingPromptAttachment[] = queuedMessage
      ? queuedMessage.attachments
      : sendContext.attachments;
    const {
      selectedProviderModels,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      selectedModel,
    } = sendContext;

    // 5. a direct annotation rides along with the draft
    let promptForSend = promptText;
    if (directAnnotation) {
      const annotation = { ...directAnnotation.annotation, screenshot: null } as WebMarkupPayload;
      if (!previewAnnotations.some((existing) => existing.id === annotation.id)) {
        previewAnnotations = [...previewAnnotations, annotation];
      }
      // The draft write and this send happen in the same tick, so the reference goes into the text right here.
      promptForSend = ensureInlineContextLinks(promptForSend, [
        webMarkupContextReference(annotation),
      ]);
    }

    // 6. what is actually sendable
    const sendState = derivePromptSendState({
      prompt: promptForSend,
      imageCount: attachments.length,
      terminalContexts,
      elementContextCount: previewAnnotations.length + reviewComments.length,
    });
    const {
      expiredTerminalContextCount,
      sendableTerminalContexts,
      hasSendableContent,
      trimmedPrompt,
    } = sendState;

    // 7. plan follow-up
    if (
      !directAnnotation &&
      !queuedMessage &&
      sendContext.interactionModeEnabled &&
      offerPlanFollowUp &&
      activeProposedPlan
    ) {
      const submission = resolvePlanFollowUpSubmission({
        draftText: trimmedPrompt,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoing = formatOutgoingPrompt({
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        provider: selectedProvider,
        text: submission.text,
        model: selectedModel,
      });
      if (!composer.validateProviderInput(outgoing)) return;
      const snapshot = {
        prompt: promptForSend,
        terminalContexts: [...sendableTerminalContexts],
        reviewComments: [...reviewComments],
        previewAnnotations: [...previewAnnotations],
      };
      const context = buildMessageContext({
        terminalContexts: sendableTerminalContexts,
        reviewComments,
        previewAnnotations,
      });
      clearComposerAfterSend();
      const started = await onSubmitPlanFollowUp({
        text: outgoing,
        context,
        interactionMode: submission.interactionMode,
      });
      if (!started) {
        const store = draftActions();
        restorePlanFollowUpPrompt({
          snapshot,
          writePrompt: (prompt) => {
            store.setPrompt(composerDraftTarget, prompt);
            promptRef.current = prompt;
          },
          writeTerminalContexts: (contexts) => {
            store.setTerminalContexts(composerDraftTarget, [...contexts]);
            composerTerminalContextsRef.current = [...contexts];
          },
          writeReviewComments: (comments) =>
            store.setReviewComments(composerDraftTarget, [...comments]),
          writePreviewAnnotations: (annotations) =>
            store.setPreviewAnnotations(composerDraftTarget, [...annotations]),
          resetCursor: (options) => composerRef.current?.resetCursorState(options),
        });
      }
      return;
    }

    // 8. standalone slash commands
    const hasContexts =
      sendableTerminalContexts.length > 0 ||
      previewAnnotations.length > 0 ||
      reviewComments.length > 0;
    if (
      sendContext.interactionModeEnabled &&
      !hasContexts &&
      !queuedMessage &&
      attachments.length === 0
    ) {
      const command = parseStandalonePromptSlashCommand(trimmedPrompt);
      if (command) {
        handleTurnModeChange(command);
        clearComposerAfterSend();
        return;
      }
    }

    // 8b. a pure "who calls X" question is answered from the code graph, with no agent turn (the daemon's parser is strict)
    if (
      forcedPrompt === null &&
      !hasContexts &&
      !queuedMessage &&
      !directAnnotation &&
      attachments.length === 0 &&
      phase !== "running" &&
      quickAnswerApiRef.current
    ) {
      sendInFlightRef.current = true;
      let answered = false;
      try {
        answered = await quickAnswerApiRef.current.tryAnswer(trimmedPrompt);
      } finally {
        sendInFlightRef.current = false;
      }
      if (answered) {
        clearComposerAfterSend();
        return;
      }
    }

    // 9. nothing to send
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const copy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "empty");
        toastManager.add({ type: "warning", title: copy.title, description: copy.description });
      }
      // A queued message with nothing in it would retry at every boundary and block the rest of the queue.
      if (queuedMessage) useQueuedMessageStore.getState().remove(routeThreadKey, queuedMessage.id);
      return;
    }

    // 10. a project is required
    if (!project) {
      toastManager.add({
        description: "This draft no longer points to an available project.",
        title: "Choose a project first",
        type: "warning",
      });
      return;
    }

    // 11. queue while a turn is running
    if (!queuedMessage && !directAnnotation && phase === "running") {
      const queuedPrompt = promptForSend;
      const outgoingForCheck = formatOutgoingPrompt({
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        provider: selectedProvider,
        model: selectedModel,
        text: trimmedPrompt,
      });
      if (!composer.validateProviderInput(outgoingForCheck)) return;
      useQueuedMessageStore.getState().enqueue(routeThreadKey, {
        prompt: queuedPrompt,
        terminalContexts: [...sendableTerminalContexts],
        previewAnnotations: [...previewAnnotations],
        reviewComments: [...reviewComments],
        attachments: [...attachments],
        submissionIntent: submissionIntentInput,
        queuedAfterToolActivityId: latestCompletedToolActivityId(activities),
        createdAt: new Date().toISOString(),
      });
      clearComposerAfterSend();
      return;
    }

    // 12. snapshots and outgoing payload
    const terminalSnapshot = [...sendableTerminalContexts];
    const annotationSnapshot = [...previewAnnotations];
    const commentSnapshot = [...reviewComments];
    const attachmentSnapshot = [...attachments];
    let sendText = promptForSend;
    for (const context of terminalContexts) {
      if (sendableTerminalContexts.some((candidate) => candidate.id === context.id)) continue;
      sendText = removeInlineContextLink(
        sendText,
        terminalExcerptReference(context).contextId,
      ).prompt;
    }
    const messageContext = buildMessageContext({
      terminalContexts: terminalSnapshot,
      reviewComments: commentSnapshot,
      previewAnnotations: annotationSnapshot,
    });
    const outgoingText = formatOutgoingPrompt({
      model: selectedModel,
      effort: selectedPromptEffort,
      provider: selectedProvider,
      models: selectedProviderModels,
      text: sendText.trim(),
    });
    if (!composer.validateProviderInput(outgoingText)) {
      // A queued message that no longer fits waits at the head for the user to edit it via Cancel.
      if (queuedMessage)
        useQueuedMessageStore.getState().holdAtFront(routeThreadKey, queuedMessage);
      return;
    }

    // 13. take ownership
    sendInFlightRef.current = true;
    let sentQueued: QueuedPromptMessage | null = null;
    if (queuedMessage) {
      const drainGenerationBefore = useQueuedMessageStore.getState().drainGeneration;
      sentQueued = useQueuedMessageStore
        .getState()
        .take(routeThreadKey, queuedMessage.id, latestCompletedToolActivityId(activities));
      if (!sentQueued) {
        sendInFlightRef.current = false;
        return;
      }
      if (useQueuedMessageStore.getState().drainGeneration !== drainGenerationBefore) {
        // Stop drained the queue while this message was being prepared: hand it back instead of starting a turn.
        restoreQueuedMessagesToPrompt([sentQueued]);
        sendInFlightRef.current = false;
        return;
      }
    }

    // 14. submission intent and the hero transition
    const effectiveIntent: PromptSubmissionIntent =
      isLocalDraftThread && submissionIntentInput === "background" ? "background" : "foreground";
    if (
      shouldDockDraftHeroForSubmission({
        isDraftHeroState,
        activeThreadKey,
        submissionIntent: effectiveIntent,
      })
    ) {
      flushSync(() => {
        capturePromptRect();
        setDockedDraftHeroThreadKey(activeThreadKey);
      });
    }

    // 15. local dispatch and scroll framing
    beginLocalDispatch({ submissionIntent: effectiveIntent });
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const firstUserMessage =
      !serverMessages.some((message) => message.role === "user") &&
      activeThread.latestTurn === null;
    if (firstUserMessage) {
      scrollModeRef.current = "anchoring-new-turn";
      isAtEndRef.current = true;
      armFollow();
      setLiveFollowEnabled(true);
      pendingAnchorRef.current = messageId as unknown as ItemId;
      positionedAnchorRef.current = null;
      settledAnchorRef.current = null;
      anchorIndexRef.current = null;
      hidePill();
      setTranscriptAnchor({ threadKey: routeThreadKey, messageId: messageId as unknown as ItemId });
    } else {
      scrollToEnd();
    }

    // 16. optimistic message
    setOptimisticMessages((current) => [
      ...current,
      {
        id: messageId,
        role: "user",
        text: outgoingText,
        ...(messageContext ? { context: messageContext } : {}),
        ...(attachmentSnapshot.length > 0
          ? { attachments: attachmentSnapshot.map(pendingPromptAttachmentToOptimistic) }
          : {}),
        turnId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      } as OptimisticMessage,
    ]);
    setThreadError(threadId, null);
    if (expiredTerminalContextCount > 0) {
      const copy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "omitted");
      toastManager.add({ type: "warning", title: copy.title, description: copy.description });
    }
    if (!sentQueued) clearComposerAfterSend();

    // 17-18. title seed and model pick
    const titleSeed = (() => {
      const text = assistantFootnotesToPlainText(stripInlineContextLinks(sendText.trim())).trim();
      if (text) return truncate(text);
      const terminal = terminalSnapshot[0];
      if (terminal) return truncate(formatTerminalExcerptLabel(terminal));
      const comment = commentSnapshot[0];
      if (comment) return truncate(`Review: ${reviewCommentContextLabel(comment)}`);
      const annotation = annotationSnapshot[0];
      if (annotation) return truncate(webMarkupContextLabel(annotation));
      return "New chat";
    })();
    const threadModelPick: ModelPick = createModelPick(
      selectedModelSelection.instanceId,
      selectedModelSelection.model || projectDefaultModelChoice?.model || DEFAULT_MODEL,
      selectedModelSelection.options,
    );

    let turnStarted = false;
    let openedFreshDraft = false;
    try {
      const sendBranch = activeThread.branch ?? null;
      // 19. persist what the next turn needs
      if (isServerThread) {
        if (firstUserMessage) {
          const renamed = await updateMetadata({
            hostId,
            input: { threadId, title: titleSeed },
          } as never);
          if (renamed._tag === "Failure") throw squashAtomActionFailure(renamed as never);
        }
        const persisted = await persistThreadPrefsForNextTurn({
          threadId,
          createdAt,
          ...(selectedModel ? { modelSelection: threadModelPick } : {}),
          runtimeMode: accessMode,
          interactionMode: sendContext.interactionMode,
        });
        if (persisted._tag === "Failure") throw squashAtomActionFailure(persisted as never);
      }

      // 20. start the turn
      const bootstrap = isLocalDraftThread
        ? {
            createThread: {
              projectId: activeThread.projectId,
              title: titleSeed,
              modelSelection: threadModelPick,
              runtimeMode: accessMode,
              interactionMode: sendContext.interactionMode,
              agentMode,
              branch: sendBranch,
              worktreePath: activeThread.worktreePath,
              createdAt,
            },
          }
        : undefined;
      if (effectiveIntent === "background" && draftId) {
        beginBackgroundDraftSubmissionByRef(routeThreadRef);
      }
      const startPromise = startTurn({
        hostId,
        input: {
          threadId,
          message: {
            messageId,
            role: "user",
            text: outgoingText,
            attachments: attachmentSnapshot.map(pendingPromptAttachmentToUpload),
            ...(messageContext ? { context: messageContext } : {}),
          },
          modelSelection: threadModelPick,
          titleSeed,
          runtimeMode: accessMode,
          interactionMode: sendContext.interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt,
        },
      } as never);
      if (effectiveIntent === "background" && draftId && projectRef) {
        markDraftPromoted(routeThreadRef);
        try {
          const opened = await openNewThread(
            projectRef,
            resolveBackgroundDraftWorkspaceOptions({
              envMode: "local",
              branch: sendBranch,
              startFromOrigin: false,
            }),
          );
          openedFreshDraft = opened !== null;
        } catch (cause) {
          clearBackgroundDraftSubmissionByRef(routeThreadRef);
          toastManager.add({
            type: "warning",
            title: "Could not open a fresh composer",
            description: errorMessageOf(cause),
          });
        }
      }
      const result = await startPromise;
      if (result._tag === "Failure") throw squashAtomActionFailure(result as never);
      turnStarted = true;

      // 21. after the turn is accepted
      if (
        isLocalDraftThread &&
        blobEntry &&
        promptAccessMode !== null &&
        promptAccessMode !== defaultAccessMode
      ) {
        void setRuntimeMode({
          hostId,
          input: { threadId, runtimeMode: promptAccessMode, createdAt: new Date().toISOString() },
        } as never);
      }
      acknowledgeWake();
      if (effectiveIntent === "background") {
        const routeMoved = routeThreadKeyRef.current !== routeThreadKey;
        if (openedFreshDraft || routeMoved) finalizePromotedDraftByRef(routeThreadRef);
        else clearBackgroundDraftSubmissionByRef(routeThreadRef);
        if (openedFreshDraft) {
          toastManager.add({
            type: "success",
            title: "Started in background",
            timeout: 5000,
            actionProps: {
              children: "Open",
              onClick: () =>
                void navigate({ to: "/$hostId/$threadId", params: { hostId, threadId } as never }),
            },
          } as never);
        }
      }
    } catch (cause) {
      const interrupted = isAtomActionInterrupted(cause as never);
      const bootstrapDeleted = wasBootstrapThreadDeleted(cause);
      if (effectiveIntent === "background" && draftId && draftThread) {
        restoreFailedBackgroundDraftThread(
          draftId,
          draftThread,
          bootstrapDeleted ? newThreadId() : threadId,
        );
        clearBackgroundDraftSubmissionByRef(routeThreadRef);
      }
      if (sentQueued) {
        setOptimisticMessages((current) => current.filter((message) => message.id !== messageId));
        useQueuedMessageStore.getState().holdAtFront(routeThreadKey, sentQueued);
      } else {
        const composerEmpty = promptRef.current.trim().length === 0;
        const reopenedEmpty = openedFreshDraft
          ? !promptDraftHasUserContent(draftActions().getComposerDraft(composerDraftTarget))
          : composerEmpty;
        // The optimistic message always goes: a failed send must never look sent.
        setOptimisticMessages((current) => current.filter((message) => message.id !== messageId));
        if (!composerEmpty && !reopenedEmpty && promptForSend.trim().length > 0) {
          // A new draft is already being typed: keep it, and offer the failed text via a Copy action.
          showUnsentPromptToast(
            promptForSend,
            "Message not sent",
            "Your draft is untouched. Copy the unsent message to send it later.",
          );
        }
        if (composerEmpty || reopenedEmpty) {
          const store = draftActions();
          store.setPrompt(composerDraftTarget, promptForSend);
          promptRef.current = promptForSend;
          store.setTerminalContexts(composerDraftTarget, terminalSnapshot);
          composerTerminalContextsRef.current = terminalSnapshot;
          store.setPreviewAnnotations(composerDraftTarget, annotationSnapshot);
          store.setReviewComments(composerDraftTarget, commentSnapshot);
          restoreAttachmentsToComposer(attachmentSnapshot);
          composerRef.current?.resetCursorState({
            cursor: collapseExpandedPromptCursor(promptForSend, promptForSend.length),
            prompt: promptForSend,
            detectTrigger: true,
          });
        }
      }
      if (!interrupted) {
        if (
          isLocalDraftThread &&
          effectiveIntent === "foreground" &&
          bootstrapDeleted &&
          draftId &&
          draftThread &&
          projectRef
        ) {
          draftActions().setLogicalProjectDraftThreadId(
            draftThread.logicalProjectKey,
            projectRef,
            draftId,
            {
              threadId: newThreadId(),
            },
          );
        }
        const message = errorMessageOf(cause, "Failed to send message.");
        setThreadError(threadId, message);
        if (effectiveIntent === "background" && openedFreshDraft && draftId) {
          toastManager.add({
            type: "error",
            title: "Background task failed",
            description: message,
            actionProps: {
              children: "Open draft",
              onClick: () => void navigate({ to: "/draft/$draftId", params: { draftId } as never }),
            },
          } as never);
        }
      }
    } finally {
      // 23.
      sendInFlightRef.current = false;
      if (!turnStarted) {
        setDockedDraftHeroThreadKey((current) => (current === activeThreadKey ? null : current));
        resetLocalDispatch();
      }
    }
  };
  const sendImplRef = useRef(sendImpl);
  sendImplRef.current = sendImpl;
  const rawOnSend = useCallback(
    (
      e?: { preventDefault(): void },
      submissionIntent?: PromptSubmissionIntent,
      directAnnotation?: { annotation: WebMarkupPayload },
      queuedMessage?: QueuedPromptMessage,
    ) => sendImplRef.current(e, submissionIntent, directAnnotation, queuedMessage),
    [],
  );
  const blobSendGuard = useBlobSendGuard(blobId, rawOnSend);
  const onSend = blobId !== null ? blobSendGuard.send : rawOnSend;
  onSendRef.current = onSend as never;

  // ---- queue draining ---------------------------------------------------------------------------------------------------
  const nextQueuedMessage = queuedMessages[0] ?? null;
  const latestToolActivityId = useMemo(
    () => latestCompletedToolActivityId(activities),
    [activities],
  );
  useEffect(() => {
    if (!nextQueuedMessage) return;
    if (
      isSendBusy ||
      activePendingApproval ||
      activePendingQuestion ||
      sendGateClosed ||
      sendInFlightRef.current
    )
      return;
    if (!isQueuedMessageDue({ message: nextQueuedMessage, phase, latestToolActivityId })) return;
    void rawOnSend(undefined, nextQueuedMessage.submissionIntent, undefined, nextQueuedMessage);
  }, [
    activePendingApproval,
    activePendingQuestion,
    isSendBusy,
    latestToolActivityId,
    nextQueuedMessage,
    phase,
    rawOnSend,
    sendGateClosed,
  ]);
  const queueActionsRef = useRef({ queuedMessages, onSend: rawOnSend, hasPendingRequest: false });
  queueActionsRef.current = {
    queuedMessages,
    onSend: rawOnSend,
    hasPendingRequest: activePendingApproval !== null || activePendingQuestion !== null,
  };
  const steerQueuedMessage = useCallback((id: string) => {
    const { queuedMessages: messages, onSend: send, hasPendingRequest } = queueActionsRef.current;
    const message = messages.find((candidate) => candidate.id === id);
    if (!message || sendInFlightRef.current || hasPendingRequest) return;
    void send(undefined, message.submissionIntent, undefined, message);
  }, []);
  const removeQueuedMessage = useCallback((id: string) => {
    const removed = useQueuedMessageStore.getState().remove(routeThreadKeyRef.current, id);
    if (removed) restoreQueuedRef.current([removed]);
  }, []);

  // ---- implement a plan in a fresh thread -----------------------------------------------------------------------------
  const onImplementPlanInNewThread = useCallback(async () => {
    const composer = composerRef.current;
    const sendContext = composer?.getSendContext();
    if (
      !composer ||
      !sendContext ||
      !activeThread ||
      !project ||
      !activeProposedPlan ||
      !activeServerThread ||
      isSendBusy ||
      isConnecting ||
      activeHostUnavailable ||
      sendInFlightRef.current ||
      !sendContext.providerAvailable ||
      !sendContext.interactionModeEnabled
    ) {
      return;
    }
    const outgoing = formatOutgoingPrompt({
      provider: sendContext.selectedProvider,
      model: sendContext.selectedModel,
      models: sendContext.selectedProviderModels,
      effort: sendContext.selectedPromptEffort,
      text: buildPlanImplementationPrompt(activeProposedPlan.planMarkdown),
    });
    if (!composer.validateProviderInput(outgoing)) return;
    const title = truncate(buildPlanImplementationThreadTitle(activeProposedPlan.planMarkdown));
    const implementationThreadId = newThreadId();
    const createdAt = new Date().toISOString();

    sendInFlightRef.current = true;
    beginLocalDispatch({ submissionIntent: "foreground" });
    try {
      const created = await createThread({
        hostId,
        input: {
          threadId: implementationThreadId,
          projectId: activeThread.projectId,
          title,
          modelSelection: sendContext.selectedModelSelection,
          runtimeMode: defaultAccessMode,
          interactionMode: "default",
          agentMode: "chat",
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          createdAt,
        },
      } as never);
      if (created._tag === "Failure") throw squashAtomActionFailure(created as never);
      const started = await startTurn({
        hostId,
        input: {
          threadId: implementationThreadId,
          message: { messageId: newMessageId(), role: "user", text: outgoing, attachments: [] },
          modelSelection: sendContext.selectedModelSelection,
          titleSeed: title,
          runtimeMode: defaultAccessMode,
          interactionMode: "default",
          sourceProposedPlan: { threadId: activeThread.id, planId: activeProposedPlan.id },
          createdAt: new Date().toISOString(),
        },
      } as never);
      if (started._tag === "Failure") throw squashAtomActionFailure(started as never);
      await waitForStartedDaemonThread(hostThreadRef(hostId, implementationThreadId));
      await navigate({
        to: "/$hostId/$threadId",
        params: { hostId, threadId: implementationThreadId } as never,
      });
    } catch (cause) {
      const cleanup = await deleteThread({
        hostId,
        input: { threadId: implementationThreadId },
      } as never);
      if (cleanup._tag === "Failure") {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomActionFailure(cleanup),
        );
      }
      if (!isAtomActionInterrupted(cause as never)) {
        toastManager.add(
          threadToast({
            description: errorMessageOf(cause, "An error occurred while creating the new chat."),
            type: "error",
            title: "Could not start implementation chat",
          }),
        );
      }
    } finally {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    }
  }, [
    activeHostUnavailable,
    activeProposedPlan,
    activeServerThread,
    activeThread,
    beginLocalDispatch,
    composerRef,
    createThread,
    defaultAccessMode,
    deleteThread,
    hostId,
    isConnecting,
    isSendBusy,
    navigate,
    project,
    resetLocalDispatch,
    startTurn,
  ]);

  // ---- model selection --------------------------------------------------------------------------------------------------
  const currentModelSelection = activeThread?.modelSelection ?? NO_AGENT_MODEL_PICK;
  const whyModelDisabled = useCallback(
    (instanceId: AgentProfileId, model: string): string | null => {
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: session !== null,
        currentModelSelection,
        currentProviderInstanceId: sessionInstanceId as AgentProfileId | null,
        nextModelSelection: createModelPick(instanceId, model),
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [currentModelSelection, providerStatuses, session, sessionInstanceId],
  );
  const onAgentModelSelect = useCallback(
    (instanceId: AgentProfileId, model: string) => {
      if (!activeThread) return;
      const targetDriver =
        providerStatuses.find((status) => status.instanceId === instanceId)?.driver ?? null;
      if (agentLock && targetDriver && targetDriver !== agentLock) {
        focusPrompt();
        return;
      }
      if (agentLock && sessionInstanceId) {
        const currentGroup = agentEntries.find(
          (entry) => entry.instanceId === sessionInstanceId,
        )?.continuationGroupKey;
        const targetGroup = agentEntries.find(
          (entry) => entry.instanceId === instanceId,
        )?.continuationGroupKey;
        if (currentGroup && targetGroup && currentGroup !== targetGroup) return;
      }
      const resolved = resolveAppModelPickForInstance(
        instanceId,
        hostPrefs,
        providerStatuses,
        model,
      );
      if (!resolved) return;
      const nextPick = createModelPick(instanceId, resolved);
      const blocked = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: session !== null,
        currentModelSelection,
        currentProviderInstanceId: sessionInstanceId as AgentProfileId | null,
        nextModelSelection: nextPick,
      });
      if (blocked) {
        toastManager.add({
          type: "warning",
          title: blocked.title,
          description: blocked.description,
        });
        return;
      }
      draftActions().setModelSelection(composerDraftTarget, nextPick, { explicit: true });
      setStickyPromptModelPick(nextPick);
      focusPrompt();
    },
    [
      activeThread,
      agentEntries,
      agentLock,
      composerDraftTarget,
      currentModelSelection,
      draftActions,
      focusPrompt,
      hostPrefs,
      providerStatuses,
      session,
      sessionInstanceId,
      setStickyPromptModelPick,
    ],
  );

  // ---- derived values for the render tree --------------------------------------------------------------------------------
  const dockAvailable = project !== null;
  const surfaceIsFleet = activeDockSurface?.kind === "fleet" && dockOpen;
  const fleetBadge = surfaceIsFleet ? 0 : liveWorkers;
  const dockGroups = useMemo<DockRailItem[]>(() => {
    const items: DockRailItem[] = [];
    if (isFleetAgentMode(agentMode) && !isServerThread) {
      items.push({
        group: "workers",
        available: false,
        unavailableReason: "workers start with your first message",
      });
    } else if (fleetAvailable) {
      items.push({
        group: "workers",
        available: true,
        unavailableReason: "",
        badge: fleetBadge,
        detail:
          totalWorkers === 0
            ? "no workers yet"
            : `${totalWorkers} ${totalWorkers === 1 ? "worker" : "workers"}${liveWorkers > 0 ? ` · ${liveWorkers} working` : ""}`,
      });
    }
    items.push({
      group: "files",
      available: project !== null,
      unavailableReason: "open a project",
    });
    items.push({
      group: "browser",
      available: isWebSupportedInRuntime(),
      unavailableReason: "desktop app only",
    });
    items.push({
      group: "terminal",
      available: project !== null,
      unavailableReason: "open a project",
    });
    return items;
  }, [agentMode, fleetAvailable, fleetBadge, isServerThread, liveWorkers, project, totalWorkers]);

  const renderedSurface = dockPresence.value?.activeSurface ?? null;
  const renderedSurfaces = dockPresence.value?.surfaces ?? dockState.surfaces;
  const onSendWebAnnotation = useCallback(
    (annotation: WebMarkupPayload) => {
      void onSend(undefined, "foreground", { annotation });
    },
    [onSend],
  );
  const dockWorkspaceRoot = project?.workspaceRoot ?? null;
  const dockContent = (() => {
    const surface = renderedSurface;
    if (!surface) return null;
    const terminalSurfaces = renderedSurfaces.filter(
      (candidate): candidate is TerminalDockSurface => candidate.kind === "terminal",
    );
    return (
      <>
        {terminalSurfaces.map((terminalSurface) => (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              surface.id === terminalSurface.id ? "flex" : "hidden",
            )}
            key={terminalSurface.id}
          >
            <PersistentThreadTerminalPanel
              focusRequestId={terminalFocusRequestId}
              onActiveTerminalChange={activateTerminal}
              onAddTerminalContext={addTerminalExcerptToDraft}
              onCloseTerminal={closeTerminalById}
              onNewTerminal={newTerminal}
              onSplitTerminal={() => splitTerminal("horizontal")}
              onSplitTerminalVertical={() => splitTerminal("vertical")}
              surface={terminalSurface}
              threadRef={routeThreadRef}
              visible={dockOpen && surface.id === terminalSurface.id}
            />
          </div>
        ))}
        {surface.kind === "preview" ? (
          <Suspense fallback={null}>
            <WebPanel
              mode="embedded"
              onSendAnnotation={onSendWebAnnotation}
              tabId={surface.resourceId}
              threadRef={routeThreadRef}
              visible={dockOpen}
            />
          </Suspense>
        ) : null}
        {surface.kind === "fleet" ? (
          <FleetPanel
            {...(isAssistantLane ? {} : { onBlobMode: closeFleetSurface })}
            threadRef={routeThreadRef}
            visible={dockOpen}
          />
        ) : null}
        {(surface.kind === "files" || surface.kind === "file") && project && dockWorkspaceRoot ? (
          <Suspense fallback={null}>
            <FileViewerPanel
              availableEditors={availableEditors}
              composerDraftTarget={composerDraftTarget}
              cwd={dockWorkspaceRoot}
              hostId={hostId}
              isAssistantOutputsProject={isAssistantLane}
              key={`${hostId}:${dockWorkspaceRoot}`}
              onOpenFile={openFileSurface}
              onPendingChange={handleFilePendingChange}
              projectName={project.title}
              relativePath={surface.kind === "file" ? surface.relativePath : null}
              revealLine={surface.kind === "file" ? surface.revealLine : null}
              revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
              selectedFilePending={pendingFileSurfaceIds.has(surface.id)}
              threadRef={routeThreadRef}
              workspaceMutationId={workspaceMutationId}
            />
          </Suspense>
        ) : null}
      </>
    );
  })();

  // ---- compaction send ------------------------------------------------------------------------------------------------------
  const compactWith = useCallback(
    async (commandText: string) => {
      const sendContext = composerRef.current?.getSendContext();
      if (
        compactUnavailable ||
        !activeThread ||
        !clientPrefsHydrated ||
        sendInFlightRef.current ||
        !sendContext?.providerAvailable
      ) {
        return;
      }
      sendInFlightRef.current = true;
      beginLocalDispatch({ submissionIntent: "foreground" });
      setThreadError(threadId, null);
      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      setOptimisticMessages((current) => [
        ...current,
        {
          id: messageId,
          role: "user",
          text: commandText,
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        } as OptimisticMessage,
      ]);
      scrollToEnd();
      try {
        const persisted = await persistThreadPrefsForNextTurn({
          threadId,
          createdAt,
          modelSelection: sendContext.selectedModelSelection,
          runtimeMode: accessMode,
          interactionMode: sendContext.interactionMode,
        });
        if (persisted._tag === "Failure") throw squashAtomActionFailure(persisted as never);
        const result = await startTurn({
          hostId,
          input: {
            threadId,
            message: { messageId, role: "user", text: commandText, attachments: [] },
            modelSelection: sendContext.selectedModelSelection,
            runtimeMode: accessMode,
            interactionMode: sendContext.interactionMode,
            createdAt,
          },
        } as never);
        if (result._tag === "Failure") throw squashAtomActionFailure(result as never);
      } catch (cause) {
        setOptimisticMessages((current) => current.filter((message) => message.id !== messageId));
        resetLocalDispatch();
        if (!isAtomActionInterrupted(cause as never))
          setThreadError(threadId, "Failed to compact context.");
      } finally {
        sendInFlightRef.current = false;
      }
    },
    [
      persistThreadPrefsForNextTurn,
      setThreadError,
      hostId,
      activeThread,
      scrollToEnd,
      resetLocalDispatch,
      composerRef,
      beginLocalDispatch,
      compactUnavailable,
      accessMode,
      startTurn,
      threadId,
      clientPrefsHydrated,
    ],
  );
  const onCompactContext = useCallback(() => void compactWith("/compact"), [compactWith]);

  // ---- B5: task-boundary offer + undo of the compaction it started ------------------------------------------------------------
  const hostHttpBaseUrl = useHostHttpBaseUrl(hostId);
  const openFreshThread = useCallback(
    async () => (projectRef ? await openNewThread(projectRef) : null),
    [openNewThread, projectRef],
  );
  const notifyLifecycle = useCallback(
    (title: string, description?: string) =>
      toastManager.add({ type: "info", title, ...(description ? { description } : {}) }),
    [],
  );
  const boundaryMessages = useMemo(
    () =>
      serverMessages.map((message) => ({
        id: String(message.id),
        role: message.role,
        text: message.text,
      })),
    [serverMessages],
  );
  const taskBoundaryItems = useTaskBoundaryItems({
    enabled:
      hostPrefs.taskBoundaryChip !== false &&
      selectedDriverKind === "claude" &&
      isServerThread &&
      activeThread !== undefined &&
      hasRealUserMessage,
    threadId,
    draftTarget: composerDraftTarget,
    messages: boundaryMessages,
    usedTokens: contextWindow?.usedTokens ?? null,
    busy: isWorking,
    compacting: isCompacting,
    compactUnavailable,
    httpBaseUrl: hostHttpBaseUrl,
    compact: compactWith,
    openFresh: openFreshThread,
    notify: notifyLifecycle,
  });
  const sendQuickQuestionToAgent = useCallback((text: string) => {
    // sendImpl reads the forced prompt synchronously (before its first await); never leave it set for a later send.
    forcedPromptRef.current = text;
    try {
      void onSendRef.current();
    } finally {
      forcedPromptRef.current = null;
    }
  }, []);
  const quickAnswer = useQuickAnswer({
    enabled:
      hostPrefs.quickAnswers !== false &&
      isServerThread &&
      activeThread !== undefined &&
      blobId === null,
    threadId,
    httpBaseUrl: hostHttpBaseUrl,
    sendToAgent: sendQuickQuestionToAgent,
  });
  quickAnswerApiRef.current = quickAnswer.api;
  // Clicks in the Graph Explorer's Overview reach this thread here: a callers / where / impact question is answered from the
  // graph (no agent turn); anything else, or a question the daemon does not parse, lands in the composer for the user to send.
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<GraphAskDetail>).detail;
      if (!detail || detail.handled) return;
      detail.handled = true;
      const toComposer = () => {
        draftActions().setPrompt(composerDraftTarget, detail.question.text);
        promptRef.current = detail.question.text;
      };
      const api = quickAnswerApiRef.current;
      if (detail.route === "quick-answer" && api) {
        void api.tryAnswer(detail.question.text).then((answered) => {
          if (!answered) toComposer();
        });
      } else {
        detail.placed = "composer";
        toComposer();
      }
    };
    const onOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<GraphOpenFileDetail>).detail;
      if (!detail || detail.handled) return;
      detail.handled = true;
      dock().openFile(routeThreadRef, detail.file, detail.line ?? undefined);
    };
    window.addEventListener(GRAPH_ASK_EVENT, onAsk);
    window.addEventListener(GRAPH_OPEN_FILE_EVENT, onOpenFile);
    return () => {
      window.removeEventListener(GRAPH_ASK_EVENT, onAsk);
      window.removeEventListener(GRAPH_OPEN_FILE_EVENT, onOpenFile);
    };
  }, [composerDraftTarget, dock, routeThreadRef]);
  const allBannerItems = useMemo(
    () =>
      taskBoundaryItems.length || quickAnswer.items.length
        ? [...bannerItems, ...taskBoundaryItems, ...quickAnswer.items]
        : bannerItems,
    [bannerItems, quickAnswer.items, taskBoundaryItems],
  );

  // ---- remaining render inputs ------------------------------------------------------------------------------------------------
  const groupsApi = useGroupsApi();
  const terminalLabelsById = useMemo(
    () =>
      new Map(
        knownTerminals.map(
          (known) =>
            [
              known.target.terminalId,
              resolveTerminalSessionLabel(known.target.terminalId, known.state.summary),
            ] as const,
        ),
      ),
    [knownTerminals],
  );
  const transcriptSkills = useMemo(
    () =>
      activeAgentStatus
        ? resolveAgentSkillsForCwd(activeAgentStatus, markdownCwd ?? null)
        : EMPTY_SKILLS,
    [activeAgentStatus, markdownCwd],
  );
  const retryLastRequest = useCallback(() => {
    if (!lastRetryableUserMessage) return;
    // Retry only refills the EMPTY composer; the user picks the model and presses send.
    // A draft already there is never overwritten: the failed prompt goes to the clipboard instead.
    if (promptRef.current.trim().length > 0) {
      showUnsentPromptToast(
        lastRetryableUserMessage.text,
        "Your draft is still in the composer",
        "Copy the failed prompt, or clear the composer to put it back.",
      );
      composerRef.current?.focusAtEnd();
      return;
    }
    composerRef.current?.insertTextAtEnd(lastRetryableUserMessage.text);
    composerRef.current?.focusAtEnd();
  }, [composerRef, lastRetryableUserMessage]);
  const transcriptInlineError = useMemo<TranscriptInlineError | null>(
    () =>
      inlineReplyErrorMessageId && lastRetryableUserMessage
        ? ({
            messageId: inlineReplyErrorMessageId,
            onRetry: retryLastRequest,
          } as TranscriptInlineError)
        : null,
    [inlineReplyErrorMessageId, lastRetryableUserMessage, retryLastRequest],
  );

  // ---- render --------------------------------------------------------------------------------------------------------------
  if (!activeThread) return <NoActiveThreadState />;

  const threadOrigin =
    (activeThread as { origin?: { kind?: string; runId?: string | null } | null }).origin ?? null;
  const projectTitle = project?.title?.trim() ? project.title : null;
  const displayedTitle = activeThread.title === "New thread" ? "New chat" : activeThread.title;
  const dockSheetDurationMs = panelAnimations.active ? panelAnimations.durationMs : 0;
  const mountContextChipStrip = routeKind === "server";
  const showContextChipStrip = mountContextChipStrip && restingControlsVisible;
  const sendDisabledReason = threadDetailLoading
    ? "Messages loading"
    : sessionStartBlocksSend
      ? "Starting session"
      : welcomeNeedsSetup
        ? "Sign in to Claude to send"
        : null;
  const chiefName = blobPersona;
  const blobThreadFlag = blobId !== null || groupId !== null;
  const swarmLeaveCount = swarmLeaveConfirm?.count ?? 0;
  const swarmLeavePlural = swarmLeaveCount === 1;

  const openProjectSettings =
    isLocalDraftThread && project
      ? () => {
          // The settings panel keys projects by their grouping key, not by hostId:projectId.
          const settingsKey =
            physicalToLogicalKeys.get(derivePhysicalProjectKey(project)) ??
            deriveLogicalProjectKeyFromPrefs(project, groupingPrefs);
          void navigate({
            to: "/settings/projects" as never,
            search: { project: settingsKey, machine: undefined } as never,
          });
        }
      : undefined;

  const dockPanelProps = {
    surfaces: renderedSurfaces,
    activeSurfaceId: dockState.activeSurfaceId ?? dockPresence.value?.activeSurface?.id ?? null,
    pendingSurfaceIds: pendingFileSurfaceIds,
    previewSessions: webState.sessions,
    desktopByTabId: webState.desktopByTabId,
    webRuntimeTabId: (tabId: string) =>
      webRuntimeTabId(routeThreadRef, webState.serverEpoch, tabId),
    terminalLabelsById,
    onActivate: activateSurface,
    onCloseSurface: (surface: DockSurface) => void closeSurfaces([surface]),
    onCopyFilePath: (path: string) => void copyFilePath(path),
    onAddBrowser: () => void openBrowserSurface(),
    onAddBrowserInProfile: (profileId: string) => void openBrowserSurface(profileId),
    onAddTerminal: newTerminal,
    groups: dockGroups,
    onSelectGroup: selectDockGroup,
    onHide: closePreviewPanel,
  } as const;

  const handleClick = () => {
    composerRef.current?.restoreAtTimelineEnd();
    scrollToEnd(true);
  };

  const handleClick2 = () => {
    applyAgentMode("orchestrator");
    setSwarmLeaveConfirm(null);
  };

  const alertDialogTitlePart = (
    <AlertDialogTitle>
      Turn Swarm off with {swarmLeaveCount} {swarmLeavePlural ? "worker" : "workers"} still running?
    </AlertDialogTitle>
  );

  const alertDialogDescriptionPart = (
    <AlertDialogDescription>
      Claude stops handing work to free-model workers. You can stop the running{" "}
      {swarmLeavePlural ? "one" : "ones"} now, or let {swarmLeavePlural ? "it" : "them"} finish so
      Claude can still read and merge the result. Their worktrees are kept either way.
    </AlertDialogDescription>
  );

  const alertDialogFooterPart = (
    <AlertDialogFooter>
      <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
      <Button onClick={handleClick2} variant="outline">
        Let {swarmLeavePlural ? "it" : "them"} finish
      </Button>
      <Button
        autoFocus
        onClick={() => {
          applyAgentMode("chat");
          setSwarmLeaveConfirm(null);
        }}
      >
        Stop workers
      </Button>
    </AlertDialogFooter>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          dockMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={dockMaximized ? "true" : "false"}
        data-browser-pip-anchor
      >
        <SurfacePageHeader
          className="@container/chat-header relative bg-background"
          data-chat-header
          electron={isNative}
          reserveNativeControls={reserveTitleBarControlInset && !inlineDockOwnsTitleBar}
        >
          {blobId ? (
            <BlobHeaderIdentity blobId={blobId} fromKora={threadOrigin?.kind === "kora"} />
          ) : null}
          {group ? (
            <GroupHeaderIdentity
              group={group}
              members={groupMemberList}
              onOpenMember={(memberId) =>
                void navigate({
                  to: "/blobs/$blobId" as never,
                  params: { blobId: memberId } as never,
                })
              }
            />
          ) : null}
          <ChatHeader
            activeProject={project}
            activeThreadHostId={hostId}
            activeThreadId={threadId}
            activeThreadTitle={displayedTitle}
            isServerThread={isServerThread}
            {...(openProjectSettings ? { onOpenProjectSettings: openProjectSettings } : {})}
          />
          {group ? (
            <GroupHeaderActions
              group={group}
              onChangeRule={(rule) => void groupsApi.update(group.id, { rule })}
              onEdit={() => setGroupEditorOpen(true)}
            />
          ) : null}
          {blobId ? (
            <BlobHeaderActions
              blobId={blobId}
              dockOpen={dockOpen}
              onCloseDock={closePreviewPanel}
              refreshKey={latestCompletedAt}
              threadId={isServerThread ? threadId : null}
              threadModel={
                activeThread.modelSelection
                  ? {
                      instanceId: activeThread.modelSelection.instanceId,
                      model: activeThread.modelSelection.model,
                    }
                  : null
              }
            />
          ) : projectTitle && !group ? (
            <div
              className="ml-auto hidden min-w-0 max-w-[42%] shrink-0 items-center gap-2 pl-2 md:flex"
              data-chat-header-project
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="hidden min-w-0 truncate text-sm font-medium text-muted-foreground @[36rem]/chat-header:block" />
                  }
                >
                  {projectTitle}
                </TooltipTrigger>
                <TooltipPopup side="bottom">{project?.workspaceRoot}</TooltipPopup>
              </Tooltip>
              {!isAssistantLane ? (
                <span className="shrink-0">
                  <GraphStatusChip placement="header" />
                </span>
              ) : null}
            </div>
          ) : null}
          {dockAvailable && blobId === null ? (
            <div className={cn("flex shrink-0 items-center pl-1", !projectTitle && "ml-auto")}>
              <DockToggleButton
                badge={fleetAvailable ? liveWorkers : 0}
                onToggle={toggleDockPanel}
                open={dockOpen}
              />
            </div>
          ) : null}
        </SurfacePageHeader>

        {blobId && threadOrigin?.kind === "routine" ? (
          <RoutineRunBannerHost
            blobId={blobId}
            runId={threadOrigin.runId ?? null}
            threadId={threadId}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
              <AgentStatusBanner
                onDismiss={() => setDismissedAgentBannerKey(agentBannerKey)}
                onOpenProviderSetup={openAgentSetup}
                status={activeAgentStatus}
              />
              {showThreadErrorBanner ? (
                <ThreadErrorBanner
                  error={threadError}
                  onDismiss={() => {
                    dismissThreadErrorBannerForSession(threadErrorBannerKey);
                    setErrorDismissTick((tick) => tick + 1);
                  }}
                  onRetry={lastRetryableUserMessage ? retryLastRequest : undefined}
                />
              ) : null}
            </div>

            <div
              ref={setTimelineEl}
              className="relative flex min-h-0 flex-1 flex-col bg-background transition-[padding-right] duration-200 ease-out"
              style={
                swarmDockVisible && blobDockActive && swarmDockGutterPx !== null
                  ? { paddingRight: swarmDockGutterPx }
                  : undefined
              }
            >
              <BlobSkinProvider skin={blobSkin}>
                <GroupThreadProvider value={groupThreadInfo}>
                  <BlobApprovalProvider value={blobApprovalApi}>
                    <ThreadTranscript
                      activeThreadHostId={displayedHostId}
                      activeTurnStartedAt={paintOnly ? null : workStartedAt}
                      agentPanelModel={agentPanelModel}
                      anchorMessageId={anchorMessageId}
                      citationHistoryLoading={threadDetailLoading}
                      citationRequest={paintOnly ? null : footnoteRequest}
                      contentInsetEndAdjustment={promptTranscriptInset}
                      displayThreadKey={displayThreadKey ?? routeThreadKey}
                      hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                      showSetupCheck={needsClaudeLogin}
                      inlineError={transcriptInlineError}
                      isAssistantThread={isAssistantLane}
                      isCompacting={paintOnly ? false : isCompacting}
                      isWorking={paintOnly ? false : isWorking}
                      latestTurn={latestTurn}
                      listRef={listRef}
                      liveFollowEnabled={liveFollowEnabled}
                      liveStatusLabel={liveStatusLabel}
                      loadEarlier={loadEarlier}
                      markdownCwd={markdownCwd}
                      onAnchorReady={onTranscriptAnchorReady}
                      onCiteAssistantText={citeAssistantText}
                      onContentOverflowChange={onContentOverflowChange}
                      onImageExpand={setExpandedImage}
                      onIsAtEndChange={onIsAtEndChange}
                      onManualNavigation={cancelLiveFollow}
                      onOpenFleet={fleetAvailable ? openFleetSurface : null}
                      onAskWholeFile={isAssistantLane ? null : askWholeFile}
                      onRemoveQueuedMessage={removeQueuedMessage}
                      onSteerQueuedMessage={steerQueuedMessage}
                      onToolOutputCollapsedAtEnd={onToolOutputCollapsedAtEnd}
                      onUseArtifactTemplate={useArtifactTemplate}
                      queuedMessages={paintOnly ? EMPTY_QUEUED : queuedMessages}
                      resolvedTheme={resolvedThemeValue}
                      routeThreadKey={routeThreadKey}
                      runningTurnId={runningTurnId}
                      skills={transcriptSkills}
                      timelineEntries={displayedEntries}
                      timestampFormat={hostPrefs.timestampFormat}
                      topBannerInset={hasTranscriptTopBanner}
                      topFadeEnabled={!hasTranscriptTopBanner}
                      workspaceRoot={transcriptWorkspaceRoot}
                    />
                  </BlobApprovalProvider>
                </GroupThreadProvider>
              </BlobSkinProvider>

              {blobDockActive ? (
                <SwarmBlobDock
                  composerInsetPx={promptTranscriptInset}
                  {...(isAssistantLane ? {} : { onPaneMode: openFleetSurface })}
                  threadRef={routeThreadRef}
                />
              ) : null}
              <KoraFirstRunGate
                bottomInset={promptTranscriptInset}
                dismiss={koraWelcome.dismiss}
                onBuild={() => {
                  composerRef.current?.insertTextAtEnd(BUILD_ME_A_BLOB_TEXT);
                  composerRef.current?.focusAtEnd();
                }}
                visible={koraWelcome.visible}
              />

              {showScrollToBottom ? (
                <div
                  className="pointer-events-none absolute right-4 z-30 flex justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <button
                    className="pointer-events-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-foreground ps-2 pe-2.5 text-[11.5px] font-medium text-background shadow-lg shadow-black/30 ring-1 ring-background/60 outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={handleClick}
                    onPointerDown={(event) => event.preventDefault()}
                    aria-label="Jump to the latest message"
                    type="button"
                  >
                    <ArrowDownToLineIcon className="size-3.5" />
                    Latest
                  </button>
                </div>
              ) : null}
            </div>

            <div
              className={cn(
                "pointer-events-none absolute z-20 bg-background",
                isDraftHeroState
                  ? "inset-0 flex items-center"
                  : "inset-x-0 bottom-0 [--composer-fade-h:2.5rem] pt-[calc(var(--composer-fade-h)+0.375rem)] sm:pt-[calc(var(--composer-fade-h)+0.5rem)]",
              )}
              data-prompt-overlay="true"
              ref={attachPromptOverlay}
              style={
                isDraftHeroState
                  ? undefined
                  : {
                      maskImage:
                        "linear-gradient(to bottom, transparent 0, black var(--composer-fade-h))",
                      WebkitMaskImage:
                        "linear-gradient(to bottom, transparent 0, black var(--composer-fade-h))",
                    }
              }
            >
              <div
                className="w-full pr-[calc(env(safe-area-inset-right)+0.75rem)] pl-[calc(env(safe-area-inset-left)+0.75rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)]"
                ref={attachTransitionGroup}
              >
                <div
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-3xl"
                  data-prompt-stack="true"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0 pb-8 group-has-[[data-prompt-shoulder-tab]]/composer-stack:pb-4 [@media(max-height:720px)]:pb-4 [@media(max-height:720px)]:has-[[data-setup-check]]:[&_[data-chat-hero]]:hidden [@media(max-height:720px)]:has-[[data-setup-check]]:[&_h1]:hidden">
                      {isAssistantLane ? (
                        <ChatHero blob={blobPersona} onPickStarter={insertStarterText} />
                      ) : (
                        <>
                          <DraftStageHeadline draftId={draftId} />
                          {isLocalDraftThread && draftId && project ? (
                            <DraftProjectChip draftId={draftId} project={project} />
                          ) : null}
                        </>
                      )}
                      {needsClaudeLogin ? (
                        <SetupCheck
                          className="mx-auto mt-5 w-full max-w-md"
                          problemsOnly
                          requireClaude
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {workerPicker ? (
                    <WorkerPickerPanel
                      key={workerPicker.requestId}
                      busy={workerPickerBusyId === workerPicker.requestId}
                      // The panel unmounts once answered: give focus to the composer, not <body>.
                      onDecline={() => {
                        void answerWorkerPicker(
                          workerPicker.requestId as RequestId,
                          WORKER_PICKER_NO_ANSWERS,
                        );
                        focusPrompt();
                      }}
                      onSubmit={(answers) => {
                        void answerWorkerPicker(workerPicker.requestId as RequestId, answers);
                        focusPrompt();
                      }}
                      request={workerPicker}
                    />
                  ) : null}

                  <div className="relative">
                    <PromptSurface.Shell contextStrip={showContextChipStrip}>
                      <PromptSurface.Host>
                        <div className="relative z-10" ref={attachPromptAnchor}>
                          <GroupThreadProvider value={groupThreadInfo}>
                            <ChatPrompt
                              activePendingApproval={activePendingApproval}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingProgress={activePendingProgress}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activeProjectDefaultModelSelection={projectDefaultModelChoice}
                              activeProposedPlan={activeProposedPlan}
                              activeContextWindow={contextWindow}
                              activeTaskSteps={activeTaskSteps}
                              activeTasksProgress={activeTasksProgress}
                              activeThread={activeThread}
                              activeThreadHostId={activeThread.hostId}
                              activeThreadId={activeThread.id}
                              activeThreadModelSelection={activeThread.modelSelection}
                              activeThreadShell={shell}
                              agentMode={agentMode}
                              bannerItems={allBannerItems}
                              blobPersona={chiefName}
                              blobThread={blobThreadFlag}
                              composerDraftTarget={composerDraftTarget}
                              composerRef={composerRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              compactDisabled={compactUnavailable}
                              compactDisabledReason={compactDisabledReason}
                              compactThreadUnavailable={compactUnavailable}
                              draftId={draftId}
                              focusComposer={focusPrompt}
                              whyModelDisabled={whyModelDisabled}
                              getTimelineScrollableNode={getScrollNode}
                              gitCwd={gitCwd}
                              handleAgentModeChange={handleAgentModeChange}
                              handleInteractionModeChange={handleTurnModeChange}
                              handleRuntimeModeChange={handleAccessModeChange}
                              hostId={hostId}
                              hostUnavailable={hostUnavailableState}
                              interactionMode={turnMode}
                              isAssistantLane={isAssistantLane}
                              isConnecting={isConnecting}
                              isDraftHeroState={isDraftHeroState}
                              isLocalDraftThread={isLocalDraftThread}
                              isSendBusy={isSendBusy}
                              isServerThread={isServerThread}
                              isTimelineAtLogicalEnd={isAtLogicalEnd}
                              lockedProvider={agentLock}
                              onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                              onChangeActivePendingUserInputCustomAnswer={
                                onChangeActivePendingUserInputCustomAnswer
                              }
                              onComposerOverlayHeightChange={publishOverlayMetrics}
                              onCompactContext={onCompactContext}
                              onDismissActivePendingUserInput={onDismissActivePendingUserInput}
                              onImplementPlanInNewThread={onImplementPlanInNewThread}
                              onInterrupt={onInterrupt}
                              onOpenProviderSetup={openAgentSetup}
                              onPageScrollKeyDown={(key: PageScrollKey) =>
                                pageScrollController.handleKeyDown(key)
                              }
                              onPageScrollKeyUp={(key: string) =>
                                pageScrollController.handleKeyUp(key)
                              }
                              onPageScrollRelease={() => pageScrollController.releaseActiveKey()}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestion
                              }
                              onProviderModelSelect={onAgentModelSelect}
                              onRespondToApproval={onRespondToApproval}
                              onRestingChange={onRestingChange}
                              onRestingControlsVisibilityChange={setRestingControlsVisible}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOption
                              }
                              onSend={onSend}
                              onUsageLimitsCommand={openUsageSettings}
                              pendingApprovals={composerApprovals}
                              pendingUserInputs={pendingUserInputs}
                              phase={phase}
                              projectSelectionRequired={isLocalDraftThread && !project}
                              promptRef={promptRef}
                              providerCatalogKnown={providerCatalogKnown}
                              providerStatuses={providerStatuses as AgentStatus[]}
                              resolvedTheme={resolvedThemeValue}
                              respondingRequestIds={respondingRequestIds}
                              restingControlsHaveLeadingContext={false}
                              restingControlsHost={restingControlsHost}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadRef}
                              runtimeMode={accessMode}
                              scheduleComposerFocus={schedulePromptFocus}
                              sendDisabledReason={sendDisabledReason}
                              setThreadError={setThreadError}
                              settings={hostPrefs}
                              offerPlanFollowUp={offerPlanFollowUp}
                              threadSyncPhase={activeHostUnavailable ? null : routeSyncPhase}
                              timelineOverflows={transcriptOverflows}
                              toggleInteractionMode={toggleTurnMode}
                            />
                          </GroupThreadProvider>
                        </div>
                      </PromptSurface.Host>
                      <div className="min-h-0">
                        <div className="relative z-0">
                          {mountContextChipStrip ? (
                            <div className="pointer-events-auto">
                              <PromptSurface.ContextStrip
                                className={cn(
                                  "gap-1 text-xs font-normal text-muted-foreground/70",
                                  !showContextChipStrip &&
                                    "pointer-events-none invisible absolute inset-x-0 top-full",
                                )}
                              >
                                <div
                                  className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
                                  data-chat-resting-prompt-controls-host="true"
                                  data-prompt-context-control
                                  ref={setRestingControlsHost}
                                />
                              </PromptSurface.ContextStrip>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </PromptSurface.Shell>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                  />

                  {isDraftHeroState && !isAssistantLane && project ? (
                    <div className="absolute inset-x-0 top-full z-0">
                      <DraftFreshStart onSendStarter={sendStarterPrompt} project={project} />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <CreateGroupDialog
              existingNames={groupsState.groups
                .filter((candidate) => !candidate.archivedAt)
                .map((candidate) => candidate.name)}
              group={group}
              members={groupMemberLookup.members}
              onOpenChange={setGroupEditorOpen}
              onSubmit={async (draft, id) => {
                if (!group) return { ok: false, message: "This group is gone." };
                const result = await groupsApi.update(id ?? group.id, draft);
                return result.ok ? { ok: true } : { ok: false, message: result.message };
              }}
              open={groupEditorOpen && group !== null}
            />

            <AlertDialog
              onOpenChange={(open) => {
                if (!open) setSwarmLeaveConfirm(null);
              }}
              open={swarmLeaveConfirm !== null}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  {alertDialogTitlePart}
                  {alertDialogDescriptionPart}
                </AlertDialogHeader>
                {alertDialogFooterPart}
              </AlertDialogPopup>
            </AlertDialog>

            <SwarmSetupDialog
              hostId={hostId}
              isAssistantLane={isAssistantLane}
              onStartSwarm={handleStartSwarm}
            />
          </div>
        </div>
      </div>

      {blobId !== null && !blobPanelSheet && blobPresence.present ? (
        <BlobSidePanel
          blobId={blobId}
          mode="inline"
          open={blobPanelOpen}
          refreshKey={latestCompletedAt}
          threadRef={isServerThread ? routeThreadRef : null}
          widthStorageKey="kora:blob-panel-width"
        />
      ) : null}
      {blobId !== null && blobPanelSheet ? (
        <DockSheet
          animationDurationMs={dockSheetDurationMs}
          onClose={() => blobPanel.setOpen(false)}
          open={blobPanelOpen}
        >
          <BlobSidePanel
            blobId={blobId}
            mode="sheet"
            open={blobPanelOpen}
            refreshKey={latestCompletedAt}
            threadRef={isServerThread ? routeThreadRef : null}
          />
        </DockSheet>
      ) : null}
      {blobSendGuard.dialog}

      {dockAvailable && !shouldUseDockSheet && dockPresence.present ? (
        <RightDockPanel
          {...dockPanelProps}
          canMaximize={canMaximizeDock}
          {...(isAssistantLane && typeof window !== "undefined"
            ? { defaultWidth: Math.round(window.innerWidth * 0.55) }
            : {})}
          maximized={dockMaximized}
          mode="inline"
          onToggleMaximize={toggleDockMaximized}
          open={dockOpen}
          widthStorageKey={`kora:web-panel-width:${routeThreadKey}`}
        >
          {dockContent}
        </RightDockPanel>
      ) : null}
      {dockAvailable && shouldUseDockSheet ? (
        <DockSheet
          animationDurationMs={dockSheetDurationMs}
          onClose={closePreviewPanel}
          open={dockOpen}
        >
          <RightDockPanel {...dockPanelProps} mode="sheet" open={dockOpen}>
            {dockContent}
          </RightDockPanel>
        </DockSheet>
      ) : null}

      {expandedImage ? (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          onClose={() => setExpandedImage(null)}
          preview={expandedImage}
        />
      ) : null}
    </div>
  );
}

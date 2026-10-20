// The thread composer and everything docked around it: banners, drawers, the editor with its command menus,
// attachments, footer controls and the imperative handle ThreadView drives it through. The draft itself
// (text, contexts, model pick) lives in stores; this component owns the composer-local state around it.
// ---------------------------------------------------------------------------
// Public types

import { randomUUID, cn } from "~/util/utils";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { AVAILABLE_LINK_STATE } from "@kora/client-runtime/link";
import { hostCatalog } from "~/link/catalog";
import { BlobAvatar } from "~/components/blobs/avatar";
import { usePromptWraps } from "./usePromptWraps";
import { usePromptFocusState } from "./usePromptFocusState";
import { measureRestingPromptControls } from "./restingPromptControlsMeasurement";
import {
  getPromptSubmissionValidationMessage,
  getPromptLengthValidationMessage,
  submitPromptDraft,
} from "./promptSubmission";
import {
  slashCommandItemsForPromptPosition,
  searchSlashCommandItems,
} from "./promptSlashCommandSearch";
import { shouldCollapsePromptForScrollKey } from "./promptScrollGesture";
import { usePromptRestingTransition } from "./promptRestingTransition";
import { resolvePromptMenuActiveItemId } from "./promptMenuHighlight";
import { makePromptMentionDragHandlers, dataTransferHasPromptMention } from "./promptMentionDrag";
import { PromptFooterPrimaryActions, PromptFooterModeControls } from "./promptFooterControls";
import {
  isInsideRestingPromptControlScope,
  isInsideCollapsedPromptControls,
} from "./promptEventScope";
import {
  getPromptInjectionState,
  getPromptAgentState,
  type TraitsRenderInput,
} from "./promptAgentState";
import {
  type PromptTasksProgress,
  PromptTasksContent,
  PromptTasksDrawer,
  PromptTasksBadge,
  type PromptTaskStep,
} from "./PromptTasksBadge";
import { PromptSwarmToggle } from "./PromptSwarmToggle";
import { PermissionPicker } from "./PermissionPicker";
import { ComposerTypingSprite } from "./ComposerTypingSprite";
import { ComposerUsageSign } from "./UsageSignIndicator";
import { PromptSurface } from "./PromptSurface";
import { PromptPlanFollowUpBanner } from "./PromptPlanFollowUpBanner";
import { PromptPendingUserInputPanel } from "./PromptPendingUserInputPanel";
import { PromptPendingApprovalPanel } from "./PromptPendingApprovalPanel";
import { ApprovalButtons } from "./ApprovalButtons";
import { PromptLengthValidation } from "./PromptLengthValidation";
import { PromptCommandMenuLayer } from "./PromptCommandMenuLayer";
import { type PromptCommandItem, PromptCommandMenu } from "./PromptCommandMenu";
import { type PromptBannerStackItem, PromptBannerStack } from "./PromptBannerStack";
import { PromptBanner } from "./PromptBanner";
import { PromptAttachmentTray } from "./PromptAttachmentTray";
import { PromptActivityRow } from "./PromptActivityStatus";
import {
  resolveContextWindowModelDisplayName,
  agentSupportsManualCompaction,
  contextWindowForComposer,
} from "./ContextWindowMeter.logic";
import { hasAgentSetup } from "./AgentStatusBanner";
import { AgentModelPicker } from "./AgentModelPicker";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { useFolderTrustBannerItems } from "../trust/useFolderTrustBannerItems";
import { useSwarmPromptBannerItems } from "../swarm/useSwarmPromptBannerItems";
import { importPastedPromptText, readPastedContextChip } from "../prompt-editor/clipboard";
import {
  shouldUseCompactPromptPrimaryActions,
  shouldUseCompactPromptFooter,
} from "../promptFooterLayout";
import { resolveRestingPromptControlsLayout } from "../promptFooterLayout";
import { useFirstRunChecks, claudeStep } from "../onboarding/firstRunChecks";
import {
  contextChipRecordsFromDraft,
  ContextChipActionsContext,
  ContextChipRecordsContext,
} from "../contextChipPresentation";
import { useGroupThread } from "../blobs/groups/groupThreadContext";
import { groupMentionItems } from "../blobs/groups/groupMentions";
import {
  getAntigravitySendBlockReason,
  resolvePromptAgentSelection,
  derivePromptSendState,
  resolvePromptTurnMode,
} from "../ThreadView.logic";
import {
  type PromptEditorHandle,
  type PromptCommandKey,
  PromptEditor,
} from "../prompt-editor/PromptEditor";
import { leaderRateLimitedUntil } from "../../util/workerActivity";
import {
  formatTerminalExcerptLabel,
  type TerminalExcerptSelection,
  type TerminalExcerptDraft,
} from "../../util/terminalContext";
import { resolveSwarmToggleAvailability } from "../../util/swarm";
import { SHELL_PASTE_AS_TEXT_EVENT } from "../../util/shellPasteAsText";
import {
  partitionIncomingAttachmentFiles,
  fileToPendingPromptAttachment,
  type PendingPromptAttachment,
} from "../../util/promptAttachments";
import { elementContextToWebMarkup } from "../../util/elementContext";
import type { ContextUsageSnapshot } from "../../util/contextWindow";
import {
  formatInlineContextLink,
  insertInlineContextLink,
  collectInlineContextIds,
} from "../../util/contextChipReferences";
import {
  terminalExcerptDraftFromRecord,
  contextChipImportLookupIds,
  isSameContextChipPayload,
  reviewCommentFromRecord,
  reviewCommentContextId,
  asKnownContextRecord,
  webMarkupFromRecord,
  webMarkupContextId,
} from "../../util/contextChipRecords";
import type { ReplyFootnoteSourceAnchor } from "../../util/assistantTextSelection";
import type { SessionPhase, ThreadShell, Thread } from "../../types";
import { type ThreadLoadPhase, threadLoadLabel } from "../../thread/threadSync";
import type { PendingQuestion, PendingApproval, WorkLogEntry } from "../../thread/timeline";
import type { PendingQuestionDraftAnswer } from "../../thread/pendingUserInput";
import { openSwarmQuickSetup } from "../../stores/swarmSetupStore";
import {
  useEffectivePromptModelState,
  usePromptThreadDraft,
  usePromptDraftStore,
  promptTargetKey,
  type DraftId,
} from "../../stores/promptDraftStore";
import { usePromptAttachmentStore, usePromptAttachments } from "../../stores/promptAttachmentStore";
import { useDockStore } from "../../stores/dockStore";
import { blobPromptPlaceholder } from "../../promptPlaceholder";
import {
  promptSubmissionIntentForEnter,
  collapseExpandedPromptCursor,
  formatReplyFootnoteForPrompt,
  expandCollapsedPromptCursor,
  clampCollapsedPromptCursor,
  isPromptTriggerDismissed,
  type DismissedPromptTrigger,
  type PromptSubmissionIntent,
  detectPromptTrigger,
  replaceTextRange,
  type PromptTrigger,
} from "../../prompt-logic";
import { getAppModelOptionsForInstance } from "../../modelPick";
import { fetchPrimaryHost } from "../../hosts/primary/shellAuth";
import { useSwarmStatus } from "../../hooks/useSwarmStatus";
import { markProjectIsGitRepo, useProjectIsGitRepo } from "../../hooks/useProjectIsGitRepo";
import { useActiveProjectTarget } from "../../hooks/useCurrentProjectTarget";
import { usePromptPathSearch } from "../../atoms/queries";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import {
  observeResponsiveBreakpointFade,
  usePanelAnimationPrefs,
} from "../../appearance/panelAnimations";
import { searchAgentSkills } from "../../agentSkillSearch";
import {
  deriveAgentProfileEntries,
  sortAgentProfileEntries,
  applyAgentProfilePrefs,
  NO_AGENT_MODEL_PICK,
  type AgentProfileEntry,
} from "../../agentProfiles";
import { USAGE_LIMITS_COMMAND } from "@kora/shared/planLimits";
import { serializePromptFileLink } from "@kora/shared/promptTrigger";
import { canonicalModelSlug, createModelPick } from "@kora/shared/modelOptions";
import { encodeContextChipFragment } from "@kora/shared/contextChipClipboard";
import type { UnifiedPrefs } from "@kora/contracts/clientPrefs";
import {
  AGENT_SEND_TURN_MAX_INPUT_CHARS,
  type AgentApprovalDecision,
  type ContextChipRecord,
  type WebMarkupPayload,
  type HostThreadRef,
  type ThreadAgentMode,
  type AgentProfileId,
  type AgentTurnMode,
  type ReplyFootnote,
  type AgentStatus,
  type AccessMode,
  type ModelPick,
  type RequestId,
  type ThreadId,
  type AgentId,
  type HostId,
} from "@kora/contracts";
import { wouldTextPasteExceedLimit } from "@kora/client-runtime/paste";
import type { HostLinkPresentation } from "@kora/client-runtime/link";
import { hostThreadRef } from "@kora/client-runtime/host";
import {
  resolveAgentSlashCommandsForCwd,
  formatAgentSkillDisplayName,
  resolveAgentSkillsForCwd,
} from "@kora/client-runtime/agentSkills";
import {
  type DragEvent as ReactDragEvent,
  useState,
  useCallback,
  useMemo,
  memo,
  type FormEvent,
  useRef,
  type ReactNode,
  useImperativeHandle,
  type RefObject,
  useLayoutEffect,
  type ClipboardEvent as ReactClipboardEvent,
  useEffect,
} from "react";
import { CircleAlertIcon, PaperclipIcon } from "lucide-react";

export interface ChatPromptHandle {
  focusAtEnd(): void;
  focusAt(cursor: number): void;
  /** Expand the desktop composer at the end of the timeline without taking focus. */
  restoreAtTimelineEnd(): void;
  collapseForTimelineScrollKey(key: string): void;
  insertTextAtEnd(
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ): boolean;
  /** Large-paste folding for text redirected from a blurred composer. */
  pasteTextAtEnd(text: string): boolean;
  citeAssistantText(citation: ReplyFootnote, sourceAnchor: ReplyFootnoteSourceAnchor): boolean;
  openModelPicker(): void;
  toggleModelPicker(): void;
  isModelPickerOpen(): boolean;
  compactContext(): void;
  readSnapshot(): { value: string; cursor: number; expandedCursor: number; contextIds: string[] };
  /** After external prompt mutations such as onSend. */
  resetCursorState(options?: { cursor?: number; prompt?: string; detectTrigger?: boolean }): void;
  addTerminalContext(selection: TerminalExcerptSelection): void;
  getSendContext(): {
    prompt: string;
    terminalContexts: TerminalExcerptDraft[];
    previewAnnotations: WebMarkupPayload[];
    reviewComments: Array<ReturnType<typeof reviewCommentFromRecord>>;
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelPick;
    providerAvailable: boolean;
    selectedProvider: AgentId;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<AgentStatus["models"][number]>;
    interactionMode: AgentTurnMode;
    interactionModeEnabled: boolean;
    attachments: PendingPromptAttachment[];
  };
  /** Validate the fully composed text right before a provider turn starts. */
  validateProviderInput(agentInput: string): boolean;
}

export interface ChatPromptProps {
  restingControlsHost: HTMLDivElement | null;
  promptRef: RefObject<string>;
  focusComposer(): void;
  /** A blob thread: permissions show as Ask / Auto / Full. */
  blobThread?: boolean;
  activePendingIsResponding: boolean;
  composerRef: RefObject<ChatPromptHandle | null>;
  hostId: HostId;
  activePendingProgress: {
    activeQuestion: { id: string; multiSelect?: boolean; allowCustomAnswer?: boolean } | null;
    isLastQuestion: boolean;
    questionIndex: number;
    customAnswer: string;
    canAdvance: boolean;
  } | null;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  interactionMode: AgentTurnMode;
  activeProjectDefaultModelSelection: ModelPick | null | undefined;
  onRestingControlsVisibilityChange(visible: boolean): void;
  onImplementPlanInNewThread(): void;
  composerTerminalContextsRef: RefObject<TerminalExcerptDraft[]>;
  onSend(e?: { preventDefault(): void }, intent?: PromptSubmissionIntent): void;
  providerStatuses: AgentStatus[];
  composerDraftTarget: HostThreadRef | DraftId;
  /** Hides the Swarm toggle and the graph / swarm-activity chips. */
  isAssistantLane?: boolean;
  phase: SessionPhase;
  settings: UnifiedPrefs;
  handleAgentModeChange(mode: ThreadAgentMode): void;
  activeTasksProgress: PromptTasksProgress | null;
  onProviderModelSelect(instanceId: AgentProfileId, model: string): void;
  getTimelineScrollableNode(): HTMLElement | null;
  routeKind: "draft" | "server";
  scheduleComposerFocus(): void;
  whyModelDisabled(instanceId: AgentProfileId, model: string): string | null;
  handleRuntimeModeChange(mode: AccessMode): void;
  /** Reported from a layout effect so it is current before the chat view measures the overlay. */
  onRestingChange(resting: boolean): void;
  threadSyncPhase: ThreadLoadPhase | null;
  offerPlanFollowUp: boolean;
  isRevertingCheckpoint?: boolean;
  sendDisabledReason: string | null;
  gitCwd: string | null;
  activePendingApproval: PendingApproval | null;
  activeThreadId: ThreadId | null;
  resolvedTheme: "dark" | "light";
  isLocalDraftThread: boolean;
  activeContextWindow: ContextUsageSnapshot | null;
  onDismissActivePendingUserInput(requestId: RequestId): void;
  activeThreadModelSelection: ModelPick | null | undefined;
  isServerThread: boolean;
  activeTaskSteps: readonly PromptTaskStep[] | null;
  activePendingDraftAnswers: Record<string, PendingQuestionDraftAnswer>;
  onChangeActivePendingUserInputCustomAnswer(
    questionId: string,
    value: string,
    caret: number,
    expandedCaret: number,
    cursorAdjacentToMention: boolean,
  ): void;
  activeThread: Thread | undefined;
  activeThreadHostId: HostId | undefined;
  pendingApprovals: PendingApproval[];
  compactDisabled: boolean;
  projectSelectionRequired: boolean;
  activePendingQuestionIndex: number;
  onComposerOverlayHeightChange(height: number): void;
  hostUnavailable: { readonly label: string; readonly connection: HostLinkPresentation } | null;
  onAdvanceActivePendingUserInput(): void;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  toggleInteractionMode(): void;
  runtimeMode: AccessMode;
  bannerItems: readonly PromptBannerStackItem[];
  activeThreadShell: ThreadShell | null;
  isConnecting: boolean;
  respondingRequestIds: RequestId[];
  /** Picking /usage-limits IS the action; the draft keeps nothing of it. */
  onUsageLimitsCommand?: (() => void) | undefined;
  pendingUserInputs: PendingQuestion[];
  draftId: DraftId | null;
  setThreadError(threadId: ThreadId | null, error: string | null): void;
  onInterrupt(): void;
  onSelectActivePendingUserInputOption(questionId: string, optionValue: string): void;
  compactThreadUnavailable: boolean;
  onPageScrollKeyUp(key: string): void;
  /** The thread has no messages yet (centred hero composer). */
  isDraftHeroState?: boolean;
  isTimelineAtLogicalEnd(): boolean;
  restingControlsHaveLeadingContext: boolean;
  handleInteractionModeChange(mode: AgentTurnMode): void;
  onPreviousActivePendingUserInputQuestion(): void;
  onPageScrollRelease(): void;
  timelineOverflows: boolean;
  onOpenProviderSetup(instanceId: AgentProfileId): void;
  compactDisabledReason: string | null;
  isSendBusy: boolean;
  onCompactContext(): void;
  /** A blob's own thread: the composer talks to them by name. */
  blobPersona?: { name: string; chief: boolean } | null;
  onPageScrollKeyDown(key: "PageUp" | "PageDown"): void;
  lockedProvider: AgentId | null;
  /** False until the server config has arrived once. */
  providerCatalogKnown: boolean;
  routeThreadRef: HostThreadRef;
  agentMode: ThreadAgentMode;
  onRespondToApproval(requestId: RequestId, decision: AgentApprovalDecision): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Module-level helpers

const PASTE_AS_TEXT_WINDOW_MS = 1000;
const EMPTY_ENTRIES: readonly AgentProfileEntry[] = [];
const INTERACTIVE_TARGET =
  'button, a, input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]';
const EDITABLE_OR_INTERACTIVE_FOCUS =
  'input, textarea, select, button, a[href], summary, [contenteditable="true"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]';

type TerminalReference = (context: TerminalExcerptDraft) => string;

/** If the replacement ends with a space and the text already has one at `rangeEnd`, take that space with it. */
function extendReplacementRangeForTrailingSpace(
  fullText: string,
  endOffset: number,
  insertion: string,
): number {
  const swallowsSpace = insertion.endsWith(" ") && fullText[endOffset] === " ";
  return swallowsSpace ? endOffset + 1 : endOffset;
}

function basenameAndDirectory(path: string): { name: string; directory: string } {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1
    ? { name: trimmed, directory: "" }
    : { name: trimmed.slice(index + 1), directory: trimmed.slice(0, index) };
}

function isTextEntryTarget(element: Element | null): boolean {
  return element !== null && element.closest(EDITABLE_OR_INTERACTIVE_FOCUS) !== null;
}

function useRestingPromptControlsLayout(host: HTMLElement | null) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({ hiddenCount: 0, visible: false });

  const measure = useCallback(() => {
    const controls = controlsRef.current;
    if (!host || !controls) return;
    const measurement = measureRestingPromptControls(controls);
    if (!measurement) return;
    setLayout((previous) => {
      const next = resolveRestingPromptControlsLayout({
        ...measurement,
        hostWidth: host.clientWidth,
        previous,
      });
      return next.hiddenCount === previous.hiddenCount && next.visible === previous.visible
        ? previous
        : next;
    });
  }, [host]);

  useLayoutEffect(measure);
  useEffect(() => {
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [host, measure]);

  return { controlsRef, hiddenBlockCount: layout.hiddenCount, controlsVisible: layout.visible };
}

// ---------------------------------------------------------------------------
// The composer

export const ChatPrompt = memo(function ChatPrompt(props: ChatPromptProps) {
  const {
    composerDraftTarget: draftTarget,
    hostId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThread,
    activeThreadShell,
    settings,
    gitCwd,
    phase,
    isConnecting,
    isSendBusy,
    providerStatuses,
    providerCatalogKnown,
    agentMode,
    interactionMode,
    threadSyncPhase,
  } = props;
  const blobThread = props.blobThread === true;
  const isAssistantLane = props.isAssistantLane === true;
  const groupThread = useGroupThread();

  // ---- store subscriptions ----
  const draft = usePromptThreadDraft(draftTarget);
  const { prompt, terminalContexts, previewAnnotations, reviewComments } = draft;
  const attachments = usePromptAttachments(draftTarget);
  const addAttachments = usePromptAttachmentStore((state) => state.addAttachments);
  const removeAttachment = usePromptAttachmentStore((state) => state.removeAttachment);
  const draftActions = usePromptDraftStore.getState;
  const targetKey = promptTargetKey(draftTarget);
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const contextWindow = useMemo(
    () => contextWindowForComposer(props.activeContextWindow, blobThread),
    [props.activeContextWindow, blobThread],
  );
  const tasksProgress = threadSyncPhase ? null : props.activeTasksProgress;
  const taskSteps = threadSyncPhase ? null : props.activeTaskSteps;

  const chipActions = useMemo(
    () => ({
      openMention: (path: string) => useDockStore.getState().openFile(routeThreadRef, path),
    }),
    [routeThreadRef],
  );
  const chipRecords = useMemo(
    () => contextChipRecordsFromDraft({ terminalContexts, reviewComments, previewAnnotations }),
    [terminalContexts, reviewComments, previewAnnotations],
  );

  // ---- agent selection ----
  const entries = useMemo(
    () =>
      sortAgentProfileEntries(
        applyAgentProfilePrefs(deriveAgentProfileEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const sessionInstanceId = activeThread?.session?.providerInstanceId ?? null;
  const lockedInstanceId = sessionInstanceId ?? activeThread?.modelSelection?.instanceId ?? null;
  const selection = resolvePromptAgentSelection({
    entries,
    candidateInstanceIds: [
      draft.activeProvider,
      sessionInstanceId,
      props.activeThreadModelSelection?.instanceId,
      props.activeProjectDefaultModelSelection?.instanceId,
    ],
    lockedProvider: props.lockedProvider,
    lockedInstanceId,
  });
  const selectedEntry = selection.selectedProviderEntry;
  const noAgentAvailable = selectedEntry === undefined;
  const agentUnavailable = providerCatalogKnown && noAgentAvailable;
  const selectedAgent: AgentId = selectedEntry?.driverKind ?? selection.requestedDriverKind;
  const selectedInstanceId: AgentProfileId =
    selectedEntry?.instanceId ??
    (providerCatalogKnown ? undefined : props.activeThreadModelSelection?.instanceId) ??
    NO_AGENT_MODEL_PICK.instanceId;
  const agentSetupInstanceId: AgentProfileId | undefined =
    selection.unavailableProviderInstanceId ??
    (props.lockedProvider
      ? undefined
      : entries.find((entry) => hasAgentSetup(entry.snapshot))?.instanceId);
  const compactDisabledReason =
    props.compactDisabledReason ??
    (noAgentAvailable ? "Compacting is unavailable right now" : null);

  // ---- swarm ----
  const { supported: swarmSupported, status: swarmStatus } = useSwarmStatus(hostId);
  const projectTarget = useActiveProjectTarget();
  const projectCwd = projectTarget?.cwd ?? null;
  const hostHttpBaseUrl = useHostHttpBaseUrl(hostId);
  // Only a link that has actually failed counts as "reconnecting"; the pre-connect default does not.
  const hostLink = Option.getOrElse(
    AsyncResult.value(useAtomValue(hostCatalog.stateAtom(hostId as never))),
    () => AVAILABLE_LINK_STATE,
  );
  const hostReconnecting = hostLink.lastFailure !== null && hostLink.phase !== "connected";
  const swarmBaseUrl = swarmSupported ? hostHttpBaseUrl : null;
  const isGitRepo = useProjectIsGitRepo(swarmBaseUrl, projectCwd);
  const swarmAvailability = useMemo(
    () =>
      resolveSwarmToggleAvailability({
        capability: swarmSupported,
        selectedProvider: selectedAgent,
        status: swarmStatus,
        isGitRepo,
      }),
    [swarmSupported, selectedAgent, swarmStatus, isGitRepo],
  );
  const swarmThreadRef = props.isServerThread ? routeThreadRef : null;
  const setUpGit = useMemo(() => {
    if (!hostHttpBaseUrl || !projectCwd) return null;
    return async (): Promise<string | null> => {
      try {
        const url = new URL("/api/git/init", hostHttpBaseUrl);
        url.searchParams.set("cwd", projectCwd);
        const response = await fetchPrimaryHost(url.toString(), { method: "POST" });
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          reason?: string;
        } | null;
        if (!response.ok || body?.ok === false) {
          return body?.reason === "unsafe-root"
            ? "Kora won't turn a home or system folder into a repo. Open a project folder instead."
            : `Couldn't set up git: ${body?.reason ?? `HTTP ${response.status}`}`;
        }
        markProjectIsGitRepo(hostHttpBaseUrl, projectCwd, true);
        return null;
      } catch (error) {
        return `Couldn't set up git: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
  }, [hostHttpBaseUrl, projectCwd]);

  const { handleAgentModeChange } = props;
  const handleAgentModeSelect = useCallback(
    (mode: ThreadAgentMode) => {
      if (mode === "swarm" && agentMode !== "swarm") {
        if (swarmAvailability.kind === "hidden" || swarmAvailability.kind === "disabled") return;
        if (swarmAvailability.kind === "needs-setup") {
          openSwarmQuickSetup({ pendingSwitch: { target: draftTarget } });
          return;
        }
      }
      handleAgentModeChange(mode);
    },
    [agentMode, swarmAvailability.kind, draftTarget, handleAgentModeChange],
  );

  const firstRun = useFirstRunChecks();
  const claudeStepKind = claudeStep(firstRun.checks, firstRun.failed).kind;
  const claudeSignedOut = claudeStepKind === "sign-in" || claudeStepKind === "fix";
  const rateLimitedUntil = useMemo(
    () => leaderRateLimitedUntil((activeThread?.activities ?? []) as never, Date.now()),
    [activeThread?.activities],
  );
  const swarmBannerItems = useSwarmPromptBannerItems({
    hostId,
    threadRef: swarmThreadRef,
    agentMode: blobThread ? "chat" : agentMode,
    selectedProvider: selectedAgent,
    leaderRateLimitedUntil: rateLimitedUntil,
    isAssistantLane,
    onSwitchAgentMode: handleAgentModeSelect,
    claudeSignedOut,
  });

  // ---- model state ----
  const modelState = useEffectivePromptModelState({
    ...(typeof draftTarget === "string" ? { draftId: draftTarget } : { threadRef: draftTarget }),
    providers: providerStatuses,
    selectedProvider: selectedAgent,
    selectedInstanceId,
    threadModelSelection: props.activeThreadModelSelection,
    projectModelSelection: props.activeProjectDefaultModelSelection,
    settings,
  });
  const selectedModel = modelState.selectedModel;
  const antigravityBlock = getAntigravitySendBlockReason(selectedEntry?.snapshot, selectedModel);
  const sendDisabledReason =
    props.sendDisabledReason ??
    (props.activePendingProgress?.activeQuestion ? null : antigravityBlock);

  const selectedStatus = selectedEntry?.snapshot ?? null;
  const manualCompaction = agentSupportsManualCompaction(selectedEntry);
  const agentSkills = useMemo(
    () => (selectedStatus ? resolveAgentSkillsForCwd(selectedStatus, gitCwd) : []),
    [selectedStatus, gitCwd],
  );
  const agentSlashCommands = useMemo(
    () => (selectedStatus ? resolveAgentSlashCommandsForCwd(selectedStatus, gitCwd) : []),
    [selectedStatus, gitCwd],
  );
  const selectedModels = selectedEntry?.models ?? [];
  const turnModeResolution = resolvePromptTurnMode({
    planModeEnabled: true,
    provider: selectedStatus,
    interactionMode,
  });
  const planModeUiEnabled = turnModeResolution.enabled;
  const turnMode = turnModeResolution.interactionMode;
  const agentState = useMemo(
    () =>
      getPromptAgentState({
        provider: selectedAgent,
        model: selectedModel,
        models: selectedModels,
        promptInjectionState: getPromptInjectionState(prompt),
        modelOptions: modelState.modelOptions?.[selectedInstanceId],
        planModeEnabled: planModeUiEnabled,
      }),
    [
      selectedAgent,
      selectedModel,
      selectedModels,
      prompt,
      modelState.modelOptions,
      selectedInstanceId,
      planModeUiEnabled,
    ],
  );
  const modelSelectionForSend = useMemo(
    () => createModelPick(selectedInstanceId, selectedModel, agentState.modelOptionsForDispatch),
    [selectedInstanceId, selectedModel, agentState.modelOptionsForDispatch],
  );

  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        entries.map((entry) => {
          const pinned = entry.instanceId === selectedInstanceId ? selectedModel : null;
          return [entry.instanceId, getAppModelOptionsForInstance(settings, entry, pinned)];
        }),
      ),
    [entries, settings, selectedInstanceId, selectedModel],
  );
  const contextWindowModelName = resolveContextWindowModelDisplayName(
    props.activeThreadModelSelection,
    modelOptionsByInstance,
  );

  // ---- local state ----
  const initialCursor = useRef<number | null>(null);
  if (initialCursor.current === null) {
    initialCursor.current = collapseExpandedPromptCursor(prompt, prompt.length);
  }
  const [cursor, setCursor] = useState(initialCursor.current);
  const [trigger, setTrigger] = useState<PromptTrigger | null>(() =>
    detectPromptTrigger(prompt, prompt.length),
  );
  const [dismissedTrigger, setDismissedTrigger] = useState<DismissedPromptTrigger | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [isDragOverPrompt, setIsDragOverPrompt] = useState(false);
  const [footerCompact, setFooterCompact] = useState(false);
  const [primaryActionsCompact, setPrimaryActionsCompact] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const focusState = usePromptFocusState();
  const [promptSubmissionError, setPromptSubmissionError] = useState<string | null>(null);
  // Enter while Send is blocked flashes the reason, so the key never "does nothing".
  const [blockedFlash, setBlockedFlash] = useState(0);
  useEffect(() => {
    if (blockedFlash === 0) return;
    const timer = window.setTimeout(() => setBlockedFlash(0), 1600);
    return () => window.clearTimeout(timer);
  }, [blockedFlash]);
  const [providerInputError, setProviderInputError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const isMultilinePrompt = usePromptWraps(menuAnchor);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  const animationPrefs = usePanelAnimationPrefs();

  const editorRef = useRef<PromptEditorHandle | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const footerControlsRef = useRef<HTMLDivElement | null>(null);
  const selectLockRef = useRef(false);
  const blurFrameRef = useRef<number | null>(null);
  const pasteAsTextDeadlineRef = useRef(0);
  const providerInputRejectedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const retainedContexts = useRef({
    terminals: new Map<string, TerminalExcerptDraft>(),
    reviews: new Map<string, ReturnType<typeof reviewCommentFromRecord>>(),
    annotations: new Map<string, WebMarkupPayload>(),
  });

  // ---- pending question / approval ----
  const activeQuestion = props.activePendingProgress?.activeQuestion ?? null;
  const choiceOnlyQuestion = activeQuestion !== null && activeQuestion.allowCustomAnswer === false;
  const pendingApproval = props.activePendingApproval;
  const hasPendingQuestion = props.pendingUserInputs.length > 0;
  const questionRequestId = props.pendingUserInputs[0]?.requestId ?? null;
  const questionSyncKey =
    activeQuestion && questionRequestId ? `${questionRequestId}:${activeQuestion.id}` : null;
  const questionCustomAnswer = props.activePendingProgress?.customAnswer ?? "";
  const questionSyncRef = useRef<{ key: string; answer: string } | null>(null);

  const topDrawerShown =
    pendingApproval !== null ||
    hasPendingQuestion ||
    (props.offerPlanFollowUp && props.activeProposedPlan !== null);
  const wideFooterActions = props.offerPlanFollowUp || activeQuestion !== null;
  const footerActionLayoutKey = activeQuestion
    ? `pending:${props.activePendingProgress?.questionIndex}:${props.activePendingProgress?.isLastQuestion}:${props.activePendingIsResponding}`
    : phase === "running"
      ? "running"
      : props.offerPlanFollowUp
        ? prompt.trim()
          ? "plan:refine"
          : "plan:implement"
        : "idle";

  const sendState = derivePromptSendState({
    prompt,
    imageCount: attachments.length,
    terminalContexts,
    elementContextCount: previewAnnotations.length + reviewComments.length,
  });
  const { hasSendableContent } = sendState;
  const footerActionKey =
    footerActionLayoutKey === "idle"
      ? `idle:${hasSendableContent}:${isSendBusy}:${isConnecting}`
      : footerActionLayoutKey;

  // ---- trigger / menu ----
  const triggerKind = trigger?.kind ?? null;
  const triggerQuery = trigger?.query ?? "";
  const pathSearch = usePromptPathSearch({
    hostId,
    cwd: groupThread || triggerKind !== "path" ? null : gitCwd,
    query: triggerKind === "path" ? triggerQuery : null,
  });

  const slashCompactAvailable = useMemo(() => {
    if (!manualCompaction || !trigger || trigger.kind !== "slash-command") return false;
    return (
      trigger.rangeStart === 0 &&
      prompt.slice(trigger.rangeEnd).length === 0 &&
      terminalContexts.length === 0 &&
      previewAnnotations.length === 0 &&
      reviewComments.length === 0
    );
  }, [manualCompaction, trigger, prompt, terminalContexts, previewAnnotations, reviewComments]);

  const menuItems = useMemo<PromptCommandItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "path") {
      if (groupThread) {
        return groupMentionItems(groupThread, trigger.query).map((item) => ({
          id: `group-member:${item.mention}`,
          type: "group-member" as const,
          mention: item.mention,
          label: `@${item.mention}`,
          description: item.description,
          avatar: item.member ? (
            <BlobAvatar
              outfit={item.member.outfit}
              chief={item.member.chief}
              chiefScale={1}
              size={20}
              still
              eyesFollowCursor={false}
            />
          ) : null,
        }));
      }
      return pathSearch.entries.map((entry) => {
        const { name, directory } = basenameAndDirectory(entry.path);
        return {
          id: `path:${entry.kind}:${entry.path}`,
          description: directory,
          type: "path" as const,
          pathKind: entry.kind,
          path: entry.path,
          label: name,
        };
      });
    }
    if (trigger.kind === "skill") {
      return searchAgentSkills(agentSkills, trigger.query).map((skill) => ({
        id: `skill:${selectedAgent}:${skill.name}`,
        type: "skill" as const,
        provider: selectedAgent,
        skill,
        label: formatAgentSkillDisplayName(skill),
        description:
          skill.shortDescription ?? skill.description ?? `${skill.scope ?? "Personal"} skill`,
      }));
    }
    const base: PromptCommandItem[] = [
      {
        description: "Switch response model for this chat",
        type: "slash-command",
        id: "slash:model",
        command: "model",
        label: "/model",
      },
    ];
    if (planModeUiEnabled) {
      base.push(
        {
          description: "Switch this chat into plan mode",
          type: "slash-command",
          id: "slash:plan",
          command: "plan",
          label: "/plan",
        },
        {
          description: "Switch this chat back to normal build mode",
          type: "slash-command",
          id: "slash:default",
          command: "default",
          label: "/default",
        },
      );
    }
    for (const command of agentSlashCommands) {
      if (command.name === "compact" && !slashCompactAvailable) continue;
      base.push({
        id: `provider-slash-command:${selectedAgent}:${command.name}`,
        type: "provider-slash-command",
        provider: selectedAgent,
        command,
        label: `/${command.name}`,
        description: command.description || command.input?.hint || "Run provider command",
      });
    }
    if (settings.showSkillsInSlashMenu) {
      for (const skill of agentSkills) {
        base.push({
          id: `skill:${selectedAgent}:${skill.name}`,
          type: "skill",
          provider: selectedAgent,
          skill,
          label: `/skill:${skill.name}`,
          description:
            skill.shortDescription ?? skill.description ?? `${skill.scope ?? "Personal"} skill`,
        });
      }
    }
    const atStart = trigger.rangeStart === 0;
    const filtered = slashCommandItemsForPromptPosition(
      base as Parameters<typeof slashCommandItemsForPromptPosition>[0],
      atStart,
    );
    return searchSlashCommandItems(filtered, trigger.query);
  }, [
    trigger,
    groupThread,
    pathSearch.entries,
    agentSkills,
    selectedAgent,
    planModeUiEnabled,
    agentSlashCommands,
    slashCompactAvailable,
    settings.showSkillsInSlashMenu,
  ]);

  const menuEmptyText =
    triggerKind === "skill"
      ? "No skills found. Try / to browse provider commands."
      : triggerKind === "path"
        ? "No matching files or folders."
        : "No matching command.";
  const menuLoading = triggerKind === "path" && triggerQuery.trim() !== "" && pathSearch.isPending;
  const menuOpen = trigger !== null && !isPromptTriggerDismissed(trigger, dismissedTrigger);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const activeItemId = menuOpen
    ? resolvePromptMenuActiveItemId({
        items: menuItems,
        highlightedItemId,
        currentSearchKey: searchKey,
        highlightedSearchKey,
      })
    : null;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const menuItemsRef = useRef(menuItems);
  menuItemsRef.current = menuItems;
  const activeItemIdRef = useRef(activeItemId);
  activeItemIdRef.current = activeItemId;

  // ---- sync effects ----
  useEffect(() => {
    props.promptRef.current = prompt;
    setCursor((current) => clampCollapsedPromptCursor(prompt, current));
  }, [prompt, props.promptRef]);
  useEffect(() => {
    setPromptSubmissionError((current) =>
      current === null ? current : getPromptLengthValidationMessage(prompt),
    );
  }, [prompt]);
  useEffect(() => {
    setProviderInputError(null);
  }, [
    terminalContexts,
    previewAnnotations,
    reviewComments,
    prompt,
    selectedModel,
    agentState.promptEffort,
    selectedAgent,
  ]);
  useEffect(() => {
    props.composerTerminalContextsRef.current = terminalContexts;
  }, [terminalContexts, props.composerTerminalContextsRef]);

  useEffect(() => {
    if (!menuOpen) {
      setHighlightedItemId(null);
      setHighlightedSearchKey(null);
      return;
    }
    setHighlightedItemId(activeItemId);
    setHighlightedSearchKey(searchKey);
  }, [menuOpen, activeItemId, searchKey]);
  useEffect(() => {
    if (dismissedTrigger && !trigger) setDismissedTrigger(null);
  }, [dismissedTrigger, trigger]);

  // A new thread / draft starts the composer from its own text.
  useEffect(() => {
    setHighlightedItemId(null);
    setHighlightedSearchKey(null);
    setPromptSubmissionError(null);
    setProviderInputError(null);
    const text = usePromptDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
    setCursor(collapseExpandedPromptCursor(text, text.length));
    setTrigger(detectPromptTrigger(text, text.length));
    setDragOver(false);
    focusState.setIsComposerScrollCollapsed(false);
  }, [targetKey]);

  useEffect(() => {
    if (!questionSyncKey || choiceOnlyQuestion) {
      questionSyncRef.current = null;
      return;
    }
    const last = questionSyncRef.current;
    if (last && last.key === questionSyncKey && last.answer === questionCustomAnswer) return;
    questionSyncRef.current = { key: questionSyncKey, answer: questionCustomAnswer };
    setCursor(collapseExpandedPromptCursor(questionCustomAnswer, questionCustomAnswer.length));
    setTrigger(detectPromptTrigger(questionCustomAnswer, questionCustomAnswer.length));
    setHighlightedItemId(null);
  }, [questionSyncKey, questionCustomAnswer, choiceOnlyQuestion]);

  // The tasks drawer closes when the tasks go away or something more important needs the space.
  useEffect(() => {
    if (
      !tasksProgress ||
      !taskSteps ||
      taskSteps.length === 0 ||
      pendingApproval ||
      hasPendingQuestion
    ) {
      setTasksDrawerOpen(false);
    }
  }, [tasksProgress, taskSteps, pendingApproval, hasPendingQuestion]);
  useEffect(() => {
    setTasksDrawerOpen(false);
  }, [targetKey]);

  function setDragOver(active: boolean) {
    setIsDragOverPrompt(active);
  }

  // ---- "Paste as Text" bridge ----
  useEffect(() => {
    const arm = () => {
      const active = document.activeElement;
      const insideForm = active !== null && formRef.current?.contains(active) === true;
      if (!insideForm && isTextEntryTarget(active)) return;
      pasteAsTextDeadlineRef.current = Date.now() + PASTE_AS_TEXT_WINDOW_MS;
    };
    const disarm = () => {
      pasteAsTextDeadlineRef.current = 0;
    };
    window.addEventListener(SHELL_PASTE_AS_TEXT_EVENT, arm);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener(SHELL_PASTE_AS_TEXT_EVENT, arm);
      window.removeEventListener("blur", disarm);
    };
  }, []);

  // ---- footer compactness ----
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const measure = () => {
      const width = form.clientWidth;
      const compact = shouldUseCompactPromptFooter(width, { hasWideActions: wideFooterActions });
      setFooterCompact(compact);
      setPrimaryActionsCompact(
        compact &&
          shouldUseCompactPromptPrimaryActions(width, { hasWideActions: wideFooterActions }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    return () => observer.disconnect();
  }, [targetKey, footerActionKey, wideFooterActions, pendingApproval !== null]);
  useEffect(() => {
    const target = footerControlsRef.current;
    const container = formRef.current;
    if (!target || !container) return;
    return observeResponsiveBreakpointFade({
      target,
      container,
      active: animationPrefs.active,
      durationMs: animationPrefs.durationMs,
      breakpoint: { value: wideFooterActions ? 780 : 620, unit: "px" },
    });
  }, [
    targetKey,
    footerActionKey,
    wideFooterActions,
    pendingApproval !== null,
    animationPrefs.active,
    animationPrefs.durationMs,
  ]);

  // ---- resting layout (the composer currently stays expanded; the hooks keep the contract) ----
  const restingControls = useRestingPromptControlsLayout(props.restingControlsHost);
  const { onRestingControlsVisibilityChange, onRestingChange } = props;
  useLayoutEffect(() => {
    onRestingControlsVisibilityChange(restingControls.controlsVisible);
  }, [restingControls.controlsVisible, onRestingControlsVisibilityChange]);
  useLayoutEffect(() => {
    onRestingChange(false);
  }, [onRestingChange]);
  const surfaceRef = usePromptRestingTransition(
    focusState.isComposerScrollCollapsed,
    false,
    restingControls.controlsRef,
    useCallback(() => props.onComposerOverlayHeightChange(0), [props]),
  );

  useEffect(
    () => () => {
      if (blurFrameRef.current !== null) cancelAnimationFrame(blurFrameRef.current);
    },
    [],
  );

  // ---- prompt text helpers ----
  const expandPromptForEditorChange = useCallback(() => {
    focusState.setIsComposerScrollCollapsed(false);
  }, [focusState]);

  const refreshCursor = useCallback(
    (text: string, nextCursor: number, expandedCursor: number, adjacent: boolean) => {
      setCursor(nextCursor);
      setTrigger(adjacent ? null : detectPromptTrigger(text, expandedCursor));
    },
    [],
  );

  const storeDraft = useCallback(
    (nextPrompt: string) => {
      draftActions().setPrompt(draftTarget, nextPrompt);
    },
    [draftActions, draftTarget],
  );

  const readPromptSnapshot = useCallback(() => {
    const snapshot = editorRef.current?.readSnapshot();
    if (snapshot) return snapshot;
    const value = props.promptRef.current;
    const collapsed = cursorRef.current;
    return {
      value,
      cursor: collapsed,
      expandedCursor: expandCollapsedPromptCursor(value, collapsed),
      contextIds: collectInlineContextIds(value),
    };
  }, [props.promptRef]);

  const forwardToPendingAnswer = props.onChangeActivePendingUserInputCustomAnswer;

  const onPromptChange = useCallback(
    (
      typedPrompt: string,
      caret: number,
      expandedCaret: number,
      adjacentToMention: boolean,
      contextIds: string[],
    ) => {
      expandPromptForEditorChange();
      if (activeQuestion) {
        if (activeQuestion.allowCustomAnswer === false) return;
        if (questionSyncKey)
          questionSyncRef.current = { key: questionSyncKey, answer: typedPrompt };
        refreshCursor(typedPrompt, caret, expandedCaret, adjacentToMention);
        forwardToPendingAnswer(
          activeQuestion.id,
          typedPrompt,
          caret,
          expandedCaret,
          adjacentToMention,
        );
        return;
      }
      props.promptRef.current = typedPrompt;
      storeDraft(typedPrompt);

      const store = draftActions();
      const current = store.getComposerDraft(draftTarget);
      const referenced = new Set(contextIds);
      const retained = retainedContexts.current;
      if (current) {
        const terminalId = (context: TerminalExcerptDraft) => terminalReferenceId(context);
        const keptTerminals = current.terminalContexts.filter((context) => {
          const wanted = referenced.has(terminalId(context));
          if (!wanted) retained.terminals.set(terminalId(context), context);
          return wanted;
        });
        const restoredTerminals = [...retained.terminals.entries()]
          .filter(([id]) => referenced.has(id) && !keptTerminals.some((c) => terminalId(c) === id))
          .map(([, context]) => context);
        if (
          keptTerminals.length !== current.terminalContexts.length ||
          restoredTerminals.length > 0
        ) {
          store.setTerminalContexts(draftTarget, [...keptTerminals, ...restoredTerminals]);
        }

        const keptReviews = current.reviewComments.filter((comment) => {
          const wanted = referenced.has(reviewCommentContextId(comment.id));
          if (!wanted) retained.reviews.set(reviewCommentContextId(comment.id), comment);
          return wanted;
        });
        if (keptReviews.length !== current.reviewComments.length) {
          store.setReviewComments(draftTarget, keptReviews);
        }
        for (const [id, comment] of retained.reviews) {
          if (referenced.has(id) && !keptReviews.some((c) => reviewCommentContextId(c.id) === id)) {
            store.addReviewComment(draftTarget, comment, { appendReference: false });
          }
        }

        const keptAnnotations = current.previewAnnotations.filter((annotation) => {
          const wanted = referenced.has(webMarkupContextId(annotation.id));
          if (!wanted) retained.annotations.set(webMarkupContextId(annotation.id), annotation);
          return wanted;
        });
        if (keptAnnotations.length !== current.previewAnnotations.length) {
          store.setPreviewAnnotations(draftTarget, keptAnnotations);
        }
        for (const [id, annotation] of retained.annotations) {
          if (referenced.has(id) && !keptAnnotations.some((a) => webMarkupContextId(a.id) === id)) {
            store.addPreviewAnnotation(draftTarget, annotation, { appendReference: false });
          }
        }
      }
      refreshCursor(typedPrompt, caret, expandedCaret, adjacentToMention);
    },
    [
      activeQuestion,
      questionSyncKey,
      draftActions,
      draftTarget,
      expandPromptForEditorChange,
      forwardToPendingAnswer,
      props.promptRef,
      refreshCursor,
      storeDraft,
    ],
  );

  const applyPromptReplacement = useCallback(
    (
      from: number,
      to: number,
      replacement: string,
      options: {
        citationComment?: { start: number; sourceAnchor: ReplyFootnoteSourceAnchor };
        focusEditorAfterReplace?: boolean;
        expectedText?: string;
      } = {},
    ): boolean => {
      if (choiceOnlyQuestion) return false;
      const source = activeQuestion ? questionCustomAnswerRef.current : props.promptRef.current;
      const start = Math.max(0, Math.min(from, source.length));
      const end = Math.max(start, Math.min(to, source.length));
      if (options.expectedText !== undefined && source.slice(start, end) !== options.expectedText) {
        return false;
      }
      const next = replaceTextRange(source, start, end, replacement);
      const nextCollapsed = collapseExpandedPromptCursor(next.text, next.cursor);
      if (options.citationComment) {
        editorRef.current?.requestCitationComment({
          sourceAnchor: options.citationComment.sourceAnchor,
          citationStart: options.citationComment.start,
          previousValue: source,
          value: next.text,
        });
      }
      if (activeQuestion) {
        if (questionSyncKey) questionSyncRef.current = { key: questionSyncKey, answer: next.text };
        forwardToPendingAnswer(activeQuestion.id, next.text, nextCollapsed, next.cursor, false);
      } else {
        props.promptRef.current = next.text;
        storeDraft(next.text);
      }
      setCursor(nextCollapsed);
      setTrigger(detectPromptTrigger(next.text, next.cursor));
      if (options.focusEditorAfterReplace !== false) {
        const written = next.text;
        requestAnimationFrame(() => {
          const live = activeQuestion ? questionCustomAnswerRef.current : props.promptRef.current;
          if (live !== written) return;
          editorRef.current?.focusAt(nextCollapsed);
        });
      }
      return true;
    },
    [
      activeQuestion,
      choiceOnlyQuestion,
      forwardToPendingAnswer,
      props.promptRef,
      questionSyncKey,
      storeDraft,
    ],
  );
  const questionCustomAnswerRef = useRef(questionCustomAnswer);
  questionCustomAnswerRef.current = questionCustomAnswer;

  // ---- submit ----
  const onSendProp = props.onSend;
  const submitPrompt = useCallback(
    (event?: { preventDefault(): void }, intent: PromptSubmissionIntent = "foreground") => {
      if (noAgentAvailable || sendDisabledReason !== null) {
        event?.preventDefault();
        if (sendDisabledReason !== null) setBlockedFlash((n) => n + 1);
        return;
      }
      const result = submitPromptDraft({
        prompt: props.promptRef.current,
        submissionTarget: hasPendingQuestion ? "pending-user-input" : "provider-turn",
        event,
        onSend: (sendEvent) => {
          providerInputRejectedRef.current = false;
          onSendProp(sendEvent, intent);
          return !providerInputRejectedRef.current;
        },
      });
      setPromptSubmissionError(result.validationMessage);
    },
    [hasPendingQuestion, noAgentAvailable, onSendProp, props.promptRef, sendDisabledReason],
  );

  const compactThreadContext = useCallback(() => {
    if (
      props.compactDisabled ||
      noAgentAvailable ||
      pendingApproval ||
      hasPendingQuestion ||
      isConnecting ||
      isSendBusy ||
      phase === "running" ||
      !props.activeThreadId
    ) {
      return;
    }
    props.onCompactContext();
  }, [
    props,
    noAgentAvailable,
    pendingApproval,
    hasPendingQuestion,
    phase,
    isSendBusy,
    isConnecting,
  ]);

  // ---- menu interaction ----
  const handleTurnModeChange = props.handleInteractionModeChange;
  const onSelectPromptItem = useCallback(
    (item: PromptCommandItem) => {
      if (selectLockRef.current) return;
      const active = (() => {
        const snapshot = readPromptSnapshot();
        const detected = detectPromptTrigger(snapshot.value, snapshot.expandedCursor);
        return detected ? { trigger: detected, text: snapshot.value } : null;
      })();
      if (!active) return;
      selectLockRef.current = true;
      requestAnimationFrame(() => {
        selectLockRef.current = false;
      });
      const { trigger: current, text } = active;
      const triggerText = text.slice(current.rangeStart, current.rangeEnd);
      const replace = (replacement: string, focus = true): boolean => {
        const end = extendReplacementRangeForTrailingSpace(text, current.rangeEnd, replacement);
        return applyPromptReplacement(current.rangeStart, end, replacement, {
          expectedText: end === current.rangeEnd ? triggerText : triggerText + " ",
          focusEditorAfterReplace: focus,
        });
      };
      const remove = (focus = false) =>
        applyPromptReplacement(current.rangeStart, current.rangeEnd, "", {
          expectedText: triggerText,
          focusEditorAfterReplace: focus,
        });

      let done = false;
      switch (item.type) {
        case "group-member":
          done = replace(`@${item.mention} `);
          break;
        case "path":
          done = replace(`${serializePromptFileLink(item.path)} `);
          break;
        case "slash-command":
          if (item.command === "model") {
            done = remove(false);
            if (done) setIsModelPickerOpen(true);
          } else if (planModeUiEnabled) {
            done = remove(true);
            if (done) handleTurnModeChange(item.command === "plan" ? "plan" : "default");
          }
          break;
        case "provider-slash-command":
          if (item.command.name === USAGE_LIMITS_COMMAND.name && props.onUsageLimitsCommand) {
            done = remove(false);
            if (done) props.onUsageLimitsCommand();
          } else {
            done = replace(`/${item.command.name} `);
          }
          break;
        case "skill":
          done = replace(`$${item.skill.name} `);
          break;
      }
      if (done) setHighlightedItemId(null);
    },
    [applyPromptReplacement, handleTurnModeChange, planModeUiEnabled, props, readPromptSnapshot],
  );

  const nudgeHighlight = useCallback((direction: "ArrowDown" | "ArrowUp") => {
    const items = menuItemsRef.current;
    if (items.length === 0) return;
    const index = items.findIndex((item) => item.id === activeItemIdRef.current);
    const offset = direction === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? 0 : (index + offset + items.length) % items.length;
    setHighlightedItemId(items[next]!.id);
    setHighlightedSearchKey(searchKeyRef.current);
  }, []);
  const searchKeyRef = useRef(searchKey);
  searchKeyRef.current = searchKey;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const escapeStopsTurnRef = useRef(false);
  escapeStopsTurnRef.current =
    phase === "running" && pendingApproval === null && !hasPendingQuestion;
  const onInterruptRef = useRef(props.onInterrupt);
  onInterruptRef.current = props.onInterrupt;

  const onPromptCommandKey = useCallback(
    (key: PromptCommandKey, event: KeyboardEvent): boolean => {
      const currentTrigger = triggerRef.current;
      if (key === "Escape") {
        if (currentTrigger && menuOpenRef.current) {
          setDismissedTrigger({ kind: currentTrigger.kind, rangeStart: currentTrigger.rangeStart });
          return true;
        }
        // Esc stops a running turn, but only from the composer and only when nothing else owns Escape:
        // an approval, a question, the worker picker, or any open menu, popover or dialog.
        if (
          escapeStopsTurnRef.current &&
          !event.isComposing &&
          !document.querySelector(
            '[data-slot$="-popup"][data-open], [role="dialog"][aria-modal="true"], [data-worker-picker]',
          )
        ) {
          onInterruptRef.current();
          return true;
        }
        return false;
      }
      if (menuOpenRef.current) {
        if (key === "ArrowDown" || key === "ArrowUp") {
          nudgeHighlight(key);
          return true;
        }
        if (key === "Enter" || key === "Tab") {
          const items = menuItemsRef.current;
          const chosen = items.find((item) => item.id === activeItemIdRef.current) ?? items[0];
          if (chosen) {
            onSelectPromptItem(chosen);
            return true;
          }
        }
      }
      if (key === "Enter") {
        const intent = promptSubmissionIntentForEnter({ shiftKey: event.shiftKey });
        if (intent === null) return false;
        submitPrompt(event, intent);
        return true;
      }
      return false;
    },
    [nudgeHighlight, onSelectPromptItem, submitPrompt],
  );

  // ---- attachments ----
  const attachFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      const intake = partitionIncomingAttachmentFiles(files, attachments.length);
      for (const rejection of intake.rejections) {
        toastManager.add({
          type: "error",
          title: rejection.title,
          description: rejection.description,
        });
      }
      const target = draftTarget;
      const key = targetKeyRef.current;
      const loaded = await Promise.all(
        intake.accepted.map((file) => fileToPendingPromptAttachment(file, randomUUID())),
      );
      if (promptTargetKey(target) !== key) return;
      addAttachments(target, loaded);
    },
    [addAttachments, attachments.length, draftTarget],
  );

  const attachDisabled =
    isConnecting ||
    pendingApproval !== null ||
    hasPendingQuestion ||
    props.projectSelectionRequired;

  // ---- paste ----
  const rejectOversizedPaste = useCallback(
    (plainText: string, selectionOverride?: { start: number; end: number }): boolean => {
      const value = props.promptRef.current;
      const range = selectionOverride ??
        editorRef.current?.readSelectionRange() ?? {
          start: value.length,
          end: value.length,
        };
      const exceeds = wouldTextPasteExceedLimit({
        valueLength: value.length,
        selection: range,
        textLength: plainText.length,
        maxLength: AGENT_SEND_TURN_MAX_INPUT_CHARS,
      });
      if (!exceeds) return false;
      toastManager.add({
        title: "Pasted text is too large for this message",
        description: "Remove some text, then paste again.",
        data: { hideCopyButton: true },
        type: "error",
      });
      return true;
    },
    [props.promptRef],
  );

  const onPromptPaste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        void attachFiles(files);
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      pasteAsTextDeadlineRef.current = 0;
      const chip = readPastedContextChip(event.clipboardData);
      if (chip && chip.records.length > 0) return;
      if (text && rejectOversizedPaste(text)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [attachFiles, rejectOversizedPaste],
  );

  // ---- context records ----
  const terminalThreadId: ThreadId | null = props.activeThreadId ?? routeThreadRef.threadId ?? null;

  const buildContextClipboardFragment = useCallback(
    (requestedIds: ReadonlyArray<string>): string | null => {
      const wanted = new Set(requestedIds);
      const current = draftActions().getComposerDraft(draftTarget);
      if (!current) return null;
      const records: ContextChipRecord[] = [];
      for (const context of current.terminalContexts) {
        if (wanted.has(terminalReferenceId(context))) records.push(terminalRecordOf(context));
      }
      for (const comment of current.reviewComments) {
        if (wanted.has(reviewCommentContextId(comment.id))) records.push(reviewRecordOf(comment));
      }
      for (const annotation of current.previewAnnotations) {
        if (wanted.has(webMarkupContextId(annotation.id))) records.push(markupRecordOf(annotation));
      }
      if (records.length === 0) return null;
      return encodeContextChipFragment({
        version: 1,
        source: {
          hostId,
          ...(terminalThreadId ? { threadId: terminalThreadId } : {}),
        },
        records,
      });
    },
    [draftActions, draftTarget, hostId, terminalThreadId],
  );

  const importContextRecords = useCallback(
    (records: ReadonlyArray<ContextChipRecord>): ReadonlyMap<string, string> => {
      const renamed = new Map<string, string>();
      const store = draftActions();
      const now = () => new Date().toISOString();
      for (const incoming of records) {
        const known = asKnownContextRecord(incoming);
        if (!known) continue;
        const current = store.getComposerDraft(draftTarget);
        const existingRecords = current ? draftRecordsFor(current) : [];
        const lookup = new Set<string>(contextChipImportLookupIds(known));
        const existing = existingRecords.find((record) => lookup.has(record.contextId));
        if (existing && isSameContextChipPayload(existing, known)) continue;
        // Producer ids fold into context ids, so two different excerpts can collide: mint a fresh id.
        const fresh = existing ? randomUUID() : null;
        const withId = fresh ? { ...known, contextId: remintContextId(known.kind, fresh) } : known;
        if (fresh) renamed.set(known.contextId, withId.contextId);
        switch (withId.kind) {
          case "terminal": {
            if (!terminalThreadId) break;
            store.addTerminalContexts(
              draftTarget,
              [terminalExcerptDraftFromRecord(withId, terminalThreadId)],
              { appendReference: false },
            );
            break;
          }
          case "review-comment":
            store.addReviewComment(draftTarget, reviewCommentFromRecord(withId), {
              appendReference: false,
            });
            break;
          case "element":
            store.addPreviewAnnotation(
              draftTarget,
              elementContextToWebMarkup(withId, randomUUID(), now()),
              { appendReference: false },
            );
            break;
          case "preview-annotation":
            store.addPreviewAnnotation(draftTarget, webMarkupFromRecord(withId), {
              appendReference: false,
            });
            break;
          default:
            break;
        }
      }
      return renamed;
    },
    [draftActions, draftTarget, terminalThreadId],
  );
  const importContextFragment = useCallback(
    (fragment: { records: ReadonlyArray<ContextChipRecord> }) =>
      importContextRecords(fragment.records),
    [importContextRecords],
  );

  // ---- inserting text ----
  const insertPromptText = useCallback(
    (
      text: string,
      position: "cursor" | "end",
      options: {
        citationCommentAnchor?: ReplyFootnoteSourceAnchor;
        ensureLeadingBoundary?: boolean;
        clipboardData?: DataTransfer;
      } = {},
    ): boolean => {
      if (
        text === "" ||
        isConnecting ||
        pendingApproval ||
        hasPendingQuestion ||
        props.projectSelectionRequired
      ) {
        return false;
      }
      if (options.citationCommentAnchor && !editorRef.current) return false;
      const insertText = options.clipboardData
        ? importPastedPromptText(options.clipboardData, importContextFragment)
        : text;
      const value = props.promptRef.current;
      const snapshotCursor = editorRef.current?.readSnapshot().expandedCursor;
      const at = position === "end" || snapshotCursor === undefined ? value.length : snapshotCursor;
      const needsBoundary =
        options.ensureLeadingBoundary === true && at > 0 && !/\s/.test(value[at - 1] ?? " ");
      const replacement = `${needsBoundary ? " " : ""}${insertText}`;
      const end = extendReplacementRangeForTrailingSpace(value, at, replacement);
      return applyPromptReplacement(at, end, replacement, {
        focusEditorAfterReplace: options.citationCommentAnchor === undefined,
        ...(options.citationCommentAnchor
          ? {
              citationComment: {
                start: at + (needsBoundary ? 1 : 0),
                sourceAnchor: options.citationCommentAnchor,
              },
            }
          : {}),
      });
    },
    [
      applyPromptReplacement,
      hasPendingQuestion,
      importContextFragment,
      isConnecting,
      pendingApproval,
      props.projectSelectionRequired,
      props.promptRef,
    ],
  );

  useEffect(() => {
    const store = draftActions();
    return store.setContextInsertionHandler(draftTarget, (references) =>
      insertPromptText(`${references.map(formatInlineContextLink).join(" ")} `, "cursor", {
        ensureLeadingBoundary: true,
      }),
    );
  }, [draftActions, draftTarget, insertPromptText]);

  // ---- traits ----
  const onTraitsPromptChange = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === props.promptRef.current) {
        props.focusComposer();
        return;
      }
      props.promptRef.current = nextPrompt;
      storeDraft(nextPrompt);
      const collapsed = collapseExpandedPromptCursor(nextPrompt, nextPrompt.length);
      setCursor(collapsed);
      setTrigger(detectPromptTrigger(nextPrompt, nextPrompt.length));
      props.scheduleComposerFocus();
    },
    [props, storeDraft],
  );
  const traitsInput = useMemo<TraitsRenderInput>(
    () => ({
      provider: selectedAgent,
      instanceId: selectedInstanceId,
      ...(props.isServerThread ? { threadRef: routeThreadRef } : draftId ? { draftId } : {}),
      model: selectedModel,
      models: selectedModels,
      modelOptions: modelState.modelOptions?.[selectedInstanceId] ?? undefined,
      prompt,
      onPromptChange: onTraitsPromptChange,
      planModeEnabled: planModeUiEnabled,
      isComposerOwned: true,
    }),
    [
      selectedAgent,
      selectedInstanceId,
      props.isServerThread,
      routeThreadRef,
      draftId,
      selectedModel,
      selectedModels,
      modelState.modelOptions,
      prompt,
      onTraitsPromptChange,
      planModeUiEnabled,
    ],
  );

  // ---- imperative handle ----
  const latest = useRef({
    prompt,
    terminalContexts,
    previewAnnotations,
    reviewComments,
    attachments,
    agentState,
    modelSelectionForSend,
    noAgentAvailable,
    antigravityBlock,
    selectedAgent,
    selectedModel,
    selectedModels,
    turnMode,
    planModeUiEnabled,
  });
  latest.current = {
    prompt,
    terminalContexts,
    previewAnnotations,
    reviewComments,
    attachments,
    agentState,
    modelSelectionForSend,
    noAgentAvailable,
    antigravityBlock,
    selectedAgent,
    selectedModel,
    selectedModels,
    turnMode,
    planModeUiEnabled,
  };

  useImperativeHandle(
    props.composerRef,
    (): ChatPromptHandle => ({
      focusAtEnd: () => editorRef.current?.focusAtEnd(),
      focusAt: (at) => editorRef.current?.focusAt(at),
      restoreAtTimelineEnd: () => focusState.restoreAtTimelineEnd(),
      collapseForTimelineScrollKey: (key) => {
        const node = props.getTimelineScrollableNode();
        if (!node || !settings.composerCollapseOnScroll || isMultilinePrompt) return;
        if (
          shouldCollapsePromptForScrollKey({
            key,
            scrollTop: node.scrollTop,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            isAtLogicalEnd: props.isTimelineAtLogicalEnd(),
          })
        ) {
          focusState.setIsComposerScrollCollapsed(true);
        }
      },
      insertTextAtEnd: (text, options) =>
        insertPromptText(text, "end", {
          ...(options?.ensureLeadingBoundary !== undefined
            ? { ensureLeadingBoundary: options.ensureLeadingBoundary }
            : {}),
          ...(options?.clipboardData ? { clipboardData: options.clipboardData } : {}),
        }),
      pasteTextAtEnd: (text) => {
        pasteAsTextDeadlineRef.current = 0;
        const end = props.promptRef.current.length;
        if (!rejectOversizedPaste(text, { start: end, end })) return false;
        props.focusComposer();
        return true;
      },
      citeAssistantText: (citation, sourceAnchor) =>
        insertPromptText(formatReplyFootnoteForPrompt(citation, citation.comment), "cursor", {
          ensureLeadingBoundary: true,
          citationCommentAnchor: sourceAnchor,
        }),
      openModelPicker: () => setIsModelPickerOpen(true),
      toggleModelPicker: () => setIsModelPickerOpen((open) => !open),
      isModelPickerOpen: () => isModelPickerOpenRef.current,
      compactContext: compactThreadContext,
      readSnapshot: readPromptSnapshot,
      resetCursorState: (options) => {
        setHighlightedItemId(null);
        const text = options?.prompt ?? props.promptRef.current;
        const collapsed = clampCollapsedPromptCursor(text, options?.cursor ?? text.length);
        setCursor(collapsed);
        setTrigger(
          options?.detectTrigger
            ? detectPromptTrigger(text, expandCollapsedPromptCursor(text, collapsed))
            : null,
        );
      },
      addTerminalContext: (selection) => {
        if (!terminalThreadId || choiceOnlyQuestion) return;
        const context: TerminalExcerptDraft = {
          id: randomUUID(),
          threadId: terminalThreadId,
          createdAt: new Date().toISOString(),
          ...selection,
        };
        const snapshot = readPromptSnapshot();
        const inserted = insertInlineContextLink(
          snapshot.value,
          snapshot.expandedCursor,
          terminalReferenceOf(context),
        );
        const ok = draftActions().insertTerminalContext(draftTarget, inserted.prompt, context, 0);
        if (!ok) return;
        props.promptRef.current = inserted.prompt;
        const collapsed = collapseExpandedPromptCursor(inserted.prompt, inserted.cursor);
        setCursor(collapsed);
        setTrigger(detectPromptTrigger(inserted.prompt, inserted.cursor));
        requestAnimationFrame(() => editorRef.current?.focusAt(collapsed));
      },
      getSendContext: () => {
        const state = latest.current;
        return {
          prompt: state.prompt,
          terminalContexts: props.composerTerminalContextsRef.current,
          previewAnnotations: state.previewAnnotations,
          reviewComments: state.reviewComments,
          selectedPromptEffort: state.agentState.promptEffort,
          selectedModelOptionsForDispatch: state.agentState.modelOptionsForDispatch,
          selectedModelSelection: state.modelSelectionForSend,
          providerAvailable: !state.noAgentAvailable && state.antigravityBlock === null,
          selectedProvider: state.selectedAgent,
          selectedModel: state.selectedModel,
          selectedProviderModels: state.selectedModels,
          interactionMode: state.turnMode,
          interactionModeEnabled: state.planModeUiEnabled,
          attachments: state.attachments,
        };
      },
      validateProviderInput: (agentInput) => {
        const message = getPromptSubmissionValidationMessage({
          prompt: props.promptRef.current,
          providerInput: agentInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = message !== null;
        setProviderInputError(message);
        return message === null;
      },
    }),
    [
      choiceOnlyQuestion,
      compactThreadContext,
      draftActions,
      draftTarget,
      focusState,
      insertPromptText,
      isMultilinePrompt,
      props,
      readPromptSnapshot,
      rejectOversizedPaste,
      settings.composerCollapseOnScroll,
      terminalThreadId,
    ],
  );
  const isModelPickerOpenRef = useRef(isModelPickerOpen);
  isModelPickerOpenRef.current = isModelPickerOpen;

  // ---- drag and drop ----
  const mentionDrag = useMemo(
    () =>
      makePromptMentionDragHandlers({
        onInsertRejected: () =>
          toastManager.add({
            description: "The composer is busy; try again once it is ready.",
            title: "Unable to add to chat",
            type: "error",
          }),
        insertMentionAtEnd: (text) =>
          insertPromptText(text, "end", { ensureLeadingBoundary: true }),
        setDragActive: setDragOver,
      }),
    [insertPromptText],
  );
  useEffect(() => {
    if (!isDragOverPrompt) return;
    const reset = () => setDragOver(false);
    window.addEventListener("dragend", reset);
    return () => window.removeEventListener("dragend", reset);
  }, [isDragOverPrompt]);

  const carriesOsFiles = (event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files") &&
    !dataTransferHasPromptMention(event.dataTransfer.types);
  const handleDragEnterOrOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (isInsideRestingPromptControlScope(event.target)) return;
    if (dataTransferHasPromptMention(event.dataTransfer.types)) {
      if (event.type === "dragenter") mentionDrag.onDragEnter(event as never);
      else mentionDrag.onDragOver(event as never);
      return;
    }
    if (!carriesOsFiles(event)) return;
    event.nativeEvent.stopPropagation();
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (isInsideRestingPromptControlScope(event.target)) return;
    if (!dataTransferHasPromptMention(event.dataTransfer.types) && !carriesOsFiles(event)) return;
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setDragOver(false);
  };
  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    if (isInsideRestingPromptControlScope(event.target)) return;
    if (dataTransferHasPromptMention(event.dataTransfer.types)) {
      mentionDrag.onDrop(event as never);
      return;
    }
    if (!carriesOsFiles(event)) return;
    event.nativeEvent.stopPropagation();
    event.stopPropagation();
    event.preventDefault();
    setDragOver(false);
    void attachFiles(Array.from(event.dataTransfer.files));
  };

  // ---- form-level capture handlers ----
  const onFormPointerDownCapture = (event: React.PointerEvent<HTMLFormElement>) => {
    if (
      isInsideRestingPromptControlScope(event.target) ||
      isInsideCollapsedPromptControls(event.target)
    )
      return;
    const target = event.target as Element | null;
    if (target?.closest(INTERACTIVE_TARGET)) return;
    focusState.setIsComposerScrollCollapsed(false);
  };
  const onFormFocusCapture = (event: React.FocusEvent<HTMLFormElement>) => {
    if (
      isInsideRestingPromptControlScope(event.target) ||
      isInsideCollapsedPromptControls(event.target)
    )
      return;
    focusState.setIsComposerScrollCollapsed(false);
    if (blurFrameRef.current !== null) {
      cancelAnimationFrame(blurFrameRef.current);
      blurFrameRef.current = null;
    }
    focusState.setIsComposerFocused(true);
  };

  // ---- banners ----
  const trustItems = useFolderTrustBannerItems({ hostId, cwd: gitCwd, isAssistantLane });
  const allBannerItems = useMemo<PromptBannerStackItem[]>(
    () => [...trustItems, ...props.bannerItems, ...swarmBannerItems],
    [trustItems, props.bannerItems, swarmBannerItems],
  );
  const hasBannerItems = allBannerItems.length > 0;
  const hasTasks = tasksProgress !== null && taskSteps !== null && taskSteps.length > 0;
  const blockingDrawer = pendingApproval !== null || hasPendingQuestion;
  const activityItem = useMemo<PromptBannerStackItem | null>(() => {
    if (!hasBannerItems) return null;
    if (threadSyncPhase) {
      return {
        title: <PromptActivityRow phase={threadSyncPhase} />,
        id: "composer-activity",
        priority: "activity",
        variant: "default",
        icon: null,
      };
    }
    if (!blockingDrawer && hasTasks && tasksProgress && taskSteps) {
      return {
        title: (
          <PromptTasksContent
            expanded={tasksDrawerOpen}
            onToggle={() => setTasksDrawerOpen((open) => !open)}
            progress={tasksProgress}
            steps={taskSteps}
          />
        ),
        id: "composer-activity",
        priority: "activity",
        variant: "default",
        icon: null,
      };
    }
    return null;
  }, [
    hasBannerItems,
    threadSyncPhase,
    blockingDrawer,
    hasTasks,
    tasksProgress,
    taskSteps,
    tasksDrawerOpen,
  ]);
  const stackItems = useMemo(
    () => (activityItem ? [activityItem, ...allBannerItems] : allBannerItems),
    [activityItem, allBannerItems],
  );
  const inlineTasksBadge =
    hasTasks && !tasksDrawerOpen && !blockingDrawer && (hasBannerItems || topDrawerShown);
  const showTasksTab = !hasBannerItems && !topDrawerShown && !tasksDrawerOpen && hasTasks;

  // ---- derived chrome ----
  const hasSubmissionError = promptSubmissionError !== null || providerInputError !== null;
  const hostUnavailable = props.hostUnavailable;
  void hostUnavailable;
  void isMultilinePrompt;
  const unavailable =
    agentUnavailable || props.projectSelectionRequired || hostUnavailable !== null;

  // ---- placeholder ----
  const placeholder = (() => {
    if (pendingApproval)
      return pendingApproval.detail ?? "Resolve this approval request to continue";
    if (choiceOnlyQuestion) return "Choose an option above";
    if (activeQuestion)
      return "Type your own answer, or leave this blank to use the selected option";
    if (props.offerPlanFollowUp)
      return "Add feedback to refine the plan, or leave this blank to implement it";
    if (hostReconnecting) return "Reconnecting to Kora…";
    if (props.projectSelectionRequired) return "Choose a project above to start a chat";
    if (agentUnavailable) return "Turn on an agent in Settings › Agents to send";
    if (isAssistantLane) {
      if (groupThread)
        return `Message #${groupThread.group.name}. @mention someone to call them in.`;
      if (props.blobPersona)
        return blobPromptPlaceholder(props.blobPersona, props.isDraftHeroState === true);
      return props.isDraftHeroState ? "Ask anything, or give Kora a goal…" : "Reply…";
    }
    // A stopped session restarts on the next send, so an existing chat keeps the follow-up hint;
    // the greeting is for a new chat only.
    if (props.isDraftHeroState) return "Let's build something";
    return "Ask a follow-up, or say what to change…";
  })();

  const editorValue = pendingApproval ? "" : activeQuestion ? questionCustomAnswer : prompt;
  const editorDisabled =
    isConnecting ||
    pendingApproval !== null ||
    props.projectSelectionRequired ||
    choiceOnlyQuestion ||
    props.activePendingIsResponding;

  // The typing sprite sits on the Code composer's top edge while the draft has text. It is hidden outright in a
  // blob's lane or when something already sits on that edge (banners, drawers, the tasks tab); a composer that stops
  // taking input (disabled, sending) keeps it, sitting idle, until the draft empties.
  const typingSpriteHidden =
    unavailable ||
    isAssistantLane ||
    stackItems.length > 0 ||
    Boolean(threadSyncPhase) ||
    Boolean(inlineTasksBadge) ||
    topDrawerShown ||
    (tasksDrawerOpen && hasTasks) ||
    showTasksTab;
  const typingSpriteEnabled = !editorDisabled && !isSendBusy;
  const typingSpriteHasText = editorValue.length > 0;

  // ---- footer pieces ----
  const planToggle = (
    <PromptFooterModeControls
      showInteractionModeToggle={planModeUiEnabled}
      interactionMode={turnMode}
      compact={footerCompact}
      onToggleInteractionMode={props.toggleInteractionMode}
    />
  );

  const modelControl: ReactNode = groupThread ? null : agentUnavailable ? (
    <Button
      variant="ghost"
      size="sm"
      data-agent-unavailable="true"
      disabled={!agentSetupInstanceId}
      className="gap-2 px-2 text-secondary-label sm:px-3"
      onClick={() => {
        if (agentSetupInstanceId) props.onOpenProviderSetup(agentSetupInstanceId);
      }}
    >
      <CircleAlertIcon aria-hidden className="size-4" />
      {agentSetupInstanceId ? "Open provider settings" : "No provider available"}
    </Button>
  ) : (
    <AgentModelPicker
      activeInstanceId={selectedInstanceId}
      model={selectedModel}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={selection.lockedContinuationGroupKey}
      instanceEntries={entries.length > 0 ? entries : EMPTY_ENTRIES}
      modelOptionsByInstance={modelOptionsByInstance}
      {...(agentState.modelPickerIconClassName
        ? { activeProviderIconClassName: agentState.modelPickerIconClassName }
        : {})}
      instanceIndicatorBackground="var(--contrast-input)"
      size="sm"
      isComposerOwned
      disabled={!providerCatalogKnown}
      open={isModelPickerOpen}
      onOpenChange={setIsModelPickerOpen}
      onOpenProviderSetup={props.onOpenProviderSetup}
      whyModelDisabled={props.whyModelDisabled}
      onInstanceModelChange={props.onProviderModelSelect}
      traits={traitsInput}
    />
  );
  const permissionControl: ReactNode =
    groupThread || agentUnavailable ? null : (
      <PermissionPicker
        driverKind={selectedEntry?.driverKind}
        mode={props.runtimeMode}
        onChange={props.handleRuntimeModeChange}
        disabled={!providerCatalogKnown}
        compact={footerCompact}
        {...(blobThread ? { blob: true } : {})}
      />
    );

  const pendingAction =
    activeQuestion && props.activePendingProgress
      ? {
          questionIndex: props.activePendingProgress.questionIndex,
          isLastQuestion: props.activePendingProgress.isLastQuestion,
          canAdvance: props.activePendingProgress.canAdvance,
          isResponding: props.activePendingIsResponding,
          isComplete: props.activePendingResolvedAnswers !== null,
        }
      : null;
  const compactActions = primaryActionsCompact;
  const primaryActions = (
    <PromptFooterPrimaryActions
      actions={{
        compact: compactActions,
        pendingAction,
        isRunning: phase === "running",
        offerPlanFollowUp: props.offerPlanFollowUp && !hasPendingQuestion,
        promptHasText: prompt.trim().length > 0,
        isSendBusy,
        sendDisabledReason,
        isConnecting,
        isHostUnavailable:
          hostUnavailable !== null || noAgentAvailable || props.projectSelectionRequired,
        hasSendableContent,
        preserveComposerFocusOnPointerDown: false,
        onPreviousPendingQuestion: props.onPreviousActivePendingUserInputQuestion,
        onInterrupt: props.onInterrupt,
        onImplementPlanInNewThread: props.onImplementPlanInNewThread,
      }}
    />
  );

  // ---- render ----
  const editorMinHeight = props.isDraftHeroState ? "min-h-24" : "min-h-12";

  return (
    <form
      ref={formRef}
      data-prompt-form="true"
      className="mx-auto w-full max-w-3xl min-w-0"
      onSubmit={(event: FormEvent<HTMLFormElement>) => submitPrompt(event)}
      onPointerDownCapture={onFormPointerDownCapture}
      onFocusCapture={onFormFocusCapture}
      onDragEnterCapture={handleDragEnterOrOver}
      onDragOverCapture={handleDragEnterOrOver}
      onDragLeaveCapture={handleDragLeave}
      onDropCapture={handleDrop}
    >
      <PromptBanner.Dock>
        <PromptBanner.Column>
          <PromptBannerStack key={targetKey} className="relative z-0" items={stackItems} />
          {!activityItem && (threadSyncPhase || inlineTasksBadge) ? (
            <PromptBanner.Attachment>
              <PromptBanner.Root data-prompt-activity-strip="true">
                {threadSyncPhase ? (
                  <PromptActivityRow phase={threadSyncPhase} />
                ) : tasksProgress && taskSteps ? (
                  <PromptTasksBadge
                    placement="inline"
                    expanded={false}
                    onToggle={() => setTasksDrawerOpen(true)}
                    progress={tasksProgress}
                    steps={taskSteps}
                  />
                ) : null}
              </PromptBanner.Root>
            </PromptBanner.Attachment>
          ) : null}
          {topDrawerShown && (!tasksDrawerOpen || blockingDrawer) ? (
            <PromptBanner.Attachment>
              <PromptBanner.Root
                data-prompt-top-drawer="true"
                variant={pendingApproval ? "warning" : "info"}
              >
                {pendingApproval ? (
                  <PromptBanner.Row layout="wrap-actions" data-prompt-collapsed-controls="true">
                    <PromptBanner.Icon>
                      <CircleAlertIcon />
                    </PromptBanner.Icon>
                    <PromptBanner.Content>
                      <PromptPendingApprovalPanel
                        approval={pendingApproval}
                        pendingCount={props.pendingApprovals.length}
                      />
                    </PromptBanner.Content>
                    <PromptBanner.Actions>
                      <ApprovalButtons
                        requestId={pendingApproval.requestId}
                        busy={props.respondingRequestIds.includes(pendingApproval.requestId)}
                        choices={pendingApproval.options}
                        onDecide={props.onRespondToApproval}
                      />
                    </PromptBanner.Actions>
                  </PromptBanner.Row>
                ) : hasPendingQuestion ? (
                  <PromptPendingUserInputPanel
                    pendingUserInputs={props.pendingUserInputs}
                    respondingRequestIds={
                      props.activePendingIsResponding && questionRequestId
                        ? [...props.respondingRequestIds, questionRequestId]
                        : props.respondingRequestIds
                    }
                    answers={props.activePendingDraftAnswers}
                    questionIndex={props.activePendingQuestionIndex}
                    onToggleOption={props.onSelectActivePendingUserInputOption}
                    onAdvance={props.onAdvanceActivePendingUserInput}
                    onDismiss={props.onDismissActivePendingUserInput}
                  />
                ) : props.activeProposedPlan ? (
                  <PromptPlanFollowUpBanner
                    key={props.activeProposedPlan.id}
                    planTitle={planTitleOf(props.activeProposedPlan.planMarkdown)}
                  />
                ) : null}
              </PromptBanner.Root>
            </PromptBanner.Attachment>
          ) : null}
          {!activityItem &&
          tasksDrawerOpen &&
          !blockingDrawer &&
          hasTasks &&
          tasksProgress &&
          taskSteps ? (
            <PromptTasksDrawer
              onCollapse={() => setTasksDrawerOpen(false)}
              progress={tasksProgress}
              steps={taskSteps}
            />
          ) : null}
          {showTasksTab && tasksProgress && taskSteps ? (
            <PromptBanner.Attachment>
              <PromptTasksBadge
                placement="tab"
                expanded={false}
                onToggle={() => setTasksDrawerOpen(true)}
                progress={tasksProgress}
                steps={taskSteps}
              />
            </PromptBanner.Attachment>
          ) : null}
        </PromptBanner.Column>
      </PromptBanner.Dock>

      <div className="relative">
        <ComposerTypingSprite
          enabled={typingSpriteEnabled}
          hasText={typingSpriteHasText}
          hidden={typingSpriteHidden}
        />
        <PromptSurface.Main ref={surfaceRef} className={agentState.composerFrameClassName}>
          <div
            data-prompt-surface="true"
            className={cn(
              "rounded-[calc(var(--radius-lg)-1px)] transition-colors duration-200",
              isDragOverPrompt && "bg-accent/45 ring-1 ring-primary/70",
              props.projectSelectionRequired && "opacity-75",
              agentState.composerSurfaceClassName,
            )}
          >
            <div
              ref={setMenuAnchor}
              data-prompt-body="true"
              className={cn(
                "relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4",
                pendingApproval && "pb-3 sm:pb-4",
              )}
            >
              {menuOpen && !pendingApproval ? (
                <PromptCommandMenuLayer anchor={menuAnchor}>
                  <PromptCommandMenu
                    items={menuItems}
                    resolvedTheme={props.resolvedTheme}
                    isLoading={menuLoading}
                    triggerKind={triggerKind}
                    emptyStateText={menuEmptyText}
                    activeItemId={activeItemId}
                    onHighlightedItemChange={(id) => {
                      setHighlightedItemId(id);
                      setHighlightedSearchKey(searchKey);
                    }}
                    onSelect={onSelectPromptItem}
                  />
                </PromptCommandMenuLayer>
              ) : null}
              <PromptAttachmentTray
                attachments={attachments}
                onRemove={(id) => removeAttachment(draftTarget, id)}
              />
              <div className="relative">
                <ContextChipActionsContext value={chipActions}>
                  <ContextChipRecordsContext value={chipRecords}>
                    <PromptEditor
                      value={editorValue}
                      cursor={cursor}
                      contextRecords={chipRecords}
                      buildContextClipboardFragment={buildContextClipboardFragment}
                      importContextFragment={importContextFragment}
                      skills={agentSkills}
                      disabled={editorDisabled}
                      placeholder={placeholder}
                      containerClassName={editorMinHeight}
                      onChange={onPromptChange}
                      onVisibleSelectionChange={expandPromptForEditorChange}
                      onCommandKeyDown={onPromptCommandKey}
                      onPageScrollKeyDown={props.onPageScrollKeyDown}
                      onPageScrollKeyUp={props.onPageScrollKeyUp}
                      onPageScrollRelease={props.onPageScrollRelease}
                      onPaste={onPromptPaste}
                      editorRef={editorRef}
                    />
                  </ContextChipRecordsContext>
                </ContextChipActionsContext>
              </div>
              <PromptLengthValidation message={providerInputError ?? promptSubmissionError} />
              {sendDisabledReason !== null && (hasSendableContent || blockedFlash > 0) ? (
                <p
                  className={cn(
                    "px-3 pb-2 text-xs transition-colors sm:px-4",
                    blockedFlash > 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                  data-prompt-send-blocked=""
                  role="status"
                >
                  {sendDisabledReason}
                </p>
              ) : null}
            </div>

            {pendingApproval ? null : (
              <div
                data-prompt-footer="true"
                data-prompt-footer-compact={footerCompact ? "true" : "false"}
                className={cn(
                  "flex flex-nowrap items-center justify-between overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                  hasPendingQuestion && "pt-2",
                  footerCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                )}
              >
                <div
                  ref={footerControlsRef}
                  data-prompt-controls="left"
                  data-prompt-footer-controls=""
                  className={cn(
                    "-mx-1 -my-1 -ml-3.5 flex min-w-0 items-center gap-1 overflow-x-auto py-1 pr-1 pl-3.5 [scrollbar-width:none]",
                    footerCompact ? "flex-none" : "flex-1",
                  )}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    data-prompt-attach-input=""
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      void attachFiles(files);
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          className="size-8 shrink-0 bg-foreground/5 p-0 sm:size-8"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={attachDisabled}
                          aria-label="Attach files"
                          variant="ghost-muted"
                          data-prompt-attach=""
                          size="icon-sm"
                          type="button"
                        />
                      }
                    >
                      <PaperclipIcon className="size-4" aria-hidden />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Attach files</TooltipPopup>
                  </Tooltip>
                  {isAssistantLane ? null : (
                    <PromptSwarmToggle
                      agentMode={agentMode}
                      swarmAvailability={swarmAvailability}
                      swarmThreadRef={swarmThreadRef}
                      onAgentModeChange={handleAgentModeSelect}
                      onSetUpGit={setUpGit}
                      compact={footerCompact}
                    />
                  )}
                  {planToggle}
                </div>
                <div
                  data-prompt-actions="right"
                  data-prompt-transition-actions=""
                  data-prompt-primary-actions-compact={primaryActionsCompact ? "true" : "false"}
                  className="flex min-w-0 flex-nowrap items-center justify-end gap-2"
                >
                  {modelControl}
                  {permissionControl}
                  {blobThread ? null : (
                    <ComposerUsageSign
                      context={
                        contextWindow
                          ? {
                              usage: contextWindow,
                              modelDisplayName: contextWindowModelName,
                              onCompact: manualCompaction ? compactThreadContext : undefined,
                              compactDisabled:
                                props.compactDisabled ||
                                noAgentAvailable ||
                                isSendBusy ||
                                isConnecting,
                              compactDisabledReason,
                            }
                          : null
                      }
                      driver={selectedStatus?.driver}
                      model={selectedModel}
                      limits={selectedStatus?.usageLimits}
                      providers={providerStatuses}
                      httpBaseUrl={hostHttpBaseUrl}
                      onOpenUsage={props.onUsageLimitsCommand}
                      threadId={terminalThreadId}
                    />
                  )}
                  <div className="flex shrink-0 items-center gap-2">{primaryActions}</div>
                </div>
              </div>
            )}
          </div>
        </PromptSurface.Main>
      </div>
    </form>
  );
});

// ---------------------------------------------------------------------------
// Draft record helpers

import {
  reviewCommentContextRecord,
  terminalExcerptRecord,
  terminalExcerptReference,
  webMarkupContextRecord,
} from "../../util/contextChipRecords";

function terminalReferenceId(context: TerminalExcerptDraft): string {
  return terminalExcerptReference(context).contextId;
}
function terminalReferenceOf(context: TerminalExcerptDraft) {
  return terminalExcerptReference(context);
}
function terminalRecordOf(context: TerminalExcerptDraft): ContextChipRecord {
  return terminalExcerptRecord(context);
}
function reviewRecordOf(comment: ReturnType<typeof reviewCommentFromRecord>): ContextChipRecord {
  return reviewCommentContextRecord(comment);
}
function markupRecordOf(annotation: WebMarkupPayload): ContextChipRecord {
  return webMarkupContextRecord(annotation);
}

function draftRecordsFor(draft: {
  terminalContexts: TerminalExcerptDraft[];
  reviewComments: Array<ReturnType<typeof reviewCommentFromRecord>>;
  previewAnnotations: WebMarkupPayload[];
}): ContextChipRecord[] {
  return [
    ...draft.terminalContexts.map(terminalRecordOf),
    ...draft.reviewComments.map(reviewRecordOf),
    ...draft.previewAnnotations.map(markupRecordOf),
  ];
}

function remintContextId(kind: string, fresh: string): never {
  return `${kind}_${fresh}`.replace(/[^a-z0-9_-]/gi, "-").slice(0, 128) as never;
}

function planTitleOf(markdown: string): string | null {
  const heading = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(markdown);
  return heading?.[1]?.trim() || null;
}

// Referenced so unused-label helpers stay type-checked.
void threadLoadLabel;
void hostThreadRef;
void canonicalModelSlug;
export type { TerminalReference, WorkLogEntry };

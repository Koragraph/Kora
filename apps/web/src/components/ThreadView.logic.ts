import { koraAtomRegistry } from "../wire/atomRegistry";
import { filterTerminalExcerptsWithText, type TerminalExcerptDraft } from "../util/terminalContext";
import { stripInlineContextLinks } from "../util/contextChipReferences";
import { type SessionPhase, type ChatMessage, type ThreadShell, type Thread } from "../types";
import type { TranscriptItem } from "../thread/timeline";
import type { ReviewCommentContext } from "../thread/reviewCommentContext";
import type { ShellWebOverlay } from "../stores/webStateStore";
import type { DraftThreadEnvMode, DraftThreadState } from "../stores/promptDraftStore";
import type { DockSurface } from "../stores/dockStore";
import type { PromptSubmissionIntent } from "../prompt-logic";
import { collapseExpandedPromptCursor } from "../prompt-logic";
import { hostThreadDetails } from "../atoms/threads";
import {
  resolveSelectableAgentProfileEntry,
  NO_AGENT_MODEL_PICK,
  type AgentProfileEntry,
} from "../agentProfiles";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type WebMarkupPayload,
  type HostThreadRef,
  type AgentProfileId,
  type AgentTurnMode,
  type AgentStatus,
  type ModelPick,
  isAgentId,
  type ThreadId,
  type AgentId,
  type HostId,
  type ItemId,
  type TurnId,
} from "@kora/contracts";
import { parseHostThreadKey } from "@kora/client-runtime/host";
import {
  codexArtifactTemplateUsePrompt,
  appendCodexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@kora/client-runtime/codex/artifact-templates";
import { terminalAppName } from "../util/utils";

/** How long a host may be unreachable before the reconnect warning shows. */
export const HOST_RECONNECT_WARNING_GRACE_MS = 2 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Browser surfaces and template prompts
// ---------------------------------------------------------------------------------------------------------------

type OverlayByTab = Readonly<Record<string, Pick<ShellWebOverlay, "controller"> | undefined>>;

/**
 * The confirmation to show before closing previews the agent is driving ("Close browser while the agent is using
 * it?" and why), or null when it drives none of them.
 */
export function agentControlledBrowserCloseConfirmation(
  surfaces: readonly DockSurface[],
  overlays: OverlayByTab,
): string | null {
  const driven = surfaces.filter(
    (s) => s.kind === "preview" && s.resourceId && overlays[s.resourceId]?.controller === "agent",
  ).length;
  if (driven === 0) return null;
  const one = driven === 1;
  const question = one
    ? "Close browser while the agent is using it?"
    : `Close ${driven} browsers while the agent is using them?`;
  const why = one
    ? "The agent is actively controlling this browser. Closing it may interrupt the current browser action."
    : "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.";
  return `${question}\n${why}`;
}

export function codexArtifactTemplatePromptToAppend(
  draftText: string,
  template: CodexArtifactTemplate,
): string | null {
  const unchanged = appendCodexArtifactTemplateUsePrompt(draftText, template) === draftText;
  return unchanged ? null : codexArtifactTemplateUsePrompt(template);
}

// ---------------------------------------------------------------------------------------------------------------
// Draft hero and transcript anchoring
// ---------------------------------------------------------------------------------------------------------------

export function shouldDockDraftHeroForSubmission(input: {
  submissionIntent: PromptSubmissionIntent;
  activeThreadKey: string | null;
  isDraftHeroState: boolean;
}): boolean {
  if (input.submissionIntent !== "foreground") return false;
  return input.isDraftHeroState && input.activeThreadKey !== null;
}

export function shouldReleaseTranscriptAnchorForToolActivity(input: {
  anchorMessageId: ItemId | null;
  liveFollowEnabled: boolean;
  runningTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TranscriptItem>;
}): boolean {
  if (!input.anchorMessageId || !input.liveFollowEnabled || !input.runningTurnId) return false;
  return input.timelineEntries.some((item) => {
    if (item.kind !== "work" || item.entry.turnId !== input.runningTurnId) return false;
    const { entry } = item;
    const hasCommand = entry.command !== undefined && entry.command.trim() !== "";
    return (
      hasCommand ||
      entry.requestKind !== undefined ||
      entry.itemType !== undefined ||
      entry.tone === "tool"
    );
  });
}

/** An inner scroll area of a tool group scrolls up before the transcript's own navigation may. */
export function toolGroupConsumesUpwardNavigation(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest("[data-tool-group-scroll]") === null) return false;
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    if (node.closest("[data-tool-group-scroll]") === node) break;
  }
  return false;
}

/** Whether a new draft shows the big centred composer: until the thread has content, unless it was docked. */
export function resolveDraftHeroState(state: {
  backgroundSubmissionPending: boolean;
  isLocalDraftThread: boolean;
  draftHeroDockRequested: boolean;
  isWorking: boolean;
  hasTimelineEntries: boolean;
}): boolean {
  const { backgroundSubmissionPending, isLocalDraftThread, draftHeroDockRequested } = state;
  const hasContent = state.isWorking || state.hasTimelineEntries;
  return (
    backgroundSubmissionPending || (!hasContent && isLocalDraftThread && !draftHeroDockRequested)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Held transcripts. Module-level memory survives ThreadView remounts so rapid thread jumps keep painting content.
// ---------------------------------------------------------------------------------------------------------------

export type HeldThreadTranscript<T extends readonly unknown[]> = {
  workspaceRoot?: string | null;
  markdownCwd?: string | null;
  threadKey: string | null;
  entries: T;
};

const REMEMBERED_TRANSCRIPT_LIMIT = 16;
const rememberedTranscripts = new Map<string, HeldThreadTranscript<readonly unknown[]>>();
let lastReadyTranscript: HeldThreadTranscript<readonly unknown[]> | null = null;

export function rememberReadyThreadTranscript<T extends readonly unknown[]>(
  held: HeldThreadTranscript<T>,
): void {
  if (held.threadKey === null || held.entries.length === 0) return;
  rememberedTranscripts.delete(held.threadKey);
  rememberedTranscripts.set(held.threadKey, held);
  while (rememberedTranscripts.size > REMEMBERED_TRANSCRIPT_LIMIT) {
    const oldest = rememberedTranscripts.keys().next().value;
    if (oldest === undefined) break;
    rememberedTranscripts.delete(oldest);
  }
  lastReadyTranscript = held;
}

export function peekRememberedThreadTranscript<T extends readonly unknown[]>(
  threadKey: string | null,
): T | null {
  if (threadKey === null) return null;
  return (rememberedTranscripts.get(threadKey)?.entries as T | undefined) ?? null;
}

export function peekHeldThreadTranscript<
  T extends readonly unknown[],
>(): HeldThreadTranscript<T> | null {
  return lastReadyTranscript && lastReadyTranscript.entries.length > 0
    ? (lastReadyTranscript as HeldThreadTranscript<T>)
    : null;
}

export function isPaintOnlyThreadTranscript(
  shownThreadKey: string | null,
  currentThreadKey: string | null,
): boolean {
  if (shownThreadKey === null || currentThreadKey === null) return false;
  return shownThreadKey !== currentThreadKey;
}

export function resolveThreadSwitchTranscript<T extends readonly unknown[]>(input: {
  lastReady?: HeldThreadTranscript<T> | null;
  rememberedForActive?: T | null;
  activeThreadKey: string | null;
  loading: boolean;
  nextEntries: T;
}): { entries: T; displayThreadKey: string | null } {
  const { activeThreadKey, nextEntries } = input;
  if (nextEntries.length > 0) return { entries: nextEntries, displayThreadKey: activeThreadKey };

  if (input.loading) {
    const remembered =
      input.rememberedForActive ?? peekRememberedThreadTranscript<T>(activeThreadKey);
    if (remembered && remembered.length > 0) {
      return { entries: remembered, displayThreadKey: activeThreadKey };
    }

    const lastReady = input.lastReady ?? peekHeldThreadTranscript<T>();
    if (
      lastReady &&
      lastReady.threadKey !== null &&
      lastReady.threadKey !== activeThreadKey &&
      lastReady.entries.length > 0 &&
      activeThreadKey !== null
    ) {
      // Only a paint fallback, and only within one host: another host's thread must never flash through.
      const held = parseHostThreadKey(lastReady.threadKey);
      const active = parseHostThreadKey(activeThreadKey);
      if (held && active && held.hostId === active.hostId) {
        return { entries: lastReady.entries, displayThreadKey: lastReady.threadKey };
      }
    }
  }
  return { entries: nextEntries, displayThreadKey: activeThreadKey };
}

const ENDED_SESSION = new Set(["error", "stopped", "interrupted"]);

/**
 * Where to go once a draft's thread exists on the daemon: the thread itself, as soon as there is something to see
 * there (a started turn, a stored user message, or a session that already ended). Not while a background send runs.
 */
export function resolveDraftPromotionNavigationTarget({
  backgroundSubmissionPending,
  serverThread: thread,
  serverThreadRef: ref,
}: {
  backgroundSubmissionPending: boolean;
  serverThread: Pick<Thread, "latestTurn" | "session" | "messages"> | null | undefined;
  serverThreadRef: HostThreadRef | null;
}): HostThreadRef | null {
  if (backgroundSubmissionPending || !ref || !thread) return null;
  const somethingToSee =
    thread.latestTurn?.startedAt != null ||
    ENDED_SESSION.has(thread.session?.status ?? "") ||
    thread.messages.some((m) => m.role === "user");
  return somethingToSee ? ref : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Host reconnect warning
// ---------------------------------------------------------------------------------------------------------------

export function scheduleHostReconnectWarning(showWarning: () => void): () => void {
  const timer = setTimeout(showWarning, HOST_RECONNECT_WARNING_GRACE_MS);
  return () => clearTimeout(timer);
}

export function hasHostReconnectWarningGraceElapsed(
  activeHostId: HostId | null,
  elapsedHostId: HostId | null,
): boolean {
  return activeHostId !== null && activeHostId === elapsedHostId;
}

// ---------------------------------------------------------------------------------------------------------------
// Thread construction and metadata
// ---------------------------------------------------------------------------------------------------------------

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelPick;
  nextModelSelection?: ModelPick;
  currentBranch: string | null;
  nextBranch?: string;
}): { modelSelection?: ModelPick; branch?: string; worktreePath?: null } | null {
  const { currentModelSelection: current, nextModelSelection: next } = input;
  const modelChanged =
    next !== undefined &&
    (next.model !== current.model ||
      next.instanceId !== current.instanceId ||
      JSON.stringify(next.options ?? null) !== JSON.stringify(current.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelChanged && !branchChanged) return null;
  return {
    ...(modelChanged ? { modelSelection: next } : {}),
    ...(branchChanged ? { worktreePath: null, branch: input.nextBranch } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draft: DraftThreadState,
  fallbackModelPick: ModelPick,
): Thread {
  return {
    interactionMode: draft.interactionMode,
    worktreePath: draft.worktreePath,
    runtimeMode: draft.runtimeMode,
    modelSelection: fallbackModelPick,
    updatedAt: draft.createdAt,
    projectId: draft.projectId,
    createdAt: draft.createdAt,
    hostId: draft.hostId,
    branch: draft.branch,
    settledOverride: null,
    title: "New chat",
    proposedPlans: [],
    agentMode: "chat",
    pullRequests: [],
    latestTurn: null,
    archivedAt: null,
    settledAt: null,
    deletedAt: null,
    checkpoints: [],
    activities: [],
    session: null,
    messages: [],
    id: threadId,
  } as unknown as Thread;
}

/** A thread to render from its sidebar shell while the full thread loads: no content yet. */
export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  const lists = ["messages", "activities", "proposedPlans", "checkpoints"].map((key) => [key, []]);
  return { ...shell, ...Object.fromEntries(lists), deletedAt: null } as unknown as Thread;
}

export function shouldWriteThreadErrorToCurrentDaemonThread(input: {
  targetThreadId: ThreadId;
  routeThreadRef: HostThreadRef;
  activeServerThread: { hostId: HostId; id: ThreadId } | null | undefined;
}): boolean {
  const active = input.activeServerThread;
  return (
    !!active &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    active.hostId === input.routeThreadRef.hostId &&
    active.id === input.targetThreadId
  );
}

type InterruptTarget = { threadId: ThreadId; turnId?: TurnId };

/** What Stop interrupts: the thread, and its running turn when there is one. */
export function buildThreadTurnInterruptInput({
  id,
  session,
}: Pick<Thread, "id" | "session">): InterruptTarget {
  const runningTurn = session?.status === "running" ? session.activeTurnId : null;
  return runningTurn ? { threadId: id, turnId: runningTurn } : { threadId: id };
}

/** The same, but only while the thread really is running (else Stop has nothing to do). */
export const buildRunningThreadTurnInterruptInput = (
  thread: Pick<Thread, "id" | "session"> | null | undefined,
  phase: SessionPhase,
): InterruptTarget | null =>
  thread && phase === "running" && thread.session?.status === "running"
    ? buildThreadTurnInterruptInput(thread)
    : null;

// ---------------------------------------------------------------------------------------------------------------
// Agent selection for the composer
// ---------------------------------------------------------------------------------------------------------------

export function resolvePromptAgentSelection(input: {
  entries: ReadonlyArray<AgentProfileEntry>;
  candidateInstanceIds: ReadonlyArray<AgentProfileId | null | undefined>;
  lockedProvider: AgentId | null;
  lockedInstanceId: AgentProfileId | null | undefined;
}): {
  selectedProviderEntry: AgentProfileEntry | undefined;
  requestedDriverKind: AgentId;
  lockedContinuationGroupKey: string | null;
  unavailableProviderInstanceId: AgentProfileId | undefined;
} {
  const { entries, lockedProvider, lockedInstanceId } = input;
  const candidates = input.candidateInstanceIds.filter(
    (id): id is AgentProfileId => id != null && id !== NO_AGENT_MODEL_PICK.instanceId,
  );
  const requestedInstanceId = candidates[0];
  const requestedEntry = entries.find((entry) => entry.instanceId === requestedInstanceId);
  const requestedDriverKind: AgentId =
    lockedProvider ??
    requestedEntry?.driverKind ??
    entries[0]?.driverKind ??
    ("unconfigured" as AgentId);

  const lockedEntry = lockedProvider
    ? entries.find((entry) => entry.instanceId === lockedInstanceId)
    : undefined;
  const lockedContinuationGroupKey = lockedProvider
    ? (lockedEntry?.continuationGroupKey ?? null)
    : null;
  // Missing continuation metadata must not move Antigravity history into a different Google profile.
  const requiresExactInstance =
    lockedProvider === "antigravity" && !!lockedInstanceId && lockedContinuationGroupKey === null;

  const compatible = entries.filter(
    (entry) =>
      (!lockedProvider || entry.driverKind === lockedProvider) &&
      (lockedContinuationGroupKey === null ||
        entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === lockedInstanceId),
  );

  const usable = (entry: AgentProfileEntry) => entry.enabled && entry.isAvailable;
  const selectedProviderEntry =
    candidates
      .map((id) => compatible.find((entry) => entry.instanceId === id))
      .find((entry): entry is AgentProfileEntry => entry !== undefined && usable(entry)) ??
    resolveSelectableAgentProfileEntry(
      compatible.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableAgentProfileEntry(compatible, undefined);

  return {
    unavailableProviderInstanceId: selectedProviderEntry
      ? undefined
      : lockedProvider
        ? (lockedInstanceId ?? requestedInstanceId)
        : requestedInstanceId,
    lockedContinuationGroupKey,
    selectedProviderEntry,
    requestedDriverKind,
  };
}

export function resolvePromptTurnMode(input: {
  planModeEnabled: boolean;
  provider: Pick<AgentStatus, "showInteractionModeToggle"> | null | undefined;
  interactionMode: AgentTurnMode;
}): { enabled: boolean; interactionMode: AgentTurnMode } {
  const enabled =
    input.planModeEnabled && !!input.provider && input.provider.showInteractionModeToggle !== false;
  return { enabled, interactionMode: enabled ? input.interactionMode : "default" };
}

export function getAntigravitySendBlockReason(
  provider:
    | Pick<AgentStatus, "driver" | "installed" | "auth" | "models" | "status">
    | null
    | undefined,
  modelSlug: string,
): string | null {
  if (!provider || provider.driver !== "antigravity") return null;
  if (!provider.installed) return "Install Antigravity (the agy command) before sending.";
  if (provider.auth.status === "unauthenticated")
    return `Sign in to Antigravity (run agy in ${terminalAppName()} once) before sending.`;
  const slug = modelSlug.trim();
  if (slug === "") return "Choose an Antigravity model before sending.";
  // Session startup checks credentials and validates the model itself.
  if (provider.auth.status === "unknown") {
    return null;
  }
  if (provider.models.length === 0) {
    return "Antigravity's models are still loading. Try again in a moment, or press Re-check in Settings › Engines.";
  }
  if (provider.status === "ready" && slug !== ANTIGRAVITY_DEFAULT_MODEL) {
    const known = provider.models.some(
      (candidate) => candidate.slug === slug || candidate.aliases?.includes(slug),
    );
    if (!known) return "That Antigravity model is no longer available. Choose another model.";
  }
  return null;
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  branch: string | null;
}): {
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  branch: string | null;
  worktreePath: null;
} {
  return {
    worktreePath: null,
    branch: input.branch,
    envMode: input.envMode,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Send state
// ---------------------------------------------------------------------------------------------------------------

export function derivePromptSendState(options: {
  terminalContexts: ReadonlyArray<TerminalExcerptDraft>;
  elementContextCount?: number;
  imageCount: number;
  prompt: string;
}): {
  trimmedPrompt: string;
  hasSendableContent: boolean;
  expiredTerminalContextCount: number;
  sendableTerminalContexts: TerminalExcerptDraft[];
} {
  const trimmedPrompt = stripInlineContextLinks(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalExcerptsWithText(options.terminalContexts);
  return {
    expiredTerminalContextCount: options.terminalContexts.length - sendableTerminalContexts.length,
    hasSendableContent:
      (options.elementContextCount ?? 0) > 0 ||
      sendableTerminalContexts.length > 0 ||
      options.imageCount > 0 ||
      trimmedPrompt.length > 0,
    trimmedPrompt,
    sendableTerminalContexts,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "empty" | "omitted",
): { description: string; title: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  return variant === "empty"
    ? {
        description: "Remove it or re-add it to include terminal output.",
        title: `${noun} won't be sent`,
      }
    : {
        description: "Re-add it if you want that terminal output included.",
        title: `${noun} omitted from message`,
      };
}

export function shouldShowPlanFollowUpPrompt(input: {
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
  interactionMode: AgentTurnMode;
  pendingUserInputCount: number;
  latestTurnSettled: boolean;
}): boolean {
  const planReady = input.latestTurnSettled && input.hasActionableProposedPlan;
  const nothingElsePending = input.pendingUserInputCount === 0 && !input.hasComposerAttachments;
  return input.interactionMode === "plan" && planReady && nothingElsePending;
}

// ---------------------------------------------------------------------------------------------------------------
// Thread started / agent lock
// ---------------------------------------------------------------------------------------------------------------

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return (
    !!thread &&
    (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null)
  );
}

/** The sidebar's view of the same question: a turn, a user message or a session exists. */
export const threadShellHasStarted = (
  shell: Pick<ThreadShell, "latestTurn" | "latestUserMessageAt" | "session"> | null | undefined,
): boolean =>
  shell != null &&
  [shell.latestTurn, shell.latestUserMessageAt ?? null, shell.session].some((x) => x !== null);

export function deriveThreadAgentLock(input: {
  threadProvider: string | null;
  selectedProvider: string | null;
  thread: Thread | null | undefined;
  providers: ReadonlyArray<Pick<AgentStatus, "instanceId" | "driver">>;
}): AgentId | null {
  if (!threadHasStarted(input.thread)) return null;
  const sessionProvider = input.thread?.session?.providerName;
  if (sessionProvider && isAgentId(sessionProvider)) return sessionProvider;

  const driverFor = (instance: string | null): AgentId | null => {
    if (!instance) return null;
    const driver =
      input.providers.find((provider) => provider.instanceId === instance)?.driver ?? instance;
    return isAgentId(driver) ? driver : null;
  };
  return driverFor(input.threadProvider) ?? driverFor(input.selectedProvider);
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<AgentStatus, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelPick;
  currentProviderInstanceId?: ModelPick["instanceId"] | null;
  nextModelSelection: ModelPick;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) return null;
  const currentInstance = input.currentProviderInstanceId ?? input.currentModelSelection.instanceId;
  const nextInstance = input.nextModelSelection.instanceId;
  if (
    currentInstance === nextInstance &&
    input.currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const requiresNewThread = [currentInstance, nextInstance].some(
    (instance) =>
      input.providers.find((provider) => provider.instanceId === instance)
        ?.requiresNewThreadForModelChange === true,
  );
  return requiresNewThread
    ? {
        description:
          "This provider does not allow switching models after a conversation has started.",
        title: "Start a new chat to change models",
      }
    : null;
}

export function waitForStartedDaemonThread(
  threadRef: HostThreadRef,
  waitMs = 1_000,
): Promise<boolean> {
  const detailAtom = hostThreadDetails.detailAtom(threadRef);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    const check = () => {
      if (threadHasStarted(koraAtomRegistry.get(detailAtom))) settle(true);
    };
    if (threadHasStarted(koraAtomRegistry.get(detailAtom))) {
      settle(true);
      return;
    }
    timer = setTimeout(() => settle(false), waitMs);
    unsubscribe = koraAtomRegistry.subscribe(detailAtom, (value) => {
      if (threadHasStarted(value)) settle(true);
    });
    check();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Local dispatch acknowledgement
// ---------------------------------------------------------------------------------------------------------------

/** The latest turn's identity and timestamps: any change means the daemon did something with it. */
type TurnMarks = {
  turnId: TurnId | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
const marksOf = (turn: Thread["latestTurn"] | null | undefined): TurnMarks => ({
  turnId: turn?.turnId ?? null,
  requestedAt: turn?.requestedAt ?? null,
  startedAt: turn?.startedAt ?? null,
  completedAt: turn?.completedAt ?? null,
});
const sameMarks = (a: TurnMarks, b: TurnMarks) =>
  a.turnId === b.turnId &&
  a.requestedAt === b.requestedAt &&
  a.startedAt === b.startedAt &&
  a.completedAt === b.completedAt;

/**
 * The thread as it was when the user pressed send, so the composer can tell when the daemon has taken the message
 * (and stop showing "sending").
 */
export interface LocalDispatchSnapshot {
  startedAt: string;
  submissionIntent: PromptSubmissionIntent;
  userMessageId: ChatMessage["id"] | null;
  turn: TurnMarks;
  session: { status: NonNullable<Thread["session"]>["status"] | null; updatedAt: string | null };
  /** A turn-start failure already on record for this message (a new one counts as an answer). */
  startFailureId: string | null;
}

/** The `provider.turn.start.failed` activity for the given user message, newest first, if any. */
export function latestTurnStartFailureId(
  thread: Thread | undefined,
  userMessageId: ChatMessage["id"] | null,
): string | null {
  if (!thread || userMessageId === null) return null;
  const failure = thread.activities.findLast(
    (a) =>
      a.kind === "provider.turn.start.failed" &&
      (a.payload as { requestId?: unknown } | null | undefined)?.requestId === userMessageId,
  );
  return failure?.id ?? null;
}

export function createLocalDispatchSnapshot(
  thread: Thread | undefined,
  options?: { submissionIntent?: PromptSubmissionIntent },
): LocalDispatchSnapshot {
  const userMessageId = thread?.messages.findLast((m) => m.role === "user")?.id ?? null;
  return {
    startedAt: new Date().toISOString(),
    submissionIntent: options?.submissionIntent ?? "foreground",
    userMessageId,
    turn: marksOf(thread?.latestTurn),
    session: {
      status: thread?.session?.status ?? null,
      updatedAt: thread?.session?.updatedAt ?? null,
    },
    startFailureId: latestTurnStartFailureId(thread, userMessageId),
  };
}

/**
 * Has the daemon answered a send? Yes once it asks something (approval, question), errors, or records a new start
 * failure. While a turn runs: once a new user message shows (steering) or a started turn other than the one in
 * the snapshot is the session's own. Otherwise: once the turn or the session changes at all.
 */
export function hasDaemonAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  threadError: string | null | undefined;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  latestTurnStartFailureId?: string | null;
}): boolean {
  const sent = input.localDispatch;
  if (!sent) return false;
  if (input.threadError || input.hasPendingApproval || input.hasPendingUserInput) return true;
  const failure = input.latestTurnStartFailureId ?? null;
  if (failure !== null && failure !== sent.startFailureId) return true;
  if (input.phase === "connecting") return false;

  const { latestTurn: turn, session } = input;
  const turnMoved = !sameMarks(marksOf(turn), sent.turn);
  if (input.phase !== "running") {
    const sessionMoved =
      (session?.status ?? null) !== sent.session.status ||
      (session?.updatedAt ?? null) !== sent.session.updatedAt;
    return turnMoved || sessionMoved;
  }
  // Steering adds a user message without touching the turn.
  if (input.latestUserMessageId !== sent.userMessageId) return true;
  if (!turnMoved || !turn || turn.startedAt === null) return false;
  return !session?.activeTurnId || session.activeTurnId === turn.turnId;
}

const shouldRefocusPromptOnWindowFocusCls1 =
  '[role="dialog"], [role="alertdialog"], [data-slot$="-popup"], [data-terminal-owner]';

// ---------------------------------------------------------------------------------------------------------------
// Focus and plan follow-up
// ---------------------------------------------------------------------------------------------------------------

export function shouldRefocusPromptOnWindowFocus(
  activeElement:
    | (Pick<Element, "getAttribute" | "tagName" | "closest"> & { isContentEditable?: boolean })
    | null,
): boolean {
  if (!activeElement || activeElement.tagName === "BODY") return true;
  if (["INPUT", "TEXTAREA", "SELECT", "IFRAME", "WEBVIEW"].includes(activeElement.tagName))
    return false;
  if (activeElement.isContentEditable || activeElement.getAttribute("role") === "textbox")
    return false;
  return activeElement.closest(shouldRefocusPromptOnWindowFocusCls1) === null;
}

export interface PlanFollowUpPromptSnapshot {
  readonly terminalContexts: ReadonlyArray<TerminalExcerptDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<WebMarkupPayload>;
  readonly prompt: string;
}

export function restorePlanFollowUpPrompt(input: {
  snapshot: PlanFollowUpPromptSnapshot;
  writePrompt: (prompt: string) => void;
  writeTerminalContexts: (contexts: ReadonlyArray<TerminalExcerptDraft>) => void;
  writeReviewComments: (comments: ReadonlyArray<ReviewCommentContext>) => void;
  writePreviewAnnotations: (annotations: ReadonlyArray<WebMarkupPayload>) => void;
  resetCursor: (options: { cursor: number; prompt: string; detectTrigger: boolean }) => void;
}): void {
  const { snapshot } = input;
  // Every field the send cleared is written back; dropping one would silently discard user context.
  input.writePrompt(snapshot.prompt);
  input.writeTerminalContexts(snapshot.terminalContexts);
  input.writeReviewComments(snapshot.reviewComments);
  input.writePreviewAnnotations(snapshot.previewAnnotations);
  input.resetCursor({
    cursor: collapseExpandedPromptCursor(snapshot.prompt, snapshot.prompt.length),
    prompt: snapshot.prompt,
    detectTrigger: true,
  });
}

/** Whether the Claude login card applies: only a thread whose model runs on Claude (never a group, never a free model). */
export function threadNeedsClaudeLogin(input: {
  isGroup: boolean;
  driverKind: AgentId | null | undefined;
}): boolean {
  return !input.isGroup && (input.driverKind ?? "claude") === "claude";
}

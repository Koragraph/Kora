// The kora daemon objects this UI server drives. The server runs INSIDE `kora server run` (loaded from the
// bundle `vp pack` emits into kora/ui/ui-server.cjs) and is handed the daemon's own Runtime + SessionManager —
// one runtime, one pane table, one chat thread store. Typed locally (a structural slice of kora's types) so this
// package's typecheck stays self-contained and never drags kora's source into the program.
import type {
  BlobCardPayload,
  BlobDraft,
  BlobDefaults,
  BlobFlags,
  BlobMemoryScope,
  BlobEngine,
  BlobProfile,
  BlobProfilePatch,
  BlobSkill,
  BlobTemplate,
  JobCardPayload,
  SwarmClearKeyInput,
  SwarmConsentState,
  SwarmInstallCancelInput,
  SwarmInstallStartInput,
  SwarmInstallState,
  SwarmPreferences,
  SwarmProviderStatus,
  SwarmSetConsentInput,
  SwarmSetKeyInput,
  SwarmSetPreferencesInput,
  SwarmStatus,
  SwarmTestProviderInput,
  ThreadAgentMode,
  ThreadOrigin,
  TokenTotals,
} from "@kora/contracts";

import type { KoraRuntimeLike } from "./fleet-service.ts";

export interface KoraThreadInfo {
  id: string;
  title: string;
  agent: string;
  cwd: string;
}
export interface KoraGraph {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { cwd: string; fresh?: boolean },
  ): Promise<{ text: string; data: unknown; ms: number }>;
  /** Indexed-or-not for a cwd; the daemon's worker-threaded graph service. */
  status(cwd: string): Promise<{ indexed: boolean }>;
  /** Index a workspace into the koragraph DB (background with `wait:false`). */
  ingest?: (
    pathArg: string,
    opts?: { project?: string; wait?: boolean; full?: boolean },
  ) => Promise<unknown>;
}
export interface KoraFleetOps {
  list(orchestratorId: string): unknown[];
  prompt(paneId: string, text: string, opts?: unknown): Promise<unknown>;
  wait(paneId: string, until: string, timeoutMs: number): Promise<unknown>;
  read(paneId: string, source: string, lines?: number): string;
  kill(paneId: string): void;
  mergeVerify(paneIds: string[]): Promise<{ pairs: unknown[]; order: string[] }>;
  merge(
    paneId: string,
    opts?: unknown,
  ): Promise<{
    ok: boolean;
    merged: string | null;
    into: string | null;
    conflicts: string[];
    message: string;
    commitsMerged: number;
  }>;
  setPlan(orchestratorId: string, plan: string): void;
  getPlan(orchestratorId: string): string;
  drainNotes?(orchestratorId: string): string[];
}
/** The daemon's `ManagerRuntime` — the seam its SessionManager drives through. We replace `fleet` with a wrapped
 *  FleetOps (so the fleet panel sees what the orchestrator did) before any chat driver is built. */
export interface KoraManagerRuntime {
  notify(method: string, params: unknown): void;
  fleet?: KoraFleetOps;
  socketPath?: string;
  binPath?: string;
}
/** A mode switch the agent has not been told about (runtime `PendingModeNotice`, session/events.ts). */
export interface KoraPendingModeNotice {
  from: ThreadAgentMode;
  to: ThreadAgentMode;
  text: string;
}
export interface KoraSessionManager {
  create(p: {
    agent: string;
    cwd: string;
    account?: string | null;
    model?: { model: string; effort?: string | null };
    title?: string;
    isOrchestrator?: boolean;
    /** Swarm sets the pending notice (from:'chat') and installs the skill (runtime S1). */
    agentMode?: ThreadAgentMode;
  }): KoraThreadInfo;
  setPermissionMode(threadId: string, mode: string): void;
  setOrchestrator(threadId: string, isOrchestrator: boolean): Promise<unknown>;
  /** Persist the mode + the pending notice; restarts the session lazily (pendingRestart), never mid-turn. */
  setAgentMode(
    threadId: string,
    mode: ThreadAgentMode,
  ): Promise<{ thread: KoraThreadInfo; notice: KoraPendingModeNotice | null }>;
  /** The composer changed model / effort: persisted, applied to a live session, restart before the next turn on an effort change. */
  changeModel(threadId: string, model: { model: string; effort?: string | null }): Promise<void>;
  /** Synchronous: returns and clears the pending notice (marks it announced). */
  takeModeNotice(threadId: string): KoraPendingModeNotice | null;
  sendTurn(p: {
    threadId: string;
    text?: string;
    /** Resolved, absolute-path attachments (never a dataUrl) — see kora-chat.ts `resolveAttachments`. */
    attachments?: Array<{ type: "image" | "file"; path: string; mimeType?: string; name?: string }>;
    /** 'kora-notice' = a Kora-sent notice / notes turn (no prompt injection). */
    origin?: "user" | "kora-notice";
    /** A pending mode notice prepended to `text` for the agent only (the bubble shows `text`). */
    koraNotice?: string;
    /** Blobs: where the thread came from (a "from Kora" header for the blob's turn context). */
    blobOrigin?: ThreadOrigin | null;
    /** The composer's Plan/Build toggle: 'plan' puts the harness in its native plan mode. */
    interactionMode?: "default" | "plan";
  }): Promise<{ turnId: string }>;
  interrupt(threadId: string, turnId?: string): Promise<void>;
  /** Stop the thread's session and remove it from the chat store (events, meta, index). */
  delete(threadId: string): Promise<void>;
  /** Mirror the UI's archive into the chat store (meta.json + index), so the CLI lists it as archived too. */
  archive?(threadId: string): void;
  unarchive?(threadId: string): void;
  /** Stop the thread's provider session (its process); the thread stays and resumes on the next turn. */
  stop?(threadId: string): Promise<void>;
  /** B5: is there a compaction of this thread to undo? */
  canUndoCompaction?(threadId: string): boolean;
  /** B5: put the thread back on its transcript from before the chip's /compact (refused while a turn runs). */
  undoCompaction?(threadId: string): Promise<{ ok: boolean; reason?: string }>;
  /** B5: a hand-over brief for a fresh thread, drafted by a side session (Haiku, no tools) from a local digest. */
  threadBrief?(
    threadId: string,
  ): Promise<{ brief: string; source: "side-session" | "digest"; digestTokens: number } | null>;
  /** B17: answer "who calls X / where is X / what breaks if I rename X" from the code graph with no agent turn (null = send it to the agent). */
  quickAnswer?(
    threadId: string,
    text: string,
  ): Promise<{ text: string; kind: string; name: string; approxTokens: number } | null>;
  /** B17: forget the quick answers waiting to ride on the thread's next turn (the user sent the question to the agent anyway). */
  discardQuickNotes?(threadId: string): void;
  /** Point a thread at another folder (the Chat -> Kora migration); copies its Claude transcript beside the new folder. */
  moveThread?(threadId: string, cwd: string): Promise<{ transcriptCopied: boolean }>;
  respondApproval(threadId: string, requestId: string, decision: string): Promise<void>;
  respondUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<void>;
}
/**
 * Swarm setup, in-process: the runtime's `SwarmSetup` (`runtime.swarmSetup`, packages/runtime/src/server/swarm-setup.ts).
 * One method per `SWARM_METHODS` RPC, same verb (ref-reconciled R1); `subscribe` is `onStatus`.
 */
export interface KoraSwarmLike {
  getStatus(opts?: { probe?: boolean }): Promise<SwarmStatus>;
  /** Returns the unsubscribe function. */
  onStatus(fn: (status: SwarmStatus) => void): () => void;
  installStart(input: SwarmInstallStartInput): Promise<SwarmInstallState>;
  installCancel(input: SwarmInstallCancelInput): Promise<SwarmInstallState>;
  setKey(input: SwarmSetKeyInput): Promise<SwarmProviderStatus>;
  clearKey(input: SwarmClearKeyInput): Promise<SwarmProviderStatus>;
  testProvider(input: SwarmTestProviderInput): Promise<SwarmProviderStatus>;
  setConsent(input: SwarmSetConsentInput): Promise<SwarmConsentState>;
  setPreferences(input: SwarmSetPreferencesInput): Promise<SwarmPreferences>;
}

/**
 * Health checks + the redacted diagnostics bundle (runtime `makeUiDoctor`, packages/runtime/src/server/ui.ts;
 * report shape: runtime `server/health.ts` `HealthReport`). Plain JSON over `/api/doctor*`, not an RPC. Optional:
 * an older daemon binds a host without it and the routes answer 404.
 */
export interface KoraDoctorLike {
  run(opts: { cwd?: string | null; only?: string[]; probe?: boolean }): Promise<unknown>;
  exportBundle(opts: {
    cwd?: string | null;
    dir?: string | null;
  }): Promise<{ path: string; bytes: number }>;
}

/** The daemon's `Runtime`: panes + graph + fleet plumbing (the fleet-service slice, plus what the engine touches). */
export type KoraRuntime = KoraRuntimeLike & {
  graph: KoraGraph;
  /** The Codex orchestrator's out-of-process bridge drains this runtime's note queue through it. */
  noteSource: { drain(orchestratorId: string): string[] } | null;
  on(event: "notify", fn: (method: string, params: unknown) => void): unknown;
};

/** One plan window (runtime `UsageWindow`, session/events.ts); `resetsAt` is epoch ms. */
export interface KoraUsageWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
}
/** Runtime `UsageLimitsReport`: a full probe (`complete`) or a sparse turn-time update. */
export interface KoraUsageLimitsReport {
  provider: string;
  windows: KoraUsageWindow[];
  plan?: string;
  limited?: boolean;
  resetsAt?: number;
  complete?: boolean;
}

export interface ClaudeModelInfo {
  value?: unknown;
  displayName?: unknown;
  /** Older SDKs: "Opus 5 with 1M context · Best for everyday tasks" (the version the displayName dropped). Newer
   *  SDKs: just the tagline, with the version in displayName ("Opus 5.5"). */
  description?: unknown;
  /** Newer SDKs: what an alias row runs, e.g. "default" → "claude-sonnet-5-5". */
  resolvedModel?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
}

// ── Blobs (docs/bots/ARCH.md sections 3 and 4) ─────────────────────────────────────────────────────────────────
// A structural slice of the runtime's `BlobRuntime` (packages/runtime/src/blobs/types.ts, Slice A) — typed locally
// for the same reason as every other host type here: ui-server never imports `@kora/runtime`. Wire shapes
// (`@kora/contracts` Blob*) are used where the runtime speaks them; anything returned in the memory module's own
// shape is typed `unknown` and adapted in blobsWire.ts. A method may answer sync or async.
type MaybeAsync<T> = T | Promise<T>;

/** What the ui-server hands `store.create` — engine is always concrete here (null = "best installed" is resolved first). */
export interface KoraBlobCreate {
  name: string;
  title: string;
  soul: string;
  engine: BlobProfile["engine"];
  permission: BlobProfile["permission"];
  outfit: BlobProfile["outfit"];
  templateId: string | null;
  toolGrants?: BlobProfile["toolGrants"];
  teamId?: string;
}
/** The runtime `BlobStore` (packages/runtime/src/blobs/store.ts): profile truth (`<KORA_HOME>/blobs/<id>/profile.json` +
 *  SOUL.md), the `~/Blobs/<slug>` workspace, and the plain settings files. It is an EventEmitter ("changed"). */
export interface KoraBlobStoreLike {
  /** Active blobs; pass `includeArchived` for the whole roster. */
  list(opts?: { includeArchived?: boolean }): BlobProfile[];
  get(blobId: string): BlobProfile | null;
  /** Creates the profile, SOUL.md and the workspace; throws on a taken name. */
  create(input: KoraBlobCreate): MaybeAsync<BlobProfile>;
  update(blobId: string, patch: BlobProfilePatch): MaybeAsync<BlobProfile>;
  archive(blobId: string): MaybeAsync<BlobProfile>;
  rehire(blobId: string): MaybeAsync<BlobProfile>;
  /** Real delete: the blob's home (and workspace, when still there) go to the Trash. `confirmName` must be its name. */
  delete(blobId: string, confirmName: string): MaybeAsync<unknown>;
  soul(blobId: string): string;
  writeSoul(blobId: string, text: string): MaybeAsync<void>;
  skills?(blobId: string): BlobSkill[];
  // The workspace-wide files. The runtime owns them when it offers these (so open sessions go stale); otherwise the
  // ui-server reads and writes the same files itself (blobsFs.ts).
  aboutMe?(): string;
  setAboutMe?(text: string): string;
  defaults?(): BlobDefaults;
  setDefaults?(d: BlobDefaults): BlobDefaults;
  flags?(): BlobFlags;
  setFlag?(key: keyof BlobFlags, value: boolean): BlobFlags;
  /** Fired after any profile (or settings file) change. May return an unsubscribe function or the emitter itself. */
  on(event: "changed", fn: () => void): unknown;
  off?(event: "changed", fn: () => void): unknown;
}
/**
 * The memory facade (runtime `blobs/memory-host.ts`): the async twin of the memory module's `MemoryStore`
 * (packages/runtime/src/memory/index.ts), a worker call per method. Results are in the module's own shapes
 * (`Fact`, `Receipt`, `EpisodeHit`); blobsWire.ts / blobsMemory.ts adapt them onto the wire.
 */
export interface KoraBlobMemoryLike {
  listFacts(a?: {
    scope?: BlobMemoryScope;
    blobId?: string;
    includeRetired?: boolean;
  }): MaybeAsync<unknown[]>;
  getFact(id: string): MaybeAsync<unknown | undefined | null>;
  getCore(blobId: string): MaybeAsync<{ you: string; blob: string }>;
  getTeamCore?(): MaybeAsync<string>;
  setCore(scope: "you" | "blob", blobId: string, text: string): MaybeAsync<unknown>;
  editFact(
    id: string,
    patch: { text?: string; confidence?: number; important?: boolean },
  ): MaybeAsync<unknown | undefined | null>;
  forgetFact(id: string): MaybeAsync<unknown>;
  /** The user's own "remember this" (no model, no checks beyond refusing a credential). Optional: an older memory module has none. */
  addFact?(a: {
    scope: "you" | "blob" | "team";
    blobId?: string;
    text: string;
    important?: boolean;
  }): MaybeAsync<unknown>;
  markImportant(id: string, on?: boolean): MaybeAsync<unknown>;
  undo(receiptId: string): MaybeAsync<boolean>;
  approvePending(id: string): MaybeAsync<unknown | null>;
  rejectPending(id: string): MaybeAsync<unknown>;
  listReceipts(a?: { blobId?: string; limit?: number }): MaybeAsync<unknown[]>;
  /** Memories held for the user's OK (open items). Optional: a memory module without it has none to show. */
  listPending?(a?: { blobId?: string }): MaybeAsync<unknown[]>;
  searchEpisodes(a: { blobId?: string; query: string; limit?: number }): MaybeAsync<unknown[]>;
  forgetBlob(blobId: string): MaybeAsync<unknown>;
}
/** `ChatEngine` as the blob runtime sees it (ARCH 3, `BlobEngineBridge`); implemented by blobsEngine.ts. */
export interface BlobEngineBridge {
  startThread(p: {
    blobId: string;
    title: string;
    prompt: string;
    origin: ThreadOrigin;
    fromKoraThreadId: string | null;
  }): Promise<
    { threadId: string; koraThreadId: string } | { refused: "busy" | "archived" | "unknown" }
  >;
  sendToThread(threadId: string, text: string, origin: ThreadOrigin): Promise<void>;
  snapshot(threadId: string): {
    state: "running" | "idle" | "needs-you" | "error";
    finalText: string | null;
    outputs: string[];
    tokens: TokenTotals;
    /** The last turn was cut off by a daemon restart (its text is half an answer). */
    interrupted?: boolean;
  } | null;
  runningCount(blobId: string): number;
  appendCard(koraThreadId: string, card: BlobCardPayload): void;
  queueNote(koraThreadId: string, text: string): void;
  onSettled(
    cb: (e: { threadId: string; koraThreadId: string; blobId: string; ok: boolean }) => void,
  ): () => void;
  /** Stop a running blob thread (job cancel). */
  interrupt?(threadId: string): void | Promise<void>;
  // Phase 4 (routines): hidden execution threads, results threads and the dated report card.
  startHiddenThread?(p: {
    blobId: string;
    title: string;
    prompt: string;
    origin: ThreadOrigin;
  }): Promise<
    { threadId: string; koraThreadId: string } | { refused: "busy" | "archived" | "unknown" }
  >;
  createResultsThread?(p: { blobId: string; title: string }): Promise<{ threadId: string } | null>;
  threadExists?(threadId: string): boolean;
  /** Retention: delete a FINISHED routine run's hidden thread. Refuses (false) for any other thread or one still active. */
  deleteHiddenThread?(threadId: string): Promise<boolean>;
  /** Append a card to a thread by its UI id (the routine report goes into the results thread). */
  postRoutineReport?(threadId: string, card: BlobCardPayload): Promise<boolean>;
  // Phase 3: a group thread's member turn (one provider session per member per group thread); the runtime's GroupOrchestrator drives it.
  runMemberTurn?(req: KoraMemberTurnRequest): Promise<{ text: string }>;
  // Phase 8: what outside access reads and does through the chat engine (`kora mcp --team`).
  outside?: KoraOutsideEngine;
}

/** Structural twin of the runtime's `MemberTurnRequest` (blobs/groups/orchestrator.ts). */
export interface KoraMemberTurnRequest {
  groupId: string;
  threadId: string;
  blobId: string;
  prompt: string;
  cwd: string;
  allowDelegation: boolean;
  depth: number;
  triggerSeq: number;
  signal: AbortSignal;
  onText?(textSoFar: string): void;
}

/** Structural twin of the runtime's `OutsideEngine` (blobs/outside/host.ts). */
export interface KoraOutsideEngine {
  threads(blobId: string): Array<{
    id: string;
    blobId: string;
    title: string;
    status: "running" | "settled" | "needs-you" | "error";
    updatedAt: number;
    messageCount: number;
  }>;
  thread(threadId: string): {
    id: string;
    blobId: string;
    title: string;
    status: "running" | "settled" | "needs-you" | "error";
    updatedAt: number;
    messageCount: number;
  } | null;
  rows(threadId: string): Array<Record<string, unknown>>;
  blobState(blobId: string): "idle" | "working" | "needs-you" | "error";
  search(
    query: string,
    blobIds: readonly string[],
    limit: number,
  ): Array<{
    kind: "thread" | "blob" | "output";
    id: string;
    blobId: string | null;
    title: string;
    snippet: string;
  }>;
  models(instanceId: string): Array<{ model: string; label: string }>;
  send(i: {
    blobId?: string;
    threadId?: string;
    text: string;
    via: { client: string; tokenId: string };
  }): Promise<
    | { threadId: string; blobId: string }
    | { refused: "busy" | "archived" | "unknown" | "empty"; message?: string }
  >;
  interrupt(threadId: string): Promise<boolean>;
  groupSend?(i: {
    groupId: string;
    text: string;
    via: { client: string; tokenId: string };
  }): Promise<{ ok: boolean; message?: string }>;
}

/** A group profile as the runtime's `GroupStore` hands it out (the handlers map it onto the wire). */
export interface KoraGroupJson {
  id: string;
  name: string;
  slug: string;
  memberIds: string[];
  leadId: string;
  rule: "mention" | "lead" | "auto";
  instructions: string;
  workspace: string;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The runtime `GroupsService` slice the ui-server drives (blobs/groups/service.ts). */
export interface KoraGroupsLike {
  readonly groups: {
    list(opts?: { includeArchived?: boolean }): KoraGroupJson[];
    get(id: string): KoraGroupJson | null;
    create(input: {
      name: string;
      memberIds: string[];
      leadId?: string;
      rule?: "mention" | "lead" | "auto";
      instructions?: string;
    }): KoraGroupJson;
    update(id: string, patch: Record<string, unknown>): KoraGroupJson;
    archive(id: string): KoraGroupJson;
    delete(id: string, confirmName: string): { trashed: string[] };
  };
  readonly attached: boolean;
  /** One user message in a group thread; resolves when the whole chain has settled. */
  send(i: {
    groupId: string;
    threadId: string;
    transcript: KoraGroupTranscript;
    text: string;
    userName?: string;
  }): Promise<unknown>;
  /** Stop in one group thread. */
  stop(threadId: string): number;
  onEvent(cb: (e: KoraGroupEvent) => void): () => void;
  on(event: "changed", fn: (id: string | null) => void): unknown;
  off(event: "changed", fn: (id: string | null) => void): unknown;
}
export interface KoraGroupTranscript {
  append(m: {
    authorId: string;
    authorName: string;
    text: string;
    to: string[];
    kind: "message" | "note";
    ts?: number;
  }): KoraGroupMessage;
  list(): KoraGroupMessage[];
}
export interface KoraGroupMessage {
  id: string;
  seq: number;
  authorId: string;
  authorName: string;
  text: string;
  to: string[];
  ts: number;
  kind: "message" | "note";
}
export type KoraGroupEvent =
  | {
      type: "routed";
      threadId: string;
      messageSeq: number;
      recipients: string[];
      label: string;
      decision: { reason: string; detail?: string };
    }
  | { type: "turn-start"; threadId: string; blobId: string; depth: number }
  | { type: "turn-delta"; threadId: string; blobId: string; text: string }
  | { type: "turn-end"; threadId: string; blobId: string; message: KoraGroupMessage; depth: number }
  | { type: "turn-timeout"; threadId: string; blobId: string; depth: number }
  | { type: "turn-empty"; threadId: string; blobId: string; depth: number }
  | { type: "turn-aborted"; threadId: string; blobId: string; depth: number }
  | { type: "turn-error"; threadId: string; blobId: string; depth: number; error: string }
  | { type: "chain-capped"; threadId: string; reason: "depth" | "turns"; blobIds: string[] };

/** The runtime `TeamFileService` slice (blobs/teamfile/service.ts). Results are plain JSON in the wire's shapes. */
export interface KoraTeamFileLike {
  options(): {
    blobs: Array<{ id: string; name: string; title: string; skills: number; routines: number }>;
    groups: Array<{ id: string; name: string; memberIds: string[] }>;
  };
  preview(selection: unknown): unknown;
  export(selection: unknown): { markdown: string; fileName: string; report: unknown };
  planFromText(text: string): { ok: true; plan: unknown } | { ok: false; error: string };
  planFromUrl(url: string): Promise<{ ok: true; plan: unknown } | { ok: false; error: string }>;
  apply(
    planId: string,
    skip: { blobs?: readonly string[]; groups?: readonly string[]; replace?: readonly string[] },
    engine: BlobProfile["engine"],
  ): {
    blobs: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string }>;
    errors: Array<{ what: string; error: string }>;
  };
}

/** The runtime `OutsideService` slice the Settings page drives (blobs/outside/service.ts). */
export interface KoraOutsideLike {
  listTokens(): Array<Record<string, unknown>>;
  createToken(
    name: string,
  ):
    | { ok: true; token: string; record: Record<string, unknown> }
    | { ok: false; error?: string; message?: string };
  revokeToken(id: string): boolean;
  auditPage(o?: { limit?: number; before?: number }): {
    rows: Array<Record<string, unknown>>;
    next: number | null;
  };
}
/** The runtime `BlobRuntime` slice the ui-server drives. Optional on `UiHost`: an older daemon has no blobs. */
export interface KoraBlobsLike {
  readonly store: KoraBlobStoreLike;
  readonly memory: KoraBlobMemoryLike;
  /** The blob whose workspace contains `cwd`, or null. */
  byCwd?(cwd: string): BlobProfile | null;
  /** Phase 6: the live view of each blob's own browser (`/blob-browser/:blobId/live`); absent on an older daemon. */
  readonly browserLive?: import("./handlers/blobs-browser.ts").LiveBrowserSource;
  /** After a settled blob turn: extract + store memory. Returns the receipts for the one-line chat card. */
  afterTurn(i: {
    blobId: string;
    threadId: string;
    messageIds: { user: string; assistant: string };
    userText: string;
    assistantText: string;
    at: number;
    /** A Kora hand-off brief: Kora's words, not the user's. Searchable, never learned from. */
    brief?: boolean;
  }): Promise<unknown[]>;
  /** The memory extractor chain's state: `{ lastModel, lastAt, breakers, retryAt, claudeCallsToday }` or null. */
  extractorStatus?(): unknown;
  /** Start the group-routing session early so the first auto-routed message does not time out. */
  prewarmRouting?(): void;
  /** Called once by `startUiServer`; the runtime keeps it for delegated work (Phase 2). */
  attachEngine?(bridge: BlobEngineBridge): void;
  /** Where a hire / proposal with no model gets one: the best installed engine right now. */
  setBestEngine?(fn: () => BlobEngine | null): void;
  /** The runtime mode a blob thread starts in for (engine, permission) — A's `resolveBlobRuntimeMode`. */
  runtimeModeFor?(instanceId: string, permission: BlobProfile["permission"]): string;
  /** About-me / defaults / Core notes were rewritten on disk by the ui-server: re-read them and mark open sessions stale. */
  refresh?(): void;
  /** Undo a blob's own SOUL / model edit by its receipt token; false when unknown or already undone. */
  undoSelfChange?(token: string): MaybeAsync<boolean>;
  /** Create Kora (the Chief) on `engine` when absent. Idempotent: an existing Kora is returned untouched. */
  ensureKora?(engine: BlobProfile["engine"]): BlobProfile;
  /** Whether Kora (the Chief) exists and is usable. */
  koraReady?(): boolean;
  // Phase 2
  templates?(): BlobTemplate[];
  hireTemplates?(templateIds: readonly string[]): MaybeAsync<BlobProfile[]>;
  /** `blobs.create` through the team: a proposal card's Hire / Tweak (`proposalId` flips the card to hired and tells Kora)
   *  or a plain draft; suggested routines are written paused. The draft's engine is already concrete. */
  hireDraft?(draft: BlobDraft, proposalId: string | null): MaybeAsync<BlobProfile>;
  /** Older shape: a hire made elsewhere, mark the proposal hired. Superseded by `hireDraft`. */
  proposalHired?(proposalId: string, blobId: string): MaybeAsync<void>;
  /** The user's click on a `confirm` card (`blobs.confirm.resolve`). */
  confirmResolve?(
    cardId: string,
    accept: boolean,
  ): MaybeAsync<{ ok: boolean; message: string; profiles: BlobProfile[] }>;
  proposalDismiss?(proposalId: string): MaybeAsync<void>;
  jobGet?(jobId: string): MaybeAsync<JobCardPayload>;
  jobCancel?(jobId: string, stepId: string | null): MaybeAsync<JobCardPayload>;
  /** Stop on a Kora (Chief) thread: cancel its unfinished jobs; resolves the cancelled step ids. */
  jobsCancelForThread?(koraThreadId: string): Promise<string[]>;
  jobFeedback?(jobId: string, stepId: string, reaction: "good" | "redo"): MaybeAsync<void>;
  /** Phase 4: routines + webhooks (runtime `RoutineService`). */
  readonly routines?: KoraRoutinesLike;
  /** Phase 4: a routine run needs the user / finished / failed (the daemon's quiet macOS notification). */
  onRoutineAttention?(
    cb: (e: { blobId: string; kind: "needs-you" | "settled" | "failed"; title: string }) => void,
  ): () => void;
  /** Phase 5: connected apps (runtime `AppsService`). */
  readonly apps?: KoraAppsLike;
  /** Phase 3: group chats (profiles, router, member turns) and team files (export / import plans). */
  readonly groups?: KoraGroupsLike;
  readonly teamfile?: KoraTeamFileLike;
  /** Phase 8: outside access (tokens, audit) for the Settings page. */
  readonly outside?: KoraOutsideLike;
}

/** A plain-JSON routine / run as the runtime's `RoutineService` hands it out (the handlers map it onto the wire). */
export type KoraRoutineJson = Record<string, unknown> & {
  id: string;
  blobId: string;
  triggers: unknown[];
};
export type KoraRoutineRunJson = Record<string, unknown> & { id: string };
type KoraResult<T> = { ok: true; value: T } | { ok: false; message: string };
/** The runtime `RoutineService` slice the ui-server drives (packages/runtime/src/blobs/routines/service.ts). */
export interface KoraRoutinesLike {
  list(blobId: string): KoraRoutineJson[];
  runs(blobId: string, limit?: number): KoraRoutineRunJson[];
  status(): { webhookPort: number; receiverUp: boolean; baseUrl: string };
  view(routine: unknown): KoraRoutineJson;
  preview(cadence: unknown): KoraResult<{ words: string; next: number[] }>;
  create(input: Record<string, unknown>, by?: string): KoraResult<unknown>;
  update(id: string, patch: Record<string, unknown>): KoraResult<unknown>;
  remove(id: string): KoraResult<unknown>;
  get(id: string): unknown;
  runNow(id: string): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  cancelRun(runId: string): Promise<boolean>;
  createTrigger(routineId: string, label: string): KoraResult<{ trigger: unknown; secret: string }>;
  rotateTrigger(
    routineId: string,
    triggerId: string,
  ): KoraResult<{ trigger: unknown; secret: string }>;
  deleteTrigger(routineId: string, triggerId: string): KoraResult<true>;
  confirm(token: string, accept: boolean): KoraResult<unknown>;
  on(
    event: "changed",
    fn: (e: { routineId: string | null; blobId: string | null }) => void,
  ): unknown;
  off(
    event: "changed",
    fn: (e: { routineId: string | null; blobId: string | null }) => void,
  ): unknown;
}

/** The runtime `AppsService` slice the ui-server drives (packages/runtime/src/blobs/apps/service.ts). */
export interface KoraAppsLike {
  status(): Promise<{
    mode: "byo" | "broker" | "unavailable";
    byoKeySet: boolean;
    brokerConfigured: boolean;
    secretStore: string;
    usage: {
      mode: "byo" | "broker" | "unavailable";
      used: number;
      limit: number | null;
      month: string;
      resetsAt: number | null;
      capReached: boolean;
    } | null;
    error: string | null;
    errorCode: string | null;
  }>;
  setByoKey(key: string): Promise<void>;
  clearByoKey(): Promise<void>;
  resetBroker(): Promise<void>;
  toolkits(q?: { search?: string; cursor?: string }): Promise<{
    toolkits: Array<{
      slug: string;
      name: string;
      description: string;
      logo: string | null;
      categories: string[];
    }>;
    nextCursor: string | null;
  }>;
  accounts(
    toolkit?: string,
  ): Promise<Array<{ id: string; toolkit: string; alias: string | null; status: string }>>;
  connect(toolkit: string, alias?: string): Promise<{ url: string; expiresAt: number }>;
  assertLinkFresh<T extends { url: string; expiresAt: number }>(l: T): T;
  disconnect(accountId: string): Promise<{ removed: number }>;
  ownerTools(toolkit: string): Promise<
    Array<{
      slug: string;
      name: string;
      description: string;
      toolkit: string;
      readOnly: boolean | null;
      outbound: boolean;
    }>
  >;
  readonly decisions: { recent(limit?: number, blobId?: string): Array<Record<string, unknown>> };
}

/** What `startUiServer` receives from `kora/src/server/ui.ts` (`UiHost` there). */
export interface UiHost {
  runtime: KoraRuntime;
  sessions: KoraSessionManager;
  managerRuntime: KoraManagerRuntime;
  makeFleetOps(runtime: unknown): KoraFleetOps;
  proxyPaneId(threadId: string): string;
  listClaudeModels(timeoutMs?: number): Promise<ClaudeModelInfo[] | null>;
  /** Plan windows via the provider's own CLI (runtime session/plan-usage.ts). Optional: older daemons lack it. */
  readUsageLimits?(provider: "claude" | "codex"): Promise<KoraUsageLimitsReport | null>;
  version: string;
  log(...parts: unknown[]): void;
  /** "Remove project": take Kora's managed blocks, hooks and folder trust out of the repo. Optional: older daemons lack it. */
  removeRepoFootprint?(
    cwd: string,
  ): Promise<{ root: string; removed: string[]; trustRevoked: boolean }>;
  /** Swarm setup (`runtime.swarmSetup`). */
  swarm: KoraSwarmLike;
  /** Settings → Diagnostics health checks and export. */
  doctor?: KoraDoctorLike;
  /** Money Kora saved, at API list prices (runtime `ledger/savings.ts` `savingsReport`): the context popover's
   *  "Kora saved you". Optional: an older daemon lacks it and `/api/savings` answers 404. */
  savings?: (threadId: string | null) => unknown;
  /** "Log in to Claude" (runtime `server/claude-login.ts`). Optional: older daemons lack it (routes answer 404). */
  claudeLogin?: KoraClaudeLoginLike;
  /** Blobs (`runtime.blobs`, packages/runtime/src/server/blobs.ts). Optional: older daemons lack it (blobs.* answer "unavailable"). */
  blobs?: KoraBlobsLike;
  /** The Kora surface switch (runtime `edition.ts`). Absent or 'coming-soon' = every blob RPC answers "Kora is coming
   *  soon" and boot starts no blob work (koraSurface.ts). */
  koraSurface?: () => "coming-soon" | "on";
  /** Phase 7 engines (ACP agents, API endpoints, Claude accounts). Optional: an older daemon has none. */
  engines?: KoraEnginesLike;
  /** Opens the graph store with the runtime's own SQLite (better-sqlite3), so one process never runs two SQLite copies on
   *  one file (graph.ts `setGraphDbOpener`). Optional: an older daemon lacks it and node:sqlite is used. */
  openGraphDb?(file: string): import("./graph.ts").GraphDb;
}

/**
 * The runtime's `Engines` service (packages/runtime/src/server/engines.ts): ACP agents, API endpoints, Claude accounts
 * and explicit executables. Results are the runtime's own shapes; engines.ts (handlers) puts them on the wire.
 */
export interface KoraEnginesLike {
  view(): Promise<unknown>;
  pickerEngines(): Promise<
    ReadonlyArray<{
      id: string;
      label: string;
      family: "acp" | "api";
      available: boolean;
      reason?: string;
      models: ReadonlyArray<{ id: string; name: string }>;
      defaultModel: string | null;
    }>
  >;
  accountList(): Array<{ name: string; label: string }>;
  /** `{driver, koraAgent}` for an id that is a known ACP / API engine, else null. */
  route(id: string): { driver: string; koraAgent: string } | null;
  acpSave(i: Record<string, unknown>): void;
  acpRemove(agentId: string): void;
  acpModels(agentId: string): Promise<{
    models: Array<{ id: string; name: string }>;
    current: string | null;
    error?: string;
  }>;
  /** The user's re-check: clears the "failed to start" mark of one ACP agent (or all). */
  acpRecheck?(agentId?: string): void;
  setIdleMinutes(minutes: number): void;
  setExecutable(
    engine: "claude" | "codex" | "opencode" | "antigravity",
    path: string | null,
  ): unknown;
  apiSave(i: Record<string, unknown>): unknown;
  apiRemove(id: string): Promise<void>;
  apiSetKey(id: string, key: string): Promise<void>;
  apiClearKey(id: string): Promise<void>;
  apiTest(
    id: string,
    key?: string,
  ): Promise<{ ok: boolean; kind: string; message: string; status?: number; modelCount?: number }>;
  apiModels(id: string): Promise<Array<{ id: string; name: string }>>;
  accountAdd(i: { name: string; label?: string }): unknown;
  accountRename(name: string, label: string): void;
  accountRemove(name: string): void;
  accountCheck(name: string): Promise<unknown>;
  /** Fired after any change (the provider list is re-synced). */
  on(event: "changed", fn: () => void): unknown;
}

/** Runtime `ClaudeLoginState`: `claude auth login` run by the daemon for the app. */
export interface KoraClaudeLoginState {
  phase: "idle" | "waiting" | "done" | "failed" | "cancelled";
  url: string | null;
  message: string | null;
  via: "cli" | "bundled" | null;
  startedAt: number | null;
}
export interface KoraClaudeLoginLike {
  start(): Promise<KoraClaudeLoginState>;
  status(): KoraClaudeLoginState;
  submitCode(code: string): KoraClaudeLoginState;
  cancel(): KoraClaudeLoginState;
}

let current: UiHost | null = null;
/** Bind the daemon's objects. Called once by `startUiServer`, before anything reads `host()`. */
export function setHost(h: UiHost): void {
  current = h;
}
export function host(): UiHost {
  if (!current) throw new Error("ui-server: host not bound (startUiServer was not called)");
  return current;
}

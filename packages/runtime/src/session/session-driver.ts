// The SessionDriver seam — a plain-TS provider adapter, no Effect. Every method is an ordinary Promise; the event stream is a push callback +
// unsubscribe (kora' EventEmitter idiom), not an Effect Stream. One driver instance = one live
// provider session bound to one thread.
import type { AgentId } from '../protocol/types';
import type {
  ChatEvent, ThreadId, TurnId, RequestId,
  ApprovalAnswer, UserInputAnswers, ModelChoice, PromptAttachment, RuntimeMode, ThreadAgentMode,
} from './events';

/** What a driver can do — clients gate UI on this (model picker, rollback affordance). */
export interface DriverCapabilities {
  /** Change model on a live session without restart. Claude: in-session (query.setModel). */
  readonly modelSwitch: 'in-session' | 'restart-only' | 'unsupported';
  /** Start a turn with no synthetic user prompt (crash-recovery continuation). Claude: true. */
  readonly promptlessContinuation: boolean;
  /** Native conversation rewind. Claude v1: false (forkSession is v2). Codex: true. */
  readonly conversationRollback: boolean;
  /** Understands a /compact-style manual compaction. */
  readonly manualCompaction: boolean;
  /** This agent can spawn kora worker sub-agents (orchestrator threads). */
  readonly canSpawnWorkers: boolean;
  /** Announces a tool call (tool.started) when it begins, not only once it has finished. Without it a long build is
   *  indistinguishable from a dead stream, so a worker's silence watchdog must not interrupt on its usual clock. */
  readonly reportsToolStart?: boolean;
}

export interface SessionStartInput {
  readonly threadId: ThreadId;
  readonly agent: AgentId; // 'claude' | 'codex' | ...
  readonly cwd: string;
  readonly account: string | null; // credential profile → per-account env isolation (§6)
  readonly model?: ModelChoice;
  /** The prompt cache is cold for this start's model (Auto moved the thread up to another model): a resumed conversation is
   *  continued from a masked copy, as after an hour away (claude-driver maskColdResume). */
  readonly coldCache?: boolean;
  /** Claude only: the model behind Claude Code's server-side advisor tool (Auto's middle tier: Sonnet works, the Default advises). */
  readonly advisorModel?: string;
  readonly runtimeMode?: RuntimeMode; // approval-required | auto-accept-edits | auto | full-access
  readonly isOrchestrator?: boolean; // wire the kora spawn MCP tool (§7)
  /** The thread's mode (swarm ⇒ fleet tools + the swarm alias). isOrchestrator stays = isFleetAgentMode(agentMode). */
  readonly agentMode?: ThreadAgentMode;
  /** A blob whose Helpers switch is off: no fleet tools (kora_spawn / kora_map / kora_wait) on this session. */
  readonly helpersOff?: boolean;
  /** A fleet worker running on this driver (server/driver-pane.ts): no fleet tools, no subagents, no questions to a
   *  human (AskUserQuestion), the worker prompt instead of the lead's. */
  readonly isWorker?: boolean;
  /** Opaque resume state from a prior session (crash recovery / reopen). */
  readonly resume?: unknown;
}

export interface SendTurnInput {
  readonly threadId: ThreadId;
  readonly text?: string; // omittable only when continuation=true
  readonly attachments?: PromptAttachment[];
  readonly model?: ModelChoice; // per-turn override; also drives mid-thread switch
  readonly interactionMode?: 'default' | 'plan';
  /** Recovery signal: allow an empty turn on promptlessContinuation drivers. */
  readonly continuation?: boolean;
  /** Who wrote this turn. 'kora-notice' = a Kora-sent notice / notes turn: the driver skips prompt injection. */
  readonly origin?: 'user' | 'kora-notice';
  /** A pending mode notice to prepend (prompt = koraNotice + "\n\n" + text); injection is computed on `text` only. */
  readonly koraNotice?: string;
}

export interface TurnHandle { readonly threadId: ThreadId; readonly turnId: TurnId; readonly resume?: unknown }

export interface SessionDriver {
  readonly agent: AgentId;
  readonly capabilities: DriverCapabilities;

  /** Boot (or resume) the provider session. Emits session.started → thread.started. */
  startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }>;

  /** Queue a user turn onto the live session. Returns once the turn is registered, not settled. */
  sendTurn(input: SendTurnInput): Promise<TurnHandle>;

  /** Interrupt the active (or a specific) turn. */
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;

  /** Resolve an open approval request (inline approvals). */
  respondToApproval(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): Promise<void>;

  /** Answer a structured user-input request (Codex async questions, Claude AskUserQuestion). */
  respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void>;

  /**
   * Switch the session model mid-thread (no-op restart when capabilities say restart-only). Resolves `false` when the
   * live session refused the switch: the manager then restarts it with the new model before the next turn.
   */
  setModel(threadId: ThreadId, model: ModelChoice): Promise<void | boolean>;
  /** Change a live session's effort without a restart; false (or absent) = the caller restarts it before the next turn. */
  setEffort?(threadId: ThreadId, effort: string | null): Promise<boolean>;

  /**
   * Push a permission-mode change into a LIVE session (Claude: query.setPermissionMode).
   * Absent ⇒ the mode only takes effect at the next session start.
   */
  setPermissionMode?(threadId: ThreadId, mode: RuntimeMode): Promise<void>;

  /** Optional native compaction; absent ⇒ the manager sends a /compact turn instead. */
  compact?(threadId: ThreadId): Promise<void>;

  /** Graceful teardown. Emits session.exited. Persisted resume state survives. */
  /** `idle`: the idle reaper is ending the process; the thread lives on and its next turn resumes (caches may be kept warm). */
  stopSession(threadId: ThreadId, opts?: { idle?: boolean }): Promise<void>;

  /** The thread is stopped for good (delete, move, explicit stop) while no session is live: drop anything an idle stop kept for it. */
  forgetThread?(threadId: ThreadId): void;

  /** Push subscription. Returns an unsubscribe fn. The manager fans this into chat.event. */
  streamEvents(onEvent: (e: ChatEvent) => void): () => void;

  hasSession(threadId: ThreadId): boolean;
}

/**
 * What the driver needs from the daemon Runtime, injected so the driver never reaches into
 * workspace.ts directly (and so tests can supply fakes). Mirrors the seams §01/§06 call out:
 *  - graphCall  → runtime.graph.callTool (koragraph, for the interceptor)
 *  - spawnWorker→ runtime.agentSpawn (the §7 orchestrator→worker-pane bridge)
 *  - spawnEnv   → adapterFor(agent).spawnEnv (per-account credential isolation, reused verbatim)
 */
export interface WorkerSpawnParams {
  agent: AgentId; cwd: string; prompt?: string; account?: string | null; worktree?: boolean; orchestratorId?: string;
  /** Extra argv for the worker's CLI (model / effort / permission flags). */
  args?: string[];
  /** Pane name — the slice title, shown on the worker's tile. */
  name?: string;
}
export interface DriverDeps {
  graphCall(name: string, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<{ text: string; data: unknown; ms: number }>;
  /** Graph status for a cwd (indexed or not) — same service as graphCall, so it also runs off the event loop. */
  graphStatus?(cwd: string): Promise<{ indexed: boolean }>;
  /** Bug-report localization for a plain-English bug prompt (graph/bug-localize.ts), answered from the graph worker thread. Absent: computed in-process. */
  graphBugLocalize?(prompt: string, root: string, generation: string): Promise<unknown>;
  spawnWorker(params: WorkerSpawnParams): Promise<{ id: string; agent: AgentId; account: string | null; /** false: no worktree of its own, it edits the lead's checkout */ worktree?: boolean }>;
  spawnEnv(threadId: string, account: string | null): Record<string, string>;
  appendSystemPrompt(input: SessionStartInput): string | undefined;
  /** Fleet control for orchestrator threads (roster / steer / wait / read / kill / merge / plan). Absent ⇒ spawn-only. */
  fleet?: import('../server/fleet-ops').FleetOps;
  /** The runtime's pane socket — what an out-of-process orchestrator's MCP bridge (`kora mcp --fleet`) dials. */
  socketPath?: string;
  /** Absolute path to bin/kora.js, for CLIs that take an MCP server command line. */
  binPath?: string;
  /**
   * The pane-equivalent session preparation (see Runtime.prepareChatSession): the repo's rulebook + hooks are
   * installed, and the returned env / system-prompt / strict-MCP settings are what an agent pane's CLI gets
   * as argv. Absent ⇒ the session starts unprepared (tests, embedders without a Runtime).
   */
  prepareSession?(input: SessionStartInput): Promise<SessionPrep>;
  /**
   * Folder trust (trust/store.ts): may this session load the repository's own Claude settings (project + local hooks,
   * MCP approvals, plugins)? Absent ⇒ the persistent trust store decides. Tests inject it.
   */
  isFolderTrusted?(cwd: string): boolean;
  /** The worker picker (kora_ask_workers): show the lead's proposed workers to the user, resolve with their answer. */
  /** The Blobs runtime (blobs/runtime.ts), structurally: blob sessions get its tools, skills plugin and policy. */
  blobs?: DriverBlobs;
  /** OpenCode as a chat engine (OpenCodeDriver): binary, free-model picking, provider env, rate-limit cooling. */
  opencode?: OpencodeDeps;
  askWorkers?(threadId: string, picks: import('./worker-picker').WorkerPick[]): Promise<import('./worker-picker').WorkerPickerAnswer>;
}

/** A pane's launch flags, translated for an SDK-driven session (Runtime.prepareChatSession). */
export interface SessionPrep {
  /** KORA_* identity (KORA_SOCKET_PATH = this daemon), PATH shims, account env — merged over process.env. */
  env: Record<string, string>;
  /** The rulebook a pane gets via `--append-system-prompt`. */
  appendSystemPrompt?: string;
  /** `--strict-mcp-config`: only the session's own MCP servers load (no user-level servers). */
  strictMcp?: boolean;
  /** What was done, for the daemon log. */
  notes: string[];
}

/** What the drivers need from the Blobs runtime. */
export interface DriverBlobs {
  /** The blob whose workspace contains `cwd`. */
  byCwd(cwd: string): { id: string; role: 'chief' | 'member'; permission: 'ask' | 'auto' | 'full'; workspace: string } | null;
  toolSpecs(ctx: import('../blobs/tools-team').TeamToolContext): import('./fleet-tools').FleetToolSpec[];
  /** Folders this blob may read but not write (Kora: every teammate's workspace, so she can read their outputs). */
  readableDirs?(blobId: string): string[];
  /** The local skills plugin for a blob session (Claude `plugins` + `skills`). */
  skills(blobId: string): { dir: string; qualified: string[] };
  /** A bearer token for a Codex / OpenCode blob session's `kora mcp --blobs` server (the blob's tools over MCP). */
  mcpIssue?(session: import('../blobs/tools-team').McpSession): string;
  /** Revoke every token of a thread (turn/thread ended). */
  mcpRevoke?(threadId: string): void;
  /** Take what a blob copied out of the user's memory / About me out of a helper's brief. */
  scrubBrief?(blobId: string, task: string): string | Promise<string>;
  /** Standing "Always for this blob" approvals (blobs/approval-rules.ts). */
  alwaysAllowed?(blobId: string, toolName: string, input: Record<string, unknown>): boolean;
  approvalRuleFor?(toolName: string, input: Record<string, unknown>): { label: string } | null;
  rememberAlways?(blobId: string, toolName: string, input: Record<string, unknown>): unknown;
}

/** OpenCode chat-engine wiring, supplied by the daemon from the swarm setup. */
export interface OpencodeDeps {
  binary(): string | null;
  /** A free model id (provider/model) not in `exclude`, or null. */
  pickModel(exclude?: string[]): string | null;
  /** Env the model's provider needs (OPENCODE_CONFIG_CONTENT, key vars, …). */
  env(model: string): Record<string, string>;
  markCooling(model: string, reason: string): void;
}

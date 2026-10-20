// ─────────────────────────────────────────────────────────────────────────────
// The kora Chat wire event schema — DAEMON side (§01 §2 + §06 §1).
// Mirrored STRUCTURALLY by the chat UI server's local types (packages/ui-server/src/host.ts): the ChatEvent
// union, ChatThreadInfo, ModelChoice, and the graph family are identical.
// Additive discipline: NEVER rename or remove a field. Sections 02/03/05/06 render
// what is defined here; this file is the single source the contract mirrors.
// ─────────────────────────────────────────────────────────────────────────────
import type { AgentId } from '../protocol/types';

export type ThreadId = string; // stable; = chat thread id (§8)
export type TurnId = string;
let turnIdSeq = 0;
/**
 * A turn id unique per thread ACROSS daemon restarts. Drivers used a per-process counter (`turn_1`, `turn_2`, …), so
 * after every restart new turns reused old ids and the timeline folded rows from different turns together (and item
 * ids, derived from the turn id, collided). Time-prefixed so ids still sort roughly by creation; no `_` after the prefix.
 */
export function newTurnId(): TurnId {
  turnIdSeq = (turnIdSeq + 1) % 1_679_616; // 36^4
  return `turn_${Date.now().toString(36)}${turnIdSeq.toString(36).padStart(4, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}
export type ItemId = string; // stable id for one transcript item (a tool card, a text block)
export type RequestId = string;

// ── envelope ────────────────────────────────────────────────────────────────
/** On every event. `seq` is a per-thread monotonic cursor for gap-free replay/backfill (§5, §8). */
export interface ChatEventBase {
  threadId: ThreadId;
  seq: number; // daemon-assigned, gap-free per thread
  at: number; // epoch ms
  turnId?: TurnId;
  itemId?: ItemId;
  requestId?: RequestId;
  agentId?: string; // set when this event belongs to a spawned sub-agent (§7)
}

// ── enums / leaf types ────────────────────────────────────────────────────────
export type ToolKind =
  | 'command_execution' | 'file_change' | 'file_read' | 'mcp_tool_call'
  | 'web_search' | 'graph_query' | 'dynamic_tool_call';

export type ApprovalKind =
  | 'command_execution_approval' | 'file_change_approval' | 'file_read_approval'
  | 'mcp_elicitation_approval' | 'apply_patch_approval' | 'unknown';

export type ApprovalAnswer = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
export interface ApprovalOption { decision: ApprovalAnswer; label: string; warning?: string }

export type ContentStream = 'assistant_text' | 'reasoning_text' | 'reasoning_summary';
export type ToolStatus = 'completed' | 'failed' | 'declined';
export type SessionState = 'starting' | 'ready' | 'running' | 'waiting' | 'stopped' | 'error';
export type TurnSettleState = 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type WorkerStatus = 'running' | 'idle' | 'blocked' | 'done' | 'failed';

export interface PlanStep { step: string; status: 'pending' | 'inProgress' | 'completed' }

export interface UserInputQuestion {
  id: string; header: string; question: string;
  options: { label: string; description: string; value?: string }[];
  allowCustomAnswer?: boolean; multiSelect?: boolean;
}
export type UserInputAnswers = Record<string, unknown>;

/**
 * How full the thread's context window is. `usedTokens` is what the model sees on its NEXT request (system prompt,
 * tools, conversation — cache reads included), not what one turn cost. Everything else is optional detail:
 * `costUsd` is the provider's own running estimate for the session (Claude's `total_cost_usd`), never a bill.
 */
export interface TokenUsage {
  usedTokens: number; maxTokens?: number; inputTokens?: number; outputTokens?: number; totalProcessedTokens?: number;
  cachedInputTokens?: number; autoCompactThreshold?: number; compactsAutomatically?: boolean; costUsd?: number;
  /** Where the number came from: `provider` = the harness's own context accounting, `estimate` = from the last request's usage. */
  source?: 'provider' | 'estimate';
}
/** One subscription quota window (Claude's 5-hour session, a weekly cap, Codex's primary/secondary window). */
export interface UsageWindow { id: string; kind: 'session' | 'weekly' | 'monthly' | 'other'; label: string; usedPercent: number; resetsAt?: number; windowMinutes?: number }
/** A (possibly partial) report of the account's plan limits. Windows merge by id onto what the daemon knew. */
export interface UsageLimitsReport { provider: AgentId; windows: UsageWindow[]; plan?: string; limited?: boolean; resetsAt?: number; complete?: boolean }
export interface TurnUsage { usageStatus: 'complete' | 'partial' | 'unavailable'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number }

export interface ModelChoice { model: string; account?: string | null; effort?: string | null; options?: Record<string, string | boolean> }
export interface AccountInfo { agent: AgentId; account: string | null; email?: string; subscriptionLabel?: string; authKind?: string }
/** A composer attachment stored by the ui-server under <KORA_HOME>/attachments; `path` is absolute. */
export interface PromptAttachment { type: 'image' | 'file'; path: string; mimeType?: string; name?: string }
export interface FileChange { path: string; additions: number; deletions: number; patch?: string }

// ── graph (the kora signature) ───────────────────────────────────────────────
export type GraphOp = 'explore' | 'blast_radius' | 'neighbours' | 'search_code' | 'changes_with' | 'overview';
export interface GraphNode { id: string; label: string; kind: 'fn' | 'method' | 'class' | 'const' | 'file' | 'module'; file: string; line?: number; x: number; y: number; hazard?: boolean }
export interface GraphEdge { from: string; to: string; kind: 'calls' | 'imports' | 'cochange' | 'contract'; crossesSeam?: boolean }
export interface GraphPartition { workerPaneId: string; nodeIds: string[]; color: string }
/** A daemon-computed, render-ready graph. Layout (x/y in 0..1) is computed daemon-side (D18). */
export interface GraphView { nodes: GraphNode[]; edges: GraphEdge[]; focusId?: string; partitions?: GraphPartition[] }

// ── the ChatEvent discriminated union ─────────────────────────────────────────
export type ChatEvent =
  // session / thread lifecycle
  | (ChatEventBase & { type: 'session.started'; resume?: unknown })
  | (ChatEventBase & { type: 'session.state'; state: SessionState; reason?: string })
  | (ChatEventBase & { type: 'session.exited'; recoverable: boolean; reason?: string })
  | (ChatEventBase & { type: 'thread.started'; providerThreadId?: string })
  | (ChatEventBase & { type: 'thread.token-usage'; usage: TokenUsage })
  // turn lifecycle
  | (ChatEventBase & { type: 'turn.started'; turnId: TurnId; model?: string; effort?: string })
  | (ChatEventBase & { type: 'turn.settled'; turnId: TurnId; state: TurnSettleState; stopReason?: string; usage?: TurnUsage; errorMessage?: string })
  | (ChatEventBase & { type: 'turn.plan'; plan: PlanStep[]; explanation?: string })
  // plan mode: the plan the agent hands back for the user to implement (Claude's ExitPlanMode)
  | (ChatEventBase & { type: 'plan.proposed'; markdown: string })
  // streamed content (this agent's own output)
  | (ChatEventBase & { type: 'content.delta'; itemId: ItemId; stream: ContentStream; delta: string })
  // inline tool cards (THIS agent's own tools)
  | (ChatEventBase & { type: 'tool.started'; itemId: ItemId; toolKind: ToolKind; toolName: string; title: string; input?: unknown; inputPartial?: string })
  | (ChatEventBase & { type: 'tool.updated'; itemId: ItemId; input?: unknown; inputPartial?: string })
  | (ChatEventBase & { type: 'tool.result'; itemId: ItemId; status: ToolStatus; output?: string; outputStream?: 'command_output' | 'file_change_output'; data?: unknown; changedFiles?: FileChange[]; /** Kora bounded this Read to a window (graph/read-bounder.ts): the card shows "read lines a-b of N". */ bounded?: { path: string; offset: number; limit: number; total: number } })
  | (ChatEventBase & { type: 'tool.progress'; itemId?: ItemId; summary?: string; elapsedMs?: number })
  // approvals (yes/no on a tool the agent wants to run)
  | (ChatEventBase & { type: 'approval.opened'; requestId: RequestId; requestKind: ApprovalKind; title: string; detail?: string; options?: ApprovalOption[]; args?: unknown; /** The tool the agent asked to use (Bash, Edit, ...). */ toolName?: string; /** Blob threads: what "Always for this blob" would remember ("Run echo"). */ alwaysLabel?: string; /** A sensitive call through a symlink: where it really lands (`~/.ssh/id_rsa`). */ linkTarget?: string })
  | (ChatEventBase & { type: 'approval.resolved'; requestId: RequestId; decision: ApprovalAnswer })
  // structured user input (a question the agent asks; not a tool gate)
  | (ChatEventBase & { type: 'user-input.requested'; requestId: RequestId; questions: UserInputQuestion[]; dismissible?: boolean })
  | (ChatEventBase & { type: 'user-input.resolved'; requestId: RequestId; answers: UserInputAnswers })
  // the worker picker: the lead proposes its workers (kora_ask_workers), the user approves / changes them
  | (ChatEventBase & { type: 'worker-picker.requested'; requestId: RequestId; picks: import('./worker-picker').WorkerPick[]; catalog: import('./worker-picker').WorkerCatalog['agents'] })
  | (ChatEventBase & { type: 'worker-picker.resolved'; requestId: RequestId; answer: import('./worker-picker').WorkerPickerAnswer })
  // spawned worker sub-agents (orchestrator threads → side-pane)
  | (ChatEventBase & { type: 'worker.attached'; paneId: string; workerAgent: string; account?: string | null; title: string; role?: string })
  | (ChatEventBase & { type: 'worker.status'; paneId: string; status: WorkerStatus; blocker?: string })
  | (ChatEventBase & { type: 'worker.detached'; paneId: string; reason?: string })
  // graph
  | (ChatEventBase & { type: 'graph.query'; itemId: ItemId; op: GraphOp; subject: string; summary: string })
  | (ChatEventBase & { type: 'graph.result'; itemId: ItemId; view: GraphView })
  | (ChatEventBase & { type: 'context.blast-radius'; subject: string; callers: number; files: number; hazards: number })
  // account / limits / diagnostics
  | (ChatEventBase & { type: 'usage.rate-limit'; window?: string; message: string; resetsAt?: number })
  | (ChatEventBase & { type: 'usage.limits'; report: UsageLimitsReport })
  /** The harness summarized the conversation (`/compact`, or automatically near the window's end). */
  /** The turn is repeating itself (the same Read or the same failing command): a quiet "looks stuck" line; the user's Stop ends it (session/runaway.ts). */
  | (ChatEventBase & { type: 'turn.stuck'; kind: 'reread' | 'refail'; message: string })
  | (ChatEventBase & { type: 'model.switch-cost'; from: string; to: string; contextTokens: number; cacheWarm: boolean; usd: number | null; /** how many ordinary cached messages the re-write costs (write price / read price) */ turns: number })
  /** Kora resumed a thread whose cache had expired from a copy with old tool outputs elided (session/prune.ts). */
  | (ChatEventBase & { type: 'context.trimmed'; stubbed: number; tokensSaved: number; contextBefore: number })
  | (ChatEventBase & { type: 'context.compacted'; trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number })
  | (ChatEventBase & { type: 'account.updated'; account: AccountInfo })
  | (ChatEventBase & { type: 'model.rerouted'; from?: string; to: string; reason?: string })
  /** Auto model (session/auto-model.ts): the thread's model was picked from its first prompt, or moved up once (escalated). */
  | (ChatEventBase & { type: 'model.auto'; model: string; reason: string; escalated: boolean; advisor?: string })
  /** A Blobs transcript card (job, proposal, memory receipt, self-change, rate-limit). The ui-server validates `card` and
   *  maps it to the `blob.card` activity; the runtime only ever passes it through. */
  | (ChatEventBase & { type: 'blob.card'; card: unknown })
  | (ChatEventBase & { type: 'runtime.warning'; message: string })
  | (ChatEventBase & { type: 'runtime.error'; errorClass: 'provider' | 'transport' | 'permission' | 'validation' | 'unknown'; message: string });

export type ChatEventType = ChatEvent['type'];
/** Narrow a ChatEvent to one variant by its `type`. */
export type ChatEventOf<T extends ChatEventType> = Extract<ChatEvent, { type: T }>;

/** Distribute Omit across a union so every member keeps its own shape. */
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
/**
 * What a driver / interceptor emits BEFORE the SessionManager stamps the gap-free `seq`.
 * `threadId`/`at` are optional here too — the manager fills any the driver left blank so a
 * pure mapper can emit `{ type, ... }` payloads and the envelope is completed centrally.
 */
export type UnsequencedChatEvent = DistributiveOmit<ChatEvent, 'seq' | 'threadId' | 'at'> & {
  threadId?: ThreadId;
  at?: number;
};

// ── thread head (persisted; §01 §8, listed by chat.thread.list) ────────────────
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
export type PermissionMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access';
export type ThreadRuntimeState = 'idle' | 'running' | 'waiting' | 'stopped' | 'error';
/** Chat | Orchestrator | Swarm (the composer toggle). Mirrors contracts `ThreadAgentMode`. */
export type ThreadAgentMode = 'chat' | 'orchestrator' | 'swarm';
/**
 * Modes that wire the fleet tools — every mode now: a plain chat delegates too, but only through kora_spawn (headless
 * CLI workers in panes), never the harness's own subagents. Unknown values fail closed.
 */
export function isFleetAgentMode(m: ThreadAgentMode | null | undefined): boolean { return m === 'chat' || m === 'orchestrator' || m === 'swarm'; }
/** A mode switch Claude has not been told about yet (persisted on ThreadMeta; delivered by the ui-server). */
export interface PendingModeNotice { from: ThreadAgentMode; to: ThreadAgentMode; text: string }

export interface ChatThreadInfo {
  id: string;
  title: string;
  agent: AgentId;
  cwd: string;
  account: string | null;
  model: ModelChoice | null;
  /** Deprecated, derived: `isFleetAgentMode(agentMode)` ("fleet tools wired"). Existing gates keep reading it. */
  isOrchestrator: boolean;
  /** The thread's mode. Optional because meta.json written before swarm lacks it (read as isOrchestrator ? 'orchestrator' : 'chat'). */
  agentMode?: ThreadAgentMode;
  state: ThreadRuntimeState;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  workerPaneIds: string[];
  archived?: boolean;
  pinned?: boolean;
  worktree?: string | null;
}

// ── provider-instance catalog (§03 §5; owned by §01 RPC) ───────────────────────
export interface ProviderInstanceEntry {
  instanceId: string; // stable routing key: `${agentId}:${accountLabel}`
  driverKind: AgentId;
  displayName: string;
  accountLabel: string | null;
  accentColor: string;
  icon: string;
  status: 'ready' | 'unauthenticated' | 'disabled';
  installed: boolean;
}
export interface ModelEsque {
  slug: string; name: string; shortName?: string; badge?: 'new';
  isDefault?: boolean; isLegacy?: boolean; isUnavailable?: boolean; effortLevels?: string[];
}

import type { LedgerSummary } from '../ledger/transcript';
import type { ChatThreadInfo, PendingModeNotice, ThreadAgentMode } from '../session/events';
export type { LedgerSummary };
// kora wire protocol — newline-delimited JSON-RPC 2.0 over a unix domain socket.
// Server socket: $KORA_SOCKET_PATH, default ~/.kora/kora.sock
// Every request: { jsonrpc:"2.0", id, method, params }. Notifications from server have no id.
// ALL FOUR WORKSTREAMS BUILD AGAINST THIS FILE. Add fields, never rename or remove.

export type AgentState = 'working' | 'blocked' | 'idle' | 'unknown';
export type AgentId =
  | 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'koragent' | 'cursor' | 'copilot' | 'amp' | 'droid' | 'grok'
  | 'kimi' | 'qwen' | 'aider' | 'shell' | 'unknown'
  // Phase 7 engines: generated ids of ACP agents (`acp-hermes`) and API endpoints (`api-groq`)
  | `acp-${string}` | `api-${string}`;

export interface PaneInfo {
  id: string;             // "p1", "p2" — stable for the server's life
  workspaceId: string;    // "w1"
  name: string;           // user label or command basename
  command: string;        // argv[0]
  args: string[];
  cwd: string;
  pid: number | null;
  agent: AgentId;         // detected or declared agent
  state: AgentState;      // from screen detection
  blocker: string | null; // short text of what the agent is waiting on, when blocked
  exited: boolean;
  exitCode: number | null;
  createdAt: number;      // epoch ms
  lastOutputAt: number;   // epoch ms
  cols: number;
  rows: number;
  title: string;          // OSC 0/2 title
  agentSessionId: string | null; // reported by hooks (claude session_id etc.)
  graph: PaneGraphInfo;   // koragraph status for this pane's cwd
  ledger?: LedgerSummary | null; // real token usage from the agent's transcript, once the session is known
  worktree: { path: string; branch: string; mainRoot: string; dirty?: number; ahead?: number } | null; // this agent's own checkout
  launched: boolean;      // false while the pane is waiting for the first index (progress bar shown)
  budgetUsd?: number | null;                       // dollar budget for this pane (null = none)
  budgetState?: 'ok' | 'warn' | 'over' | null;     // from the ledger: warn at 80%, over at 100% (the agent is told, never killed)
  lastCompactAt?: number | null;                   // epoch ms of the last /compact kora sent (manual or auto)
  liveCwd?: string | null;                         // where the pane's process is NOW (a shell after `cd`); graph state follows it
  sizeOwnerConnId?: string | null;                 // the connection that owns this pane's geometry: pane.focus claims it, and pane.resize from any other connection is ignored (multi-frontend: TUI + GUI sharing a pane don't fight over cols/rows). null = unclaimed.
  // ---- orchestration (fleet) ----
  role?: 'orchestrator' | 'worker' | null;         // a promoted orchestrator pane, or a worker it spawned
  account?: string | null;                         // credential profile this pane's agent runs under (per-account isolation)
  orchestratorId?: string | null;                  // the orchestrator pane that owns this worker
  steeredAt?: number | null;                       // epoch ms of the last unsolicited human steer of this worker
  /** The worker's agent stopped on a transient API/network error (server/error-stall.ts); kora sends "continue" up to a cap. */
  errorStall?: { line: string; at: number; retries: number; retrying: boolean } | null;
  // ---- swarm ----
  swarm?: SwarmWorkerMeta | null;                  // set by SwarmService on a swarm worker (agent 'opencode'); null otherwise
  // ---- worker boxes (docs/fleet/WORKER-BOXES.md) ----
  /** 'gui' = the worker has a structured feed (a DriverPane, a swarm/Koragent worker); absent = terminal only. */
  surface?: 'gui' | 'terminal';
  model?: string | null;
  costUsd?: number | null;
  contextPct?: number | null;
  pendingApproval?: { requestId: string; title: string } | null;
  /** A DriverPane retrying a turn that failed on a transient error. */
  retrying?: { attempt: number; max: number; message: string; nextAt: number | null } | null;
  /** GUI worker: when its last turn completed (null while a turn runs or before the first). Kept on the runtime pane, so a
   *  ui-server restart still shows "Done". */
  turnEndedAt?: number | null;
}
export type RestartMode = 'resume' | 'cheap' | 'fresh';

export interface PaneGraphInfo {
  repoRoot: string | null;
  indexed: boolean;
  nodes: number;
  edges: number;
  lastIngestAt: number | null;
  enforced: boolean;      // enforcement adapter installed for this agent in this cwd
  indexing?: { phase: string; pct: number; files: number; filesTotal?: number; elapsedMs: number; etaMs: number } | null; // first index in progress (pane shows a bar); files = done so far, filesTotal once the store reports it
  incomplete?: boolean;          // a first/full index of this repo died or failed part-way: the store holds a partial graph (indexed is then false)
  firstIndexRunning?: boolean;   // the repo's first full index is running right now: partial graph, indexed is false until it lands
  storeError?: string;           // the graph store itself cannot be read (corrupt file): re-indexing moves it aside and rebuilds
  indexedFrom?: string | null;   // the checkout the store row was indexed from, when it is not this one
  staleForCheckout?: boolean;    // a sample of indexed files is missing here: the index is from a different copy/revision
  // freshness: the commit the index was built at vs the checkout's HEAD. stale = they differ (the runtime then
  // re-indexes incrementally in the background; the header says "stale · reindexing"). null when unknown.
  indexedSha?: string | null;
  headSha?: string | null;
  stale?: boolean;
  dirtyFiles?: number;    // uncommitted source files newer than the last ingest (stale is then true even though HEAD matches)
  toolCalls: number;      // graph tool calls made from this pane (via CLI/hook/MCP bridge)
  toolCallsByChannel?: Partial<Record<GraphChannel, number>>; // which channel actually drove each call
}

export interface WorkspaceInfo { id: string; name: string; cwd: string; paneIds: string[]; activePaneId: string | null; }

// ---- orchestration (fleet) ----
export interface RosterEntry { paneId: string; agent: AgentId; account: string | null; state: AgentState; blocker: string | null; steered: boolean; }
export interface FleetEvent { at: number; kind: 'worker-done' | 'human-steered' | 'blocked' | 'plan' | 'merged'; text: string; workerId?: string; }
// A pre-merge conflict check between two workers' diffs. semantic = A's change breaks a call site inside B's diff
// (git would merge it clean); needs-human = the graph can't be sure (a brand-new symbol / dynamic reference).
/** One coupling the merge gate found between two refs. `kind`: 'dependent' = a base-graph dependent of a touched symbol
 *  lives in the other side's changed file; 'reference' = a line the other side ADDED names the touched symbol (a new
 *  caller the index cannot know). `inHunk`: the other side edited that very line. `removed`: the symbol no longer
 *  exists on the side that touched it (renamed / deleted) — its callers are certainly broken. */
export interface MergeBlame { file: string; line: number; symbol: string; byWorker: string; kind?: 'dependent' | 'reference'; inHunk?: boolean; removed?: boolean; /** every call the other side's file makes to this symbol fits its NEW signature (arity check) */ compatible?: boolean }
export interface MergePair { a: string; b: string; status: 'clean' | 'semantic' | 'needs-human'; blame?: MergeBlame[]; /** why a pair is not clean, in words (a needs-human without a reason is useless to the orchestrator) */ reason?: string; }

// A rendered screen cell. attrs bitfield: 1 bold, 2 italic, 4 underline, 8 inverse, 16 dim
export interface Cell { ch: string; fg: number; bg: number; attrs: number; wide?: boolean }
export interface ScreenSnapshot { paneId: string; cols: number; rows: number; cursorX: number; cursorY: number; cursorVisible: boolean; lines: Cell[][]; altScreen: boolean; }

// ---- methods (request → result) ----
export interface Methods {
  'server.ping': { params: {}; result: { ok: true; version: string; pid: number; uptimeMs: number } };
  'server.status': { params: {}; result: { version: string; panes: number; workspaces: number; socket: string; ui?: { port: number; url: string } | null; uiError?: string; graph: { db: string; repos: number }; memory?: { rssMb: number; heapUsedMb: number; liveChatSessions: number; uptimeS: number; stalls: { count: number; maxMs: number; lastAt: number } } } };
  'server.shutdown': { params: {}; result: { ok: true } };

  'pane.list': { params: { workspaceId?: string }; result: { panes: PaneInfo[] } };
  'pane.get': { params: { paneId: string }; result: PaneInfo };
  // spawn: command defaults to the user's shell. agent declares which enforcement adapter to prepare.
  'pane.spawn': { params: { command?: string; args?: string[]; cwd?: string; agent?: AgentId; name?: string; workspaceId?: string; cols?: number; rows?: number; env?: Record<string, string>; enforce?: boolean; budgetUsd?: number }; result: PaneInfo };
  'pane.kill': { params: { paneId: string; signal?: string }; result: { ok: true } };
  'pane.write': { params: { paneId: string; text?: string; base64?: string }; result: { ok: true } };
  'pane.resize': { params: { paneId: string; cols: number; rows: number }; result: { ok: true } };
  // read: source 'screen' = viewport as the user sees it; 'detection' = bottom buffer detection uses; 'scrollback' = last N lines
  'pane.read': { params: { paneId: string; source?: 'screen' | 'detection' | 'scrollback'; format?: 'text' | 'ansi'; lines?: number }; result: { text: string } };
  'pane.snapshot': { params: { paneId: string }; result: ScreenSnapshot };
  'pane.focus': { params: { paneId: string }; result: { ok: true } };
  'pane.rename': { params: { paneId: string; name: string }; result: { ok: true } };
  // restart: respawn an exited (or running → killed) pane with the same command/cwd/agent/worktree.
  // mode (default: config.restartMode): 'resume' = `--resume <session>` (re-sends the whole old conversation at cache-write
  // price); 'cheap' = a fresh session with a distilled brief written to ~/.kora/panes/<newPaneId>/resume-brief.md, which the
  // SessionStart hook includes once and deletes; 'fresh' = new session, no brief.
  'pane.restart': { params: { paneId: string; mode?: RestartMode }; result: PaneInfo };
  // called by hooks inside the pane (claude SessionStart etc.)
  'pane.reportAgentSession': { params: { paneId: string; agent: AgentId; agentSessionId: string; transcriptPath?: string }; result: { ok: true } };
  // the agent's own turn state, from its hooks (Claude: prompt/pre-tool/post-tool → working, stop → idle)
  'pane.reportState': { params: { paneId: string; state: 'working' | 'idle'; source?: string }; result: { ok: true } };
  // called by hooks / graph CLI so the sidebar can show "graph used N times"
  // channel: which of the enforcement channels produced this call. The only honest way to learn whether
  // MCP earns its standing schema cost is to count calls per channel over real sessions.
  'pane.reportGraphUse': { params: { paneId: string; tool: string; ms?: number; channel?: GraphChannel }; result: { ok: true } };

  'agent.list': { params: {}; result: { agents: PaneInfo[] } };
  // worktree: give the agent its own git worktree + branch (default: yes when cwd is a git repo with commits)
  // orchestratorId: when set, the new pane is that orchestrator's WORKER (role='worker'); account = its credential profile.
  // swarm additions (SwarmService is the only caller today): command = an absolute binary overriding agentCommand(agent);
  // env = merged into the pane env; reuseWorktree = spawn in this existing worktree (failover) instead of creating one;
  // skipWorkerPermission = add NO skipPermissionArgs (the swarm path owns the worker's permission argv).
  'agent.spawn': { params: { agent: AgentId; cwd?: string; args?: string[]; name?: string; prompt?: string; workspaceId?: string; worktree?: boolean; budgetUsd?: number; orchestratorId?: string; account?: string; command?: string; env?: Record<string, string>; reuseWorktree?: { path: string; branch: string; mainRoot: string } | null; skipWorkerPermission?: boolean; isolatedEnv?: boolean; eventStream?: boolean; paneId?: string }; result: PaneInfo };
  'worktree.list': { params: { cwd?: string }; result: { worktrees: { path: string; branch: string; mainRoot: string; head: string | null; paneId: string | null; dirty: number; ahead: number }[] } };
  'worktree.merge': { params: { paneId?: string; path?: string; into?: string; commitFirst?: boolean }; result: { ok: boolean; merged: string | null; into: string | null; conflicts: string[]; message: string; commitsMerged: number } };
  'worktree.remove': { params: { paneId?: string; path?: string; force?: boolean; deleteBranch?: boolean }; result: { ok: boolean; message: string } };
  'worktree.sweep': { params: { dryRun?: boolean }; result: { scanned: number; removed: string[]; orphans: { path: string; branch: string | null; dirty: number; ahead: number }[]; parked: string[]; busy: string[]; errors: { path: string; message: string }[]; reclaimedBytes?: number; branchesDeleted?: string[]; branchesKept?: { root: string; branch: string; ahead: number }[] } };
  // prompt: types text into the agent and presses Enter (submit=true). Waits for idle first if waitIdle.
  'agent.prompt': { params: { paneId: string; text: string; submit?: boolean; waitIdle?: boolean; timeoutMs?: number }; result: { ok: true; state: AgentState } };
  // wait: resolves when the agent reaches `until` (default: blocked|idle i.e. "needs a human"), or times out.
  // afterChange: first wait for the NEXT state change (or exit), then apply `until`. Use it right after sending
  // input, otherwise a pane that is already blocked/idle satisfies the wait instantly and you act on stale state.
  'agent.wait': { params: { paneId: string; until?: AgentState | 'needs-human'; timeoutMs?: number; afterChange?: boolean }; result: { state: AgentState; blocker: string | null; timedOut: boolean } };
  'agent.status': { params: { paneId: string }; result: { state: AgentState; blocker: string | null; agent: AgentId } };
  // promote: mark this pane the orchestrator and hand it the briefing (it then interviews the user in-pane, then
  // spawns workers with `kora agent spawn --orchestrator <this pane> …`). Agent-agnostic: any agent can be promoted.
  'agent.promote': { params: { paneId: string; briefing?: string }; result: { ok: true } };
  // assign: give an existing worker more work (waits idle, types, submits). Convenience over agent.prompt.
  'agent.assign': { params: { paneId: string; prompt: string }; result: { ok: true; state: AgentState } };
  // mergeVerify: the graph pre-merge gate — union blast-radius across the workers' worktrees. Returns each pair's
  // conflict status + a suggested merge order (clean/low-blast-radius first). Does NOT merge; the orchestrator does.
  'worktree.mergeVerify': { params: { paneIds?: string[]; worktreePaths?: string[] }; result: { pairs: MergePair[]; order: string[] } };
  // merge.verify: the STANDALONE graph-verified merge/PR gate (kora merge / kora pr / the desktop Merge view).
  // refs = branch names, SHAs, or on-disk worktree paths; the runtime resolves the repo root from cwd and the merge
  // gate runs against their common merge-base (or baseRef). Same engine, refs in, verdict out — no panes, no fleet.
  // targetRef: the branch the refs will be merged INTO; each ref is then diffed from its own merge-base with it (an
  // already-merged ref shows no changes). Without it (and without baseRef) the refs' common merge-base is used.
  'merge.verify': { params: { cwd: string; refs: string[]; baseRef?: string; targetRef?: string }; result: { pairs: MergePair[]; order: string[]; base: string; refs: string[]; bases?: Record<string, string> } };
  // fleet.get: the orchestrator's roster + plan + recent events, for the roster view.
  'fleet.get': { params: { orchestratorId: string }; result: { roster: RosterEntry[]; plan: string; events: FleetEvent[] } };
  // fleet.set: the orchestrator records its plan.
  'fleet.set': { params: { orchestratorId: string; plan?: string }; result: { ok: true } };
  // pending out-of-band notes for an orchestrator hosted outside the runtime (drained by the fleet MCP bridge)
  'fleet.drainNotes': { params: { orchestratorId: string }; result: { notes: string[] } };

  // ---- swarm (kept small: the ui-server calls SwarmSetup in-process through UiHost.swarm) ----
  // getStatus: readiness for `kora swarm status`; probe = re-detect opencode + drop caches (the CLI calls it after
  // writing keys / consent / an install in-process, so the daemon sees the change).
  'swarm.getStatus': { params: { probe?: boolean }; result: SwarmStatus };
  // reportEvent: the opencode plugin (`kora hook opencode-event`) reporting a worker's session status.
  'swarm.reportEvent': { params: SwarmPaneEvent; result: { ok: true } };
  /** An OpenCode swarm worker's plugin → its box feed (tool calls, text parts). */
  'pane.feed': { params: { paneId: string; items: unknown[] }; result: { ok: true } };
  // spawn: a swarm worker for an orchestrator hosted OUTSIDE the runtime (`kora mcp --fleet`, e.g. a Koragent lead
  // pane). Same guard as the in-process path: the orchestrator must be a Swarm-mode thread or an orchestrator pane.
  'swarm.spawn': { params: { orchestratorId: string; cwd: string; task: string; title?: string; runtimeMode?: string; permission?: 'supervised' | 'auto-edits' | 'full'; check?: string; queue?: boolean }; result: SwarmRemoteSpawnResult };
  // task: what the in-process SwarmSpawner answers from memory (taskForPane / note / lostInRestart) plus the report,
  // for the remote bridge's kora_wait / kora_read. `paneId` may be a task id ("s7") — a queued task with no pane yet.
  // Blobs: `kora mcp --blobs` (Codex / OpenCode blobs) asks the daemon which tools its blob session may use and runs them.
  'blobs.mcp.hello': { params: { blobId: string; token: string; threadId?: string }; result: { ok: true; chief: boolean; tools: Array<{ name: string; description: string; params: unknown }> } | { ok: false; error: string } };
  'blobs.mcp.call': { params: { blobId: string; token: string; name: string; args?: Record<string, unknown>; threadId?: string }; result: { text: string; isError?: boolean; image?: { data: string; mimeType: string } } };
  // Blobs: `kora mcp --team` (outside access): an outside MCP client's token is checked by the daemon on every call.
  'blobs.outside.hello': { params: { token: string }; result: { ok: boolean; client?: string; tools?: Array<{ name: string; description: string; params: unknown; maxSeconds?: number }>; error?: string } };
  'blobs.outside.call': { params: { token: string; tool: string; args?: unknown; clientInfo?: { name?: string; version?: string } }; result: { text: string; isError?: boolean } };
  'swarm.task': { params: { paneId: string; report?: boolean }; result: SwarmRemoteTask };
  // finished: this orchestrator's tasks that finished before a daemon restart (no pane any more; kora_workers lists them).
  'swarm.finished': { params: { orchestratorId: string }; result: { tasks: SwarmFinishedTask[] } };
  // queued: this orchestrator's queued (not yet started) swarm tasks, FIFO order (kora_workers lists them).
  'swarm.queued': { params: { orchestratorId: string }; result: { tasks: SwarmQueuedTask[] } };
  // setAgentMode: flip a chat thread's mode; persists the pending mode notice (e2e scripts and tests).
  /** Workers asleep after work / wake one / one's history (server/worker-sleep.ts), for the fleet bridge. */
  'worker.asleep': { params: { orchestratorId: string }; result: { workers: import('../server/fleet-ops').SleepingWorker[] } };
  'worker.wake': { params: { orchestratorId: string; id: string }; result: { paneId: string; resumed?: boolean; rebriefed?: boolean } };
  'worker.history': { params: { orchestratorId: string; id: string; maxEntries?: number }; result: { text: string | null } };
  /** A lead's worker picker (kora_ask_workers over the fleet bridge): blocks until the user answers in the app. */
  'chat.workers.ask': { params: { orchestratorId: string; picks: import('../session/worker-picker').WorkerPick[] }; result: import('../session/worker-picker').WorkerPickerAnswer };
  'chat.thread.setAgentMode': { params: { threadId: string; agentMode: ThreadAgentMode }; result: { thread: ChatThreadInfo; notice: PendingModeNotice | null } };

  // koragraph tools, in-process. name ∈ explore|search_code|neighbours|changes_with|blast_radius|file_symbols|overview
  // fresh (default true): run koragraph's live-freshness pass (git status + incremental ingest) first. The prompt hook
  // passes false — it has a 7 s budget and a few seconds of staleness cost nothing.
  'graph.tool': { params: { name: string; args: Record<string, unknown>; cwd?: string; paneId?: string; channel?: GraphChannel; fresh?: boolean }; result: { text: string; data: unknown; ms: number } };
  'graph.status': { params: { cwd?: string }; result: PaneGraphInfo };
  'graph.ingest': { params: { path: string; project?: string; wait?: boolean }; result: { ok: true; nodes?: number; edges?: number } };
  'graph.brief': { params: { cwd: string; agent?: AgentId }; result: { text: string } };

  // ledger: real token usage + counterfactual savings, from the agent's own transcript
  'ledger.get': { params: { paneId: string; full?: boolean }; result: { summary: LedgerSummary | null } };
  'ledger.summary': { params: {}; result: { panes: { paneId: string; summary: LedgerSummary }[]; totals: { costUsd: number; cacheSavedUsd: number; context: number; graphCalls: number; reads: number; greps: number } } };

  // compaction: send `/compact` to a claude pane (the single biggest per-turn saver once context is large)
  'pane.compact': { params: { paneId: string }; result: { ok: boolean; sent: boolean; reason?: string } };
  // prelaunch: the `claude`/`codex` shim calls this just before exec inside a plain shell pane — the agent is about to
  // start HERE, so set the repo up (hooks + rulebook) and warm its graph exactly as a spawned pane would.
  'pane.prelaunch': { params: { paneId: string; agent: AgentId; cwd: string }; result: { ok: true; repoRoot: string | null; indexed: boolean; indexing: boolean } };
  // index: (re-)index the repo the pane is in, with the progress bar in the tab bar (ctrl+b i)
  'pane.index': { params: { paneId: string }; result: { ok: boolean; repoRoot: string | null; message: string } };
  'config.get': { params: {}; result: { config: Record<string, unknown>; path: string } };
  'config.set': { params: { patch: Record<string, unknown> }; result: { config: Record<string, unknown> } };

  'events.subscribe': { params: { paneOutput?: boolean; paneIds?: string[] }; result: { ok: true } };
  'events.unsubscribe': { params: {}; result: { ok: true } };
}

export type GraphChannel = 'mcp' | 'cli' | 'shim' | 'hook';
export type MethodName = keyof Methods;

// ---- notifications (server → subscribed clients) ----
export interface Notifications {
  'pane.created': PaneInfo;
  'pane.closed': { paneId: string; exitCode: number | null };
  'pane.updated': PaneInfo;                       // state/title/name/graph changed
  // one item of a GUI worker's feed changed (server/worker-feed.ts; the worker box renders it)
  'pane.feed': { paneId: string; item: import('../server/worker-feed').WorkerFeedItem };
  'pane.output': { paneId: string; base64: string }; // only when subscribed with paneOutput
  'agent.state': { paneId: string; state: AgentState; blocker: string | null; previous: AgentState };
  'workspace.updated': { workspaces: WorkspaceInfo[]; activeWorkspaceId: string | null };
  'graph.used': { paneId: string | null; tool: string; ms: number; channel: GraphChannel };
  'ledger.updated': { paneId: string; summary: LedgerSummary };
  'pane.compacted': { paneId: string; auto: boolean; contextBefore: number };
  // the runtime answered a known-safe dialog for the agent (trust folder / new MCP server / read outside the worktree); logged too
  'pane.autoAnswered': { paneId: string; kind: 'trustFolder' | 'mcpFound' | 'readOutsideWorktree' | 'editApproval'; detail: string };
  // budget crossed 80% (warn) or 100% (over)
  'pane.budget': { paneId: string; state: 'warn' | 'over'; costUsd: number; budgetUsd: number };
  // one-line notice for the status bar (e.g. "set up claude hooks + rulebook for <repo>")
  'pane.notice': { paneId: string | null; text: string };
  // an UNSOLICITED human steer of a worker pane (a human typed a redirect into it): the owning orchestrator is
  // notified out of band and re-plans. This is the loop competitors leave open — steering that feeds back.
  'pane.steered': { paneId: string; orchestratorId: string; origin: 'human'; text: string; state: AgentState };
  // fleet roster/plan/event updates for the orchestrator's side strip
  'fleet.roster': { orchestratorId: string; roster: RosterEntry[] };
  'fleet.plan': { orchestratorId: string; plan: string; becauseOf?: string };
  'fleet.event': { orchestratorId: string; event: FleetEvent };
  // swarm readiness changed (install progress included)
  'swarm.status': SwarmStatus;
  // a swarm worker happening (report written / failover / exhausted / bounced by verify)
  'swarm.worker': { orchestratorId: string; event: SwarmWorkerEvent };
  'server.shutdown': {};
}

export interface RpcRequest { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown; /** The control capability (the UI token) for privileged methods; see server/control-auth.ts. */ auth?: string; /** Who is calling without the token: the agent's own pane or `chat:<thread>` id (server/control-auth.ts scopes token-less calls to that caller's fleet). */ caller?: string; /** Proof of `caller` (KORA_CALLER_KEY, control-auth.ts callerKey): a caller without it is no caller. */ callerKey?: string }
export interface RpcNotification { jsonrpc: '2.0'; method: string; params?: unknown; auth?: string; caller?: string; callerKey?: string }
export interface RpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

// ---- environment contract injected into every spawned pane ----
export const PANE_ENV = {
  KORA_ENV: '1',              // "you are inside kora"
  KORA_PANE_ID: '<pane id>',
  KORA_CALLER_KEY: '<proof of KORA_PANE_ID for token-less socket calls (server/control-auth.ts callerKey)>',
  KORA_SOCKET_PATH: '<socket>',
  KORA_BIN: '<abs path to bin/kora.js>',
  KORA_AGENT: '<AgentId>',
  KORA_REPO_ROOT: '<repo root or empty>',
  KORAGRAPH_DB: '<inherited if set>',
  // ---- swarm workers only (set by swarmPaneEnv) ----
  KORA_REPORT: '<abs path of the report file the worker must write>',
  KORA_SWARM_TASK_ID: '<swarm task id, e.g. s3>',
  KORA_SWARM_MODEL: '<opencode -m model id>',
  KORA_SWARM_PROVIDER: '<SwarmProviderId>',
  KORA_NODE: '<abs path of the node running the daemon (process.execPath)>',
} as const;

export const GRAPH_TOOLS = ['explore', 'search_code', 'neighbours', 'changes_with', 'blast_radius', 'file_symbols', 'overview'] as const;
export type GraphTool = typeof GRAPH_TOOLS[number];

export function defaultSocketPath(): string {
  const os = require('node:os');
  const path = require('node:path');
  // Under KORA_HOME (a second install such as Kora Dev's ~/.kora-dev), never the default home's socket.
  return process.env.KORA_SOCKET_PATH || path.join(process.env.KORA_HOME || path.join(os.homedir(), '.kora'), 'kora.sock');
}
export function koraHome(): string {
  const os = require('node:os');
  const path = require('node:path');
  return process.env.KORA_HOME || path.join(os.homedir(), '.kora');
}

// ---- swarm (TS mirrors of packages/contracts/src/swarm.ts + fleet.ts FleetSwarm*) ----
// The runtime does not import @kora/contracts. These interfaces MUST stay key-for-key equal to the Effect schemas;
// server/swarm-contract.test.ts (runtime) + contracts/src/swarm.test.ts pin both to contracts/src/fixtures/*.json.
// Wire rule: nullable fields are `T | null`, never optional-undefined.

export type SwarmProviderId = 'zen' | 'openrouter' | 'cerebras';
/** Local model servers (no key; nothing leaves the machine). Workers on them carry this as their provider. */
export type SwarmLocalProviderId = 'ollama' | 'lmstudio';
/** Any provider a worker/model can be on: the keyed remote ones plus the local servers (contracts SwarmProviderId). */
export type SwarmSupplyProviderId = SwarmProviderId | SwarmLocalProviderId;
export type SwarmBlockerCode = 'opencode-missing' | 'opencode-too-old' | 'koragent-missing' | 'koragent-too-old' | 'consent-missing' | 'no-provider' | 'all-models-cooling';
export interface SwarmBlocker { code: SwarmBlockerCode; message: string }
export type SwarmOpencodeSource = 'config' | 'kora' | 'path' | 'opencode-home' | 'homebrew' | 'bun' | 'local';
export interface SwarmOpencodeStatus {
  installed: boolean; path: string | null; source: SwarmOpencodeSource | null; version: string | null;
  minVersion: string; versionOk: boolean; onDaemonPath: boolean;
}
export type SwarmInstallPhase = 'idle' | 'downloading' | 'extracting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
export interface SwarmInstallState {
  operationId: string | null; phase: SwarmInstallPhase; downloadedBytes: number; totalBytes: number | null;
  version: string | null; installedVersion: string | null; message: string | null;
}
export interface SwarmConsentState { requiredVersion: number; acceptedVersion: number | null; acceptedAt: number | null }
export interface SwarmProviderLimits {
  requestsPerMinute: number | null; requestsPerDay: number | null; remainingToday: number | null;
  resetsAt: number | null; isFreeTier: boolean | null;
}
export type SwarmTestOutcome = 'ok' | 'invalid-key' | 'rate-limited' | 'unreachable' | 'no-free-models' | 'opencode-missing';
export interface SwarmProviderTestResult {
  ok: boolean; outcome: SwarmTestOutcome; message: string | null; freeModels: string[];
  latencyMs: number | null; testedAt: number; limits: SwarmProviderLimits | null;
}
export type SwarmKeySource = 'kora' | 'env' | 'opencode-auth';
export interface SwarmProviderStatus {
  provider: SwarmProviderId; enabled: boolean; keyRequired: boolean; hasKey: boolean;
  keySource: SwarmKeySource | null; keyHint: string | null;
  lastTest: SwarmProviderTestResult | null; limits: SwarmProviderLimits | null;
}
export interface SwarmModelInfo { id: string; provider: SwarmSupplyProviderId; label: string; rank: number; maxConcurrent: number | null }
export interface SwarmModelCooling { model: string; provider: SwarmSupplyProviderId; until: number; reason: string }
export interface SwarmPreferences { providerOrder: SwarmProviderId[]; defaultModel: string | null; maxWorkers: number }
export type SwarmKeyStorage = 'file';
export interface SwarmStatus {
  ready: boolean;
  blockers: SwarmBlocker[];
  opencode: SwarmOpencodeStatus;
  install: SwarmInstallState;
  consent: SwarmConsentState;
  providers: SwarmProviderStatus[];          // preference order
  models: { available: SwarmModelInfo[]; cooling: SwarmModelCooling[] };
  preferences: SwarmPreferences;
  /** The paid / local supply settings in the wire shape (contracts SwarmSupplyState). */
  supplyState?: { supply: 'free-first' | 'paid-first' | 'local-only'; paid: { enabled: boolean; maxTaskUsd: number; models: string[] }; local: Record<'ollama' | 'lmstudio', { enabled: boolean; baseUrl: string; models: string[] }> };
  keyStorage: SwarmKeyStorage;
  checkedAt: number;                         // epoch ms
  /** The worker backend (config swarm.workerBackend) and, for koragent, its resolved binary. Absent = opencode. */
  workerBackend?: SwarmWorkerBackendStatus;
}
/** Which program runs swarm workers: `opencode` (the frozen default) or `koragent` (event-driven). */
export type WorkerBackendId = 'opencode' | 'koragent';
export interface SwarmWorkerBackendStatus {
  id: WorkerBackendId; installed: boolean; path: string | null; source: string | null;
  /** koragent only: `--version` (null = no answer), the gate, and the sha256 pin (null = not installed by Kora). */
  version?: string | null; minVersion?: string; versionOk?: boolean; pinned?: string | null; pinOk?: boolean | null;
}
export interface SwarmStreamEvent { type: 'snapshot'; status: SwarmStatus }
/** Every swarm setup failure; `message` is safe to show (never contains a key). Mirrors contracts SwarmOperationError. */
export interface SwarmOperationError { operation: string; message: string }

// workers
export type SwarmWorkerPhase = 'starting' | 'running' | 'rate-limited' | 'respawning' | 'exhausted' | 'failed' | 'done' | 'queued';
export interface SwarmAttempt {
  paneId: string; provider: SwarmSupplyProviderId; model: string;
  /** 'stalled' = the watchdog moved the task off a slow / silent worker. */
  outcome: 'running' | 'ok' | 'rate-limited' | 'model-gone' | 'crashed' | 'auth-failed' | 'stalled' | 'unreachable'; at: number;
}
export interface SwarmReportRef { bytes: number; updatedAt: number; preview: string /* ≤280 chars */ }
/** Verify-and-bounce state (PLAN X2). Same name and shape as the contracts schema `FleetSwarmVerify`. */
export interface FleetSwarmVerify { state: 'pending' | 'passed' | 'bounced' | 'failed' | 'skipped'; bounces: number; summary: string | null }
/** What a kind of tool call is, for the thought-bubble label (contracts `FleetSwarmActivity_.kind`). */
export type SwarmStepKind = 'read' | 'search' | 'fetch' | 'write' | 'think' | 'run' | 'other';
/**
 * A swarm worker's latest step ("reading imdb.com", "writing report"), from its newest tool call (or a
 * text/reasoning part newer than any tool call, reported as "thinking…"). Same shape as the contracts schema
 * `FleetSwarmActivity_` / `FleetSwarmStep`. `text` is ≤48 chars.
 */
export interface SwarmStep { text: string; at: number; kind: SwarmStepKind }
/** On `Pane.swarm` / `PaneInfo.swarm`. The contracts `FleetSwarmWorker` is exactly this minus `reportPath`. */
export interface SwarmWorkerMeta {
  taskId: string;
  provider: SwarmSupplyProviderId;
  model: string;                             // opencode -m id
  modelLabel: string;
  phase: SwarmWorkerPhase;
  attempt: number;                           // 1-based
  attempts: SwarmAttempt[];
  reportPath: string;                        // absolute; $KORA_REPORT
  report: SwarmReportRef | null;
  supersededBy: string | null;               // replacement pane after a failover
  previousPaneIds: string[];
  verify: FleetSwarmVerify | null;
  /** The foreman stage (done-check, auto-retry, reviewer) across every attempt; absent/null when it is off. */
  foreman?: SwarmForemanState | null;
  /** The worker's latest step (thought bubble); absent/null when unknown. */
  step?: SwarmStep | null;
}
/** Why the foreman did not accept an attempt. */
/** report = the worker's own report says failed / partial / blocked / budget; no-change = an edit task with no diff. */
export type SwarmForemanFailure = 'check' | 'gate' | 'no-report' | 'crashed' | 'reviewer' | 'report' | 'no-change';
/** One run of the leader's done-check (`kora_spawn check`) in the worker's worktree. */
export interface SwarmForemanCheck { state: 'passed' | 'failed' | 'timeout' | 'error'; exitCode: number | null; durationMs: number; tail: string }
/** The optional free-model reviewer's answer (`error` = it could not answer; never fails the attempt). */
export interface SwarmForemanReview { verdict: 'pass' | 'fail' | 'error'; model: string | null; reasons: string }
/** The foreman's verdict on one attempt. */
export interface SwarmForemanVerdict {
  attempt: number;                           // 1-based foreman attempt
  paneId: string;
  model: string;
  check: SwarmForemanCheck | null;
  gate: FleetSwarmVerify['state'] | null;    // the X2 merge gate's final state for this attempt
  review: SwarmForemanReview | null;
  failure: SwarmForemanFailure | null;       // null = accepted
  durationMs: number;                        // attempt start → verdict
  at: number;
}
/** What the leader gets when the foreman is done: PASS, or a short escalation. */
export interface SwarmForemanResult {
  kind: 'pass' | 'escalation';
  attempts: number;
  worktree: string | null;
  diffStat: string | null;                   // e.g. "3 files changed, 40 insertions(+)"
  checkTail: string | null;                  // pass: the check output's last lines
  lastFailure: string | null;                // escalation: the last failure excerpt
}
export interface SwarmForemanState {
  state: 'working' | 'checking' | 'retrying' | 'passed' | 'escalated';
  attempt: number;                           // current foreman attempt, 1-based
  maxAttempts: number;                       // 1 + swarm.foremanRetries
  check: string | null;                      // the done-check command, if any
  review: boolean;                           // the reviewer gate is on for this task
  verdicts: SwarmForemanVerdict[];
  result: SwarmForemanResult | null;
}
/** The opencode plugin → `swarm.reportEvent` (via `kora hook opencode-event`). */
/** `swarm.spawn` result (mirrors server/swarm.ts SwarmSpawnResult; kept structural so the protocol has no server import).
 *  `paneId` is null and `queued` is true when the caller opted in (`queue: true`) and every slot was busy: the task
 *  still gets a stable `taskId` and starts automatically once a slot frees (kora_wait/kora_workers/kora_read accept
 *  the task id in place of a pane id). */
export interface SwarmRemoteSpawnResult {
  paneId: string | null; taskId: string; provider: string; model: string; modelLabel: string; reportPath: string;
  overlaps: { paneId: string; files: string[] }[];
  foreman?: { check: string | null; maxAttempts: number; review: boolean; checkRefused: string | null } | null;
  agent?: WorkerBackendId; permission?: 'supervised' | 'auto-edits' | 'full';
  queued?: boolean; queuePosition?: number;
  /** No git: the worker works in the folder itself, shared with the lead and the other workers. */
  sharedFolder?: boolean;
}
/** `swarm.queued` row: one task waiting for a slot. */
export interface SwarmQueuedTask { taskId: string; title: string; position: number }
/** `swarm.task` result: the task a (possibly replaced / pre-restart) pane belongs to. */
/** A swarm task that finished (done) before a daemon restart: its pane is gone, its worktree is still there. */
export interface SwarmFinishedTask { paneId: string; taskId: string; status: string; worktree: string; branch: string }
export interface SwarmRemoteTask {
  task: { taskId: string; orchestratorId: string; paneIds: string[]; reportPath: string; status: string } | null;
  note: string | null;
  lostInRestart: boolean;
  report: { text: string; truncated: boolean; updatedAt: number } | null;
}

export interface SwarmPaneEvent {
  paneId: string;
  type: 'session.status' | 'session.idle' | 'session.error';
  status?: 'busy' | 'idle' | 'retry';
  attempt?: number;
  message?: string;
  next?: number;                             // epoch ms of opencode's next retry
}
/** Runtime notification `swarm.worker`. `bounced` = verify-and-bounce sent findings back to the same worker. */
export interface SwarmWorkerEvent {
  kind: 'report' | 'failover' | 'exhausted' | 'bounced';
  paneId: string;
  taskId: string;
  newPaneId?: string;
  fromModel?: string;
  toModel?: string;
  tried?: string[];
  verify?: FleetSwarmVerify;
}

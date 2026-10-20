// SessionManager (§01 §6) — the daemon-side owner the chat.* RPC arms delegate to. Holds the live
// drivers, the thread store (§8), and the fan-out into the runtime's existing `notify` emitter.
//
// Every driver event flows through onEvent, which (1) stamps the gap-free `seq` (via the store),
// (2) appends to the persisted log, (3) updates the thread head (state, lastSeq, workerPaneIds),
// (4) re-emits on the Runtime's `notify` — the same channel pane.output/fleet.* use. No new emitter,
// no new socket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, PaneInfo } from '../protocol/types';
import { adapterFor } from '../detect/agent-adapter';
import { ChatThreadStore, type ThreadMeta } from './store';
import type { SessionDriver, DriverCapabilities, DriverDeps, DriverBlobs, OpencodeDeps, SessionStartInput, SessionPrep } from './session-driver';
import { resolveBlobRuntimeMode } from '../blobs/permissions';
import type { ThreadOrigin } from '../blobs/types';
import type { FleetOps } from '../server/fleet-ops';
import { chatDelegationPrompt, chatOrchestratorPrompt, chatWorkerPrompt } from '../server/orchestrator-skill';
import { loadWorkerCatalog, normalizeEffort, stretchPicks, type WorkerPick, type WorkerPickerAnswer } from './worker-picker';
import { chatSwarmPrompt, installSwarmSkill, swarmModeNotice } from '../server/swarm-skill';
import { isBlobsCwd } from '../blobs/home';
import { PLAN_MODE_GRAPH_NOTICE } from './plan-mode';
import { migrateTrustOnce, onTrustChange, resolveTrustRoot } from '../trust/store';
import type { SwarmSpawner } from './fleet-tools';
import { ClaudeDriver, DEFAULT_CHAT_EFFORT, proxyPaneId, type QueryFn } from './drivers/claude-driver';
import { restoreSnapshot, readSnapshot, dropSnapshot } from './compact-undo';
import { dropThreadFlags } from './thread-flags';
import { dropToolOut } from './bash-trim';
import { forgetFork } from './prune';
import { draftBriefForSession, type BriefResult } from './thread-brief';
import { parseQuickQuestion, parseQuickQuestionPlain, answerQuickQuestion, type QuickAnswer } from '../graph/quick-answer';
import { quickAnswersOn, autoModelOn, autoSonnetOn, autoAdvisorOn, autoHeadroomOn, autoEffortOn } from '../util/savings-settings';
import { PlanHeadroom, tightReason } from './plan-headroom';
import { retryableErrorText, ERROR_STALL_MAX_RETRIES, DRIVER_RETRY_DELAYS_MS, DRIVER_RATE_LIMIT_DELAYS_MS } from '../server/error-stall';
import { classifyPrompt, escalation, midEscalation, hasMidTier, midEffort, wantsCeiling, turnEffort, effortChangeCacheSafe, AUTO_LIGHT_MODEL, AUTO_MID_MODEL } from './auto-model';
import { firstPartyRoute, sideModelEnv } from '../util/side-model';
import { effectiveClaudeDefault } from '../util/claude-default-model';
/** The full id the Default runs (the ledger prices Auto's light calls against it): a bare alias names today's model. */
function ceilingModelId(configDir: string | null): string {
  const m = effectiveClaudeDefault(configDir ?? undefined).replace(/\[1m\]$/i, '');
  // The `haiku` alias runs Haiku 5.5 wherever Kora sets ANTHROPIC_DEFAULT_HAIKU_MODEL (side-model.ts), else Haiku 4.5.
  const haiku = sideModelEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL ?? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-4-5';
  return ({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku, fable: 'claude-fable-5-1' } as Record<string, string>)[m.toLowerCase()] ?? m;
}
/** The composer's Auto row (ui-server claudeModels.ts adds it). */
const AUTO_MODEL_SLUG = 'auto';
/** A light thread whose context reached this many tokens (Haiku 5.5's 5x tier starts at 100k) is not light work any more. */
// Below Haiku 5.5's own compaction point (100k): the move-up is decided before Haiku pays to compact (R6 review #9).
const AUTO_LIGHT_GROWN_TOKENS = 80_000;
import { logCost } from '../util/cost-log';
import { CodexDriver } from './drivers/codex-driver';
import { OpenCodeDriver } from './drivers/opencode-driver';
import { AntigravityDriver } from './drivers/antigravity-driver';
import { AcpDriver, type AcpEngine } from './drivers/acp-driver';
import { ApiDriver } from './drivers/api-driver';
import type { ApiEndpoint } from './drivers/api-providers';
import { shutdownCacheWarm } from '../cachewarm/manager';
import {
  isFleetAgentMode,
  type ChatEvent, type ChatThreadInfo, type ThreadId, type ModelChoice, type PromptAttachment,
  type ApprovalAnswer, type UserInputAnswers, type ThreadRuntimeState, type RuntimeMode, type PermissionMode,
  type ThreadAgentMode, type PendingModeNotice,
} from './events';
import { folderAccessHint } from '../util/platform-copy';

/** What the manager needs from the Blobs runtime (blobs/runtime.ts satisfies it structurally). */
export interface ManagerBlobs extends DriverBlobs {
  systemPrompt(i: { blobId: string; threadId: string; agent: string }): string;
  turnContext(i: { blobId: string; threadId: string; text: string; agent: string; origin: ThreadOrigin | null }): Promise<string>;
  recordTurnUsage?(cwd: string, threadId: string, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): void;
  /** A blob's static prompt inputs changed (SOUL, profile, about-me); blobId null = every blob. */
  onPromptChanged?(cb: (blobId: string | null) => void): () => void;
}

/** The slice of the daemon Runtime the manager needs — kept minimal so the manager is unit-testable. */
export interface ManagerRuntime {
  notify(method: string, params: unknown): void;
  graph: {
    callTool(name: any, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<{ text: string; data: unknown; ms: number }>;
    status?(cwd: string): Promise<{ indexed: boolean }>;
    /** Keep an ALREADY-indexed checkout current (deduped, background). Called at every session start — resume
     *  included — so a reopened thread's per-turn graph queries never hit a stale index. Never indexes a new dir. */
    ensureFresh?(cwd: string): void;
    /** graph/bug-localize.ts, answered from the graph worker thread (optional: tests hand a bare callTool). */
    bugLocalize?(prompt: string, root: string, generation: string): Promise<unknown>;
  };
  /** Prepare a chat session the way an agent pane is prepared (rulebook, hooks, KORA_* env, strict MCP). */
  prepareChat?(params: { threadId: ThreadId; agent: AgentId; cwd: string; account: string | null }): Promise<SessionPrep>;
  agentSpawn(params: { agent: AgentId; cwd?: string; prompt?: string; account?: string | null; worktree?: boolean; orchestratorId?: string; args?: string[]; name?: string }): Promise<PaneInfo>;
  /** Fleet control handed to orchestrator threads' drivers (see server/fleet-ops.ts). Optional for tests. */
  fleet?: FleetOps;
  /** The runtime's pane socket + bin path, so a Codex orchestrator's MCP bridge can reach this runtime. */
  socketPath?: string;
  binPath?: string;
  /**
   * The runtime's SwarmService (`runtime.swarm`): the fleet tools' `swarm` alias spawns through it, and a thread
   * that leaves swarm for chat (or is deleted) has its swarm workers stopped. Optional: absent ⇒ no swarm workers.
   */
  swarm?: SwarmSpawner & { cleanupThread(orchestratorId: string, opts?: { kill?: boolean; reason?: 'stopped' | 'left-swarm' }): Promise<void> };
  /** The Blobs runtime (docs/bots/ARCH.md section 3): blob prompts, memory recall, self tools, skills. Absent ⇒ no blobs. */
  blobs?: ManagerBlobs;
  /** OpenCode as a chat engine (OpenCodeDriver). Absent ⇒ an opencode thread fails with a clear message. */
  opencode?: OpencodeDeps;
  /** Phase 7 engines (server/engines.ts): ACP agents and API endpoints get their own driver per agent id. */
  engines?: ManagerEngines;
}

/** The slice of server/engines.ts the manager needs to build a driver for an ACP / API agent id. */
export interface ManagerEngines {
  acpEngine(agent: string): AcpEngine | null;
  apiEndpoint(agent: string): ApiEndpoint | null;
  idleMs(): number;
  /** Why an ACP agent is parked after failing to start (null = fine) / park it. Optional: test doubles omit them. */
  acpBlocked?(agent: string): string | null;
  acpMarkFailed?(agent: string, reason: string): void;
  keys: { get(endpointId: string): Promise<string | null> };
}

/** The agents that can lead a swarm: the ones with the fleet bridge (antigravity / ACP / API engines have none). */
const SWARM_LEADER_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex', 'opencode']);

interface LiveSession { driver: SessionDriver; agent: AgentId }

const CHAT_EVENT = 'chat.event';
const THREAD_UPDATED = 'chat.thread.updated';

const folderGoneMessage = (cwd: string) =>
  `This thread's folder is gone: ${cwd}. It was moved, renamed or deleted. Put it back, or open the folder from its new place and start a new thread there.`;

/** Why an agent cannot start in `cwd` (gone, a file, not readable), or null when it can. */
export function folderProblem(cwd: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(cwd); } catch (e: any) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') return folderDeniedMessage(cwd);
    return folderGoneMessage(cwd);
  }
  if (!st.isDirectory()) return `This thread's project is a file, not a folder: ${cwd}. Open the folder that holds it as the project instead.`;
  // Opening the directory runs the same checks the agent's own reads hit (POSIX permissions and macOS privacy).
  try { fs.opendirSync(cwd).closeSync(); } catch (e: any) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') return folderDeniedMessage(cwd);
  }
  return null;
}
const folderDeniedMessage = (cwd: string) =>
  `Kora can't open this thread's folder: ${cwd} (permission denied). ${folderAccessHint()}, or open another folder.`;

export class SessionManager {
  private live = new Map<ThreadId, LiveSession>();
  private drivers = new Map<AgentId, SessionDriver>();
  private unsubs = new Map<AgentId, () => void>();
  /** Per-thread permission mode picked in the composer (defaults to approval-required). */
  private runtimeModes = new Map<ThreadId, RuntimeMode>();
  /**
   * Threads whose mode changed while a session was live. The toolset is wired at session start, so the session
   * must restart — but NOT mid-turn (the old setOrchestrator killed the running turn): the next sendTurn stops it
   * first and resumes with the new toolset. In-memory only: after a daemon restart no session is live anyway.
   */
  private pendingRestart = new Set<ThreadId>();
  /** Last event / turn per LIVE thread — the idle reaper's clock (see reapIdle). */
  private lastActive = new Map<ThreadId, number>();

  /**
   * `opts.queryFn` overrides the real SDK query (tests inject a fake; production uses the SDK).
   * `opts.driverFactory` overrides driver construction entirely (tests inject a fake SessionDriver).
   */
  constructor(private runtime: ManagerRuntime, readonly store: ChatThreadStore, private opts: { queryFn?: QueryFn; driverFactory?: (agent: AgentId, deps: DriverDeps) => SessionDriver; folderExists?: (cwd: string) => boolean; folderProblem?: (cwd: string) => string | null; trustMigration?: boolean } = {}) {
    this.planHeadroom.persistTo(path.join(store.root, '.plan-headroom.json'));
    // Folder trust (trust/store.ts). On the first start of a version with trust, every folder the user was already
    // using is trusted once — before any new thread can be created, so a folder opened after the upgrade never is.
    if (opts.trustMigration !== false) {
      try {
        const r = migrateTrustOnce();
        if (r.migrated) console.error(`[kora] folder trust: trusted ${r.trusted.length} folder(s) already in use before this version; new folders ask first`);
      } catch (e: any) { console.error(`[kora] folder trust migration failed (new folders stay untrusted): ${e?.message ?? e}`); }
    }
    // A session reads trust when it starts (setting sources, hooks). Trust granted or revoked while one is live:
    // restart it before its next turn — never mid-turn — so it picks the change up (resume keeps the conversation).
    // A blob's SOUL / profile / about-me changed: its live sessions pick the new static prompt up at their next turn
    // (restart + resume), never mid-turn.
    this.offBlobs = runtime.blobs?.onPromptChanged?.((blobId) => {
      for (const threadId of this.live.keys()) {
        let cwd = ''; try { cwd = this.store.get(threadId).cwd; } catch { continue; }
        const b = runtime.blobs!.byCwd(cwd);
        if (b && (blobId === null || b.id === blobId)) this.pendingRestart.add(threadId);
      }
    }) ?? (() => {});
    try { this.closeOrphanedPrompts(); } catch { /* best effort */ }
    this.offTrust = onTrustChange((root) => {
      for (const threadId of this.live.keys()) {
        let cwd = ''; try { cwd = this.store.get(threadId).cwd; } catch { continue; }
        if (folderCoveredBy(cwd, root)) this.pendingRestart.add(threadId);
      }
    });
  }
  private offTrust: () => void = () => {};
  private offBlobs: () => void = () => {};

  /** A thread whose project folder was moved, renamed, deleted or cannot be opened does not start: Node reports the
   *  spawn's bad cwd as `spawn …/claude ENOENT` (reads like Claude Code is not installed), `spawn ENOTDIR`, or — for a
   *  folder the user may not read — the SDK's "native binary … failed to launch … musl … libc" guess. Say what actually
   *  happened instead. (Fake-driver tests use made-up cwds, so the real check is the default only for real drivers.) */
  private assertFolder(cwd: string): void {
    if (isBlobsCwd(cwd)) return;
    const gone = this.opts.folderExists ? (c: string) => (this.opts.folderExists!(c) ? null : folderGoneMessage(c)) : null;
    const check = this.opts.folderProblem ?? gone ?? (this.opts.driverFactory ? null : folderProblem);
    const problem = check?.(cwd);
    if (problem) throw new Error(problem);
  }

  // ── thread heads ──────────────────────────────────────────────────────────────
  list(includeArchived = false): ChatThreadInfo[] {
    // A worker pane's hidden thread (server/driver-pane.ts) is the pane's engine, not a conversation.
    const all = this.store.list().filter((t) => !(t as { workerPaneId?: string | null }).workerPaneId);
    return includeArchived ? all : all.filter((t) => !t.archived);
  }
  get(threadId: ThreadId): ChatThreadInfo { return this.store.get(threadId); }

  create(params: { agent: AgentId; cwd: string; account?: string | null; model?: ModelChoice; isOrchestrator?: boolean; agentMode?: ThreadAgentMode; title?: string; worktree?: string | null }): ChatThreadInfo {
    const chatSurface = isBlobsCwd(params.cwd);
    // A blob is always swarm-powered (its quiet helpers; the Helpers switch only decides whether the tools are wired) —
    // never a mode the user picked, so it never gets a mode notice, and any lead is allowed there (assertSwarmLeader
    // is a Code-surface-only rule).
    const agentMode: ThreadAgentMode = chatSurface ? 'swarm' : (params.agentMode ?? (params.isOrchestrator ? 'orchestrator' : 'chat'));
    if (agentMode === 'swarm' && !chatSurface) assertSwarmLeader(params.agent);
    // A thread born in swarm: the agent has never been told, so the first turn carries the notice (from 'chat').
    // assistant-lane threads are swarm from birth by DESIGN, not a switch the agent needs telling about.
    const pendingModeNotice = agentMode === 'swarm' && !chatSurface ? modeNotice('chat', 'swarm') : null;
    if (agentMode === 'swarm' && !chatSurface) installSkillSafely();
    const meta = this.store.create({ ...params, agentMode, pendingModeNotice });
    this.runtime.notify('chat.thread.created', meta);
    return meta;
  }
  /** The hidden thread a worker pane runs on (server/driver-pane.ts): chat mode, no fleet tools, never listed. */
  createWorker(params: { paneId: string; agent: AgentId; cwd: string; account?: string | null; model?: ModelChoice; title?: string; runtimeMode?: RuntimeMode }): ChatThreadInfo {
    const meta = this.store.create({ agent: params.agent, cwd: params.cwd, account: params.account ?? null, ...(params.model ? { model: params.model } : {}), agentMode: 'chat', title: params.title ?? 'Worker', workerPaneId: params.paneId });
    if (params.runtimeMode) { this.runtimeModes.set(meta.id, params.runtimeMode); this.store.update(meta.id, { runtimeMode: params.runtimeMode }); }
    return meta;
  }
  /** Every event of one thread, after it is stamped and persisted (a DriverPane's feed). */
  subscribeThread(threadId: ThreadId, cb: (e: ChatEvent) => void): () => void {
    let set = this.threadSubs.get(threadId);
    if (!set) { set = new Set(); this.threadSubs.set(threadId, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (!set!.size) this.threadSubs.delete(threadId); };
  }
  private threadSubs = new Map<ThreadId, Set<(e: ChatEvent) => void>>();
  rename(threadId: ThreadId, title: string): void { this.pushHead(this.store.rename(threadId, title)); }
  archive(threadId: ThreadId): void { this.pushHead(this.store.archive(threadId)); }
  unarchive(threadId: ThreadId): void { this.pushHead(this.store.unarchive(threadId)); }
  /** Hard delete — user-confirmed only (never agent-initiated). Stops the session first. */
  async delete(threadId: ThreadId): Promise<void> {
    await this.stop(threadId).catch(() => {});
    this.pendingRestart.delete(threadId);
    this.quickNotes.delete(threadId);
    // Its swarm workers belong to it (cleanupThread keeps worktrees; an unknown thread is a no-op there).
    await this.cleanupSwarm(threadId);
    // Files Kora kept for this thread alone (flags, undo copy, spilled Bash output, its Kora-made cold-resume fork).
    try {
      const meta = this.store.tryGet(threadId);
      dropThreadFlags(threadId); dropSnapshot(threadId); dropToolOut(threadId);
      if (meta && typeof meta.resume === 'string') forgetFork(meta.resume);
    } catch { /* leftovers are swept by housekeeping */ }
    this.store.delete(threadId);
    this.runtime.notify('chat.thread.closed', { threadId });
  }
  /**
   * Record the thread's runtime mode AND push it into a live session, the way setModel does.
   * Recording alone left a running query on its start-time mode (see ClaudeDriver.setPermissionMode).
   */
  setPermissionMode(threadId: ThreadId, mode: PermissionMode): void {
    const runtimeMode = permissionToRuntimeMode(mode);
    this.runtimeModes.set(threadId, runtimeMode);
    // Persisted on the thread head: the in-memory map dies with the daemon, and a resumed thread must come back
    // in the mode the composer still shows (it silently fell back to approval-required after every restart).
    try { if (this.store.has(threadId) && this.store.get(threadId).runtimeMode !== runtimeMode) this.store.update(threadId, { runtimeMode }); } catch { /* best effort */ }
    const d = this.live.get(threadId)?.driver;
    if (d?.setPermissionMode) void d.setPermissionMode(threadId, runtimeMode).catch(() => {});
  }

  // ── driver registry ────────────────────────────────────────────────────────────
  /** What `agent`'s driver can do (building the driver if it is not running yet). */
  driverCapabilities(agent: AgentId): DriverCapabilities { return this.driverFor(agent).capabilities; }
  /** Localizes agent-specific session code (parallels adapterFor for panes). */
  private driverFor(agent: AgentId): SessionDriver {
    let d = this.drivers.get(agent);
    if (d) {
      // An ACP / API engine edited in Settings > Engines (path, arguments, base URL, idle time): a driver nobody is using
      // is rebuilt from the new config; one with live threads keeps running as it is (an ACP process also restarts by
      // itself when its launch contract changes).
      const sig = this.engineSig.get(agent);
      if (sig !== undefined && sig !== this.engineSignature(agent) && ![...this.live.values()].some((l) => l.driver === d)) {
        this.unsubs.get(agent)?.(); this.unsubs.delete(agent); this.drivers.delete(agent);
        void (d as { shutdown?(): Promise<void> }).shutdown?.()?.catch?.(() => {});
        d = undefined;
      } else return d;
    }
    d = this.buildDriver(agent);
    this.drivers.set(agent, d);
    const sigNow = this.engineSignature(agent);
    if (sigNow !== undefined) this.engineSig.set(agent, sigNow);
    // Subscribe ONCE per driver; route stamped events by threadId.
    this.unsubs.set(agent, d.streamEvents((e) => this.onEvent(e)));
    return d;
  }

  /** What an ACP / API driver was built from (undefined for the native engines): a changed value means rebuild when idle. */
  private engineSig = new Map<string, string>();
  private engineSignature(agent: string): string | undefined {
    const e = this.runtime.engines;
    if (!e) return undefined;
    const acp = e.acpEngine(agent);
    if (acp) return JSON.stringify({ c: acp.command, x: acp.executable ?? null, a: acp.args, e: acp.env ?? null, i: e.idleMs() });
    const api = e.apiEndpoint(agent);
    return api ? JSON.stringify(api) : undefined;
  }

  private buildDriver(agent: AgentId): SessionDriver {
    const deps: DriverDeps & { swarm?: SwarmSpawner } = {
      graphCall: (name, args, opts) => this.runtime.graph.callTool(name, args, opts),
      ...(this.runtime.graph.status ? { graphStatus: (cwd) => this.runtime.graph.status!(cwd) } : {}),
      ...(this.runtime.graph.bugLocalize ? { graphBugLocalize: (prompt, root, generation) => this.runtime.graph.bugLocalize!(prompt, root, generation) } : {}),
      spawnWorker: async (p) => {
        const info = await this.runtime.agentSpawn({ agent: p.agent, cwd: p.cwd, prompt: p.prompt, account: p.account, worktree: p.worktree, orchestratorId: p.orchestratorId, args: p.args, name: p.name });
        return { id: info.id, agent: info.agent, account: info.account ?? null };
      },
      ...(this.runtime.swarm ? { swarm: this.runtime.swarm } : {}),
      spawnEnv: (threadId, account) => adapterFor(agent).spawnEnv(proxyPaneId(threadId), account),
      appendSystemPrompt: (input) => this.appendSystemPrompt(input),
      askWorkers: (threadId, picks) => this.askWorkers(threadId, picks),
      ...(this.runtime.prepareChat ? { prepareSession: (input: SessionStartInput) => this.runtime.prepareChat!({ threadId: input.threadId, agent: input.agent, cwd: input.cwd, account: input.account }) } : {}),
      ...(this.runtime.fleet ? { fleet: this.runtime.fleet } : {}),
      ...(this.runtime.blobs ? { blobs: this.runtime.blobs } : {}),
      ...(this.runtime.opencode ? { opencode: this.runtime.opencode } : {}),
      ...(this.runtime.socketPath ? { socketPath: this.runtime.socketPath } : {}),
      ...(this.runtime.binPath ? { binPath: this.runtime.binPath } : {}),
    };
    if (this.opts.driverFactory) return this.opts.driverFactory(agent, deps);
    if (agent === 'codex') return new CodexDriver(deps);
    if (agent === 'opencode') return new OpenCodeDriver(deps);
    // Google's agent: the `agy` CLI in print mode (one child per turn, `--conversation` resume).
    if (agent === 'antigravity') return new AntigravityDriver(deps);
    // Phase 7: a known ACP agent id (gemini, grok, acp-hermes, acp-my-cli...) or API endpoint id (api-groq) has its own driver.
    const acp = this.runtime.engines?.acpEngine(agent);
    if (acp) {
      const engines = this.runtime.engines!;
      return new AcpDriver(deps, acp, { idleMs: engines.idleMs(), health: { blocked: () => engines.acpBlocked?.(agent) ?? null, fail: (reason) => engines.acpMarkFailed?.(agent, reason) } });
    }
    const api = this.runtime.engines?.apiEndpoint(agent);
    if (api) return new ApiDriver(deps, { endpoint: api, getEndpoint: () => this.runtime.engines?.apiEndpoint(agent) ?? api, getKey: (id) => this.runtime.engines!.keys.get(id) });
    // Claude is the default driver; Codex drives the `codex` CLI via CodexDriver.
    return new ClaudeDriver(deps, this.opts.queryFn ?? defaultQueryFn());
  }

  private appendSystemPrompt(input: SessionStartInput): string | undefined {
    // A blob has its own persona prompt (SOUL, about-me, memory core, skills): the Chat leader prompt never applies.
    if (this.runtime.blobs) {
      try {
        const b = this.runtime.blobs.byCwd(input.cwd);
        if (b) return this.runtime.blobs.systemPrompt({ blobId: b.id, threadId: input.threadId, agent: input.agent });
      } catch (e: any) { console.error('[kora] blob system prompt failed:', e?.message ?? e); }
    }
    // An assistant folder that no blob owns (a stray thread, a deleted blob) is still never the code orchestrator.
    if (isBlobsCwd(input.cwd)) return undefined;
    if (input.isWorker) return chatWorkerPrompt();
    const mode: ThreadAgentMode = input.agentMode ?? (input.isOrchestrator ? 'orchestrator' : 'chat');
    if (mode === 'swarm') {
      // The short hard rules (≤40 lines); the long playbook is the koraswarm skill. Until swarm-skill lands its
      // prompt, a swarm leader still gets the orchestrator rules — it drives the same kora_* fleet tools.
      try { return chatSwarmPrompt(); } catch { return chatOrchestratorPrompt(); }
    }
    if (mode === 'orchestrator') return chatOrchestratorPrompt();
    return chatDelegationPrompt();
  }

  /** Legacy Chat | Orchestrator flip — a wrapper over setAgentMode. */
  async setOrchestrator(threadId: ThreadId, isOrchestrator: boolean): Promise<ChatThreadInfo> {
    return (await this.setAgentMode(threadId, isOrchestrator ? 'orchestrator' : 'chat')).thread;
  }

  /**
   * The composer's Chat | Orchestrator | Swarm toggle. Persists the mode (and the derived isOrchestrator) plus the
   * notice the agent still has to hear, measured against what it was last TOLD (`announcedAgentMode`): flipping
   * Chat → Swarm → Chat before delivery leaves no notice at all. A live session is NOT stopped here — a turn may be
   * running; `pendingRestart` makes the next sendTurn restart it with the new toolset (resume keeps the chat).
   * Swarm needs a leader with the fleet bridge; leaving swarm for chat stops the thread's swarm workers (decision D-a: the
   * UI asks first, and "keep them" is a switch to Orchestrator instead).
   */
  async setAgentMode(threadId: ThreadId, mode: ThreadAgentMode): Promise<{ thread: ChatThreadInfo; notice: PendingModeNotice | null }> {
    const meta = this.store.get(threadId);
    // assistant-lane threads have no Chat|Orchestrator|Swarm toggle — the client never shows it — and their mode is
    // fixed to 'swarm' by design (create()/start()). A stray call (old client, stale cache) is a no-op, not an error.
    if (isBlobsCwd(meta.cwd)) return { thread: meta, notice: null };
    const prev: ThreadAgentMode = meta.agentMode ?? (meta.isOrchestrator ? 'orchestrator' : 'chat');
    if (mode === 'swarm') assertSwarmLeader(meta.agent);
    if (prev === mode) return { thread: meta, notice: meta.pendingModeNotice ?? null };
    const announced: ThreadAgentMode = meta.announcedAgentMode ?? prev;
    const notice = mode === announced ? null : modeNotice(announced, mode);
    if (mode === 'swarm') installSkillSafely();
    const next = this.store.update(threadId, { agentMode: mode, isOrchestrator: isFleetAgentMode(mode), pendingModeNotice: notice, announcedAgentMode: announced });
    if (this.live.has(threadId)) this.pendingRestart.add(threadId);
    if (prev === 'swarm' && mode === 'chat') await this.cleanupSwarm(threadId);
    this.pushHead(next);
    return { thread: next, notice };
  }

  /**
   * Take (and clear) the notice the agent has not heard yet, marking its target mode as announced. Synchronous, so
   * the ui-server takes it and puts it on exactly one turn — never two.
   */
  takeModeNotice(threadId: ThreadId): PendingModeNotice | null {
    const meta = this.store.tryGet(threadId);
    const n = meta?.pendingModeNotice ?? null;
    if (!n) return null;
    this.store.update(threadId, { pendingModeNotice: null, announcedAgentMode: n.to });
    return n;
  }

  private async cleanupSwarm(threadId: ThreadId, reason: 'stopped' | 'left-swarm' = 'left-swarm'): Promise<void> {
    if (!this.runtime.swarm) return;
    try { await this.runtime.swarm.cleanupThread(proxyPaneId(threadId), reason === 'stopped' ? { kill: true, reason } : { kill: true }); }
    catch (e: any) { console.error(`[kora] swarm cleanup for ${threadId} failed:`, e?.message ?? e); }
  }

  // ── session lifecycle ────────────────────────────────────────────────────────────
  async start(threadId: ThreadId): Promise<{ threadId: ThreadId; state: string }> {
    const meta = this.store.get(threadId);
    if (this.live.has(threadId) && this.live.get(threadId)!.driver.hasSession(threadId)) return { threadId, state: meta.state };
    this.assertFolder(meta.cwd);
    const driver = this.driverFor(meta.agent);
    const chatSurface = isBlobsCwd(meta.cwd);
    // The mode lives only on the persisted head (never an in-memory map), so it survives a daemon restart. A blob
    // thread is ALWAYS treated as swarm when started, even a thread whose head predates this rule.
    const agentMode: ThreadAgentMode = chatSurface ? 'swarm' : (meta.agentMode ?? (meta.isOrchestrator ? 'orchestrator' : 'chat'));
    const isWorker = !!(meta as { workerPaneId?: string | null }).workerPaneId;
    const input: SessionStartInput = {
      threadId, agent: meta.agent, cwd: meta.cwd, account: meta.account,
      ...(meta.model ? { model: this.launchModel(meta) } : {}),
      ...(() => { const a = this.launchAdvisor(meta); return a ? { advisorModel: a } : {}; })(),
      ...(this.coldNext.delete(threadId) ? { coldCache: true } : {}),
      runtimeMode: this.runtimeModes.get(threadId) ?? meta.runtimeMode ?? this.blobDefaultMode(meta.cwd) ?? 'approval-required',
      isOrchestrator: isWorker ? false : isFleetAgentMode(agentMode),
      agentMode,
      ...(isWorker ? { isWorker: true, helpersOff: true } : {}),
      ...(chatSurface && this.blobHelpersOff(meta.cwd) ? { helpersOff: true } : {}),
      ...(meta.resume !== undefined ? { resume: meta.resume } : {}),
    };
    // Resume included: a reopened thread refreshes its (already-indexed) checkout's graph in the background.
    // The assistant lane is never a checkout — no graph, nothing to freshen.
    if (!chatSurface) { try { this.runtime.graph.ensureFresh?.(meta.cwd); } catch { /* advisory */ } }
    await driver.startSession(input);
    this.live.set(threadId, { driver, agent: meta.agent });
    this.lastActive.set(threadId, Date.now());
    this.setState(threadId, 'idle');
    return { threadId, state: 'idle' };
  }

  /** A blob thread nobody set a posture on starts in its profile's (Auto by default), resolved for its engine. */
  private blobDefaultMode(cwd: string): RuntimeMode | null {
    try { const b = this.runtime.blobs?.byCwd(cwd) as ({ permission: 'ask' | 'auto' | 'full'; engine?: { instanceId: string } } & { id: string }) | null | undefined; return b?.engine ? resolveBlobRuntimeMode(b.engine.instanceId, b.permission) : null; } catch { return null; }
  }

  private async ensureLive(threadId: ThreadId): Promise<SessionDriver> {
    if (!this.live.has(threadId) || !this.live.get(threadId)!.driver.hasSession(threadId)) await this.start(threadId);
    return this.live.get(threadId)!.driver;
  }

  async sendTurn(p: { threadId: ThreadId; text?: string; attachments?: PromptAttachment[]; model?: ModelChoice; interactionMode?: 'default' | 'plan'; continuation?: boolean; origin?: 'user' | 'kora-notice'; koraNotice?: string; blobOrigin?: ThreadOrigin | null }): Promise<{ turnId: string }> {
    // A mode flip made while the session was live: restart it now, before this turn, with the new toolset.
    if (p.origin !== 'kora-notice' && !p.continuation) this.resumeCount.delete(p.threadId);
    if (this.pendingRestart.delete(p.threadId)) await this.stop(p.threadId).catch(() => {});
    const auto = await this.resolveAuto(p);
    if (auto) p = { ...p, model: auto };
    const driver = await this.ensureLive(p.threadId);
    // Auto effort: this turn's effort reaches the live session before its message (cache kept; a no-op when unchanged).
    const eff = this.turnEffortFor.get(p.threadId);
    if (eff !== undefined) { this.turnEffortFor.delete(p.threadId); await driver.setEffort?.(p.threadId, eff).catch(() => false); }
    // The lead's first turn after a daemon restart that cut its swarm tasks: it hears what became of them (its last
    // kora_spawn / kora_wait result was lost, and the SDK replays that call as "rejected by the user").
    let restart: string | null = null;
    try { restart = this.runtime.swarm?.takeRestartDigest?.(proxyPaneId(p.threadId)) ?? null; } catch { /* best effort */ }
    // A blob's per-turn context (recalled facts, a Core delta, a "from Kora" header): agent-only, bounded (400 ms), never blocks.
    let blobCtx: string | null = null;
    if (this.runtime.blobs && p.origin !== 'kora-notice' && p.text) {
      try {
        const meta = this.store.get(p.threadId);
        const b = this.runtime.blobs.byCwd(meta.cwd);
        if (b) blobCtx = await this.runtime.blobs.turnContext({ blobId: b.id, threadId: p.threadId, text: p.text, agent: meta.agent, origin: p.blobOrigin ?? null }) || null;
      } catch (e: any) { console.error('[kora] blob turn context failed:', e?.message ?? e); }
    }
    // B17: quick answers the user already read ride once on the next real turn (not on a notice turn, not on a bare slash command).
    let quick: string | null = null;
    if (p.origin !== 'kora-notice' && p.text && !p.text.trim().startsWith('/')) { const q = this.quickNotes.get(p.threadId); if (q?.length) { quick = q.join('\n\n'); this.quickNotes.delete(p.threadId); } }
    const planNotice = await this.planNoticeFor(p);
    const koraNotice = [p.koraNotice, restart, blobCtx, quick, planNotice].filter((t): t is string => !!t).join('\n\n');
    let handle;
    try {
      handle = await driver.sendTurn({
        threadId: p.threadId, text: p.text, attachments: p.attachments, model: p.model, interactionMode: p.interactionMode, continuation: p.continuation,
        ...(p.origin ? { origin: p.origin } : {}),
        ...(koraNotice ? { koraNotice } : {}),
      });
    } catch (e) {
      if (restart) try { this.runtime.swarm?.restoreRestartDigest?.(proxyPaneId(p.threadId), restart); } catch { /* best effort */ }
      throw e;
    }
    this.setState(p.threadId, 'running');
    return { turnId: handle.turnId };
  }

  async interrupt(threadId: ThreadId, turnId?: string): Promise<void> {
    this.cancelPickers(threadId);
    // A blob's helpers belong to the turn the user just cancelled (a job step's Cancel comes through here too): stop them
    // with it, queued ones included, or they keep burning free-model quota for an answer nobody is waiting for.
    const helpers = this.isBlobThread(threadId) ? this.cleanupSwarm(threadId, 'stopped') : Promise.resolve();
    const d = this.live.get(threadId)?.driver;
    if (d) await d.interruptTurn(threadId, turnId);
    await helpers;
  }
  /** A blob whose Helpers switch is off gets no fleet tools (it still runs as swarm, so nothing else about the thread changes). */
  private blobHelpersOff(cwd: string): boolean {
    try { const b = this.runtime.blobs?.byCwd(cwd) as ({ helpers?: boolean } | null | undefined); return !!b && b.helpers === false; } catch { return false; }
  }

  /**
   * Point a thread at another folder (the Chat -> Kora migration moves conversations under a blob). Stops its session,
   * rewrites the head's cwd and copies the Claude transcript next to the new folder's slug so a resumed conversation keeps
   * its context (copy, never move: the old file stays). Events and the read model are untouched.
   */
  async moveThread(threadId: ThreadId, cwd: string): Promise<{ transcriptCopied: boolean }> {
    const meta = this.store.get(threadId);
    if (meta.cwd === cwd) return { transcriptCopied: false };
    await this.stop(threadId).catch(() => {});
    this.store.update(threadId, { cwd, worktree: null });
    return { transcriptCopied: meta.agent === 'claude' && typeof meta.resume === 'string' ? copyClaudeTranscript(meta.resume, meta.cwd, cwd) : false };
  }

  private isBlobThread(threadId: ThreadId): boolean {
    try { const meta = this.store.tryGet(threadId); return !!meta && !!this.runtime.blobs?.byCwd(meta.cwd); } catch { return false; }
  }
  /** What an Auto thread runs: its sticky pick, else the user's Default (a thread whose first prompt has not been seen yet). */
  /** Threads whose next session start has a cold prompt cache for its model (an Auto escalation): resume masked. */
  private readonly coldNext = new Set<ThreadId>();
  /** How close the Claude plan is to a limit (the chat lane's usage.limits reports): Auto starts new work on Sonnet when tight. */
  readonly planHeadroom = new PlanHeadroom();
  /** Auto effort: the effort resolveAuto picked for the turn sendTurn is about to send. */
  private readonly turnEffortFor = new Map<ThreadId, string>();
  /** Auto effort: threads whose last real turn ran at low by the rule (the next complaint flips that turn to high). */
  private readonly lastTurnLow = new Set<ThreadId>();
  /** Plan mode: threads whose current plan-mode stretch already got the graph notice. */
  private readonly planNoticeSent = new Set<ThreadId>();

  /** The graph notice for the first user turn after Plan is switched on, in an indexed code repo (session/plan-mode.ts). */
  private async planNoticeFor(p: { threadId: ThreadId; text?: string; interactionMode?: 'default' | 'plan'; continuation?: boolean; origin?: 'user' | 'kora-notice' }): Promise<string | null> {
    if (p.origin === 'kora-notice' || p.continuation) return null;
    if (p.interactionMode !== 'plan') { this.planNoticeSent.delete(p.threadId); return null; }
    if (this.planNoticeSent.has(p.threadId) || !p.text || p.text.trim().startsWith('/')) return null;
    const meta = this.store.tryGet(p.threadId);
    const cwd = meta?.cwd;
    // Codex plans in its read-only sandbox, which has no network and so no route to the Kora socket: `kora graph` would
    // fail there. It still gets the per-prompt declarations (injected daemon-side), so it is not told to run the CLI.
    if (!cwd || isBlobsCwd(cwd) || meta?.agent === 'codex' || !this.runtime.graph.status) return null;
    try {
      const st = await Promise.race([this.runtime.graph.status(cwd), new Promise<null>((r) => setTimeout(() => r(null), 1500).unref())]);
      if (!st?.indexed) return null;
    } catch { return null; }
    this.planNoticeSent.add(p.threadId);
    return PLAN_MODE_GRAPH_NOTICE;
  }

  private launchModel(meta: ThreadMeta): ModelChoice {
    const m = meta.model!;
    if (m.model !== AUTO_MODEL_SLUG || meta.agent !== 'claude') return m;
    const a = meta.autoModel;
    // Auto off runs the Default. The middle tier's switch decides NEW threads only: a running Sonnet thread stays on Sonnet
    // (moving it re-writes its whole context, and its next turn asks for Sonnet anyway: R6 review #5).
    if (!autoModelOn() || !firstPartyRoute(this.claudeRouteEnv(meta))) return { ...m, model: 'default' };
    return a?.model === AUTO_MID_MODEL ? { ...m, model: a.model, effort: midEffort(m.effort) } : { ...m, model: a?.model ?? 'default' };
  }
  /** The env a thread's Claude process routes by: the daemon's, with the thread's account config dir. */
  private claudeRouteEnv(meta: ThreadMeta): NodeJS.ProcessEnv {
    const dir = this.claudeConfigDirFor(meta);
    return dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env;
  }
  /** The advisor an Auto thread's session starts with (the middle tier's KORA_AUTO_ADVISOR experiment), else undefined. */
  private launchAdvisor(meta: ThreadMeta): string | undefined {
    if (meta.model?.model !== AUTO_MODEL_SLUG || meta.agent !== 'claude' || meta.autoModel?.model !== AUTO_MID_MODEL || !autoModelOn() || !autoSonnetOn() || !autoAdvisorOn()) return undefined;
    return meta.autoModel?.advisor;
  }

  /**
   * The composer's "Auto" model (session/auto-model.ts), Claude threads only. The first real prompt of a fresh thread picks the
   * model (light work -> Haiku 5.5, else the user's Default) BEFORE any API call, so the pick costs no cache; the pick then
   * sticks. A light thread moves up once, to the Default, when the user complains, asks for a stronger model, the thread turns
   * to real work or a turn looked stuck. Null = not an Auto turn (the turn's own model goes through unchanged).
   */
  private async resolveAuto(p: { threadId: ThreadId; text?: string; attachments?: PromptAttachment[]; model?: ModelChoice; continuation?: boolean; origin?: 'user' | 'kora-notice' }): Promise<ModelChoice | null> {
    const meta = this.store.tryGet(p.threadId);
    const pick = p.model ?? meta?.model;
    if (!meta || meta.agent !== 'claude' || pick?.model !== AUTO_MODEL_SLUG) return null;
    // Auto off, or Claude routed through Bedrock / Vertex / a gateway (Auto's picks are first-party ids): the Default.
    if (!autoModelOn() || !firstPartyRoute(this.claudeRouteEnv(meta))) {
      // A light session still live keeps Haiku's 100k compaction point: restart it (masked) on the Default (R7 N2).
      // Once: the pick becomes the Default (up only), or every later turn would restart it again (R8 review).
      if (meta.autoModel?.model === AUTO_LIGHT_MODEL && this.live.has(p.threadId)) {
        this.store.update(p.threadId, { autoModel: { model: 'default', reason: 'Auto was switched off', escalated: true } });
        logCost({ k: 'auto-model', ts: Date.now(), thread: p.threadId, model: 'manual', reason: 'Auto was switched off' });
        this.coldNext.add(p.threadId); await this.stop(p.threadId).catch(() => {});
      }
      return { ...pick, model: 'default' };
    }
    let cur = meta.autoModel ?? null;
    const realPrompt = p.origin !== 'kora-notice' && !p.continuation && !!p.text?.trim() && !p.text.trim().startsWith('/');
    if (!realPrompt) {
      // A notice or a continuation after a low chore turn runs at the thread's own effort again (R6 review #7); the flip-back
      // memory stays for the user's next message.
      if (this.lastTurnLow.has(p.threadId) && autoEffortOn()) this.turnEffortFor.set(p.threadId, (cur?.model === AUTO_MID_MODEL ? midEffort(pick.effort) : pick.effort) ?? DEFAULT_CHAT_EFFORT);
      return { ...pick, model: cur?.model ?? 'default' };
    }
    const emit = (c: NonNullable<ThreadMeta['autoModel']>) => this.onEvent({ type: 'model.auto', threadId: p.threadId, model: c.model, reason: c.reason, escalated: !!c.escalated, ...(c.advisor ? { advisor: c.advisor } : {}), seq: 0, at: Date.now() } as ChatEvent);
    const ceiling = ceilingModelId(this.claudeConfigDirFor(meta));
    // The middle tier (Sonnet for ordinary work) when it is on and the Default is worth one; the advisor is an experiment.
    const mid = autoSonnetOn() && hasMidTier(ceiling) ? { model: AUTO_MID_MODEL, ...(autoAdvisorOn() ? { advisor: ceiling } : {}) } : null;
    // A plan window near its limit: NEW work starts on the middle tier even when it is off (never a running thread).
    const tight = !mid && hasMidTier(ceiling) && autoHeadroomOn() ? this.planHeadroom.tight() : null;
    const midTo = mid ?? (tight ? { model: AUTO_MID_MODEL, headroom: true } : null);
    if (!cur) {
      const fresh = meta.resume === undefined || meta.resume === null;
      const lead = !!meta.workerPaneId || (meta.agentMode ?? 'chat') !== 'chat';
      const images = (p.attachments ?? []).filter((a) => a.type === 'image').length;
      const d = fresh ? classifyPrompt({ text: p.text ?? '', images, orchestrator: lead }) : { tier: 'standard' as const, reason: 'an earlier conversation' };
      cur = d.tier === 'light' ? { model: AUTO_LIGHT_MODEL, reason: d.reason }
        : fresh && mid && !wantsCeiling(p.text ?? '') ? { ...mid, reason: d.reason }
        : fresh && tight && !wantsCeiling(p.text ?? '') ? { model: AUTO_MID_MODEL, reason: tightReason(tight), headroom: true }
        : { model: 'default', reason: d.reason };
      this.store.update(p.threadId, { autoModel: cur });
      logCost({ k: 'auto-model', ts: Date.now(), thread: p.threadId, model: cur.model, reason: cur.reason, ceiling, ...(cur.advisor ? { advisor: cur.advisor } : {}) });
      if (cur.model !== 'default') {
        emit(cur);
        // A session opened before this first prompt was launched on the Default and has sent nothing yet: relaunch it on the pick.
        if (this.live.has(p.threadId)) await this.stop(p.threadId).catch(() => {});
      }
    } else if (cur.model !== 'default' && (cur.model === AUTO_MID_MODEL || !cur.escalated)) {
      // Up only: light -> the middle tier (real work, delegating) or the Default (a complaint, asked for, stuck); middle -> Default.
      let why: string | null; let to: { model: string; advisor?: string; headroom?: boolean } = { model: 'default' };
      if (cur.model === AUTO_MID_MODEL) why = midEscalation(p.text ?? '', { stuck: cur.stuck === true });
      else {
        why = cur.lead ? 'the thread started delegating' : escalation(p.text ?? '', { stuck: cur.stuck === true }) ?? (cur.big ? 'the thread grew past 80k tokens' : null);
        if (midTo && (why === 'the thread started delegating' || why === 'the thread moved on to real work' || why === 'the thread grew past 80k tokens')) to = midTo;
      }
      if (why) {
        cur = { ...to, reason: why, escalated: true };
        this.store.update(p.threadId, { autoModel: cur });
        // The Default has no cache of this thread: a switch would re-write all of it at the Default's price. Restart on the
        // Default from a masked copy instead (old tool outputs elided, as after an hour away); the next start picks it up.
        if (meta.resume !== undefined && meta.resume !== null) { this.coldNext.add(p.threadId); if (this.live.has(p.threadId)) await this.stop(p.threadId).catch(() => {}); }
        logCost({ k: 'auto-model', ts: Date.now(), thread: p.threadId, model: cur.model, reason: why, escalated: true, ceiling, ...(cur.advisor ? { advisor: cur.advisor } : {}) });
        emit(cur);
      }
    }
    const effective = cur.model === AUTO_MID_MODEL ? { ...pick, model: cur.model, effort: midEffort(pick.effort) } : { ...pick, model: cur.model };
    if (autoEffortOn() && cur.model !== AUTO_LIGHT_MODEL && effortChangeCacheSafe(cur.model === 'default' ? ceiling : cur.model)) {
      // Every real prompt sets the turn's effort: a chore drops it, a complaint raises it, anything else puts the thread's own back.
      // The middle tier's high is Kora's, not the user's: a chore there is judged against the user's own pick.
      const own = pick.effort ?? DEFAULT_CHAT_EFFORT;
      const base = effective.effort ?? DEFAULT_CHAT_EFFORT;
      const te = turnEffort(p.text ?? '', cur.model === AUTO_MID_MODEL && own === 'medium' ? own : base, { afterLow: this.lastTurnLow.has(p.threadId) });
      if (te?.effort === 'low') this.lastTurnLow.add(p.threadId); else this.lastTurnLow.delete(p.threadId);
      this.turnEffortFor.set(p.threadId, te?.effort ?? base);
      if (te) logCost({ k: 'auto-effort', ts: Date.now(), thread: p.threadId, effort: te.effort, base, reason: te.reason });
    }
    return effective;
  }

  async setModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    // Leaving Auto (or coming back) ends the ledger's Auto stretch: a later pick of the same model is the user's, not a saving.
    const before = this.store.tryGet(threadId);
    if (before?.autoModel && (before.model?.model === AUTO_MODEL_SLUG) !== (model.model === AUTO_MODEL_SLUG)) {
      logCost({ k: 'auto-model', ts: Date.now(), thread: threadId, model: model.model === AUTO_MODEL_SLUG ? before.autoModel.model : 'manual', reason: model.model === AUTO_MODEL_SLUG ? 'back on Auto' : 'you picked a model' });
    }
    this.store.update(threadId, { model });
    const d = this.live.get(threadId)?.driver;
    if (model.model === AUTO_MODEL_SLUG) model = this.launchModel(this.store.get(threadId));
    // A live session that refused the switch keeps answering on the old model: restart it with the new one (resume keeps the chat).
    if (d && (await d.setModel(threadId, model)) === false) this.pendingRestart.add(threadId);
  }
  /**
   * The composer changed the model or effort of an existing thread. The model reaches a live session at once
   * (setModel); so does the effort where the driver can (Claude: applyFlagSettings, cache kept). Otherwise the live session
   * is restarted before its next turn (resume keeps the chat) — the picker must never show Low while it thinks at High.
   */
  async changeModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    const prev = this.store.get(threadId).model;
    await this.setModel(threadId, model);
    if (!this.live.has(threadId) || (prev?.effort ?? null) === (model.effort ?? null)) return;
    const d = this.live.get(threadId)?.driver;
    const live = await d?.setEffort?.(threadId, model.effort ?? null).catch(() => false);
    if (!live) this.pendingRestart.add(threadId);
  }
  async respondApproval(threadId: ThreadId, requestId: string, decision: ApprovalAnswer): Promise<void> {
    const d = this.live.get(threadId)?.driver;
    // No live session = the approval died with the daemon (or the session). Answering it used to return ok and do nothing
    // (the invisible-approval shape): close it in the log and say so.
    if (!d) { this.closeOrphanedPrompts(threadId); throw new Error(`no such pending approval (${requestId}): its session is gone — send a new message to continue`); }
    await d.respondToApproval(threadId, requestId, decision);
  }
  /**
   * Prompts (approvals, questions) left open in a thread's log whose session no longer exists: close them with
   * `cancel`/empty answers so the card disappears and the thread stops reading "waiting". Run for every thread at
   * start-up (a kill -9 mid-approval), and for one thread when a stale answer arrives. Never touches a LIVE session.
   */
  closeOrphanedPrompts(only?: ThreadId): number {
    let closed = 0;
    const ids = only ? [only] : this.store.list().filter((t) => t.state === 'waiting').map((t) => t.id);
    for (const id of ids) {
      if (this.live.has(id) || !this.store.has(id)) continue;
      try {
        const approvals = new Set<string>(); const inputs = new Set<string>();
        for (const ev of this.store.read(id).events as any[]) {
          if (ev.type === 'approval.opened') approvals.add(ev.requestId);
          else if (ev.type === 'approval.resolved') approvals.delete(ev.requestId);
          else if (ev.type === 'user-input.requested') inputs.add(ev.requestId);
          else if (ev.type === 'user-input.resolved') inputs.delete(ev.requestId);
        }
        for (const requestId of approvals) { this.onEvent({ type: 'approval.resolved', threadId: id, requestId, decision: 'cancel', seq: 0, at: Date.now() } as ChatEvent); closed++; }
        for (const requestId of inputs) { this.onEvent({ type: 'user-input.resolved', threadId: id, requestId, answers: {}, seq: 0, at: Date.now() } as ChatEvent); closed++; }
        if (this.store.tryGet(id)?.state === 'waiting') this.setState(id, 'idle');
      } catch (e: any) { console.error(`[kora] could not close orphaned prompts of ${id}: ${e?.message ?? e}`); }
    }
    return closed;
  }
  async respondUserInput(threadId: ThreadId, requestId: string, answers: UserInputAnswers): Promise<void> {
    if (this.pickers.has(requestId)) { this.answerPicker(requestId, answers); return; }
    const d = this.live.get(threadId)?.driver; if (d) await d.respondToUserInput(threadId, requestId, answers);
  }
  /**
   * The worker picker: show the lead's proposed workers (one row per task) and resolve with what the user approved.
   * Answered through the same respond path as a question (respondUserInput): `{ picks, autoApprove? }`, or `{}` for a
   * dismiss (= declined). A thread set to "don't ask again" approves the proposal at once.
   */
  askWorkers(threadId: ThreadId, picks: WorkerPick[]): Promise<WorkerPickerAnswer> {
    const meta = this.store.tryGet(threadId);
    // Stretch (Swarm mode): pressing the button is the approval, for the cheap fallback tier only.
    if (meta?.agentMode === 'swarm') return Promise.resolve(((kept) => ({ picks: kept, auto: true, ...(kept.length ? {} : { cancelled: true }) }))(stretchPicks(picks, loadWorkerCatalog())));
    if (!meta || meta.autoApproveWorkers) return Promise.resolve({ picks, auto: true });
    const requestId = `wp_${Date.now().toString(36)}${(++this.pickerSeq).toString(36)}`;
    return new Promise((resolve) => {
      this.pickers.set(requestId, { threadId, resolve });
      this.onEvent({ type: 'worker-picker.requested', threadId, requestId, picks, catalog: loadWorkerCatalog().agents, seq: 0, at: Date.now() } as ChatEvent);
    });
  }
  private pickers = new Map<string, { threadId: ThreadId; resolve: (a: WorkerPickerAnswer) => void }>();
  private pickerSeq = 0;
  private answerPicker(requestId: string, answers: UserInputAnswers): void {
    const p = this.pickers.get(requestId); if (!p) return;
    this.pickers.delete(requestId);
    const raw = Array.isArray((answers as any)?.picks) ? (answers as any).picks as any[] : null;
    const picks: WorkerPick[] = (raw ?? []).filter((x) => x && typeof x.agent === 'string' && x.agent).map((x) => ({
      title: String(x.title ?? x.agent).slice(0, 80),
      agent: String(x.agent),
      ...(typeof x.model === 'string' && x.model ? { model: x.model } : {}),
      ...(normalizeEffort(x.effort) ? { effort: normalizeEffort(x.effort)! } : {}),
    }));
    const autoApprove = (answers as any)?.autoApprove === true;
    if (autoApprove) this.store.update(p.threadId, { autoApproveWorkers: true });
    const answer: WorkerPickerAnswer = raw === null || picks.length === 0 ? { picks: [], cancelled: true } : { picks, ...(autoApprove ? { autoApprove: true } : {}) };
    this.onEvent({ type: 'worker-picker.resolved', threadId: p.threadId, requestId, answer, seq: 0, at: Date.now() } as ChatEvent);
    p.resolve(answer);
  }
  /** A stopped or interrupted lead is not waiting on the picker any more: close it as declined. */
  private cancelPickers(threadId: ThreadId): void {
    for (const [id, p] of this.pickers) if (p.threadId === threadId) this.answerPicker(id, {});
  }
  /** "Ask me before starting workers" again (the picker's "don't ask again" undone). */
  setAutoApproveWorkers(threadId: ThreadId, on: boolean): ChatThreadInfo {
    return this.store.update(threadId, { autoApproveWorkers: on });
  }

  async stop(threadId: ThreadId, opts?: { idle?: boolean }): Promise<void> {
    // Only the pending continue: the count survives the restart a continuation itself makes (the user's next message resets it).
    if (!opts?.idle) this.cancelAutoResume(threadId);
    this.cancelPickers(threadId);
    const live = this.live.get(threadId);
    if (!live) {
      // An idle-reaped thread has no live session but may still hold a keep-warm chain: a real stop ends it.
      if (!opts?.idle) { const meta = this.store.tryGet(threadId); if (meta) try { this.drivers.get(meta.agent)?.forgetThread?.(threadId); } catch { /* best effort */ } }
      return;
    }
    await live.driver.stopSession(threadId, opts);
    this.live.delete(threadId);
    this.lastActive.delete(threadId);
    this.setState(threadId, 'stopped');
  }

  /** The CLAUDE_CONFIG_DIR a Claude thread's account uses (null = the default login). */
  private claudeConfigDirFor(meta: ThreadMeta): string | null {
    try { const d = (adapterFor('claude').spawnEnv(proxyPaneId(meta.id), meta.account ?? null) as Record<string, string | undefined>).CLAUDE_CONFIG_DIR; return d || null; } catch { return null; }
  }

  /** Is there a compaction of this thread to undo (B5)? */
  canUndoCompaction(threadId: ThreadId): boolean { return !!readSnapshot(threadId); }

  /**
   * B5 "Undo compaction": point the thread at a copy of its transcript as it was before the chip's /compact. The compacted session
   * stays on disk. Refused while a turn runs. The next message resumes from the restored session.
   */
  async undoCompaction(threadId: ThreadId): Promise<{ ok: boolean; reason?: string }> {
    const meta = this.store.tryGet(threadId);
    if (!meta || meta.agent !== 'claude') return { ok: false, reason: 'no such Claude thread' };
    if (meta.state === 'running' || meta.state === 'waiting') return { ok: false, reason: 'the thread is busy' };
    const r = restoreSnapshot({ threadId, configDir: this.claudeConfigDirFor(meta) });
    if (!r) return { ok: false, reason: 'nothing to undo' };
    await this.stop(threadId);
    this.pushHead(this.store.update(threadId, { resume: r.sessionId }));
    return { ok: true };
  }

  /** B17 answers the user took instead of an agent turn: the next turn's agent hears them once (a user-message note, never the prefix). */
  private quickNotes = new Map<ThreadId, string[]>();

  /**
   * B17 "who calls X / where is X / what breaks if I rename X" typed in the composer: answered from the code graph with no agent
   * turn. Null (the caller sends the message to the agent as usual) unless the text is clearly such a question, the thread is a
   * code thread in an indexed repo, and the graph answers in time. The answer is also queued as a one-shot note for the thread's
   * next agent turn; `discardQuickNotes` drops it when the user sends the question to the agent anyway.
   */
  async quickAnswer(threadId: ThreadId, text: string): Promise<QuickAnswer | null> {
    try {
      if (!quickAnswersOn()) return null;
      const meta = this.store.tryGet(threadId);
      if (!meta || isBlobsCwd(meta.cwd) || !this.runtime.graph.status) return null;
      const q = parseQuickQuestion(text) ?? parseQuickQuestionPlain(text); // a plain word is answered only when the graph holds exactly one declaration of it
      if (!q) return null;
      const graph = this.runtime.graph;
      const a = await answerQuickQuestion(q, meta.cwd, { status: (c) => graph.status!(c), callTool: (n, args, o) => graph.callTool(n, args, o) });
      if (!a) return null;
      const notes = this.quickNotes.get(threadId) ?? [];
      notes.push(`[kora] The user asked "${text.trim().slice(0, 160)}" in the composer and Kora answered it from the code graph without a turn:\n${a.text}`);
      this.quickNotes.set(threadId, notes.slice(-3));
      logCost({ k: 'quick', ts: Date.now(), thread: threadId, chars: a.text.length });
      return a;
    } catch { return null; }
  }
  discardQuickNotes(threadId: ThreadId): void {
    if (this.quickNotes.delete(threadId)) logCost({ k: 'quick-discard', ts: Date.now(), thread: threadId });
  }

  /** B5 "fresh thread with a brief": a hand-over drafted by a side session (Haiku, no tools) from a local digest of the thread. */
  async threadBrief(threadId: ThreadId): Promise<BriefResult | null> {
    const meta = this.store.tryGet(threadId);
    if (!meta || meta.agent !== 'claude' || typeof meta.resume !== 'string') return null;
    // One drafting at a time per thread (S6 2026-10-14): each is a model call and a child process, and a double click or a script
    // must not stack them. A second request while one runs shares its answer.
    const running = this.briefsRunning.get(threadId);
    if (running) return running;
    const configDir = this.claudeConfigDirFor(meta);
    const p = draftBriefForSession({ sessionId: meta.resume, cwd: meta.cwd, configDir, ...(configDir ? { accountEnv: { CLAUDE_CONFIG_DIR: configDir } } : {}) })
      .finally(() => { this.briefsRunning.delete(threadId); });
    this.briefsRunning.set(threadId, p);
    return p;
  }
  private briefsRunning = new Map<ThreadId, Promise<BriefResult | null>>();

  /** Backfill the event log from a cursor (the crash/reconnect recovery path, §5). */
  backfill(threadId: ThreadId, sinceSeq = 0, limit?: number): { events: ChatEvent[]; nextSeq: number } {
    return this.store.read(threadId, sinceSeq, limit ?? Infinity);
  }

  // ── the fan-out (the one place seq is stamped and events are persisted) ──────────
  private onEvent(e: ChatEvent): void {
    const threadId = e.threadId;
    if (!threadId || !this.store.has(threadId)) return;
    if (this.live.has(threadId)) this.lastActive.set(threadId, Date.now());
    // (1) stamp the gap-free seq + (2) append to the log (source of truth).
    const sealed = this.store.append(threadId, e);
    if (e.type === 'usage.limits') { try { this.planHeadroom.observe(e.report); } catch { /* advisory */ } }
    // Auto model: a light thread that grew past Haiku 5.5's cheap tier (100k) is not light work: it moves up at its next prompt.
    if (e.type === 'thread.token-usage' && (e.usage?.usedTokens ?? 0) >= AUTO_LIGHT_GROWN_TOKENS) { try { const a = this.store.tryGet(threadId)?.autoModel; if (a && a.model === AUTO_LIGHT_MODEL && !a.big) this.store.update(threadId, { autoModel: { ...a, big: true } }); } catch { /* advisory */ } }
    // Auto model: a light thread that looked stuck, or began to lead (asked for workers), moves up at its next prompt.
    if (e.type === 'turn.stuck' || e.type === 'worker-picker.requested') { try { const a = this.store.tryGet(threadId)?.autoModel; if (a && a.model !== 'default' && (!a.escalated || a.model === AUTO_MID_MODEL) && !a.stuck && !(a.lead && e.type !== 'turn.stuck')) this.store.update(threadId, { autoModel: { ...a, ...(e.type === 'turn.stuck' ? { stuck: true } : { lead: true }) } }); } catch { /* advisory */ } }
    if (e.type === 'turn.settled' && e.usage && this.runtime.blobs?.recordTurnUsage) {
      try { const m = this.store.tryGet(threadId); if (m) this.runtime.blobs.recordTurnUsage(m.cwd, threadId, e.usage); } catch { /* advisory */ }
    }
    // (3) update the thread head.
    this.applyHead(threadId, sealed);
    this.autoResume(threadId, sealed);
    // (4) re-emit on the Runtime's notify channel.
    this.runtime.notify(CHAT_EVENT, sealed);
    const subs = this.threadSubs.get(threadId);
    if (subs) for (const cb of [...subs]) { try { cb(sealed); } catch (err) { console.error('[kora] thread subscriber failed:', err); } }
  }

  // ── auto-resume: a chat turn that died on a transient error (dropped stream, network blip, overloaded) is continued on
  // its own, backed off, up to ERROR_STALL_MAX_RETRIES in a row (a finished turn or the user's own message resets the count;
  // progress inside a turn does not, or a failure that recurs after a few tool calls would be continued forever).
  // A worker's hidden thread is retried by its DriverPane, a stopped/interrupted turn and every limit/auth error never.
  private resumeTimers = new Map<ThreadId, NodeJS.Timeout>();
  private resumeCount = new Map<ThreadId, number>();
  private cancelAutoResume(threadId: ThreadId): void {
    const t = this.resumeTimers.get(threadId); if (t) { clearTimeout(t); this.resumeTimers.delete(threadId); }
  }
  private autoResume(threadId: ThreadId, e: ChatEvent): void {
    try {
      if (e.type === 'turn.started') { this.cancelAutoResume(threadId); return; }
      if (e.type !== 'turn.settled') return;
      if (e.state === 'completed') { this.resumeCount.delete(threadId); return; }
      if (e.state !== 'failed' || !e.errorMessage) return;
      const meta = this.store.tryGet(threadId);
      if (!meta || (meta as { workerPaneId?: string | null }).workerPaneId) return;
      const retry = retryableErrorText(e.errorMessage);
      const used = this.resumeCount.get(threadId) ?? 0;
      if (!retry || used >= ERROR_STALL_MAX_RETRIES) return;
      const attempt = used + 1;
      this.resumeCount.set(threadId, attempt);
      const delays = retry.kind === 'rate-limit' ? DRIVER_RATE_LIMIT_DELAYS_MS : DRIVER_RETRY_DELAYS_MS;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)]!;
      this.cancelAutoResume(threadId);
      this.onEvent({ type: 'runtime.warning', threadId, message: `${retry.text} — continuing automatically in ${Math.round(delay / 1000)} s (retry ${attempt}/${ERROR_STALL_MAX_RETRIES})`, seq: 0, at: Date.now() } as ChatEvent);
      const timer = setTimeout(() => {
        this.resumeTimers.delete(threadId);
        const cur = this.store.tryGet(threadId);
        if (!cur || cur.state === 'running' || cur.state === 'waiting') return; // the user already moved on
        void this.sendTurn({ threadId, text: 'continue', origin: 'kora-notice', continuation: true }).catch((err) => console.error('[kora] auto-resume failed:', err?.message ?? err));
      }, delay);
      timer.unref?.();
      this.resumeTimers.set(threadId, timer);
    } catch (err) { console.error('[kora] auto-resume skipped:', (err as Error)?.message ?? err); }
  }

  /** Fold one event into the persisted thread head (state, lastSeq, workerPaneIds). */
  private applyHead(threadId: ThreadId, e: ChatEvent): void {
    const meta = this.store.tryGet(threadId); if (!meta) return;
    const patch: Partial<ThreadMeta> = { lastSeq: e.seq };
    switch (e.type) {
      case 'turn.started': patch.state = 'running'; break;
      case 'turn.settled': patch.state = e.state === 'failed' ? 'error' : 'idle'; break;
      case 'session.state': patch.state = mapSessionState(e.state); break;
      case 'session.exited': patch.state = 'stopped'; break;
      case 'runtime.error': patch.state = 'error'; break;
      case 'thread.started': if (e.providerThreadId) patch.resume = e.providerThreadId; break;
      case 'approval.opened': patch.state = 'waiting'; break;
      case 'user-input.requested': patch.state = 'waiting'; break;
      case 'worker-picker.requested': patch.state = 'waiting'; break;
      case 'worker.attached': {
        const ids = new Set(meta.workerPaneIds); ids.add(e.paneId); patch.workerPaneIds = [...ids];
        // D4: the orchestrator thread's proxy pane owns these workers via orchestratorId=proxyPaneId.
        break;
      }
      case 'worker.detached': patch.workerPaneIds = meta.workerPaneIds.filter((id) => id !== e.paneId); break;
    }
    const next = this.store.update(threadId, patch);
    // Only push a head update to clients for meaningful changes (not every delta) to keep it quiet.
    if (patch.state !== undefined || patch.workerPaneIds !== undefined) this.runtime.notify(THREAD_UPDATED, next);
  }

  private setState(threadId: ThreadId, state: ThreadRuntimeState): void {
    const next = this.store.update(threadId, { state });
    this.runtime.notify(THREAD_UPDATED, next);
  }
  private pushHead(meta: ChatThreadInfo): void { this.runtime.notify(THREAD_UPDATED, meta); }

  /**
   * Stop live sessions nobody is using. Each live Claude session is a `claude` process (a few hundred MB) that stays up
   * waiting for the next prompt, so a daemon that runs for weeks accumulated one per thread ever opened. A reaped
   * thread looks the same in the UI (session.exited has no transcript row) and its next turn resumes the provider
   * session (ensureLive), paying a few seconds of start-up once. Only a settled thread is reaped — never one running a
   * turn or waiting on an approval/question. A fleet thread (orchestrator / swarm) that still lists workers waits
   * 4× longer: its workers' notes arrive as turns. Past `maxLive`, the least recently active settled sessions go
   * first. Returns the reaped thread ids.
   */
  async reapIdle(opts: { idleMs: number; maxLive: number; now?: number }): Promise<ThreadId[]> {
    const now = opts.now ?? Date.now();
    const settled: { id: ThreadId; at: number; limit: number }[] = [];
    const gone = new Set<ThreadId>();
    for (const id of this.live.keys()) {
      const meta = this.store.tryGet(id);
      if (!meta) { settled.push({ id, at: 0, limit: 0 }); gone.add(id); continue; } // deleted under us
      if (meta.state !== 'idle' && meta.state !== 'error' && meta.state !== 'stopped') continue;
      const fleet = isFleetAgentMode(meta.agentMode ?? (meta.isOrchestrator ? 'orchestrator' : 'chat')) && meta.workerPaneIds.length > 0;
      settled.push({ id, at: this.lastActive.get(id) ?? 0, limit: fleet ? opts.idleMs * 4 : opts.idleMs });
    }
    const reap = new Set<ThreadId>();
    if (opts.idleMs > 0) for (const s of settled) if (now - s.at >= s.limit) reap.add(s.id);
    const over = this.live.size - reap.size - Math.max(1, opts.maxLive);
    if (over > 0) for (const s of settled.filter((x) => !reap.has(x.id)).sort((a, b) => a.at - b.at).slice(0, over)) reap.add(s.id);
    for (const id of reap) await this.stop(id, gone.has(id) ? undefined : { idle: true }).catch(() => {}); // a deleted thread's warm chain ends too
    return [...reap];
  }

  /** Live provider sessions (each one a running agent process). */
  liveCount(): number { return this.live.size; }

  /** Run reapIdle every `everyMs` (KORA_CHAT_IDLE_MIN, default 30; 0 = off. KORA_CHAT_MAX_LIVE, default 8). */
  startIdleReaper(everyMs = 60_000, log: (msg: string) => void = () => {}): () => void {
    const idleMin = Number(process.env.KORA_CHAT_IDLE_MIN ?? 30);
    const maxLive = Number(process.env.KORA_CHAT_MAX_LIVE ?? 8);
    if (!Number.isFinite(idleMin) || idleMin <= 0) return () => {};
    let busy = false;
    const t = setInterval(() => {
      if (busy) return; busy = true;
      this.reapIdle({ idleMs: idleMin * 60_000, maxLive: Number.isFinite(maxLive) && maxLive > 0 ? maxLive : 8 })
        .then((ids) => { if (ids.length) log(`chat: stopped ${ids.length} idle session(s) (${ids.join(', ')}); ${this.live.size} live`); })
        .catch(() => {}).finally(() => { busy = false; });
    }, everyMs);
    t.unref();
    return () => clearInterval(t);
  }

  /** Claude plan usage through an already-running chat session (no process start, no turn); null when none is live. */
  async readLivePlanUsage(): Promise<import('./events').UsageLimitsReport | null> {
    const d = this.drivers.get('claude') as ClaudeDriver | undefined;
    return d?.readPlanUsage ? d.readPlanUsage() : null;
  }

  /** Graceful teardown of all live sessions (daemon shutdown). Threads persist on disk. */
  async shutdown(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.stop(id).catch(() => {});
    for (const d of this.drivers.values()) await (d as { shutdown?(): Promise<void> }).shutdown?.()?.catch?.(() => {}); // AcpDriver closes every agent process
    for (const unsub of this.unsubs.values()) try { unsub(); } catch { /* ignore */ }
    this.unsubs.clear(); this.drivers.clear();
    try { this.offTrust(); } catch { /* ignore */ }
    try { this.offBlobs(); } catch { /* ignore */ }
    await shutdownCacheWarm().catch(() => {}); // the keep-warm proxy child (no-op when it never started)
  }
}

/** True when trust changing at `root` affects a session in `cwd` (the folder or its repo root sits under it). */
function folderCoveredBy(cwd: string, root: string): boolean {
  const under = (p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  let real = cwd; try { real = fs.realpathSync(cwd); } catch { /* missing */ }
  try { return under(real) || under(resolveTrustRoot(cwd)); } catch { return under(real); }
}

function assertSwarmLeader(agent: AgentId): void {
  if (!SWARM_LEADER_AGENTS.has(agent)) throw new Error(`Swarm mode needs a Claude, Codex or OpenCode leader; this thread runs ${agent}.`);
}

/** The `[kora] …` notice for a mode switch the agent must hear; null when it needs none (neither side is swarm). */
function modeNotice(from: ThreadAgentMode, to: ThreadAgentMode): PendingModeNotice | null {
  let text: string | null;
  try { text = swarmModeNotice(from, to); }
  catch { text = fallbackModeNotice(from, to); }
  return text ? { from, to, text } : null;
}
/** Only while server/swarm-skill.ts has no swarmModeNotice yet (the W0 stub throws): same contract, plainer text. */
function fallbackModeNotice(from: ThreadAgentMode, to: ThreadAgentMode): string | null {
  if (to === 'swarm') return '[kora] User has switched to Swarm mode. Load /koraswarm (the koraswarm skill; if you cannot load skills, read ~/.kora/skills/swarm.md) and follow it for the rest of this thread.';
  if (from === 'swarm') return `[kora] User left Swarm mode (now ${to === 'chat' ? 'Chat' : 'Orchestrator'}). Stop dispatching swarm workers.`;
  return null;
}
function installSkillSafely(): void {
  try { installSwarmSkill(); }
  catch (e: any) { console.error('[kora] installSwarmSkill failed:', e?.message ?? e); }
}

function mapSessionState(s: import('./events').SessionState): ThreadRuntimeState {
  switch (s) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'stopped': return 'stopped';
    case 'error': return 'error';
    default: return 'idle';
  }
}
function permissionToRuntimeMode(mode: PermissionMode): RuntimeMode {
  switch (mode) {
    case 'auto-accept-edits': return 'auto-accept-edits';
    case 'auto': return 'auto';
    case 'full-access': return 'full-access';
    default: return 'approval-required';
  }
}

/** The real SDK query, loaded lazily so tests (which inject their own) never require the SDK. */
function defaultQueryFn(): import('./drivers/claude-driver').QueryFn {
  return (params) => {
    const { query } = require('@anthropic-ai/claude-agent-sdk');
    return query(params);
  };
}

/** Claude Code files a session under <config dir>/projects/<cwd with every non-alphanumeric turned into "-">/<id>.jsonl. */
export function claudeProjectSlug(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function copyClaudeTranscript(sessionId: string, fromCwd: string, toCwd: string): boolean {
  try {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return false;
    const base = path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects');
    let src: string | null = null;
    for (const c of [fromCwd, safeReal(fromCwd)]) { const f = path.join(base, claudeProjectSlug(c), `${sessionId}.jsonl`); if (fs.existsSync(f)) { src = f; break; } }
    if (!src) return false;
    for (const c of new Set([toCwd, safeReal(toCwd)])) {
      const dest = path.join(base, claudeProjectSlug(c), `${sessionId}.jsonl`);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    return true;
  } catch { return false; }
}
function safeReal(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

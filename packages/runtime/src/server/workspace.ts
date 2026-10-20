// Runtime: workspaces, panes, spawning (env injection + enforcement + graph), agent prompt/wait,
// foreground-process agent identification, persistence. The daemon maps JSON-RPC onto this.
import { EventEmitter } from 'node:events';
import { LedgerService } from '../ledger/service';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, AgentState, Methods, Notifications, PaneInfo, WorkspaceInfo, RestartMode, FleetEvent, RosterEntry, MergePair } from '../protocol/types';
import { defaultSocketPath, GraphChannel, koraHome } from '../protocol/types';
import { loadConfig } from '../config';
import { isUnder } from './autoanswer';
import { writeResumeBrief } from './resume';
import type { LedgerSummary } from '../ledger/transcript';
import { assistantTurns, findTranscript, guessClaudeTranscript } from '../ledger/transcript';
import { createGraphService, GraphService } from '../graph';
import { unsafeIndexRoot } from '../graph/embedded';
import { createEnforcer, Enforcer } from '../enforce';
import { agentFromArgv, agentFromArgvTokens, agentFromPsArgs, agentCommand, isKnownAgent } from '../detect';
import { adapterFor } from '../detect/agent-adapter';
import { Pane } from './pane';
import { DriverPane, type WorkerDriverHost } from './driver-pane';
import { pluginFeedItem } from './worker-feed';
import type { WorkerFeedItem } from './worker-feed';
import type { RuntimeMode } from '../session/events';
import { orchestratorPlaybook, orchestratorPlaybookPath, claudeSkillDoc, activationPrompt } from './orchestrator-skill';
import { log } from './log';
import { PersistedState, loadState, saveState, flush, restoreCommand, stripResume, stateFileFor } from './state';
import { autoName } from '../util/naming';
import { SwarmService } from './swarm';
import { SwarmSetup } from './swarm-setup';
import { SwarmHealth } from './swarm-health';
import { swarmIdleConfirmed } from './swarm-state';
import { confirmInputEmptied, confirmStartupDelivery } from './prompt-delivery';
import { cleanSteerText, isSteerText } from './steer-text';
import { detectErrorStall, errorStallFromTranscript, nextErrorStall, ERROR_STALL_CONTINUE } from './error-stall';
import { assertDiskRoom, withDiskGuard } from './disk';
import { capSize } from '../util/bounded';
import { ChildLedger, setSharedChildLedger } from './children';
import { baseEnv, type EnvPolicy } from './worker-env';
import { claudePrivacyEnv } from '../util/claude-privacy';
import { claudeCompactEnv } from '../util/claude-compaction';
import { GIT_NO_FSMONITOR, GIT_TIMEOUT_MS, gitEnv } from '../util/safe-path';
import { gitPath, userShell } from '../util/win-exec';
import { listWindowsProcesses, splitWindowsCommandLine } from '../util/win-procs';

export interface Workspace {
  id: string; name: string; cwd: string; paneIds: string[]; activePaneId: string | null;
  /** Never persisted and never the active workspace: holds the chat UI's panes (fleet workers, terminal tiles),
   *  which belong to chat threads — a daemon restart must not re-spawn them as orphan TUI panes. */
  ephemeral?: boolean;
}

/**
 * A repo this machine also runs the previous runtime in carries that runtime's hooks in .claude/settings.local.json,
 * and Claude Code fires every hook it finds. Its prompt hook would inject a second set of declarations and its
 * pre-tool hook would redirect Grep to a CLI kora does not ship; these two variables (the previous runtime's own
 * switches) make those hooks stand down inside a kora session. Harmless where they are not installed.
 */
export const LEGACY_HOOK_ENV: Record<string, string> = { ['NH' + 'ANDS_INJECT_OWNER']: 'driver', ['NH' + 'ANDS_ASSUME_GRAPH']: '0' };

/** What a chat (SDK) session gets instead of a pane's argv — see Runtime.prepareChatSession. */
export interface ChatSessionPrep { env: Record<string, string>; appendSystemPrompt?: string; strictMcp?: boolean; notes: string[] }

const EXITED_PANE_GRACE_MS = 30_000;
const FG_WATCH_MS = 2_000;
/** Windows lists processes through PowerShell (~0.5 s a start): the watcher queries at most this often there. */
const FG_WATCH_WIN_MS = 6_000;

/**
 * Auto-indexing must be graceful: never walk a home directory, a filesystem root, or a shallow mount just because
 * someone opened a terminal there. Refuse the home dir, any ancestor of it (`/`, `/Users`, …), the fs root, and
 * any path fewer than two segments deep. A real project deeper than that indexes; a home / prod / dev-server dir
 * does not — it just shows as "not indexed", and the user can `kora ingest .` if they actually want it.
 */
export function isSafeToAutoIndex(root: string): boolean {
  // The one rule every ingest path uses (graph/embedded.ts): also refuses macOS system trees and temp/volume roots,
  // which this copy used to let through.
  return unsafeIndexRoot(root) === null;
}
const MAX_WAIT_MS = 60 * 60 * 1000;
const AUTO_COMPACT_MIN_GAP_MS = 10 * 60 * 1000;
const AUTO_ANSWER_KEY_GAP_MS = 400;

export function binPath(): string { return path.resolve(__dirname, '..', '..', 'bin', 'kora.js'); }

export class Runtime extends EventEmitter {
  workspaces = new Map<string, Workspace>();
  panes = new Map<string, Pane>();
  activeWorkspaceId: string | null = null;
  graph: GraphService; enforcer: Enforcer;
  readonly socketPath: string; readonly binPath = binPath(); readonly startedAt = Date.now();
  /** Persisted panes for THIS runtime (keyed by socket — see state.ts stateFileFor). */
  readonly stateFile: string;
  private nextPane = 1; private nextWs = 1;
  private ingested = new Set<string>();
  private lastIndex = new Map<string, { sha: string | null; at: number }>(); // per root: HEAD at the last index we ran
  readonly ledger = new LedgerService();
  /** Live panes' process groups, persisted beside the state file, so a crashed daemon's agents are reaped at start. */
  readonly children: ChildLedger;
  private fgTimer: NodeJS.Timeout | null = null; private fgBusy = false; private fgLastWin = 0;
  private closing = false;
  private fleets = new Map<string, { plan: string; events: FleetEvent[] }>(); // per orchestrator
  /** Swarm workers (spawn / follow / failover / reports). */
  readonly swarm: SwarmService;
  /** Swarm setup (status / install / keys / consent); the ui-server's `UiHost.swarm`. */
  readonly swarmSetup: SwarmSetup;

  constructor(socketPath = defaultSocketPath()) {
    super();
    this.socketPath = socketPath; this.stateFile = stateFileFor(socketPath);
    this.children = new ChildLedger(this.stateFile.replace(/\.json$/, '') + '.children.json');
    setSharedChildLedger(this.children);
    this.graph = safeGraph(); this.enforcer = safeEnforcer(this.graph);
    const swarmHealth = new SwarmHealth();
    this.swarmSetup = new SwarmSetup({ health: swarmHealth });
    this.swarm = new SwarmService({ runtime: this, setup: this.swarmSetup, health: swarmHealth });
    this.fgTimer = setInterval(() => this.fgTick(), FG_WATCH_MS); this.fgTimer.unref();
    const wtTimer = setInterval(() => this.refreshWorktreeStatus(), 5000); wtTimer.unref();
    // Freshness follows commits: every 20 s each live pane's graph state is re-read (one cached store read per repo)
    // so a HEAD that moved shows as stale and gets its incremental re-index without anyone asking.
    const freshTimer = setInterval(() => { for (const p of this.panes.values()) if (!p.exited && !p.graph.indexing) this.refreshGraphInfo(p).catch(() => {}); }, 20_000); freshTimer.unref();
    this.ledger.on('updated', (paneId: string, summary: LedgerSummary) => {
      const p = this.panes.get(paneId); if (!p) return;
      p.ledger = summary; this.notify('ledger.updated', { paneId, summary });
      try { this.onLedger(p, summary); } catch (e) { log(`pane ${paneId}: ledger reaction failed`, e); }
      this.notify('pane.updated', p.info());
    });
  }

  notify<N extends keyof Notifications>(method: N, params: Notifications[N]) { this.emit('notify', method, params); }

  // ---------- workspaces ----------
  workspaceInfo(w: Workspace): WorkspaceInfo { return { id: w.id, name: w.name, cwd: w.cwd, paneIds: [...w.paneIds], activePaneId: w.activePaneId }; }
  listWorkspaces(): { workspaces: WorkspaceInfo[]; activeWorkspaceId: string | null } { return { workspaces: [...this.workspaces.values()].map((w) => this.workspaceInfo(w)), activeWorkspaceId: this.activeWorkspaceId }; }
  createWorkspace(name?: string, cwd?: string, id?: string, opts: { ephemeral?: boolean } = {}): Workspace {
    const wid = id ?? `w${this.nextWs++}`;
    if (id) { const n = Number(id.slice(1)); if (n >= this.nextWs) this.nextWs = n + 1; }
    const dir = resolveCwd(cwd);
    const w: Workspace = { id: wid, name: name || path.basename(dir) || wid, cwd: dir, paneIds: [], activePaneId: null, ...(opts.ephemeral ? { ephemeral: true } : {}) };
    this.workspaces.set(wid, w);
    if (!this.activeWorkspaceId && !opts.ephemeral) this.activeWorkspaceId = wid;
    this.workspacesChanged();
    if (!opts.ephemeral) this.warmBrief(dir); // fill the brief cache now so a claude pane opened here later doesn't wait on a cold graph
    return w;
  }
  /** The ephemeral workspace chat threads' panes live in (created on first use). */
  chatWorkspaceId(): string {
    for (const w of this.workspaces.values()) if (w.ephemeral && w.name === 'chat') return w.id;
    return this.createWorkspace('chat', os.homedir(), undefined, { ephemeral: true }).id;
  }

  /**
   * Prepare an SDK-driven chat session the way spawnPane prepares an agent pane: the same enforcer.prepare (CLAUDE.md
   * rulebook block + hooks in .claude/settings.local.json, PATH shims) and the same KORA_* identity — with
   * KORA_SOCKET_PATH pointing at THIS runtime, so the session's hooks report to the daemon that drives it. The
   * pane's argv is translated for the SDK: `--append-system-prompt` → appendSystemPrompt, `--strict-mcp-config` →
   * strictMcp; `--mcp-config` is dropped (the session carries its own in-process MCP server). KORA_INJECT_OWNER=driver
   * makes the UserPromptSubmit hook leave declaration injection to the ClaudeDriver (one injection per prompt).
   */
  async prepareChatSession(p: { threadId: string; agent: AgentId; cwd: string; account?: string | null }): Promise<ChatSessionPrep> {
    const paneId = `chat:${p.threadId}`;
    const cwd = resolveCwd(p.cwd);
    const { isBlobsCwd } = require('../blobs/home') as typeof import('../blobs/home');
    const env: Record<string, string> = {
      KORA_ENV: '1', KORA_PANE_ID: paneId, KORA_SOCKET_PATH: this.socketPath, KORA_BIN: this.binPath,
      KORA_AGENT: p.agent, KORA_INJECT_OWNER: 'driver', ...LEGACY_HOOK_ENV, ...callerKeyEnv(paneId),
    };
    // The assistant lane is not a repo: no CLAUDE.md rulebook block, no `.claude/settings.local.json` hooks to
    // install there (there is no graph to inject or redirect Grep for). Keep the KORA_* identity env only — the
    // fleet tools (kora_spawn/kora_map/kora_wait…) and the daemon connection still need it.
    if (isBlobsCwd(cwd)) return { env, notes: ['assistant folder: no rulebook/hooks (no graph)'] };
    let repoRoot: string | null = null;
    try { repoRoot = this.graph.repoRoot(cwd); } catch { /* not a repo */ }
    env.KORA_REPO_ROOT = repoRoot ?? '';
    if (p.agent === 'claude') this.warmBrief(cwd, p.agent);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
    const plan = await this.enforcer.prepare({ agent: p.agent, cwd, paneId, socketPath: this.socketPath, binPath: this.binPath, command: agentCommand(p.agent), args: [], env: { ...base, ...env }, noRepoWrites: !this.chatFolderTrusted(cwd) });
    Object.assign(env, plan.env ?? {});
    const out: ChatSessionPrep = { env, notes: [...(plan.notes ?? [])] };
    const args = plan.args ?? [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--append-system-prompt' && i + 1 < args.length) out.appendSystemPrompt = args[++i];
      else if (a === '--strict-mcp-config') out.strictMcp = true;
      else if (a === '--mcp-config') i++;
    }
    return out;
  }

  /** An untrusted folder gets no files written into it by Kora (trust/gate.ts): the first send used to drop CLAUDE.md and .claude/settings.local.json there. */
  private chatFolderTrusted(cwd: string): boolean { try { return require('../trust/store').isFolderTrusted(cwd); } catch { return false; } }

  /**
   * A chat session resumed or started in `cwd`: if that checkout is ALREADY indexed and its index is behind HEAD, run
   * the same incremental re-index a pane gets (once per HEAD, at most every 30 s per repo, off the event loop). Never
   * a first index — the chat UI asks before indexing a new directory.
   */
  ensureChatGraphFresh(cwd: string, opts: { headMoved?: boolean } = {}): void {
    (async () => {
      const st = await this.graph.status(cwd, opts.headMoved ? { nocache: true } : undefined);
      const root = st.repoRoot;
      if (!root || !st.indexed || st.staleForCheckout || !st.stale || process.env.KORA_AUTO_INGEST === '0') return;
      const last = this.lastIndex.get(root);
      // Kora's own merge moved HEAD (its git runs with hooks off, so the repo's post-merge re-index never fires): catch
      // up now, not 30 s or a message later -- the chip read amber "Out of date" right after a successful Swarm merge.
      if (last && ((last.sha === st.headSha && !st.dirtyFiles) || (!opts.headMoved && Date.now() - last.at < 30_000))) return; // uncommitted edits keep HEAD put: only the 30 s gap guards those
      capSize(this.lastIndex, 1000); this.lastIndex.set(root, { sha: st.headSha ?? null, at: Date.now() });
      log(`graph: chat session in ${root} → incremental re-index (index at ${(st.indexedSha || '').slice(0, 7)}, HEAD ${(st.headSha || '').slice(0, 7)})`);
      await this.graph.ingest(root, { wait: false });
    })().catch((e) => log(`graph: chat freshness check for ${cwd} failed`, e));
  }

  private warmedBriefs = new Set<string>();
  /** Pre-compute the session-start brief for a cwd in the background, so a pane's SessionStart hook reads a warm
   *  disk cache (~ms) instead of computing a multi-second brief against a large graph while the human waits. The
   *  daemon is long-lived, so warming once per cwd at workspace/pane creation keeps opens fast. Fire-and-forget. */
  private warmBrief(cwd: string, agent: AgentId = 'claude'): void {
    const key = `${cwd}\u0000${agent}`;
    if (this.warmedBriefs.has(key)) return;
    capSize(this.warmedBriefs, 1000); this.warmedBriefs.add(key);
    Promise.resolve().then(() => this.graph.brief(cwd, agent)).catch(() => { this.warmedBriefs.delete(key); });
  }
  selectWorkspace(id: string) { this.requireWorkspace(id); this.activeWorkspaceId = id; this.workspacesChanged(); }
  closeWorkspace(id: string) {
    const w = this.requireWorkspace(id);
    for (const pid of [...w.paneIds]) this.removePane(pid, true);
    this.workspaces.delete(id);
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = this.workspaces.keys().next().value ?? null;
    this.workspacesChanged();
  }
  private workspacesChanged() { this.notify('workspace.updated', this.listWorkspaces()); this.persist(); }
  requireWorkspace(id: string): Workspace { const w = this.workspaces.get(id); if (!w) throw new Error(`no such workspace: ${id}`); return w; }
  requirePane(id: string): Pane { const p = this.panes.get(id); if (!p) throw new Error(`no such pane: ${id}`); return p; }
  activeWorkspace(): Workspace | null { return this.activeWorkspaceId ? this.workspaces.get(this.activeWorkspaceId) ?? null : null; }
  private workspaceFor(workspaceId?: string, cwd?: string): Workspace {
    if (workspaceId) return this.requireWorkspace(workspaceId);
    return this.activeWorkspace() ?? this.createWorkspace(undefined, cwd);
  }

  // ---------- panes ----------
  listPanes(workspaceId?: string): PaneInfo[] {
    return [...this.panes.values()].filter((p) => !workspaceId || p.workspaceId === workspaceId).map((p) => p.info());
  }
  listAgents(): PaneInfo[] { return [...this.panes.values()].filter((p) => isKnownAgent(p.agent)).map((p) => p.info()); }

  async spawnPane(params: Methods['pane.spawn']['params'], opts: { id?: string; agentSessionId?: string | null; worktree?: PaneInfo['worktree']; budgetUsd?: number | null; account?: string | null; envPolicy?: EnvPolicy; eventStream?: boolean } = {}): Promise<PaneInfo> {
    const cwd = resolveCwd(params.cwd ?? this.activeWorkspace()?.cwd);
    const ws = this.workspaceFor(params.workspaceId, cwd);
    const shell = userShell();   // $SHELL, or Git bash / cmd.exe on Windows (util/win-exec.ts)
    let command = params.command || shell;
    let args = params.args ? [...params.args] : (params.command ? [] : ['-l']);
    if (!params.command && !/zsh|bash|fish|sh(\.exe)?$/i.test(shell)) args = [];
    // The user's shell, started so that its own rc files run and the kora shims still end up first on PATH
    // (a plain login shell let path_helper / .zshrc push them behind the real `claude`).
    // Also for a pane RESTORED from state.json (its recorded args are ours: `-l` / `--rcfile …`) — a server restart
    // must not hand back shells without the shims.
    let shellEnv: Record<string, string> = {};
    const defaultShell = !params.command || (/(^|\/)(zsh|bash|sh|dash|ash|fish)$/.test(params.command) && (!params.args || params.args.length === 0 || params.args[0] === '-l' || params.args[0] === '--rcfile'));
    if (defaultShell) { try { const { shellLaunch } = require('../enforce/shims'); const l = shellLaunch(params.command || shell); if (l) { args = l.args; shellEnv = l.env; } } catch { /* plain shell */ } }
    const agent: AgentId = params.agent ?? agentFromArgv(command, args);
    if (agent === 'claude') this.warmBrief(cwd, agent); // warm the brief while the agent boots, so SessionStart is instant
    const id = opts.id ?? `p${this.nextPane++}`;
    if (opts.id) { const n = Number(opts.id.slice(1)); if (n >= this.nextPane) this.nextPane = n + 1; }
    const cols = params.cols ?? 120, rows = params.rows ?? 40;
    // An event-driven agent (Koragent) listens on ~/.kora/panes/<id>.sock: the id is known only here, so the flag is
    // appended here. A stale socket file from an earlier daemon's pane with the same id is removed first.
    let eventSocketPath: string | null = null;
    if (opts.eventStream) {
      eventSocketPath = require('./koragent-backend').paneSocketPath(koraHome(), id) as string;
      // A folder someone else owns (the /tmp fallback has a predictable name) is refused: the spawn fails (audit #8).
      require('./koragent-backend').ensurePrivateSocketDir(path.dirname(eventSocketPath));
      try { fs.rmSync(eventSocketPath, { force: true }); } catch (e) { log(`pane ${id}: event socket`, e); }
      args = [...args, '--event-stream', `unix:${eventSocketPath}`];
    }
    // A assistant-lane pane (a swarm worker in ~/.kora/chat/...) is not in a repo: no graph, no rulebook, no hooks,
    // nothing written into the user's chat folder.
    const chatSurface = (require('../blobs/home') as typeof import('../blobs/home')).isBlobsCwd(cwd);
    let repoRoot: string | null = null;
    if (!chatSurface) { try { repoRoot = this.graph.repoRoot(cwd); } catch (e) { log('graph.repoRoot failed', e); } }
    // Shell panes and orchestrator workers inherit the daemon's env (minus a parent session's markers); a Swarm
    // worker (third-party model) gets an allowlisted env and only its own provider key — see worker-env.ts.
    const env: Record<string, string> = baseEnv(process.env, opts.envPolicy ?? 'inherit');
    Object.assign(env, shellEnv, {
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
      KORA_ENV: '1', KORA_PANE_ID: id, KORA_SOCKET_PATH: this.socketPath, KORA_BIN: this.binPath,
      KORA_AGENT: agent, KORA_REPO_ROOT: repoRoot ?? '', ...LEGACY_HOOK_ENV, ...callerKeyEnv(id),
    }, agent === 'claude' ? { ...claudePrivacyEnv(), ...claudeCompactEnv(((a) => { const i = a.indexOf('--model'); return i >= 0 ? a[i + 1] : undefined; })(params.args ?? [])) } : {}, adapterFor(agent).spawnEnv(id, opts.account ?? null), params.env ?? {});
    let enforced = false;
    if (chatSurface) {
      log(`pane ${id}: assistant lane — no enforcement (no graph)`);
    } else if (isKnownAgent(agent) && params.enforce !== false) {
      try {
        // An untrusted main checkout gets nothing written into it (the rulebook rides as a system prompt); a worker's own
        // worktree under <KORA_HOME>/worktrees is Kora's folder and keeps its block + hooks (pl5 S2-1).
        const ownWorktree = (() => { try { const r = fs.realpathSync(require('./worktree').worktreesDir()); return fs.realpathSync(cwd).startsWith(r + path.sep); } catch { return false; } })();
        const plan = await this.enforcer.prepare({ agent, cwd, paneId: id, socketPath: this.socketPath, binPath: this.binPath, command, args, env, noRepoWrites: !ownWorktree && !this.chatFolderTrusted(cwd) });
        command = plan.command || command; args = plan.args ?? args; Object.assign(env, plan.env ?? {});
        enforced = (plan.notes?.length ?? 0) > 0;
        for (const n of plan.notes ?? []) log(`pane ${id}: enforce: ${n}`);
      } catch (e) { log(`pane ${id}: enforcer.prepare failed (continuing without)`, e); }
    } else if (params.enforce !== false) {
      // A shell pane still gets the PATH shims (grep/rg/find hits, and the `claude`/`codex` launchers that set the
      // repo up and warm the graph before exec) and the shell rc wiring that keeps them first — measured: without
      // this a hand-typed `claude` bypassed kora entirely. `agent: 'shell'` makes prepare() touch no repo files.
      try { const plan = await this.enforcer.prepare({ agent: 'shell', cwd, paneId: id, socketPath: this.socketPath, binPath: this.binPath, command, args, env }); Object.assign(env, plan.env ?? {}); }
      catch (e) { log(`pane ${id}: shell prepare failed (continuing without shims)`, e); }
      // …and in one of your project dirs, the repo's agent hooks once, so that hand-run agent has them from its first session.
      this.ensureRepoEnforced(repoRoot);
    }
    const name = params.name || (isKnownAgent(agent) ? agent : path.basename(command));
    const pane = new Pane({ id, workspaceId: ws.id, name, command, args, cwd, agent, env, cols, rows, agentSessionId: opts.agentSessionId ?? null, userArgs: params.args ?? args });
    pane.graph.repoRoot = repoRoot; pane.graph.enforced = enforced; pane.worktree = opts.worktree ?? null; pane.account = opts.account ?? null;
    if (eventSocketPath) { pane.eventDriven = true; pane.eventSocketPath = eventSocketPath; }
    const budget = opts.budgetUsd !== undefined ? opts.budgetUsd : (params.budgetUsd ?? (isKnownAgent(agent) ? loadConfig().defaultBudgetUsd : 0));
    pane.budgetUsd = budget && budget > 0 ? budget : null;
    this.panes.set(id, pane); ws.paneIds.push(id); ws.activePaneId = id;
    this.wirePane(pane);
    // Indexing gate is OPT-IN (config waitIndex / KORA_WAIT_INDEX=1). By default the agent launches instantly and
    // the graph warms in the background (refreshGraphInfo → indexInBackground), with a small warm-up bar in the
    // sidebar — the terminal never waits on the graph. Only gate when the user has explicitly asked for it.
    let gate = false;
    if (isKnownAgent(agent) && repoRoot && loadConfig().waitIndex && this.graph.ingestWithProgress) {
      try { const st = await this.graph.status(cwd); pane.graph = { ...st, enforced: pane.graph.enforced || st.enforced, toolCalls: 0 }; gate = !st.indexed && !this.ingested.has(repoRoot); } catch { gate = false; }
    }
    if (gate) {
      this.ingested.add(repoRoot!);
      this.notify('pane.created', pane.info()); this.workspacesChanged();
      this.indexThenLaunch(pane, repoRoot!).catch((e) => log(`pane ${id}: index gate failed`, e));
      return pane.info();
    }
    this.launch(pane);
    this.notify('pane.created', pane.info());
    this.workspacesChanged();
    this.refreshGraphInfo(pane).catch((e) => log(`pane ${id}: graph status`, e));
    return pane.info();
  }

  private wirePane(pane: Pane) {
    pane.on('output', (d: string) => this.notify('pane.output', { paneId: pane.id, base64: Buffer.from(d, 'utf8').toString('base64') }));
    pane.on('state', (state: AgentState, blocker: string | null, previous: AgentState) => {
      log(`pane ${pane.id}: ${previous} → ${state}${blocker ? ` (${blocker})` : ''}`);
      this.notify('agent.state', { paneId: pane.id, state, blocker, previous }); this.notify('pane.updated', pane.info());
      if (state === 'blocked') this.maybeAutoAnswer(pane, blocker).catch((e) => log(`pane ${pane.id}: auto-answer failed`, e));
      // A worker that stopped on a transient API error, and one that recovered from it (server/error-stall.ts).
      if (state === 'idle' && !(pane instanceof DriverPane)) this.checkErrorStall(pane);
      else if (state === 'working' && pane.errorStall && !(pane instanceof DriverPane)) { pane.errorStall = null; this.notify('pane.updated', pane.info()); }
      if (state === 'idle' && pane.budgetOverPending) this.tellBudgetOver(pane).catch((e) => log(`pane ${pane.id}: budget notice failed`, e));
      // Orchestrator went idle with steer notes waiting → deliver them now so it re-plans (queued while it was busy).
      if (state === 'idle' && pane.role === 'orchestrator' && pane.steerQueue.length) this.flushSteers(pane).catch((e) => log(`pane ${pane.id}: steer flush failed`, e));
      // Fleet: surface a worker's state to its orchestrator's roster + event feed.
      if (pane.role === 'worker' && pane.orchestratorId) {
        this.notifyRoster(pane.orchestratorId);
        if (state === 'blocked') this.pushFleetEvent(pane.orchestratorId, { at: Date.now(), kind: 'blocked', text: `${pane.id} blocked${blocker ? `: ${blocker}` : ''}`, workerId: pane.id });
      }
    });
    pane.on('title', () => {
      this.notify('pane.updated', pane.info());
      if (!isKnownAgent(pane.declaredAgent)) { const hint = pane.titleAgentHint(); if (hint && hint !== pane.agent && pane.setDetectedAgent(hint)) this.notify('pane.updated', pane.info()); }
    });
    pane.on('exit', (code: number) => {
      log(`pane ${pane.id}: exited ${code}`);
      this.notify('pane.updated', pane.info());
      if (pane.role === 'worker' && pane.orchestratorId) { this.pushFleetEvent(pane.orchestratorId, { at: Date.now(), kind: 'worker-done', text: pane.stoppedByUser ? `${pane.id} stopped by you` : pane.retired ? `${pane.id} closed after its merge` : pane.sleeping ? `${pane.id} went to sleep` : code === 143 || code === 137 ? `${pane.id} was closed` : `${pane.id} finished (exit ${code})`, workerId: pane.id }); this.notifyRoster(pane.orchestratorId); }
      const t = setTimeout(() => { if (this.panes.has(pane.id)) this.removePane(pane.id, false); }, EXITED_PANE_GRACE_MS); t.unref();
    });
  }

  private launch(pane: Pane) {
    pane.spawn(); pane.launched = true;
    // Crash recovery: the next daemon kills this group if we die without disposing it (children.ts).
    const pid = pane.pid; this.children.add(pid, `pane ${pane.id} (${pane.agent})`); pane.once('exit', () => this.children.remove(pid));
    log(`pane ${pane.id}: spawned ${pane.command} ${pane.args.join(' ')} (agent=${pane.agent}, cwd=${pane.cwd}, pid=${pane.pid})`);
  }

  private async indexThenLaunch(pane: Pane, root: string) {
    const bar = (pct: number, w = 30) => { const n = Math.round((pct / 100) * w); return '█'.repeat(n) + '░'.repeat(w - n); };
    const fmtS = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
    pane.writeLocal(`\x1b[2J\x1b[H\x1b[1;36mkora\x1b[0m · first time in \x1b[1m${path.basename(root)}\x1b[0m — building the code graph before ${pane.agent} starts\r\n`);
    pane.writeLocal(`\x1b[2m${root}\x1b[0m\r\n\r\n`);
    let lastLine = '';
    const draw = (p: { phase: string; pct: number; files: number; filesTotal?: number; elapsedMs: number; etaMs: number }) => {
      const line = `  ${bar(p.pct)} ${String(p.pct).padStart(3)}%  ${p.filesTotal ? `${p.files}/${p.filesTotal}` : p.files} files · ${p.phase} · ${fmtS(p.elapsedMs)} elapsed${p.pct < 100 ? ` · ~${fmtS(p.etaMs)} left` : ''}`;
      if (line !== lastLine) { pane.writeLocal(`\r\x1b[2K${line}`); lastLine = line; }
      pane.graph.indexing = p.phase === 'done' ? null : { ...p };
      this.notify('pane.updated', pane.info());
    };
    const r = await this.graph.ingestWithProgress!(root, draw);
    if (!this.panes.has(pane.id)) return;
    if (r.ok) {
      pane.writeLocal(`\r\n\r\n  \x1b[32m✓ indexed\x1b[0m ${r.nodes ?? '?'} nodes · ${r.edges ?? '?'} edges in ${fmtS(r.ms)} — launching ${pane.agent}\r\n\r\n`);
      await sleep(600);
      pane.writeLocal('\x1b[2J\x1b[H');
    } else {
      // Silent-safe: a failed index degrades to a plain terminal. No error banner — just clear and launch.
      log(`pane ${pane.id}: index failed (${r.error ?? '?'}) — launching ${pane.agent} without graph`);
      pane.writeLocal('\x1b[2J\x1b[H');
    }
    pane.graph.indexing = null;
    this.launch(pane);
    this.notify('pane.updated', pane.info());
    this.refreshGraphInfo(pane).catch((e) => log(`pane ${pane.id}: graph status`, e));
  }

  private ensuredRepos = new Set<string>();
  /** Is this repo inside one of the user's project roots (default ~/Projects)? Only those get auto-setup. */
  private underTrustedRoot(root: string | null): boolean {
    if (!root) return false;
    return (loadConfig().trustedRoots || []).some((r) => r && isUnder(root, r.replace(/^~(?=$|\/)/, os.homedir())));
  }
  /**
   * Make "open a normal pane, then run claude/codex/… by hand" work: install the repo's agent hooks (the graph
   * plumbing) once, so whatever agent you launch here picks the graph up — no `ctrl+b a` required. Scoped to a
   * real project under a trusted root; never a home dir, a mount, or a repo outside your project roots.
   */
  private ensureRepoEnforced(repoRoot: string | null): void {
    if (!repoRoot || this.ensuredRepos.has(repoRoot)) return;
    if (!isSafeToAutoIndex(repoRoot) || !this.underTrustedRoot(repoRoot)) return;
    capSize(this.ensuredRepos, 1000); this.ensuredRepos.add(repoRoot);
    this.enforcer.install({ agent: 'all', cwd: repoRoot })
      .then((r) => log(`auto-setup ${repoRoot}: ${r.results.map((x) => `${x.agent}:${x.action}`).join(', ')}`))
      .catch((e) => log(`auto-setup ${repoRoot} failed`, e));
  }

  private async refreshGraphInfo(pane: Pane, cwd: string = pane.liveCwd ?? pane.cwd) {
    let st;
    try { st = await this.graph.status(cwd); } catch (e) { log(`pane ${pane.id}: graph.status failed`, e); return; }
    if (!this.panes.has(pane.id)) return;
    pane.graph = { ...st, enforced: pane.graph.enforced || st.enforced, toolCalls: pane.graph.toolCalls };
    this.notify('pane.updated', pane.info());
    const root = st.repoRoot ?? pane.graph.repoRoot;
    // Warm the graph for a real project you're working in — an agent pane anywhere safe, OR any pane (a plain
    // shell) inside one of your project roots, so a `claude`/`codex` you run by hand there has data ready. Never a
    // home dir, a mount, the fs root, or a repo outside your project roots (those stay a plain terminal).
    const wantsGraph = isKnownAgent(pane.agent) || this.underTrustedRoot(root);
    // User rule: a repo the user never indexed is NEVER indexed automatically (an agent opening there included). An
    // index built from ANOTHER copy (staleForCheckout) is a first index of THIS checkout, so it is not started here
    // either (audit 2026-10-15 #2): the status carries it and the user re-indexes.
    // Stale (HEAD moved since the index): an incremental re-index — koragraph re-extracts only the changed files —
    // once per HEAD, at most every 30 s per repo. The header reads "stale · reindexing" meanwhile.
    const last = root ? this.lastIndex.get(root) : undefined;
    const staleIndex = !!st.indexed && !!st.stale && !st.staleForCheckout && (!last || last.sha !== st.headSha) && (!last || Date.now() - last.at > 30_000);
    if (staleIndex && root && fs.existsSync(root) && process.env.KORA_AUTO_INGEST !== '0'
        && wantsGraph && isSafeToAutoIndex(root)) {
      capSize(this.ingested, 1000); capSize(this.lastIndex, 1000); this.ingested.add(root); this.lastIndex.set(root, { sha: st.headSha ?? null, at: Date.now() });
      log(`graph: stale → incremental re-index ${root} (index at ${(st.indexedSha || '').slice(0, 7)}, HEAD ${(st.headSha || '').slice(0, 7)})`);
      this.indexInBackground(pane, root).catch((e) => log(`graph: ingest ${root} failed`, e));
    } else if ((!st.indexed || st.staleForCheckout) && root && wantsGraph) {
      log(`graph: ${root} ${st.staleForCheckout ? `has an index from another copy (${st.indexedFrom})` : 'is not indexed'} — not indexing it automatically (the user starts the first index)`);
    }
  }

  // Warm the graph WITHOUT blocking or writing into the pane: the agent is already live. Progress lands only in
  // pane.graph.indexing, which the sidebar renders as a small transient repo warm-up bar that vanishes when done.
  // Degrades silently — if ingestWithProgress is unavailable or fails, the pane simply stays a plain terminal.
  private async indexInBackground(pane: Pane, root: string) {
    const draw = (p: { phase: string; pct: number; files: number; filesTotal?: number; elapsedMs: number; etaMs: number }) => {
      if (!this.panes.has(pane.id)) return;
      pane.graph.indexing = p.phase === 'done' ? null : { ...p };
      this.notify('pane.updated', pane.info());
    };
    let ok = false;
    try {
      if (this.graph.ingestWithProgress) ok = (await this.graph.ingestWithProgress(root, draw)).ok;
      else { await this.graph.ingest(root, { wait: false }); ok = true; }
    } finally {
      if (this.panes.has(pane.id)) {
        try { const st = await this.graph.status(pane.cwd); pane.graph = { ...st, enforced: pane.graph.enforced || st.enforced, toolCalls: pane.graph.toolCalls, indexing: null }; } catch { pane.graph.indexing = null; }
        this.notify('pane.updated', pane.info());
      }
    }
    // Keep it fresh from here on: koragraph's git hooks re-ingest after commit / checkout / merge / rewrite.
    if (ok) { try { const { ensureGitHooks } = require('../graph/service'); const r = ensureGitHooks(root); log(`graph: git hooks for ${root}: ${r.detail}`); } catch (e) { log(`graph: git hooks for ${root} failed`, e); } }
    // The store is written by the time the child exits: refresh NOW (every pane of this repo — a shell beside the
    // agent shows the same graph), so the pane never shows "not indexed" after its index just finished (measured: it
    // did, for the 30 s the old deferred refresh waited). A second refresh later picks up the background co-change
    // mining counts.
    for (const p of this.panes.values()) if (p.graph.repoRoot === root || p === pane) this.refreshGraphInfo(p).catch(() => {});
    const t = setTimeout(() => this.refreshGraphInfo(pane).catch(() => {}), 30_000); t.unref();
  }

  removePane(id: string, kill: boolean) {
    const p = this.panes.get(id); if (!p) return;
    if (kill && !p.exited) { p.kill('SIGTERM'); const t = setTimeout(() => { if (!p.exited) p.kill('SIGKILL'); }, 1500); t.unref(); }
    const ws = this.workspaces.get(p.workspaceId);
    if (ws) { ws.paneIds = ws.paneIds.filter((x) => x !== id); if (ws.activePaneId === id) ws.activePaneId = ws.paneIds[ws.paneIds.length - 1] ?? null; }
    this.panes.delete(id);
    this.ledger.detach(id);
    this.notify('pane.closed', { paneId: id, exitCode: p.exitCode });
    const t = setTimeout(() => p.dispose(), 2000); t.unref();
    this.workspacesChanged();
  }
  killPane(id: string, signal?: string) {
    const p = this.requirePane(id);
    // Worktrees are persistent (herdr's model): closing a pane never deletes its checkout or branch. Remove one
    // explicitly with `kora worktree remove` / ctrl+b — a clean one is reused when you open it again.
    if (p.exited || !signal || signal === 'SIGTERM' || signal === 'SIGKILL') this.removePane(id, true);
    else p.kill(signal);
  }
  focusPane(id: string) {
    const p = this.requirePane(id); const ws = this.requireWorkspace(p.workspaceId);
    ws.activePaneId = id; this.activeWorkspaceId = ws.id; this.workspacesChanged();
  }
  renamePane(id: string, name: string) { const p = this.requirePane(id); p.name = name; p.autoNamed = false; this.notify('pane.updated', p.info()); this.persist(); }
  /**
   * resume: `--resume <session>` (re-sends the whole conversation at cache-write price — the most expensive turn of the day).
   * cheap (default): a fresh session; the old transcript is distilled into ~/.kora/panes/<newId>/resume-brief.md, which the
   * SessionStart hook injects once and deletes. fresh: new session, nothing carried over.
   */
  async restartPane(id: string, mode?: RestartMode): Promise<PaneInfo> {
    const p = this.requirePane(id);
    const m: RestartMode = mode ?? loadConfig().restartMode;
    const { restoreCommand, stripResume } = require('./state');
    // the args as the user gave them (enforcer flags are re-derived by prepare()); resume flags only in resume mode
    const persisted = { id: p.id, name: p.name, command: p.command, args: stripResume(p.declaredAgent, p.userArgs), cwd: p.cwd, agent: p.declaredAgent, agentSessionId: p.agentSessionId, cols: p.cols, rows: p.rows };
    const { command, args } = m === 'resume' ? restoreCommand(persisted) : { command: p.command, args: persisted.args };
    const worktree = p.worktree; const ws = p.workspaceId; const budgetUsd = p.budgetUsd; const transcript = p.agentSessionPath;
    const name = p.autoNamed ? p.declaredAgent : p.name; // an auto-name belongs to the old session's first prompt
    // Reserve the new id now: the brief must be at the path the new pane's KORA_PANE_ID will point at.
    const newId = `p${this.nextPane++}`;
    let briefNote = '';
    if (m === 'cheap' && p.declaredAgent === 'claude') {
      try { const r = writeResumeBrief(newId, transcript); briefNote = r ? ` · brief ${r.tokens} tok → ${r.path}` : ' · no transcript to distil (fresh)'; }
      catch (e: any) { briefNote = ` · brief failed: ${e?.message || e}`; }
    }
    log(`pane ${id}: restart mode=${m} → ${newId}${briefNote}`);
    this.removePane(id, true);
    await sleep(300);
    return this.spawnPane({ command, args, cwd: p.cwd, agent: p.declaredAgent, name, workspaceId: ws, cols: p.cols, rows: p.rows }, { id: newId, agentSessionId: m === 'resume' ? p.agentSessionId : null, worktree, budgetUsd });
  }

  // ---------- runtime intelligence: compaction, budgets, auto-name, auto-answer, zero-setup ----------
  /** Send `/compact` with keep-instructions to an idle Claude pane. The single biggest per-turn saver once context is large. */
  async compactPane(paneId: string, auto = false): Promise<{ ok: boolean; sent: boolean; reason?: string }> {
    const p = this.requirePane(paneId);
    if (!adapterFor(p.agent).canCompact) return { ok: false, sent: false, reason: `compaction is a Claude Code command (pane runs ${p.agent})` };
    if (p.exited || !p.launched) return { ok: false, sent: false, reason: 'pane is not running' };
    if (p.state !== 'idle') return { ok: false, sent: false, reason: `pane is ${p.state}${p.blocker ? ` (${p.blocker})` : ''} — compact when idle` };
    const contextBefore = p.ledger?.lastContext ?? 0;
    // Through the pane's prompt lock: /compact and a budget notice fired from the same ledger update once typed
    // over each other into one garbled line.
    const typed = p.promptLock.then(async () => {
      if (p.exited) return false;
      const t0 = Date.now(); while (Date.now() - p.lastOutputAt < 500 && Date.now() - t0 < 3000) await sleep(100);
      p.write('/compact keep every file:line citation, every decision and the current task; drop tool output');
      await sleep(80); p.write('\r');
      return true;
    });
    p.promptLock = typed.catch(() => undefined);
    if (!(await typed)) return { ok: false, sent: false, reason: 'pane exited' };
    p.lastCompactAt = Date.now();
    const t1 = Date.now(); while (p.state === 'idle' && !p.exited && Date.now() - t1 < 5000) await sleep(100);
    const left = p.state !== 'idle';
    log(`pane ${p.id}: /compact sent (${auto ? 'auto' : 'manual'}, context ${contextBefore}) — ${left ? 'agent left idle' : 'no state change within 5s'}`);
    this.notify('pane.compacted', { paneId: p.id, auto, contextBefore });
    this.notify('pane.updated', p.info());
    return { ok: true, sent: true, reason: left ? undefined : 'sent, but the pane did not leave idle within 5s' };
  }
  private onLedger(p: Pane, s: LedgerSummary) {
    const cfg = loadConfig();
    // auto-name: the first prompt is the pane's natural name
    if (s.firstPrompt && (p.name === p.agent || p.name === p.declaredAgent) && !p.autoNamed) {
      const name = autoName(s.firstPrompt);
      if (name) { p.name = name; p.autoNamed = true; log(`pane ${p.id}: named "${name}"`); this.persist(); }
    }
    // budget
    if (p.budgetUsd && p.budgetUsd > 0) {
      const prev = p.budgetState;
      const next: Pane['budgetState'] = s.costUsd >= p.budgetUsd ? 'over' : s.costUsd >= 0.8 * p.budgetUsd ? 'warn' : 'ok';
      if (next !== prev) {
        p.budgetState = next;
        if (next === 'warn' && !p.budgetWarned) { p.budgetWarned = true; log(`pane ${p.id}: budget warn ${s.costUsd.toFixed(2)}/${p.budgetUsd.toFixed(2)}`); this.notify('pane.budget', { paneId: p.id, state: 'warn', costUsd: s.costUsd, budgetUsd: p.budgetUsd }); }
        if (next === 'over' && !p.budgetOverSent) {
          this.notify('pane.budget', { paneId: p.id, state: 'over', costUsd: s.costUsd, budgetUsd: p.budgetUsd });
          p.budgetOverPending = true;
          if (p.state === 'idle') this.tellBudgetOver(p).catch((e) => log(`pane ${p.id}: budget notice failed`, e));
          else log(`pane ${p.id}: budget over (${s.costUsd.toFixed(2)}/${p.budgetUsd.toFixed(2)}); telling the agent when it is idle`);
        }
      }
    }
    // auto-compact
    const ac = cfg.autoCompact;
    if (ac.enabled && adapterFor(p.agent).canCompact && !p.exited && s.lastContext > ac.contextTokens && (!ac.onlyWhenIdle || p.state === 'idle')
        && (!p.lastCompactAt || Date.now() - p.lastCompactAt > AUTO_COMPACT_MIN_GAP_MS)) {
      p.lastCompactAt = Date.now(); // claim the slot before the async send so a burst of ledger updates sends once
      log(`pane ${p.id}: auto-compact (context ${s.lastContext} > ${ac.contextTokens})`);
      this.compactPane(p.id, true).then((r) => { if (!r.sent) log(`pane ${p.id}: auto-compact not sent: ${r.reason}`); }).catch((e) => log(`pane ${p.id}: auto-compact failed`, e));
    }
  }
  /** The agent is told, never killed. Typed once, only when idle. */
  private async tellBudgetOver(p: Pane) {
    if (p.budgetOverSent || !p.budgetUsd || p.exited) return;
    p.budgetOverSent = true; p.budgetOverPending = false;
    const spent = p.ledger?.costUsd ?? 0;
    const text = `kora: this task's budget of $${p.budgetUsd.toFixed(2)} is spent ($${spent.toFixed(2)}). Finish with a 3-line summary and stop.`;
    log(`pane ${p.id}: budget over — telling the agent`);
    await this.prompt(p.id, text, true, true, 30_000).catch((e) => { log(`pane ${p.id}: budget message not delivered: ${e?.message || e}`); });
  }
  private async maybeAutoAnswer(p: Pane, blocker: string | null) {
    if (p.exited) return;
    const cfg = loadConfig();
    // allowlist worker-permission: a worker also gets its in-worktree FILE EDITS auto-accepted (never commands).
    const allowEdits = p.role === 'worker' && cfg.workerPermission === 'allowlist';
    if (!allowEdits && !cfg.autoAnswer.trustFolder && !cfg.autoAnswer.mcpFound && !cfg.autoAnswer.readOutsideWorktree) return;
    // one attempt per blocker: if the same dialog is still up after we answered, a human decides
    if (p.lastAutoAnswer && p.lastAutoAnswer.blocker === blocker && Date.now() - p.lastAutoAnswer.at < 60_000) return;
    await sleep(250); // let the dialog finish painting
    if (p.state !== 'blocked') return;
    // Agent-agnostic: each adapter knows its own dialogs (claude delegates to planAutoAnswer; codex has its own; others none).
    const plan = adapterFor(p.agent).autoAnswer({ screen: p.read('detection'), cwd: p.cwd, mainRoot: p.worktree?.mainRoot ?? null, ...(require('../trust/gate') as typeof import('../trust/gate')).autoAnswerScope(cfg, p.cwd), allowEdits }); // trust/store.ts: only a user-trusted folder gets its trust / MCP dialog answered
    if (!plan) return;
    p.lastAutoAnswer = { blocker, at: Date.now() };
    log(`pane ${p.id}: auto-answer ${plan.kind}: ${plan.detail} (${plan.keys.length} keys)`);
    this.notify('pane.autoAnswered', { paneId: p.id, kind: plan.kind as Notifications['pane.autoAnswered']['kind'], detail: plan.detail });
    for (const k of plan.keys) { if (p.exited) return; p.write(k); await sleep(AUTO_ANSWER_KEY_GAP_MS); }
    await sleep(3000);
    if (!p.exited && p.state === 'blocked' && p.blocker === blocker) log(`pane ${p.id}: auto-answer ${plan.kind} did not clear the dialog; leaving it to a human`);
  }
  private setupDone = new Set<string>();
  /** Zero-setup: first agent in a repo with nothing installed → install every adapter + shims silently, once per repo. */
  async ensureSetup(cwd: string): Promise<string | null> {
    let root: string | null = null; try { root = this.graph.repoRoot(cwd); } catch { /* not a repo */ }
    if (!root) return null;
    if (process.env.KORA_AUTO_SETUP === '0') { log(`setup: ${root}: skipped (KORA_AUTO_SETUP=0)`); return null; }
    if (this.setupDone.has(root)) return null;
    // Folder trust (trust/gate.ts): nothing is written into a folder the user has not trusted. A worker there gets the
    // rulebook as a system prompt from its adapter's prepare (readOnly), like the chat lane (pl5 S2-1).
    if (!(require('../trust/gate') as typeof import('../trust/gate')).isFolderTrusted(root)) { log(`setup: ${root}: skipped (untrusted folder)`); return null; }
    capSize(this.setupDone, 1000); this.setupDone.add(root);
    try {
      const st = await this.enforcer.status({ agent: 'all', cwd: root });
      // "managed" must mean THIS repo's files. The shim rows (~/.kora/shims, per machine) are managed on every
      // machine that ever ran kora — counting them made this a no-op for every repo (measured: a hand-run
      // claude in a fresh repo got no hooks and no rulebook).
      // …and only files INSIDE this repo count (the per-machine ~/.codex/config.toml MCP entry reported "managed"
      // for every repo on the machine — the same mistake one level up).
      const inRepo = (f: string) => { try { return fs.realpathSync(f).startsWith(fs.realpathSync(root!) + path.sep); } catch { return f.startsWith(root! + path.sep); } };
      if (st.results.some((r) => r.action === 'managed' && r.agent !== 'shims' && r.file && inRepo(r.file))) return null;
      const r = await this.enforcer.install({ agent: 'all', cwd: root });
      const done = r.results.filter((x) => x.action === 'installed' || x.action === 'refreshed');
      const agents = [...new Set(done.map((x) => x.agent).filter((a) => a !== 'shims' && a !== 'agentsmd'))];
      const text = `kora: set up ${agents.length ? agents.join(' + ') + ' hooks + rulebook' : 'enforcement'} for ${path.basename(root)}`;
      log(`setup: ${root}: ${done.map((x) => `${x.agent}:${x.action}`).join(', ') || 'nothing to do'}`);
      if (done.length) { this.notify('pane.notice', { paneId: null, text }); return text; }
    } catch (e) { log(`setup: ${root} failed`, e); }
    return null;
  }

  // ---------- worktrees ----------
  worktreeList(cwd?: string) {
    const wt = require('./worktree');
    const roots = new Set<string>();
    if (cwd) { const r = wt.mainRoot(resolveCwd(cwd)); if (r) roots.add(r); }
    for (const p of this.panes.values()) { if (p.worktree) roots.add(p.worktree.mainRoot); else { const r = wt.mainRoot(p.cwd); if (r) roots.add(r); } }
    const out: any[] = [];
    for (const root of roots) for (const w of wt.listWorktrees(root)) {
      const pane = [...this.panes.values()].find((p) => p.worktree?.path === w.path);
      const st = wt.worktreeStatus(w.path);
      out.push({ ...w, paneId: pane?.id ?? null, dirty: st.dirty, ahead: st.ahead });
    }
    return { worktrees: out };
  }
  private worktreePath(params: { paneId?: string; path?: string }): string {
    if (params.path) return path.resolve(params.path);
    // A swarm task that finished before a daemon restart has no pane any more, but its worktree is still there (D18).
    if (params.paneId && !this.panes.has(params.paneId)) { const w = this.swarm?.finishedWorktree(params.paneId); if (w) return w.path; }
    const p = this.requirePane(params.paneId || ''); if (!p.worktree) throw new Error(`pane ${p.id} has no worktree`);
    return p.worktree.path;
  }
  /** Merge runs in a child: git merge + status + commit are synchronous and blocked the event loop 5–9 s under load. */
  async worktreeMerge(params: Methods['worktree.merge']['params']) {
    const wt = require('./worktree') as typeof import('./worktree');
    // Which checkout the merge lands in, read BEFORE the merge: it runs for seconds in a child (tens under load), and a
    // finished worker's pane can be reaped meanwhile -- the index catch-up below was then skipped (amber "Out of date").
    const mergedRoot = (params.paneId ? this.panes.get(params.paneId)?.worktree?.mainRoot ?? this.swarm?.finishedWorktree(params.paneId)?.mainRoot : undefined) ?? null;
    const r = await wt.worktreeInChild<ReturnType<typeof wt.mergeWorktree>>('mergeWorktree', [this.worktreePath(params), { into: params.into, commitFirst: params.commitFirst }]);
    this.refreshWorktreeStatus();
    // A merged swarm worker's job is over: close its OpenCode (an idle one holds ~800 MB; swarm QA 2026-10-02 found
    // every merged worker of the day still running). The pane stays listed as exited and the worktree/branch are
    // kept; `retired` tells the fleet this exit is not "the worker exited".
    const pane = params.paneId ? this.panes.get(params.paneId) : undefined;
    if (r.ok && pane) pane.branchMerged = true;
    const freshenRoot = pane?.worktree?.mainRoot ?? mergedRoot;
    if (r.ok && freshenRoot) this.ensureChatGraphFresh(freshenRoot, { headMoved: true });
    // Gated on the CONFIRMED phase (its report is in), never the raw screen state: an OpenCode that still drew a busy
    // footer read "working" and kept its ~800 MB after the merge (flaky in swarm-spawn.test, night 2026-10-04).
    if (r.ok && pane && !pane.exited && pane.swarm?.phase === 'done') {
      pane.retired = true;
      log(`swarm: ${pane.id} merged \u2014 closing its worker`);
      try { pane.kill('SIGTERM'); } catch { /* already gone */ }
    }
    return r;
  }
  worktreeRemove(params: Methods['worktree.remove']['params']) {
    const wt = require('./worktree'); const dir = this.worktreePath(params);
    const pane = [...this.panes.values()].find((p) => p.worktree?.path === dir);
    if (pane && !pane.exited && !params.force) return { ok: false, message: `pane ${pane.id} is still running in ${dir}; kill it first or pass force` };
    if (pane) this.removePane(pane.id, true);
    return wt.removeWorktree(dir, { force: params.force, deleteBranch: params.deleteBranch });
  }
  /** Orphan sweep (see worktree.ts sweepWorktrees): everything under $KORA_HOME/worktrees that no live pane owns. */
  async worktreeSweep(params: { dryRun?: boolean; repos?: string[]; minAgeMs?: number } = {}) {
    const wt = require('./worktree') as typeof import('./worktree');
    const live = [...this.panes.values()].filter((p) => p.worktree && !p.exited).map((p) => p.worktree!.path);
    // Leftover agent branches live in the repos agents worked in: every pane's checkout plus what the caller knows.
    const repos = new Set<string>(params.repos ?? []);
    for (const p of this.panes.values()) repos.add(p.worktree?.mainRoot ?? p.cwd);
    const r = await wt.sweepWorktreesInChild({ live, dryRun: params.dryRun, repos, ...(params.minAgeMs ? { minAgeMs: params.minAgeMs } : {}) });
    log(`worktree sweep${params.dryRun ? ' (dry run)' : ''}: ${r.scanned} scanned, ${r.removed.length} removed (${(r.reclaimedBytes / 1048576).toFixed(1)} MB), ${r.orphans.length} orphan(s) kept, ${r.parked.length} parked (main checkout gone), ${r.busy.length} busy, ${r.branchesDeleted.length} merged branch(es) deleted, ${r.branchesKept.length} unmerged branch(es) kept, ${r.errors.length} error(s)`);
    return r;
  }
  /**
   * The lead (or the human) merged a worker's branch with plain git instead of kora_merge, e.g. after kora_merge
   * aborted on a conflict. The status poll saw its commits land; record it as merged so the Workers panel stops
   * saying "NOT merged", and close a finished swarm worker exactly as kora_merge would (an idle one holds ~800 MB).
   */
  private noteMergedByHand(pane: Pane) {
    pane.branchMerged = true;
    log(`worktree: ${pane.id}'s branch ${pane.worktree?.branch ?? ''} landed in the main checkout outside kora_merge`);
    if (pane.orchestratorId) this.pushFleetEvent(pane.orchestratorId, { at: Date.now(), kind: 'merged', text: `${pane.id}: merged \u2014 its branch landed in the main checkout (merged by hand)`, workerId: pane.id });
    if (!pane.exited && pane.swarm?.phase === 'done') {
      pane.retired = true;
      log(`swarm: ${pane.id} merged \u2014 closing its worker`);
      try { pane.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
  private worktreeStatusBusy = false;
  refreshWorktreeStatus() {
    if (this.worktreeStatusBusy) return; // a slow git must not pile up polls
    const wt = require('./worktree');
    const panes = [...this.panes.values()].filter((p) => p.worktree && !p.exited);
    if (!panes.length) return;
    this.worktreeStatusBusy = true;
    (async () => {
      for (const p of panes) {
        if (!p.worktree || !this.panes.has(p.id)) continue;
        try {
          const st = await wt.worktreeStatusAsync(p.worktree.path);
          if (p.worktree && (st.dirty !== p.worktree.dirty || st.ahead !== p.worktree.ahead)) {
            const landed = landedOutsideMerge(p, st);
            p.worktree = { ...p.worktree, dirty: st.dirty, ahead: st.ahead }; this.notify('pane.updated', p.info());
            if (landed) this.noteMergedByHand(p);
          }
        } catch { /* gone */ }
      }
    })().finally(() => { this.worktreeStatusBusy = false; });
  }

  /**
   * What a worker SAID, from its transcript — not its screen. A coding-agent TUI owns the alternate
   * screen, so everything it printed before the current viewport is gone from the pane's buffer: the
   * report an orchestrator actually wants is exactly the part `read('scrollback')` can never return.
   * The transcript keeps it. Needs the pane's agent session (reportAgentSession); empty before the
   * agent has announced one.
   */
  report(paneId: string, turns = 1): string {
    const p = this.requirePane(paneId);
    if (p instanceof DriverPane) return p.report(); // its feed's last answer (the engine's own, never a scraped screen)
    // A swarm worker's answer is its report file ($KORA_REPORT), not a transcript (opencode keeps none kora reads).
    if (p.swarm?.reportPath) {
      try {
        const st = fs.lstatSync(p.swarm.reportPath); // a symlinked report is not a report (SwarmService.reportStat)
        if (st.isFile() && st.size > 0) {
          const cap = 256 * 1024;
          const fd = fs.openSync(p.swarm.reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { const buf = Buffer.alloc(Math.min(cap, st.size)); const n = fs.readSync(fd, buf, 0, buf.length, 0); const text = buf.subarray(0, n).toString('utf8'); if (st.size <= cap) return text; return text + '\n…truncated'; } finally { fs.closeSync(fd); }
        }
      } catch { /* not written yet: fall back to the transcript */ }
    }
    const file = this.transcriptFor(p);
    if (!file) return '';
    return assistantTurns(file, Math.max(1, turns)).map((t) => t.text).join('\n\n---\n\n');
  }

  /**
   * The pane's agent transcript. The SessionStart hook's report is the normal source; without it (the hook's socket
   * call timed out behind a slow graph brief, a restored pane with only a session id, a named-account worker whose
   * transcript lives under its CLAUDE_CONFIG_DIR) kora_read said "no transcript yet" for live Claude workers. Fall back
   * to the session id under every config dir, then to the one fresh, unclaimed transcript in the pane's project folder.
   */
  transcriptFor(p: Pane): string | null {
    if (p.agentSessionPath) return p.agentSessionPath;
    const home = os.homedir();
    const configDir = p.envVar('CLAUDE_CONFIG_DIR');
    const configDirs = configDir ? [configDir] : [];
    if (p.agentSessionId) {
      const f = findTranscript(p.agentSessionId, home, configDirs);
      if (f) { p.agentSessionPath = f; return f; }
    }
    if (p.agent !== 'claude' && p.declaredAgent !== 'claude') return null;
    const claimed = new Set<string>();
    for (const o of this.panes.values()) if (o !== p && o.agentSessionPath) claimed.add(o.agentSessionPath);
    // Not cached: a guess is re-made each time, so the hook's real report (or a /clear's new file) always wins.
    return guessClaudeTranscript({ cwds: [p.cwd, p.liveCwd, p.worktree?.path], home, configDirs, since: p.createdAt, claimed });
  }

  /**
   * A worker went idle: did its agent stop on a transient API/network error ("API Error: The response stopped
   * arriving")? Then it looks idle with nothing to report. Flag it `error-stalled` (PaneInfo.errorStall) and send
   * "continue" — once per stall, ERROR_STALL_MAX_RETRIES per worker. Runs synchronously inside the 'state' event,
   * before any waiter's listener, so a kora_wait never resolves on the stalled idle while a retry is on its way.
   */
  private checkErrorStall(p: Pane): void {
    if (p.role !== 'worker' || p.swarm || p.exited || p.retired || p.stoppedByUser) return;
    let detected: string | null = null;
    try { detected = detectErrorStall(p.read('screen', 'text'), errorStallFromTranscript(this.transcriptFor(p))); } catch (e) { log(`pane ${p.id}: error-stall check failed`, e); }
    const { stall, retry } = nextErrorStall(p.errorStall ?? null, p.errorRetries, detected, Date.now());
    if (!stall && !p.errorStall) return;
    p.errorStall = stall;
    if (!stall) { this.notify('pane.updated', p.info()); return; }
    if (retry) p.errorRetries = stall.retries;
    log(`pane ${p.id}: error-stalled ("${stall.line}")${retry ? ` — sending "continue" (${stall.retries})` : ' — retry cap reached, leaving it to the lead'}`);
    this.notify('pane.updated', p.info());
    if (p.orchestratorId) { this.pushFleetEvent(p.orchestratorId, { at: Date.now(), kind: 'blocked', text: `${p.id} error-stalled: ${stall.line}${retry ? ' (auto-continue)' : ''}`, workerId: p.id }); this.notifyRoster(p.orchestratorId); }
    if (!retry) return;
    const release = () => {
      // The "continue" did not get the agent working (it is still idle): drop `retrying` so waiters see error-stalled.
      if (p.errorStall?.retrying && p.state !== 'working') { p.errorStall = { ...p.errorStall, retrying: false }; this.notify('pane.updated', p.info()); p.emit('recheck'); }
    };
    this.prompt(p.id, ERROR_STALL_CONTINUE, true, true, 30_000, 'kora')
      .catch((e) => log(`pane ${p.id}: auto-continue not delivered: ${e?.message || e}`))
      .finally(() => { const t = setTimeout(release, 8000); t.unref?.(); });
  }

  /** A hook inside the pane reported the agent's own turn state (working / idle). Authoritative for turns; see tracker. */
  reportState(id: string, state: 'working' | 'idle') {
    const p = this.panes.get(id); if (!p) return;
    p.hint(state);
  }
  reportAgentSession(id: string, agent: AgentId, sessionId: string, transcriptPath?: string) {
    // A chat thread's session (prepared with KORA_PANE_ID=chat:<thread>) has no pane; its SessionStart hook still
    // reports here. Logged, not ledgered: the chat lane keeps its own per-turn accounting, and a per-second re-parse
    // of a long chat transcript would sit on the event loop the UI websocket shares.
    if (id.startsWith('chat:') && !this.panes.has(id)) {
      log(`chat ${id.slice(5)}: SessionStart hook reported ${agent || 'agent'} session ${sessionId}${transcriptPath ? ` (${transcriptPath})` : ''}`);
      return;
    }
    const p = this.requirePane(id);
    // 2026-10-15 audit #6: the path is the agent's word, and the ledger opens and parses it. Only an agent's own transcript
    // folder counts; anything else is dropped and transcriptFor() finds the file by the session id instead.
    const ok = transcriptPath ? agentTranscriptPath(transcriptPath, p.envVar('CLAUDE_CONFIG_DIR')) : null;
    if (transcriptPath && !ok) log(`pane ${id}: ignored reported transcript ${transcriptPath} (not a regular file in an agent's own transcript folder)`);
    p.agentSessionId = sessionId; p.agentSessionPath = ok;
    if (ok) this.ledger.attach(id, ok);
    if (agent && agent !== p.agent && isKnownAgent(agent)) p.setDetectedAgent(agent);
    this.notify('pane.updated', p.info()); this.persist();
  }
  reportGraphUse(id: string | null, tool: string, ms = 0, channel: GraphChannel = 'cli') {
    const p = id ? this.panes.get(id) : null;
    if (p) {
      p.graph.toolCalls++;
      p.graph.toolCallsByChannel = { ...(p.graph.toolCallsByChannel || {}), [channel]: ((p.graph.toolCallsByChannel || {})[channel] || 0) + 1 };
      this.notify('pane.updated', p.info());
    }
    this.notify('graph.used', { paneId: p?.id ?? null, tool, ms, channel });
  }

  // ---------- agents ----------
  /** Live known-agent panes running directly in a repo's MAIN checkout (not a worktree). auto mode keeps this ≤ 1. */
  private agentsInMain(mainRoot: string, exclude?: string): number {
    const wt = require('./worktree'); let n = 0;
    for (const p of this.panes.values()) {
      if (p.exited || p.id === exclude || !isKnownAgent(p.agent) || p.worktree) continue;
      try { const r = wt.mainRoot(p.cwd); if (r && fs.realpathSync(r) === fs.realpathSync(mainRoot)) n++; } catch { /* skip */ }
    }
    return n;
  }
  // Swarm additions (SwarmService is the caller): params.command = an absolute binary overriding agentCommand(agent);
  // params.env = merged into the pane env; params.reuseWorktree = spawn IN this existing worktree (a failover keeps its
  // predecessor's checkout; a swarm spawn pre-creates its own so the report path is known before launch) — no new
  // worktree, no main-checkout redirect; params.skipWorkerPermission = add no skipPermissionArgs (the swarm path owns
  // the worker's permission argv — otherwise `--auto` lands twice and ignores the thread's posture).
  async agentSpawn(params: Methods['agent.spawn']['params']): Promise<PaneInfo> {
    // A plain OpenCode worker: the resolved binary + a live free model, or a clear 'not installed' error BEFORE any
    // worktree or pane exists (a bare `opencode` off PATH exited 1 at once). No-op when `command` is given (swarm).
    if (params.agent === 'opencode' && !params.command) params = await (require('./opencode-worker') as typeof import('./opencode-worker')).prepareOpencodeSpawn(params, require('./opencode-worker').defaultOpencodeSpawnDeps(this));
    // Koragent the same way: the installed binary ($KORAGENT_BIN, then $KORAGENT_HOME|~/.koragent/bin/koragent, then
    // PATH, as the swarm backend resolves it), or a clear error before any pane exists. A bare `koragent` off PATH
    // exited 1 with an empty screen (Koragent E2E D20).
    // Koragent is Kora Pro: the free edition refuses the agent before any worktree or pane exists.
    if (params.agent === 'koragent' && !(require('../edition') as typeof import('../edition')).isProEdition()) throw new Error((require('../edition') as typeof import('../edition')).proOnlyMessage('Koragent'));
    if (params.agent === 'koragent' && !params.command) params = { ...params, command: (require('./koragent-backend') as typeof import('./koragent-backend')).requireKoragentBinary() };
    if (params.reuseWorktree) return this.agentSpawnIn(params, params.reuseWorktree);
    let cwd0 = resolveCwd(params.cwd ?? this.activeWorkspace()?.cwd);
    // Spawned from inside ANOTHER agent's worktree (a split beside an agent pane inherits its live cwd)? A second
    // agent must not share that checkout — two agents editing one worktree is exactly what worktrees prevent — so
    // resolve back to the main checkout, keeping the relative sub-directory, and branch a fresh worktree from there.
    try {
      const wt = require('./worktree');
      // only Kora's own agent worktrees: a user's linked checkout (kora-dev beside kora) is where they work, and workers branch from it
      if (wt.isAgentWorktree(cwd0)) {
        const top = require('../graph/embedded').gitTopLevel(cwd0); const main = wt.mainRoot(cwd0);
        if (top && main && main !== top) { const rel = path.relative(fs.realpathSync(top), fs.realpathSync(cwd0)); const back = rel && !rel.startsWith('..') ? path.join(main, rel) : main; if (fs.existsSync(back)) { log(`agent ${params.agent}: cwd ${cwd0} is a worktree — spawning from ${back}`); cwd0 = back; } }
      }
    } catch { /* keep cwd0 */ }
    // Phase timings: a spawn that stalls the daemon (several seconds of blocked event loop drop every websocket)
    // must name its slow step in the log — see the desktop daemon's "event loop blocked" line.
    const t0 = Date.now(); const phase = (name: string) => { const ms = Date.now() - t0; if (ms > 1500) log(`agent ${params.agent}: spawn phase "${name}" took ${ms}ms so far`); };
    // A worker (or any agent about to get its own worktree) needs disk: refuse up front on a nearly full volume rather
    // than fail half-way through a checkout. A plain agent in the main checkout needs nothing new.
    // A assistant-lane worker writes into its project's scratch folder, not a checkout: a small floor, not the checkout one.
    if (params.orchestratorId) {
      if ((require('../blobs/home') as typeof import('../blobs/home')).isBlobsCwd(cwd0)) assertDiskRoom(`a ${params.agent} worker`, cwd0, 256 * 1024 ** 2);
      else assertDiskRoom(`a ${params.agent} worker`, require('./worktree').worktreesDir());
    }
    await this.ensureSetup(cwd0); phase('ensureSetup');
    let cwd = cwd0; let worktree: PaneInfo['worktree'] = null;
    const wt = require('./worktree');
    const mainRoot0 = (() => { try { return wt.mainRoot(cwd0); } catch { return null; } })();
    const canWorktree = !!mainRoot0 && wt.hasCommits(mainRoot0) && !wt.isAgentWorktree(cwd0);
    // Decide: main checkout, or an isolated worktree. Explicit params.worktree wins (the TUI menu / --worktree /
    // --no-worktree). Otherwise config.worktrees: never = always main; always = always a worktree; auto (default) =
    // main until a SECOND agent would land in the same checkout, then isolate so they don't collide.
    const mode = loadConfig().worktrees;
    let wantWorktree: boolean;
    if (params.worktree !== undefined) wantWorktree = params.worktree;
    else if (!canWorktree || mode === 'never') wantWorktree = false;
    else if (mode === 'always') wantWorktree = true;
    // A fleet worker (spawned by a lead) always isolates: its lead is working in this checkout even when that lead is
    // the desktop chat (not a pane, so agentsInMain never counted it) - the first worker used to edit the user's
    // checkout directly and the lead had to commit it by hand (swarm QA 2026-10-02).
    else if (params.orchestratorId) wantWorktree = true;
    else wantWorktree = mainRoot0 ? this.agentsInMain(mainRoot0) >= 1 : false; // auto: isolate only on contention
    if (wantWorktree && canWorktree) {
      assertDiskRoom(`a worktree for ${params.agent}`, wt.worktreesDir());
      try {
        // In a child: `git worktree add` + its checkout is synchronous and took seconds on a large repo under load.
        const w: import('./worktree').WorktreeInfo = await (wt as typeof import('./worktree')).worktreeInChild('createWorktree', [cwd0, params.agent]);
        wt.primeWorktreeFacts(w.path, w.mainRoot);
        const rel = path.relative(fs.realpathSync(w.mainRoot), fs.realpathSync(cwd0));
        cwd = rel && !rel.startsWith('..') ? path.join(w.path, rel) : w.path;
        worktree = { path: w.path, branch: w.branch, mainRoot: w.mainRoot };
        phase('createWorktree');
        log(`agent ${params.agent}: worktree ${w.path} on ${w.branch}${mode === 'auto' ? ' (another agent is in the main checkout)' : ''}`);
        this.notify('pane.notice', { paneId: null, text: `${params.agent} works in its own worktree (${w.branch.replace(/^kora\//, '')})${mode === 'auto' ? ' — another agent is already in your checkout' : ', branched from HEAD'}. ctrl+b m merges it back.` });
      } catch (e: any) { log(`agent ${params.agent}: no worktree (${e?.message || e}); using the shared checkout`); }
    } else if (isKnownAgent(params.agent) && mainRoot0 && !worktree) {
      this.notify('pane.notice', { paneId: null, text: `${params.agent} runs in your checkout (${path.basename(mainRoot0)}) — it sees your uncommitted changes.` });
    }
    // workerPermission='auto': a worker launches with its agent's skip-permissions flag so it never parks on an
    // approval prompt (max automation). 'escalate'/'allowlist' leave prompts on — handled live by maybeAutoAnswer.
    const info = await this.launchWorker(params, cwd, worktree);
    phase('spawnPane');
    return info;
  }

  /** agent.spawn with `reuseWorktree`: the pane runs in that existing checkout (cwd kept when it is inside it). */
  private async agentSpawnIn(params: Methods['agent.spawn']['params'], reuse: { path: string; branch: string; mainRoot: string }): Promise<PaneInfo> {
    if (!fs.existsSync(reuse.path)) throw new Error(`worktree ${reuse.path} no longer exists`);
    const want = params.cwd ? resolveCwd(params.cwd) : reuse.path;
    const inside = (() => { try { const r = path.relative(fs.realpathSync(reuse.path), fs.realpathSync(want)); return !r.startsWith('..') && !path.isAbsolute(r); } catch { return false; } })();
    log(`agent ${params.agent}: reusing worktree ${reuse.path} on ${reuse.branch}`);
    return this.launchWorker(params, inside ? want : reuse.path, { path: reuse.path, branch: reuse.branch, mainRoot: reuse.mainRoot });
  }

  /** The shared tail of agentSpawn: permission argv, spawnPane, worker role, the initial prompt. */
  private driverHost: WorkerDriverHost | null = null;
  /** The daemon's chat engines (SessionManager): a lead's worker on one of them is a GUI worker box (DriverPane). */
  setDriverHost(host: WorkerDriverHost | null): void { this.driverHost = host; }
  /** A GUI worker's feed (snapshot) — null for a terminal-only pane. */
  workerFeed(paneId: string): WorkerFeedItem[] | null {
    const p = this.panes.get(paneId);
    if (p instanceof DriverPane) return p.feed.snapshot();
    const f = (p as { feed?: { snapshot(): WorkerFeedItem[] } } | undefined)?.feed;
    return f ? f.snapshot() : null;
  }
  /** Steps a swarm worker's OpenCode plugin reported (`pane.feed`): the pane becomes a GUI box from its first step. */
  pushPluginFeed(paneId: string, raw: unknown[]): void {
    this.pushWorkerFeed(paneId, raw.slice(-60).map(pluginFeedItem).filter((i): i is WorkerFeedItem => !!i));
  }
  /** Feed items for a PTY worker (swarm OpenCode plugin, Koragent's event stream). */
  pushWorkerFeed(paneId: string, items: WorkerFeedItem[]): void {
    const p = this.panes.get(paneId);
    if (!p || p instanceof DriverPane || !items.length) return;
    const fresh = !p.feed;
    const feed = p.ensureFeed();
    if (fresh) {
      p.on('feed', (item: WorkerFeedItem) => this.notify('pane.feed', { paneId, item }));
      if (p.initialTask) feed.user(p.initialTask, 'leader', p.createdAt);
    }
    for (const item of items) {
      // A tool's end keeps what its start said (Koragent's tool.end carries no name or subject).
      const cur = item.kind === 'tool' ? feed.get(item.id) : undefined;
      feed.upsert(cur?.kind === 'tool' && item.kind === 'tool' ? { ...item, at: cur.at, tool: item.tool === 'Tool' ? cur.tool : item.tool, title: item.title || cur.title } : item);
    }
    if (fresh) this.notify('pane.updated', p.info());
  }
  /** The human answered a GUI worker's approval card. */
  async respondWorkerApproval(paneId: string, requestId: string, decision: 'accept' | 'acceptForSession' | 'decline'): Promise<void> {
    const p = this.requirePane(paneId);
    if (!(p instanceof DriverPane)) throw new Error(`pane ${paneId} has no approval to answer`);
    await p.respondApproval(requestId, decision);
  }

  /**
   * A lead's worker on a chat engine (docs/fleet/WORKER-BOXES.md): no PTY, the engine's own events drive state, the
   * feed is the box. Same pane id space, worktree, role and roster as a CLI worker, so kora_wait / kora_read / merge
   * work unchanged. Not restored after a daemon restart (its record is the thread; the lead re-spawns if needed).
   */
  private launchDriverWorker(params: Methods['agent.spawn']['params'], cwd: string, worktree: PaneInfo['worktree'], host: WorkerDriverHost): PaneInfo {
    const ws = this.workspaceFor(params.workspaceId, cwd);
    const id = `p${this.nextPane++}`;
    const name = params.name || params.agent;
    const args = params.args ?? [];
    const { model, effort } = modelFromArgs(args);
    const pane = new DriverPane({ id, workspaceId: ws.id, name, command: '', args: [], cwd, agent: params.agent, env: {}, cols: 120, rows: 40, host, model, effort, runtimeMode: runtimeModeFromArgs(args, loadConfig().workerPermission === 'auto' && !params.skipWorkerPermission) });
    pane.worktree = worktree; pane.account = params.account ?? null;
    pane.role = 'worker'; pane.orchestratorId = params.orchestratorId ?? null;
    this.panes.set(id, pane); ws.paneIds.push(id); ws.activePaneId = id;
    this.wirePane(pane);
    pane.on('feed', (item: WorkerFeedItem) => this.notify('pane.feed', { paneId: id, item }));
    pane.on('meta', () => this.notify('pane.updated', pane.info()));
    pane.spawn();
    log(`pane ${id}: ${params.agent} worker on its chat engine (model=${model ?? 'default'}, cwd=${cwd})`);
    this.notify('pane.created', pane.info());
    this.workspacesChanged();
    if (params.orchestratorId) this.notifyRoster(params.orchestratorId);
    this.refreshGraphInfo(pane).catch((e) => log(`pane ${id}: graph status`, e));
    if (params.prompt) {
      pane.promptPending = true;
      this.prompt(id, params.prompt, true, false)
        .catch((e) => { log(`pane ${id}: initial prompt failed`, e); pane.promptPending = false; pane.emit('state', pane.state, pane.blocker, pane.state); });
    }
    return pane.info();
  }

  private async launchWorker(params: Methods['agent.spawn']['params'], cwd: string, worktree: PaneInfo['worktree']): Promise<PaneInfo> {
    const host = this.driverHost;
    if (params.orchestratorId && !params.command && !params.eventStream && host && guiWorkersOn() && host.supports(params.agent)) return this.launchDriverWorker(params, cwd, worktree, host);
    const extraArgs = (params.orchestratorId && !params.skipWorkerPermission && loadConfig().workerPermission === 'auto') ? adapterFor(params.agent).skipPermissionArgs() : [];
    if (extraArgs.length) log(`agent ${params.agent}: worker auto-permission → ${extraArgs.join(' ')}`);
    const wtEnv: Record<string, string> = worktree ? { KORA_MAIN_ROOT: worktree.mainRoot, KORA_WORKTREE: worktree.path, KORA_BRANCH: worktree.branch } : {};
    const env = worktree || params.env ? { ...wtEnv, ...(params.env ?? {}) } : undefined;
    // params.paneId: a swarm task resumed after a restart keeps its pane id, so the leader's ids stay valid (D17/D18).
    const keepId = params.paneId && /^p\d+$/.test(params.paneId) && !this.panes.has(params.paneId) ? { id: params.paneId } : {};
    const info = await this.spawnPane({ command: params.command || agentCommand(params.agent), args: [...(params.args ?? []), ...extraArgs], cwd, agent: params.agent, name: params.name, workspaceId: params.workspaceId, budgetUsd: params.budgetUsd, env }, { ...keepId, worktree, account: params.account ?? null, ...(params.isolatedEnv ? { envPolicy: 'isolated' as const } : {}), ...(params.eventStream ? { eventStream: true } : {}) });
    // Fleet: a pane spawned WITH an orchestratorId is that orchestrator's worker (account is already applied at spawn
    // for credential isolation). role + orchestratorId let the roster and the steering feedback find its owner.
    if (params.orchestratorId) {
      const wp = this.panes.get(info.id);
      if (wp) { wp.role = 'worker'; wp.orchestratorId = params.orchestratorId; this.notify('pane.updated', wp.info()); this.notifyRoster(params.orchestratorId); }
      // A chat lead's CLI worker gets a record: it sleeps after work (worker-sleep.ts) and stays readable afterwards.
      if (wp && !params.command) { try { this.workerSleeper().track(wp as any, { prompt: params.prompt ?? null, args: params.args ?? [] }); } catch (e) { log(`pane ${info.id}: worker record failed`, e); } }
    }
    if (params.prompt) {
      const text = params.prompt;
      const wp = this.panes.get(info.id);
      if (wp) { wp.promptPending = true; wp.initialTask = text; }
      // An untrusted folder: the agent may sit on its own trust dialog until the human answers it (Kora won't). Keep the
      // task queued for that long instead of dropping it after 2 min; the lead is told not to re-send it (pl5 S2-2).
      const untrusted = !(require('../trust/gate') as typeof import('../trust/gate')).isFolderTrusted(info.worktree?.mainRoot ?? info.cwd);
      this.prompt(info.id, text, true, true, untrusted ? 30 * 60_000 : 120_000)
        .catch((e) => log(`pane ${info.id}: initial prompt failed`, e))
        .finally(() => { const q = this.panes.get(info.id); if (q) { q.promptPending = false; q.emit('state', q.state, q.blocker, q.state); } });
    }
    return info;
  }

  private sleeper: import('./worker-sleep').WorkerSleeper | null = null;
  /** Chat leads' CLI workers: records, sleep after 10 min idle (folder removed, work kept on its branch), wake. */
  workerSleeper(): import('./worker-sleep').WorkerSleeper {
    if (this.sleeper) return this.sleeper;
    const { WorkerSleeper } = require('./worker-sleep') as typeof import('./worker-sleep');
    this.sleeper = new WorkerSleeper({
      panes: () => [...this.panes.values()] as any,
      report: (id) => this.report(id, 1),
      kill: (id) => this.killPane(id),
      spawn: async (p) => ({ id: (await this.agentSpawn({ agent: p.agent as AgentId, cwd: p.cwd, name: p.name, orchestratorId: p.orchestratorId, args: p.args, ...(p.prompt ? { prompt: p.prompt } : {}), ...(p.reuseWorktree ? { reuseWorktree: p.reuseWorktree } : {}) } as any)).id }),
      ready: (id) => this.settleResumed(id),
      notify: (method, params) => this.notify(method as any, params as any),
      log: (m) => log(m),
    }, { ...(Number(process.env.KORA_WORKER_SLEEP_MS) > 0 ? { sleepAfterMs: Number(process.env.KORA_WORKER_SLEEP_MS) } : {}) });
    return this.sleeper;
  }
  /** A resumed pane is ready for typing when it reads idle and its screen has been quiet (the TUI redraws its history and
   *  loads MCP servers first). Reuses `wait` and the quiet-screen settle of `promptNow`; bounded, never throws. */
  private async settleResumed(paneId: string): Promise<void> {
    const p = this.panes.get(paneId);
    if (!p || p.exited) return;
    await this.wait(paneId, 'idle', 45_000, false, { ignorePending: true }).catch(() => undefined);
    const t0 = Date.now();
    while (!p.exited && Date.now() - p.lastOutputAt < 2000 && Date.now() - t0 < 15_000) await sleep(100);
  }
  /** A worker's readable history (awake or asleep): its record and its CLI transcript (Claude Code / Codex JSONL). */
  workerTranscript(recordId: string): { record: import('./worker-sleep').WorkerRecord; entries: import('./worker-sleep').TranscriptEntry[] } | null {
    const ws = require('./worker-sleep') as typeof import('./worker-sleep');
    const r = this.workerSleeper().load(recordId);
    if (!r) return null;
    const live = r.status === 'awake' ? this.panes.get(r.paneId) : undefined;
    let file = r.session.transcriptPath ?? live?.agentSessionPath ?? (r.session.id || live?.agentSessionId ? findTranscript((r.session.id || live?.agentSessionId)!) : null);
    if (!file && r.agent === 'codex') file = ws.findCodexSession(r.worktree?.path ?? r.cwd, r.createdAt)?.path ?? null;
    return { record: r, entries: ws.readTranscript(file) };
  }
  /** Wake a sleeping worker (its folder back from its branch, the same session resumed). */
  wakeWorker(recordId: string): Promise<import('./worker-sleep').WakeResult> { return this.workerSleeper().wake(recordId); }

  /** Every 30 s: the sleeper's pass. Returns the stop function. */
  startWorkerSleeper(intervalMs = 30_000): () => void {
    const sl = this.workerSleeper();
    let running = false;
    const t = setInterval(() => { if (running) return; running = true; sl.tick().catch((e) => log('worker sleeper failed', e)).finally(() => { running = false; }); }, intervalMs);
    t.unref();
    return () => clearInterval(t);
  }

  async prompt(paneId: string, text: string, submit = true, waitIdle = true, timeoutMs = 60_000, source: 'leader' | 'kora' = 'leader'): Promise<{ ok: true; state: AgentState }> {
    const p = this.requirePane(paneId);
    // An event-driven agent (Koragent) takes text as a `steer` message on its event stream, never as keystrokes: no
    // idle wait, no typed injection, no delivery escalation. waitIdle = "after the current turn" (queue); otherwise it
    // lands at the next step boundary (steer).
    if (p.steerSink && submit) {
      if (p.exited) throw new Error(`pane ${paneId} has exited`);
      await p.steerSink(text, source, waitIdle ? 'queue' : 'steer');
      return { ok: true, state: p.state };
    }
    // One prompt at a time per pane. The chain is kept alive across failures so a rejected prompt never blocks the next.
    const run = p.promptLock.then(() => this.promptNow(p, text, submit, waitIdle, timeoutMs));
    p.promptLock = run.catch(() => undefined);
    return run;
  }

  private async promptNow(p: Pane, text: string, submit: boolean, waitIdle: boolean, timeoutMs: number): Promise<{ ok: true; state: AgentState }> {
    const paneId = p.id;
    if (waitIdle && p.state !== 'idle' && !p.exited) {
      // ignorePending: THIS call may be the pending initial prompt itself (agentSpawn sets promptPending before
      // typing, so an external wait does not report the fresh pane idle). Gating our own wait on it deadlocked
      // every spawn prompt for the full 120 s in three live fleet runs — the pane sat idle at an empty composer,
      // the log said "not idle after 120000ms (state=idle)", and the orchestrator had to re-prompt by hand.
      const r = await this.wait(paneId, 'idle', timeoutMs, false, { ignorePending: true });
      if (r.timedOut) throw new Error(`agent ${paneId} not idle after ${timeoutMs}ms (state=${r.state}${r.blocker ? `: ${r.blocker}` : ''}); use --no-wait to type anyway`);
    }
    if (p.exited) throw new Error(`pane ${paneId} has exited`);
    // Settle: "idle" can fire from the banner/title before the input box exists (a real Claude start-up lost a
    // prompt this way). Wait for the screen to go quiet before typing, bounded so a chatty agent cannot stall us.
    if (waitIdle) { const t0 = Date.now(); while (Date.now() - p.lastOutputAt < 700 && Date.now() - t0 < 5000) await sleep(100); }
    // A finished coding agent often leaves a SUGGESTED next action sitting in its composer ("Save this
    // as a research file in the repo"). Typing onto that and pressing Enter submits the suggestion plus
    // our text — the agent then does something nobody asked for, in the repo. Clear the line first:
    // ^U alone: it is the tty's VKILL in canonical mode AND the composer's clear-line in a raw-mode
    // TUI, so it works for a shell pane and an agent alike, and is inert on an empty box. (^K is NOT
    // a tty special — on a canonical pane it would be delivered as a literal byte in the line.)
    if (waitIdle && submit) { p.write('\x15'); await sleep(30); }
    // Agents without a prompt hook (codex, gemini, agy, …) never got the per-prompt graph declarations the Claude
    // lane gets from UserPromptSubmit: their only graph signal was the rulebook. Resolve them here and type them
    // ahead of the prompt, as one bracketed paste so a multi-line block does not submit early. Best effort, bounded.
    let typed = text;
    if (submit && typedInjectionAgent(p.agent)) {
      try {
        const { injectForPrompt } = require('../graph/prompt-inject') as typeof import('../graph/prompt-inject');
        // keyed by pane id AND creation time: pane ids restart at p1 with every daemon, and the injected/shown markers
        // live in tmp — a fresh p1 inherited the last daemon's p1 markers and skipped its first prompt as 'already injected'
        const inj = await injectForPrompt({ prompt: text, cwd: p.liveCwd || p.cwd, sessionId: `pane:${p.id}:${p.createdAt}`, lane: 'pane-typed', graph: this.graph as any });
        if (inj) typed = `${inj}\n\n${text}`;
      } catch { /* the prompt goes without */ }
    }
    if (typed !== text || /\n/.test(typed)) p.write(`\x1b[200~${typed}\x1b[201~`); else p.write(typed);
    if (submit) {
      await sleep(50); p.write('\r');
      // Did the agent take it? Escalates for a swallowed Enter / dropped prompt, and never re-sends an accepted
      // one (prompt-delivery.ts). The re-type sends the bare prompt (no injected declarations), as before.
      const env = { now: Date.now, sleep, log: (m: string) => log(m) };
      await confirmStartupDelivery(p, text, Date.now(), env);
      // Then the screen: the text must have left the input box (a resumed worker's state can read non-idle with text unsent).
      await confirmInputEmptied(p, text, env);
    }
    return { ok: true, state: p.state };
  }

  wait(paneId: string, until: AgentState | 'needs-human' = 'needs-human', timeoutMs = 0, afterChange = false, opts: { ignorePending?: boolean } = {}): Promise<{ state: AgentState; blocker: string | null; timedOut: boolean }> {
    const p = this.requirePane(paneId);
    let armed = !afterChange; // with afterChange, the first transition arms the `until` check
    // A pane whose initial prompt is still being typed is not idle in any useful sense (blocked still counts: a
    // trust dialog can precede the prompt); the spawn path emits a state event when the prompt has gone in.
    // The prompt path itself passes ignorePending — it IS the pending prompt (see promptNow).
    // A swarm (OpenCode) worker's idle must be backed by its idle screen or the plugin (swarm-state.ts): a start-up
    // blank reads as a quiet idle for a few hundred ms and answered kora_wait "idle, no report" before any work began.
    // An error-stalled worker kora is auto-continuing is not idle either (its "continue" is on its way).
    const idleNow = () => p.state === 'idle' && (opts.ignorePending || !p.promptPending) && (opts.ignorePending || !p.errorStall?.retrying) && (!p.swarm || opts.ignorePending || swarmIdleConfirmed(p));
    const done = () => p.exited || (armed && (until === 'needs-human' ? p.state === 'blocked' || idleNow() : until === 'idle' ? idleNow() : p.state === until));
    const result = (timedOut: boolean) => ({ state: p.state, blocker: p.blocker, timedOut });
    if (done()) return Promise.resolve(result(false));
    const limit = timeoutMs > 0 ? Math.min(timeoutMs, MAX_WAIT_MS) : MAX_WAIT_MS;
    return new Promise((resolve) => {
      let poll: ReturnType<typeof setInterval> | null = null;
      const finish = (timedOut: boolean) => { clearTimeout(t); if (poll) clearInterval(poll); p.off('state', check); p.off('exit', check); p.off('recheck', check); resolve(result(timedOut)); };
      const check = () => { armed = true; if (done()) finish(false); };
      const t = setTimeout(() => finish(true), limit);
      p.on('state', check); p.on('exit', check); p.on('recheck', check);
      // An unconfirmed swarm idle can become confirmed with no state change (idle → idle): look again every second.
      poll = p.swarm ? setInterval(() => { if (p.state === 'idle' && done()) finish(false); }, 1000) : null;
    });
  }

  // ---------- orchestration (fleet) ----------
  /** Promote a pane to orchestrator and hand it the briefing. Agent-agnostic — any agent can be the orchestrator. */
  async promote(paneId: string, briefing?: string): Promise<{ ok: true }> {
    const p = this.requirePane(paneId);
    p.role = 'orchestrator';
    installOrchestratorSkill(p.agent);   // ensure the portable playbook + Claude skill are present
    this.notify('pane.updated', p.info());
    log(`pane ${p.id}: promoted to orchestrator`);
    // A caller-supplied briefing is used verbatim; otherwise send the SHORT activation (not the 60-line playbook —
    // the agent reads that from the skill/file), so promotion is fast and never mangled by a slow paste. Best-effort.
    const brief = (briefing && briefing.trim()) || activationPrompt(p.id);
    this.prompt(p.id, brief, true, true, 60_000).catch((e) => log(`pane ${p.id}: activation not delivered: ${e?.message || e}`));
    return { ok: true };
  }
  /**
   * A human wrote to a pane over the socket (a frontend). For a WORKER pane this is unsolicited steering: accumulate
   * the keystrokes, and when a substantive line is submitted, notify the owning orchestrator so it re-plans. Any
   * other pane (orchestrator, plain agent, shell) just gets the bytes. Agent-agnostic: provenance is the socket, not
   * a Claude hook — a human steering a Codex worker is detected exactly the same way.
   */
  humanWrite(paneId: string, data: string | Buffer): void {
    const p = this.requirePane(paneId);
    p.write(data);
    // A chat-plane orchestrator (`chat:<threadId>`) is not a pane: steer detection still runs (the daemon routes
    // pane.steered to the thread); only the in-pane note delivery below needs a pane.
    if (p.role !== 'worker' || !p.orchestratorId) return;
    const s = typeof data === 'string' ? data : data.toString('utf8');
    p.humanInputBuf += s;
    if (!/[\r\n]/.test(s)) { if (p.humanInputBuf.length > 4096) p.humanInputBuf = p.humanInputBuf.slice(-4096); return; }
    const raw = p.humanInputBuf.split(/[\r\n]/)[0];
    p.humanInputBuf = '';
    // strip CSI/control so the note is the human's actual words; short lines are y/n / menu nav, not a steer.
    // Strip everything a terminal EMULATOR sends on its own (DCS/OSC/APC replies such as XTVERSION
    // `ESC P > | libghostty ESC \`, CSI replies) so the note is the human's actual words.
    // Mouse reports (SGR `ESC[<35;12;40M` and its ESC-less fragments) used to survive here and reach the lead as a
    // "steer"; cleanSteerText strips every terminal-sent sequence, isSteerText demands actual words.
    const text = cleanSteerText(raw);
    if (!isSteerText(text)) return;
    const now = Date.now();
    if (p.steeredAt && now - p.steeredAt < 600) return; // debounce a paste burst
    this.noteHumanSteer(p, text, now);
  }
  /** A GUI worker's steer box (DriverPane): the text goes to the engine as a steer (stop the turn, then this). */
  async humanSteer(paneId: string, text: string): Promise<void> {
    const p = this.requirePane(paneId);
    if (!p.steerSink || p.exited) throw new Error(`pane ${paneId} cannot take a steer`);
    await p.steerSink(text, 'human', 'steer');
    if (p.role === 'worker' && p.orchestratorId && text.trim()) this.noteHumanSteer(p, text.trim(), Date.now());
  }
  private noteHumanSteer(p: Pane, text: string, now: number): void {
    if (!p.orchestratorId) return;
    p.steeredAt = now;
    log(`pane ${p.id}: human steered → orchestrator ${p.orchestratorId}: "${text}"`);
    this.notify('pane.steered', { paneId: p.id, orchestratorId: p.orchestratorId, origin: 'human', text, state: p.state });
    this.notify('pane.updated', p.info());
    this.pushFleetEvent(p.orchestratorId, { at: now, kind: 'human-steered', text: `${p.id}: ${text}`, workerId: p.id });
    this.notifyRoster(p.orchestratorId);
    this.enqueueSteer(p.orchestratorId, `[kora] the human just steered worker ${p.id} (${p.agent}${p.account ? '@' + p.account : ''}): "${text}"\nTreat this as a hard override: accept it, adjust the plan, and do NOT re-issue the instruction it overrode. If it changes what ${p.id} touches, re-check the other workers for new conflicts.`);
  }
  private enqueueSteer(orchestratorId: string, note: string): void {
    const o = this.panes.get(orchestratorId); if (!o || o.exited) return;
    o.steerQueue.push(note);
    if (o.state === 'idle') this.flushSteers(o).catch((e) => log(`pane ${o.id}: steer flush failed`, e));
  }
  private async flushSteers(o: Pane): Promise<void> {
    if (o.exited || !o.steerQueue.length) return;
    const notes = o.steerQueue; o.steerQueue = [];
    const text = notes.join('\n\n');
    await this.prompt(o.id, text, true, true, 30_000).catch((e) => { o.steerQueue.unshift(...notes); log(`pane ${o.id}: steer note not delivered (requeued): ${e?.message || e}`); });
  }
  /** assign: give an existing worker more work. */
  async assign(paneId: string, prompt: string): Promise<{ ok: true; state: AgentState }> {
    const r = await this.prompt(paneId, prompt, true, true, 120_000);
    return { ok: true, state: r.state };
  }
  private fleetState(orchestratorId: string) {
    let f = this.fleets.get(orchestratorId);
    if (!f) { capSize(this.fleets, 200); f = { plan: '', events: [] }; this.fleets.set(orchestratorId, f); }
    return f;
  }
  private pushFleetEvent(orchestratorId: string, event: FleetEvent) {
    const f = this.fleetState(orchestratorId);
    f.events.push(event); if (f.events.length > 40) f.events.shift();
    this.notify('fleet.event', { orchestratorId, event });
  }
  private roster(orchestratorId: string): RosterEntry[] {
    return [...this.panes.values()].filter((p) => p.orchestratorId === orchestratorId && !p.exited).map((p) => ({
      paneId: p.id, agent: p.agent, account: p.account, state: p.state, blocker: p.blocker,
      steered: !!p.steeredAt && Date.now() - p.steeredAt < 4000,
    }));
  }
  private notifyRoster(orchestratorId: string) { if (this.panes.has(orchestratorId)) this.notify('fleet.roster', { orchestratorId, roster: this.roster(orchestratorId) }); }
  /**
   * Out-of-band notes for an orchestrator that lives OUTSIDE this process (the desktop chat daemon queues them per
   * thread). The host installs a source; `fleet.drainNotes` hands the pending notes to whoever asks — the
   * `kora mcp --fleet` bridge folds them into kora_wait / kora_workers results, so a Codex orchestrator learns
   * of a steer mid-turn the way a Claude one does.
   */
  noteSource: { drain(orchestratorId: string): string[] } | null = null;
  fleetDrainNotes(orchestratorId: string): string[] {
    try { return this.noteSource?.drain(orchestratorId) ?? []; } catch (e) { log(`fleet.drainNotes failed`, e); return []; }
  }
  fleetGet(orchestratorId: string): Methods['fleet.get']['result'] {
    const f = this.fleetState(orchestratorId);
    return { roster: this.roster(orchestratorId), plan: f.plan, events: [...f.events].reverse() };
  }
  fleetSet(orchestratorId: string, patch: { plan?: string }): { ok: true } {
    const f = this.fleetState(orchestratorId);
    if (patch.plan !== undefined) { f.plan = patch.plan; this.notify('fleet.plan', { orchestratorId, plan: f.plan }); }
    return { ok: true };
  }
  /**
   * Graph pre-merge gate across the given workers' worktrees. Does NOT merge. Each worktree is diffed from its own
   * merge-base with the main checkout's HEAD (the branch it will be merged into) — never from the commit the graph
   * happened to be indexed at (a stale index made every worker "change" main's recent files and flagged every pair;
   * an unindexed repo silently returned all-clean).
   */
  async mergeVerify(params: { paneIds?: string[]; worktreePaths?: string[] }): Promise<{ pairs: MergePair[]; order: string[] }> {
    const { mergeTarget } = require('./worktree') as typeof import('./worktree');
    const workers: { paneId: string; path: string }[] = [];
    for (const id of params.paneIds ?? []) { const p = this.panes.get(id); if (p?.worktree) workers.push({ paneId: p.id, path: p.worktree.path }); }
    for (const wpath of params.worktreePaths ?? []) if (!workers.some((w) => w.path === wpath)) workers.push({ paneId: wpath, path: wpath });
    if (workers.length < 2) return { pairs: [], order: workers.map((w) => w.paneId) };
    const repoRoot = mergeTarget(workers[0].path) ?? workers[0].path;
    // Labels are pane ids (what the orchestrator/UI know), so the engine's worktree refs are relabelled below.
    const refs = workers.map((w) => ({ kind: 'worktree' as const, path: w.path, label: w.paneId }));
    const r = await this.runMergeGate({ repoRoot, refs, targetRef: 'HEAD' });
    return { pairs: r.pairs, order: r.order };
  }

  /**
   * Run the merge engine OFF the event loop: a child `kora cross-worktree` does the work (git diffs + graph
   * queries, ~a minute on a cold repo — in-process it stalled the server long enough to drop every websocket).
   * The in-process path stays as the fallback when the child cannot start.
   */
  private async runMergeGate(job: { repoRoot: string; refs: any[]; baseRef?: string; targetRef?: string }): Promise<{ pairs: MergePair[]; order: string[]; base: string; refs: string[]; bases?: Record<string, string> }> {
    type R = { pairs: MergePair[]; order: string[]; base: string; refs: string[]; bases?: Record<string, string> };
    try {
      return await new Promise<R>((resolve, reject) => {
        const child = execFile(process.execPath, [this.binPath, 'cross-worktree'], { timeout: 300_000, maxBuffer: 64 << 20, env: { ...process.env, KORA_ENV: '1' } }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`${err.message}${stderr ? `: ${String(stderr).slice(0, 300)}` : ''}`));
          try { resolve(JSON.parse(String(stdout))); } catch (e) { reject(e); }
        });
        child.stdin?.end(JSON.stringify(job));
      });
    } catch (e: any) {
      // In-process only when the child could not START (no bin): the engine on the event loop is a multi-second stall,
      // so a child that timed out or crashed under load reports that instead of re-running here.
      if (!/ENOENT|EACCES|MODULE_NOT_FOUND/.test(String(e?.message ?? e))) throw e;
      log('merge gate child could not start; running in-process', e);
      const { verifyMerge } = require('../merge/engine') as typeof import('../merge/engine');
      return await verifyMerge(job.repoRoot, job.refs, this.graph, { baseRef: job.baseRef, targetRef: job.targetRef });
    }
  }

  // Standalone graph-verified merge/PR gate. Resolves the repo root from cwd, classifies each ref (an on-disk path
  // → an existing worktree used in place; otherwise a branch/SHA the engine materializes into a throwaway worktree),
  // and runs the shared merge engine — each ref diffed from its merge-base with `targetRef` when given, else from
  // the refs' common merge-base. Backs `kora merge`, `kora pr`, and the desktop Merge view. Never touches the fleet.
  async mergeVerifyRefs(params: { cwd: string; refs: string[]; baseRef?: string; targetRef?: string }): Promise<{ pairs: MergePair[]; order: string[]; base: string; refs: string[]; bases?: Record<string, string> }> {
    const { execFile } = require('node:child_process');
    const fs = require('node:fs');
    // Async + bounded: never a git call that can hang on the daemon's event loop.
    const top = await new Promise<string | null>((resolve) => execFile('git', [...GIT_NO_FSMONITOR, '-C', params.cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: gitEnv() }, (err: unknown, out: string) => resolve(err ? null : String(out || '').trim())));
    const repoRoot = gitPath(top) || params.cwd;
    const refs = (params.refs || []).map((r) => {
      const abs = require('node:path').isAbsolute(r) ? r : require('node:path').join(params.cwd, r);
      const isWorktree = (() => { try { return fs.existsSync(abs) && fs.statSync(abs).isDirectory() && fs.existsSync(require('node:path').join(abs, '.git')); } catch { return false; } })();
      return isWorktree ? { kind: 'worktree', path: abs } : { kind: 'branch', name: r };
    });
    return await this.runMergeGate({ repoRoot, refs, baseRef: params.baseRef, targetRef: params.targetRef });
  }

  // ---------- foreground process watcher (shell panes running an agent) ----------
  private fgTick() {
    if (this.fgBusy || this.closing) return;
    const win = process.platform === 'win32';
    if (win && Date.now() - this.fgLastWin < FG_WATCH_WIN_MS) return;
    const targets = [...this.panes.values()].filter((p) => !p.exited && p.pid && !isKnownAgent(p.declaredAgent));
    if (!targets.length) return;
    this.fgBusy = true;
    if (win) {
      // Windows has no `ps`: one asynchronous CIM query (util/win-procs.ts), command lines split by Windows' rules.
      this.fgLastWin = Date.now();
      listWindowsProcesses().then((procs) => {
        this.fgBusy = false;
        if (!procs) { log('fg watcher: process query failed'); return; }
        const children = new Map<number, { pid: number; args: string }[]>();
        for (const pr of procs) {
          if (!children.has(pr.ppid)) children.set(pr.ppid, []);
          children.get(pr.ppid)!.push({ pid: pr.pid, args: pr.commandLine });
        }
        this.fgScan(targets, children, (args) => agentFromArgvTokens(splitWindowsCommandLine(args)));
      }, () => { this.fgBusy = false; });
      return;
    }
    try {
      execFile('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024, timeout: 1500 }, (err, stdout) => {
        this.fgBusy = false;
        if (err) { log('fg watcher: ps failed', err.message); return; }
        const children = new Map<number, { pid: number; args: string }[]>();
        for (const line of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); if (!m) continue;
          const pid = Number(m[1]), ppid = Number(m[2]);
          if (!children.has(ppid)) children.set(ppid, []);
          children.get(ppid)!.push({ pid, args: m[3] });
        }
        this.fgScan(targets, children, agentFromPsArgs);
      });
    } catch (e: any) {
      this.fgBusy = false;
      log('fg watcher: ps spawn failed', e?.message || e);
    }
  }
  /** Walk each shell pane's process tree for an agent it started (`detect` reads one process's command line). */
  private fgScan(targets: Pane[], children: Map<number, { pid: number; args: string }[]>, detect: (args: string) => AgentId | null) {
      (async () => {
        await this.trackCwds(targets).catch((e) => log('fg watcher: cwd', e));
        for (const p of targets) {
          let found: AgentId | null = null; let agentPid: number | null = null;
          const queue = [...(children.get(p.pid!) ?? [])]; let guard = 0;
          while (queue.length && guard++ < 200) {
            const c = queue.shift()!;
            const a = detect(c.args); if (a) { found = a; agentPid = c.pid; break; }
            queue.push(...(children.get(c.pid) ?? []));
          }
          if (!found) found = p.titleAgentHint();
          if (p.setDetectedAgent(found)) {
            this.notify('pane.updated', p.info());
            // An agent started BY HAND in this shell: treat the directory it runs in like a spawn — hooks + rulebook,
            // and a graph warm-up with the bar (the shim's prelaunch usually got here first; both are idempotent).
            // The directory is the AGENT PROCESS's cwd (`cd x && claude` on one line beats the 2 s poll of the shell).
            if (found && isKnownAgent(found)) { const cwd = (agentPid ? await processCwd(agentPid) : null) ?? p.liveCwd ?? p.cwd; this.adoptAgent(p, cwd).catch((e) => log(`pane ${p.id}: adopt failed`, e)); }
          }
        }
      })().catch((e) => log('fg watcher', e));
  }
  /** Follow each shell pane's `cd`: when its repo changes, its graph state (tab bar, header) follows. */
  private async trackCwds(panes: Pane[]) {
    for (const p of panes) {
      if (p.exited || !p.pid) continue;
      const cwd = await processCwd(p.pid); if (!cwd || cwd === p.liveCwd) continue;
      p.liveCwd = cwd;
      let root: string | null = null; try { root = this.graph.repoRoot(cwd); } catch { root = null; }
      if (root !== pane_root(p)) { log(`pane ${p.id}: now in ${cwd}`); await this.refreshGraphInfo(p, cwd); }
      else this.notify('pane.updated', p.info());
    }
  }
  /** A known agent is running (or about to) in `cwd` of a pane that was spawned as a shell. */
  async adoptAgent(p: Pane, cwd: string): Promise<void> {
    log(`pane ${p.id}: adopting ${p.agent} in ${cwd}`);
    p.liveCwd = cwd;
    await this.ensureSetup(cwd);
    let root: string | null = null; try { root = this.graph.repoRoot(cwd); } catch { root = null; }
    if (root) this.ensuredRepos.add(root);
    await this.refreshGraphInfo(p, cwd);
  }
  async prelaunch(id: string, agent: AgentId, cwd: string): Promise<Methods['pane.prelaunch']['result']> {
    const p = this.requirePane(id);
    if (isKnownAgent(agent) && !isKnownAgent(p.declaredAgent) && p.setDetectedAgent(agent)) this.notify('pane.updated', p.info());
    await this.adoptAgent(p, cwd);
    return { ok: true, repoRoot: p.graph.repoRoot, indexed: p.graph.indexed, indexing: !!p.graph.indexing };
  }
  /** ctrl+b i: (re-)index the repo the pane is in, bar in the tab bar. Serialised per root by the ingest lock. */
  async indexPane(id: string): Promise<Methods['pane.index']['result']> {
    const p = this.requirePane(id);
    let root: string | null = null; try { root = this.graph.repoRoot(p.liveCwd ?? p.cwd); } catch { root = null; }
    if (!root) return { ok: false, repoRoot: null, message: `${p.liveCwd ?? p.cwd} is not inside a git repository` };
    if (p.graph.indexing) return { ok: false, repoRoot: root, message: `${path.basename(root)} is already being indexed` };
    this.ingested.add(root);
    log(`graph: index ${root} (requested from pane ${p.id})`);
    this.indexInBackground(p, root).catch((e) => log(`graph: ingest ${root} failed`, e));
    return { ok: true, repoRoot: root, message: `indexing ${path.basename(root)}…` };
  }

  // ---------- persistence ----------
  snapshotState(): PersistedState {
    return {
      version: 1, savedAt: Date.now(), activeWorkspaceId: this.activeWorkspaceId,
      workspaces: [...this.workspaces.values()].filter((w) => !w.ephemeral).map((w) => ({
        id: w.id, name: w.name, cwd: w.cwd, activePaneId: w.activePaneId,
        // Swarm workers are not re-spawned from here: SwarmService resumes the unfinished ones from tasks.json (with a
        // digest continuation, same pane id) and leaves finished ones finished. Re-spawning them from their argv re-ran
        // every task from scratch, done ones included (Koragent E2E D17).
        panes: w.paneIds.map((id) => this.panes.get(id)).filter((p): p is Pane => !!p && !p.exited && !p.swarm && !(p instanceof DriverPane)).map((p) => ({
          id: p.id, name: p.name, command: p.command, args: stripResume(p.declaredAgent, p.userArgs), cwd: p.cwd, agent: p.declaredAgent, agentSessionId: p.agentSessionId, cols: p.cols, rows: p.rows, worktree: p.worktree,
          budgetUsd: p.budgetUsd, agentSessionPath: p.agentSessionPath,
          ...(p.role ? { role: p.role } : {}), ...(p.orchestratorId ? { orchestratorId: p.orchestratorId } : {}),
        })),
      })),
    };
  }
  persist(immediate = false) { if (!this.closing) saveState(this.snapshotState(), immediate, this.stateFile); }

  /** Panes this daemon brought back from the state file (their ids are the previous daemon's). */
  readonly restoredPaneIds = new Set<string>();

  async restore(): Promise<number> {
    const s = loadState(this.stateFile); if (!s) return 0;
    let n = 0;
    for (const w of s.workspaces) {
      const ws = this.createWorkspace(w.name, w.cwd, w.id);
      for (const p of w.panes) {
        if (!fs.existsSync(p.cwd)) { log(`restore: skip ${p.id}, cwd missing: ${p.cwd}`); continue; }
        // A swarm worker saved by an older daemon (before swarm panes were left out): never re-run its task from argv.
        if (isSwarmWorkerArgv(p.args)) { log(`restore: skip ${p.id}, a swarm worker (SwarmService resumes it)`); continue; }
        const { command, args } = restoreCommand(p);
        try {
          await this.spawnPane({ command, args, cwd: p.cwd, agent: p.agent, name: p.name, workspaceId: ws.id, cols: p.cols, rows: p.rows }, { id: p.id, agentSessionId: p.agentSessionId, worktree: (p as any).worktree ?? null, budgetUsd: p.budgetUsd ?? null });
          // D18: the fleet link survives the restart (kora_workers / kora_wait of the orchestrator find it again).
          const np = this.panes.get(p.id);
          if (np && p.role) np.role = p.role;
          if (np && p.orchestratorId) np.orchestratorId = p.orchestratorId;
          this.restoredPaneIds.add(p.id);
          n++;
        } catch (e) { log(`restore: pane ${p.id} failed`, e); }
      }
      if (w.activePaneId && ws.paneIds.includes(w.activePaneId)) ws.activePaneId = w.activePaneId;
    }
    if (s.activeWorkspaceId && this.workspaces.has(s.activeWorkspaceId)) this.activeWorkspaceId = s.activeWorkspaceId;
    this.workspacesChanged();
    log(`restore: ${n} pane(s) re-spawned from ${s.workspaces.length} workspace(s)`);
    return n;
  }

  shutdown() {
    if (this.closing) return;
    this.persist(true); flush();
    this.closing = true;
    if (this.fgTimer) clearInterval(this.fgTimer);
    // Before the panes die: their exits must not rewrite tasks.json as failed (D17 - a restart resumes them).
    try { this.swarm?.shutdown(); } catch (e) { log('swarm shutdown failed', e); }
    for (const p of this.panes.values()) { try { p.dispose(); } catch { /* ignore */ } }
    this.panes.clear();
    for (const r of this.children.list()) this.children.remove(r.pid); // disposed above: nothing left to reap
    this.children.flush();
  }
}

/** Agents that get graph declarations TYPED with the prompt: every known agent except claude (its UserPromptSubmit
 *  hook injects them) and a plain shell. Override with KORA_TYPED_INJECT=agent,agent or =0. */
/** argv of a swarm worker (Koragent `--task-spec`): state files written before swarm panes were left out still have them. */
export function isSwarmWorkerArgv(args: string[] | undefined): boolean { return Array.isArray(args) && args.includes('--task-spec'); }

export function typedInjectionAgent(agent: string): boolean {
  const env = process.env.KORA_TYPED_INJECT;
  if (env === '0') return false;
  if (env) return env.split(',').map((s) => s.trim()).includes(agent);
  return isKnownAgent(agent) && agent !== 'claude';
}
const pane_root = (p: Pane) => p.graph.repoRoot;
/** Current directory of a process: /proc on Linux, lsof elsewhere (10–20 ms). Null when unknown. */
function processCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') { try { return Promise.resolve(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { return Promise.resolve(null); } }
  // Windows: no lsof, and no process query (CIM, Get-Process) exposes another process's cwd (it sits in the target's PEB:
  // native code only). Callers fall back to the pane's own cwd (`p.liveCwd ?? p.cwd`).
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1500 }, (err, out) => { if (err) return resolve(null); const n = String(out).split('\n').find((l) => l.startsWith('n')); resolve(n ? n.slice(1) : null); }));
}
function resolveCwd(cwd?: string): string {
  const c = cwd ? path.resolve(cwd.replace(/^~(?=$|\/)/, os.homedir())) : process.cwd();
  try { if (fs.statSync(c).isDirectory()) return c; } catch { /* fallthrough */ }
  return os.homedir();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Legacy full-briefing text (agent-neutral). Kept for callers/tests that want the whole playbook inline; promote()
 *  now installs the skill and sends a short activation instead of pasting this. Derived from the one playbook. */
export function orchestratorBriefing(orchestratorId: string): string {
  return orchestratorPlaybook().replace(/<orchestratorId>/g, orchestratorId);
}

/** Ensure the portable orchestrator playbook (readable by any agent) and, for a claude pane, the Claude skill exist. */
export function installOrchestratorSkill(agent?: AgentId): void {
  try {
    const pb = orchestratorPlaybookPath();
    fs.mkdirSync(path.dirname(pb), { recursive: true });
    fs.writeFileSync(pb, orchestratorPlaybook() + '\n');
  } catch (e) { log('could not write orchestrator playbook', e); }
  if (!agent || agent === 'claude') {
    try {
      const dir = path.join(os.homedir(), '.claude', 'skills', 'kora-orchestrator');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), claudeSkillDoc());
    } catch (e) { log('could not write claude orchestrator skill', e); }
  }
}

function safeGraph(): GraphService {
  try {
    const inline = createGraphService();
    // Queries off the event loop (graph/offload.ts). KORA_GRAPH_INLINE=1 keeps the old in-process path.
    // Ingests refuse to start on a nearly full disk (disk.ts); queries are unaffected.
    if (process.env.KORA_GRAPH_INLINE === '1') return withDiskGuard(inline);
    const { withGraphWorkers } = require('../graph/offload') as typeof import('../graph/offload');
    return withDiskGuard(withGraphWorkers(inline));
  }
  catch (e) {
    log('graph service unavailable', e);
    const nope = async () => { throw new Error('graph service unavailable'); };
    return { callTool: nope as any, status: async () => ({ repoRoot: null, indexed: false, nodes: 0, edges: 0, lastIngestAt: null, enforced: false, toolCalls: 0 }), ingest: nope as any, brief: async () => '', repoRoot: () => null };
  }
}
// The enforcer gets the daemon's OFFLOADED graph service: with its own inline one, the AGENTS.md brief a worker pane
// launches with (status + staleness: sync git and SQLite) ran on the event loop -- a 2.5 s stall on a swarm spawn.
function safeEnforcer(graph?: GraphService): Enforcer {
  try { return createEnforcer(graph ? { graph } : {}); }
  catch (e) {
    log('enforcer unavailable', e);
    return { prepare: async (i) => ({ command: i.command, args: i.args, env: {}, notes: [] }), install: async () => ({ results: [] }), uninstall: async () => ({ results: [] }), status: async () => ({ results: [] }), doctor: async () => ({ checks: [] }) };
  }
}

/**
 * A worker's branch landed in the main checkout by some other road than kora_merge: it had commits ahead of the
 * main checkout's branch, now has none, and nothing is left uncommitted in its worktree. A worker that never
 * committed (ahead stays 0) is not "merged".
 */
export function landedOutsideMerge(pane: { branchMerged: boolean; worktree: { ahead?: number } | null }, next: { dirty: number; ahead: number }): boolean {
  if (pane.branchMerged || !pane.worktree) return false;
  return (pane.worktree.ahead ?? 0) > 0 && next.ahead === 0 && next.dirty === 0;
}

/** GUI worker boxes (docs/fleet/WORKER-BOXES.md) are on unless KORA_GUI_WORKERS=off (then every worker is a PTY pane). */
export function guiWorkersOn(): boolean { return process.env.KORA_GUI_WORKERS !== 'off' && process.env.KORA_GUI_WORKERS !== '0'; }

/** The model and effort a worker was asked for, from its CLI launch args (agent-adapter modelArgs encodings). */
export function modelFromArgs(args: string[]): { model: string | null; effort: string | null } {
  let model: string | null = null, effort: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    if ((a === '--model' || a === '-m') && v) { model = v; i++; }
    else if (a.startsWith('--model=')) model = a.slice(8);
    else if (a === '--effort' && v) { effort = v; i++; }
    else if (a === '-c' && v && /^model_reasoning_effort=/.test(v)) { effort = v.slice('model_reasoning_effort='.length).replace(/^"|"$/g, ''); i++; }
  }
  return { model, effort };
}

/** The permission posture a worker's CLI args asked for, as a chat RuntimeMode. */
export function runtimeModeFromArgs(args: string[], autoDefault: boolean): RuntimeMode {
  const s = args.join(' ');
  if (/--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--permission-mode[= ]bypassPermissions|--yolo|--approval-mode[= ]yolo/.test(s)) return 'full-access';
  if (/--permission-mode[= ]acceptEdits|--full-auto|--approval-mode[= ]auto_edit/.test(s)) return 'auto-accept-edits';
  return autoDefault ? 'full-access' : 'approval-required';
}

/** KORA_CALLER_KEY for a pane / chat session id (server/control-auth.ts callerKey); empty without a token file. */
function callerKeyEnv(id: string): Record<string, string> {
  try { const k = (require('./control-auth') as typeof import('./control-auth')).callerKey(id, koraHome()); return k ? { KORA_CALLER_KEY: k } : {}; } catch { return {}; }
}

/**
 * The real path of a transcript an agent reported, when it is a regular file (not a symlink) in an agent's own transcript
 * folder: a Claude config dir (`~/.claude*`, the pane's CLAUDE_CONFIG_DIR), Codex's / Gemini's home, or the Kora home
 * (per-account config dirs). Null otherwise. Exported for tests.
 */
export function agentTranscriptPath(p: string, configDir?: string | null, home: string = os.homedir()): string | null {
  try {
    if (!path.isAbsolute(p) || !/\.jsonl?$/i.test(p)) return null;
    const st = fs.lstatSync(p);
    if (!st.isFile()) return null;
    const real = fs.realpathSync.native(p);
    const r = (x: string): string => { try { return fs.realpathSync.native(x); } catch { return path.resolve(x); } };
    const roots = [configDir, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, path.join(home, '.codex'), path.join(home, '.gemini'), koraHome()].filter((x): x is string => !!x).map(r);
    const h = r(home);
    const top = real.startsWith(h + path.sep) ? real.slice(h.length + 1).split(path.sep)[0] ?? '' : '';
    const inClaudeHome = top.startsWith('.claude') && top !== '.claude.json';
    if (!inClaudeHome && !roots.some((root) => real.startsWith(root + path.sep))) return null;
    const { sensitivePathReason } = require('../session/sensitive-guard') as typeof import('../session/sensitive-guard');
    return sensitivePathReason(real, home) ? null : real;
  } catch { return null; }
}

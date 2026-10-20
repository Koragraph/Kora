// Unix-socket JSON-RPC server. `createServer()` for programmatic use; `runForeground()` for `server run`;
// `startDetached()` for `server start`.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Methods, MethodName, SwarmPaneEvent } from '../protocol/types';
import type { ChatThreadInfo, PendingModeNotice, ThreadAgentMode } from '../session/events';
import { defaultSocketPath, koraHome, GRAPH_TOOLS } from '../protocol/types';
import { version } from '../../package.json';
import { Runtime, binPath } from './workspace';
import { makeFleetOps } from './fleet-ops';
import { PRIVILEGED_METHODS, ensureControlToken, hasControl, orchestratorRuntimeMode, vetUncontrolledCall, verifiedCaller, insideRoots, GUARDED_AGENTS, CONTROL_DENIED_CODE, CONTROL_DENIED_MESSAGE } from './control-auth';
import { LineBuffer, parseMessage, resultResponse, errorResponse, encode, notification, RpcError, ERR_METHOD_NOT_FOUND, ERR_INVALID_PARAMS, ERR_INTERNAL } from './rpc';
import { log, logPath } from './log';
import { SUN_PATH_MAX } from '../graph/embedded';
import { ipcAddress, isWindows } from '../util/ipc-path';
import { loadConfig, saveConfig, configPath, invalidateConfig } from '../config';
import { KoraClient } from '../protocol/client';
import { SessionManager, type ManagerRuntime } from '../session/session-manager';
import { ApprovedPicks } from '../session/worker-picker';
import { ChatThreadStore } from '../session/store';
import { extractNeighborhood, layoutNeighborhood, type GraphToolResult } from '../session/graph-interceptor';
import { startUiServer, type UiServerHandle } from './ui';
import { makeBlobRuntime, makeOpencodeDeps } from './blobs';
import { Engines } from './engines';
import { blobsRoot } from '../blobs/home';
import { isKoraSurfaceOn, KORA_COMING_SOON_MESSAGE } from '../edition';
import type { BlobRuntimeImpl } from '../blobs/runtime';
import { startHousekeeping } from './housekeeping';
import { noteWatchdogLabel, startWatchdog } from './watchdog';
import { removeDaemonPid, writeDaemonPid } from './daemon-pid';
import { graphStoreDir } from './disk';
import { GIT_NO_FSMONITOR, GIT_TIMEOUT_MS, gitEnv, isSafePathSegment } from '../util/safe-path';

const MAX_WRITABLE = 4 * 1024 * 1024;
/** Concurrent socket connections (2026-10-15 audit #7): the app, the CLI, every pane's hooks; far above any real fleet. */
export const MAX_CONNECTIONS = 512;
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
/** The start-up sweep's `minAgeMs`: a worktree touched this recently may belong to a spawn whose pane is not live yet
 *  (a swarm spawn creates its worktree before the pane; found by B5: the 1.5 s sweep deleted one under load). A daemon
 *  that crashed mid-fleet leaves worktrees older than this; younger ones wait for the periodic sweep. */
export const STARTUP_SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/** The start-up sweep (after `delayMs`) and the periodic one; returns a stop function. */
export function scheduleWorktreeSweeps(
  sweep: (p: { repos: string[]; minAgeMs: number }) => Promise<unknown>,
  repos: () => string[],
  opts: { delayMs?: number; everyMs?: number; onError?: (e: unknown) => void } = {},
): () => void {
  const fail = (e: unknown) => { try { opts.onError?.(e); } catch { /* ignore */ } };
  const run = (minAgeMs: number) => { try { sweep({ repos: repos(), minAgeMs }).catch(fail); } catch (e) { fail(e); } };
  const first = setTimeout(() => run(STARTUP_SWEEP_MIN_AGE_MS), opts.delayMs ?? 1500); first.unref?.();
  const every = opts.everyMs ?? SWEEP_EVERY_MS;
  const iv = setInterval(() => run(every), every); iv.unref?.();
  return () => { clearTimeout(first); clearInterval(iv); };
}

// chatThreadIds: the per-connection chat-event subscription filter (mirrors paneIds for pane.output).
// null = not chat-subscribed; a Set = only chat.event frames for these threads reach this connection.
interface Conn { sock: net.Socket; lines: LineBuffer; subscribed: boolean; paneOutput: boolean; paneIds: Set<string> | null; chatThreadIds: Set<string> | null; id: number; /** events.subscribe came with the control token: pane output of every pane, shells included. */ control?: boolean; /** Without the token: the verified caller whose fleet's events this connection receives (2026-10-15 audit #3). */ scope?: string }

/** Who made a call: the control token's holder (the user), or a verified agent (`caller`), or neither. */
interface CallCtx { control: boolean; caller?: string; /** A `caller` that came without a valid key (a pane started before the key existed). */ unproven?: string }

/**
 * The refusal an agent sees when it named itself without a valid KORA_CALLER_KEY: say why and what fixes it, instead of
 * an empty list or a bare "must come from a Kora agent". Every pane / chat session the daemon starts, restores or restarts
 * gets a fresh key (workspace.ts callerKeyEnv); a process started before the key existed, or before the control token
 * changed, holds none or a stale one, and only a restart hands it a new environment.
 */
function staleCallerError(method: string, caller: string): RpcError {
  return new RpcError(CONTROL_DENIED_CODE, `${method}: ${staleCallerHint(caller)}`);
}
function staleCallerHint(caller: string): string {
  return `this agent (${caller}) has no valid KORA_CALLER_KEY: it was started before Kora's update or before the control token changed. Restart this pane (or this chat session) and retry.`;
}

export interface ServerHandle {
  socketPath: string; runtime: Runtime;
  /** The ONE chat SessionManager + the runtime seam it drives through — the socket's chat.* lane and the in-process
   *  chat UI server (ui.ts) share both, so there is one ChatThreadStore writer per machine. */
  sessions: SessionManager; managerRuntime: ManagerRuntime;
  /** The in-process chat UI server, once runForeground has started it (null: off, no bundle, or not up yet). */
  ui: UiServerHandle | null;
  /** The Blobs runtime (store, memory worker, prompts, self tools); also `managerRuntime.blobs` and `UiHost.blobs`. */
  blobs: BlobRuntimeImpl;
  /** Why the chat UI server could not start (its port taken by another program, …): status says so instead of "off". */
  uiError?: string | null;
  close(): Promise<void>; readonly closed: Promise<void>;
}

// The kernel truncates a socket path longer than sun_path (see SUN_PATH_MAX): the file to remove may be the
// truncated name. Remove both spellings so a crashed server never leaves an EADDRINUSE behind.
function unlinkSocket(socketPath: string): void {
  if (isWindows) return;   // a named pipe goes away with its server
  for (const p of socketPath.length > SUN_PATH_MAX ? [socketPath, socketPath.slice(0, SUN_PATH_MAX)] : [socketPath]) { try { fs.unlinkSync(p); } catch { /* absent */ } }
}
export function isSocketAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  // Note: no existsSync check — macOS silently truncates sun_path (>104 bytes) so the file may not be where we think.
  return new Promise((resolve) => {
    const s = net.createConnection(ipcAddress(socketPath));
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

/**
 * `runtime` lets a test serve a Runtime it already owns. Its `socketPath` MUST be the path we listen on: every pane
 * it spawns is handed that path as KORA_SOCKET_PATH, and a pane whose hooks dial a socket this runtime does not
 * answer gets "no such pane" on prelaunch — the agent then starts unregistered and can lose its prompt.
 */
export async function createServer(opts: { socketPath?: string; restore?: boolean; sweep?: boolean; runtime?: Runtime } = {}): Promise<ServerHandle> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  privateDir(koraHome(), true);
  try { ensureControlToken(koraHome()); } catch (e) { log('control token unavailable: privileged socket calls will be refused', e); }
  privateDir(path.dirname(socketPath), path.resolve(path.dirname(socketPath)) === path.resolve(koraHome()));
  // The graph store holds source excerpts of every repo indexed. The engine creates its folder 0700, but only when IT
  // creates it: stores made before that (and kora-runtime.sh's `mkdir -p`) are 0755. Tighten the dedicated store folder
  // (`.koragraph` / `<KORA_HOME>/koragraph`), never a shared parent a custom KORAGRAPH_DB points into.
  { const dir = graphStoreDir(); if (/^\.?koragraph$/.test(path.basename(dir))) { try { privateDir(dir, true); } catch { /* best effort */ } } }
  if (await isSocketAlive(socketPath)) throw new Error(`a kora server is already listening on ${socketPath}`);
  unlinkSocket(socketPath);

  const runtime = opts.runtime ?? new Runtime(socketPath);
  if (runtime.socketPath !== socketPath) {
    throw new Error(`runtime.socketPath (${runtime.socketPath}) must equal the served socket (${socketPath}); its panes would dial a socket nobody answers`);
  }
  const conns = new Set<Conn>(); let nextConn = 1;
  let resolveClosed!: () => void; const closed = new Promise<void>((r) => (resolveClosed = r));

  // The chat (structured) lane: a SessionManager fed by the same runtime + notify emitter as the mux
  // lane. Chat events flow through runtime.notify('chat.event', …) and are gated per-connection below.
  // One Blobs root for the daemon, the ui-server bundle and every child it spawns (the flavor's own folder, never the
  // stable app's ~/Blobs for Kora Dev): derive it from the home once and export it.
  process.env.KORA_BLOBS_ROOT = blobsRoot();
  const blobs = makeBlobRuntime(runtime);
  const stopBlobsMaintenance = blobs.startMaintenance();
  const engines = new Engines({ log: (m) => log(m), opencodePath: { get: () => loadConfig().swarm.opencodePath ?? null, set: (p) => { try { saveConfig({ swarm: { opencodePath: p } } as never); invalidateConfig(); } catch (e) { log('engines: could not save the OpenCode path', e); } } } });
  // Blob browsers a crashed daemon left behind (only pids this install recorded whose command line still names the headless shell + that blob's profile)
  void blobs.browsers.sweepOrphans().then((r) => { if (r.killed.length) log(`blobs: swept ${r.killed.length} orphaned blob browser(s)`); }).catch((e) => log('blobs: browser sweep failed', e?.message ?? e));
  const managerRuntime: ManagerRuntime = {
    notify: (m, p) => runtime.emit('notify', m, p),
    graph: {
      callTool: (n, a, o) => runtime.graph.callTool(n, a, o),
      status: (cwd) => runtime.graph.status(cwd),
      ensureFresh: (cwd) => runtime.ensureChatGraphFresh(cwd),
      // bug-report localization runs in the graph worker thread, never on this event loop
      ...(runtime.graph.bugLocalize ? { bugLocalize: (prompt: string, root: string, generation: string) => runtime.graph.bugLocalize!(prompt, root, generation) } : {}),
    },
    // A chat orchestrator's workers are panes of THIS runtime, kept in the ephemeral "chat" workspace (not the TUI's
    // active one, and never re-spawned by restore — they belong to their thread).
    agentSpawn: (p) => runtime.agentSpawn({ agent: p.agent, cwd: p.cwd, prompt: p.prompt, worktree: p.worktree, orchestratorId: p.orchestratorId, args: p.args, name: p.name, workspaceId: runtime.chatWorkspaceId(), ...(p.account != null ? { account: p.account } : {}) }),
    fleet: makeFleetOps(runtime),
    // Every chat session gets the pane preparation (rulebook, hooks, KORA_* env → this socket, strict MCP).
    prepareChat: (p) => runtime.prepareChatSession(p),
    // A Codex orchestrator's fleet tools run out of process (`kora mcp --fleet`) and dial this socket.
    socketPath: runtime.socketPath,
    binPath: runtime.binPath,
    // Swarm workers (fleet tools' `swarm` alias) + cleanup when a thread leaves swarm for chat or is deleted.
    swarm: runtime.swarm,
    // Blobs: persistent coworker agents (prompts, memory recall, self tools, skills) + OpenCode as a chat engine.
    blobs,
    opencode: makeOpencodeDeps(runtime),
    // Phase 7: ACP agents, API endpoints, Claude accounts (Settings > Engines)
    engines,
  };
  // KORA_QA_STUB_ENGINE=1 (the QA stacks only): the Claude lane answers from a canned stand-in, never a model.
  const qaStub = process.env.KORA_QA_STUB_ENGINE === '1' ? (require('../session/qa-stub-query') as typeof import('../session/qa-stub-query')).qaStubQuery : null;
  const sessions = new SessionManager(managerRuntime, new ChatThreadStore(), qaStub ? { queryFn: qaStub } : {});
  // A chat lead's Claude / Codex / Antigravity / ACP workers run on these same engines as GUI worker boxes
  // (server/driver-pane.ts, docs/fleet/WORKER-BOXES.md); KORA_GUI_WORKERS=off keeps every worker a PTY pane.
  runtime.setDriverHost((require('../session/worker-host') as typeof import('../session/worker-host')).sessionWorkerHost(sessions, { isAcp: (a) => !!engines?.acpEngine(a) }));
  // Swarm readiness (install progress included) → socket notification `swarm.status`. `swarm.worker` needs nothing
  // here: SwarmService emits it through runtime 'notify' like every other notification.
  let offSwarmStatus: () => void = () => {};
  // The providers' live free-model lists, now and every 15 min (the picker must not spawn a stale catalog id).
  try { runtime.swarmSetup.startAutoRefresh(); } catch { /* advisory */ }
  try { offSwarmStatus = runtime.swarmSetup.onStatus((status) => runtime.emit('notify', 'swarm.status', status)); }
  catch (e) { log('swarm status notifications unavailable', e); }

  /** Is pane `id` the caller itself or one of its workers? */
  const inFleet = (id: unknown, caller: string): boolean => {
    if (typeof id !== 'string' || !id) return false;
    return id === caller || runtime.panes.get(id)?.orchestratorId === caller;
  };
  /**
   * May a token-less subscriber scoped to `caller` see this notification (2026-10-15 audit #3)? It concerns a pane of
   * its fleet, or names its orchestrator id; chat frames are filtered by thread below; anything else (the workspace list,
   * notices about no pane) only the user sees.
   */
  const visibleTo = (caller: string | undefined, method: string, params: any): boolean => {
    if (method === 'chat.event' || method === 'swarm.status' || method === 'server.shutdown') return true;
    if (!caller || !params || typeof params !== 'object') return false;
    if (typeof params.paneId === 'string') return inFleet(params.paneId, caller);
    if ((method === 'pane.created' || method === 'pane.updated') && typeof params.id === 'string') return params.id === caller || params.orchestratorId === caller;
    if (typeof params.orchestratorId === 'string') return params.orchestratorId === caller;
    return false;
  };

  runtime.on('notify', (method: string, params: any) => {
    const frame = notification(method, params);
    for (const c of conns) {
      if (!c.subscribed) continue;
      if (!c.control && !visibleTo(c.scope, method, params)) continue;
      if (method === 'pane.output') {
        if (!c.paneOutput) continue;
        if (c.paneIds && !c.paneIds.has(params.paneId)) continue;
        // Without the control token a subscriber sees only panes that run a guarded agent, never a shell (control-auth.ts).
        if (!c.control && !GUARDED_AGENTS.has(String(runtime.panes.get(params.paneId)?.agent ?? ''))) continue;
        if (c.sock.writableLength > MAX_WRITABLE) continue; // backpressure: drop output frames
      }
      if (method === 'chat.event') {
        // Per-connection filter, mirroring pane.output. Unlike pane.output, chat.event is NEVER
        // dropped under backpressure — each frame carries a gap-free seq the client backfills from.
        if (!c.chatThreadIds || !c.chatThreadIds.has(params.threadId)) continue;
      }
      c.sock.write(frame);
    }
  });

  const server = net.createServer((sock) => {
    if (conns.size >= MAX_CONNECTIONS) { log(`socket: ${conns.size} connections open, refusing another`); sock.destroy(); return; }
    const conn: Conn = { sock, lines: new LineBuffer(), subscribed: false, paneOutput: false, paneIds: null, chatThreadIds: null, id: nextConn++ };
    conns.add(conn);
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = conn.lines.push(chunk); } catch (e: any) { sock.write(encode(errorResponse(null, e.code ?? ERR_INTERNAL, e.message))); return; }
      for (const line of lines) handleLine(conn, line);
    });
    sock.on('error', (e) => log(`conn ${conn.id}: ${e.message}`));
    sock.on('close', () => {
      conns.delete(conn);
      // release any panes this connection owned the size of, so a dead frontend can't lock geometry
      for (const pane of runtime.panes.values()) if (pane.sizeOwnerConnId === String(conn.id)) pane.sizeOwnerConnId = null;
    });
  });

  /** Worker picks the user approved through `chat.workers.ask`, per chat orchestrator: one per token-less agent.spawn. */
  const socketPicks = new Map<string, ApprovedPicks>();

  /** Every folder a token-less caller works in: its own pane's / chat thread's and its workers' checkouts, worktrees and repo roots. */
  function callerRoots(caller: string): string[] {
    const roots = new Set<string>();
    const addPane = (x: { cwd: string; worktree?: { path: string; mainRoot: string } | null; graph: { repoRoot?: string | null } }) => {
      roots.add(x.cwd); if (x.worktree) { roots.add(x.worktree.path); roots.add(x.worktree.mainRoot); } if (x.graph.repoRoot) roots.add(x.graph.repoRoot);
    };
    for (const x of runtime.panes.values()) if (x.id === caller || x.orchestratorId === caller) addPane(x);
    if (caller.startsWith('chat:')) {
      try {
        const cwd = sessions.get(caller.slice(5)).cwd; roots.add(cwd);
        try { const r = runtime.graph.repoRoot(cwd); if (r) roots.add(r); } catch { /* not a repo */ }
      } catch { /* no such thread */ }
    }
    return [...roots].filter(Boolean);
  }
  /** The pane (live, or a finished swarm task) whose own worktree is at `dir`. */
  function worktreeOwner(dir: string): { paneId: string; orchestratorId?: string | null } | undefined {
    for (const x of runtime.panes.values()) if (x.worktree && insideRoots(dir, [x.worktree.path]) && insideRoots(x.worktree.path, [dir])) return { paneId: x.id, orchestratorId: x.orchestratorId };
    return undefined;
  }

  /**
   * Why this call is refused (control-auth.ts), or null: privileged methods need the token, open ones are vetted without
   * it. `ctx` gets who is calling: the user (token) or a VERIFIED caller; a `caller` sent without its key is dropped.
   */
  function refusal(method: string, params: unknown, env: { auth?: string; caller?: string; callerKey?: string }, ctx: CallCtx): string | null {
    if (hasControl(env.auth, koraHome())) { ctx.control = true; return null; }
    ctx.control = false; ctx.caller = verifiedCaller(env.caller, env.callerKey, koraHome());
    if (env.caller && !ctx.caller) ctx.unproven = env.caller;
    if (PRIVILEGED_METHODS.has(method)) return CONTROL_DENIED_MESSAGE;
    const why = vetUncontrolledCall(method, params, {
      paneAgent: (pid) => runtime.panes.get(pid)?.agent, caller: ctx.caller,
      paneFacts: (pid) => { const x = runtime.panes.get(pid); return x ? { agent: x.agent, role: x.role, orchestratorId: x.orchestratorId } : undefined; }, modeOf: (orch) => orchestratorRuntimeMode(orch, koraHome()),
      takeSpawnApproval: (orch, agent) => !!socketPicks.get(orch)?.take(agent),
      worktreeOwner,
      finishedOwner: (pid) => (runtime.swarm?.finishedWorktree(pid) ? runtime.swarm.taskForPane(pid)?.orchestratorId ?? '' : undefined),
      callerRoots,
    });
    return why && ctx.unproven ? `${why}. ${staleCallerHint(ctx.unproven)}` : why;
  }

  function handleLine(conn: Conn, line: string) {
    const parsed = parseMessage(line);
    if (parsed.kind === 'error') { conn.sock.write(encode(parsed.resp)); return; }
    if (parsed.kind === 'notification') {
      const ctx: CallCtx = { control: false };
      const why = refusal(parsed.note.method, parsed.note.params, parsed.note, ctx);
      if (why) { log(`notification ${parsed.note.method}: refused (${why})`); return; }
      dispatch(conn, parsed.note.method, parsed.note.params, ctx).catch((e) => log(`notification ${parsed.note.method}: ${e?.message}`)); return;
    }
    const { id, method, params } = parsed.req;
    const ctx: CallCtx = { control: false };
    const why = refusal(method, params, parsed.req, ctx);
    if (why) { log(`rpc ${method}: refused (${why})`); conn.sock.write(encode(errorResponse(id, CONTROL_DENIED_CODE, why === CONTROL_DENIED_MESSAGE ? why : `${why}. ${CONTROL_DENIED_MESSAGE}`))); return; }
    const rpcDone = noteRpc(method);
    dispatch(conn, method, params, ctx).finally(rpcDone).then(
      (result) => { if (!conn.sock.destroyed) conn.sock.write(encode(resultResponse(id, result))); },
      (e: any) => {
        const code = e instanceof RpcError ? e.code : ERR_INTERNAL;
        if (!(e instanceof RpcError)) log(`rpc ${method} failed:`, e?.stack || e);
        if (!conn.sock.destroyed) conn.sock.write(encode(errorResponse(id, code, e?.message || String(e), e?.data)));
      },
    );
  }

  const need = (p: any, key: string): any => { if (p == null || p[key] === undefined || p[key] === null || p[key] === '') throw new RpcError(ERR_INVALID_PARAMS, `missing param: ${key}`); return p[key]; };

  // The chat (structured) lane RPC surface — additive; delegates to the SessionManager. Kept in its
  // own dispatcher so the mux switch below stays typed against MethodName and byte-for-byte unchanged.

  // Thread-scoped graph query → render-ready GraphView (reuses the inline-card layout so the Graph
  // pane and the conversation GraphCards draw identically). Advisory: any failure yields an empty view.
  async function chatGraph(cwd: string, op: 'explore' | 'neighbours' | 'blast_radius', tool: string, args: Record<string, unknown>): Promise<{ view: unknown; text: string; ms: number }> {
    const r = (await runtime.graph.callTool(tool as never, args, { cwd })) as GraphToolResult;
    runtime.reportGraphUse(null, tool, r.ms ?? 0, 'cli');
    return { view: layoutNeighborhood(extractNeighborhood(op, r)), text: String(r.text ?? ''), ms: r.ms ?? 0 };
  }

  async function dispatchChat(conn: Conn, method: string, p: any): Promise<unknown> {
    assertThreadIdParams(p);
    switch (method) {
      case 'chat.thread.list': return { threads: sessions.list(!!p.includeArchived) };
      case 'chat.thread.create': return sessions.create({ agent: need(p, 'agent'), cwd: String(need(p, 'cwd')), account: p.account ?? null, model: p.model, isOrchestrator: !!p.isOrchestrator, ...(p.agentMode ? { agentMode: p.agentMode } : {}), title: p.title, worktree: p.isolation === 'worktree' ? '' : null });
      case 'chat.thread.get': return sessions.get(String(need(p, 'threadId')));
      case 'chat.thread.rename': sessions.rename(String(need(p, 'threadId')), String(need(p, 'title'))); return { ok: true };
      case 'chat.thread.setAgentMode': {
        const agentMode = need(p, 'agentMode') as ThreadAgentMode;
        if (!(['chat', 'orchestrator', 'swarm'] as const).includes(agentMode)) throw new RpcError(ERR_INVALID_PARAMS, `agentMode must be chat|orchestrator|swarm, got ${String(agentMode)}`);
        return await sessions.setAgentMode(String(need(p, 'threadId')), agentMode);
      }
      case 'chat.thread.archive': sessions.archive(String(need(p, 'threadId'))); return { ok: true };
      case 'chat.thread.unarchive': sessions.unarchive(String(need(p, 'threadId'))); return { ok: true };
      case 'chat.thread.delete': await sessions.delete(String(need(p, 'threadId'))); return { ok: true };
      case 'chat.diff': { const meta = sessions.get(String(need(p, 'threadId'))); return await computeWorkingDiff(meta.cwd); }

      // ── graph (the kora signature) — thread-scoped koragraph queries ──
      case 'chat.graph.explore': { const meta = sessions.get(String(need(p, 'threadId'))); return await chatGraph(meta.cwd, 'explore', 'explore', { query: String(need(p, 'query')), detail: 'full' }); }
      case 'chat.graph.neighbours': { const meta = sessions.get(String(need(p, 'threadId'))); return await chatGraph(meta.cwd, 'neighbours', 'neighbours', { symbol: String(need(p, 'symbol')), file: p.file, direction: p.direction ?? 'both' }); }
      case 'chat.graph.blastRadius': {
        const meta = sessions.get(String(need(p, 'threadId')));
        const files: string[] | undefined = Array.isArray(p.files) ? p.files.map(String) : undefined;
        const args = p.symbol ? { symbol: String(p.symbol) } : { files_changed: files ?? [] };
        const r = (await runtime.graph.callTool('blast_radius' as never, args, { cwd: meta.cwd })) as GraphToolResult;
        runtime.reportGraphUse(null, 'blast_radius', r.ms ?? 0, 'cli');
        const view = layoutNeighborhood(extractNeighborhood('blast_radius', r));
        const callers = view.nodes.filter((n) => n.id !== view.focusId).length;
        const fileCount = new Set(view.nodes.map((n) => n.file).filter(Boolean)).size;
        const hazards = view.nodes.filter((n) => n.hazard).length;
        const subject = String(p.symbol ?? (files && files.length === 1 ? files[0] : `${files?.length ?? 0} files`));
        return { subject, callers, files: fileCount, hazards, view };
      }
      case 'chat.graph.overview': { const meta = sessions.get(String(need(p, 'threadId'))); const r = (await runtime.graph.callTool('overview' as never, {}, { cwd: meta.cwd })) as GraphToolResult; return { text: String(r.text ?? '') }; }

      case 'chat.session.start': return sessions.start(String(need(p, 'threadId')));
      case 'chat.session.stop': await sessions.stop(String(need(p, 'threadId'))); return { ok: true };
      case 'chat.session.setModel': await sessions.setModel(String(need(p, 'threadId')), need(p, 'model')); return { ok: true };
      case 'chat.session.setPermissionMode': sessions.setPermissionMode(String(need(p, 'threadId')), need(p, 'mode')); return { ok: true };

      case 'chat.turn.send': return sessions.sendTurn({ threadId: String(need(p, 'threadId')), text: p.text, attachments: p.attachments, model: p.model, interactionMode: p.interactionMode, continuation: p.continuation });
      case 'chat.turn.interrupt': await sessions.interrupt(String(need(p, 'threadId')), p.turnId); return { ok: true };

      case 'chat.approval.respond': await sessions.respondApproval(String(need(p, 'threadId')), String(need(p, 'requestId')), need(p, 'decision')); return { ok: true };
      case 'worker.asleep': { const o = makeFleetOps(runtime); return { workers: o.asleep!(String(need(p, 'orchestratorId'))) }; }
      case 'worker.wake': return await makeFleetOps(runtime).wake!(String(need(p, 'orchestratorId')), String(need(p, 'id')));
      case 'worker.history': return { text: makeFleetOps(runtime).history!(String(need(p, 'orchestratorId')), String(need(p, 'id')), typeof p.maxEntries === 'number' ? p.maxEntries : undefined) };
      case 'chat.workers.ask': {
        const orch = String(need(p, 'orchestratorId'));
        if (!orch.startsWith('chat:')) throw new RpcError(ERR_INVALID_PARAMS, `chat.workers.ask needs a chat orchestrator id, got ${orch}`);
        // A thread that does not exist would auto-approve (askWorkers' no-meta path): over the socket it is an error, or
        // any agent could mint approved picks for a made-up fleet.
        if (!sessions.store.has(orch.slice(5))) throw new RpcError(ERR_INVALID_PARAMS, `no chat thread ${orch.slice(5)}`);
        const answer = await sessions.askWorkers(orch.slice(5), Array.isArray(p.picks) ? p.picks : []);
        // What the user approved for a lead whose fleet tools run outside the daemon (a Codex lead's `kora mcp --fleet`):
        // its token-less agent.spawn calls each use one up (vetUncontrolledCall).
        if (!answer.cancelled && answer.picks.length) {
          let ledger = socketPicks.get(orch);
          if (!ledger) { ledger = new ApprovedPicks(); socketPicks.set(orch, ledger); }
          ledger.add(answer.picks);
        }
        return answer;
      }
      case 'chat.userInput.respond': await sessions.respondUserInput(String(need(p, 'threadId')), String(need(p, 'requestId')), need(p, 'answers')); return { ok: true };

      case 'chat.events.subscribe': {
        conn.subscribed = true;
        const ids: string[] = Array.isArray(p.threadIds) ? p.threadIds.map(String) : [];
        conn.chatThreadIds = new Set([...(conn.chatThreadIds ?? []), ...ids]);
        // replaySince: backfill the gap for each thread the client already had a cursor for (§5).
        const since: Record<string, number> = p.replaySince ?? {};
        for (const id of ids) {
          const from = since[id] ?? 0;
          if (!sessions.store.has(id)) continue;
          for (const ev of sessions.backfill(id, from).events) conn.sock.write(notification('chat.event', ev));
        }
        return { ok: true };
      }
      case 'chat.events.unsubscribe': {
        const ids: string[] | undefined = Array.isArray(p.threadIds) ? p.threadIds.map(String) : undefined;
        if (!ids || conn.chatThreadIds == null) conn.chatThreadIds = null;
        else { for (const id of ids) conn.chatThreadIds.delete(id); if (conn.chatThreadIds.size === 0) conn.chatThreadIds = null; }
        return { ok: true };
      }
      case 'chat.events.backfill': return sessions.backfill(String(need(p, 'threadId')), p.sinceSeq != null ? Number(p.sinceSeq) : 0, p.limit != null ? Number(p.limit) : undefined);
    }
    throw new RpcError(ERR_METHOD_NOT_FOUND, `unknown method: ${method}`);
  }

  async function dispatch(conn: Conn, method: string, rawParams: unknown, ctx: CallCtx): Promise<unknown> {
    noteWatchdogLabel(`RPC ${method}`);
    const p: any = rawParams ?? {};
    if (method.startsWith('chat.')) return dispatchChat(conn, method, p);
    switch (method as MethodName) {
      case 'server.ping': return { ok: true, version, pid: process.pid, uptimeMs: Date.now() - runtime.startedAt };
      case 'server.status': {
        const db = (require('../graph/embedded') as typeof import('../graph/embedded')).graphDbPath(); // KORAGRAPH_DB, else KORAGRAPH_HOME, else ~/.koragraph
        const roots = new Set([...runtime.panes.values()].map((x) => x.graph.repoRoot).filter(Boolean));
        return { version, panes: runtime.panes.size, workspaces: runtime.workspaces.size, socket: socketPath, ui: handle.ui ? { port: handle.ui.port, url: `http://127.0.0.1:${handle.ui.port}` } : null, ...(handle.uiError ? { uiError: handle.uiError } : {}), graph: { db, repos: roots.size }, memory: daemonMemory() };
      }
      case 'server.shutdown': setTimeout(() => handle.close().catch(() => {}), 20); return { ok: true };

      // Without the token: the caller and its own workers only (2026-10-15 audit #2: the full list handed out every
      // pane's id, orchestrator, argv and folder, i.e. everything needed to aim at another fleet).
      case 'pane.list': if (ctx.unproven) throw staleCallerError(method, ctx.unproven); return { panes: runtime.listPanes(p.workspaceId).filter((x) => ctx.control || (!!ctx.caller && inFleet(x.id, ctx.caller))) };
      case 'pane.get': return runtime.requirePane(need(p, 'paneId')).info();
      case 'pane.spawn': return runtime.spawnPane(p);
      case 'pane.kill': runtime.killPane(need(p, 'paneId'), p.signal); return { ok: true };
      case 'pane.write': {
        // A raw pane.write over the socket is HUMAN-origin (a frontend's keystrokes). humanWrite delivers the bytes
        // and, for a worker pane, detects an unsolicited steer and notifies its orchestrator. Orchestrator-origin
        // input goes through agent.prompt/agent.spawn (in-process Runtime.prompt), which never emits a steer.
        const paneId = String(need(p, 'paneId'));
        runtime.requirePane(paneId);
        if (typeof p.base64 === 'string') runtime.humanWrite(paneId, Buffer.from(p.base64, 'base64'));
        else if (typeof p.text === 'string') runtime.humanWrite(paneId, p.text);
        else throw new RpcError(ERR_INVALID_PARAMS, 'text or base64 required');
        return { ok: true };
      }
      case 'pane.resize': {
        const pane = runtime.requirePane(need(p, 'paneId'));
        // multi-frontend size ownership: only the owning connection (last to pane.focus) may resize.
        // A different frontend viewing the same pane fits-to-view locally instead of fighting over cols/rows.
        if (pane.sizeOwnerConnId != null && pane.sizeOwnerConnId !== String(conn.id)) return { ok: true };
        pane.resize(Number(need(p, 'cols')), Number(need(p, 'rows')));
        return { ok: true };
      }
      // 'report' reads the agent's transcript instead of the screen — the only way to get back what a
      // TUI agent printed before the current viewport (alt-screen panes keep no scrollback).
      case 'pane.read': return p.source === 'report'
        ? { text: runtime.report(need(p, 'paneId'), p.turns != null ? Number(p.turns) : 1) }
        : { text: runtime.requirePane(need(p, 'paneId')).read(p.source, p.format, p.lines != null ? Number(p.lines) : undefined) };
      case 'pane.snapshot': return runtime.requirePane(need(p, 'paneId')).snapshot();
      case 'pane.focus': { const pane = runtime.requirePane(need(p, 'paneId')); pane.sizeOwnerConnId = String(conn.id); runtime.focusPane(pane.id); return { ok: true }; }
      case 'pane.rename': runtime.renamePane(need(p, 'paneId'), String(need(p, 'name'))); return { ok: true };
      case 'pane.reportAgentSession': runtime.reportAgentSession(need(p, 'paneId'), p.agent, String(need(p, 'agentSessionId')), p.transcriptPath); return { ok: true };
      case 'pane.feed': { runtime.pushPluginFeed(String(need(p, 'paneId')), Array.isArray(p.items) ? p.items : []); return { ok: true }; }
      case 'pane.reportState': { const st = p.state === 'idle' ? 'idle' : 'working'; runtime.reportState(need(p, 'paneId'), st); return { ok: true }; }
      case 'pane.restart': {
        if (p.mode != null && !['resume', 'cheap', 'fresh'].includes(p.mode)) throw new RpcError(ERR_INVALID_PARAMS, `mode must be resume|cheap|fresh, got ${p.mode}`);
        return runtime.restartPane(need(p, 'paneId'), p.mode);
      }
      case 'pane.compact': return runtime.compactPane(need(p, 'paneId'));
      case 'pane.prelaunch': return runtime.prelaunch(need(p, 'paneId'), p.agent || 'claude', String(need(p, 'cwd')));
      case 'pane.index': return runtime.indexPane(need(p, 'paneId'));
      case 'config.get': return { config: loadConfig() as any, path: configPath() };
      case 'config.set': {
        const patch = need(p, 'patch'); if (typeof patch !== 'object' || Array.isArray(patch)) throw new RpcError(ERR_INVALID_PARAMS, 'patch must be an object');
        const cfg = saveConfig(patch); invalidateConfig(); log(`config.set ${JSON.stringify(patch)}`);
        return { config: cfg as any };
      }
      case 'worktree.list': { if (ctx.unproven) throw staleCallerError(method, ctx.unproven); const r = runtime.worktreeList(p.cwd); return ctx.control ? r : { worktrees: r.worktrees.filter((w: { paneId: string | null }) => !!ctx.caller && inFleet(w.paneId, ctx.caller)) }; }
      case 'worktree.merge': return runtime.worktreeMerge(p);
      case 'worktree.remove': return runtime.worktreeRemove(p);
      case 'worktree.sweep': return await runtime.worktreeSweep({ dryRun: !!p.dryRun });
      case 'ledger.get': {
        const id = need(p, 'paneId'); const summary = runtime.ledger.refresh(id) ?? runtime.ledger.get(id);
        return { summary };
      }
      case 'ledger.summary': {
        for (const { paneId } of runtime.ledger.all()) runtime.ledger.refresh(paneId);
        if (ctx.control) return { panes: runtime.ledger.all(), totals: runtime.ledger.totals() };
        if (ctx.unproven) throw staleCallerError(method, ctx.unproven);
        const panes = runtime.ledger.all().filter((x) => !!ctx.caller && inFleet(x.paneId, ctx.caller));
        const totals = { costUsd: 0, cacheSavedUsd: 0, context: 0, graphCalls: 0, reads: 0, greps: 0 };
        for (const { summary: x } of panes) { totals.costUsd += x.costUsd; totals.cacheSavedUsd += x.cacheSavedUsd; totals.context += x.context; totals.graphCalls += x.graphCalls; totals.reads += x.reads; totals.greps += x.greps; }
        return { panes, totals };
      }
      case 'pane.reportGraphUse': runtime.reportGraphUse(need(p, 'paneId'), String(need(p, 'tool')), p.ms != null ? Number(p.ms) : 0, p.channel || 'cli'); return { ok: true };

      case 'agent.list': if (ctx.unproven) throw staleCallerError(method, ctx.unproven); return { agents: runtime.listAgents().filter((x) => ctx.control || (!!ctx.caller && inFleet(x.id, ctx.caller))) };
      case 'agent.spawn': return runtime.agentSpawn({ ...p, agent: need(p, 'agent') });
      case 'agent.prompt': {
        // A chat lead drives its workers in-process, never over this socket: a `kora agent prompt` aimed at one of its
        // workers is the person (or a script) steering out of band. Tell the lead and the UI like a typed steer (QA 2026-10-10:
        // the lead reported such steering as unrequested behaviour).
        const target = runtime.panes.get(String(p.paneId ?? ''));
        const text = String(p.text ?? '').replace(/\s+/g, ' ').trim();
        if (target && target.role === 'worker' && target.orchestratorId?.startsWith('chat:') && text.length >= 3) {
          target.steeredAt = Date.now();
          runtime.notify('pane.steered', { paneId: target.id, orchestratorId: target.orchestratorId, origin: 'human', text, state: target.state });
        }
        return runtime.prompt(need(p, 'paneId'), String(need(p, 'text')), p.submit !== false, p.waitIdle !== false, p.timeoutMs != null ? Number(p.timeoutMs) : 60_000);
      }
      case 'agent.wait': return runtime.wait(need(p, 'paneId'), p.until ?? 'needs-human', p.timeoutMs != null ? Number(p.timeoutMs) : 0, Boolean(p.afterChange));
      case 'agent.status': { const pane = runtime.requirePane(need(p, 'paneId')); return { state: pane.state, blocker: pane.blocker, agent: pane.agent }; }
      case 'agent.promote': { runtime.requirePane(need(p, 'paneId')); return runtime.promote(String(p.paneId), p.briefing); }
      case 'agent.assign': { runtime.requirePane(need(p, 'paneId')); return runtime.assign(String(p.paneId), String(need(p, 'prompt'))); }
      case 'worktree.mergeVerify': return runtime.mergeVerify({ paneIds: p.paneIds, worktreePaths: p.worktreePaths });
      case 'merge.verify': return runtime.mergeVerifyRefs({ cwd: String(need(p, 'cwd')), refs: (p.refs as string[]) || [], baseRef: p.baseRef, targetRef: p.targetRef });
      case 'fleet.get': return runtime.fleetGet(String(need(p, 'orchestratorId')));
      case 'fleet.set': return runtime.fleetSet(String(need(p, 'orchestratorId')), { plan: p.plan });
      case 'fleet.drainNotes': return { notes: runtime.fleetDrainNotes(String(need(p, 'orchestratorId'))) };

      // ---- swarm (the socket keeps only these; the ui-server calls SwarmSetup in-process) ----
      case 'swarm.getStatus': return runtime.swarmSetup.getStatus(p.probe != null ? { probe: !!p.probe } : {});
      case 'swarm.spawn': {
        const orchestratorId = String(need(p, 'orchestratorId'));
        return runtime.swarm.spawn({ orchestratorId, cwd: String(need(p, 'cwd')), task: String(need(p, 'task')), ...(p.title ? { title: String(p.title) } : {}), ...(p.runtimeMode ? { runtimeMode: p.runtimeMode as any } : {}), ...(p.permission ? { permission: String(p.permission) as any } : {}), ...(p.check ? { check: String(p.check) } : {}), ...(p.queue ? { queue: true } : {}) });
      }
      // ---- blobs: the MCP bridge (`kora mcp --blobs`) for Codex / OpenCode blob sessions; bearer token per session ----
      case 'blobs.mcp.hello': case 'blobs.mcp.call': case 'blobs.outside.hello': case 'blobs.outside.call':
        // Kora is coming soon (edition.ts): the blob MCP bridge and outside access refuse before any token is looked at.
        if (!isKoraSurfaceOn()) throw new RpcError(ERR_INVALID_PARAMS, KORA_COMING_SOON_MESSAGE);
        switch (method) {
          case 'blobs.mcp.hello': return blobs.hub.hello({ blobId: String(need(p, 'blobId')), token: String(need(p, 'token')) });
          case 'blobs.mcp.call': return blobs.hub.call({ blobId: String(need(p, 'blobId')), token: String(need(p, 'token')), name: String(need(p, 'name')), args: (p.args && typeof p.args === 'object' ? p.args : {}) as Record<string, unknown> });
          // ---- outside access (`kora mcp --team`): token-gated inside the service (bad / revoked token -> a refusal + an audit row) ----
          case 'blobs.outside.hello': return blobs.outside.hello({ token: String(need(p, 'token')) });
          default: return blobs.outside.call({ token: String(need(p, 'token')), tool: String(need(p, 'tool')), args: p.args, ...(p.clientInfo && typeof p.clientInfo === 'object' ? { clientInfo: p.clientInfo as { name?: string; version?: string } } : {}) });
        }
      case 'swarm.task': {
        const paneId = String(need(p, 'paneId'));
        return {
          task: runtime.swarm.taskForPane(paneId), note: runtime.swarm.note(paneId), lostInRestart: runtime.swarm.lostInRestart(paneId),
          report: p.report === false ? null : await runtime.swarm.readReport(paneId).catch(() => null),
        };
      }
      case 'swarm.finished': return { tasks: runtime.swarm.finishedTasks(String(need(p, 'orchestratorId'))) };
      case 'swarm.queued': return { tasks: runtime.swarm.queuedTasks(String(need(p, 'orchestratorId'))) };
      case 'swarm.reportEvent': {
        const paneId = String(need(p, 'paneId')); const type = need(p, 'type');
        if (!['session.status', 'session.idle', 'session.error'].includes(type)) throw new RpcError(ERR_INVALID_PARAMS, `unknown swarm event type: ${String(type)}`);
        runtime.swarm.reportEvent({ ...(p as SwarmPaneEvent), paneId, type });
        return { ok: true };
      }

      case 'graph.tool': {
        const name = String(need(p, 'name'));
        if (!(GRAPH_TOOLS as readonly string[]).includes(name)) throw new RpcError(ERR_INVALID_PARAMS, `unknown graph tool: ${name}`);
        const cwd = p.cwd || (p.paneId ? runtime.panes.get(p.paneId)?.cwd : undefined) || process.cwd();
        const r = await runtime.graph.callTool(name as any, p.args ?? {}, { cwd, fresh: p.fresh !== false });
        runtime.reportGraphUse(p.paneId ?? null, name, r.ms, p.channel || 'cli');
        return r;
      }
      case 'graph.status': return runtime.graph.status(p.cwd || process.cwd());
      // Always detached: an in-process ingest here would run the whole parse on the daemon's event loop.
      case 'graph.ingest': return runtime.graph.ingest(String(need(p, 'path')), { project: p.project, wait: false, full: p.full, force: p.force === true });
      case 'graph.brief': return { text: await runtime.graph.brief(String(need(p, 'cwd')), p.agent) };

      case 'events.subscribe': {
        // Without the token (2026-10-15 audit #3): a verified caller, and only its own fleet's events (filtered per frame
        // in the notify loop, so a worker spawned later is included); named panes must be in that fleet too.
        const paneIds: string[] | null = Array.isArray(p.paneIds) ? p.paneIds.map(String) : null;
        if (!ctx.control) {
          if (ctx.unproven) throw staleCallerError('events.subscribe', ctx.unproven);
          if (!ctx.caller) throw new RpcError(CONTROL_DENIED_CODE, `events.subscribe: a call without the Kora control token must come from a Kora agent (KORA_PANE_ID + KORA_CALLER_KEY). ${CONTROL_DENIED_MESSAGE}`);
          const foreign = paneIds?.find((id) => runtime.panes.has(id) && !inFleet(id, ctx.caller!));
          if (foreign) throw new RpcError(CONTROL_DENIED_CODE, `events.subscribe: pane ${foreign} is not in your fleet. ${CONTROL_DENIED_MESSAGE}`);
        }
        conn.control = ctx.control; conn.scope = ctx.control ? undefined : ctx.caller;
        conn.subscribed = true; conn.paneOutput = !!p.paneOutput; conn.paneIds = paneIds ? new Set(paneIds) : null; return { ok: true };
      }
      case 'events.unsubscribe': conn.subscribed = false; conn.paneOutput = false; conn.paneIds = null; return { ok: true };
    }
    throw new RpcError(ERR_METHOD_NOT_FOUND, `unknown method: ${method}`);
  }

  // The socket drives agents (full-access included), so only this user may dial it: bind under umask 077 (no window
  // where it exists with the default mode), then chmod 0600 for good measure; the home dir is 0700 (privateDir).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const prevUmask = setUmask(0o177);
    try { server.listen(ipcAddress(socketPath), () => { server.off('error', reject); resolve(); }); }
    finally { if (prevUmask !== null) setUmask(prevUmask); }
  });
  if (!isWindows) { try { fs.chmodSync(socketPath, 0o600); } catch { /* ignore */ } }
  log(`server ${version} listening on ${socketPath} (pid ${process.pid})`);
  // Extensions: their keychain values into memory (launches stay synchronous), then Antigravity's own file in step.
  void (async () => {
    try {
      const ext = require('../extensions') as typeof import('../extensions');
      await ext.warmExtensionSecrets();
      ext.afterChange();
    } catch (e: any) { log(`extensions: start-up sync failed: ${e?.message ?? e}`); }
  })();

  let closing = false;
  let stopSweeps: (() => void) | null = null;
  const stopReaper = sessions.startIdleReaper(60_000, (m) => log(m));
  liveSessionCount = () => sessions.liveCount();
  const handle: ServerHandle = {
    socketPath, runtime, sessions, managerRuntime, closed, ui: null, blobs,
    async close() {
      if (closing) return closed; closing = true;
      log('server shutting down');
      const frame = notification('server.shutdown', {});
      for (const c of conns) { if (c.subscribed) { try { c.sock.write(frame); } catch { /* ignore */ } } }
      try { offSwarmStatus(); } catch { /* gone */ }
      stopSweeps?.();
      stopReaper();
      // No single step may hold the shutdown hostage (a browser that will not exit, a routine run, a session that never
      // settles): each gets a deadline, then the next step runs (live QA #4: a daemon that ignored SIGTERM).
      await withDeadline(sessions.shutdown(), STEP_DEADLINE_MS, 'chat sessions shutdown', log);
      stopBlobsMaintenance();
      await withDeadline(blobs.close(), STEP_DEADLINE_MS, 'blobs shutdown', log);
      runtime.shutdown();
      for (const c of conns) c.sock.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      unlinkSocket(socketPath);
      resolveClosed();
    },
  };
  // Before restore re-spawns anything: the previous daemon's panes, if it died without disposing them (crash, SIGKILL).
  try { await runtime.children.reapOrphans(); } catch (e) { log('orphan reap failed', e); }
  if (opts.restore !== false) {
    try { await runtime.restore(); } catch (e) { log('restore failed', e); }
    // Unfinished swarm tasks of the previous daemon: relaunched with a digest (finished ones stay finished). Not awaited:
    // it creates panes, and the socket must answer meanwhile.
    runtime.swarm.resumeAfterRestart({ restoredPaneIds: runtime.restoredPaneIds })
      .then((r) => { if (r.resumed.length || r.finished.length || r.dropped.length) log(`swarm: restart — resumed ${r.resumed.join(', ') || 'none'}; kept done ${r.finished.join(', ') || 'none'}; not resumed ${r.dropped.join(', ') || 'none'}`); })
      .catch((e) => log('swarm: resume after restart failed', e));
  }
  // Orphan sweep after restore (whatever the restore flag): a daemon killed mid-fleet must not leave stranded worktrees
  // behind, and a clean one costs nothing to drop. Off the startup path's critical section, best effort. The chat
  // threads' checkouts are where leftover merged agent branches accumulate, so they are swept too.
  const threadRepos = (): string[] => { try { return [...new Set(sessions.list(true).slice(0, 200).map((t) => t.cwd))]; } catch { return []; } };
  if (opts.sweep !== false) {
    // 1.5 s in (minAgeMs STARTUP_SWEEP_MIN_AGE_MS), then every 6 h for a daemon that runs for weeks. A worktree created
    // or reported into recently counts as busy: a spawn makes its worktree before its pane is live, and a finished
    // worker's report waits for its leader.
    stopSweeps = scheduleWorktreeSweeps((p) => runtime.worktreeSweep(p), threadRepos, { onError: (e) => log('worktree sweep failed', e) });
  }
  // Chat leads' CLI workers fall asleep after 10 min idle (process closed, folder removed, work kept on its branch).
  const stopSleeper = runtime.startWorkerSleeper();
  const prevClose = handle.close.bind(handle);
  handle.close = async () => { stopSleeper(); return prevClose(); };
  return handle;
}

/**
 * Thread ids name files and folders in the chat store (`<home>/chat/<id>…`): the store refuses a non-segment id
 * (`invalid thread id`), but that surfaced as an internal error with a stack in the log. Refuse it at the RPC boundary
 * instead, as a clean invalid-params error, for every chat method (`threadId`, `threadIds[]`, a `chat:<id>` orchestrator id).
 */
export function assertThreadIdParams(p: any): void {
  if (p == null || typeof p !== 'object') return;
  const bad = (v: unknown) => { throw new RpcError(ERR_INVALID_PARAMS, `invalid threadId: ${JSON.stringify(String(v)).slice(0, 80)}`); };
  const check = (v: unknown) => { if (typeof v !== 'string' || !isSafePathSegment(v)) bad(v); };
  if (p.threadId !== undefined && p.threadId !== null && p.threadId !== '') check(p.threadId);
  if (Array.isArray(p.threadIds)) for (const v of p.threadIds) check(v);
  if (typeof p.orchestratorId === 'string' && p.orchestratorId.startsWith('chat:')) check(p.orchestratorId.slice(5));
}

// Working-tree diff for the diff-review pane: `git diff` (unstaged) in the thread's cwd, parsed into
// files/hunks/lines. Includes untracked files (via --no-index against /dev/null) so newly-created files show.
export function computeWorkingDiff(cwd: string): Promise<unknown> {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('git', [...GIT_NO_FSMONITOR, '-C', cwd, 'diff', '--no-color', '--no-ext-diff', '--unified=3'], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: gitEnv() }, (_e: unknown, tracked: string) => {
      execFile('git', [...GIT_NO_FSMONITOR, '-C', cwd, 'ls-files', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: gitEnv() }, (_e2: unknown, untrackedList: string) => {
        const files = parseUnifiedDiff(tracked || '');
        const untracked = (untrackedList || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50);
        let pending = untracked.length;
        const done = (): void => resolve({ cwd, files });
        if (!pending) return done();
        for (const path of untracked) {
          // `--` before the paths: an untracked file named `--output=<f>` was otherwise parsed as an option (git opened
          // and truncated <f>). The file name comes from the working tree, i.e. from whatever cloned or generated it.
          // oxlint-disable-next-line kora/no-posix-only-paths -- git (Git for Windows too) takes /dev/null as the empty side of --no-index
          execFile('git', [...GIT_NO_FSMONITOR, '-C', cwd, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path], { maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, env: gitEnv() }, (_e3: unknown, out: string) => {
            for (const f of parseUnifiedDiff(out || '')) files.push(f);
            if (--pending === 0) done();
          });
        }
      });
    });
  });
}
export function parseUnifiedDiff(text: string): any[] {
  const files: any[] = [];
  let f: any = null; let h: any = null; let oldNo = 0; let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      f = { path: '', additions: 0, deletions: 0, hunks: [] as any[] }; files.push(f); h = null;
    } else if (line.startsWith('+++ ')) {
      // oxlint-disable-next-line kora/no-posix-only-paths -- git's diff output names the missing side /dev/null on every OS
      if (f) { const p = line.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') f.path = p; }
    } else if (line.startsWith('--- ')) {
      // oxlint-disable-next-line kora/no-posix-only-paths -- git's diff output names the missing side /dev/null on every OS
      if (f && !f.path) { const p = line.slice(4).replace(/^a\//, ''); if (p !== '/dev/null') f.path = p; }
    } else if (line.startsWith('Binary files')) {
      if (f) f.binary = true;
    } else if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0; newNo = m ? Number(m[2]) : 0;
      h = { header: line, lines: [] as any[] }; if (f) f.hunks.push(h);
    } else if (h && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) {
      const t = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
      const row: any = { type: t, text: line.slice(1) };
      if (t === 'del') { row.oldNo = oldNo++; } else if (t === 'add') { row.newNo = newNo++; } else { row.oldNo = oldNo++; row.newNo = newNo++; }
      h.lines.push(row);
      if (f) { if (t === 'add') f.additions++; else if (t === 'del') f.deletions++; }
    }
  }
  return files.filter((x) => x.path);
}

/** `process.umask(mask)`, or null where it cannot be set (worker threads). Returns the previous mask. */
function setUmask(mask: number): number | null {
  try { return process.umask(mask); } catch { return null; }
}

/**
 * Create `dir` 0700. `tighten`: also strip group/other bits from an existing dir we own — right for the kora home,
 * wrong for a shared parent a custom KORA_SOCKET_PATH may sit in (/tmp), which we only create, never chmod.
 */
export function privateDir(dir: string, tighten: boolean): void {
  let existed = true;
  try { fs.statSync(dir); } catch { existed = false; }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existed && !tighten) return;
  try {
    const st = fs.statSync(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    if (st.uid === uid && (st.mode & 0o077) !== 0) fs.chmodSync(dir, st.mode & 0o700);
  } catch { /* best effort */ }
}

/**
 * Event-loop stall detector. The chat UI's websocket shares this loop: a synchronous stretch of a few seconds (an
 * in-process graph gate, a cold index, a big git call) makes every UI client miss its pings and drop ("reconnecting"
 * in the app) with nothing in the log to say why. Name the stall and its length.
 */
/** For `server.status` (and the soak test): the daemon's footprint. With KORA_STATUS_GC=1 and --expose-gc, a full GC
 *  runs first so heapUsed is the retained heap, not whatever garbage the last tick left. */
function daemonMemory(): { rssMb: number; heapUsedMb: number; liveChatSessions: number; uptimeS: number; stalls: { count: number; maxMs: number; lastAt: number } } {
  const g = (globalThis as { gc?: () => void }).gc;
  if (process.env.KORA_STATUS_GC === '1' && g) g();
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576 * 10) / 10, liveChatSessions: liveSessionCount(), uptimeS: Math.round(process.uptime()), stalls: { ...stallStats } };
}
let liveSessionCount: () => number = () => 0;
/** What the stall detector has seen since start (server.status → `kora server status`). */
const stallStats = { count: 0, maxMs: 0, lastAt: 0 };
export function stallStatsForTests(): { count: number; maxMs: number; lastAt: number } { return { ...stallStats }; }

// What was running when the loop stalled: a ring of recent socket RPCs (start/end, monotonic ms) plus GC pauses. A stall
// is only seen AFTER the blocking code returned, so the log names everything whose interval overlaps the stalled window
// (the blocker is among them) instead of just "blocked for ~5000ms". UI-websocket RPCs run inside the ui-server bundle and
// are not on this list; a stall with an empty list and no GC points there (or at a timer).
const RPC_TRAIL_MAX = 60;
const rpcTrail: { method: string; start: number; end: number | null }[] = [];
const gcTrail: { start: number; end: number; kind: number }[] = [];
let lastRpcMethod = '';
export function noteRpc(method: string): () => void {
  const e = { method, start: performance.now(), end: null as number | null };
  lastRpcMethod = method; rpcTrail.push(e); if (rpcTrail.length > RPC_TRAIL_MAX) rpcTrail.shift();
  return () => { e.end = performance.now(); };
}
/** The text that goes after "event loop blocked": RPCs/GC overlapping [from, to] (performance.now ms) and live handles. */
export function describeStall(from: number, to: number): string {
  const rpcs = rpcTrail.filter((r) => r.start <= to && (r.end === null || r.end >= from)).slice(-6)
    .map((r) => `${r.method}(${Math.round(((r.end ?? to) - r.start))}ms${r.end === null ? ',in flight' : ''})`);
  const gcs = gcTrail.filter((g) => g.end >= from && g.start <= to).map((g) => `${Math.round(g.end - g.start)}ms`);
  let handles = ''; try { const c: Record<string, number> = {}; for (const h of (process as any).getActiveResourcesInfo?.() ?? []) c[h] = (c[h] ?? 0) + 1; handles = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}x${v}`).join(' '); } catch { /* old node */ }
  return `during: ${rpcs.length ? rpcs.join(', ') : 'no socket RPC'}${gcs.length ? `; gc ${gcs.join(',')}` : ''}; last rpc ${lastRpcMethod || '-'}; handles ${handles || '-'}`;
}
const WALL_JUMP_IGNORE_MS = 60_000;

export function startStallDetector(tickMs = 500, warnMs = 2000): () => void {
  // Monotonic clock: on macOS it stops while the Mac sleeps, the wall clock does not — measured with Date.now() every
  // lid-close logged as a 15–25 MINUTE "event loop blocked" and buried the real stalls (and inflated stallStats).
  let last = performance.now(); let lastWall = Date.now();
  let obs: { disconnect(): void } | null = null;
  try {
    const { PerformanceObserver } = require('node:perf_hooks') as typeof import('node:perf_hooks');
    const o = new PerformanceObserver((list) => { for (const e of list.getEntries()) { gcTrail.push({ start: e.startTime, end: e.startTime + e.duration, kind: (e as any).detail?.kind ?? 0 }); if (gcTrail.length > 40) gcTrail.shift(); } });
    o.observe({ entryTypes: ['gc'] }); obs = o;
  } catch { /* no gc entries */ }
  const t = setInterval(() => {
    const mono = performance.now(); const wall = Date.now();
    const lag = Math.round(mono - last - tickMs);
    // A wall-clock gap far beyond the monotonic one is the Mac asleep (or the clock stepped), never a stall.
    const slept = (wall - lastWall) - (mono - last) > WALL_JUMP_IGNORE_MS || lag > WALL_JUMP_IGNORE_MS;
    if (lag > warnMs && !slept) { stallStats.count++; stallStats.maxMs = Math.max(stallStats.maxMs, lag); stallStats.lastAt = wall; log(`event loop blocked for ~${lag}ms (ended ${new Date(wall).toISOString()}) ${describeStall(last, mono)}`); }
    else if (lag > warnMs && slept) log(`clock gap of ~${Math.round((wall - lastWall) / 1000)}s ignored (the Mac was asleep)`);
    last = mono; lastWall = wall;
  }, tickMs);
  t.unref();
  return () => { clearInterval(t); try { obs?.disconnect(); } catch { /* ignore */ } };
}

/** How long one shutdown step may take before the daemon moves on without it. */
export const STEP_DEADLINE_MS = 4_000;

/** Wait for `p`, but never longer than `ms`: a rejection or a timeout is logged, not thrown. */
export async function withDeadline(p: Promise<unknown>, ms: number, what: string, logFn: (m: string, e?: unknown) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.catch((e) => logFn(`${what} failed`, e)),
      new Promise<void>((resolve) => { timer = setTimeout(() => { logFn(`${what} did not finish in ${ms} ms: moving on`); resolve(); }, ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * The SIGINT / SIGTERM / SIGHUP handler: start a graceful close, and make sure the process really goes: after `graceMs`
 * (or at a second signal) it exits. `exit` is injectable for the test.
 */
export function makeSignalStop(close: () => Promise<void>, o: { graceMs?: number; exit?: (code: number) => void; log?: (m: string) => void } = {}): (signal?: string) => void {
  const graceMs = o.graceMs ?? 10_000;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const say = o.log ?? ((m: string) => log(m));
  let signals = 0;
  return (signal) => {
    signals++;
    if (signals === 1) {
      const t = setTimeout(() => { say(`shutdown still running after ${graceMs} ms: exiting now`); exit(0); }, graceMs);
      t.unref();
      // a close that finishes ends the process the normal way (runForeground resumes; `server run` adds its own 1.5 s backstop)
      void close().then(() => clearTimeout(t), () => clearTimeout(t));
    } else {
      say(`second ${signal ?? 'signal'}: exiting now`);
      exit(0);
    }
  };
}

/**
 * Routines: the loopback webhook receiver (port = UI port + 3, KORA_WEBHOOK_PORT overrides). A taken port is logged,
 * never fatal. Not while Kora is "coming soon" (edition.ts): no routine runs then, so nothing may listen on :8793 either.
 */
export function startWebhookReceiver(routines: { startReceiver(): Promise<{ port: number } | null> }, surfaceOn: () => boolean = isKoraSurfaceOn): boolean {
  if (!surfaceOn()) return false;
  void routines.startReceiver().then((r) => { if (r) log(`routines: webhook receiver on http://127.0.0.1:${r.port}`); }, (e) => log('routines: webhook receiver failed', e));
  return true;
}

/** `kora server run`: foreground until shutdown/signals. Also serves the chat UI (ui.ts) when a bundle is installed. */
export async function runForeground(opts: { socketPath?: string } = {}): Promise<number> {
  // Kora's own secrets (a KORA_*_TOKEN, release-signing secrets from a release shell) leave the daemon's env before
  // anything is spawned: every child — pane, SDK chat lane, model probe — inherits process.env (util/child-env.ts).
  try {
    const { scrubProcessEnv } = require('../util/child-env') as typeof import('../util/child-env');
    const removed = scrubProcessEnv();
    if (removed.length) log(`env: kept ${removed.length} Kora-own secret variable(s) away from agents: ${removed.join(', ')}`);
  } catch (e) { log('env scrub failed', e); }
  const handle = await createServer(opts);
  startStallDetector();
  // Windows: another process renaming/vacuuming the graph store asks every holder to close (graph/store-maintenance.ts);
  // this releases the daemon's koragraph pool. A no-op on macOS/Linux.
  try {
    const { watchStoreMaintenance } = require('../graph/store-maintenance') as typeof import('../graph/store-maintenance');
    const { releaseKoragraphModules } = require('../graph/embedded') as typeof import('../graph/embedded');
    watchStoreMaintenance(releaseKoragraphModules);
  } catch (e) { log('graph store maintenance watch failed', e); }
  const stopWatchdog = startWatchdog();
  writeDaemonPid();
  // Logs rotate, telemetry compacts, caches and killed-gate scratch age out: at start (+20 s) and hourly.
  const stopHousekeeping = startHousekeeping();
  // The savings meter's price list (models.dev snapshot, ledger/prices.ts): at start (+30 s), then every 6 h.
  const stopPrices = (require('../ledger/prices') as typeof import('../ledger/prices')).startPriceCatalogRefresh();
  let down = false;
  startWebhookReceiver(handle.blobs.routines);
  // Not awaited: the socket is already serving; the UI comes up after its model-catalog probes (a few seconds).
  startUiServer(handle).then((h) => { if (down) void h?.close(); else { handle.ui = h; handle.uiError = null; } }, (e) => { handle.uiError = String((e as Error)?.message ?? e); log(`ui: the chat UI server did not start — ${handle.uiError}`); });
  const stop = makeSignalStop(() => handle.close());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop(sig));
  process.on('uncaughtException', (e) => log('uncaughtException', e));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e as any));
  await handle.closed;
  // Every shutdown path (signal, server.shutdown RPC) ends here: the UI listener would otherwise keep the process alive.
  down = true;
  stopWatchdog();
  removeDaemonPid();
  stopHousekeeping();
  stopPrices();
  await Promise.resolve(handle.ui?.close()).catch((e) => log('ui server close failed', e));
  handle.ui = null;
  return 0;
}

/** `kora server start`: spawn a detached `server run`, wait for the socket. */
// Cold start is ~1 s on an idle machine, but a fresh node process can sit several seconds in macOS's exec
// assessment queue under load (measured 5-20 s while the parallel test suite runs). The wait returns as soon as the
// socket answers, so a generous ceiling costs nothing on the happy path.
const START_WAIT_MS = Number(process.env.KORA_START_WAIT_MS) || 20_000;
export async function startDetached(opts: { socketPath?: string; waitMs?: number } = {}): Promise<{ pid: number; socketPath: string }> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  if (await isSocketAlive(socketPath)) throw new Error(`server already running on ${socketPath}`);
  privateDir(koraHome(), true);
  const out = fs.openSync(logPath(), 'a', 0o600);
  // --liftoff-only: the daemon parses source too (a file-scoped query catches a dirty file up in a graph worker), and
  // V8's optimizing wasm tier both aborts the process on the Swift grammar and cost ~2 GB of compile memory on a medium
  // repo's ingest (3.0 GB → 0.84 GB peak with the flag). Command-line only; see koragraph/src/services/ast-extractor.js.
  const child = spawn(process.execPath, ['--liftoff-only', binPath(), 'server', 'run'], {
    detached: true, windowsHide: true, stdio: ['ignore', out, out], cwd: process.cwd(),
    env: { ...process.env, KORA_SOCKET_PATH: socketPath },
  });
  child.unref(); fs.closeSync(out);
  const deadline = Date.now() + (opts.waitMs ?? START_WAIT_MS);
  while (Date.now() < deadline) {
    if (await isSocketAlive(socketPath)) return { pid: child.pid!, socketPath };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not come up within ${opts.waitMs ?? START_WAIT_MS}ms (see ${logPath()})`);
}

export async function ensureServer(opts: { socketPath?: string } = {}): Promise<{ started: boolean }> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  if (await isSocketAlive(socketPath)) return { started: false };
  await startDetached({ socketPath });
  return { started: true };
}

/**
 * Bootstrap + connect in one call: find the socket → autostart the daemon if the socket isn't alive
 * → return a connected `KoraClient`. The single entry point every frontend (TUI, Electron main, scripts)
 * should use so the launch-or-attach race (hazard H6) is owned in one place. `started` reports whether this
 * call spawned the daemon (vs. attached to a running one). The caller owns closing the returned client.
 */
export async function ensureAndConnect(
  opts: { socketPath?: string; connectTimeoutMs?: number } = {},
): Promise<{ client: KoraClient; started: boolean }> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const { started } = await ensureServer({ socketPath });
  const client = new KoraClient(socketPath);
  await client.connect(opts.connectTimeoutMs ?? 5000);
  return { client, started };
}

// FleetOps — the small, driver-facing view of the Runtime an ORCHESTRATOR chat thread uses to run its fleet.
// The chat plane's orchestrator is not a pane (its id is `chat:<threadId>`), so it cannot shell out to
// `kora agent …` against a socket that may not even be bound (the chat UI server drives the Runtime in-process).
// Everything it needs — roster, steer, wait, read a worker's screen, kill, graph-verified merge, plan — goes
// through this object instead, built once per Runtime and handed to the SessionManager as `runtime.fleet`.
import type { AgentState, MergePair, PaneInfo, SwarmWorkerMeta } from '../protocol/types';
import type { SwarmSpawner } from '../session/fleet-tools';
import type { SwarmSpawnResult, SwarmTaskRecord } from './swarm';
import type { SwarmRemoteTask } from '../protocol/types';
import type { Runtime } from './workspace';

export interface WorkerInfo {
  id: string;
  name: string;
  agent: string;
  account: string | null;
  state: AgentState | 'exited';
  blocker: string | null;
  exited: boolean;
  exitCode: number | null;
  cwd: string;
  worktree: PaneInfo['worktree'];
  costUsd: number | null;
  contextPct: number | null;
  steeredAt: number | null;
  createdAt: number;
  lastOutputAt: number;
  /** ms since the pane last wrote anything (screen detection can only say "working"; a frozen spinner looks the same) */
  quietMs: number;
  /** state says working but nothing has been written for STALL_MS — detectable, and worth a kora_read/kora_kill */
  stalled: boolean;
  /** Stopped on a transient API/network error ("The response stopped arriving"): shown as `error-stalled`; kora auto-continues it up to a cap. */
  errorStall?: { line: string; at: number; retries: number; retrying: boolean } | null;
  /** A swarm worker's meta (task, model, phase, report, verify); null for any other worker. */
  swarm: SwarmWorkerMeta | null;
}

/** A chat lead's CLI worker that went to sleep (server/worker-sleep.ts): readable, wakeable. */
export interface SleepingWorker { recordId: string; lastPaneId: string; agent: string; title: string; sleptAt: number; finalReport: string | null; ahead: number; files: string[]; branch: string | null; canResume: boolean }

export interface FleetOps {
  /** Live workers owned by this orchestrator (exited ones included until the runtime reaps them). */
  list(orchestratorId: string): WorkerInfo[];
  /** Type a line into a worker (orchestrator-origin: never counts as a human steer) and optionally submit it. */
  prompt(paneId: string, text: string, opts?: { submit?: boolean; waitIdle?: boolean; timeoutMs?: number }): Promise<{ state: AgentState }>;
  /** Block until the worker reaches `until` (or exits), bounded by timeoutMs. */
  wait(paneId: string, until: AgentState | 'needs-human', timeoutMs: number): Promise<{ state: AgentState; blocker: string | null; timedOut: boolean; exited: boolean }>;
  /** The worker's screen or scrollback as plain text. */
  read(paneId: string, source: 'screen' | 'scrollback', lines?: number): string;
  /** What the worker SAID, from its transcript: the last `turns` assistant messages, in full. */
  report(paneId: string, turns?: number): string;
  kill(paneId: string): void;
  /** Graph pre-merge gate across the given workers' worktrees (union blast-radius). */
  mergeVerify(paneIds: string[]): Promise<{ pairs: MergePair[]; order: string[] }>;
  /** Merge one worker's worktree branch into the main checkout. */
  merge(paneId: string, opts?: { into?: string; commitFirst?: boolean }): Promise<{ ok: boolean; merged: string | null; into: string | null; conflicts: string[]; message: string; commitsMerged: number }>;
  setPlan(orchestratorId: string, plan: string): void;
  getPlan(orchestratorId: string): string;
  /**
   * Optional: take (and clear) the out-of-band `[kora] …` notes queued for this orchestrator while its turn
   * runs, so a tool result can carry them in-turn. Hosts that deliver notes another way leave it undefined.
   */
  drainNotes?(orchestratorId: string): string[];
  /** The live pane for `paneId` after swarm failovers (identity otherwise), once any in-flight failover settled. */
  follow?(paneId: string): Promise<string>;
  /** The in-process SwarmService (the `swarm` agent alias). Hosts pass it on as FleetToolContext.swarm. */
  swarm?: SwarmSpawner;
  /** This orchestrator's workers that went to sleep after work. */
  asleep?(orchestratorId: string): SleepingWorker[];
  /** Wake one (by record id, or the pane id it had while awake): resumes its session; returns its new pane id. */
  wake?(orchestratorId: string, id: string): Promise<{ paneId: string; resumed?: boolean; rebriefed?: boolean }>;
  /** A worker's history as text (final answer + transcript tail), awake or asleep, by record id or pane id. */
  history?(orchestratorId: string, id: string, maxEntries?: number): string | null;
}

function ctxPct(p: PaneInfo): number | null {
  const l = p.ledger;
  if (!l || typeof l.lastContext !== 'number' || typeof l.contextWindow !== 'number' || l.contextWindow <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((l.lastContext / l.contextWindow) * 100)));
}

/** A "working" pane silent this long is reported as stalled. Agents stream tokens; 5 minutes of nothing while working is
 *  a hang, a network stall or a modal the detector missed — the orchestrator sat out full timeouts on these before. */
export const STALL_MS = 5 * 60 * 1000;
/** A remote `worktree.merge` waits longer than the daemon's merge child (worktree.ts MERGE_CHILD_TIMEOUT_MS = 290 s, lock
 *  wait included) plus its graph freshen: an RPC that gave up first reported a failure for a merge that then landed,
 *  and the lead's retry read "nothing to merge" (audit 2026-10-15 fleet #11). Not imported: worktree.ts pulls in the
 *  graph layer, which `kora mcp --fleet` does not load. */
export const MERGE_RPC_TIMEOUT_MS = 330_000;
export function toWorkerInfo(p: PaneInfo, now = Date.now()): WorkerInfo {
  const quietMs = Math.max(0, now - (p.lastOutputAt || p.createdAt || now));
  return {
    quietMs, stalled: !p.exited && p.state === 'working' && quietMs >= STALL_MS,
    id: p.id, name: p.name, agent: p.agent, account: p.account ?? null,
    state: p.exited ? 'exited' : p.state, blocker: p.blocker, exited: p.exited, exitCode: p.exitCode,
    cwd: p.liveCwd || p.cwd, worktree: p.worktree,
    costUsd: typeof p.ledger?.costUsd === 'number' ? p.ledger.costUsd : null,
    contextPct: ctxPct(p), steeredAt: p.steeredAt ?? null, createdAt: p.createdAt, lastOutputAt: p.lastOutputAt,
    swarm: p.swarm ?? null,
    errorStall: !p.exited && p.errorStall ? p.errorStall : null,
  };
}

export function makeFleetOps(runtime: Runtime): FleetOps {
  return {
    asleep: (orchestratorId) => runtime.workerSleeper().list(orchestratorId).filter((r) => r.status === 'asleep').map(toSleeping),
    wake: async (orchestratorId, id) => runtime.wakeWorker(resolveRecord(runtime, orchestratorId, id)),
    history: (orchestratorId, id, maxEntries = 40) => {
      const rid = (() => { try { return resolveRecord(runtime, orchestratorId, id); } catch { return null; } })();
      const t = rid ? runtime.workerTranscript(rid) : null;
      return t ? workerHistoryText(t.record, t.entries, maxEntries) : null;
    },
    list: (orchestratorId) => runtime.listPanes().filter((p) => p.orchestratorId === orchestratorId).map(toWorkerInfo),
    prompt: async (paneId, text, opts = {}) => {
      const r = await runtime.prompt(paneId, text, opts.submit !== false, opts.waitIdle !== false, opts.timeoutMs ?? 120_000);
      return { state: r.state };
    },
    wait: async (paneId, until, timeoutMs) => {
      const r = await runtime.wait(paneId, until, timeoutMs);
      const p = runtime.panes.get(paneId);
      return { ...r, exited: !p || p.exited };
    },
    read: (paneId, source, lines) => runtime.requirePane(paneId).read(source, 'text', lines),
    report: (paneId, turns) => runtime.report(paneId, turns ?? 1),
    kill: (paneId) => runtime.killPane(paneId),
    mergeVerify: (paneIds) => runtime.mergeVerify({ paneIds }),
    merge: (paneId, opts = {}) => runtime.worktreeMerge({ paneId, into: opts.into, commitFirst: opts.commitFirst ?? true }),
    setPlan: (orchestratorId, plan) => { runtime.fleetSet(orchestratorId, { plan }); },
    getPlan: (orchestratorId) => runtime.fleetGet(orchestratorId).plan,
    follow: async (paneId) => {
      let id = paneId;
      try { id = await runtime.swarm.followSettled(paneId); } catch { /* not a swarm pane */ }
      // A CLI worker that slept and was woken (by kora_prompt or the app's Wake button) runs under a new pane id;
      // the lead still names it by the old one. A live pane with that id is itself and wins.
      const live = runtime.panes.get(id);
      if (live && !live.exited) return id;
      return runtime.workerSleeper().wokenPaneFor(id) ?? id;
    },
    swarm: runtime.swarm,
  };
}

// ── remote: fleet control over the fleet socket ─────────────────────────────────────────────────────────────
// For an orchestrator that is NOT in this process — `kora mcp --fleet`, launched by a Codex/other CLI as an
// MCP server — every op is the runtime's existing RPC (agent.*, pane.*, worktree.*, fleet.*) on the socket the
// runtime handed out as KORA_SOCKET_PATH. Implements the async `FleetControl` the shared fleet tools consume
// (session/fleet-tools.ts); the in-process FleetOps is adapted to the same interface by `fleetControlFrom`.
type AgentId = import('../protocol/types').AgentId;
type Methods = import('../protocol/types').Methods;
type MethodName = import('../protocol/types').MethodName;

export interface RemoteFleet {
  control: import('../session/fleet-tools').FleetControl;
  /** The `swarm` agent alias over the socket (`swarm.spawn` / `swarm.task`). */
  swarm: SwarmSpawner;
  spawnWorker(p: { agent: AgentId; cwd: string; prompt?: string; account?: string | null; worktree?: boolean; orchestratorId?: string; args?: string[]; name?: string }): Promise<{ id: string; agent: AgentId; account: string | null; /** false: no worktree of its own, it edits the lead's checkout */ worktree?: boolean }>;
  /** The worker picker in the app (`chat.workers.ask`); waits up to 30 min for the user. */
  askWorkers(orchestratorId: string, picks: import('../session/worker-picker').WorkerPick[]): Promise<import('../session/worker-picker').WorkerPickerAnswer>;
  close(): void;
}

export function makeRemoteFleet(socketPath: string, caller?: string): RemoteFleet {
  const { KoraClient } = require('../protocol/client') as typeof import('../protocol/client');
  let client: InstanceType<typeof KoraClient> | null = null;
  const conn = async () => {
    if (client) return client;
    const c = new KoraClient(socketPath);
    if (caller) c.caller = caller; // Codex scrubs the MCP env: the lead names itself so the daemon can scope the call to its fleet
    await c.connect(3000);
    c.on('close', () => { if (client === c) client = null; }); // re-dial on the next call after a drop
    client = c;
    return c;
  };
  const call = async <M extends MethodName>(method: M, params: Methods[M]['params'], timeoutMs = 60_000): Promise<Methods[M]['result']> => {
    const c = await conn();
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method}: no reply from the runtime within ${timeoutMs} ms`)), timeoutMs);
      c.call(method, params).then((v) => { clearTimeout(t); resolve(v as any); }, (e) => { clearTimeout(t); reject(e); });
    });
  };
  const control: import('../session/fleet-tools').FleetControl = {
    list: async (orchestratorId) => (await call('pane.list', {})).panes.filter((p) => p.orchestratorId === orchestratorId).map(toWorkerInfo),
    prompt: async (paneId, text, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const r = await call('agent.prompt', { paneId, text, submit: opts.submit !== false, waitIdle: opts.waitIdle !== false, timeoutMs }, timeoutMs + 30_000);
      return { state: r.state };
    },
    wait: async (paneId, until, timeoutMs) => {
      const r = await call('agent.wait', { paneId, until, timeoutMs }, timeoutMs + 30_000);
      let exited = false;
      try { exited = (await call('pane.get', { paneId })).exited; } catch { exited = true; }
      return { ...r, exited };
    },
    read: async (paneId, source, lines) => (await call('pane.read', { paneId, source, format: 'text', lines })).text,
    report: async (paneId, turns) => (await call('pane.read', { paneId, source: 'report' as any, ...(turns != null ? { turns } : {}) } as any)).text,
    kill: async (paneId) => { await call('pane.kill', { paneId }); },
    mergeVerify: (paneIds) => call('worktree.mergeVerify', { paneIds }, 330_000),
    merge: (paneId, opts = {}) => call('worktree.merge', { paneId, into: opts.into, commitFirst: opts.commitFirst ?? true }, MERGE_RPC_TIMEOUT_MS),
    setPlan: async (orchestratorId, plan) => { await call('fleet.set', { orchestratorId, plan }); },
    drainNotes: async (orchestratorId) => { try { return (await call('fleet.drainNotes', { orchestratorId }, 5000)).notes ?? []; } catch { return []; } },
    asleep: async (orchestratorId) => { try { return (await call('worker.asleep', { orchestratorId }, 10_000)).workers; } catch { return []; } },
    wake: (orchestratorId, id) => call('worker.wake', { orchestratorId, id }, 180_000),
    history: async (orchestratorId, id, maxEntries) => (await call('worker.history', { orchestratorId, id, ...(maxEntries ? { maxEntries } : {}) }, 15_000)).text,
    // A remote orchestrator follows a swarm pane's supersededBy chain while the old panes are still listed (the
    // in-process SwarmService keeps an alias map this side cannot see). Best effort; identity when unknown.
    follow: async (paneId) => {
      let id = paneId;
      for (let i = 0; i < 8; i++) {
        let next: string | null = null;
        try { next = (await call('pane.get', { paneId: id }, 5000)).swarm?.supersededBy ?? null; } catch { break; }
        if (!next || next === id) break;
        id = next;
      }
      return id;
    },
  };
  // The remote SwarmSpawner. fleet-tools asks taskForPane / note / lostInRestart synchronously, so the answers come
  // from a cache that spawn() and every readReport() (one `swarm.task` round trip) refresh.
  const tasks = new Map<string, SwarmTaskRecord>();
  const notes = new Map<string, { note: string | null; lost: boolean }>();
  const remember = (paneId: string, r: SwarmRemoteTask) => {
    if (r.task) { const rec = { ...r.task, status: r.task.status as SwarmTaskRecord['status'] }; for (const id of new Set([paneId, ...rec.paneIds])) tasks.set(id, rec); }
    notes.set(paneId, { note: r.note, lost: r.lostInRestart });
  };
  // kora_verify: the done-checks (kora_spawn check:) this bridge's lead gave, newest last. checksFor is synchronous, so they are
  // remembered here when the spawn goes through (a task spawned by an earlier bridge process is not known: "no check recorded").
  const checks: { orchestratorId: string; taskId: string; check: string }[] = [];
  const swarm: SwarmSpawner = {
    checksFor: (orchestratorId, paneIds) => {
      const only = paneIds?.length ? new Set(paneIds.map((id) => tasks.get(id)?.taskId).filter((x): x is string => !!x)) : null;
      const out: { taskId: string; check: string }[] = [];
      for (const c of [...checks].reverse()) {
        if (c.orchestratorId !== orchestratorId || (only && !only.has(c.taskId))) continue;
        if (!out.some((o) => o.check === c.check)) out.push({ taskId: c.taskId, check: c.check });
      }
      return out;
    },
    spawn: async (p) => {
      const r = await call('swarm.spawn', { orchestratorId: p.orchestratorId, cwd: p.cwd, task: p.task, ...(p.title ? { title: p.title } : {}), ...(p.runtimeMode ? { runtimeMode: p.runtimeMode } : {}), ...(p.permission ? { permission: p.permission } : {}), ...(p.check ? { check: p.check } : {}), ...(p.queue ? { queue: true } : {}) }, 180_000);
      // A queued task has no pane yet (r.paneId null): cache it under its task id so taskForPane('sN') still answers
      // "queued" until swarm.task (readReport) or another spawn.queued refresh sees it start.
      const key = r.paneId ?? r.taskId;
      tasks.set(key, { taskId: r.taskId, orchestratorId: p.orchestratorId, paneIds: r.paneId ? [r.paneId] : [], reportPath: r.reportPath ?? '', status: r.queued ? 'queued' : 'starting' });
      if (p.check) { checks.push({ orchestratorId: p.orchestratorId, taskId: r.taskId, check: p.check }); if (checks.length > 50) checks.shift(); }
      return r as unknown as SwarmSpawnResult;
    },
    taskForPane: (paneId) => tasks.get(paneId) ?? null,
    readReport: async (paneId) => {
      try { const r = await call('swarm.task', { paneId }, 15_000); remember(paneId, r); return r.report; } catch { return null; }
    },
    finishedTasks: async (orchestratorId) => { try { return (await call('swarm.finished', { orchestratorId }, 10_000)).tasks ?? []; } catch { return []; } },
    queuedTasks: async (orchestratorId) => { try { return (await call('swarm.queued', { orchestratorId }, 10_000)).tasks ?? []; } catch { return []; } },
    note: (paneId) => notes.get(paneId)?.note ?? null,
    lostInRestart: (paneId) => notes.get(paneId)?.lost ?? false,
  };
  return {
    control,
    swarm,
    spawnWorker: async (p) => {
      const info = await call('agent.spawn', { agent: p.agent, cwd: p.cwd, prompt: p.prompt, account: p.account ?? undefined, worktree: p.worktree, orchestratorId: p.orchestratorId, args: p.args, name: p.name }, 120_000);
      return { id: info.id, agent: info.agent, account: info.account ?? null, worktree: !!info.worktree };
    },
    askWorkers: (orchestratorId, picks) => call('chat.workers.ask', { orchestratorId, picks }, 30 * 60_000),
    close: () => { client?.close(); client = null; },
  };
}

function toSleeping(r: import('./worker-sleep').WorkerRecord): SleepingWorker {
  return { recordId: r.recordId, lastPaneId: r.paneId, agent: r.agent, title: r.title, sleptAt: r.sleptAt ?? r.createdAt, finalReport: r.finalReport, ahead: r.changes?.ahead ?? 0, files: r.changes?.files ?? [], branch: r.branchKept ? r.worktree?.branch ?? null : null, canResume: (require('./worker-sleep') as typeof import('./worker-sleep')).canResumeSession(r) };
}

/** A record id, or the pane id a worker had (its newest record under this orchestrator). */
function resolveRecord(runtime: Runtime, orchestratorId: string, id: string): string {
  const sl = runtime.workerSleeper();
  if (/^w_/.test(id) && sl.load(id)?.orchestratorId === orchestratorId) return id;
  const r = sl.findByLastPane(orchestratorId, id);
  if (!r) throw new Error(`no worker ${id} (awake or asleep) in this fleet`);
  return r.recordId;
}

/** Text a lead can read: what the worker was asked, what it answered, what it changed, the end of its transcript. */
export function workerHistoryText(r: import('./worker-sleep').WorkerRecord, entries: import('./worker-sleep').TranscriptEntry[], maxEntries = 40): string {
  const lines = [
    `${r.recordId} (${r.status}${r.status === 'awake' ? ` as ${r.paneId}` : `, was ${r.paneId}`}) ${r.agent} "${r.title}"`,
    r.prompt ? `asked: ${r.prompt.slice(0, 600)}` : '',
    r.finalReport ? `final answer:\n${r.finalReport.slice(0, 4000)}` : '',
    r.changes ? `changes: ${r.changes.ahead} commit(s)${r.worktree && r.branchKept ? ` on ${r.worktree.branch}` : ''}${r.changes.files.length ? ` — ${r.changes.files.slice(0, 20).join(', ')}` : ''}${r.changes.autoCommitted ? ' (uncommitted edits were auto-committed when it slept)' : ''}` : '',
    entries.length ? `transcript (last ${Math.min(maxEntries, entries.length)} of ${entries.length}):\n${entries.slice(-maxEntries).map((e) => `  [${e.role}] ${e.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}` : 'transcript: (none found)',
  ];
  return lines.filter(Boolean).join('\n');
}

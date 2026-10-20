// Control capability for the daemon's unix socket (audit 2026-10-13 S2-2).
//
// The socket is 0600, but every agent Kora starts inherits KORA_SOCKET_PATH, so "same user" is not "the user". An
// agent that could dial it flipped a thread to Full access with no approval. Methods that change what an agent may
// do (permission mode, approvals, config, spawning arbitrary commands, typing into panes, shutting down) now need the
// UI token (`<KORA_HOME>/ui-token`, 0600) in the request envelope (`auth`). Kora's own CLI/hooks/fleet tools attach it
// when they run OUTSIDE an agent (see protocol/client.ts); an agent process never holds it: the sensitive-path guard
// refuses the file on every lane, and agy/Codex/OpenCode run under an OS read-deny for it (session/os-sandbox.ts).
// Everything the kora_* fleet tools and hooks call (pane.list/get/read/kill, agent.*, fleet.*, swarm.*, graph.*,
// worktree.merge*, chat.workers.ask) stays open.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Socket methods that change an agent's powers or run arbitrary commands: UI-token only. */
export const PRIVILEGED_METHODS: ReadonlySet<string> = new Set([
  'server.shutdown', 'config.set',
  // starts an index of any path (the user's "never index on open" rule: only the user starts a first index; nothing in
  // Kora calls it over the socket — the chip goes through the ui-server, `kora ingest` runs in its own process)
  'graph.ingest',
  'pane.spawn', 'pane.write', 'pane.restart',
  // Deletes every unowned worktree under <KORA_HOME>/worktrees (2026-10-15 audit #1): a token-less sweep removed another
  // fleet's freshly made worktree, or a finished swarm worker's whose report was not read yet. The daemon's own sweeps run
  // in-process; only the user's `kora worktree sweep` comes over the socket.
  'worktree.sweep',
  // Only the user makes a pane an orchestrator (A3-9): an agent that could promote a pane could then spawn into its fleet unpicked.
  'agent.promote',
  // The whole thread list (titles, folders): no agent has a use for it; a single thread is read through `chat.thread.get` (own thread only).
  'chat.thread.list',
  'chat.thread.create', 'chat.thread.setAgentMode', 'chat.thread.delete', 'chat.thread.archive', 'chat.thread.unarchive',
  'chat.session.start', 'chat.session.stop', 'chat.session.setModel', 'chat.session.setPermissionMode',
  'chat.turn.send', 'chat.turn.interrupt', 'chat.approval.respond', 'chat.userInput.respond',
]);

export const CONTROL_DENIED_CODE = -32001;
export const CONTROL_DENIED_MESSAGE = 'this call changes what agents may do, so it needs the Kora control token ($KORA_HOME/ui-token). Agents cannot use it; run it yourself from a terminal.';

const TOKEN_FILE = 'ui-token';

/** Same file and format as the ui-server's `ensureUiToken` (reuse when it holds one, else mint 0600 atomically). */
export function ensureControlToken(home: string): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* missing: mint */ }
  const token = crypto.randomBytes(32).toString('base64url');
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, `${token}\n`); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
}

/**
 * A caller's proof of identity (2026-10-15 audit #2): HMAC of its id under the control token. `caller` alone was
 * self-asserted (`pane.list` handed out every pane's id), so an agent named a victim's pane or `chat:<thread>` and drove
 * it. The daemon hands each pane / chat session its key in the env (KORA_CALLER_KEY) and the client sends it with
 * `caller`; nothing else can mint one without the token. Derived, not stored: it survives a daemon restart, and the
 * daemon re-derives it to check. Null without a token file.
 */
export function callerKey(caller: string, home: string): string | null {
  const t = readControlToken(home);
  return t ? crypto.createHmac('sha256', t).update(`kora-caller-v1:${caller}`).digest('base64url') : null;
}

/**
 * Hand a caller key to a process whose env is scrubbed (Codex starts MCP servers that way) without putting it on argv,
 * where `ps -ww` shows it to every process of the user: a one-time 0600 file in a 0700 folder under KORA_HOME. Only its
 * path rides argv; the reader deletes it (takeCallerKeyFile), and the writer deletes it again when the process ends.
 */
export function writeCallerKeyFile(caller: string, home: string): string | null {
  const key = callerKey(caller, home);
  if (!key) return null;
  const dir = path.join(home, 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `caller-key-${crypto.randomBytes(12).toString('hex')}`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, key); } finally { fs.closeSync(fd); }
  return file;
}

/** Read and delete a writeCallerKeyFile file: a regular file (no symlink) of ours with mode 0600, else undefined. */
export function takeCallerKeyFile(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return undefined;
    const key = fs.readFileSync(file, 'utf8').trim();
    return key.length > 0 && key.length <= 128 ? key : undefined;
  } catch { return undefined; } finally { try { fs.unlinkSync(file); } catch { /* gone already */ } }
}

/** `caller` when `key` proves it (callerKey), else undefined: an unproven caller is no caller at all. */
export function verifiedCaller(caller: string | undefined, key: string | undefined, home: string): string | undefined {
  if (!caller || !key) return undefined;
  const want = callerKey(caller, home);
  if (!want) return undefined;
  const a = Buffer.from(key); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? caller : undefined;
}

/** The token file's value, or null (never creates). */
export function readControlToken(home: string): string | null {
  try { const t = fs.readFileSync(path.join(home, TOKEN_FILE), 'utf8').trim(); return t.length >= 32 ? t : null; } catch { return null; }
}

/** Is a process an agent Kora started (pane worker, chat session, hook, fleet tool)? A plain terminal pane is the user. */
export function isAgentOrigin(env: NodeJS.ProcessEnv = process.env): boolean {
  const a = env.KORA_AGENT;
  return !!a && a !== 'shell';
}

/** Does this envelope carry the control token? Constant-time compare; fails closed without a token file. */
export function hasControl(auth: string | undefined, home: string): boolean {
  if (!auth) return false;
  const want = readControlToken(home);
  if (!want) return false;
  const a = Buffer.from(auth); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** May this envelope call this method? Public methods always pass. */
export function controlAllowed(method: string, auth: string | undefined, home: string): boolean {
  if (!PRIVILEGED_METHODS.has(method)) return true;
  return hasControl(auth, home);
}

// ---- open methods, called without the token (deep audit 2026-10-13 A1-1) ------------------------------------------
//
// `agent.spawn` / `agent.prompt` / `pane.read` stay open because the fleet tools of a Codex lead (`kora mcp --fleet`) and
// a pane orchestrator's `kora agent spawn` run inside an agent. But `agent.spawn` also took `command` (any binary),
// `env`, an unknown agent id (= a binary name) or a shell, and `agent.prompt` typed into any pane, a shell included. A
// fenced agy/Codex/OpenCode agent (or any agent the guard stopped) could start `/bin/sh -c 'cat ~/.ssh/id_rsa'` OUTSIDE
// its fence and read it back with `pane.read`: the OS read-deny and the credential guard both bypassed. Without the
// token, a call may now only start an agent Kora guards (hooks or the OS fence), with the launch flags Kora's own fleet
// tools produce, and only drive or read panes that run such an agent.

/** Agents a token-less caller may start or drive: each runs under the credential guard (Claude hooks) or the OS fence. */
export const GUARDED_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'antigravity', 'gemini', 'opencode', 'koragent']);

/** agent.spawn params that only Kora's in-process callers (SwarmService, the worker sleeper) may set. */
const INTERNAL_SPAWN_KEYS = ['command', 'env', 'isolatedEnv', 'eventStream', 'reuseWorktree', 'skipWorkerPermission', 'paneId'] as const;

/** Each agent's "skip every permission prompt" flags (agent-adapter.ts skipPermissionArgs). */
const SKIP_PERMISSION_FLAGS: ReadonlySet<string> = new Set(['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--auto']);
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,127}$/;
/** The flags `workerLaunchArgs` (fleet-tools.ts) and the adapters emit: model, effort, posture, no-subagents. */
const VALUE_FLAGS: Readonly<Record<string, RegExp>> = {
  '--model': SAFE_VALUE, '-m': SAFE_VALUE,
  '--effort': /^(minimal|low|medium|high|xhigh|max)$/,
  '--permission-mode': /^(default|acceptEdits|plan)$/,
  '--mode': /^(accept-edits|plan)$/,
  '--approval-mode': /^(default|auto_edit|plan)$/,
  '-s': /^(read-only|workspace-write)$/,
  '-a': /^(untrusted|on-failure|on-request|never)$/,
  '--disable': /^multi_agent$/,
  '-c': /^(model_reasoning_effort="?(minimal|low|medium|high|xhigh)"?|check_for_update_on_startup=false)$/,
};
const BARE_FLAGS: ReadonlySet<string> = new Set([...SKIP_PERMISSION_FLAGS, '--disallowedTools=Agent,Task,Workflow']);

/** Why these launch args are refused without the token, or null. `skips` = they turn every permission prompt off. */
export function vetWorkerArgs(args: unknown): { error: string | null; skips: boolean } {
  if (args == null) return { error: null, skips: false };
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return { error: 'args must be a list of strings', skips: false };
  let skips = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (BARE_FLAGS.has(a)) { if (SKIP_PERMISSION_FLAGS.has(a)) skips = true; continue; }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const rule = VALUE_FLAGS[flag];
    if (!rule) return { error: `launch flag ${JSON.stringify(a.slice(0, 60))} is not one Kora's fleet tools use`, skips };
    const value = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (typeof value !== 'string' || !rule.test(value)) return { error: `value ${JSON.stringify(String(value ?? '').slice(0, 60))} for ${flag} is not allowed`, skips };
  }
  return { error: null, skips };
}

type Mode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
const MODES: ReadonlySet<string> = new Set(['approval-required', 'auto-accept-edits', 'auto', 'full-access']);

/**
 * The permission posture an orchestrator's workers may have at most, read from Kora's own state (never from the caller):
 * a chat thread's stored mode, else the daemon's default runtime mode, else Full access (DEFAULT_RUNTIME_MODE).
 */
export function orchestratorRuntimeMode(orchestratorId: string | null | undefined, home: string): Mode {
  const valid = (m: unknown): Mode | null => (typeof m === 'string' && MODES.has(m) ? (m as Mode) : null);
  if (orchestratorId && orchestratorId.startsWith('chat:') && /^chat:[A-Za-z0-9_-]{1,128}$/.test(orchestratorId)) {
    try { const m = valid(JSON.parse(fs.readFileSync(path.join(home, 'chat', orchestratorId.slice(5), 'meta.json'), 'utf8')).runtimeMode); if (m) return m; } catch { /* the default */ }
  }
  try { const m = valid(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).defaultRuntimeMode); if (m) return m; } catch { /* none saved */ }
  return 'full-access';
}

/** Methods that drive or read ONE pane named by `paneId`: without the token, only a pane running a guarded agent. */
const PANE_TARGET_METHODS: ReadonlySet<string> = new Set(['agent.prompt', 'agent.assign', 'pane.read', 'pane.snapshot']);

/** Pane-addressed methods a token-less caller may only aim at itself or a worker of its own fleet (deep A1 D3). */
const FLEET_SCOPED_PANE_METHODS: ReadonlySet<string> = new Set([...PANE_TARGET_METHODS, 'pane.get', 'pane.kill', 'agent.status', 'agent.wait', 'pane.rename', 'pane.compact', 'pane.index', 'pane.resize', 'pane.focus', 'ledger.get', 'swarm.task']);
/**
 * What a pane's own hooks and plugins report: only that pane may send them (S6 2026-10-14, 2026-10-15 audit #5).
 * reportAgentSession points a pane's transcript (read back through pane.read source=report) at a file, prelaunch writes
 * Kora's hook files into a cwd, reportState/reportGraphUse/swarm.reportEvent move its state, and pane.feed writes the
 * worker box the user reads ("Fixed it, tests pass."). A hook reports for its own pane (KORA_PANE_ID is both the paneId
 * and the caller), so not even its orchestrator has a use for them.
 */
const SELF_REPORT_METHODS: ReadonlySet<string> = new Set(['pane.reportAgentSession', 'pane.prelaunch', 'pane.reportState', 'pane.reportGraphUse', 'pane.feed', 'swarm.reportEvent']);
/** Methods addressed by `orchestratorId`: a token-less caller may only name its own. */
const FLEET_SCOPED_ORCH_METHODS: ReadonlySet<string> = new Set(['fleet.get', 'fleet.set', 'fleet.drainNotes', 'worker.asleep', 'worker.wake', 'worker.history', 'chat.workers.ask', 'swarm.spawn', 'swarm.finished', 'swarm.queued']);
/** Thread-addressed chat methods: a token-less caller may only read its own thread (`chat:<id>`). */
const THREAD_SCOPED_METHODS: ReadonlySet<string> = new Set(['chat.thread.get', 'chat.thread.rename', 'chat.events.subscribe', 'chat.events.unsubscribe', 'chat.events.backfill', 'chat.graph.explore', 'chat.graph.neighbours', 'chat.graph.blastRadius', 'chat.graph.overview', 'chat.diff']);
/**
 * Methods that read a repo by `cwd` (the merge gate, graph queries over the store's source excerpts): the caller's own repos only (audit #9).
 * NOT a security boundary: graph.db is readable by the user's processes, and `kora graph` answers in-process when the daemon
 * refuses, so an agent can still read other repos' graph data. This keeps the daemon's answers tidy; do not build on it.
 */
const CWD_SCOPED_METHODS: ReadonlySet<string> = new Set(['merge.verify', 'graph.tool', 'graph.brief']);

export interface PaneFacts { agent?: string; role?: string | null; orchestratorId?: string | null }

/** What the fleet scoping needs to know about the daemon's state (the daemon passes it; tests fake it). */
export interface ScopeDeps {
  paneFacts: (paneId: string) => PaneFacts | undefined;
  /** The pane (live, or a finished swarm task's) whose worktree is at this path, or undefined: none. */
  worktreeOwner?: (dir: string) => { paneId: string; orchestratorId?: string | null } | undefined;
  /** The orchestrator of a swarm task whose pane is gone (its worktree outlives a daemon restart), or undefined. */
  finishedOwner?: (paneId: string) => string | null | undefined;
  /** The folders a caller works in (its own and its workers' checkouts, worktrees, repo roots, its thread's folder). */
  callerRoots?: (caller: string) => string[];
}

function realOr(p: string): string { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
const underDir = (t: string, root: string): boolean => t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Is `dir` inside one of `roots` (both compared as real paths)? Exported for tests. */
export function insideRoots(dir: string, roots: readonly string[]): boolean {
  const t = realOr(dir);
  return roots.some((r) => r && (underDir(t, realOr(r)) || underDir(path.resolve(dir), path.resolve(r))));
}

/**
 * The fleet scope of a token-less call (deep A1 D3 / A3-9 / 2026-10-15 audit). `caller` is the id the calling agent was
 * proven to be (its pane id, or `chat:<thread>` for a chat lead and its Codex bridge; see verifiedCaller): the daemon
 * drops a `caller` that comes without its key. Returns a refusal reason or null.
 */
function vetFleetScope(method: string, p: Record<string, unknown>, caller: string | undefined, deps: ScopeDeps): string | null {
  const facts = deps.paneFacts;
  const need = (): string | null => (caller ? null : `${method}: a call without the Kora control token must come from a Kora agent (KORA_PANE_ID + KORA_CALLER_KEY)`);
  const inFleet = (id: string, f: PaneFacts | undefined): boolean => id === caller || (!!f && f.orchestratorId === caller);
  if (SELF_REPORT_METHODS.has(method)) {
    const id = p.paneId == null ? '' : String(p.paneId);
    if (facts(id) === undefined) return null; // no such pane: the method reports it (a chat session's hook reports for `chat:<id>`)
    const c = need(); if (c) return c;
    return id === caller ? null : `${method}: only pane ${id} itself may report for it`;
  }
  if (FLEET_SCOPED_PANE_METHODS.has(method)) {
    const id = p.paneId == null ? '' : String(p.paneId);
    const f = facts(id);
    if (f === undefined) return null; // no such pane: the method reports it
    const c = need(); if (c) return c;
    return inFleet(id, f) ? null : `${method}: pane ${id} is not in your fleet`;
  }
  if (FLEET_SCOPED_ORCH_METHODS.has(method)) {
    const c = need(); if (c) return c;
    const o = p.orchestratorId == null ? '' : String(p.orchestratorId);
    return o === caller ? null : `${method}: ${o.slice(0, 60) || 'no orchestrator'} is not your fleet`;
  }
  if (THREAD_SCOPED_METHODS.has(method)) {
    const c = need(); if (c) return c;
    const ids = [p.threadId, ...(Array.isArray(p.threadIds) ? p.threadIds : [])].filter((x) => x != null).map(String);
    if (!ids.length) return `${method}: needs your own thread id`;
    return ids.every((id) => caller === `chat:${id}`) ? null : `${method}: only your own thread can be read without the control token`;
  }
  if (method === 'worktree.merge' || method === 'worktree.remove' || method === 'worktree.mergeVerify') {
    // 2026-10-15 audit #1: `{path:"/any/dir"}` named no pane, so it passed, and `git worktree remove --force` / a commit-
    // everything merge ran on any checkout on the machine (this repo's main one included). Without the token a worktree
    // is named by a pane of the caller's fleet, or by the path of such a pane's own worktree; nothing else.
    const ids = [p.paneId, ...(Array.isArray(p.paneIds) ? p.paneIds : [])].filter((x) => x != null).map(String);
    const paths = [p.path, ...(Array.isArray(p.worktreePaths) ? p.worktreePaths : [])].filter((x) => x != null && x !== '').map(String);
    if (ids.length || paths.length) { const c = need(); if (c) return c; }
    for (const id of ids) {
      const f = facts(id);
      if (f !== undefined) { if (!inFleet(id, f)) return `${method}: pane ${id} is not in your fleet`; continue; }
      const orch = deps.finishedOwner?.(id);
      if (orch != null && orch !== caller && id !== caller) return `${method}: pane ${id} is not in your fleet`;
    }
    for (const dir of paths) {
      const owner = deps.worktreeOwner?.(dir);
      if (!owner) return `${method}: ${dir.slice(0, 120)} is not the worktree of a worker in your fleet; name the worker's pane instead`;
      if (owner.paneId !== caller && owner.orchestratorId !== caller) return `${method}: ${dir.slice(0, 120)} belongs to pane ${owner.paneId}, not your fleet`;
    }
    return null;
  }
  if (CWD_SCOPED_METHODS.has(method)) {
    const pid = p.paneId == null ? '' : String(p.paneId);
    if (pid) { const f = facts(pid); if (f !== undefined) { const c = need(); if (c) return c; if (!inFleet(pid, f)) return `${method}: pane ${pid} is not in your fleet`; } }
    if (!deps.callerRoots) return null;
    const c = need(); if (c) return c;
    const roots = deps.callerRoots(caller!);
    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    if (!cwd) return method === 'graph.tool' && pid && facts(pid) !== undefined ? null : `${method}: a call without the Kora control token must name a cwd in your own repo`;
    if (!insideRoots(cwd, roots)) return `${method}: ${cwd.slice(0, 120)} is not a repo you or your workers work in`;
    if (method === 'merge.verify') {
      for (const r of Array.isArray(p.refs) ? p.refs.map(String) : []) {
        const abs = path.isAbsolute(r) ? r : path.join(cwd, r);
        if (fs.existsSync(abs) && !insideRoots(abs, roots)) return `${method}: ${r.slice(0, 120)} is not a checkout you or your workers work in`;
      }
    }
  }
  return null;
}

/**
 * Why a token-less call is refused, or null. `paneAgent` names the agent a pane runs (undefined: no such pane, which the
 * method itself reports). `paneFacts` (the daemon passes it) turns on the fleet scoping above. Pure apart from `modeOf`.
 */
export function vetUncontrolledCall(method: string, params: unknown, deps: { paneAgent: (paneId: string) => string | undefined; paneFacts?: (paneId: string) => PaneFacts | undefined; caller?: string; modeOf: (orchestratorId: string | undefined) => Mode; takeSpawnApproval?: (orchestratorId: string, agent: string) => boolean } & Partial<Omit<ScopeDeps, 'paneFacts'>>): string | null {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  if (deps.paneFacts && method !== 'agent.spawn') { const why = vetFleetScope(method, p, deps.caller, { ...deps, paneFacts: deps.paneFacts }); if (why) return why; }
  if (method === 'agent.spawn') {
    const internal = INTERNAL_SPAWN_KEYS.find((k) => p[k] !== undefined && p[k] !== null && p[k] !== false);
    if (internal) return `agent.spawn: "${internal}" is set only by Kora itself`;
    const agent = String(p.agent ?? '');
    if (!GUARDED_AGENTS.has(agent)) return `agent.spawn: an agent may only start ${[...GUARDED_AGENTS].join(', ')} workers, not "${agent.slice(0, 40)}"`;
    const v = vetWorkerArgs(p.args);
    if (v.error) return `agent.spawn: ${v.error}`;
    const orch = typeof p.orchestratorId === 'string' ? p.orchestratorId : undefined;
    if (deps.paneFacts) {
      // A3-9: no unparented panes, and only into the caller's own fleet: a chat fleet (picker below) or the fleet of a pane
      // the USER promoted to orchestrator (agent.promote is control-token only, so an agent cannot make one).
      if (!orch) return 'agent.spawn: a worker needs an orchestrator (--orchestrator <id>): agents may not start unparented panes';
      if (!deps.caller) return 'agent.spawn: a call without the Kora control token must come from a Kora agent (KORA_PANE_ID + KORA_CALLER_KEY)';
      if (orch !== deps.caller) return `agent.spawn: ${orch.slice(0, 60)} is not your fleet`;
      if (!orch.startsWith('chat:') && deps.paneFacts(orch)?.role !== 'orchestrator') return `agent.spawn: ${orch.slice(0, 60)} is not an orchestrator pane`;
    }
    if (v.skips) {
      const mode = deps.modeOf(orch);
      if (mode !== 'full-access' && mode !== 'auto') return `agent.spawn: a worker that skips every permission prompt needs its lead's thread in Full access or Auto (it is ${mode})`;
    }
    // The user picks who works (session/worker-picker.ts). The picker was enforced only inside the fleet-tool process,
    // so an agent could start a worker into its chat thread's fleet with a raw `kora agent spawn --orchestrator chat:<id>`
    // and spend tokens nobody approved (A1 D4). A token-less spawn into a chat fleet now uses up one pick the user
    // approved over the socket (chat.workers.ask), the same way kora_spawn does.
    if (orch?.startsWith('chat:') && deps.takeSpawnApproval && !deps.takeSpawnApproval(orch, agent)) {
      return `agent.spawn: no approved ${agent} pick in this thread. Propose workers with kora_ask_workers first: the user picks who works.`;
    }
    return null;
  }
  if (PANE_TARGET_METHODS.has(method)) {
    const id = p.paneId == null ? '' : String(p.paneId);
    const agent = deps.paneAgent(id);
    if (agent !== undefined && !GUARDED_AGENTS.has(agent)) return `${method}: pane ${id} runs ${agent}, not an agent Kora guards`;
  }
  return null;
}

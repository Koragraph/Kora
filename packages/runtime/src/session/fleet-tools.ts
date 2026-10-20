// The orchestrator's fleet toolset, defined ONCE and agent-neutral.
//
// Two hosts expose it to a model:
//   • ClaudeDriver — as in-process SDK MCP tools (zod shapes), inside the chat thread's query;
//   • `kora mcp --fleet` — as a stdio MCP server (JSON-schema shapes) for agents whose CLI takes MCP servers
//     but has no in-process hook: a Codex orchestrator runs `codex exec -c mcp_servers.kora_fleet…` and its
//     tools reach the SAME runtime over the fleet socket (server/fleet-ops.ts `makeRemoteFleetOps`).
// Every tool answers plain text the model can act on and never throws — a failure is `isError` text, so a dead
// worker cannot take the orchestrator down. Worker spawns derive their launch flags from the WORKER's agent
// adapter (never from a claude-shaped guess) and inherit the orchestrator's model/effort only on the same agent.
import type { AgentId } from '../protocol/types';
import type { ModelChoice, RuntimeMode, ThreadAgentMode } from './events';
import type { WorkerSpawnParams } from './session-driver';
import type { FleetOps, WorkerInfo } from '../server/fleet-ops';
import type { SwarmSpawnParams, SwarmSpawnResult, SwarmTaskRecord } from '../server/swarm';
import { SWARM_THREAD_REQUIRED } from '../server/swarm';
import { failingNames, formatForeman, runCheck, tailOf } from '../server/swarm-foreman';
import { carryOver, digestLine } from '../server/swarm-dynamic';
import { ERROR_STALL_MAX_RETRIES, transientErrorText } from '../server/error-stall';
import { adapterFor } from '../detect/agent-adapter';
import { agentAlias, ApprovedPicks, checkWorker, cliModelId, describePick, loadWorkerCatalog, noSubagentArgs, sameModel, workerCatalogText, type WorkerCatalog, type WorkerPick, type WorkerPickerAnswer } from './worker-picker';
import { isBlobsCwd } from '../blobs/home';
import { desktopClientsNow } from '../server/desktop-clients';
import { GIT_NO_FSMONITOR, gitEnv, isSafeGitRef } from '../util/safe-path';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { markUnsentInput } from './screen-input';
import { delegatePlanOn } from '../server/orchestrator-skill';

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object[]';
  description?: string;
  optional?: boolean;
  enum?: readonly string[];
  /** 'object[]' only: the shape of each element. */
  items?: ParamShape;
}
export type ParamShape = Record<string, ParamSpec>;

export interface FleetToolResult { text: string; isError?: boolean; /** A tool may return one picture (browser_screenshot): base64 data + mime type. Drivers that cannot show it keep the text. */ image?: { data: string; mimeType: string } }

export interface FleetToolSpec {
  name: string;
  description: string;
  params: ParamShape;
  handler(args: Record<string, unknown>): Promise<FleetToolResult>;
}

/** FleetOps with every op async — what the tools consume, so an in-process runtime and a socket look the same. */
export interface FleetControl {
  list(orchestratorId: string): Promise<WorkerInfo[]>;
  prompt(paneId: string, text: string, opts?: { submit?: boolean; waitIdle?: boolean; timeoutMs?: number }): Promise<{ state: string }>;
  wait(paneId: string, until: 'idle' | 'needs-human' | 'blocked' | 'working', timeoutMs: number): Promise<{ state: string; blocker: string | null; timedOut: boolean; exited: boolean }>;
  read(paneId: string, source: 'screen' | 'scrollback', lines?: number): Promise<string>;
  report(paneId: string, turns?: number): Promise<string>;
  kill(paneId: string): Promise<void>;
  mergeVerify(paneIds: string[]): Promise<{ pairs: import('../protocol/types').MergePair[]; order: string[] }>;
  merge(paneId: string, opts?: { into?: string; commitFirst?: boolean }): Promise<{ ok: boolean; conflicts: string[]; message: string; commitsMerged: number }>;
  setPlan(orchestratorId: string, plan: string): Promise<void>;
  drainNotes?(orchestratorId: string): Promise<string[]>;
  /** The live pane for `paneId` after swarm failovers (identity otherwise). Every tool resolves ids through it first. */
  follow?(paneId: string): Promise<string>;
  asleep?(orchestratorId: string): Promise<import('../server/fleet-ops').SleepingWorker[]>;
  wake?(orchestratorId: string, id: string): Promise<{ paneId: string; resumed?: boolean; rebriefed?: boolean }>;
  history?(orchestratorId: string, id: string, maxEntries?: number): Promise<string | null>;
}

/** What the fleet tools need from SwarmService (the `swarm` agent alias). Structural slice of server/swarm.ts. */
export interface SwarmSpawner {
  spawn(p: SwarmSpawnParams): Promise<SwarmSpawnResult>;
  taskForPane(paneId: string): SwarmTaskRecord | null;
  /** The done-checks (kora_spawn check:'…') of this orchestrator's tasks, distinct, newest first; `paneIds` limits it to those workers' tasks. Absent over the remote bridge. */
  checksFor?(orchestratorId: string, paneIds?: string[]): { taskId: string; check: string }[];
  readReport(paneId: string): Promise<{ text: string; truncated: boolean; updatedAt: number } | null>;
  /** (CCR S2-1, additive) The last `[kora] …` failover / exhausted note of the task `paneId` belongs to. */
  note?(paneId: string): string | null;
  /** (CCR S2-1, additive) The task was restored from tasks.json by a new daemon and its pane is gone (journey c). */
  lostInRestart?(paneId: string): boolean;
  /** Dynamic workflow: one progress digest per pane (milestones, changed files, quiet flag). */
  progress?(paneIds: string[]): Promise<import('../server/swarm-dynamic').SwarmProgress[]>;
  /** One-shot: what a daemon restart did to this orchestrator's in-flight tasks (resumed / kept done / dropped). */
  takeRestartDigest?(orchestratorId: string): string | null;
  /** The turn that took the digest never started: the lead's next turn gets it instead. */
  restoreRestartDigest?(orchestratorId: string, digest: string): void;
  /** Tasks that finished before a daemon restart (no pane; worktree kept) — kora_workers lists them (D18). */
  finishedTasks?(orchestratorId: string): import('../protocol/types').SwarmFinishedTask[] | Promise<import('../protocol/types').SwarmFinishedTask[]>;
  /** This orchestrator's queued (not yet started — every slot busy) tasks, FIFO order — kora_workers lists them. */
  queuedTasks?(orchestratorId: string): import('../protocol/types').SwarmQueuedTask[] | Promise<import('../protocol/types').SwarmQueuedTask[]>;
}

/** kora_wait appends at most this much of a swarm report (kora_read / fleet.readReport serve the rest). */
export const SWARM_REPORT_WAIT_CAP = 16_000;
/**
 * By default kora_wait hands the leader a COMPACT report: a report longer than this is cut down to its Status,
 * Changes, Check tail, Findings and Blockers within this budget, and the full file stays on disk for a Read. Every
 * char the leader takes in is re-read on each of its later calls; `full:true` asks for the whole report.
 */
export const SWARM_REPORT_COMPACT_CAP = 3_000;

/** Adapt the in-process FleetOps (synchronous where the runtime answers from memory) to FleetControl. */
export function fleetControlFrom(fleet: FleetOps): FleetControl {
  return {
    list: async (o) => fleet.list(o),
    prompt: (p, t, o) => fleet.prompt(p, t, o),
    wait: (p, u, ms) => fleet.wait(p, u as any, ms),
    read: async (p, s, l) => fleet.read(p, s, l),
    report: async (p, t) => fleet.report(p, t),
    kill: async (p) => { fleet.kill(p); },
    mergeVerify: (ids) => fleet.mergeVerify(ids),
    merge: async (p, o) => fleet.merge(p, o),
    setPlan: async (o, plan) => { fleet.setPlan(o, plan); },
    ...(fleet.drainNotes ? { drainNotes: async (o: string) => fleet.drainNotes!(o) } : {}),
    ...(fleet.follow ? { follow: async (p: string) => fleet.follow!(p) } : {}),
    ...(fleet.asleep ? { asleep: async (o: string) => fleet.asleep!(o) } : {}),
    ...(fleet.wake ? { wake: (o: string, id: string) => fleet.wake!(o, id) } : {}),
    ...(fleet.history ? { history: async (o: string, id: string, n?: number) => fleet.history!(o, id, n) } : {}),
  };
}

export interface FleetToolContext {
  fleet: FleetControl | undefined;
  orchestratorId: string;
  /** The orchestrator thread's own agent, cwd, account, model and permission posture. */
  agent: AgentId;
  cwd: string;
  account: string | null;
  model?: ModelChoice;
  runtimeMode?: RuntimeMode;
  spawnWorker(params: WorkerSpawnParams): Promise<{ id: string; agent: AgentId; account: string | null; /** false: no worktree of its own, it edits the lead's checkout */ worktree?: boolean }>;
  /** The user's latest message in this thread (kora_spawn include_request). */
  lastUserRequest?(): string | null;
  /** True when the user sent this thread a message after `since` (ms epoch). kora_wait polls it and returns early. */
  userMessageSince?(since: number): boolean;
  /** kora_locate: where symptoms/behaviours/symbols live, from the code graph (compact, per query). */
  locate?(queries: string[]): Promise<string>;
  /** kora_plan with slices: the graph's check of a plan (shared files, uncovered callers) before anyone is spawned. */
  planCheck?(slices: { title: string; files: string[]; symbols?: string[] }[]): Promise<string>;
  /** Host hooks for transcript rows (the Claude driver emits worker.attached / worker.detached). */
  onSpawned?(w: { id: string; agent: AgentId; account: string | null; title: string }): void;
  onKilled?(paneId: string): void;
  /** The thread's mode. The `swarm` agent alias is offered only when this is 'swarm'. */
  agentMode?: ThreadAgentMode;
  /** Present on swarm-capable hosts (the in-process runtime). */
  swarm?: SwarmSpawner;
  /**
   * Put the lead's proposed workers to the user (the worker picker popup) and resolve with what they approved.
   * Absent: no UI to ask (tests, a pane orchestrator) — kora_ask_workers then approves the proposal as-is.
   */
  askWorkers?(picks: WorkerPick[]): Promise<WorkerPickerAnswer>;
  /** KORA_HOME override for the worker catalog (tests). */
  koraHome?: string;
  /**
   * A blob thread (Blobs). Its helpers get a self-contained brief and nothing else of the user: the request is NOT pasted
   * above the brief unless asked for (`include_request: true`), `scrubBrief` removes whatever the blob copied from the
   * user's memory / About me, and no more than `maxWorkers` run at once for the thread.
   */
  blobThread?: { maxWorkers: number; scrubBrief?(task: string): string | Promise<string> };
}

/** Why `into` cannot be a kora_merge target (null when absent or fine): it must be a plain branch name, never an option. */
export function badMergeTarget(into: unknown): string | null {
  if (into === undefined || into === null || into === '') return null;
  if (!isSafeGitRef(into) || /\.\.|[~^:?*\[\\]|@\{/.test(into)) return `kora_merge: "into" must be a plain branch name (got ${JSON.stringify(String(into)).slice(0, 80)}) — nothing merged`;
  return null;
}

export const FLEET_TOOL_NAMES = ['kora_ask_workers', 'kora_spawn', 'kora_map', 'kora_workers', 'kora_prompt', 'kora_wait', 'kora_read', 'kora_kill', 'kora_merge_verify', 'kora_merge', 'kora_verify', 'kora_plan', 'kora_open_preview'] as const;

export function formatWorker(w: WorkerInfo): string {
  const sw = w.swarm;
  return `${w.id}  ${workerStateLabel(w)}${w.blocker ? ` (${w.blocker})` : ''}  ${w.agent}${w.account ? '@' + w.account : ''}  "${w.name}"` +
    `${sw ? `  swarm=${sw.model} task=${sw.taskId}${sw.attempt > 1 ? ` attempt=${sw.attempt}` : ''}${sw.phase !== 'running' && sw.phase !== 'starting' ? ` phase=${sw.phase}` : ''}${sw.verify ? ` verify=${sw.verify.state}${sw.verify.bounces ? `(${sw.verify.bounces} bounce${sw.verify.bounces === 1 ? '' : 's'})` : ''}` : ''}` : ''}` +
    `${w.worktree ? `  worktree=${w.worktree.path} branch=${w.worktree.branch}` : `  cwd=${w.cwd} (shared checkout)`}` +
    `${w.costUsd != null ? `  $${w.costUsd.toFixed(2)}` : ''}${w.contextPct != null ? `  ctx ${w.contextPct}%` : ''}${w.exitCode != null ? `  exit=${w.exitCode}` : ''}` +
    `${w.errorStall ? `  API error: "${w.errorStall.line}" — ${w.errorStall.retrying ? `kora sent "continue" (${w.errorStall.retries}/${ERROR_STALL_MAX_RETRIES})` : `auto-continue used ${w.errorStall.retries}/${ERROR_STALL_MAX_RETRIES}; kora_prompt it "continue" or re-dispatch`}` : ''}` +
    `${w.stalled ? `  STALLED? no output for ${Math.round(w.quietMs / 60000)} min while "working" — kora_read source=screen to see, kora_kill if hung` : ''}`;
}

/** A worker's state as the lead reads it: `error-stalled` when its agent stopped on a transient API error (server/error-stall.ts). */
export function workerStateLabel(w: Pick<WorkerInfo, 'state' | 'exited' | 'errorStall'>): string {
  return !w.exited && w.errorStall ? 'error-stalled' : w.state;
}

/** The state a "since you last looked" digest compares: what the lead would act on. */
export function workerLookLabel(w: WorkerInfo): string {
  return w.exited ? 'exited' : w.errorStall ? 'error-stalled' : w.stalled ? 'stalled' : w.state;
}

/**
 * What changed among a lead's workers since its last kora_workers / kora_wait: a worker that went idle, blocked, exited
 * or error-stalled after the lead's turn ended used to be news only if a note happened to get through. `prev` is the
 * last look (undefined = first look: nothing to compare, no lines); `skip` = workers the caller reports on already.
 * Workers that are new since then are the lead's own spawns: not listed. Pure.
 */
export function sinceLastLooked(prev: Map<string, string> | undefined, ws: WorkerInfo[], skip: Set<string> = new Set()): { lines: string[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const lines: string[] = [];
  for (const w of ws) {
    const now = workerLookLabel(w);
    next.set(w.id, now);
    const before = prev?.get(w.id);
    if (before && before !== now && !skip.has(w.id)) lines.push(`${w.id} "${w.name}" ${before} → ${now}`);
  }
  for (const [id, before] of prev ?? []) if (!next.has(id) && !skip.has(id) && before !== 'exited') lines.push(`${id} ${before} → gone (closed or asleep)`);
  return { lines, next };
}
/** Per lead: each worker's label at its last look (module-level: the tool specs are rebuilt per session start). */
const lastLooked = new Map<string, Map<string, string>>();
export function resetLastLookedForTests(): void { lastLooked.clear(); }

/** Launch flags for a worker: permission posture from the thread's runtimeMode, model knobs from the worker's adapter. */
export function workerLaunchArgs(ctx: Pick<FleetToolContext, 'agent' | 'model' | 'runtimeMode'>, agent: AgentId, explicit: { model?: string; effort?: string }, opts: { inherit?: boolean; catalog?: WorkerCatalog } = {}): { args: string[]; model?: string; effort?: string } {
  const a = adapterFor(agent);
  // A pick the user approved launches exactly as chosen ("CLI default" means the CLI's default, not the lead's model).
  const sameAgent = agent === ctx.agent && opts.inherit !== false;
  const model = explicit.model ?? (sameAgent ? ctx.model?.model : undefined);
  const effort = explicit.effort ?? (sameAgent ? ctx.model?.effort ?? undefined : undefined);
  const mode = ctx.runtimeMode;
  const permission = mode === 'full-access' || mode === 'auto' ? a.skipPermissionArgs() : mode === 'auto-accept-edits' ? a.acceptEditsArgs() : [];
  // Workers obey the lead's rule too: no harness-native subagents, only what Kora can show in a pane.
  // argv carries the full id for a Claude alias (cliModelId); the returned `model` stays what the user picked.
  const argvModel = agent === 'claude' && model ? cliModelId(agent, model, opts.catalog ?? loadWorkerCatalog()) : model;
  return { args: [...a.modelArgs(argvModel, effort), ...permission, ...noSubagentArgs(agent)], ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** A CLI worker's line saying it stopped on something it cannot fix itself (mirrors ui-server fleet-service). */
const WORKER_PROBLEM = /usage limit|rate[ -]?limit|quota|insufficient (credit|balance)|billing|unauthori[sz]ed|not logged in|please (log ?in|run \/login)|invalid api key|authentication|overloaded|\bAPI Error\b|panicked|Traceback/i;
const STOPPED_MARK = '⚠ STOPPED';

/** Start-up dialogs the auto-answerer handles (server/autoanswer.ts); kora_wait waits through them. */
const AUTO_ANSWERED_DIALOG = /trust (the contents of )?this (directory|folder)|do you trust|new MCP server/i;
const AUTO_ANSWER_GRACE_MS = 20_000;

/** A locate query counts for a task when they share a significant word; a locate older than this no longer speaks for the lead's plan. */
export const LOCATE_FOCUS_MAX_AGE_MS = 15 * 60_000;
/**
 * The lead's recent kora_locate queries that this task is about, as the task's `focus` (at most 3). Pure.
 * "About" = a shared word of 5+ letters (identifier parts split) between the query and the task text.
 */
export function inferFocus(task: string, locate: { at: number; queries: string[] } | null, now: number): string[] {
  if (!locate || now - locate.at > LOCATE_FOCUS_MAX_AGE_MS) return [];
  const words = (t: string) => new Set((t || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5));
  const taskWords = words(task);
  return locate.queries.filter((q) => { for (const w of words(q)) if (taskWords.has(w)) return true; return false; }).slice(0, 3);
}

/** True when `dir` sits inside a git checkout (a `.git` dir or file up the tree): only then can a worker get a worktree. */
export function insideGitCheckout(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** The kora_spawn note for a worker that shares the lead's folder: no git checkout, or none Kora could branch (no worktree, no merge). */
export function sharedFolderNote(cwd: string, workerId: string, othersSharing: number, inCheckout = false): string {
  const why = inCheckout ? `${workerId} got no worktree of its own (worktrees are off, the repository has no commits yet, or creating one failed)` : `${cwd} is not a git repository, so ${workerId} has no worktree`;
  return `\nNOTE: ${why}: it edits the same files as you${othersSharing ? ` and ${othersSharing} other worker(s) here` : ''}, and kora_merge has nothing to merge. Give each worker files no one else touches, or tell it to create its own git worktree in the repo it changes and work only there.`;
}

const gitRun = (cwd: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile('git', [...GIT_NO_FSMONITOR, ...args], { cwd, encoding: 'utf8', timeout: 8_000, maxBuffer: 1 << 20, env: gitEnv() }, (err, out) => resolve(err ? null : String(out ?? '').trim()));
});
/** HEAD of the checkout a merge lands in (null outside a git repo or on any error): taken BEFORE kora_merge. */
export async function mergeHead(cwd: string): Promise<string | null> { return gitRun(cwd, ['rev-parse', 'HEAD']); }
/**
 * A short, bounded git summary of what the merge(s) just landed (`before..HEAD`): commit count, files, +/-, and up to six
 * subjects. The lead used to run `git log` / `git diff --stat` in Bash for this (22% of leader calls were Bash re-runs,
 * LEADER-TOKENS.md); now the kora_merge answer carries it. Empty string when there is nothing to say.
 */
export async function mergeGitSummary(cwd: string, before: string | null): Promise<string> {
  try {
    if (!before) return '';
    const after = await gitRun(cwd, ['rev-parse', 'HEAD']);
    if (!after || after === before) return '';
    const [log, stat] = await Promise.all([
      gitRun(cwd, ['log', '--format=%h %s', '-n', '7', `${before}..${after}`]),
      gitRun(cwd, ['diff', '--shortstat', before, after]),
    ]);
    const subjects = (log ?? '').split('\n').filter(Boolean);
    if (!subjects.length && !stat) return '';
    const more = subjects.length > 6 ? ' (+ more)' : '';
    const st = (stat ?? '').replace(/ files? changed/, ' file(s)').replace(/ insertions?\(\+\)/, '+').replace(/ deletions?\(-\)/, '-').replace(/,\s*/g, ' ').trim();
    return `git: ${before.slice(0, 7)}..${after.slice(0, 7)}${st ? ` — ${st}` : ''}${more}\n${subjects.slice(0, 6).map((l) => `  ${l.slice(0, 100)}`).join('\n')}`;
  } catch { return ''; }
}

/** kora_verify's answer for one finished check. Bounded: names ≤10, tail ≤600 chars. */
export function formatVerifyResult(command: string, r: { state: string; exitCode: number | null; durationMs: number; tail: string; output?: string }): string {
  const secs = `${(r.durationMs / 1000).toFixed(1)} s`;
  const cmd = command.length > 90 ? `${command.slice(0, 87)}…` : command;
  if (r.state === 'passed') return `PASS  ${cmd}  (${secs})`;
  const { names, total } = failingNames(r.output ?? r.tail);
  const why = r.state === 'timeout' ? 'timed out' : r.state === 'error' ? 'did not run' : `exit ${r.exitCode}`;
  const failing = names.length ? ` — ${total} failing: ${names.join('; ')}${total > names.length ? '; …' : ''}` : '';
  const tail = tailOf(r.tail || '', 8, 600);
  return `FAIL  ${cmd}  (${why}, ${secs})${failing}${tail ? `\n${tail.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}`;
}

export function fleetToolSpecs(ctx: FleetToolContext): FleetToolSpec[] {
  const need = (): FleetControl => { if (!ctx.fleet) throw new Error('fleet control is not available in this runtime'); return ctx.fleet; };
  const swarmMode = ctx.agentMode === 'swarm';
  let lastLocate: { at: number; queries: string[] } | null = null;
  const defaultAgent = swarmMode && ctx.swarm ? 'swarm' : 'claude';
  // Every paneId argument is resolved through follow() first: a swarm worker's old id (before a failover) keeps
  // meaning "that task's live worker" for the leader.
  const follow = async (paneId: string): Promise<string> => { try { return (await ctx.fleet?.follow?.(paneId)) || paneId; } catch { return paneId; } };
  // A swarm pane that is no longer listed: lost in a daemon restart (journey c), exhausted, or finished and reaped.
  const gone = (paneId: string): string | null => {
    const rec = ctx.swarm?.taskForPane(paneId);
    if (!rec || rec.orchestratorId !== ctx.orchestratorId) return null;
    const note = ctx.swarm?.note?.(paneId) ?? null;
    // Still queued (no pane yet): not gone, just not started — a decision-free state, distinct from every other case.
    if (rec.status === 'queued') return `swarm task ${rec.taskId} is queued (every slot is busy) — it starts automatically; kora_wait ${rec.taskId} to block for it, or kora_workers to see its position;`;
    if (ctx.swarm?.lostInRestart?.(paneId)) return `worker ${paneId} was lost in a daemon restart (swarm task ${rec.taskId});`;
    if (rec.status === 'exhausted') return note ?? `swarm task ${rec.taskId} failed on every free model. Rewrite or split it.`;
    return `worker ${paneId} (swarm task ${rec.taskId}) is no longer running (${rec.status});${note ? ` ${note}` : ''}`;
  };
  const goneWithReport = async (paneId: string, full = true): Promise<string | null> => {
    if (!ctx.swarm) return null;
    // Report first: over the remote bridge it is also what fills taskForPane's cache — a lead whose `kora mcp --fleet`
    // came back after a daemon restart knew no task and answered "no worker p11 in this fleet" (D18).
    const rep = await ctx.swarm.readReport(paneId).catch(() => null);
    const head = gone(paneId);
    if (!head) return null;
    const rec = ctx.swarm!.taskForPane(paneId);
    return `${head} report (if written): ${rep?.text.trim() ? (full || !rec ? capReport(rep.text, rep.truncated) : compactReport(rep.text, rec.reportPath, rep.truncated)) : '(none)'}`;
  };
  const own = async (paneId: string): Promise<WorkerInfo> => {
    const w = (await need().list(ctx.orchestratorId)).find((x) => x.id === paneId);
    if (!w) throw new Error(gone(paneId) ?? `no worker ${paneId} in this fleet (see kora_workers)`);
    return w;
  };
  const listed = async (paneId: string): Promise<boolean> => (await need().list(ctx.orchestratorId)).some((x) => x.id === paneId);
  /** A worker that went to sleep (record id `w_…`, or the pane id it had): its history, or null when it is not one. */
  const asleepHistory = async (id: string): Promise<string | null> => {
    if (!ctx.fleet?.history || (await listed(id))) return null;
    try { return await ctx.fleet.history(ctx.orchestratorId, id); } catch { return null; }
  };
  // Out-of-band notes queued while the turn runs (a steer / block / exit) ride along on the tools the model is
  // already polling with, so it learns of them in-turn instead of only after the turn settles.
  /** "Since you last looked: …" for this lead (and remember this look). */
  const lookDigest = (ws: WorkerInfo[], skip: string[] = []): string => {
    const { lines, next } = sinceLastLooked(lastLooked.get(ctx.orchestratorId), ws, new Set(skip));
    lastLooked.set(ctx.orchestratorId, next);
    return lines.length ? `Since you last looked: ${lines.join('; ')}` : '';
  };
  const withNotes = async (t: string): Promise<string> => {
    const notes = await ctx.fleet?.drainNotes?.(ctx.orchestratorId);
    return notes?.length ? `${t}\n\n${notes.join('\n\n')}` : t;
  };
  const text = (t: string, isError = false): FleetToolResult => ({ text: t, ...(isError ? { isError: true } : {}) });
  const wrap = (fn: (a: Record<string, any>) => Promise<FleetToolResult>) => async (a: Record<string, unknown>): Promise<FleetToolResult> => {
    try { return await fn(a ?? {}); } catch (e: any) { return text(`${e?.message ?? e}`, true); }
  };
  const num = (v: unknown, d: number) => (v == null || v === '' ? d : Number(v));

  const spawnSwarmOne = async (a: Record<string, any>): Promise<{ paneId: string | null; taskId: string; queued: boolean; text: string }> => {
    const title = String(a.title ?? (a.prompt ? String(a.prompt).split('\n')[0].slice(0, 60) : 'swarm')).trim() || 'swarm';
    const permission = typeof a.permission === 'string' && a.permission ? a.permission as SwarmSpawnParams['permission'] : undefined;
    // The user's request rides along by default (include_request:false opts out): a lead that retypes the spec or pastes
    // source into the task spends its most expensive tokens (output) on what the worker can read itself (bench5x).
    let prompt = String(a.prompt ?? '');
    // continues:<paneId> — replace a worker: carry over what it learned (milestones, changes, report), then stop it.
    if (a.continues && ctx.swarm?.progress) {
      const prevId = await follow(String(a.continues));
      const [prev] = await ctx.swarm.progress([prevId]).catch(() => []);
      const rep = await ctx.swarm.readReport(prevId).catch(() => null);
      prompt = `${prompt}\n\n${carryOver({ paneId: prevId, milestones: prev?.milestones ?? [], changedFiles: prev?.changedFiles ?? [], report: rep?.text ? compactReport(rep.text, '', rep.truncated) : null })}`;
      try { await need().kill(prevId); ctx.onKilled?.(prevId); } catch { /* already gone */ }
    }
    // A blob's helper gets the brief the blob wrote (self-contained), not the user's whole message: what the user typed is
    // theirs, and "my wife's birthday is..." has no business on a free model unless the task needs it.
    const wantsRequest = ctx.blobThread ? a.include_request === true : a.include_request !== false;
    let task = withUserRequest(prompt, wantsRequest ? ctx.lastUserRequest?.() ?? null : null, { split: a.__batchSize > 1 });
    if (ctx.blobThread?.scrubBrief) task = await ctx.blobThread.scrubBrief(task);
    let focus = Array.isArray(a.focus) ? a.focus.map(String).filter(Boolean).slice(0, 5) : [];
    // No explicit focus: the lead's own kora_locate queries that this task is about become its focus (the worker's packet then
    // starts at the declarations the lead already found, with no extra graph work on the lead's side).
    if (!focus.length && !ctx.blobThread) focus = inferFocus(task, lastLocate, Date.now());
    const r = await ctx.swarm!.spawn({ orchestratorId: ctx.orchestratorId, cwd: ctx.cwd, task, title, ...(focus.length ? { focus } : {}), ...(a.race ? { race: String(a.race) } : {}), ...(ctx.runtimeMode ? { runtimeMode: ctx.runtimeMode } : {}), ...(permission ? { permission } : {}), ...(a.check ? { check: String(a.check) } : {}), ...(a.queue ? { queue: true } : {}), ...(ctx.blobThread ? { maxConcurrent: ctx.blobThread.maxWorkers } : {}) });
    if (r.queued) {
      // Over maxWorkers, queued instead of refused: a stable task id now, a pane once a slot frees.
      return { paneId: null, taskId: r.taskId, queued: true, text: `queued swarm task ${r.taskId} "${title}" — every slot is busy; it starts automatically as soon as one frees (position ${r.queuePosition ?? '?'}). kora_wait ${r.taskId} blocks for it, or kora_workers to see its position.` };
    }
    // The worker program the daemon actually launched (D31: a Koragent worker was labelled "opencode").
    ctx.onSpawned?.({ id: r.paneId!, agent: (r.agent ?? 'opencode') as AgentId, account: null, title });
    const warn = r.overlaps.map((o) => `⚠ overlaps ${o.paneId} (${o.files.slice(0, 5).join(', ')}${o.files.length > 5 ? `, +${o.files.length - 5}` : ''}) — consider sequencing`).join('\n');
    const fm = r.foreman;
    const fmLine = fm ? `\nforeman: ${fm.check ? `done-check \`${fm.check}\`, ` : ''}${fm.review ? 'reviewer on, ' : ''}up to ${fm.maxAttempts} attempt${fm.maxAttempts === 1 ? '' : 's'} before you hear a failure${fm.checkRefused ? `\n⚠ ${fm.checkRefused}` : ''}` : '';
    return { paneId: r.paneId, taskId: r.taskId, queued: false, text: `spawned swarm worker ${r.paneId} (task ${r.taskId}, ${r.modelLabel} via ${r.provider}) "${title}" ${r.sharedFolder ? 'in this folder itself (not a git repo: no worktree, so it shares files with you and any other worker — give parallel workers different files, or run them one at a time)' : 'in its own worktree'}. It writes its report to ${r.reportPath}; kora_wait ${r.paneId} returns the report.${fmLine}${warn ? `\n${warn}` : ''}` };
  };
  /**
   * kora_spawn in a swarm thread: one task (prompt) or a batch (tasks:[…]) spawned in order in ONE leader call, and
   * with wait:"all"|"any" the wait rides on the same call. A refusal mid-batch (pool full, not ready) stops the batch
   * and says which tasks did not start.
   */
  const spawnSwarm = async (a: Record<string, any>): Promise<FleetToolResult> => {
    if (!ctx.swarm || !swarmMode) return text(`${SWARM_THREAD_REQUIRED}. This thread is ${ctx.agentMode ?? 'not a swarm thread'} — use agent:"claude"/"codex", or ask the user to switch to Swarm.`, true);
    const batch: Record<string, any>[] = Array.isArray(a.tasks) && a.tasks.length ? a.tasks.filter((x: unknown) => x && typeof x === 'object') : [a];
    // Over maxWorkers: queue instead of refusing on assistant-lane threads (no pane orchestrator's own cwd to isolate,
    // and a Chat lead routinely fans out more items than the worker cap — journey: kora_map with 8 items).
    const autoQueue = isBlobsCwd(ctx.cwd);
    const lines: string[] = []; const ids: string[] = [];
    let refused: string | null = null;
    for (let i = 0; i < batch.length; i++) {
      if (!String(batch[i].prompt ?? '').trim()) { lines.push(`task ${i + 1}: no prompt — skipped`); continue; }
      try { const r = await spawnSwarmOne({ ...batch[i], permission: batch[i].permission ?? a.permission, include_request: batch[i].include_request ?? a.include_request, race: batch[i].race ?? a.race, queue: autoQueue, __batchSize: batch.length }); ids.push(r.paneId ?? r.taskId); lines.push(r.text); }
      catch (e: any) {
        if (batch.length === 1) throw e;
        refused = `${e?.message ?? e}`;
        lines.push(`task ${i + 1}${batch.length - i > 1 ? `–${batch.length}` : ''} NOT spawned: ${refused}`);
        break;
      }
    }
    if (!ids.length) return text(lines.join('\n') || 'nothing to spawn: give prompt, or tasks:[{prompt, title}]', true);
    let out = lines.join('\n');
    if (a.wait === 'all' || a.wait === 'any') {
      const deadline = Date.now() + Math.min(num(a.timeoutMs, 300_000), 600_000);
      const o = { deadline, full: a.full === true };
      out += `\n\n${ids.length === 1 ? await waitOne(ids[0], o) : await waitMany(ids, a.wait, o)}`;
      return text(await withNotes(out));
    }
    return text(out);
  };

  /** The swarm part of a kora_wait answer: verify line, then the report (or the screen tail when there is none). */
  const swarmTail = async (w: WorkerInfo, state: string, full = false): Promise<string> => {
    const sw = w.swarm!;
    let out = '';
    if (sw.verify && sw.verify.state !== 'pending') out += `\nverify: ${sw.verify.state}${sw.verify.bounces ? ` after ${sw.verify.bounces} bounce${sw.verify.bounces === 1 ? '' : 's'}` : ''}${sw.verify.summary ? ` — ${sw.verify.summary}` : ''}`;
    const fm = formatForeman(sw.foreman);
    if (fm) out += `\n${fm}`;
    // An escalation is the whole answer: the report of a rejected attempt is one kora_read away, not in the leader's context.
    if (sw.foreman?.result?.kind === 'escalation') return `${out}\n(report: kora_read ${w.id})`;
    const rep = await ctx.swarm!.readReport(w.id).catch(() => null);
    if (rep && rep.text.trim()) {
      const ago = Math.max(0, Math.round((Date.now() - rep.updatedAt) / 1000));
      const body = full ? capReport(rep.text, rep.truncated) : compactReport(rep.text, sw.reportPath, rep.truncated);
      out += `\n--- report ${sw.taskId} (${sw.reportPath}, ${(Buffer.byteLength(rep.text) / 1024).toFixed(1)} KB, written ${ago}s ago) ---\n${body}`;
      return out;
    }
    if (state === 'idle' || state === 'exited') {
      // Journey l: SwarmService already nudged it once; hand Claude what the worker shows instead of nothing.
      let tail = '';
      try { tail = (await need().read(w.id, 'screen', 30)).trim(); } catch { /* reaped */ }
      if (!full) tail = compactScreen(tail);
      out += `\n(no report file — screen tail)\n${tail || '(blank screen)'}\n(kora_prompt it: "write your report to ${sw.reportPath} now")`;
    }
    return out;
  };

  type WaitOpts = { until?: unknown; deadline: number; full: boolean; stop?: () => boolean };
  /** paneId / paneIds → a de-duplicated id list (paneIds wins when both are given). */
  const waitIds = (a: Record<string, any>): string[] => {
    const raw: unknown[] = Array.isArray(a.paneIds) && a.paneIds.length ? a.paneIds : a.paneId != null && a.paneId !== '' ? [a.paneId] : [];
    return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  };
  /** One worker's kora_wait answer (without the drained notes). Throws for a pane that is not in this fleet. */
  /**
   * kora_wait mode:"event": return at the first thing the lead should react to — a milestone, a worker finishing or
   * failing, a worker going quiet — with one digest line per worker (and the compact report of any that finished).
   */
  const eventWait = async (asked: string[], deadline: number, full = false, untilAll = false): Promise<string> => {
    const ids = await Promise.all(asked.map(follow));
    const TERMINAL = new Set(['done', 'failed', 'exhausted']);
    // Wake the lead only for a decision: a finish/failure, a quiet worker, or a rejected/stuck milestone. Informational
    // milestones (reproduced, root-cause, fixed, note) ride along in the digest; each wake-up re-reads the lead's whole
    // context (bench5x Z2: 25 lead calls, most of them wake-ups it only answered with another wait).
    const DECIDE = new Set(['rejected', 'stuck']);
    const key = (p: import('../server/swarm-dynamic').SwarmProgress) => `${p.phase}|${p.milestones.filter((m) => DECIDE.has(m.kind)).length}|${p.quiet}`;
    const first = await ctx.swarm!.progress!(ids);
    // Panes Kora cannot track as live swarm tasks (restored, gone, not swarm): the classic wait answers them.
    if (first.length < ids.length) return ids.length === 1 ? waitOne(ids[0], { deadline, full }) : waitMany(ids, 'any', { deadline, full });
    const seen = new Map(first.map((p) => [p.taskId, key(p)]));
    const blocked = async (): Promise<string[]> => {
      try { return (await need().list(ctx.orchestratorId)).filter((w) => ids.includes(w.id) && w.state === 'blocked').map((w) => w.id); } catch { return []; }
    };
    let cur = first;
    let changed = cur.filter((p) => !TERMINAL.has(p.phase) && p.quiet);
    let stuck = await blocked();
    while (!changed.length && !stuck.length && Date.now() < deadline && !cur.every((p) => TERMINAL.has(p.phase))) {
      await new Promise((r) => setTimeout(r, 3000));
      cur = await ctx.swarm!.progress!(ids);
      changed = cur.filter((p) => seen.get(p.taskId) !== key(p));
      // untilAll (mode:"all" in Swarm mode): a worker merely finishing is not a reason to wake the lead yet.
      if (untilAll) changed = changed.filter((p) => !TERMINAL.has(p.phase) || p.phase !== 'done');
      stuck = await blocked();
    }
    // A worker that finished or needs a human gets the full classic answer (foreman verdict, compact report, blocker)
    // first; everyone else is one digest line.
    const finished = cur.filter((p) => TERMINAL.has(p.phase) && (seen.get(p.taskId) !== key(p) || cur.every((x) => TERMINAL.has(x.phase))));
    const full_: string[] = [];
    // Answer under the id the lead asked for (a respawn mid-wait moves the task to a new pane: "p1 → p2").
    const askedByTask = new Map(first.map((p, i) => [p.taskId, asked[i] ?? p.paneId]));
    const targets = [...stuck.map((id) => ({ id, ask: askedByTask.get(cur.find((p) => p.paneId === id)?.taskId ?? '') ?? id })), ...finished.map((p) => ({ id: p.paneId, ask: askedByTask.get(p.taskId) ?? p.paneId }))];
    const answered = new Set<string>();
    for (const x of targets) { if (answered.has(x.id)) continue; answered.add(x.id); full_.push(await waitOne(x.ask, { deadline: Date.now() + 1500, full })); }
    const rest = cur.filter((p) => !finished.includes(p) && !stuck.includes(p.paneId));
    const events = changed.filter((p) => !finished.includes(p));
    const parts = [...full_];
    if (rest.length) parts.push([events.length ? `event (${events.map((p) => p.paneId).join(', ')}):` : 'still working:', ...rest.map(digestLine)].join('\n'));
    if (!parts.length) parts.push(['no event before the timeout:', ...cur.map(digestLine)].join('\n'));
    return parts.join('\n\n');
  };

  /** kora_wait's wait in every mode, without the notes (the handler drains those once, for whichever answer wins). */
  const waitForWorkers = async (a: Record<string, any>, ids: string[]): Promise<string> => {
    const deadline = Date.now() + Math.min(num(a.timeoutMs, 300_000), 600_000);
    const opts = { until: a.until, deadline, full: a.full === true };
    // Swarm leads steer on events by default (bench5x Z1: a lead that waited on one worker at a time and polled
    // kora_workers spent 8 of its 26 calls on it); mode:"all"/"any" still ask for the old behaviour.
    const eventMode = a.mode === 'event' || (a.mode == null && a.until == null && swarmMode && !!ctx.swarm?.progress);
    if (eventMode && ctx.swarm?.progress) return eventWait(ids, deadline, a.full === true);
    // Swarm "all": wait for everyone, but still wake for a decision (rejected, stuck, quiet, blocked) — a lead
    // that waited 10 min on "all" never saw its workers loop on a merge gate (bench5x Z4).
    if (a.mode === 'all' && a.until == null && swarmMode && ctx.swarm?.progress && ids.length > 1) return eventWait(ids, deadline, a.full === true, true);
    if (ids.length === 1) return waitOne(ids[0], opts);
    return waitMany(ids, a.mode === 'any' ? 'any' : 'all', opts);
  };
  /** Resolves once the user sends a message after `since` (polled); never resolves on hosts without the hook. */
  const userMessageDuring = (since: number): { promise: Promise<void>; cancel(): void } => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const promise = new Promise<void>((resolve) => {
      const check = ctx.userMessageSince;
      if (!check) return;
      const tick = () => {
        if (cancelled) return;
        if (check(since)) resolve();
        else timer = setTimeout(tick, USER_MESSAGE_POLL_MS);
      };
      tick();
    });
    return { promise, cancel: () => { cancelled = true; if (timer) clearTimeout(timer); } };
  };
  const userInterruptAnswer = async (ids: string[]): Promise<string> => {
    const ws = await need().list(ctx.orchestratorId).catch(() => [] as WorkerInfo[]);
    const lines = await Promise.all(ids.map(async (asked) => {
      const live = await follow(asked);
      const w = ws.find((x) => x.id === live);
      return `${asked}${live !== asked ? ` → ${live}` : ''}: ${w ? (w.exited ? 'exited' : w.state) : 'not listed'}`;
    }));
    return `[kora] the user sent you a message, so this wait stopped early — answer them now (their message arrives with this result). The workers keep running; kora_wait them again afterwards.\n${lines.join('\n')}`;
  };

  const waitOne = async (asked: string, o: WaitOpts): Promise<string> => {
    // A queued swarm task (over maxWorkers, no pane yet): block here — within THIS wait's own deadline — until a
    // slot frees and it starts, instead of answering "gone" for a task that never got a turn.
    if (ctx.swarm) {
      for (;;) {
        const rec = ctx.swarm.taskForPane(asked);
        if (!rec || rec.status !== 'queued') break;
        if (Date.now() >= o.deadline || o.stop?.()) return `${asked}: still queued (every slot is busy) — kora_wait ${asked} again, or kora_workers to see its position.`;
        await sleep(Math.min(500, Math.max(1, o.deadline - Date.now())));
      }
    }
    let id = await follow(asked);
    if (!(await listed(id))) { const g = await goneWithReport(id, o.full); if (g) return g; }
    const slept = await asleepHistory(id);
    if (slept) return `${slept}\n(asleep — nothing to wait for; kora_prompt ${id} wakes it)`;
    await own(id);
    // "until idle" also returns on BLOCKED: a worker parked on a permission dialog will never reach idle until
    // someone answers, and an orchestrator that waits for idle sat out the full 5-minute timeout twice while
    // both its workers asked for approval. A blocked worker is a decision to make, not a wait to continue.
    const until = o.until === 'idle' ? 'needs-human' : (o.until ?? 'needs-human');
    const left = () => Math.max(1, o.deadline - Date.now());
    const autoGraceUntil = Date.now() + AUTO_ANSWER_GRACE_MS;
    let r: Awaited<ReturnType<FleetControl['wait']>>;
    let w: WorkerInfo | undefined;
    for (;;) {
      r = await need().wait(id, until as any, left());
      // Journey d: a swarm worker failed over while we waited — the old pane "exited", but the task lives on in its
      // replacement. Follow it instead of reporting a false EXITED.
      for (let hop = 0; hop < 8 && r.exited; hop++) {
        const next = await follow(id);
        if (next === id) break;
        id = next;
        r = await need().wait(id, until as any, left());
      }
      w = (await need().list(ctx.orchestratorId)).find((x) => x.id === id);
      // A start-up dialog Kora answers by itself (trust this folder, a new MCP server) is not a decision for the lead:
      // returning "blocked" there handed a lead nothing to read, and it invented the worker's answer. Keep waiting.
      if (!w?.swarm && r.state === 'blocked' && AUTO_ANSWERED_DIALOG.test(r.blocker ?? '') && Date.now() < autoGraceUntil && Date.now() < o.deadline && !o.stop?.()) {
        await sleep(Math.min(750, left()));
        continue;
      }
      // A swarm worker that has not CONFIRMED working yet (or is being replaced) has done nothing: OpenCode's start-up
      // screen reads as idle, and a wait issued right after the spawn (kora_spawn wait:"all") returned at once with
      // no report — the leader then spent calls re-prompting workers that were about to start.
      if (!w?.swarm || w.exited || !SWARM_NOT_STARTED.has(w.swarm.phase) || Date.now() >= o.deadline || o.stop?.()) break;
      await sleep(Math.min(SWARM_START_POLL_MS, left()));
      id = await follow(id);
    }
    // X2: a report under verification (or bounced back to the worker) is not an answer yet — Claude hears passes,
    // or failures left after the bounces are spent. Foreman: nor is anything before its verdict (done-check,
    // retries on the same or a new worker, reviewer) — Claude hears PASS or a short escalation.
    const fmBusy = (x: WorkerInfo | undefined) => { const f = x?.swarm?.foreman; return !!f && f.state !== 'passed' && f.state !== 'escalated' && !['exhausted', 'failed', 'done'].includes(x!.swarm!.phase); };
    const verifying = (x: WorkerInfo | undefined) => !!x?.swarm && !x.exited && (x.swarm.verify?.state === 'pending' || x.swarm.verify?.state === 'bounced' || fmBusy(x));
    const rework = (x: WorkerInfo) => x.swarm!.verify?.state === 'bounced' || fmBusy(x);
    const relist = async () => (await need().list(ctx.orchestratorId)).find((x) => x.id === id);
    while (Date.now() < o.deadline && !o.stop?.()) {
      // A foreman retry on a new model replaces the pane (like a failover): follow it.
      if (!w || w.exited || w.swarm?.supersededBy) {
        const next = await follow(id);
        if (next === id) break;
        id = next; w = await relist();
        r = { state: w?.state === 'exited' ? 'idle' : (w?.state ?? r.state), blocker: w?.blocker ?? null, timedOut: false, exited: !!w?.exited };
        continue;
      }
      if (!verifying(w)) break;
      if (w.state === 'blocked') break; // needs a human: a decision, not a wait
      if (rework(w) && w.state === 'working') r = await need().wait(id, until as any, left());
      else await sleep(Math.min(SWARM_VERIFY_POLL_MS, left()));
      w = await relist();
    }
    const hopLine = asked !== id && w?.swarm ? `${followLine(asked, id, w)}\n` : '';
    if (!w) { const g = await goneWithReport(id, o.full); if (g) return `${hopLine}${g}`; }
    const timedOut = r.timedOut || verifying(w);
    let out = `${hopLine}${id}: ${r.exited ? 'exited' : w?.errorStall ? 'error-stalled' : r.state}${r.blocker ? ` (${r.blocker})` : ''}${timedOut ? ' — timed out, still running' : ''}${w ? `\n${formatWorker(w)}` : ''}`;
    if (w?.swarm && ctx.swarm) out += await swarmTail(w, r.exited ? 'exited' : r.state, o.full);
    else if (w && !timedOut && (r.state === 'idle' || r.exited)) out += await cliWorkerTail(id, w);
    return out;
  };
  /** A CLI worker that finished: what it said (its last message), or — no transcript, e.g. it failed before
   *  answering — the end of its screen, so an error ("usage limit", "auth") reaches the lead instead of a bare "idle". */
  const cliWorkerTail = async (id: string, w?: WorkerInfo): Promise<string> => {
    try {
      // Stopped on a transient API error with the auto-continue spent: its last message is NOT an answer.
      const es = w && !w.exited ? w.errorStall : null;
      if (es && !es.retrying) return `\n${STOPPED_MARK} error-stalled — its agent stopped on a transient API error: ${es.line}\nkora already sent "continue" ${es.retries}/${ERROR_STALL_MAX_RETRIES} time(s). kora_prompt ${id} "continue" to try again, or re-dispatch the task.`;
      const rep = (await need().report(id, 1)).trim();
      if (rep) return `\n--- worker's last message ---\n${rep.length > 4000 ? `${rep.slice(0, 4000)}\n… (kora_read for the rest)` : rep}`;
      const rows = markUnsentInput(await need().read(id, 'screen')).split('\n').map((l) => l.trimEnd()).filter(Boolean);
      const problem = [...rows].reverse().find((l) => WORKER_PROBLEM.test(l))?.trim();
      const screen = rows.slice(-12).join('\n');
      const head = problem ? `\n${STOPPED_MARK} on an error — it will not continue on its own: ${problem}\nRe-dispatch the task (kora_ask_workers → another agent or model) or tell the user; ask them before doing it yourself on their own tokens.` : '';
      return screen ? `${head}\n--- no answer in its transcript; end of its screen ---\n${screen}` : head;
    } catch { return ''; }
  };
  /**
   * Several workers in ONE leader call. Every leader call re-reads its whole context, so N workers waited one by one
   * cost N calls; 'all' costs one. 'any' returns at the first finished worker and lists where the others stand.
   */
  const waitMany = async (ids: string[], mode: 'all' | 'any', o: WaitOpts): Promise<string> => {
    const one = (id: string, oo: WaitOpts) => waitOne(id, oo).catch((e: any) => `${id}: ${e?.message ?? e}`);
    if (mode === 'all') {
      // Every worker — but a worker that STOPPED on an error (usage limit, auth, …) wakes the lead at once: waiting
      // on the others while one task is dead only wastes the lead's time.
      let stop = false;
      const oo: WaitOpts = { ...o, stop: () => stop };
      const results = new Map<string, string>();
      const dead = await new Promise<string | null>((resolve) => {
        let left = ids.length;
        for (const id of ids) {
          void one(id, oo).then((t) => {
            results.set(id, t);
            if (t.includes(STOPPED_MARK)) resolve(id);
            if (--left === 0) resolve(null);
          });
        }
      });
      if (!dead) return ids.map((id) => results.get(id)!).join('\n\n');
      stop = true;
      const ws = await need().list(ctx.orchestratorId).catch(() => [] as WorkerInfo[]);
      const others = ids.filter((id) => id !== dead).map((id) => results.has(id) && !results.get(id)!.includes('timed out')
        ? results.get(id)!
        : `${id}: ${(() => { const w = ws.find((x) => x.id === id); return w ? (w.exited ? 'exited' : w.state) : 'not listed'; })()} — still going (kora_wait it next)`);
      return [`Returned early — ${dead} stopped on an error:`, results.get(dead)!, ...others].join('\n\n');
    }
    let stopped = false;
    const oo: WaitOpts = { ...o, stop: () => stopped };
    const first = await Promise.race(ids.map((id) => one(id, oo).then((t) => ({ id, t }))));
    stopped = true;
    const ws = await need().list(ctx.orchestratorId).catch(() => [] as WorkerInfo[]);
    const rest: string[] = [];
    for (const id of ids) {
      if (id === first.id) continue;
      const live = await follow(id);
      const w = ws.find((x) => x.id === live);
      rest.push(`${id}${live !== id ? ` → ${live}` : ''}: ${w ? `${w.exited ? 'exited' : w.state}${w.swarm?.verify ? ` (verify ${w.swarm.verify.state})` : ''}` : 'not listed'}`);
    }
    return `${first.t}${rest.length ? `\n\nstill waiting on (kora_wait them next):\n${rest.join('\n')}` : ''}`;
  };

  /** kora_merge paneIds:[…] — the verify → merge → merge … sequence as ONE leader call. */
  /** A swarm task of this fleet that finished before a daemon restart: no pane, its worktree still merges (D18). */
  const finishedBeforeRestart = async (id: string): Promise<SwarmTaskRecord | null> => {
    if (!ctx.swarm || (await listed(id))) return null;
    await ctx.swarm.readReport(id).catch(() => null); // refreshes the remote bridge's task cache
    const rec = ctx.swarm.taskForPane(id);
    return rec && rec.orchestratorId === ctx.orchestratorId && rec.status === 'done' ? rec : null;
  };
  const mergeMany = async (a: Record<string, any>): Promise<FleetToolResult> => {
    const badInto = badMergeTarget(a.into); if (badInto) return text(badInto, true);
    const ids = [...new Set(await Promise.all((a.paneIds as unknown[]).map((p) => follow(String(p)))))];
    const ws = await need().list(ctx.orchestratorId);
    const lines: string[] = [];
    const withTree: string[] = [];
    const finished: string[] = [];
    for (const id of ids) {
      const w = ws.find((x) => x.id === id);
      if (!w && (await finishedBeforeRestart(id))) finished.push(id);
      else if (!w) lines.push(`${id}: ${gone(id) ?? 'no such worker in this fleet'} — skipped`);
      else if (!w.worktree) lines.push(`${id}: works in the shared checkout — nothing to merge`);
      else withTree.push(id);
    }
    let order = withTree;
    if (withTree.length > 1) {
      const r = await need().mergeVerify(withTree);
      const bad = r.pairs.filter((p) => p.status === 'semantic' || p.status === 'needs-human');
      if (bad.length) {
        const why = bad.map((p) => `${p.a} × ${p.b}: ${p.status}${p.reason ? ` — ${p.reason}` : ''}${p.blame?.length ? `\n${p.blame.slice(0, 6).map((b) => `    ${b.file}:${b.line}  ${b.symbol}  (${b.removed ? 'removed' : 'changed'} by ${b.byWorker})`).join('\n')}` : ''}`);
        return text(`NOT merged — kora_merge_verify found ${bad.length} colliding pair(s); fix the callers (or re-prompt the later worker), or merge the clean ones one by one:\n${why.join('\n')}`, true);
      }
      order = [...r.order.filter((id) => withTree.includes(id)), ...withTree.filter((id) => !r.order.includes(id))];
      lines.push(`verify: ${r.pairs.length} pair(s) clean`);
    }
    // Tasks that finished before a restart first (they have no pane for the pair gate; git reports any conflict).
    order = [...finished, ...order];
    for (const id of order) {
      const r = await need().merge(id, { commitFirst: a.commitFirst !== false, into: a.into });
      lines.push(`${id}: ${r.ok ? 'merged' : 'NOT merged'}: ${r.message}${r.conflicts.length ? `\nconflicts: ${r.conflicts.join(', ')}` : ''}${r.commitsMerged ? ` (${r.commitsMerged} commit(s))` : ''}`);
      if (!r.ok) { const rest = order.slice(order.indexOf(id) + 1); if (rest.length) lines.push(`stopped; not merged: ${rest.join(', ')}`); return text(lines.join('\n'), true); }
    }
    return text(lines.join('\n'));
  };

  // What the user approved in the worker picker; each kora_spawn of a CLI worker uses one up.
  const approved = new ApprovedPicks();
  // Workers this lead started in its own folder because that folder is no git checkout (they share every file).
  const sharedFolderWorkers: string[] = [];
  const catalogBlock = workerCatalogText(loadWorkerCatalog(ctx.koraHome));
  const specs: FleetToolSpec[] = [
    // Stretch (the Swarm toggle): the free tier is kora_spawn agent:"swarm"; this picker is the paid-cheap fallback tier
    // (Claude Haiku, Codex Luna), approved without a picker and clamped to those models (session-manager askWorkers).
    ...([{
      name: 'kora_ask_workers',
      description: swarmMode && ctx.swarm ? 'Stretch fallback ONLY: when kora_spawn agent:"swarm" has no free worker, or a task failed on every free model, propose cheap paid workers for those slices — agent claude (Haiku 5.5) or codex (GPT Luna); any other pick is replaced. Approved automatically, no picker. Then kora_spawn exactly those.' : `Before delegating, propose your workers — one row per task: which CLI (agent), model and effort you suggest, and why in a few words. Kora shows the user a picker pre-filled with your proposal over every model they have; they approve or change it (usually one click) and this returns what they approved. Then kora_spawn exactly those. Suggest the cheapest model that can do each slice: a planned, bounded slice (rename, one-file edit with its sites given, docs, running tests and reporting, reading and summarizing) runs well on Claude Haiku 5.5 (about 1/20 of Sonnet 5.5 per token); normal coding on Sonnet 5.5 at medium effort (on Kora's own tasks it passed as often as high at about 4/5 of the cost); Opus only for hard reasoning (twice Sonnet's price). Any agent may run any other (Claude can run Codex workers and vice versa). Never pass one CLI's model id to another.\nInstalled (* = that CLI's default):\n${catalogBlock || '  claude, codex: models: their CLI default'}`,
      params: {
        tasks: { type: 'object[]', items: { title: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string', optional: true }, effort: { type: 'string', optional: true }, why: { type: 'string', optional: true } }, description: 'one per worker you want to start' } as ParamSpec,
      },
      handler: wrap(async (a: Record<string, any>) => {
        const catalog = loadWorkerCatalog(ctx.koraHome);
        const raw: any[] = Array.isArray(a.tasks) ? a.tasks : [];
        if (!raw.length) return text('kora_ask_workers needs tasks:[{title, agent, model?, effort?, why?}]', true);
        // A proposal is fixed up, not refused: an impossible model becomes the CLI default, a missing effort is dropped.
        const proposal: WorkerPick[] = raw.slice(0, 12).map((t, i) => {
          const agent = agentAlias(String(t?.agent ?? 'claude')) || 'claude';
          // A full claude id the catalog lists under an alias ("claude-haiku-4-5-…" → "haiku") shows as that model.
          const asked = t?.model ? String(t.model) : undefined;
          const listed = asked ? catalog.agents[agent]?.models.find((m) => m.id === asked || (m.id !== 'default' && sameModel(agent, m.id, asked))) : undefined;
          const c = checkWorker({ agent, model: listed?.id ?? asked, effort: t?.effort }, catalog, true);
          const ok = c.ok ? c : checkWorker({ agent }, catalog, true);
          return {
            title: String(t?.title ?? `task ${i + 1}`).trim().slice(0, 80) || `task ${i + 1}`,
            agent,
            ...(ok.ok && ok.model ? { model: ok.model } : {}),
            ...(ok.ok && ok.effort ? { effort: ok.effort } : {}),
            ...(t?.why ? { why: String(t.why).slice(0, 160) } : {}),
          };
        });
        const answer: WorkerPickerAnswer = ctx.askWorkers ? await ctx.askWorkers(proposal) : { picks: proposal, auto: true };
        if (answer.cancelled || !answer.picks.length) return text('The user declined these workers. Do not delegate this — do it yourself, or ask the user what they want instead.');
        const checked = answer.picks.map((p) => ({ p, c: checkWorker(p, catalog, true) }));
        const picks = checked.filter((x) => x.c.ok).map((x) => x.p);
        const impossible = checked.filter((x) => !x.c.ok).map((x) => `"${x.p.title}" (${x.c.ok ? '' : x.c.error})`);
        // Never "The user approved:" over an empty list: the lead then looped approve → spawn refused (live).
        if (!picks.length) return text(`None of the approved workers can run on this machine: ${impossible.join('; ')}. Do not retry this pick — do the work yourself, or ask the user which installed worker to use.`, true);
        approved.add(picks);
        const dropped = proposal.filter((p) => !answer.picks.some((q) => q.title === p.title)).map((p) => p.title);
        return text([
          answer.auto ? 'Approved as proposed (the user lets you pick in this thread):' : 'The user approved:',
          ...picks.map((p, i) => `  ${i + 1}. "${p.title}" → ${describePick(p)}`),
          ...(dropped.length ? [`Removed by the user (do not spawn): ${dropped.join(', ')}`] : []),
          ...(impossible.length ? [`Cannot run here (not spawned): ${impossible.join('; ')}`] : []),
          'Now kora_spawn each of these with its agent (and model); Kora launches the model and effort shown here.',
        ].join('\n'));
      }),
    }]),
    {
      name: 'kora_spawn',
      description: swarmMode && ctx.swarm
        ? 'Spawn workers in their own panes + worktrees beside this chat. In Swarm mode the default agent is swarm: a cheap-model worker (Koragent or OpenCode; Kora picks the model, fails over on rate limits, and returns its report through kora_wait). For a code change, paste the full requirements into the prompt and give the repo test command as check. Give each a self-contained prompt and a short title. Batch: tasks:[{prompt,title},…] spawns several in one call; wait:"all" also waits for them in the same call.'
        : `Start a worker the user approved with kora_ask_workers: a real CLI agent (Claude Code, Codex, …) in its own pane beside this chat that the user can watch and steer (returns its paneId). This is the ONLY way to delegate — the harness's own subagents are off. Pass the agent (and model) of an approved pick; Kora launches it with the model and effort the user chose. A spawn with no matching approved pick is refused — ask first. Give it a self-contained prompt and a short title; kora_wait for its report.`,
      params: {
        agent: swarmMode && ctx.swarm
          ? { type: 'string', optional: true, description: 'swarm (DEFAULT: free models via opencode — Kora picks the model). Fallback tier: claude | codex, only a pick approved by kora_ask_workers (cheap paid workers)' }
          : { type: 'string', description: 'the agent of an approved pick (kora_ask_workers): claude | codex | …' },
        prompt: swarmMode && ctx.swarm ? { type: 'string', optional: true, description: 'one task (or use tasks)' } : { type: 'string' },
        title: { type: 'string', optional: true, description: 'short slice name shown on the pane' },
        ...(swarmMode && ctx.swarm ? {
          tasks: { type: 'object[]', optional: true, items: { prompt: { type: 'string' }, title: { type: 'string', optional: true }, check: { type: 'string', optional: true }, include_request: { type: 'boolean', optional: true }, focus: { type: 'string[]', optional: true }, race: { type: 'string', optional: true }, continues: { type: 'string', optional: true }, permission: { type: 'string', optional: true, enum: ['supervised', 'auto-edits', 'full'] } }, description: 'swarm: several tasks spawned in this one call (instead of prompt); each may carry its own done-check and permission' } as ParamSpec,
          permission: { type: 'string', optional: true, enum: ['supervised', 'auto-edits', 'full'], description: 'swarm: what workers may do without asking a human (default: this orchestrator\'s own mode; never above it). supervised = every edit/command waits for approval; auto-edits workers still wait for a human before running ANY command (tests, builds), so leave this unset unless the task is edit-only' } as ParamSpec,
          wait: { type: 'string', optional: true, enum: ['all', 'any'], description: 'swarm: also wait in this call — all workers, or the first to finish — and return their compact reports' } as ParamSpec,
          timeoutMs: { type: 'number', optional: true, description: 'with wait (default 300000, max 600000)' } as ParamSpec,
        } : {}),
        model: { type: 'string', optional: true, description: "the model of the approved pick you are starting (Kora launches the user's choice either way; ignored for swarm)" },
        effort: { type: 'string', optional: true, description: 'ignored for CLI workers: the approved pick\'s effort is used' },
        account: { type: 'string', optional: true },
        worktree: { type: 'boolean', optional: true, description: 'isolate in a git worktree (default: auto; swarm workers always get one)' },
        ...(swarmMode && ctx.swarm ? {
          focus: { type: 'string[]' as const, optional: true, description: 'swarm: where to look — symbols, files or a behaviour you found with kora_locate (≤5). Kora resolves them in the code graph and puts the declarations at the top of the task, so the worker starts at the right spot.' },
          race: { type: 'string' as const, optional: true, description: 'swarm: race group. Give several tasks the same race key (different hypotheses for one problem): the first to post root-cause/fixed or pass its check wins and Kora stops the rest.' },
          continues: { type: 'string' as const, optional: true, description: 'swarm: paneId of a worker to REPLACE (quiet, stuck or off-track): its milestones, changes and report are carried into the new task, then it is stopped.' },
        } : {}),
        ...(swarmMode && ctx.swarm ? { include_request: { type: 'boolean' as const, optional: true, description: 'swarm only (default true): Kora pastes the user\'s latest message verbatim at the top of every task, so write only what to add (this task\'s scope in a split, the check). Never repeat the spec or paste source code; the worker reads the repo itself. false: send your prompt alone.' } } : {}),
        ...(swarmMode && ctx.swarm ? { check: { type: 'string' as const, optional: true, description: 'swarm only: a shell command that proves the task is done (e.g. "pnpm test -- foo.test.ts"), run in the worker\'s worktree (90 s budget, exit 0 = pass). Kora retries a failing worker automatically before kora_wait answers.' } } : {}),
      },
      handler: wrap(async (a) => {
        const agentArg = String(a.agent || defaultAgent);
        if (agentArg === 'swarm') return spawnSwarm(a);
        // One worker pool per thread: a Swarm thread delegates to swarm workers only.
        // tasks:[…] is the swarm batch form; a claude/codex worker is one kora_spawn per approved pick (it used to be dropped
        // silently and start ONE worker with no task: found live 2026-10-19).
        if (Array.isArray(a.tasks) && a.tasks.length) return text(`tasks:[…] only works with agent:"swarm". For agent ${agentArg}, call kora_spawn once per worker (each uses one approved pick), with its own prompt and title.`, true);
        const agent = agentAlias(agentArg) as AgentId;
        // Bench only (scripts/lead-bench): KORA_MAX_LIVE_WORKERS=n refuses a spawn while n of this lead's workers are running. Unset = no cap.
        const cap = Number(process.env.KORA_MAX_LIVE_WORKERS);
        if (Number.isInteger(cap) && cap > 0 && ctx.fleet) {
          const live = (await ctx.fleet.list(ctx.orchestratorId).catch(() => [])).filter((w) => w.state === 'working' || w.state === 'blocked').length;
          if (live >= cap) return text(`kora_spawn refused: ${live} workers are running; kora_wait for one first`, true);
        }
        // The user picks who works: only a pick approved in the worker picker may start, on the model they chose.
        const pick = approved.take(agent, a.model ? String(a.model) : undefined);
        if (!pick) {
          const left = approved.unused();
          return text(`kora_spawn refused: no approved pick for ${agent}${a.model ? ` ${a.model}` : ''}. ${left.length ? `Still approved: ${left.map((p) => `"${p.title}" → ${describePick(p)}`).join('; ')}.` : 'Call kora_ask_workers with your plan first — the user picks the models.'}`, true);
        }
        const resolved = checkWorker({ agent, model: pick.model, effort: pick.effort }, loadWorkerCatalog(ctx.koraHome), true);
        if (!resolved.ok) { approved.release(pick); return text(`kora_spawn refused: ${resolved.error}`, true); }
        const launch = workerLaunchArgs(ctx, agent, { model: resolved.model, effort: resolved.effort }, { inherit: false });
        const title = String(a.title ?? (a.prompt ? String(a.prompt).split('\n')[0].slice(0, 60) : agent)).trim() || agent;
        let worker: Awaited<ReturnType<typeof ctx.spawnWorker>>;
        try {
          worker = await ctx.spawnWorker({ agent, cwd: ctx.cwd, prompt: a.prompt, account: a.account ?? ctx.account, worktree: a.worktree, orchestratorId: ctx.orchestratorId, args: launch.args, name: title });
        } catch (e) { approved.release(pick); throw e; }
        ctx.onSpawned?.({ ...worker, title });
        let shared = '';
        // From what the spawn did, not from the folder: a repo with no commits, a `.git` git does not accept, a symlink out
        // of a checkout or worktrees turned off all left a worker in the lead's files with no word of it (test/fleet 2026-10-14).
        if (worker.worktree === false || (worker.worktree === undefined && !insideGitCheckout(ctx.cwd))) {
          shared = sharedFolderNote(ctx.cwd, worker.id, sharedFolderWorkers.length, insideGitCheckout(ctx.cwd));
          sharedFolderWorkers.push(worker.id);
        }
        return text(`spawned worker ${worker.id} (${worker.agent}${launch.model ? `, ${launch.model}` : ''}${launch.effort ? ` ${launch.effort}` : ''}) "${title}". It is reading your prompt now; kora_wait on it or continue dispatching.${shared}`);
      }),
    },
    ...(swarmMode && ctx.swarm ? [{
      name: 'kora_map',
      description: 'Swarm: apply ONE template to many similar items, one worker per item (max 24 per call). template must contain {{item}} — Kora substitutes each entry of items in turn. Use this instead of many separate kora_spawn calls when the tasks are the same shape (summarize each URL, check each file against a rule, look up each name, …).',
      params: {
        template: { type: 'string', description: 'the task text, with {{item}} where each item goes' },
        items: { type: 'string[]', description: 'up to 24 items; extra ones are not spawned (call kora_map again for the rest)' },
        title: { type: 'string', optional: true, description: 'short label prefix shown on each pane (default: the item itself)' },
      },
      handler: wrap(async (a: Record<string, any>) => {
        if (!ctx.swarm || !swarmMode) return text(`${SWARM_THREAD_REQUIRED}. This thread is ${ctx.agentMode ?? 'not a swarm thread'}.`, true);
        const template = String(a.template ?? '');
        if (!template.includes('{{item}}')) return text('kora_map: template must contain {{item}}', true);
        const items = (Array.isArray(a.items) ? a.items : []).map((x: unknown) => String(x)).filter((x: string) => x.trim().length > 0);
        if (!items.length) return text('kora_map needs items:[…]', true);
        const capped = items.slice(0, 24);
        // Never refused for a full pool: every item over maxWorkers is QUEUED instead, and starts as a slot frees
        // (this is the whole point of kora_map — one call, up to 24 items, whatever the worker cap is).
        const started: { taskId: string; paneId: string }[] = [];
        const queued: string[] = [];
        const errors: string[] = [];
        for (const item of capped) {
          const prompt = template.split('{{item}}').join(item);
          const title = String(a.title ?? '').trim() ? `${String(a.title).trim()}: ${item}`.slice(0, 60) : item.slice(0, 60);
          try {
            const r = await spawnSwarmOne({ prompt, title, queue: true, __batchSize: capped.length });
            if (r.paneId) started.push({ taskId: r.taskId, paneId: r.paneId }); else queued.push(r.taskId);
          } catch (e: any) {
            const doneSoFar = started.length + queued.length + errors.length;
            const remaining = capped.length - doneSoFar;
            errors.push(`"${item.slice(0, 60)}"${remaining > 1 ? ` and ${remaining - 1} more` : ''} NOT spawned: ${e?.message ?? e}`);
            break; // a hard refusal (not-ready, no prompt, …) repeats for every later item — stop instead of spamming it
          }
        }
        const skipped = items.length > capped.length ? `\n${items.length - capped.length} item(s) over the 24 cap were not spawned — call kora_map again with the rest.` : '';
        const total = started.length + queued.length;
        const parts: string[] = [];
        if (started.length) parts.push(`${started.map((s) => `${s.taskId}→${s.paneId}`).join(', ')} running`);
        if (queued.length) parts.push(`${queued.join(', ')} queued (start as slots free)`);
        const summary = total ? `${total} task${total === 1 ? '' : 's'}: ${parts.join('; ')}.${queued.length ? ' kora_wait them all.' : ''}` : '';
        const ids = [...started.map((s) => s.paneId), ...queued];
        const hint = ids.length ? `\n\nkora_wait paneIds:[${ids.map((i) => `"${i}"`).join(', ')}] mode:"all" to collect them.` : '';
        const out = [summary, ...errors].filter(Boolean).join('\n');
        return text(`${out}${skipped}${hint}`, total === 0);
      }),
    } as FleetToolSpec] : []),
    ...(swarmMode && ctx.swarm && ctx.locate ? [{
      name: 'kora_locate',
      description: 'Swarm: where things live, from the code graph, WITHOUT reading code. Make ONE call with every query you have (a symptom, a behaviour or a symbol each, up to 8); it returns the top declarations (file:line) per query. Use the answers as kora_spawn focus. A weak hit is fine: the worker confirms it; do not re-query to perfect it.',
      params: { queries: { type: 'string[]', description: 'up to 8: symptoms, behaviours or symbol names' } },
      handler: wrap(async (a: Record<string, any>) => {
        const queries = Array.isArray(a.queries) ? a.queries.map(String) : [String(a.queries ?? '')];
        lastLocate = { at: Date.now(), queries: queries.map((q) => q.trim()).filter(Boolean).slice(0, 8) };
        return text(await ctx.locate!(queries));
      }),
    } as FleetToolSpec] : []),
    {
      name: 'kora_workers',
      description: 'What every worker is up to right now: state (working / idle / blocked / exited), what is on its screen, whether it stopped on an error, its worktree and cost. Call this whenever the user asks how the workers are doing, or before waiting on one.',
      params: {},
      handler: wrap(async () => {
        const ws = await need().list(ctx.orchestratorId);
        // One "now:" line per live CLI worker from its screen — the last meaningful line, or the error it stopped on.
        const nowLine = async (w: WorkerInfo): Promise<string> => {
          if (w.swarm || w.exited || w.errorStall) return ''; // error-stalled: formatWorker already says what and what kora did
          try {
            const rows = (await need().read(w.id, 'screen')).split('\n').map((l) => l.replace(/[│┃╭╮╰╯─]+/g, ' ').trim()).filter((l) => l.length > 2);
            // A transient API error still on the screen of a WORKING worker was got past (kora's auto-continue or a retry).
            const problem = [...rows].reverse().find((l) => WORKER_PROBLEM.test(l) && !(w.state === 'working' && transientErrorText(l)));
            if (problem) return `\n    ${STOPPED_MARK} on an error — not continuing: ${problem.slice(0, 200)}`;
            const last = [...rows].reverse().find((l) => !/^[›❯>]\s*$|^\?|shortcuts|bypass permissions|Ask Codex to do anything/i.test(l));
            return last ? `\n    now: ${last.slice(0, 160)}` : '';
          } catch { return ''; }
        };
        const now = await Promise.all(ws.map(nowLine));
        const digest = lookDigest(ws);
        const fin = (await Promise.resolve(ctx.swarm?.finishedTasks?.(ctx.orchestratorId)).catch(() => [])) ?? [];
        const queued = (await Promise.resolve(ctx.swarm?.queuedTasks?.(ctx.orchestratorId)).catch(() => [])) ?? [];
        const lines = [
          ...ws.map((w, i) => formatWorker(w) + now[i]),
          ...queued.map((q) => `${q.taskId}  queued  position ${q.position} of ${queued.length}  "${q.title}" — starts as a slot frees; kora_wait ${q.taskId}`),
          ...fin.filter((f) => !ws.some((w) => w.id === f.paneId)).map((f) => `${f.paneId}  finished before a daemon restart  swarm task=${f.taskId} phase=${f.status}  worktree=${f.worktree} branch=${f.branch} — kora_wait ${f.paneId} returns its report; kora_merge ${f.paneId} lands it`),
        ];
        // Asleep after work (10 min idle): no process, no folder — the answer, changes and transcript are kept.
        const asleep = (await Promise.resolve(ctx.fleet?.asleep?.(ctx.orchestratorId)).catch(() => [])) ?? [];
        for (const w of asleep) {
          const mins = Math.max(1, Math.round((Date.now() - w.sleptAt) / 60_000));
          lines.push(`${w.recordId}  asleep ${mins} min (was ${w.lastPaneId})  ${w.agent}  "${w.title}"${w.ahead ? `  ${w.ahead} commit(s) on ${w.branch ?? '(branch deleted)'}` : ''}${w.finalReport ? `\n    answered: ${w.finalReport.replace(/\s+/g, ' ').slice(0, 160)}` : ''}\n    kora_read ${w.recordId} for its answer + transcript; kora_prompt ${w.recordId} wakes it${w.canResume ? ' (same session)' : ''}`);
        }
        if (digest) lines.unshift(digest);
        return text(await withNotes(lines.length ? lines.join('\n') : 'no workers yet'));
      }),
    },
    {
      name: 'kora_prompt',
      description: 'Send a worker further instructions (typed into its pane and submitted). Waits until the worker is idle first unless waitIdle=false. A worker asleep after work (kora_workers lists it) is woken first: same session, same branch.',
      params: { paneId: { type: 'string' }, text: { type: 'string' }, waitIdle: { type: 'boolean', optional: true }, timeoutMs: { type: 'number', optional: true } },
      handler: wrap(async (a) => {
        let id = await follow(String(a.paneId));
        // A worker asleep after work is woken first (same session resumed, its folder restored from its branch).
        let woke = '';
        if (!(await listed(id)) && ctx.fleet?.wake && (await asleepHistory(id))) {
          const w = await ctx.fleet.wake(ctx.orchestratorId, id);
          // Say what really happened: a session that could not be resumed is a fresh one (the lead must not assume memory).
          woke = `woke ${id} as ${w.paneId} (${w.resumed === false ? (w.rebriefed ? 'its session could not be resumed: this is a FRESH session on the same branch, and its original brief was re-sent first' : 'its session could not be resumed: this is a FRESH session with no memory of the task; say what it is working on') : 'its session resumed'}); `;
          id = w.paneId;
        }
        await own(id);
        const r = await need().prompt(id, String(a.text), { waitIdle: a.waitIdle !== false, timeoutMs: Math.min(num(a.timeoutMs, 120_000), 600_000) });
        return text(`${woke}delivered to ${id}; it is now ${r.state}`);
      }),
    },
    {
      name: 'kora_wait',
      description: swarmMode && ctx.swarm
        ? 'Wait for workers: paneIds:[…] waits for ALL of them in one call (mode:"any" returns at the first to finish) — prefer one kora_wait over one per worker. Returns when idle (done), needing a human, or exited; bounded by timeoutMs (default 300000, max 600000). A swarm worker\'s report comes back compact (status, changes, check, findings, blockers; full:true for the whole file) and is followed across rate-limit failovers. "[kora] …" notes that arrived meanwhile are appended.'
        : 'Wait until a worker is idle (done with its current turn), needs a human, or exits. Bounded by timeoutMs (default 300000, max 600000). A swarm worker\'s report is appended (it is followed across rate-limit failovers). Any "[kora] …" notes that arrived meanwhile (a steer, a block, an exit) are appended. paneIds:[…] waits for several in one call.',
      params: {
        paneId: { type: 'string', optional: true },
        paneIds: { type: 'string[]', optional: true, description: 'several workers in one call (instead of paneId)' },
        mode: { type: 'string', optional: true, enum: ['all', 'any', 'event'], description: 'event (DEFAULT in Swarm mode: return at the first milestone, finish or quiet flag, with a one-line digest per worker — the steering loop), all (wait for every worker), any (first finished)' },
        until: { type: 'string', optional: true, enum: ['idle', 'needs-human', 'blocked', 'working'] },
        timeoutMs: { type: 'number', optional: true },
        full: { type: 'boolean', optional: true, description: 'swarm: the whole report instead of the compact one' },
      },
      handler: wrap(async (a) => {
        const ids = waitIds(a);
        if (!ids.length) return text('kora_wait needs paneId or paneIds', true);
        // The human speaking ends the wait at once: a lead blocked here otherwise answers only after the timeout
        // (up to 10 min — the SDK hands it the message only when this tool returns). The abandoned wait runs on
        // to its own deadline in the background; the workers are untouched.
        const user = userMessageDuring(Date.now());
        const answer = waitForWorkers(a, ids);
        answer.catch(() => {});
        const first = await Promise.race([answer.then((t) => ({ t })), user.promise.then(() => null)]);
        user.cancel();
        // The other workers' changes since the lead last looked: one may have finished or stalled while it waited here.
        const digest = await need().list(ctx.orchestratorId).then((ws) => lookDigest(ws, ids), () => '');
        const out = await withNotes(`${first ? first.t : await userInterruptAnswer(ids)}${digest ? `\n\n${digest}` : ''}`);
        // A swarm worker blocked on a permission prompt in a thread that is not Full access / Auto is waiting for the HUMAN.
        const attended = ctx.runtimeMode !== 'full-access' && ctx.runtimeMode !== 'auto';
        return text(swarmMode && attended && /: blocked\b|\bBLOCKED\b/.test(out) ? `${out}\n\n[kora] A blocked swarm worker is waiting for the user's approval (this thread is not in Full access). Do NOT answer its prompt or type "Allow" into it. Tell the user in one line which worker needs approval, then wait for the others or stop.` : out);
      }),
    },
    {
      name: 'kora_read',
      description: "Read a worker. source 'report' (DEFAULT) is what it SAID — its last assistant message(s) in full, from its transcript (a swarm worker: its report file); use this to collect results. 'screen' is the visible terminal (what it is doing right now, and what a blocked worker is asking). 'scrollback' is near-useless for a coding agent: its TUI owns the alternate screen, so anything above the viewport is already gone — never ask a worker to write a file just to hand you its output.",
      params: { paneId: { type: 'string' }, source: { type: 'string', optional: true, enum: ['report', 'screen', 'scrollback'] }, lines: { type: 'number', optional: true, description: 'screen/scrollback: lines' }, turns: { type: 'number', optional: true, description: 'report: how many trailing assistant messages (default 1)' } },
      handler: wrap(async (a) => {
        const id = await follow(String(a.paneId));
        if (!(await listed(id))) { const g = await goneWithReport(id); if (g) return text(g); }
        // Asleep after work: its record has the final answer, its changes and its whole transcript.
        const slept = await asleepHistory(id);
        if (slept) return text(`${slept}\n(asleep — kora_prompt ${id} wakes it and resumes its session)`);
        await own(id);
        const source = (a.source ?? 'report') as 'report' | 'screen' | 'scrollback';
        if (source === 'report') {
          const rep = await need().report(id, a.turns != null ? Number(a.turns) : 1);
          if (rep.trim()) return text(rep);
          const screen = markUnsentInput(await need().read(id, 'screen', a.lines != null ? Number(a.lines) : undefined));
          return text(screen.trim() ? `(no transcript yet — showing the screen)\n${screen}` : '(nothing yet)');
        }
        const raw = await need().read(id, source, a.lines != null ? Number(a.lines) : undefined);
        const out = source === 'screen' ? markUnsentInput(raw) : raw;
        return text(out.trim() ? out : '(blank screen)');
      }),
    },
    {
      name: 'kora_kill',
      description: 'Stop a worker (its worktree and branch are kept).',
      params: { paneId: { type: 'string' } },
      handler: wrap(async (a) => {
        const asked = String(a.paneId);
        const id = await follow(asked);
        // Asleep after work: there is no process — say so instead of "no worker" (its branch and session are kept).
        if (!(await listed(id)) && (await asleepHistory(id))) return text(`${id} is asleep — no process to stop. Its branch and session are kept; kora_prompt ${id} would wake it.`);
        await own(id); await need().kill(id); ctx.onKilled?.(id);
        return text(`killed ${id}${id !== asked ? ` (was ${asked})` : ''}`);
      }),
    },
    {
      name: 'kora_merge_verify',
      description: "Graph pre-merge gate across workers' worktrees: pairs of workers whose changes collide semantically (git would merge them clean), plus a suggested merge order. Does not merge.",
      params: { paneIds: { type: 'string[]', optional: true, description: 'default: every worker with a worktree' } },
      handler: wrap(async (a) => {
        const ids: string[] = Array.isArray(a.paneIds) && a.paneIds.length ? await Promise.all(a.paneIds.map((p: unknown) => follow(String(p)))) : (await need().list(ctx.orchestratorId)).filter((w) => w.worktree).map((w) => w.id);
        if (ids.length < 2) return text(`only ${ids.length} worker(s) with a worktree — nothing to cross-check; merge them one by one with kora_merge`);
        const r = await need().mergeVerify(ids);
        const lines = r.pairs.map((p) => `${p.a} × ${p.b}: ${p.status}${p.reason ? ` — ${p.reason}` : ''}${p.blame?.length ? '\n' + p.blame.slice(0, 12).map((b) => `    ${b.file}:${b.line}  ${b.symbol}  (${b.removed ? 'removed' : 'changed'} by ${b.byWorker}${b.kind === 'reference' ? ', new reference' : ''}${b.inHunk ? ', on a line the other side edited' : ''})`).join('\n') + (p.blame.length > 12 ? `\n    … ${p.blame.length - 12} more` : '') : ''}`);
        const semantic = r.pairs.filter((p) => p.status === 'semantic').length, human = r.pairs.filter((p) => p.status === 'needs-human').length;
        const verdict = !r.pairs.length ? 'no pairs' : semantic ? `${semantic} semantic conflict(s): git would merge these clean but the composition breaks — fix the callers (or re-prompt the later worker) BEFORE merging that pair` : human ? `${human} pair(s) need a human look` : 'all pairs clean — merge in the suggested order';
        return text(`${verdict}\n${lines.join('\n')}\nsuggested merge order: ${r.order.join(' → ') || '(none)'}`);
      }),
    },
    {
      name: 'kora_merge',
      description: "Merge one worker's worktree branch into the main checkout (commits the worker's uncommitted work first unless commitFirst=false). paneIds:[…] merges several in one call: it runs kora_merge_verify across them first, merges nothing if any pair collides, else merges all in the suggested order (stopping at the first failure).",
      params: { paneId: { type: 'string', optional: true }, paneIds: { type: 'string[]', optional: true, description: 'several workers: verify, then merge all in order' }, commitFirst: { type: 'boolean', optional: true }, into: { type: 'string', optional: true } },
      handler: wrap(async (a) => {
        // `into` is model-written and becomes `git checkout <into>` in the user's checkout: a plain branch name only.
        const badInto = badMergeTarget(a.into); if (badInto) return text(badInto, true);
        if (Array.isArray(a.paneIds) && a.paneIds.length > 1) return mergeMany(a);
        const one = Array.isArray(a.paneIds) && a.paneIds.length ? a.paneIds[0] : a.paneId;
        if (one == null || one === '') return text('kora_merge needs paneId or paneIds', true);
        const id = await follow(String(one));
        // A swarm task that finished before a daemon restart: no pane, but its worktree merges like any other (D18).
        {
          const rec = await finishedBeforeRestart(id);
          if (rec) {
            const r = await need().merge(id, { commitFirst: a.commitFirst !== false, into: a.into });
            return text(`${r.ok ? 'merged' : 'NOT merged'} (swarm task ${rec.taskId}, finished before a restart): ${r.message}${r.conflicts.length ? `\nconflicts: ${r.conflicts.join(', ')}` : ''}${r.commitsMerged ? ` (${r.commitsMerged} commit(s))` : ''}`, !r.ok);
          }
        }
        const w = await own(id);
        if (!w.worktree) return text(`${id} works in the shared checkout — its changes are already in place, nothing to merge`);
        const r = await need().merge(id, { commitFirst: a.commitFirst !== false, into: a.into });
        return text(`${r.ok ? 'merged' : 'NOT merged'}: ${r.message}${r.conflicts.length ? `\nconflicts: ${r.conflicts.join(', ')}` : ''}${r.commitsMerged ? ` (${r.commitsMerged} commit(s))` : ''}`, !r.ok);
      }),
    },
    {
      name: 'kora_verify',
      description: "Run the done-checks you gave kora_spawn (check:'…') against the main checkout, once: PASS/FAIL per check, the failing test names and a short tail. Use it after kora_merge instead of re-running tests in Bash. paneIds:[…] limits it to those workers' checks; default: every check of this thread's tasks (distinct, at most 3).",
      params: { paneIds: { type: 'string[]', optional: true, description: 'default: every check of this thread' } },
      handler: wrap(async (a) => {
        if (!ctx.swarm?.checksFor) return text('kora_verify is not available over this bridge: run the project\'s test command yourself, once.', true);
        // The check is a command the lead wrote at kora_spawn time and the user never approved. In a thread that asks before running
        // commands, running it here would skip that question (S6 2026-10-14): the lead runs the project's tests in Bash and is asked.
        if (ctx.runtimeMode === 'approval-required' || ctx.runtimeMode === 'auto-accept-edits') return text('kora_verify is off in a thread that asks before running commands: run the project\'s test command yourself in Bash, once (the user will be asked).', true);
        const ids: string[] | undefined = Array.isArray(a.paneIds) && a.paneIds.length ? await Promise.all(a.paneIds.map((p: unknown) => follow(String(p)))) : undefined;
        const checks = ctx.swarm.checksFor(ctx.orchestratorId, ids).slice(0, 3);
        if (!checks.length) return text('kora_verify: no done-check was recorded for these tasks (kora_spawn check:"<command>" records one). Run the project\'s test command yourself, once.', true);
        const lines: string[] = [];
        let failed = 0;
        for (const c of checks) {
          const r = await runCheck(c.check, ctx.cwd, 120_000, { keepOutput: true });
          if (r.state !== 'passed') failed++;
          lines.push(formatVerifyResult(c.check, r));
        }
        return text(`kora_verify: ${failed ? `FAIL (${failed} of ${checks.length} check${checks.length === 1 ? '' : 's'} failed)` : `PASS (${checks.length} check${checks.length === 1 ? '' : 's'})`} in ${ctx.cwd}\n${lines.join('\n')}`);
      }),
    },
    {
      name: 'kora_plan',
      description: 'Publish or refresh the fleet plan the human sees beside the workers (numbered slices, owner, status). Replaces the previous plan.',
      params: { plan: { type: 'string' }, slices: { type: 'object[]', optional: true, items: { title: { type: 'string' }, files: { type: 'string[]' }, symbols: { type: 'string[]', optional: true } }, description: 'optional, for the graph check: [{ title, files: [paths], symbols: [names] }] per slice; the answer lists shared files and callers no slice covers' } },
      handler: wrap(async (a) => {
        await need().setPlan(ctx.orchestratorId, String(a.plan ?? ''));
        if (Array.isArray(a.slices) && a.slices.length && ctx.planCheck) return text(`plan published\n${await ctx.planCheck(a.slices as any)}`);
        return text('plan published');
      }),
    },
    {
      name: 'kora_open_preview',
      description: 'Ask the Kora desktop app to show a web page in the in-app browser beside this chat — a dev server you started, a mock or draft you served on localhost, docs. http(s) only. The answer says whether a desktop window could show it; when it can\'t, give the user the link instead.',
      params: { url: { type: 'string', description: 'http:// or https:// URL, e.g. http://localhost:5173' } },
      handler: wrap(async (a) => {
        const url = String(a.url ?? '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) return text('kora_open_preview needs an http(s) url', true);
        return text(openPreviewAck(url, desktopClientsNow()));
      }),
    },
  ];
  // The answer of kora_merge ends with a short git summary of what landed (commits, files, +/-), so the lead never runs
  // `git log` / `git diff --stat` itself. Taken from HEAD before/after, so it is empty when nothing merged.
  const mergeSpec = specs.find((t) => t.name === 'kora_merge');
  if (mergeSpec) {
    const inner = mergeSpec.handler;
    mergeSpec.handler = async (a) => {
      const before = await mergeHead(ctx.cwd);
      const r = await inner(a);
      const g = await mergeGitSummary(ctx.cwd, before);
      return g ? { ...r, text: `${r.text}\n${g}` } : r;
    };
  }
  // A Swarm lead merges with kora_merge (it verifies first): kora_merge_verify only added calls (bench5x Z3 still called
  // verify twice — the SDK's disallowedTools does not reach MCP tools). kora_plan is offered again with plan-on-delegate
  // (its slices check is the lead's planning step); KORA_DELEGATE_PLAN=0 hides it as before.
  const planOn = delegatePlanOn();
  const offered = swarmMode && ctx.swarm ? specs.filter((t) => t.name !== 'kora_merge_verify' && (planOn || t.name !== 'kora_plan')) : specs;
  // A blob's lead repeats what its tools tell it, so on a blob chat the tools speak Blobs: helpers, not swarm workers in worktrees.
  if (!ctx.blobThread) return offered;
  return offered.map((t) => ({ ...t, handler: async (a: Record<string, unknown>) => { const r = await t.handler(a); return { ...r, text: blobSpeak(r.text) }; } }));
}

/**
 * kora_open_preview's answer. The page is opened by the desktop client (useAgentWebOpens.ts) when it sees the call, so
 * the daemon can't confirm it was shown: it says what it knows. It used to claim "Opened" even with no app window.
 */
export function openPreviewAck(url: string, desktopWindows: number | null): string {
  if (desktopWindows === 0)
    return `NOT opened: no Kora desktop window is connected, and only the desktop app has the in-app browser. Give the user the link instead: ${url}`;
  return `Asked the Kora app to show ${url} in the in-app browser beside this chat (it opens while this thread is on screen in the desktop app; a browser tab of Kora can't show it). Kora can't confirm it opened: if the user says it didn't, give them the link.`;
}

/** Code-surface words in a tool answer, said the Blobs way. Only for a blob chat (`blobThread`). */
export function blobSpeak(text: string): string {
  return text
    .replace(/\bswarm (worker|task|mode|lead)s?\b/gi, (_m, w: string) => (/^task/i.test(w) ? 'helper task' : /^worker/i.test(w) ? 'helper' : `helper ${w}`))
    .replace(/\bswarm\b/gi, 'helper')
    .replace(/\bworktrees?\b/gi, 'working folder')
    .replace(/\bforeman\b/gi, 'Kora')
    .replace(/\borchestrators?\b/gi, 'lead');
}

const SWARM_VERIFY_POLL_MS = 250;
const SWARM_START_POLL_MS = 1_000;
const SWARM_NOT_STARTED: ReadonlySet<string> = new Set(['starting', 'respawning', 'rate-limited']);
/** How often kora_wait checks whether the user sent a message. */
const USER_MESSAGE_POLL_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function capReport(t: string, truncated = false): string {
  if (t.length > SWARM_REPORT_WAIT_CAP) return `${t.slice(0, SWARM_REPORT_WAIT_CAP)}\n…truncated — kora_read for the rest`;
  return truncated ? `${t}\n…truncated — kora_read for the rest` : t;
}

/**
 * The leader's view of a swarm report: whole when it fits SWARM_REPORT_COMPACT_CAP, else its sections cut to size —
 * Status whole, Changes and Findings from the top, Check from the END (a command's verdict and errors come last),
 * Blockers from the top — plus the path to the full file. Worker reports follow swarmWorkerPreamble's sections; one
 * that does not keeps its head. Every char here is re-read on each later leader call, so smaller is cheaper.
 */
// eslint-disable-next-line no-control-regex
// CSI parameter bytes are 0x30–0x3F (`<` `=` `>` included: an SGR mouse report `ESC[<35;12;40M` is one); OSC ends at BEL or ST.
const ANSI_RE = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Terminal colour/cursor codes: noise the leader would re-read on every later call. */
export function stripAnsi(t: string): string { return t.replace(ANSI_RE, ''); }

/** A worker task with the user's own request pasted above the leader's instructions (kora_spawn include_request). */
export function withUserRequest(prompt: string, request: string | null, opts: { split?: boolean } = {}): string {
  const req = (request ?? '').split('\n').filter((l) => !/^\[kora\]/.test(l.trim())).join('\n').trim();
  if (!req) return prompt;
  // In a split, every worker sees the whole request for context, but must stay on its own part: workers that saw six
  // bug reports each chased all six (bench5x Z2) and the lead spent calls pulling them back.
  if (opts.split) return `## The user's request (context only — other workers own the other parts; do NOT work on them)\n${req}\n\n## YOUR part — do only this\n${prompt.trim() || 'Do the request above.'}`;
  return `## The user's request (verbatim — the full spec; every requirement in it applies)\n${req}\n\n## Lead's instructions\n${prompt.trim() || 'Do the request above.'}`;
}

export function compactReport(t: string, reportPath: string, truncated = false, cap = SWARM_REPORT_COMPACT_CAP): string {
  const text = stripAnsi(t).trim();
  const pointer = `(compact — full report: ${reportPath}, ${(Buffer.byteLength(t) / 1024).toFixed(1)} KB; Read it or kora_wait full:true only if this is not enough)`;
  if (text.length <= cap && !truncated) return text;
  const sections = new Map<string, string[]>();
  const head: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    const m = /^#{1,3}\s*(status|changes|check|findings|blockers)\b/i.exec(line);
    if (m) { cur = []; sections.set(m[1].toLowerCase(), cur); continue; }
    (cur ?? head).push(line);
  }
  if (!sections.size) return `${text.slice(0, cap)}\n…\n${pointer}`;
  const budget: Record<string, number> = { status: 0.08, changes: 0.2, check: 0.22, findings: 0.35, blockers: 0.15 };
  const clip = (lines: string[], chars: number, fromEnd: boolean): string => {
    const body = lines.join('\n').trim();
    if (body.length <= chars) return body;
    return fromEnd ? `…\n${body.slice(body.length - chars).replace(/^[^\n]*\n/, '')}` : `${body.slice(0, chars).replace(/\n[^\n]*$/, '')}\n…`;
  };
  // Unused budget of short sections flows to the long ones.
  const sizes = Object.fromEntries([...sections].map(([k, v]) => [k, v.join('\n').trim().length]));
  let spare = 0;
  for (const k of Object.keys(budget)) { const room = Math.floor(cap * budget[k]); spare += Math.max(0, room - (sizes[k] ?? 0)); }
  const long = Object.keys(budget).filter((k) => (sizes[k] ?? 0) > cap * budget[k]);
  const out: string[] = [];
  for (const k of ['status', 'changes', 'check', 'findings', 'blockers']) {
    const lines = sections.get(k);
    if (!lines) continue;
    const room = Math.floor(cap * budget[k]) + (long.includes(k) ? Math.floor(spare / long.length) : 0);
    out.push(`## ${k[0].toUpperCase()}${k.slice(1)}\n${clip(lines, room, k === 'check')}`);
  }
  return `${out.join('\n')}\n${pointer}`;
}

/**
 * A TUI screen as the leader needs it: text lines only. Blank lines, box-drawing / block-art rows (OpenCode's logo and
 * frames) and trailing padding go; at most `maxLines` lines are kept, from the end. The start-up screen was ~2.5K
 * chars of art the leader re-read on every later call.
 */
export function compactScreen(screen: string, maxLines = 12): string {
  const lines = screen.split('\n').map((l) => l.replace(/[\u2500-\u259f]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => /[\p{L}\p{N}]{2,}/u.test(l));
  return lines.slice(-maxLines).join('\n');
}

/** `p5 → p7 (rate-limited on X, now Y)` for every failover hop between the asked id and the live worker. */
function followLine(asked: string, live: string, w: WorkerInfo): string {
  const sw = w.swarm!;
  const chain = [...sw.previousPaneIds, live];
  const start = Math.max(0, chain.indexOf(asked));
  const hops: string[] = [];
  for (let i = start; i < chain.length - 1; i++) {
    const from = sw.attempts.find((x) => x.paneId === chain[i]);
    const to = sw.attempts.find((x) => x.paneId === chain[i + 1]);
    hops.push(`${chain[i]} → ${chain[i + 1]} (${from?.outcome ?? 'replaced'} on ${from?.model ?? '?'}, now ${to?.model ?? sw.model})`);
  }
  return hops.length ? hops.join('; ') : `${asked} → ${live}`;
}

/** The zod shape the Claude Agent SDK's `tool()` takes. `z` is the caller's zod (the SDK's peer). */
export function toZodShape(params: ParamShape, z: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, p] of Object.entries(params)) {
    let s: any = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : p.type === 'string[]' ? z.array(z.string()) : p.type === 'object[]' ? z.array(z.object(toZodShape(p.items ?? {}, z))) : p.enum ? z.enum([...p.enum]) : z.string();
    if (p.description) s = s.describe(p.description);
    out[k] = p.optional ? s.optional() : s;
  }
  return out;
}

/** The JSON-schema `inputSchema` an MCP tools/list entry carries. */
export function toJsonSchema(params: ParamShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, p] of Object.entries(params)) {
    const base: Record<string, unknown> = p.type === 'number' ? { type: 'number' } : p.type === 'boolean' ? { type: 'boolean' } : p.type === 'string[]' ? { type: 'array', items: { type: 'string' } } : p.type === 'object[]' ? { type: 'array', items: toJsonSchema(p.items ?? {}) } : { type: 'string', ...(p.enum ? { enum: [...p.enum] } : {}) };
    if (p.description) base.description = p.description;
    properties[k] = base;
    if (!p.optional) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// SwarmService — swarm WORKERS: spawn (context packet + overlap check), the old→new pane alias after a failover
// (`follow`), plugin events, failover, verify-and-bounce, the report file and the persisted task registry
// (~/.kora/swarm/tasks.json). `runtime.swarm`. The constructor stays cheap and never throws (Runtime builds it on
// every start, tests included): the registry is read lazily on first use.
//
// Lifecycle of one task (sN):
//   spawn → its OWN worktree (always — the first worker must never share the user's checkout, journey e) →
//   `opencode -m <free model> [--auto] --prompt <preamble + graph context + task>` in a pane →
//   promptPending until the first working state (60 s cap, the early-false-idle fix) →
//   idle with a report → verify-and-bounce (X2, the merge gate in a child process) → `swarm.worker` report event.
//   A 429 / gone model → failover: cool the model, kill the pane, wait for exit, respawn on the next free model in
//   the SAME worktree; `follow(old)` → new. After 4 attempts (or no model left) → exhausted.
// Model choice: pickModel ranks the first available supply tier by measured outcomes (swarm-routing.ts: first-try
// pass rate × provider reliability − time, per task type, Thompson-sampled). A 15 s watchdog (swarm-watchdog.ts)
// nudges a slow worker at T1 and moves it to a faster model at T2, reusing the worktree; paid models are stopped at
// their per-task spend cap.
//
// WorkerBackend (config swarm.workerBackend, fixed per task at spawn): everything above is the `opencode` backend,
// frozen. The `koragent` backend (koragent-backend.ts, protocol/koragent.ts) writes a TaskSpec and launches
// `koragent --task-spec <file> --event-stream unix:~/.kora/panes/<paneId>.sock`; its session.state events drive the
// pane (pane.hint, authoritative) and the phase, task.report feeds the same verify path (report files as fallback),
// route.failover cools the model WITHOUT a respawn, budget.update feeds the watchdog, and Kora's own messages and a
// leader's kora_prompt go out as `steer` messages. No screen scraping, prompt hold, idle nudge or 429 polling.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { koragentFeedItems } from './worker-feed';
import { koraHome } from '../protocol/types';
import type { SwarmFinishedTask } from '../protocol/types';
import type { AgentId, FleetSwarmVerify, MergePair, SwarmForemanCheck, SwarmForemanReview, SwarmForemanState, SwarmForemanVerdict, SwarmModelInfo, SwarmPaneEvent, SwarmProviderId, SwarmStep, SwarmSupplyProviderId, SwarmWorkerEvent, SwarmWorkerMeta, SwarmWorkerPhase, WorkerBackendId } from '../protocol/types';
import type { KoragentEvent, TaskReport } from '../protocol/koragent';
import { KoragentEventClient } from './koragent-socket';
import { untrustedAgentEnv } from '../trust/gate';
import { RECENT_EVENTS, asTaskReport, buildTaskSpec, ensureReportFiles, failoverOutcome, koragentDigest, koragentPaneEnv, koragentPermission, paneStateFor, recentEventLine, reportJsonPath, taskSpecPath, writeTaskSpec } from './koragent-backend';
import type { RuntimeMode } from '../session/events';
import type { SwarmOverlap } from './swarm-context';
import type { SwarmHealth } from './swarm-health';
import type { SwarmSetup } from './swarm-setup';
import type { Runtime } from './workspace';
import { SwarmNotReadyError } from './swarm-errors';
import { blobWorkspaceRootOf, isBlobsCwd } from '../blobs/home';
import { assistantWorkerPreamble } from './assistant-worker';
import { swarmIdleConfirmed, swarmWorkingConfirmed } from './swarm-state';
import { modelTier, providerOfModel } from './swarm-health';
import { ensureBaseline, wrapCheck } from './swarm-baseline';
import { RACE_WIN_KINDS, WORKER_AID, isQuiet, readMilestones, writeWorkerHelpers, type Milestone, type SwarmProgress } from './swarm-dynamic';
import { FOCUS_PACKET_BUDGET_MS } from './swarm-context';
import { classifySwarmTask, loadRoutingStats, rankModels, type RoutingStats, type SwarmTaskType } from './swarm-routing';
import { KORAGENT_ESCALATE_GRACE_MS, OpencodeActivity, WATCHDOG_DEFAULTS, budgetStopText, koragentStallStep, koragentStallText, watchdogDecision, watchdogNudgeText, type WatchdogSettings, type WorkerActivity } from './swarm-watchdog';
import { stepFromKoragentToolStart } from './swarm-step';
import { BASELINE_CHECK_BUDGET_MS, FOREMAN_BUDGET_MS, NOT_DONE_STATUSES, diffSummary, failureExcerpt, gateOf, isEmptyDiff, looksModelRelated, parseReview, reportStatus, reviewPrompt, retryDigest, runCheck, runReviewer, tailOf, worktreeDiff } from './swarm-foreman';
import { log } from './log';
import { assertDiskRoom, minFreeBytes } from './disk';
/** Free space a assistant-lane worker needs (reports + OpenCode's session state), far below a checkout's floor. */
const CHAT_WORKER_MIN_FREE_BYTES = 256 * 1024 ** 2;
import { redactSecrets } from '../util/redact';
import { GIT_NO_FSMONITOR, gitEnv } from '../util/safe-path';

export interface SwarmSpawnParams {
  /** `chat:<kora thread id>` (a Swarm-mode thread) or an orchestrator pane id (isSwarmThread), or spawn refuses. */
  orchestratorId: string;
  cwd: string;
  /** The slice the leader hands over (the preamble and context packet are added by spawn). */
  task: string;
  /** Tile title; defaults to the task's first line. */
  title?: string;
  /** The leader thread's permission posture → the worker's OPENCODE_PERMISSION / argv. */
  runtimeMode?: RuntimeMode;
  /** Foreman done-check: a shell command run in the worker's worktree before the leader hears "done" (exit 0 = pass). */
  check?: string;
  /** Symbols, files or behaviours the lead located (kora_locate): the graph packet is built from these. */
  focus?: string[];
  /** Race group: the first task in the group to post root-cause/fixed (or pass its check) wins; Kora stops the rest. */
  race?: string;
  /**
   * The worker's permission, explicit (TaskSpec.permission vocabulary). A Koragent lead passes its own
   * `workerPermission` here. Capped by `runtimeMode` when both are given; without either the worker inherits the
   * orchestrator's posture (swarmPermissionFor), never a silent `supervised`.
   */
  permission?: SwarmWorkerPermission;
  /**
   * Over `maxWorkers`: queue the task instead of refusing it. It gets a stable task id immediately and a placeholder
   * (`SwarmSpawnResult.queued: true`, `paneId: null`); it starts (FIFO, per orchestrator) as soon as one of this
   * orchestrator's workers leaves a slot-holding phase. `kora_map` always sets this; `kora_spawn agent:"swarm"` sets
   * it on assistant-lane threads. A queued-but-unstarted task is dropped (not resumed) across a daemon restart.
   */
  queue?: boolean;
  /** A tighter cap on this orchestrator's live workers than the global `maxWorkers` (a blob thread runs at most 2 helpers). */
  maxConcurrent?: number;
}

/** TaskSpec.permission vocabulary, accepted on `swarm.spawn` / kora_spawn from a pane orchestrator. */
export type SwarmWorkerPermission = 'supervised' | 'auto-edits' | 'full';
export const SWARM_WORKER_PERMISSIONS: readonly SwarmWorkerPermission[] = ['supervised', 'auto-edits', 'full'];
const PERMISSION_MODE: Record<SwarmWorkerPermission, RuntimeMode> = { supervised: 'approval-required', 'auto-edits': 'auto-accept-edits', full: 'full-access' };
const MODE_RANK: Record<RuntimeMode, number> = { 'approval-required': 0, 'auto-accept-edits': 1, auto: 2, 'full-access': 3 };

/**
 * The worker's RuntimeMode (D5). An explicit `permission` wins, capped by the request's `runtimeMode` (a leader can
 * lower its workers' posture, never raise it past the thread's); else the request's `runtimeMode`; else the
 * orchestrator's own mode (`fallback`: a chat thread's stored mode, or the daemon's default runtime mode for a pane
 * orchestrator). Workers of a Koragent lead pane came out `supervised`, so every edit waited for a click.
 */
export function swarmRuntimeMode(req: { permission?: string | null; runtimeMode?: RuntimeMode | null }, fallback: RuntimeMode | null = null): RuntimeMode | undefined {
  const explicit = req.permission && (SWARM_WORKER_PERMISSIONS as readonly string[]).includes(req.permission) ? PERMISSION_MODE[req.permission as SwarmWorkerPermission] : null;
  const asked = req.runtimeMode && req.runtimeMode in MODE_RANK ? req.runtimeMode : null;
  if (explicit && asked) return MODE_RANK[explicit] <= MODE_RANK[asked] ? explicit : asked;
  return explicit ?? asked ?? fallback ?? undefined;
}

export interface SwarmSpawnResult {
  /** null when the task was queued (over maxWorkers, `queue: true`): no pane exists yet. */
  paneId: string | null;
  taskId: string;
  /** '' while queued (chosen once the task actually starts). */
  provider: SwarmSupplyProviderId | '';
  model: string;
  modelLabel: string;
  /** Absolute $KORA_REPORT; '' while queued (chosen once the task actually starts). */
  reportPath: string;
  /** Advisory (X3): running workers already touching this task's files. Never blocks the spawn. */
  overlaps: SwarmOverlap[];
  /** The foreman's plan for this task (null = off); `checkRefused` says why a given check will not run. */
  foreman?: { check: string | null; maxAttempts: number; review: boolean; checkRefused: string | null } | null;
  /** The worker program (WorkerBackend): what the chat's worker.attached row names (D31: Koragent read "opencode"). */
  agent?: WorkerBackendId;
  /** The permission the worker runs with (TaskSpec.permission vocabulary). */
  permission?: SwarmWorkerPermission;
  /** True when this task was queued instead of started now (every slot was busy and the caller opted in). */
  queued?: boolean;
  /** No git (a plain folder): the worker runs in the folder itself, shared with the lead and other workers. */
  sharedFolder?: boolean;
  /** queued only: 1-based FIFO position behind this orchestrator's other queued tasks. */
  queuePosition?: number;
}

/** Why a task left its current model. 'stalled' = the watchdog moved it off a slow / silent worker. */
export type SwarmFailReason = 'rate-limited' | 'model-gone' | 'crashed' | 'auth-failed' | 'stalled' | 'unreachable';

/** One row of ~/.kora/swarm/tasks.json — survives a daemon restart (journey c). */
export interface SwarmTaskRecord {
  taskId: string;
  orchestratorId: string;
  /** Every pane the task ran on, oldest first; the last is the current one. */
  paneIds: string[];
  reportPath: string;
  status: SwarmWorkerPhase;
  /** The human stopped it (fleet.kill). Persisted so a restart neither resumes it nor drops it from the Tasks list. */
  userStopped?: boolean;
}

/** The leader-facing error when a non-swarm thread (or a Codex orchestrator) asks for a swarm worker (journey g). */
export const SWARM_THREAD_REQUIRED = 'swarm workers need a Swarm-mode thread or an orchestrator pane';
/** 429 / quota / free-limit wording across Zen, OpenRouter and Cerebras (and opencode's own retry messages). */
export const RATE_LIMIT_RE = /429|rate.?limit|too many requests|Free limit reached|Free usage exceeded|FreeUsageLimitError|resource.?exhausted/i;
const MODEL_GONE_RE = /model.*not found|not a valid model|404/i;
/** A free endpoint that is down (not a quota): after a few of OpenCode's own retries, move the task to another model. */
export const PROVIDER_DOWN_RE = /endpoint is unavailable|upstream request failed|service unavailable|model is overloaded|\b50[23]\b/i;
const MANY_RETRIES_RE = /attempt #([3-9]|\d{2,})/i;
/**
 * The worker cannot reach its provider at all (recorded from OpenCode 1.18.32 offline: "Cannot connect to API: Unable to
 * connect. Is the computer able to access the url?"). OpenCode retries that quietly for as long as it likes, so the task
 * sat silent until the watchdog's 8–15 min (night 2026-10-04): after a couple of retries, move it on.
 */
export const UNREACHABLE_RE = /Cannot connect to API|Unable to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|fetch failed|network (?:is )?unreachable/i;
const AUTH_RE = /401|unauthori[sz]ed|invalid.{0,12}api.?key|authentication/i;
const MAX_ATTEMPTS = 4;
/** Attempts that stalled or crashed before a task is handed back to the leader: the original + 2 failovers. */
export const MAX_COSTLY_ATTEMPTS = 3;
const REPORT_CAP = 256 * 1024;
const PREVIEW_CHARS = 280;
const PROMPT_PENDING_CAP_MS = 60_000;
/** The X2 merge gate's budget per verify (it is a child process; a hung one must not hold the report). */
const VERIFY_BUDGET_MS = 90_000;
const VERIFY_CONCURRENCY = 2;
const CONTEXT_PACKET_BUDGET_MS = 1_600; // the packet's own 1.5 s budget + slack; never blocks a spawn longer
const OVERLAP_BUDGET_MS = 3_000;
/** OpenRouter's free tier is 20 requests/min shared across every model: at most this many workers on it at once. */
const OPENROUTER_MAX_WORKERS = 2;
const WATCHDOG_TICK_MS = 15_000;
/** Worker phases that hold one of the orchestrator's `maxWorkers` slots. */
const SLOT_PHASES = new Set<SwarmWorkerPhase>(['starting', 'running', 'rate-limited', 'respawning']);
/** Worker phases a step / retry / extend applies to (a task still mid-flight, not superseded). */
const LIVE_SWARM_PHASES = new Set<SwarmWorkerPhase>(['starting', 'running', 'rate-limited']);
/** Thought-bubble poll cadence (OpenCode workers only; Koragent's `tool.start` feeds the step inline). */
const STEP_TICK_MS = 2_500;

/**
 * The seams SwarmService calls into other streams / the machine through. Each default is the frozen function
 * (S3: swarmPaneEnv / swarmWorkerPreamble / opencode adapter; S4: keys, binary; X1/X3: swarm-context); tests
 * inject fakes. Every default is wrapped so a stub that throws degrades instead of failing the spawn.
 */
export interface SwarmIO {
  apiKey(provider: SwarmSupplyProviderId): string | null;
  opencodePath(): string | null;
  paneEnv(meta: SwarmWorkerMeta, opts: { apiKey: string | null; runtimeMode?: RuntimeMode; readHints?: Record<string, number[]>; cwd?: string }): Record<string, string>;
  preamble(input: { reportPath: string; taskId: string; cwd?: string }): string;
  modelArgs(model: string): string[];
  permissionArgs(runtimeMode: RuntimeMode | undefined): string[];
  contextPacket(input: { cwd: string; task: string; focus?: string[] }): Promise<{ text: string; files: string[] }>;
  overlap(input: { files: string[]; running: { paneId: string; files: string[] }[] }): SwarmOverlap[];
  changedFiles(worktreePath: string): Promise<string[]>;
  /** X2's gate: the merge engine over this worker's worktree (+ running siblings, + the target HEAD). */
  verifyGate(input: { paneId: string; worktree: string; mainRoot: string; siblings: { paneId: string; worktree: string }[] }): Promise<MergePair[]>;
  threadMode(orchestratorId: string): string | null;
  /** The orchestrator's RuntimeMode when a spawn names none (chat thread meta, else the daemon default). */
  orchestratorMode?(orchestratorId: string): RuntimeMode | null;
  config(): { autoVerify: boolean; maxBounces: number; maxWorkers: number; defaultModel?: string | null; foremanRetries?: number; foremanReview?: boolean; watchdog?: WatchdogSettings; paidMaxTaskUsd?: number };
  /** Foreman: the leader's done-check in a child process (bounded; never throws). */
  runCheck(command: string, cwd: string): Promise<SwarmForemanCheck>;
  /** Foreman: the worker's change vs its fork point (stat + patch + untracked). */
  diff(dir: string, mainRoot: string | null): Promise<{ stat: string; patch: string; untracked: string[] }>;
  /** Foreman: one reviewer call (`opencode run`, or `koragent run` on the koragent backend); `failed` = non-zero exit / timeout. */
  review(input: { opencode: string; model: string; cwd: string; prompt: string; env: Record<string, string>; backend?: WorkerBackendId }): Promise<{ output: string; failed: boolean }>;
  /** Idle-without-report delay before the one automatic nudge (journey l). */
  nudgeMs: number;
  /** Rate-limit screen fallback poll while a swarm pane runs. 0 = off. */
  screenPollMs: number;
  /** Watchdog tick (slow / silent workers, paid spend). 0 = off. */
  watchdogTickMs?: number;
  /** A finished worker with nothing to merge (assistant-lane helper, no worktree) is closed after this. 0 = never. */
  retireDoneMs?: number;
  /** A completed-but-unmerged worker is retired after this duration idle (default 10 min: 600_000 ms). 0 = never. */
  retireUnmergedMs?: number;
  /** Is this worktree untouched (nothing dirty, nothing committed ahead of the main checkout)? Default: git, async. A finished
   *  worker whose worktree is clean is closed like a no-worktree helper and its worktree + branch swept. */
  worktreeClean?: (dir: string) => Promise<boolean>;
  /** Measured outcomes for routing (default: ~/.kora/swarm/outcomes.jsonl). */
  routingStats?: () => RoutingStats;
  /** Thompson-sampling randomness (tests pin it). */
  random?: () => number;
  /** OpenCode progress + spend per worktree (default: its session DB, read-only). */
  activity?: (dirs: { dir: string; sinceMs: number }[]) => Map<string, WorkerActivity>;
  /** OpenCode workers' latest step per worktree, thought-bubble text (default: same session DB; polled every ~2.5 s). */
  step?: (dirs: { dir: string; sinceMs: number; match?: string; key?: string }[]) => Map<string, SwarmStep | null>;
  /** WorkerBackend for NEW tasks (config swarm.workerBackend; default 'opencode'). A task keeps its backend for life. */
  workerBackend?: () => WorkerBackendId;
  /** The Koragent binary (KORAGENT_BIN → ~/.koragent/bin/koragent → PATH); null = not installed. */
  koragentPath?: () => string | null;
  /** Opens a Koragent pane's event stream (tests inject; default: a KoragentEventClient that retries until it is up). */
  koragentClient?: (socketPath: string) => KoragentEventClient;
}

/** One attempt's launch, as a WorkerBackend plans it. */
export interface WorkerLaunchInput {
  taskId: string; reportPath: string; orchestratorId: string; cwd: string; task: string; title: string;
  runtimeMode?: RuntimeMode; worktree: { path: string; branch: string; mainRoot: string } | null;
  model: SwarmModelInfo; meta: SwarmWorkerMeta; contextText?: string; contextFiles?: string[]; continuation?: string;
  /** Koragent: the ordered route (model first, then fallbacks), the done-check the harness may run, the budget. */
  route: SwarmModelInfo[]; check: string | null; paidCapUsd: number | null;
}
export interface WorkerLaunchPlan { agent: AgentId; command: string | null; args: string[]; env: Record<string, string>; eventStream: boolean }

/**
 * Which program runs a swarm worker. `opencode` is today's worker, frozen: prompt in argv, state scraped from the
 * screen + the kora-state plugin, 429 screen polling, idle nudge, prompt-pending hold. `koragent` is event-driven:
 * a TaskSpec file + an event stream; its state, report, failover and spend arrive as events, steers go out as messages.
 */
export interface WorkerBackend {
  readonly id: WorkerBackendId;
  readonly eventDriven: boolean;
  plan(input: WorkerLaunchInput): WorkerLaunchPlan;
}

interface TaskState {
  /** Dynamic workflow (server/swarm-dynamic.ts): race group, milestones file + what was read, when it started. */
  race?: string | null;
  msFile?: string | null;
  msOffset?: number;
  milestones?: Milestone[];
  startedAt?: number;
  lastChangeAt?: number | null;
  lastChanged?: string[];
  /** Baseline file for the done-check (server/swarm-baseline.ts); the check both sides run is wrapCheck(check, it). */
  checkBaseline?: string | null;
  record: SwarmTaskRecord;
  cwd: string;
  task: string;
  title: string;
  runtimeMode?: RuntimeMode;
  worktree: { path: string; branch: string; mainRoot: string } | null;
  /** In-flight failover; follow waits on it. */
  failing: Promise<void> | null;
  /** The last `[kora] …` note this task produced (failover / exhausted). */
  note: string | null;
  /** The human stopped this task's worker (fleet.kill): no foreman retry, no watchdog respawn. */
  userStopped?: boolean;
  /** Last report mtime handed to the verify/report path (a re-idle with the same report is not re-reported). */
  handledReportAt: number;
  nudged: boolean;
  timers: NodeJS.Timeout[];
  /** Restored from tasks.json by a new daemon: its panes are gone (journey c). */
  restored: boolean;
  /** Loaded from tasks.json by this daemon (stays true after a resume, unlike `restored`): the lead may not know it. */
  fromDisk?: boolean;
  lastRetryNext: number | null;
  /** Coarse task type (routing). */
  type?: SwarmTaskType;
  /** Watchdog state of the CURRENT attempt (reset on every launch). */
  wd?: { attemptAt: number; nudgedAt: number | null; idleSince: number | null; budgetStopAt: number | null; nudges: number; kgEscalatedAt?: number | null; extendMs?: number };
  /** The foreman (done-check / auto-retry / reviewer); null when off. Mirrored onto the live pane's `swarm.foreman`. */
  fm?: SwarmForemanState | null;
  /** When the current foreman attempt started. */
  fmStartedAt?: number;
  /** The pane a no-report verdict is already scheduled for. */
  fmNoReportPane?: string | null;
  /** WorkerBackend of every attempt of this task (restored tasks: opencode). */
  backend?: WorkerBackendId;
  /** Koragent: what its event stream said (progress + spend for the watchdog, the last report). */
  kg?: { lastAt: number; usd: number; steps: number; report: TaskReport | null; reportTs: number; recent?: string[] };
  /** X1 packet files (Koragent's TaskSpec carries them structured). */
  contextFiles?: string[];
  /** Restored mid-flight (its worker died with the previous daemon): what resumeAfterRestart needs to relaunch it. */
  resume?: SwarmResumeInfo | null;
  /** tasks.json's resume info, as loaded (restored tasks persist it back unchanged). */
  resumeLoaded?: SwarmResumeInfo | null;
  /** Its worker died with a previous daemon and it was not (or could not be) resumed. */
  lost?: boolean;
  /** Set while `record.status === 'queued'`: the spawn request to run once a slot frees (dispatchQueued). Never persisted. */
  queuedParams?: SwarmSpawnParams;
}

/** Persisted beside each tasks.json row: enough to relaunch an unfinished task after a daemon restart (D17). */
interface SwarmResumeInfo {
  cwd: string; task: string; title: string; runtimeMode?: RuntimeMode; worktree: { path: string; branch: string; mainRoot: string } | null;
  backend: WorkerBackendId; check: string | null; type?: SwarmTaskType; model: string | null; attempt: number;
  /** The current attempt's provider (zen / openrouter / …), for the Tasks list after a restart. */
  provider?: string | null;
  /** Koragent: the last events (koragentDigest) — the brief's facts, never the screen. */
  recent?: string[];
}
const MID_FLIGHT = new Set<string>(['starting', 'running', 'rate-limited', 'respawning']);

type PaneLike = import('./pane').Pane;

// Not unref'd: a caller is awaiting it (a spawn waiting on its context packet must not be dropped by an idle loop).
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => new Promise<T>((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});
const modelLabel = (id: string) => id.split('/').slice(-1)[0].replace(/:free$/, '');
const providerOf = (id: string): SwarmSupplyProviderId => providerOfModel(id);
/** A swarm task id ("s7"), never a pane id ("p7"): every ref-taking op accepts either. */
const isTaskRef = (id: string): boolean => /^s\d+$/.test(id);

/**
 * `[kora] swarm task s3 failed on every free model (<list>; next reset <time>). Rewrite or split it.` — unless every
 * attempt died on the PROVIDER (rate limit, outage, auth, model gone): then rewriting the task cannot help, and the
 * lead must say so plainly and offer the real ways out (night 2026-10-04, B5 "all free providers down").
 */
export function swarmExhaustedNote(taskId: string, tried: string[], nextResetAt: number | null, reasons: ReadonlyArray<SwarmFailReason | string | undefined> = []): string {
  const reset = nextResetAt ? new Date(nextResetAt).toLocaleTimeString() : 'unknown';
  const providerOnly = reasons.length > 0 && reasons.every((r) => r === 'rate-limited' || r === 'model-gone' || r === 'auth-failed' || r === 'unreachable');
  if (providerOnly) {
    return `[kora] swarm task ${taskId} could not run: every free model is rate-limited or unavailable right now (${tried.join(', ')}; next reset ${reset}). This is the free providers, not the task. Hand the slice to the cheap paid tier (kora_ask_workers: claude Haiku or codex Luna, then kora_spawn it; the user's Stretch button approves that) and tell the user in one line (more free capacity: an OpenRouter/Cerebras key in Settings → Swarm). Do not do it yourself without asking.`;
  }
  return `[kora] swarm task ${taskId} failed on every free model (${tried.join(', ')}; next reset ${reset}). Rewrite or split it, or hand it to the cheap paid tier (kora_ask_workers: claude Haiku or codex Luna, then kora_spawn it).`;
}

/** `[kora] swarm worker p5 (m1) hit a rate limit; respawned as p7 on m2, same task, same worktree. kora_wait p5 follows it.` */
export function swarmFailoverNote(oldPane: string, fromModel: string, reason: SwarmFailReason, newPane: string, toModel: string): string {
  const why = reason === 'rate-limited' ? 'hit a rate limit' : reason === 'model-gone' ? 'lost its model' : reason === 'auth-failed' ? 'was refused by its provider' : reason === 'stalled' ? 'was too slow (no report in time)' : reason === 'unreachable' ? 'could not reach its provider (no connection)' : 'crashed';
  return `[kora] swarm worker ${oldPane} (${fromModel}) ${why}; respawned as ${newPane} on ${toModel}, same task, same worktree. kora_wait ${oldPane} follows it.`;
}

export const STALLED_COOLDOWN_MS = 10 * 60 * 1000;
/** Default cooldown per provider / reason (B9). `next` = opencode's own retry time when it gave one. */
export function cooldownUntil(model: string, reason: SwarmFailReason, now: number, next?: number | null): number {
  if (reason === 'model-gone') return now + 24 * 60 * 60 * 1000;
  if (reason === 'auth-failed') return now + 60 * 60 * 1000;
  if (reason === 'crashed') return now + 60_000;
  // A short cool: no connection is often this Mac's network, not the provider — never a 15-minute ban.
  if (reason === 'unreachable') return now + 2 * 60_000;
  // A model whose worker went silent is parked for 10 min: the next spawn must not draw it again (found live: one free
  // model stalled three workers in a row). When every free model is parked, Stretch falls to its cheap paid tier.
  if (reason === 'stalled') return now + STALLED_COOLDOWN_MS;
  // OpenCode's `next` is when IT retries (seconds away), not when the limit resets: found live, big-pickle cooled ~5 s
  // and the very next spawn went back to it and hit the same wall. The provider floor is a minimum, never undercut.
  const floor = providerOf(model) === 'zen' ? now + 15 * 60 * 1000 : now + 60_000;
  return next && next > floor ? next : floor;
}

function defaultIO(svc: SwarmService): SwarmIO {
  const rt = () => svc.deps.runtime;
  // One instance (one DB handle, one off-switch) for both `activity` (watchdog progress) and `step` (thought bubble).
  const opencodeActivity = new OpencodeActivity();
  return {
    apiKey: (p) => { if (p === 'zen' || p === 'ollama' || p === 'lmstudio') return null; try { return require('./swarm-secrets').getSwarmKey(p); } catch { return null; } },
    opencodePath: () => { try { return require('./swarm-install').resolveOpencodeBinary().path ?? null; } catch { return null; } },
    paneEnv: (meta, opts) => {
      const base = { KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId, KORA_SWARM_MODEL: meta.model, KORA_SWARM_PROVIDER: meta.provider, KORA_NODE: process.execPath };
      try { return { ...base, ...require('./swarm-opencode').swarmPaneEnv(meta, opts) }; }
      catch (e: any) { log(`swarm: swarmPaneEnv unavailable (${e?.message ?? e}) — minimal env`); return base; }
    },
    preamble: (input) => {
      // assistant-lane tasks are research/analysis/writing legwork, never a code edit — a different worker preamble
      // (no worktree talk, no "changed files", writes only where the task says).
      if (input.cwd && isBlobsCwd(input.cwd)) {
        try { return assistantWorkerPreamble(input); } catch { /* fall through to the code preamble */ }
      }
      try { return require('./swarm-skill').swarmWorkerPreamble(input); }
      catch { return `Write your report to ${input.reportPath} (task ${input.taskId}): what you changed, how you verified it, anything left open. Facts only.`; }
    },
    modelArgs: (model) => {
      try { const a = require('../detect/agent-adapter').adapterFor('opencode').modelArgs(model); if (Array.isArray(a) && a.length) return a; } catch { /* default adapter */ }
      return ['-m', model];
    },
    permissionArgs: (mode) => {
      if (mode !== 'full-access' && mode !== 'auto') return [];
      try { return require('../detect/agent-adapter').adapterFor('opencode').skipPermissionArgs(); } catch { return []; }
    },
    contextPacket: async (input) => {
      const { buildSwarmContextPacket } = require('./swarm-context') as typeof import('./swarm-context');
      const graph = rt().graph;
      return buildSwarmContextPacket({ ...input, graphCall: (name, args, opts) => graph.callTool(name as any, args, opts) });
    },
    overlap: (input) => (require('./swarm-context') as typeof import('./swarm-context')).checkSwarmOverlap(input),
    changedFiles: (dir) => gitChangedFiles(dir),
    verifyGate: async ({ paneId, worktree, mainRoot, siblings }) => {
      // The existing engine, in its child process: this worktree + running siblings + the target branch (HEAD of the
      // main checkout — whatever already landed since the worker forked, e.g. an earlier merged swarm worker).
      const r = await rt().mergeVerifyRefs({ cwd: mainRoot, refs: [worktree, ...siblings.map((s) => s.worktree), 'HEAD'] });
      const byPath = new Map<string, string>([[path.basename(worktree), paneId], ...siblings.map((s) => [path.basename(s.worktree), s.paneId] as [string, string]), ['HEAD', 'main']]);
      const rename = (l: string) => byPath.get(l) ?? l;
      return r.pairs.map((p) => ({ ...p, a: rename(p.a), b: rename(p.b), ...(p.blame ? { blame: p.blame.map((b) => ({ ...b, byWorker: rename(b.byWorker) })) } : {}) }));
    },
    threadMode: (orchestratorId) => {
      if (!orchestratorId.startsWith('chat:')) return null;
      try { return JSON.parse(fs.readFileSync(path.join(koraHome(), 'chat', orchestratorId.slice(5), 'meta.json'), 'utf8')).agentMode ?? null; } catch { return null; }
    },
    // A chat thread's stored mode, else settings.json defaultRuntimeMode, else full-access (DEFAULT_RUNTIME_MODE).
    orchestratorMode: (orchestratorId) => (require('./control-auth') as typeof import('./control-auth')).orchestratorRuntimeMode(orchestratorId, koraHome()),
    config: () => {
      try {
        const c = require('../config').loadConfig().swarm;
        return { autoVerify: c.autoVerify !== false, maxBounces: Number(c.maxBounces ?? 2), maxWorkers: Number(c.maxWorkers ?? 4), defaultModel: c.defaultModel ?? null,
          watchdog: c.watchdog ?? WATCHDOG_DEFAULTS, paidMaxTaskUsd: c.paid?.maxTaskUsd ?? 0.05, foremanRetries: Number(c.foremanRetries ?? 2), foremanReview: c.foremanReview === true };
      }
      catch { return { autoVerify: true, maxBounces: 2, maxWorkers: 4, foremanRetries: 2, foremanReview: false }; }
    },
    runCheck: (command, cwd) => runCheck(command, cwd, / swarm check --baseline /.test(command) ? BASELINE_CHECK_BUDGET_MS : undefined),
    diff: (dir, mainRoot) => worktreeDiff(dir, mainRoot),
    review: (input) => runReviewer(input),
    nudgeMs: 20_000,
    screenPollMs: 2_000,
    watchdogTickMs: WATCHDOG_TICK_MS,
    routingStats: () => loadRoutingStats(),
    random: Math.random,
    activity: (dirs) => opencodeActivity.read(dirs),
    step: (dirs) => opencodeActivity.readSteps(dirs),
    workerBackend: () => { try { return require('../config').loadConfig().swarm.workerBackend === 'koragent' ? 'koragent' : 'opencode'; } catch { return 'opencode'; } },
    koragentPath: () => { try { return (require('./koragent-backend') as typeof import('./koragent-backend')).resolveKoragentBinary().path; } catch { return null; } },
    koragentClient: (socketPath) => new KoragentEventClient(socketPath, { log: (m) => log(m) }),
  };
}

/** A path's canonical form (symlinks resolved: macOS /var → /private/var, /tmp → /private/tmp); itself when missing. */
function realPath(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

/**
 * Main-checkout absolute paths in `text` → the worker's worktree (a leader names files by the main checkout's path).
 * `canonical`: every form of both paths (as given and symlink-resolved) becomes the worktree's canonical path — for
 * Koragent, whose containment check compares against its realpath'd cwd without resolving the target: a worktree
 * file named as /var/folders/… (not /private/var/folders/…) was denied as an external directory (found live, e2e kg2).
 */
export function inWorktreeText(text: string, wt: { path: string; mainRoot: string } | null | undefined, opts: { canonical?: boolean } = {}): string {
  if (!wt || !wt.mainRoot || wt.mainRoot === wt.path) return text;
  if (!opts.canonical) return text.split(wt.mainRoot).join(wt.path);
  const target = realPath(wt.path);
  // Placeholder first, so a worktree nested under the main checkout is not rewritten twice.
  const mark = '\u0000KORA_WT\u0000';
  const forms = (p: string) => [...new Set([p, realPath(p)])].sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms(wt.path)) out = out.split(f).join(mark);
  for (const f of forms(wt.mainRoot)) out = out.split(f).join(mark);
  return out.split(mark).join(target);
}

/** The frozen OpenCode worker: preamble + graph context + task in `--prompt`, model / permission in argv, OPENCODE_* env. */
function opencodeBackend(io: SwarmIO): WorkerBackend {
  return {
    id: 'opencode', eventDriven: false,
    plan: (i) => {
      // Leaders name files by the MAIN checkout's absolute path; a worker with full access followed it and edited the
      // main checkout instead of its worktree (found live, e2e). Point every such path at the worktree, and say so.
      const wt = i.worktree;
      const inWorktree = (x: string) => inWorktreeText(x, wt);
      const where = wt && wt.mainRoot !== wt.path
        ? `Your working directory is ${wt.path} (a git worktree of ${wt.mainRoot}, branch ${wt.branch}). Make every change inside it and commit there; never edit ${wt.mainRoot}.`
        : '';
      const text = [
        io.preamble({ reportPath: i.reportPath, taskId: i.taskId, cwd: i.cwd }),
        where,
        inWorktree(i.contextText || ''),
        i.continuation || '',
        inWorktree(i.task),
        `When you are done, write your report to ${i.reportPath}.`,
      ].filter((s) => s && s.trim()).join('\n\n');
      const hints = i.contextText ? (() => { try { return (require('./swarm-opencode') as typeof import('./swarm-opencode')).packetReadHints(i.contextText!); } catch { return {}; } })() : {};
      const env = io.paneEnv(i.meta, { apiKey: io.apiKey(i.model.provider), cwd: i.cwd, ...(i.runtimeMode ? { runtimeMode: i.runtimeMode } : {}), ...(Object.keys(hints).length ? { readHints: hints } : {}) });
      const command = io.opencodePath();
      const args = [...io.modelArgs(i.model.id), ...io.permissionArgs(i.runtimeMode), '--prompt', text];
      // Untrusted folder (trust/store.ts): no project `.opencode/` config, plugins or tools (repo code run on load, C7).
      // Kora's own kora-state plugin lives in OPENCODE_CONFIG_DIR, which OpenCode still loads with this set.
      return { agent: 'opencode', command, args, env: { ...env, ...untrustedAgentEnv('opencode', i.worktree?.mainRoot ?? i.cwd) }, eventStream: false };
    },
  };
}

/**
 * Koragent: `koragent --task-spec <file>` (+ `--event-stream unix:~/.kora/panes/<paneId>.sock`, appended by spawnPane
 * once the pane id exists). The spec carries goal, the X1 packet (structured), acceptance, budget, the ordered route,
 * worktree, permission, report path, parent and verify settings; the env carries only the route's provider keys.
 * Main-checkout paths in the goal and the check point at the worktree (as for OpenCode): Koragent remaps them only
 * in its file tools, not in bash or in the harness's own acceptance check — found live (e2e kg1): a leader's check
 * `cd <main> && node --test …` sent both workers to write their files into the main checkout.
 */
function koragentBackend(io: SwarmIO, cfg: () => ReturnType<SwarmIO['config']>): WorkerBackend {
  return {
    id: 'koragent', eventDriven: true,
    plan: (i) => {
      const command = io.koragentPath?.() ?? null;
      if (!command) throw new SwarmNotReadyError([{ code: 'koragent-missing', message: (require('./koragent-backend') as typeof import('./koragent-backend')).KORAGENT_NOT_INSTALLED }]);
      const c = (() => { try { return cfg(); } catch { return null; } })();
      const wd = c?.watchdog ?? WATCHDOG_DEFAULTS;
      const spec = buildTaskSpec({
        taskId: i.taskId, goal: inWorktreeText(i.task, i.worktree, { canonical: true }), continuation: i.continuation ? inWorktreeText(i.continuation, i.worktree, { canonical: true }) : null,
        packet: i.contextText ? { text: i.contextText, files: i.contextFiles ?? [] } : null,
        check: i.check ? inWorktreeText(i.check, i.worktree, { canonical: true }) : null, checkTimeoutMs: i.check && / swarm check --baseline /.test(i.check) ? BASELINE_CHECK_BUDGET_MS : FOREMAN_BUDGET_MS,
        budget: { ...(i.paidCapUsd != null ? { maxUsd: i.paidCapUsd } : {}), ...(wd.reassignAfterMs > 0 ? { maxWallMs: Math.round(wd.reassignAfterMs * 1.5) } : {}) },
        route: i.route.map((m) => m.id),
        // Canonical paths: Koragent realpaths its cwd and compares tool targets against it as given.
        worktree: i.worktree ? { path: realPath(i.worktree.path), mainRoot: realPath(i.worktree.mainRoot), branch: i.worktree.branch } : { path: realPath(i.cwd), mainRoot: realPath(i.cwd), branch: '' },
        ...(i.runtimeMode ? { runtimeMode: i.runtimeMode } : {}),
        reportMdPath: i.reportPath, orchestratorId: i.orchestratorId,
        verify: { maxFixRounds: Math.max(0, Number(c?.maxBounces ?? 2)), escalateAfter: 1 },
      });
      const file = writeTaskSpec(taskSpecPath(i.reportPath), spec);
      const env = koragentPaneEnv({
        taskId: i.taskId, reportMdPath: i.reportPath, providers: i.route.map((m) => m.provider), apiKey: (p) => io.apiKey(p),
        route: i.route.map((m) => m.id),
        localBaseUrl: (p) => { try { return require('../config').loadConfig().swarm.local[p].baseUrl; } catch { return p === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234'; } },
      });
      // KORAGENT_PURE: no external plugins and no directory tools (`.koragent/tool/*.ts`, `.opencode/tools/*.ts`) — those
      // are repository code imported and run on load, with no trust prompt, in a headless worker. Kora's koragent
      // workers rely on neither (built-in plugins still load; state comes over the event stream).
      // Untrusted folder (trust/store.ts): no project `.koragent/` / `.opencode/` config either (KORAGENT_DISABLE_PROJECT_CONFIG).
      return { agent: 'koragent', command, args: ['--task-spec', file], env: { ...env, KORAGENT_PURE: '1', ...untrustedAgentEnv('koragent', i.worktree?.mainRoot ?? i.cwd) }, eventStream: true };
    },
  };
}

/** `git diff --name-only HEAD` + untracked files, off the event loop; kora's managed files dropped. */
async function defaultWorktreeClean(dir: string): Promise<boolean> {
  const st = await (require('./worktree') as typeof import('./worktree')).worktreeStatusAsync(dir);
  return st.dirty === 0 && st.ahead === 0;
}

export function gitChangedFiles(dir: string): Promise<string[]> {
  const run = (args: string[]) => new Promise<string>((resolve) => {
    execFile('git', [...GIT_NO_FSMONITOR, ...args], { cwd: dir, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20, env: gitEnv() }, (err, out) => resolve(err ? '' : String(out || '')));
  });
  return Promise.all([run(['diff', '--name-only', 'HEAD']), run(['ls-files', '--others', '--exclude-standard'])]).then(([a, b]) => {
    const { isManaged } = require('./worktree') as typeof import('./worktree');
    return [...new Set([...a.split('\n'), ...b.split('\n')].map((l) => l.trim()).filter(Boolean))].filter((f) => !isManaged(f)).sort();
  });
}

export class SwarmService {
  private readonly io: SwarmIO;
  private tasks: Map<string, TaskState> | null = null;
  private aliases = new Map<string, string>();
  private watched = new WeakSet<object>();

  private readonly backends: Record<WorkerBackendId, WorkerBackend>;

  constructor(readonly deps: { runtime: Runtime; setup: SwarmSetup; health: SwarmHealth; io?: Partial<SwarmIO> }) {
    this.io = { ...defaultIO(this), ...(deps.io ?? {}) };
    this.backends = { opencode: opencodeBackend(this.io), koragent: koragentBackend(this.io, () => this.io.config()) };
  }

  /** The WorkerBackend a task runs on (fixed at spawn; restored / pre-seam tasks are opencode). */
  private backendOf(t: TaskState): WorkerBackend { return this.backends[t.backend ?? 'opencode'] ?? this.backends.opencode; }
  private newTaskBackend(): WorkerBackendId { try { return this.io.workerBackend?.() === 'koragent' ? 'koragent' : 'opencode'; } catch { return 'opencode'; } }

  private get rt(): Runtime { return this.deps.runtime; }
  private registryFile(): string { return path.join(koraHome(), 'swarm', 'tasks.json'); }

  // ── task registry (journey c) ─────────────────────────────────────────────────────────────────────────
  private registry(): Map<string, TaskState> {
    if (this.tasks) return this.tasks;
    const m = new Map<string, TaskState>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile(), 'utf8'));
      for (const r of Array.isArray(raw?.tasks) ? raw.tasks : []) {
        if (!r || typeof r.taskId !== 'string' || !Array.isArray(r.paneIds)) continue;
        // A task that was mid-flight when the daemon stopped cannot still be running: its pane died with the daemon.
        // With its resume info it is relaunched by resumeAfterRestart (D17); without, it failed. A task that was only
        // QUEUED (no pane, no in-flight resume) never ran at all: it is dropped outright, plainly, never relaunched.
        const midFlight = !r.status || MID_FLIGHT.has(r.status);
        const wasQueued = r.status === 'queued';
        const ri = r.resume && typeof r.resume === 'object' && typeof r.resume.task === 'string' && typeof r.resume.cwd === 'string' ? r.resume as SwarmResumeInfo : null;
        const userStopped = r.userStopped === true;
        const record: SwarmTaskRecord = { taskId: r.taskId, orchestratorId: String(r.orchestratorId ?? ''), paneIds: r.paneIds.map(String), reportPath: String(r.reportPath ?? ''),
          // A task the human stopped is never resumed: it stays stopped (failed + userStopped).
          status: wasQueued ? 'failed' : midFlight && (!ri || userStopped) ? 'failed' : r.status, ...(userStopped ? { userStopped: true } : {}) };
        m.set(record.taskId, { record, cwd: ri?.cwd ?? '', task: ri?.task ?? '', title: ri?.title ?? '', worktree: ri?.worktree ?? null, failing: null,
          note: wasQueued ? `[kora] swarm task ${record.taskId} was queued but never started before a daemon restart; it was dropped — spawn it again.` : null,
          handledReportAt: 0, nudged: true, timers: [], restored: true, fromDisk: true, lastRetryNext: null,
          resume: wasQueued || userStopped ? null : midFlight ? ri : null, resumeLoaded: ri, lost: !wasQueued && !userStopped && midFlight && !ri, ...(userStopped ? { userStopped: true } : {}) });
      }
    } catch { /* none yet */ }
    this.tasks = m;
    return m;
  }

  /**
   * The daemon is stopping: write tasks.json once as it stands, then ignore the panes' deaths. Disposing the panes
   * fired every worker's exit, which recorded running tasks as failed (or done) — a restart then had nothing to resume.
   */
  private closing = false;
  shutdown(): void {
    if (this.closing) return;
    this.persist();
    this.closing = true;
    if (this.wdTimer) { clearInterval(this.wdTimer); this.wdTimer = null; }
    for (const t of this.registry().values()) { for (const x of t.timers) clearTimeout(x); t.timers = []; }
  }

  private persist(): void {
    if (this.closing) return;
    try {
      const file = this.registryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rows = [...this.registry().values()].map((t) => { const ri = this.resumeInfo(t); return ri ? { ...t.record, resume: ri } : t.record; }).slice(-500);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tasks: rows }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { log('swarm: tasks.json not written', e); }
  }

  /** The resume info a tasks.json row carries (live tasks: from their state; restored: what was loaded). */
  private resumeInfo(t: TaskState): SwarmResumeInfo | null {
    if (t.restored) return t.resumeLoaded ?? null;
    // A queued task never ran: nothing to relaunch, and it must never look mid-flight to a future daemon (dropped).
    if (t.record.status === 'queued' || !t.task) return null;
    const cur = this.rt.panes?.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
    return {
      cwd: t.cwd, task: t.task, title: t.title, ...(t.runtimeMode ? { runtimeMode: t.runtimeMode } : {}), worktree: t.worktree,
      backend: t.backend ?? 'opencode', check: t.fm?.check ?? null, ...(t.type ? { type: t.type } : {}),
      model: cur?.swarm?.model ?? null, provider: cur?.swarm?.provider ?? null, attempt: cur?.swarm?.attempt ?? 1, ...(t.kg?.recent?.length ? { recent: t.kg.recent } : {}),
    };
  }

  // Monotonic and synchronous: spawn registers the task only after several awaits (worktree, context packet, overlap),
  // so deriving the id from the registry alone gave two concurrent leaders the same id (found live, e2e: s6 twice).
  private taskSeq = 0;
  private nextTaskId(): string {
    let n = this.taskSeq;
    for (const id of this.registry().keys()) { const k = Number(id.slice(1)); if (Number.isFinite(k) && k > n) n = k; }
    this.taskSeq = n + 1;
    return `s${n + 1}`;
  }

  /**
   * The task a pane belongs to. Pane ids restart at p1 with the daemon, so a task restored from tasks.json can name
   * the same id as a live worker: found live (e10 e2e), the new p7's rate-limit event matched a restored task from an
   * earlier run, which "failed over" — killing the live worker and spawning one for a dead thread. Live tasks only,
   * unless `restored` (history lookups: lost-in-restart, a report file). `paneId` may also be a task id ("s7") — a
   * queued task has no pane yet, and every op (kora_wait / kora_read / kora_kill / kora_merge) resolves through here.
   */
  private taskOf(paneId: string, opts: { restored?: boolean } = {}): TaskState | null {
    if (isTaskRef(paneId)) { const t = this.registry().get(paneId); return t && (opts.restored || !t.restored) ? t : null; }
    for (const t of this.registry().values()) if (!t.restored && t.record.paneIds.includes(paneId)) return t;
    // Newest first: every daemon restart reuses p1, p2, … so several restored tasks claim the same id (found live:
    // kora_wait p1 after a restart matched a days-old task of another thread and answered "no worker p1 in this fleet").
    if (opts.restored) for (const t of [...this.registry().values()].reverse()) if (t.restored && t.record.paneIds.includes(paneId)) return t;
    return null;
  }

  /** The task a (possibly dead / pre-restart) pane belonged to. */
  taskForPane(paneId: string): SwarmTaskRecord | null {
    const t = this.taskOf(paneId) ?? this.taskOf(paneId, { restored: true });
    if (t && !t.restored) this.settleIfGone(t);
    return t ? { ...t.record, paneIds: [...t.record.paneIds] } : null;
  }

  /**
   * The done-checks (kora_spawn check:'…') of an orchestrator's tasks, distinct, newest first (kora_verify runs them once,
   * against the main checkout, after the merge). `paneIds` limits it to those workers' tasks.
   */
  checksFor(orchestratorId: string, paneIds?: string[]): { taskId: string; check: string }[] {
    const only = paneIds?.length ? new Set(paneIds.map((p) => this.taskOf(p, { restored: true })?.record.taskId).filter((x): x is string => !!x)) : null;
    const out: { taskId: string; check: string }[] = [];
    for (const t of [...this.registry().values()].reverse()) {
      if (t.record.orchestratorId !== orchestratorId || !t.fm?.check) continue;
      if (only && !only.has(t.record.taskId)) continue;
      if (!out.some((o) => o.check === t.fm!.check)) out.push({ taskId: t.record.taskId, check: t.fm.check });
    }
    return out;
  }

  /** True when the task was restored from disk by this daemon and its current pane is not live (journey c). */
  lostInRestart(paneId: string): boolean {
    if (this.taskOf(paneId)) return false; // a live task owns this id now
    const t = this.taskOf(paneId, { restored: true });
    // A task that finished before the restart was not lost: kora_wait answers with its status and report (D18).
    if (!t || !(t.lost || MID_FLIGHT.has(t.record.status))) return false;
    return !this.rt.panes.has(t.record.paneIds[t.record.paneIds.length - 1]);
  }

  /**
   * The worktree of a task that FINISHED (done) on a pane that no longer exists — reported before a daemon restart —
   * so kora_merge can still land it (D18). Null for live panes, unfinished tasks and tasks without a worktree.
   */
  finishedWorktree(paneId: string): { path: string; branch: string; mainRoot: string } | null {
    if (this.rt.panes.has(paneId)) return null;
    const t = this.taskOf(paneId) ?? this.taskOf(paneId, { restored: true });
    if (!t || t.record.status !== 'done') return null;
    const wt = t.worktree ?? t.resumeLoaded?.worktree ?? null;
    return wt && fs.existsSync(wt.path) ? wt : null;
  }

  /**
   * This orchestrator's tasks that finished before a daemon restart and still have their worktree (kora_workers lists
   * them: a leader that saw only the resumed worker re-dispatched the finished one — found live with a Claude leader).
   * A pane orchestrator's ids restart per daemon, so only one this daemon restored counts. Newest first, at most 20.
   */
  finishedTasks(orchestratorId: string): SwarmFinishedTask[] {
    if (!orchestratorId.startsWith('chat:') && !(this.rt as any).restoredPaneIds?.has?.(orchestratorId)) return [];
    const out: SwarmFinishedTask[] = [];
    for (const t of [...this.registry().values()].reverse()) {
      if (!t.restored || t.record.orchestratorId !== orchestratorId || t.record.status !== 'done') continue;
      const paneId = t.record.paneIds[t.record.paneIds.length - 1] ?? '';
      const wt = this.finishedWorktree(paneId);
      if (wt && !out.some((x) => x.paneId === paneId)) out.push({ paneId, taskId: t.record.taskId, status: t.record.status, worktree: wt.path, branch: wt.branch });
      if (out.length >= 20) break;
    }
    return out;
  }

  /** The last `[kora] …` note (failover / exhausted) of the task `paneId` belongs to. */
  note(paneId: string): string | null { return (this.taskOf(paneId) ?? this.taskOf(paneId, { restored: true }))?.note ?? null; }

  /**
   * May this orchestrator lead swarm workers? A chat thread: its PERSISTED mode must be 'swarm'. A pane orchestrator
   * (an orchestrator hosted in a pane, e.g. a Koragent lead reaching the runtime through `kora mcp --fleet`): the pane
   * is live and is a promoted orchestrator or a Koragent pane that is not itself a worker.
   */
  isSwarmThread(orchestratorId: string): boolean {
    try { if (this.io.threadMode(orchestratorId) === 'swarm') return true; } catch { /* fall through to panes */ }
    return this.isPaneOrchestrator(orchestratorId);
  }

  /**
   * The orchestrator's own posture, for a spawn that names none: a chat thread's stored runtime mode, else the
   * daemon's default runtime mode (settings.json `defaultRuntimeMode`, default full-access). Never throws.
   */
  orchestratorMode(orchestratorId: string): RuntimeMode | null {
    try { const m = this.io.orchestratorMode?.(orchestratorId); if (m && m in MODE_RANK) return m; } catch { /* default below */ }
    return null;
  }

  /** A live pane that orchestrates: role 'orchestrator', or a Koragent pane (lead mode) that is not a worker/swarm pane. */
  isPaneOrchestrator(orchestratorId: string): boolean {
    if (orchestratorId.startsWith('chat:')) return false;
    const pane = this.rt.panes.get(orchestratorId);
    if (!pane || pane.exited || pane.swarm) return false;
    return pane.role === 'orchestrator' || (pane.agent === 'koragent' && pane.role !== 'worker');
  }

  /**
   * The live pane for `paneId` after any failovers (identity when never replaced). `paneId` may be a task id ("s7"):
   * resolved to its current pane once the task has started, else returned unchanged (still queued, or unknown).
   */
  follow(paneId: string): string {
    let id = paneId;
    if (isTaskRef(id)) {
      const last = this.registry().get(id)?.record.paneIds.slice(-1)[0];
      if (!last) return id; // queued (or unknown): nothing to follow to yet
      id = last;
    }
    for (let i = 0; i < 16; i++) { const next = this.aliases.get(id); if (!next || next === id) break; id = next; }
    return id;
  }

  /** follow() after any in-flight failover of the task has finished (bounded) — what kora_wait uses. */
  async followSettled(paneId: string, timeoutMs = 120_000): Promise<string> {
    const t = this.taskOf(this.follow(paneId));
    if (t?.failing) await withTimeout(t.failing, timeoutMs, undefined);
    return this.follow(paneId);
  }

  // ── picking ───────────────────────────────────────────────────────────────────────────────────────────
  private liveSwarmPanes(): PaneLike[] {
    return [...this.rt.panes.values()].filter((p) => p.swarm && !p.exited && !p.swarm.supersededBy);
  }

  /** The next model: setup's pickable list (enabled providers and supply tiers in preference order, default first)
   *  minus cooling / excluded ones, respecting each model's maxConcurrent and OpenRouter's shared free-tier cap.
   *  Inside the first available tier (a provider's free models, the paid tier, or a local server) the model with the
   *  best measured outcomes for this task type wins (swarm-routing.ts); `preferFast` weighs time 4× (watchdog). */
  pickModel(exclude: string[] = [], opts: { type?: SwarmTaskType | null; task?: string; preferFast?: boolean; paidOnly?: boolean } = {}): SwarmModelInfo | null {
    let models: SwarmModelInfo[] = [];
    try { models = this.deps.setup.pickableModels(); } catch (e: any) { log(`swarm: pickableModels failed: ${e?.message ?? e}`); return null; }
    const live = this.liveSwarmPanes();
    const onModel = (id: string) => live.filter((p) => p.swarm!.model === id).length;
    // The 20/min cap is OpenRouter's FREE tier (shared across its `:free` models); paid models are not under it.
    const onOpenRouterFree = live.filter((p) => p.swarm!.provider === 'openrouter' && modelTier(p.swarm!.model) === 'free').length;
    const eligible = models.filter((m) => !exclude.includes(m.id) && this.deps.health.isAvailable(m.id)
      && !(opts.paidOnly && modelTier(m.id) !== 'paid')
      && !(m.maxConcurrent != null && onModel(m.id) >= m.maxConcurrent)
      && !(m.provider === 'openrouter' && modelTier(m.id) === 'free' && onOpenRouterFree >= OPENROUTER_MAX_WORKERS));
    if (!eligible.length) return null;
    // A user-chosen default model wins outright.
    const dflt = (() => { try { return this.io.config().defaultModel ?? null; } catch { return null; } })();
    if (dflt && eligible[0].id === dflt) return eligible[0];
    const tierOf = (m: SwarmModelInfo) => (modelTier(m.id) === 'paid' ? 'paid' : m.provider);
    const tier = eligible.filter((m) => tierOf(m) === tierOf(eligible[0]));
    const type = opts.type ?? (opts.task ? classifySwarmTask(opts.task) : null);
    let stats: RoutingStats = { models: new Map(), rows: 0 };
    try { stats = this.io.routingStats?.() ?? stats; } catch { /* no data: priors only */ }
    // Load costs 0.15 per live worker, so new workers still spread across a tier (ten leaders on one free model is
    // how a free tier gets rate-limited); a clearly better model can take a second worker.
    return rankModels(tier, type, { stats, load: onModel, ...(this.io.random ? { rnd: this.io.random } : {}), ...(opts.preferFast ? { preferFast: true } : {}) })[0] ?? null;
  }

  /**
   * "Pick a different model than X" (the foreman's retry hook): the best available model that is not `models`, for
   * this task (text or type). Returns null when nothing else is free right now. Never throws.
   */
  pickModelOtherThan(models: string | string[], opts: { task?: string; type?: SwarmTaskType; preferFast?: boolean } = {}): SwarmModelInfo | null {
    try { return this.pickModel(Array.isArray(models) ? models : [models], opts); } catch { return null; }
  }

  private nextFreeAt(): number | null {
    try { const c = this.deps.health.cooling(); return c.length ? Math.min(...c.map((x) => x.until)) : null; } catch { return null; }
  }

  // ── spawn ─────────────────────────────────────────────────────────────────────────────────────────────
  /** This orchestrator's queued task ids, FIFO (oldest first). */
  private queues = new Map<string, string[]>();

  /** Throws SwarmNotReadyError when setup is incomplete or the thread is not in swarm mode. */
  async spawn(p0: SwarmSpawnParams): Promise<SwarmSpawnResult> {
    // D5: the worker's posture — explicit request permission (capped by runtimeMode), else the orchestrator's own.
    const ceiling = this.orchestratorMode(p0.orchestratorId);
    let mode = swarmRuntimeMode(p0, p0.permission || p0.runtimeMode ? null : ceiling);
    // Never above the orchestrator's own posture as KORA stores it (deep audit 2026-10-13 A1-2): the request's
    // `runtimeMode` is the caller's word — a Codex lead's bridge has its launch-time mode, a raw socket call none — and
    // `permission: 'full'` alone used to win, so a supervised thread got Full-access workers and an unattended done-check.
    // A pane orchestrator has no stored posture of its own; its ceiling is the daemon default runtime mode (deep audit A1 D5:
    // its explicit `permission: 'full'` used to stand above a lower default).
    if (mode && ceiling && MODE_RANK[mode] > MODE_RANK[ceiling]) mode = ceiling;
    const p: SwarmSpawnParams = { ...p0, ...(mode ? { runtimeMode: mode } : {}) };
    // Consent + mode on EVERY spawn path, whoever the caller (journey m): a stale tool list mid-turn, a Codex
    // orchestrator, or an Orchestrator thread asking for agent:"swarm" all stop here.
    if (!this.isSwarmThread(p.orchestratorId)) throw new Error(`${SWARM_THREAD_REQUIRED} (${p.orchestratorId} is neither a Swarm-mode thread nor a live orchestrator pane). Use agent:"claude"/"codex" here, or ask the user to switch to Swarm.`);
    // Pick from the providers' LIVE free lists, not the seed catalog (bounded wait; a no-op when tested < 15 min ago).
    await (this.deps.setup as { ensureFresh?: () => Promise<void> }).ensureFresh?.();
    const status = await this.deps.setup.getStatus();
    if (!status.ready) throw new SwarmNotReadyError(status.blockers, { nextFreeAt: this.nextFreeAt() });
    const cfg = this.io.config();
    const maxWorkers = Math.min(status.preferences?.maxWorkers ?? cfg.maxWorkers, p.maxConcurrent && p.maxConcurrent > 0 ? p.maxConcurrent : Infinity);
    // Only workers still at work hold a slot (D16): a finished, failed or exhausted worker whose pane is still open
    // (done but not yet merged or killed) held it too, and a lead's retry dispatch was refused.
    const mine = this.liveSwarmPanes().filter((x) => x.orchestratorId === p.orchestratorId && SLOT_PHASES.has(x.swarm!.phase));
    if (mine.length >= maxWorkers) {
      if (!p.queue) throw new Error(`swarm: ${mine.length} workers already running (maxWorkers ${maxWorkers}) — kora_wait for one to finish (or kora_kill one) before spawning more`);
      return this.enqueueTask(p, maxWorkers);
    }
    return this.startTask(p, this.nextTaskId());
  }

  /** Over `maxWorkers` with `queue: true`: register a placeholder task and park it FIFO for `dispatchQueued`. */
  private enqueueTask(p: SwarmSpawnParams, maxWorkers: number): SwarmSpawnResult {
    const taskId = this.nextTaskId();
    const title = (p.title?.trim() || p.task.split('\n')[0].slice(0, 60).trim() || taskId);
    const t: TaskState = {
      record: { taskId, orchestratorId: p.orchestratorId, paneIds: [], reportPath: '', status: 'queued' },
      cwd: p.cwd, task: p.task, title, runtimeMode: p.runtimeMode, worktree: null, failing: null, note: null, handledReportAt: 0,
      nudged: false, timers: [], restored: false, lastRetryNext: null,
      race: p.race?.trim() || null, startedAt: Date.now(), milestones: [], msOffset: 0, lastChangeAt: null, lastChanged: [],
      msFile: null, queuedParams: p,
    };
    this.registry().set(taskId, t);
    const q = this.queues.get(p.orchestratorId) ?? [];
    q.push(taskId);
    this.queues.set(p.orchestratorId, q);
    this.persist();
    log(`swarm: task ${taskId} queued (position ${q.length}; ${maxWorkers} workers already running for ${p.orchestratorId})`);
    return { paneId: null, taskId, provider: '', model: '', modelLabel: '', reportPath: '', overlaps: [], queued: true, queuePosition: q.length };
  }

  /**
   * This orchestrator's queued (not yet started) tasks, FIFO order. Public for kora_workers / `swarm.queued`.
   */
  queuedTasks(orchestratorId: string): { taskId: string; title: string; position: number }[] {
    const q = this.queues.get(orchestratorId) ?? [];
    return q.map((taskId, i) => ({ taskId, title: this.registry().get(taskId)?.title ?? taskId, position: i + 1 }));
  }

  /**
   * A slot may have freed for `orchestratorId`: start its next queued task (FIFO), and keep draining while there is
   * room. Re-entrant-safe (one drain loop per orchestrator at a time); never throws — a task that fails to start is
   * marked failed with a note and the drain continues with the next one.
   */
  private draining = new Set<string>();
  private dispatchQueued(orchestratorId: string): void {
    void this.drainQueue(orchestratorId).catch((e) => log(`swarm: dispatchQueued(${orchestratorId}) failed`, e));
  }

  private async drainQueue(orchestratorId: string): Promise<void> {
    if (this.draining.has(orchestratorId)) return;
    this.draining.add(orchestratorId);
    try {
      for (;;) {
        const q = this.queues.get(orchestratorId);
        if (!q?.length) return;
        let maxWorkers = 4;
        try { const status = await this.deps.setup.getStatus(); maxWorkers = status.preferences?.maxWorkers ?? this.io.config().maxWorkers; } catch { try { maxWorkers = this.io.config().maxWorkers; } catch { /* default 4 */ } }
        const mine = this.liveSwarmPanes().filter((x) => x.orchestratorId === orchestratorId && SLOT_PHASES.has(x.swarm!.phase));
        const headParams = this.registry().get(q[0]!)?.queuedParams;
        if (headParams?.maxConcurrent && headParams.maxConcurrent > 0) maxWorkers = Math.min(maxWorkers, headParams.maxConcurrent);
        if (mine.length >= maxWorkers) return;
        const taskId = q.shift();
        if (!taskId) continue;
        const t = this.registry().get(taskId);
        const params = t?.queuedParams;
        if (!t || t.restored || t.record.status !== 'queued' || !params) continue; // cancelled / already handled
        try {
          await this.startTask(params, taskId);
        } catch (e: any) {
          t.record.status = 'failed';
          t.note = `[kora] swarm task ${taskId} could not start after waiting in the queue: ${e?.message ?? e}`;
          this.persist();
          log(`swarm: queued task ${taskId} failed to start: ${e?.message ?? e}`);
        }
      }
    } finally { this.draining.delete(orchestratorId); }
  }

  /** Actually create the worktree, context packet and pane for `taskId` (fresh spawn, or a queued task's turn). */
  private async startTask(p: SwarmSpawnParams, taskId: string): Promise<SwarmSpawnResult> {
    // A code worker is a full checkout; a Chat worker only writes a report into its project's scratch folder.
    if (isBlobsCwd(p.cwd)) assertDiskRoom('a swarm worker', p.cwd, Math.min(minFreeBytes(), CHAT_WORKER_MIN_FREE_BYTES));
    else assertDiskRoom('a swarm worker', require('./worktree').worktreesDir()); // each worker is a full checkout
    const type = classifySwarmTask(p.task);
    const model = this.pickModel([], { type });
    if (!model) throw new SwarmNotReadyError([{ code: 'all-models-cooling', message: 'every free model is cooling, gone or at its concurrency limit' }], { nextFreeAt: this.nextFreeAt() });

    const title = (p.title?.trim() || p.task.split('\n')[0].slice(0, 60).trim() || taskId);
    // The assistant lane is not a git repo: never try a worktree there (ownWorktree would just fail and fall back to
    // the plain cwd anyway — this skips that round trip), and the report lands in the CHAT PROJECT's own scratch/
    // dir rather than ~/.kora/swarm/reports, so it is a file the user's project (and kora_wait) can both find.
    const chatSurface = isBlobsCwd(p.cwd);
    // Always its own worktree, created here so $KORA_REPORT (inside it, R9) is known before launch.
    const backend = this.newTaskBackend();
    const { worktree, cwd } = chatSurface ? { worktree: null, cwd: p.cwd } : await this.ownWorktree(p.cwd, backend);
    const chatProjectRoot = chatSurface ? blobWorkspaceRootOf(p.cwd) : null;
    const reportPath = worktree
      ? path.join(worktree.path, '.kora', 'swarm', `${taskId}.md`)
      : chatProjectRoot
        ? path.join(chatProjectRoot, 'scratch', taskId, 'report.md')
        : path.join(koraHome(), 'swarm', 'reports', p.orchestratorId.replace(/^chat:/, '').replace(/[^\w.-]+/g, '_'), `${taskId}.md`);
    try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.rmSync(reportPath, { force: true }); } catch { /* spawn anyway */ }

    // X1 + X3: never block the spawn — both are bounded, and both degrade to nothing. The assistant lane has no code
    // graph and no worktree siblings to collide with: skip the packet build and the overlap check outright.
    const focus = (p.focus ?? []).map((f) => String(f).trim()).filter(Boolean);
    const packet = chatSurface ? { text: '', files: [] as string[] }
      : await withTimeout(this.io.contextPacket({ cwd, task: p.task, ...(focus.length ? { focus } : {}) }).catch(() => ({ text: '', files: [] })), focus.length ? FOCUS_PACKET_BUDGET_MS + 500 : CONTEXT_PACKET_BUDGET_MS, { text: '', files: [] });
    const overlaps = chatSurface ? [] : await this.overlapsFor(p.orchestratorId, packet.files);

    // Foreman (on by default: swarm.foremanRetries 2). The done-check is a shell command the worker never approved, so
    // it runs unattended only where the thread already lets workers run shell commands unattended.
    const cfg = this.io.config();
    const check = p.check?.trim() || null;
    const unattended = p.runtimeMode === 'full-access' || p.runtimeMode === 'auto';
    const checkRefused = check && !unattended ? `check not run: it runs unattended, which needs the thread in Full access or Auto mode (this thread: ${p.runtimeMode ?? 'approval-required'})` : null;
    const retries = Math.max(0, Math.min(5, Number(cfg.foremanRetries ?? 0) || 0));
    const review = cfg.foremanReview === true;
    const fm: SwarmForemanState | null = retries > 0 || (check && !checkRefused) || review
      ? { state: 'working', attempt: 1, maxAttempts: 1 + retries, check: checkRefused ? null : check, review, verdicts: [], result: null }
      : null;
    const t: TaskState = {
      record: { taskId, orchestratorId: p.orchestratorId, paneIds: [], reportPath, status: 'starting' },
      cwd, task: worktree ? `${p.task}\n${WORKER_AID}` : p.task, title, runtimeMode: p.runtimeMode, worktree, failing: null, note: null, handledReportAt: 0,
      nudged: false, timers: [], restored: false, lastRetryNext: null, type, fm, fmStartedAt: Date.now(), fmNoReportPane: null,
      backend, contextFiles: packet.files,
      race: p.race?.trim() || null, startedAt: Date.now(), milestones: [], msOffset: 0, lastChangeAt: null, lastChanged: [],
      msFile: worktree ? writeWorkerHelpers({ worktree: worktree.path, taskId, node: process.execPath, koraJs: path.resolve(__dirname, '../../bin/kora.js'),
        env: { KORAGRAPH_DB: process.env.KORAGRAPH_DB, KORAGRAPH_HOME: process.env.KORAGRAPH_HOME, KORA_HOME: koraHome() } }) : null,
    };
    this.registry().set(taskId, t);
    this.startMilestoneTicker();
    // Judge the check against the commit the worker starts from (pre-existing failures are not its fault). Computed in
    // the background, once per commit + command; the wrapper waits for it only if the check actually fails.
    if (fm?.check && worktree?.mainRoot) {
      try { t.checkBaseline = await ensureBaseline(worktree.mainRoot, fm.check, (cmd, dir, ms) => runCheck(cmd, dir, ms, { keepOutput: true })); } catch { t.checkBaseline = null; }
    }
    const pane = await this.launch(t, model, { attempt: 1, attempts: [], previousPaneIds: [], contextText: packet.text });
    return { paneId: pane.id, taskId, provider: model.provider, model: model.id, modelLabel: model.label || modelLabel(model.id), reportPath, overlaps,
      foreman: fm || checkRefused ? { check: fm?.check ?? null, maxAttempts: fm?.maxAttempts ?? 1, review, checkRefused } : null,
      agent: backend, permission: koragentPermission(p.runtimeMode), queued: false,
      ...(!worktree && !chatSurface ? { sharedFolder: true } : {}) };
  }

  private async ownWorktree(cwd0: string, agent: WorkerBackendId = 'opencode'): Promise<{ worktree: { path: string; branch: string; mainRoot: string } | null; cwd: string }> {
    try {
      const wt = require('./worktree') as typeof import('./worktree');
      // In a child: creating a worktree is several synchronous git calls, and ten leaders spawning at once blocked the
      // daemon's event loop for 30 s (CPU profile, e2e).
      const r = await wt.worktreeInChild<ReturnType<typeof wt.prepareAgentWorktree>>('prepareAgentWorktree', [cwd0, agent]);
      if (!r) return { worktree: null, cwd: cwd0 };
      // Its graph root is known: prime the cache so the pane spawn does not re-derive it with sync git calls.
      try {
        const g = (this.rt as any).graph;
        for (const p of new Set([r.worktree.path, r.cwd])) { g?.primeRepoRoot?.(p, r.worktree.mainRoot); }
        require('../graph/embedded').primeGitTopLevel(r.worktree.path, r.worktree.path);
        wt.primeWorktreeFacts(r.worktree.path, r.worktree.mainRoot);
        require('../enforce/takeover').primeHooksDir(r.worktree.path, r.worktree.mainRoot);
      } catch { /* optional */ }
      return r;
    } catch (e: any) {
      log(`swarm: no worktree for ${cwd0} (${e?.message ?? e}); the report goes under ~/.kora/swarm/reports`);
      return { worktree: null, cwd: cwd0 };
    }
  }


  private async overlapsFor(orchestratorId: string, files: string[]): Promise<SwarmOverlap[]> {
    if (!files.length) return [];
    const running = this.liveSwarmPanes().filter((x) => x.orchestratorId === orchestratorId && x.worktree);
    if (!running.length) return [];
    const touched = await withTimeout(Promise.all(running.map(async (x) => ({ paneId: x.id, files: await this.io.changedFiles(x.worktree!.path).catch(() => []) }))), OVERLAP_BUDGET_MS, [] as { paneId: string; files: string[] }[]);
    try { return this.io.overlap({ files, running: touched }); } catch { return []; }
  }

  /** Start one attempt of a task on `model` in the task's worktree. */
  private async launch(t: TaskState, model: SwarmModelInfo, a: { attempt: number; attempts: SwarmWorkerMeta['attempts']; previousPaneIds: string[]; contextText?: string; continuation?: string; keepPaneId?: string }): Promise<PaneLike> {
    const { taskId, reportPath, orchestratorId } = t.record;
    const meta: SwarmWorkerMeta = {
      taskId, provider: model.provider, model: model.id, modelLabel: model.label || modelLabel(model.id), phase: 'starting',
      attempt: a.attempt, attempts: [...a.attempts], reportPath, report: null, supersededBy: null, previousPaneIds: [...a.previousPaneIds], verify: null,
      ...(t.fm ? { foreman: t.fm } : {}),
    };
    const backend = this.backendOf(t);
    // Koragent walks the route inside its session (route.failover); OpenCode gets one model per pane.
    const route = backend.eventDriven ? this.routeFor(t, model, a.attempts.map((x) => x.model)) : [model];
    const paid = route.some((m) => modelTier(m.id) === 'paid');
    const plan = backend.plan({
      taskId, reportPath, orchestratorId, cwd: t.cwd, task: t.task, title: t.title, ...(t.runtimeMode ? { runtimeMode: t.runtimeMode } : {}),
      worktree: t.worktree, model, meta, ...(a.contextText ? { contextText: a.contextText, contextFiles: t.contextFiles ?? [] } : {}),
      ...(a.continuation ? { continuation: a.continuation } : {}),
      route, check: this.effectiveCheck(t), paidCapUsd: paid ? (() => { try { return this.io.config().paidMaxTaskUsd ?? 0.05; } catch { return 0.05; } })() : null,
    });
    const { command, args, env } = plan;
    const rt = this.rt as any;
    const info = await this.rt.agentSpawn({
      agent: plan.agent, cwd: t.cwd, args, env, name: t.title, orchestratorId,
      ...(command ? { command } : {}),
      ...(typeof rt.chatWorkspaceId === 'function' && orchestratorId.startsWith('chat:') ? { workspaceId: rt.chatWorkspaceId() } : {}),
      // A pane orchestrator's workers sit in its workspace, beside it.
      ...(!orchestratorId.startsWith('chat:') && this.rt.panes.get(orchestratorId)?.workspaceId ? { workspaceId: this.rt.panes.get(orchestratorId)!.workspaceId } : {}),
      ...(t.worktree ? { reuseWorktree: t.worktree } : { worktree: false }),
      skipWorkerPermission: true,
      // Third-party model: an allowlisted env, never the user's shell credentials (worker-env.ts).
      isolatedEnv: true,
      ...(plan.eventStream ? { eventStream: true } : {}),
      ...(a.keepPaneId ? { paneId: a.keepPaneId } : {}),
    });
    const pane = this.rt.panes.get(info.id);
    if (!pane) throw new Error(`swarm: pane ${info.id} vanished right after spawn`);
    meta.attempts.push({ paneId: pane.id, provider: model.provider, model: model.id, outcome: 'running', at: Date.now() });
    pane.swarm = meta;
    if (backend.eventDriven) {
      // Koragent says busy before its first draw and its state comes from events: no prompt-pending hold.
      t.kg = { lastAt: Date.now(), usd: t.kg?.usd ?? 0, steps: 0, report: null, reportTs: 0, recent: [] };
      this.attachKoragent(t, pane);
    } else {
      // The prompt rides in argv, so the start-up "Ask anything" screen reads idle: hold waits until the first working
      // state (or the plugin's busy), capped — the early-false-idle fix.
      pane.promptPending = true;
      const cap = setTimeout(() => this.releasePending(pane), PROMPT_PENDING_CAP_MS); cap.unref?.();
      t.timers.push(cap);
    }
    if (t.record.paneIds[t.record.paneIds.length - 1] !== pane.id) t.record.paneIds.push(pane.id);
    t.record.status = 'starting';
    t.wd = { attemptAt: Date.now(), nudgedAt: null, idleSince: null, budgetStopAt: null, nudges: t.wd?.nudges ?? 0 };
    this.watch(t, pane);
    this.startWatchdog();
    this.startStepTicker();
    this.persist();
    this.touch(pane);
    log(`swarm: task ${taskId} attempt ${a.attempt} → ${pane.id} on ${model.id}${t.worktree ? ` in ${t.worktree.path}` : ''}`);
    return pane;
  }

  private touch(pane: PaneLike): void {
    this.syncRecord(pane);
    try { this.rt.notify('pane.updated', pane.info()); } catch { /* fake runtime */ }
  }

  /**
   * The registry row mirrors its CURRENT pane's phase. Several paths replace `pane.swarm` directly (verify, failover,
   * exhausted, cleanup) and only some updated `record.status`, so tasks.json (and kora_wait's "no longer running
   * (running)") could say `running` for a finished task. Every touch() now re-syncs it.
   */
  private syncRecord(pane: PaneLike): void {
    const t = this.taskOf(pane.id);
    if (!t || !pane.swarm || pane.swarm.supersededBy || t.record.paneIds[t.record.paneIds.length - 1] !== pane.id) return;
    if (t.record.status === pane.swarm.phase) return;
    t.record.status = pane.swarm.phase;
    this.persist();
  }

  /** A task whose current pane is gone (reaped, killed without an exit event) cannot still be running. */
  private settleIfGone(t: TaskState): void {
    if (!['starting', 'running', 'rate-limited'].includes(t.record.status) || t.failing) return;
    const cur = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
    if (cur && !cur.exited) return;
    t.record.status = this.reportStat(t.record.reportPath) ? 'done' : 'failed';
    if (cur?.swarm && !cur.swarm.supersededBy) cur.swarm = { ...cur.swarm, phase: t.record.status };
    this.persist();
  }

  private releasePending(pane: PaneLike): void {
    if (!pane.promptPending) return;
    pane.promptPending = false;
    pane.emit('state', pane.state, pane.blocker, pane.state); // let parked waits re-check
  }

  private setPhase(t: TaskState, pane: PaneLike, phase: SwarmWorkerPhase): void {
    if (!pane.swarm || pane.swarm.phase === phase) return;
    pane.swarm = { ...pane.swarm, phase };
    t.record.status = phase;
    this.persist();
    this.touch(pane);
    if (phase === 'done' || phase === 'failed') this.logOutcome(t, pane);
    if (phase === 'done') this.retireLater(t, pane);
    if (!SLOT_PHASES.has(phase)) this.dispatchQueued(t.record.orchestratorId);
  }

  /**
   * Close a finished helper that has nothing to merge (a assistant-lane worker runs in the project folder, no
   * worktree) once the lead has had time to read its report — it would otherwise idle on: live, five research
   * helpers held ~1.4 GB after the answer was written. Its report file stays; kora_wait still returns it.
   * A worktree worker is closed when its branch is merged instead (Runtime.worktreeMerge).
   */
  private retireLater(t: TaskState, pane: PaneLike): void {
    const ms = this.io.retireDoneMs ?? 90_000;
    if (ms > 0) {
      const timer = setTimeout(() => { void this.retireNow(t, pane); }, ms);
      timer.unref?.();
      t.timers.push(timer);
    }
    this.retireUnmergedLater(t, pane);
  }

  /**
   * Retire a completed-but-unmerged swarm worker after 10 minutes idle (600_000 ms), reclaiming ~0.8 GB OpenCode RSS.
   * Follows the existing retire-on-merge pattern (pane.retired = true, then kill): the worktree and branch remain intact.
   * Never retires a worker that is still working or that the user holds open (sizeOwnerConnId).
   */
  private retireUnmergedLater(t: TaskState, pane: PaneLike): void {
    const ms = this.io.retireUnmergedMs ?? 600_000;
    if (!(ms > 0)) return;
    const timer = setTimeout(() => { void this.retireUnmergedNow(t, pane); }, ms);
    timer.unref?.();
    t.timers.push(timer);
  }

  private async retireUnmergedNow(t: TaskState, pane: PaneLike): Promise<void> {
    if (this.closing || pane.exited || pane.retired || this.rt.panes.get(pane.id) !== pane || pane.swarm?.phase !== 'done') return;
    if (pane.branchMerged) return;
    // Never retire a worker that is still working: only confirmed worker states count (swarm-state.ts)
    const isWorking = (pane.state === 'working' && swarmWorkingConfirmed(pane)) || pane.state === 'blocked';
    const isIdle = pane.state === 'idle' && swarmIdleConfirmed(pane);
    if (isWorking || !isIdle) {
      const retry = setTimeout(() => { void this.retireUnmergedNow(t, pane); }, 60_000);
      retry.unref?.();
      t.timers.push(retry);
      return;
    }
    // Never retire a worker that the user holds open
    if (pane.sizeOwnerConnId != null || (pane as any).userOpen || (pane as any).heldOpen) {
      const retry = setTimeout(() => { void this.retireUnmergedNow(t, pane); }, 60_000);
      retry.unref?.();
      t.timers.push(retry);
      return;
    }
    pane.retired = true;
    log(`swarm: ${pane.id} (task ${t.record.taskId}) completed but unmerged after 10 min idle \u2014 closing its worker`);
    try { pane.kill('SIGTERM'); } catch { /* already gone */ }
  }

  /**
   * The retire step. A no-worktree helper is closed. A worktree worker is closed only when its worktree is CLEAN (no
   * edits, no commits: a read-only research or kora_map helper, QA 2026-10-10 left nine worktrees + five idle
   * OpenCodes behind): its report is copied out of the worktree first (kora_wait keeps working), the pane is closed
   * and the worktree + branch swept at once instead of at the next periodic sweep. A worker with changes waits for
   * its merge (Runtime.worktreeMerge).
   */
  private async retireNow(t: TaskState, pane: PaneLike): Promise<void> {
    const still = () => !this.closing && !pane.exited && this.rt.panes.get(pane.id) === pane && pane.swarm?.phase === 'done' && pane.state !== 'working' && pane.state !== 'blocked';
    if (!still()) return;
    let sweepRoot: string | null = null;
    if (t.worktree) {
      let clean = false;
      try { clean = await (this.io.worktreeClean ?? defaultWorktreeClean)(t.worktree.path); } catch { clean = false; }
      if (!clean || !still()) return;
      // Keep the report readable after the worktree is gone: it lives in the worktree's .kora/ until now.
      try {
        const from = t.record.reportPath;
        if (from && fs.existsSync(from)) {
          const to = path.join(koraHome(), 'swarm', 'reports', t.record.orchestratorId.replace(/^chat:/, '').replace(/[^\w.-]+/g, '_'), `${t.record.taskId}.md`);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          t.record.reportPath = to;
          if (pane.swarm) pane.swarm = { ...pane.swarm, reportPath: to };
          this.persist();
        }
      } catch { /* the report stays where it is; the sweep keeps a worktree it cannot clear */ }
      sweepRoot = t.worktree.mainRoot;
    }
    pane.retired = true;
    log(`swarm: ${pane.id} (task ${t.record.taskId}) finished with nothing to merge \u2014 closing it`);
    try { pane.kill('SIGTERM'); } catch { /* already gone */ }
    if (sweepRoot) {
      // The pane has to be gone before the sweep treats its worktree as an orphan.
      const root = sweepRoot;
      const sweep = setTimeout(() => { void Promise.resolve((this.rt as any).worktreeSweep?.({ repos: [root], minAgeMs: 60_000 })).catch(() => {}); }, 3_000);
      sweep.unref?.();
    }
  }

  /**
   * One line per finished task in ~/.kora/swarm/outcomes.jsonl — the measured inputs for `kora swarm usage` (jobs per
   * Claude window, workers per job, retries, pass rate, free vs paid, worker tokens joined from OpenCode's own DB).
   * Local only; nothing leaves the machine. Written once per task; never throws.
   */
  private logOutcome(t: TaskState, pane: PaneLike): void {
    if ((t as any).logged || !pane.swarm) return;
    (t as any).logged = true;
    try {
      const m = pane.swarm;
      const startedAt = m.attempts.length ? Math.min(...m.attempts.map((a) => a.at)) : Date.now();
      const row = {
        v: 1, ts: Date.now(), thread: t.record.orchestratorId, taskId: t.record.taskId, status: m.phase,
        startedAt, durationMs: Date.now() - startedAt, title: redactSecrets(t.title.slice(0, 120)),
        attempts: m.attempts.map((a) => ({ model: a.model, provider: a.provider, outcome: a.outcome, at: a.at })),
        verify: m.verify ? { state: m.verify.state, bounces: m.verify.bounces } : null,
        reportBytes: m.report?.bytes ?? null, worktree: t.worktree?.path ?? null,
        // WorkerBackend (opencode | koragent); Koragent's own usage when its report carried one.
        backend: t.backend ?? 'opencode',
        // tokens: the session's totals (every round), what `kora swarm usage` reports for Koragent workers.
        ...(t.kg?.report ? { usage: { steps: t.kg.report.usage.steps, costUsd: t.kg.report.usage.costUsd, refCostUsd: t.kg.report.usage.refCostUsd, tokens: { ...t.kg.report.usage.tokens } } } : {}),
        // Routing (swarm-routing.ts): the task type, and how often the watchdog / idle nudge had to step in.
        type: t.type ?? classifySwarmTask(t.task), nudges: (t.wd?.nudges ?? 0) + (t.nudged ? 1 : 0),
        // Every foreman attempt: model, check result, gate, reviewer, duration (null = foreman off).
        foreman: t.fm ? {
          result: t.fm.result?.kind ?? null, maxAttempts: t.fm.maxAttempts, check: t.fm.check, review: t.fm.review,
          attempts: t.fm.verdicts.map((v) => ({ attempt: v.attempt, model: v.model, check: v.check ? { state: v.check.state, exitCode: v.check.exitCode, ms: v.check.durationMs } : null,
            gate: v.gate, reviewer: v.review ? { verdict: v.review.verdict, model: v.review.model } : null, failure: v.failure, durationMs: v.durationMs })),
        } : null,
      };
      const file = path.join(koraHome(), 'swarm', 'outcomes.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch (e) { log('swarm: outcome not logged', e); }
  }

  /**
   * A task that had reported when the daemon stopped (kept done on restart) never passed through setPhase('done'), so its
   * outcome line was never written and the pass-rate data lost it (QA 2026-10-10: s6). Written once, with what is known.
   */
  private logRestoredOutcome(t: TaskState, ri: SwarmResumeInfo): void {
    if ((t as any).logged) return;
    (t as any).logged = true;
    try {
      const st = this.reportStat(t.record.reportPath);
      const row = {
        v: 1, ts: Date.now(), thread: t.record.orchestratorId, taskId: t.record.taskId, status: 'done', restored: true,
        startedAt: null, durationMs: null, title: redactSecrets((ri.title ?? t.title ?? '').slice(0, 120)),
        attempts: [], verify: null, reportBytes: st?.size ?? null, worktree: ri.worktree?.path ?? null,
        backend: ri.backend ?? 'opencode', type: classifySwarmTask(ri.task ?? ''), nudges: 0, foreman: null,
      };
      const file = path.join(koraHome(), 'swarm', 'outcomes.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch (e) { log('swarm: restored outcome not logged', e); }
  }

  private watch(t: TaskState, pane: PaneLike): void {
    if (this.watched.has(pane)) return;
    this.watched.add(pane);
    // Only CONFIRMED states count (swarm-state.ts): the start-up blank/draw of the TUI reads as idle/working via the
    // tracker's no-rule fallback. An unconfirmed state is looked at again every second until it confirms or changes.
    let recheck: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      recheck = null;
      if (!pane.swarm || pane.swarm.supersededBy || pane.exited) return;
      if (pane.state === 'working') {
        if (!swarmWorkingConfirmed(pane)) { schedule(); return; }
        this.releasePending(pane);
        if (t.wd) t.wd.idleSince = null;
        if (pane.swarm.phase === 'starting') this.setPhase(t, pane, 'running');
      } else if (pane.state === 'idle' && !pane.promptPending) {
        if (!swarmIdleConfirmed(pane)) { schedule(); return; }
        this.onIdle(t, pane);
      }
    };
    const schedule = () => { if (recheck) return; recheck = setTimeout(evaluate, 1000); recheck.unref?.(); t.timers.push(recheck); };
    // A Koragent worker's lifecycle is driven by its events (onKoragentEvent), never by the pane's state.
    const evented = this.backendOf(t).eventDriven;
    if (!evented) pane.on('state', () => { if (recheck) { clearTimeout(recheck); recheck = null; } evaluate(); });
    pane.on('exit', () => {
      for (const x of t.timers) clearTimeout(x);
      t.timers = [];
      if (this.closing || !pane.swarm || pane.swarm.supersededBy || t.failing) return;
      // The file fallback: a report Koragent wrote as JSON only (or sent just before it quit) becomes the .md here.
      if (evented) ensureReportFiles(t.record.reportPath, t.kg?.report ?? null);
      const phase = pane.swarm.phase;
      if (phase === 'exhausted' || phase === 'respawning') return;
      // Foreman: a worker that exited on its own (its pane is still registered — a kill removes it first) before the
      // foreman accepted it is a crash worth a retry; a check already under way finishes on its own.
      if (this.fmActive(t) && phase !== 'done' && phase !== 'failed' && this.rt.panes.get(pane.id) === pane) {
        if (t.fm!.state === 'checking') return;
        if (this.reportStat(t.record.reportPath)) { this.fmSet(t, pane, { state: 'checking' }); this.settle(t, pane); return; } // reported, then quit
        this.foremanFail(t, pane, 'crashed', { extra: this.workerTail(t, pane) }).catch((e) => log('swarm: foreman retry failed', e));
        return;
      }
      const hasReport = this.reportStat(t.record.reportPath) != null;
      this.setPhase(t, pane, hasReport ? 'done' : 'failed');
    });
    if (!evented && this.io.screenPollMs > 0) {
      const poll = setInterval(() => {
        if (pane.exited || !pane.swarm || pane.swarm.supersededBy) { clearInterval(poll); return; }
        if (t.failing || pane.state !== 'working') return;
        let screen = '';
        try { screen = pane.read('detection'); } catch { return; }
        const down = PROVIDER_DOWN_RE.test(screen) && MANY_RETRIES_RE.test(screen);
        if (/retrying/i.test(screen) && (RATE_LIMIT_RE.test(screen) || down)) {
          log(`swarm: ${pane.id} screen shows ${down ? 'a provider outage' : 'a rate-limit'} retry on ${pane.swarm.model}`);
          this.failover(t.record.taskId, 'rate-limited').catch((e) => log('swarm: failover failed', e));
        }
      }, this.io.screenPollMs);
      poll.unref?.();
      t.timers.push(poll as unknown as NodeJS.Timeout);
    }
  }

  private reportStat(file: string): { size: number; mtimeMs: number } | null {
    // lstat: a report path the worker (or the repo) turned into a symlink is not a report — it would hand the leader and
    // the UI whatever file it points at (~/.ssh/…).
    try { const st = fs.lstatSync(file); return st.isFile() && st.size > 0 ? { size: st.size, mtimeMs: st.mtimeMs } : null; } catch { return null; }
  }

  private readPreview(file: string): string {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const buf = Buffer.alloc(PREVIEW_CHARS * 4); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).toString('utf8').slice(0, PREVIEW_CHARS); } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  /** The worker went idle: a report → verify (X2) → report event; none → one nudge after nudgeMs (journey l). */
  private onIdle(t: TaskState, pane: PaneLike): void {
    const meta = pane.swarm!;
    const st = this.reportStat(t.record.reportPath);
    if (!st) {
      if (t.wd && t.wd.idleSince == null) t.wd.idleSince = Date.now();
      if (t.nudged) { if (this.fmActive(t)) this.foremanNoReport(t, pane); return; }
      const timer = setTimeout(() => {
        if (t.nudged || pane.exited || pane.state !== 'idle' || !swarmIdleConfirmed(pane) || !pane.swarm || pane.swarm.supersededBy) return;
        if (this.reportStat(t.record.reportPath)) return;
        t.nudged = true;
        log(`swarm: ${pane.id} idle ${Math.round(this.io.nudgeMs / 1000)} s without a report — nudging once`);
        this.say(pane, `Write your report to ${t.record.reportPath} now (what you changed, how you verified it, what is left). Then stop.`, true, 30_000)
          .catch((e: any) => log(`swarm: ${pane.id} nudge not delivered: ${e?.message ?? e}`));
      }, this.io.nudgeMs);
      timer.unref?.();
      t.timers.push(timer);
      return;
    }
    const fresh = st.mtimeMs !== t.handledReportAt;
    const reverify = meta.verify?.state === 'bounced';
    if (!fresh && !reverify) return;
    t.handledReportAt = st.mtimeMs;
    pane.swarm = { ...meta, report: { bytes: st.size, updatedAt: Math.round(st.mtimeMs), preview: this.readPreview(t.record.reportPath) } };
    const attempts = pane.swarm.attempts.map((x) => (x.paneId === pane.id && x.outcome === 'running' ? { ...x, outcome: 'ok' as const } : x));
    pane.swarm = { ...pane.swarm, attempts };
    // Foreman: from here until its verdict the report is on hold (kora_wait keeps waiting) — set synchronously.
    if (this.fmActive(t)) this.fmSet(t, pane, { state: 'checking' });
    const cfg = this.io.config();
    if (!cfg.autoVerify || !pane.worktree) {
      pane.swarm = { ...pane.swarm, verify: cfg.autoVerify ? { state: 'skipped', bounces: 0, summary: 'no worktree to verify' } : null };
      this.touch(pane);
      this.settle(t, pane);
      return;
    }
    // Synchronously pending, so a kora_wait woken by this same idle sees "verify running" and keeps waiting.
    pane.swarm = { ...pane.swarm, verify: { state: 'pending', bounces: meta.verify?.bounces ?? 0, summary: null } };
    this.touch(pane);
    this.verifyAndBounce(pane.id).then((v) => {
      if (v.state === 'bounced') { if (this.fmActive(t)) this.fmSet(t, pane, { state: 'working' }); return; } // the worker is fixing it; Claude hears nothing yet (X2)
      this.settle(t, pane);
    }).catch((e) => log(`swarm: verify ${pane.id} failed`, e));
  }

  /** The report passed X2 (or X2 is off): done — unless the foreman has the last word. */
  private settle(t: TaskState, pane: PaneLike): void {
    if (this.fmActive(t)) { this.runForeman(t, pane).catch((e) => { log(`swarm: foreman ${pane.id} failed`, e); this.escalate(t, pane, `foreman error: ${e?.message ?? e}`).catch(() => {}); }); return; }
    this.setPhase(t, pane, 'done');
    this.emitWorker(t, { kind: 'report', paneId: pane.id, taskId: t.record.taskId, ...(pane.swarm?.verify ? { verify: pane.swarm.verify } : {}) });
  }

  // ── foreman: done-check → reviewer → pass | retry | escalate ─────────────────────────────────────────
  /** The foreman still owns this task's outcome (after its verdict, a leader's follow-up turn is plain X2 again). */
  private fmActive(t: TaskState): boolean { return !!t.fm && t.fm.state !== 'passed' && t.fm.state !== 'escalated'; }

  private fmSet(t: TaskState, pane: PaneLike | null, patch: Partial<SwarmForemanState>): void {
    if (!t.fm) return;
    t.fm = { ...t.fm, ...patch };
    if (pane?.swarm) { pane.swarm = { ...pane.swarm, foreman: t.fm }; this.touch(pane); }
  }

  private fmDirs(t: TaskState, pane: PaneLike): { dir: string; mainRoot: string | null } {
    const wt = pane.worktree ?? t.worktree;
    return { dir: wt?.path ?? t.cwd, mainRoot: wt?.mainRoot ?? null };
  }

  private screenTail(pane: PaneLike): string {
    try { return tailOf(pane.read('screen'), 15, 800); } catch { return ''; }
  }

  /**
   * What a retry brief says about the attempt that ended (D21). OpenCode: its screen tail. Koragent: its last report
   * and events — a Koragent pane's screen is TUI chrome (HUD, footer), and it went into the next worker's prompt as text.
   */
  private workerTail(t: TaskState, pane: PaneLike): string {
    if (this.backendOf(t).eventDriven) return koragentDigest(t.kg ?? null);
    const tail = this.screenTail(pane);
    return tail ? `worker screen (tail):\n${tail}` : '';
  }

  /** The first 2 KB of a report (the Status section is at the top); '' when none. */
  private readHead(file: string): string {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const buf = Buffer.alloc(2048); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  private reportGist(t: TaskState, status: string): string {
    const r = t.kg?.report;
    if (!r) return `worker report: status ${status}`;
    return [`worker report: status ${r.status}${r.summary ? ` — ${r.summary.slice(0, 400)}` : ''}`, ...r.blockers.slice(0, 5).map((b) => `blocker: ${b.slice(0, 300)}`)].join('\n');
  }

  /** The done-check as run: judged against the base commit when a baseline is known. */
  private effectiveCheck(t: TaskState): string | null {
    const c = t.fm?.check ?? null;
    if (!c) return null;
    return t.checkBaseline ? wrapCheck(c, t.checkBaseline) : c;
  }

  private async runForeman(t: TaskState, pane: PaneLike): Promise<void> {
    const fm = t.fm!;
    const { dir, mainRoot } = this.fmDirs(t, pane);
    const verify = pane.swarm?.verify ?? null;
    const gate = gateOf(verify);
    let check: SwarmForemanCheck | null = null;
    // The check runs in the worker's worktree; a `cd <main checkout>` in it would test the main checkout instead.
    if (fm.check) check = await this.io.runCheck(inWorktreeText(this.effectiveCheck(t)!, pane.worktree ?? t.worktree), dir).catch((e: any) => ({ state: 'error' as const, exitCode: null, durationMs: 0, tail: String(e?.message ?? e) }));
    if (pane.swarm?.supersededBy || !this.fmActive(t) || t.fm!.attempt !== fm.attempt) return; // superseded meanwhile
    // A check that could not start is the machine's fault, not the worker's: recorded, never a failure.
    let failure: SwarmForemanVerdict['failure'] = gate === 'failed' ? 'gate' : check && (check.state === 'failed' || check.state === 'timeout') ? 'check' : null;
    let diff: Awaited<ReturnType<SwarmIO['diff']>> | null = null;
    // D19: the worker's own verdict counts. A report that says failed / partial / blocked / budget is not a pass (a
    // `blocked (failed)` report with no diff read "foreman: PASS"), and neither is an edit task that changed nothing.
    let reportNote: string | null = null;
    if (!failure) {
      const st = reportStatus(t.kg?.report?.status, this.readHead(t.record.reportPath));
      if (st && NOT_DONE_STATUSES.has(st)) { failure = 'report'; reportNote = this.reportGist(t, st); }
    }
    // A assistant-lane task has no worktree and its deliverable is the report (or files it was told to write): never
    // judge it by a diff — a research report that "changed nothing" is exactly right there.
    const chatTask = isBlobsCwd(t.cwd);
    if (!failure && !chatTask && (t.type ?? classifySwarmTask(t.task)) !== 'research') {
      diff = await this.io.diff(dir, mainRoot).catch(() => null);
      if (isEmptyDiff(diff)) failure = 'no-change';
    }
    let review: SwarmForemanReview | null = null;
    if (!failure && fm.review && !chatTask) {
      diff = await this.io.diff(dir, mainRoot).catch(() => null);
      review = diff ? await this.review(t, pane, diff, check) : { verdict: 'error', model: null, reasons: 'could not read the diff' };
      if (review.verdict === 'fail') failure = 'reviewer';
    }
    const v = this.verdict(t, pane, { check, gate, review, failure });
    if (failure) {
      await this.foremanFail(t, pane, failure, { verdict: v, gateSummary: verify?.summary ?? null, ...(reportNote ? { extra: reportNote } : {}) });
      return;
    }
    if (!diff && !chatTask) diff = await this.io.diff(dir, mainRoot).catch(() => null);
    this.fmSet(t, pane, { state: 'passed', result: {
      kind: 'pass', attempts: fm.attempt, worktree: t.worktree?.path ?? null, diffStat: diff ? diffSummary(diff) : null,
      checkTail: check ? tailOf(check.tail, 8, 600) || null : null, lastFailure: null,
    } });
    this.setPhase(t, pane, 'done');
    this.emitWorker(t, { kind: 'report', paneId: pane.id, taskId: t.record.taskId, ...(pane.swarm?.verify ? { verify: pane.swarm.verify } : {}) });
    void this.raceWon(t, 'check passed');
  }

  private verdict(t: TaskState, pane: PaneLike, v: Pick<SwarmForemanVerdict, 'check' | 'gate' | 'review' | 'failure'>): SwarmForemanVerdict {
    const now = Date.now();
    const row: SwarmForemanVerdict = { attempt: t.fm!.attempt, paneId: pane.id, model: pane.swarm?.model ?? '?', ...v, durationMs: now - (t.fmStartedAt ?? now), at: now };
    this.fmSet(t, pane, { verdicts: [...t.fm!.verdicts, row] });
    log(`swarm: foreman ${t.record.taskId} attempt ${row.attempt} on ${row.model}: ${row.failure ?? 'pass'}`);
    return row;
  }

  /** The reviewer gate: a free model (not the worker's) reads task + diff. Rate limits → the next model, once; never stalls. */
  private async review(t: TaskState, pane: PaneLike, diff: { patch: string; untracked: string[] }, check: SwarmForemanCheck | null): Promise<SwarmForemanReview> {
    // The task's own backend reviews: `koragent run` for Koragent workers (OpenCode need not be installed at all).
    const kg = this.backendOf(t).id === 'koragent';
    const opencode = kg ? (this.io.koragentPath?.() ?? null) : this.io.opencodePath();
    if (!opencode) return { verdict: 'error', model: null, reasons: kg ? 'koragent not installed' : 'opencode not installed' };
    const prompt = reviewPrompt(t.task, diff, check ? `\`${t.fm?.check}\` ${check.state}${check.exitCode != null ? ` (exit ${check.exitCode})` : ''}` : null);
    const { dir } = this.fmDirs(t, pane);
    const exclude = [pane.swarm?.model ?? ''];
    for (let i = 0; i < 2; i++) {
      const m = this.pickModel(exclude) ?? (i === 0 ? this.pickModel([]) : null);
      if (!m) break;
      exclude.push(m.id);
      const meta = { ...pane.swarm!, taskId: `${t.record.taskId}-review`, provider: m.provider, model: m.id, reportPath: path.join(dir, '.kora', 'swarm', `${t.record.taskId}-review.md`) };
      const env = kg
        ? koragentPaneEnv({ taskId: meta.taskId, reportMdPath: meta.reportPath, providers: [m.provider], apiKey: (p) => this.io.apiKey(p), route: [m.id] })
        : this.io.paneEnv(meta, { apiKey: this.io.apiKey(m.provider) });
      const r = await withTimeout(this.io.review({ opencode, model: m.id, cwd: dir, prompt, env, ...(kg ? { backend: 'koragent' as const } : {}) }), FOREMAN_BUDGET_MS + 5_000, { output: 'the reviewer did not answer in time', failed: true });
      const parsed = parseReview(r.output);
      if (parsed.verdict !== 'error') return { ...parsed, model: m.id };
      if (RATE_LIMIT_RE.test(r.output)) { try { this.deps.health.markCooling(m.id, cooldownUntil(m.id, 'rate-limited', Date.now()), 'rate-limited'); } catch { /* advisory */ } continue; }
      return { ...parsed, model: m.id };
    }
    return { verdict: 'error', model: null, reasons: 'no free model could review (rate-limited or none available)' };
  }

  /** Idle again after the nudge and still no report: give it one more nudgeMs, then it is a failed attempt. */
  private foremanNoReport(t: TaskState, pane: PaneLike): void {
    if (t.fmNoReportPane === pane.id) return;
    t.fmNoReportPane = pane.id;
    const timer = setTimeout(() => {
      t.fmNoReportPane = null;
      const fm = t.fm;
      if (!fm || fm.state === 'checking' || fm.state === 'passed' || fm.state === 'escalated') return;
      if (pane.exited || !pane.swarm || pane.swarm.supersededBy || t.failing || pane.state !== 'idle') return;
      if (this.reportStat(t.record.reportPath)) return;
      this.foremanFail(t, pane, 'no-report', { extra: this.workerTail(t, pane) }).catch((e) => log('swarm: foreman retry failed', e));
    }, this.io.nudgeMs);
    timer.unref?.();
    t.timers.push(timer);
  }

  /** A failed attempt: retry (same pane, or a new free model in the same worktree) while attempts remain, else escalate. */
  private async foremanFail(t: TaskState, pane: PaneLike, failure: NonNullable<SwarmForemanVerdict['failure']>, o: { verdict?: SwarmForemanVerdict; gateSummary?: string | null; extra?: string }): Promise<void> {
    const fm = t.fm;
    if (!fm || fm.state === 'passed' || fm.state === 'escalated') return;
    const v = o.verdict ?? this.verdict(t, pane, { check: null, gate: gateOf(pane.swarm?.verify ?? null), review: null, failure });
    const excerpt = failureExcerpt(v, o.gateSummary ?? null, o.extra ?? '');
    if (t.fm!.attempt >= t.fm!.maxAttempts) return this.escalate(t, pane, excerpt);
    const sameModel = t.fm!.verdicts.filter((x) => x.failure && x.model === v.model).length;
    const dead = pane.exited || this.rt.panes.get(pane.id) !== pane;
    const tried = [...new Set([...(pane.swarm?.attempts ?? []).map((a) => a.model), ...t.fm!.verdicts.map((x) => x.model)])];
    const paidOnly = modelTier(pane.swarm?.attempts?.[0]?.model ?? v.model ?? '') === 'paid'; // a paid task stays paid
    const next = dead || looksModelRelated(failure, sameModel) ? this.pickModel(tried, { ...(t.type ? { type: t.type } : {}), ...(paidOnly ? { paidOnly } : {}) }) : null;
    if (dead && !next) return this.escalate(t, pane, `${excerpt}\n(no other free model is available for a retry)`);
    const attempt = t.fm!.attempt + 1;
    // The old report must not satisfy the retry: a worker that goes idle without a fresh one is a no-report.
    try { const r = t.record.reportPath; if (fs.existsSync(r)) fs.renameSync(r, r.replace(/\.md$/, `.foreman${t.fm!.attempt}.md`)); } catch { /* keep going */ }
    if (this.backendOf(t).eventDriven) this.retireKoragentReport(t, `.foreman${t.fm!.attempt}`);
    t.handledReportAt = 0; t.nudged = false; t.fmNoReportPane = null; t.fmStartedAt = Date.now();
    const digest = retryDigest(v, excerpt, { check: t.fm!.check, reportPath: t.record.reportPath, attempt, maxAttempts: t.fm!.maxAttempts, newModel: !!next });
    this.fmSet(t, pane, { state: 'retrying', attempt });
    if (!next) {
      if (pane.swarm) pane.swarm = { ...pane.swarm, verify: null, report: null };
      this.setPhase(t, pane, 'running');
      this.say(pane, digest, true, 120_000).catch((e: any) => log(`swarm: foreman retry to ${pane.id} not delivered: ${e?.message ?? e}`));
      log(`swarm: foreman ${t.record.taskId} retry ${attempt} on the same worker ${pane.id} (${failure})`);
      return;
    }
    if (t.failing) await t.failing;
    t.failing = this.foremanRespawn(t, pane, next, digest, failure).finally(() => { t.failing = null; });
    return t.failing;
  }

  private async foremanRespawn(t: TaskState, old: PaneLike, next: SwarmModelInfo, digest: string, failure: string): Promise<void> {
    const meta = old.swarm!;
    const attempts = meta.attempts.map((x) => (x.paneId === old.id && x.outcome === 'running' ? { ...x, outcome: failure === 'crashed' ? 'crashed' as const : 'ok' as const } : x));
    old.swarm = { ...meta, attempts, phase: 'respawning' };
    t.record.status = 'respawning';
    this.touch(old);
    await this.killAndWait(old); // never two writers in one worktree
    let pane: PaneLike;
    try {
      pane = await this.launch(t, next, { attempt: meta.attempt + 1, attempts, previousPaneIds: [...meta.previousPaneIds, old.id], continuation: digest });
    } catch (e: any) {
      old.swarm = { ...old.swarm!, phase: 'failed' };
      await this.escalate(t, old, `could not start the retry on ${next.id}: ${e?.message ?? e}`);
      return;
    }
    old.swarm = { ...old.swarm!, supersededBy: pane.id };
    this.aliases.set(old.id, pane.id);
    t.note = `[kora] foreman: swarm worker ${old.id} (${meta.model}) was not accepted (${failure}); retrying as ${pane.id} on ${next.id}, same task, same worktree. kora_wait ${old.id} follows it.`;
    this.persist();
    this.emitWorker(t, { kind: 'failover', paneId: old.id, taskId: t.record.taskId, newPaneId: pane.id, fromModel: meta.model, toModel: next.id });
    log(`swarm: foreman ${t.record.taskId} retry ${t.fm?.attempt} → ${pane.id} on ${next.id} (${failure})`);
  }

  /** Out of attempts: a SHORT structured escalation for the leader (see formatForeman). */
  private async escalate(t: TaskState, pane: PaneLike, lastFailure: string): Promise<void> {
    if (!t.fm || t.fm.state === 'escalated' || t.fm.state === 'passed') return;
    const { dir, mainRoot } = this.fmDirs(t, pane);
    const diff = await this.io.diff(dir, mainRoot).catch(() => null);
    this.fmSet(t, pane, { state: 'escalated', result: {
      kind: 'escalation', attempts: t.fm.attempt, worktree: t.worktree?.path ?? null, diffStat: diff ? diffSummary(diff) : null, checkTail: null, lastFailure,
    } });
    this.setPhase(t, pane, 'failed');
    t.note = `[kora] foreman: swarm task ${t.record.taskId} was not accepted after ${t.fm!.attempt} attempt${t.fm!.attempt === 1 ? '' : 's'}; kora_wait ${pane.id} has the escalation.`;
    this.persist();
    this.emitWorker(t, { kind: 'report', paneId: pane.id, taskId: t.record.taskId, ...(pane.swarm?.verify ? { verify: pane.swarm.verify } : {}) });
  }

  private emitWorker(t: TaskState, event: SwarmWorkerEvent): void {
    try { this.rt.notify('swarm.worker', { orchestratorId: t.record.orchestratorId, event }); } catch { /* fake runtime */ }
  }

  // At most VERIFY_CONCURRENCY merge-gate children at once: twenty workers finishing together each launched the graph
  // engine and none answered (e2e). Queue time counts toward VERIFY_BUDGET_MS.
  private gatesRunning = 0;
  private readonly gateQueue: (() => void)[] = [];
  private async gated<T>(fn: () => Promise<T>): Promise<T> {
    if (this.gatesRunning >= VERIFY_CONCURRENCY) await new Promise<void>((r) => this.gateQueue.push(r));
    this.gatesRunning++;
    try { return await fn(); } finally { this.gatesRunning--; this.gateQueue.shift()?.(); }
  }

  // ── Koragent: the event-driven WorkerBackend ────────────────────────────────────────────────────────────
  /** The ordered route for a Koragent attempt: `first`, then the next-best models (Thompson-sampled), ≤ MAX_ATTEMPTS. */
  private routeFor(t: TaskState, first: SwarmModelInfo, tried: string[]): SwarmModelInfo[] {
    const out = [first];
    const exclude = [...new Set([...tried, first.id])];
    // A task on a PAID model fails over to paid models only: a free model is rate-limited and weaker, and a paying
    // user's worker must not silently degrade (bench5x: a stalled paid worker fell through six :free models and the
    // lead spent an hour babysitting them).
    const paidOnly = modelTier(first.id) === 'paid';
    while (out.length < MAX_ATTEMPTS) {
      const m = this.pickModel(exclude, { ...(t.type ? { type: t.type } : {}), ...(paidOnly ? { paidOnly } : {}) });
      if (!m) break;
      out.push(m); exclude.push(m.id);
    }
    return out;
  }

  /** Connect to the pane's event stream (Koragent listens; retry until it is up) and route steers to it. */
  private attachKoragent(t: TaskState, pane: PaneLike): void {
    const sock = pane.eventSocketPath;
    if (!sock || !this.io.koragentClient) { log(`swarm: ${pane.id} is a Koragent worker without an event stream`); return; }
    let client: KoragentEventClient;
    try { client = this.io.koragentClient(sock); } catch (e: any) { log(`swarm: ${pane.id} event stream: ${e?.message ?? e}`); return; }
    const acks = new Map<string, () => void>();
    let steerSeq = 0;
    client.on('event', (e: KoragentEvent) => {
      if (e.type === 'steer.received' && acks.has(e.id)) { acks.get(e.id)!(); acks.delete(e.id); }
      this.onKoragentEvent(t, pane, e);
    });
    client.on('connect', () => {
      log(`swarm: ${pane.id} event stream connected${client.connects > 1 ? ` (reconnect ${client.connects - 1}, since seq ${client.lastSeq})` : ''}`);
      this.sendCatalog(client);
    });
    pane.steerSink = async (text, source, delivery) => {
      const id = `${pane.id}-${++steerSeq}`;
      const acked = new Promise<void>((resolve) => acks.set(id, resolve));
      client.send({ type: 'steer', text, source, delivery, id });
      // The message is queued while the stream is down and delivered on reconnect: an unacknowledged steer is logged,
      // never re-sent (a duplicate steer is worse than a late one).
      const ok = await withTimeout(acked.then(() => true), 5_000, false);
      acks.delete(id);
      if (!ok) log(`swarm: ${pane.id} steer ${id} (${source}) not acknowledged within 5 s${client.connected ? '' : ' — event stream down, queued'}`);
    };
    pane.once('exit', () => {
      pane.steerSink = null;
      // Let a report sent just before the exit arrive, then stop reconnecting.
      const tm = setTimeout(() => client.close(), 1_000); tm.unref?.();
      try { fs.rmSync(sock, { force: true }); } catch { /* Koragent's to clean */ }
    });
    (pane as any).koragent = client;
    client.start();
  }

  /** `catalog.update`: the fleet-wide cooldowns and measured pass rates, so Koragent's own failover skips cooling models. */
  private sendCatalog(client: KoragentEventClient): void {
    try {
      const cooldowns = this.deps.health.cooling().map((c) => ({ model: c.model, until: c.until, reason: c.reason }));
      const passRates: Record<string, number> = {};
      try { for (const [model, s] of this.io.routingStats?.().models ?? new Map()) if (s.all.ran > 0) passRates[model] = Math.round((s.all.passed / s.all.ran) * 1000) / 1000; } catch { /* no data */ }
      client.send({ type: 'catalog.update', cooldowns, passRates });
    } catch (e) { log('swarm: catalog.update not sent', e); }
  }

  /** One Koragent event → pane state, worker phase, report, failover, spend. Never throws. */
  private onKoragentEvent(t: TaskState, pane: PaneLike, e: KoragentEvent): void {
    try {
      // Only the task's CURRENT pane speaks for it (a superseded pane's late events are history).
      if (!pane.swarm || pane.swarm.supersededBy || this.rt.panes.get(pane.id) !== pane) return;
      const kg = (t.kg ??= { lastAt: Date.now(), usd: 0, steps: 0, report: null, reportTs: 0 });
      kg.lastAt = Date.now();
      try { this.rt.pushWorkerFeed(pane.id, koragentFeedItems(e)); } catch (err) { log(`swarm: ${pane.id} feed`, err); }
      const line = recentEventLine(e as any);
      if (line) { kg.recent = [...(kg.recent ?? []), line].slice(-RECENT_EVENTS); }
      switch (e.type) {
        case 'hello':
          log(`swarm: ${pane.id} koragent ${e.version} pid ${e.pid} (replay from ${e.replayFrom})`);
          return;
        case 'session.state': {
          // `ready` before the task has started is the TUI coming up with the spec pre-seeded, not a finished
          // worker: reading it as idle answered kora_wait "idle, no report" before any work (the OpenCode start-up
          // blank, again). The phase moves before the pane state, so a wait woken by the state sees the new phase.
          const st = e.state === 'ready' && pane.swarm.phase === 'starting' ? null : paneStateFor(e.state);
          if (e.state === 'working') {
            if (t.wd) t.wd.idleSince = null;
            if (pane.swarm.phase === 'starting' || pane.swarm.phase === 'rate-limited') this.setPhase(t, pane, 'running');
          }
          if (st) pane.hint(st, st === 'blocked' ? (e.blockedOn || e.reason || 'blocked') : null);
          if (e.state === 'retrying') {
            if (e.reason && RATE_LIMIT_RE.test(e.reason)) this.setPhase(t, pane, 'rate-limited');
          } else if (e.state === 'done' || e.state === 'failed') {
            if (t.wd && t.wd.idleSince == null) t.wd.idleSince = Date.now();
            this.onKoragentSettled(t, pane);
          }
          return;
        }
        case 'permission.request':
          pane.hint('blocked', `permission: ${e.tool}${e.summary ? ` — ${e.summary}` : ''}`);
          return;
        case 'budget.update':
          kg.usd = Number(e.usd) || 0; kg.steps = Number(e.steps) || 0;
          return;
        case 'route.failover':
          this.onRouteFailover(t, pane, e);
          return;
        case 'model.switch':
          if (e.to && e.to !== pane.swarm.model) { pane.swarm = { ...pane.swarm, model: e.to, provider: providerOf(e.to), modelLabel: modelLabel(e.to) }; this.touch(pane); }
          return;
        case 'task.report': {
          const r = asTaskReport(e.report);
          if (!r) { log(`swarm: ${pane.id} sent a task.report that is not a TaskReport`); return; }
          kg.report = r; kg.reportTs = Number(e.ts) || Date.now();
          ensureReportFiles(t.record.reportPath, r, { freshAfter: kg.reportTs - 2_000 });
          return;
        }
        case 'error':
          log(`swarm: ${pane.id} koragent error${e.fatal ? ' (fatal)' : ''}: ${String(e.message ?? '').slice(0, 300)}`);
          return;
        case 'tool.start':
          this.setStep(pane, stepFromKoragentToolStart(e, Number(e.ts) || Date.now()));
          return;
        default:
          return; // ui.ready, turn.*, tool.end, steer.*, task.check: progress only (kg.lastAt)
      }
    } catch (err) { log(`swarm: ${pane.id} koragent event ${(e as any)?.type} failed`, err); }
  }

  /**
   * The session reached done/failed. The report (event, else the JSON Koragent wrote — the file fallback) goes into
   * the same verify path as an OpenCode report; none at all is a failed attempt (the harness always writes one, so a
   * missing report means it crashed) — never a nudge.
   */
  private onKoragentSettled(t: TaskState, pane: PaneLike): void {
    if (!pane.swarm || pane.swarm.supersededBy || t.failing) return;
    if (ensureReportFiles(t.record.reportPath, t.kg?.report ?? null)) { this.onIdle(t, pane); return; }
    if (this.fmActive(t)) { if (t.fm!.state !== 'checking') this.foremanFail(t, pane, 'no-report', { extra: this.workerTail(t, pane) }).catch((x) => log('swarm: foreman retry failed', x)); return; }
    t.note = `[kora] swarm worker ${pane.id} (koragent) ended without a report.`;
    this.setPhase(t, pane, 'failed');
  }

  /** Koragent moved to the next model of its route in the SAME session: cool the old model, record it; no respawn. */
  private onRouteFailover(t: TaskState, pane: PaneLike, e: Extract<KoragentEvent, { type: 'route.failover' }>): void {
    const meta = pane.swarm!;
    const now = Date.now();
    const from = e.from || meta.model;
    const to = String(e.to || '');
    if (!to) return;
    const reason: SwarmFailReason = failoverOutcome(e.reason);
    // retryAfter: epoch ms (a value that small is a duration in seconds).
    const ra = Number(e.retryAfter);
    const next = Number.isFinite(ra) && ra > 0 ? (ra > 1e12 ? ra : now + ra * 1000) : null;
    try { this.deps.health.markCooling(from, cooldownUntil(from, reason, now, next), reason, { gone: reason === 'model-gone' }); } catch { /* advisory */ }
    const attempts = meta.attempts.map((x) => (x.paneId === pane.id && x.outcome === 'running' ? { ...x, outcome: reason } : x));
    attempts.push({ paneId: pane.id, provider: providerOf(to), model: to, outcome: 'running', at: now });
    pane.swarm = { ...meta, model: to, provider: providerOf(to), modelLabel: modelLabel(to), attempt: meta.attempt + 1, attempts, phase: meta.phase === 'rate-limited' || meta.phase === 'starting' ? 'running' : meta.phase };
    t.record.status = pane.swarm.phase;
    t.note = `[kora] swarm worker ${pane.id} (koragent) moved from ${from} to ${to} (${e.reason || reason}) in the same session; same pane, same worktree.`;
    // A new model gets its own watchdog window (T1 nudge, T2 escalation), as a respawned attempt would.
    if (t.wd) { t.wd.attemptAt = now; t.wd.nudgedAt = null; t.wd.kgEscalatedAt = null; }
    log(`swarm: ${pane.id} route failover ${from} → ${to} (${e.reason || reason})`);
    this.persist();
    this.touch(pane);
    this.emitWorker(t, { kind: 'failover', paneId: pane.id, taskId: t.record.taskId, newPaneId: pane.id, fromModel: from, toModel: to });
  }

  /** A retry must not be satisfied by the previous round's report: its JSON goes aside with the .md, and is forgotten. */
  private retireKoragentReport(t: TaskState, suffix: string): void {
    const json = reportJsonPath(t.record.reportPath);
    try { if (fs.existsSync(json)) fs.renameSync(json, json.replace(/\.json$/, `${suffix}.json`)); } catch { /* keep going */ }
    if (t.kg) { t.kg.report = null; t.kg.reportTs = 0; }
  }

  /** A Kora-originated message for a worker (nudge, bounce, foreman retry): a `steer` for Koragent, keystrokes otherwise. */
  private say(pane: PaneLike, text: string, waitIdle: boolean, timeoutMs: number): Promise<unknown> {
    return (this.rt as unknown as { prompt: (...a: unknown[]) => Promise<unknown> }).prompt(pane.id, text, true, waitIdle, timeoutMs, 'kora');
  }

  // ── watchdog: slow / silent workers, paid spend (swarm-watchdog.ts) ─────────────────────────────────────
  private wdTimer: NodeJS.Timeout | null = null;

  private startWatchdog(): void {
    const ms = this.io.watchdogTickMs ?? 0;
    if (this.wdTimer || ms <= 0) return;
    this.wdTimer = setInterval(() => { try { this.tickWatchdog(); } catch (e) { log('swarm: watchdog tick failed', e); } }, ms);
    this.wdTimer.unref?.();
  }

  /** One pass over the live tasks. Public for tests (and a manual poke); cheap: one DB query for every worker. */
  tickWatchdog(now = Date.now()): void {
    const live: { t: TaskState; pane: PaneLike }[] = [];
    for (const t of this.registry().values()) {
      if (t.restored || t.failing || !t.wd) continue;
      const pane = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
      if (!pane || pane.exited || !pane.swarm || pane.swarm.supersededBy) { this.settleIfGone(t); continue; }
      if (!['starting', 'running', 'rate-limited'].includes(pane.swarm.phase) || pane.promptPending) continue;
      live.push({ t, pane });
    }
    if (!live.length) {
      // Stop only when no task can still become live: a task skipped this tick (its prompt hold still on, a restore in
      // progress) would otherwise lose its watchdog for good (found live 2026-10-19: a stalled worker, no nudge in 20 min).
      const pending = [...this.registry().values()].some((t) => !!t.wd && !t.failing && ['starting', 'running', 'rate-limited'].includes(t.record.status));
      if (!pending && this.wdTimer) { clearInterval(this.wdTimer); this.wdTimer = null; }
      return;
    }
    const cfg = (() => { try { return this.io.config(); } catch { return null; } })();
    const settings = cfg?.watchdog ?? WATCHDOG_DEFAULTS;
    // Since the TASK's first attempt: the spend cap is per task (every attempt in the worktree counts); older
    // sessions' activity predates this attempt, so it never masks a silent current worker.
    // Koragent workers report progress and spend on their event stream (budget.update, tool/turn events); only
    // OpenCode workers need its session DB read.
    const evented = (t: TaskState) => this.backendOf(t).eventDriven;
    const dirs = live.filter((x) => x.t.worktree && !evented(x.t)).map((x) => ({ dir: x.t.worktree!.path, sinceMs: Math.min(x.t.wd!.attemptAt, ...x.pane.swarm!.attempts.map((a) => a.at)) }));
    let act = new Map<string, WorkerActivity>();
    try { if (dirs.length) act = this.io.activity?.(dirs) ?? act; } catch { /* pane output is the fallback */ }
    for (const { t, pane } of live) {
      const wd = t.wd!;
      const a: WorkerActivity | undefined = evented(t) ? (t.kg ? { lastAt: t.kg.lastAt, costUsd: t.kg.usd } : undefined) : t.worktree ? act.get(t.worktree.path) : undefined;
      const paid = modelTier(pane.swarm!.model) === 'paid';
      const lastOut = typeof (pane as any).lastOutputAt === 'number' ? (pane as any).lastOutputAt : wd.attemptAt;
      // A human `fleet.extend` pushes the effective attempt start later, so both T1 (nudge) and T2 (reassign) wait longer.
      const attemptStartedAt = wd.attemptAt + (wd.extendMs ?? 0);
      const decision = watchdogDecision({
        now, attemptStartedAt, lastProgressAt: Math.max(attemptStartedAt, a?.lastAt ?? lastOut),
        hasReport: this.reportStat(t.record.reportPath) != null,
        inVerify: pane.swarm!.verify != null && pane.swarm!.verify.state !== 'skipped',
        idleSince: wd.idleSince, idleNudged: t.nudged, wdNudged: wd.nudgedAt != null,
        ...(paid ? { spentUsd: a?.costUsd ?? 0, capUsd: cfg?.paidMaxTaskUsd ?? 0.05, budgetStopAt: wd.budgetStopAt } : {}),
        settings,
      });
      this.applyWatchdog(t, pane, decision, a?.costUsd ?? 0, cfg?.paidMaxTaskUsd ?? 0.05, now);
    }
  }

  private applyWatchdog(t: TaskState, pane: PaneLike, d: ReturnType<typeof watchdogDecision>, spent: number, cap: number, now: number): void {
    const wd = t.wd!;
    const say = (text: string, what: string) => this.say(pane, text, false, 10_000)
      .catch((e: any) => log(`swarm: ${pane.id} ${what} not delivered: ${e?.message ?? e}`));
    switch (d.kind) {
      case 'none': return;
      case 'nudge':
        wd.nudgedAt = now; wd.nudges++;
        log(`swarm: watchdog — ${pane.id} (${pane.swarm!.model}) has no report after ${Math.round(d.elapsedMs / 60_000)} min; nudging`);
        // Typed while it works: OpenCode queues a message sent mid-turn and reads it at its next step.
        void say(watchdogNudgeText(t.record.reportPath, d.elapsedMs), 'watchdog nudge');
        return;
      case 'reassign':
        // The foreman owns a missing report (it retries after its own nudge) and has the last word once it has
        // passed or escalated a task; the watchdog only moves slow workers off a live foreman attempt.
        if (t.fm && (!this.fmActive(t) || d.why === 'no-report')) return;
        // Koragent: steer in-session and escalate along its route first; kill + respawn only as the last resort.
        if (this.backendOf(t).eventDriven) {
          const step = koragentStallStep({ now, escalatedAt: wd.kgEscalatedAt ?? null });
          if (step === 'wait') return;
          if (step === 'escalate') {
            wd.kgEscalatedAt = now; wd.nudges++;
            const model = pane.swarm!.model;
            log(`swarm: watchdog — ${pane.id} (koragent, ${model}) ${d.why === 'slow' ? 'is too slow' : 'has no report'}; steering it to wrap up and escalating along its route`);
            void say(koragentStallText(t.record.reportPath, now - wd.attemptAt, model), 'watchdog stall steer');
            const client = (pane as any).koragent as KoragentEventClient | undefined;
            try { client?.send({ type: 'model.reject', model, reason: 'stalled: no progress toward a report (Kora watchdog)' }); } catch (e) { log(`swarm: ${pane.id} model.reject not sent`, e); }
            t.note = `[kora] swarm worker ${pane.id} (koragent) stalled on ${model}; Kora steered it to report and asked its route to move on (same pane).`;
            return;
          }
          log(`swarm: watchdog — ${pane.id} (koragent) still stalled ${Math.round(KORAGENT_ESCALATE_GRACE_MS / 60_000)} min after the steer + route escalation; respawning as a last resort`);
          this.failover(t.record.taskId, 'stalled').catch((e) => log('swarm: watchdog reassign failed', e));
          return;
        }
        log(`swarm: watchdog — ${pane.id} (${pane.swarm!.model}) ${d.why === 'slow' ? 'is too slow' : 'went idle without its report'}; reassigning to a faster model in the same worktree`);
        this.failover(t.record.taskId, 'stalled').catch((e) => log('swarm: watchdog reassign failed', e));
        return;
      case 'budget-stop':
        wd.budgetStopAt = now;
        t.note = `[kora] swarm task ${t.record.taskId} reached its paid spend cap ($${spent.toFixed(3)} of $${cap.toFixed(2)}) on ${pane.swarm!.model}; the worker was told to report and stop.`;
        log(`swarm: ${pane.id} spent $${spent.toFixed(4)} ≥ cap $${cap} on ${pane.swarm!.model}; asking it to report and stop`);
        void say(budgetStopText(t.record.reportPath, spent, cap), 'budget stop');
        return;
      case 'budget-kill':
        log(`swarm: ${pane.id} over its spend cap — stopping it`);
        wd.budgetStopAt = -1; // killed once; exit decides done/failed by the report
        void this.killAndWait(pane);
        return;
    }
  }

  // ── daemon restart (D17 / D18) ──────────────────────────────────────────────────────────────────────────
  /**
   * After a daemon restart: every task that was mid-flight when the previous daemon stopped. A worker never survives
   * its daemon (a clean stop disposes every pane; after a crash the start-up reap kills the orphans), so there is no
   * process to re-attach to and no event stream to replay: an unfinished task is RELAUNCHED in its own worktree, on its
   * old pane id when free, with a digest continuation (not from scratch). A task that reported before the stop is
   * done. Tasks that had finished stay finished — the state file no longer re-spawns swarm panes from their argv.
   * `restoredPaneIds`: the panes Runtime.restore brought back — a pane orchestrator must be one of them (pane ids
   * restart per daemon, so an unrestored id may already name something else).
   */
  async resumeAfterRestart(opts: { restoredPaneIds?: ReadonlySet<string> } = {}): Promise<{ resumed: string[]; finished: string[]; dropped: string[] }> {
    const out = { resumed: [] as string[], finished: [] as string[], dropped: [] as string[] };
    const addDigest = (orch: string, line: string) => { const l = this.restartDigests.get(orch) ?? []; l.push(line); this.restartDigests.set(orch, l); };
    for (const t of [...this.registry().values()]) {
      if (!t.restored || !t.resume) continue;
      const ri = t.resume;
      t.resume = null;
      const id = t.record.taskId;
      const oldId = t.record.paneIds[t.record.paneIds.length - 1] ?? '';
      const drop = (why: string) => {
        t.record.status = 'failed'; t.lost = true;
        t.note = `[kora] swarm task ${id} was stopped by a daemon restart and not resumed: ${why}.`;
        out.dropped.push(id);
        addDigest(t.record.orchestratorId, `- ${id}${t.title ? ` "${t.title}"` : ''}: NOT resumed (${why}); spawn it again if it is still needed`);
        log(`swarm: restart — task ${id} not resumed (${why})`);
      };
      // Reported before the stop (or Koragent's JSON landed without the .md): finished stays finished.
      const reported = ri.backend === 'koragent' ? ensureReportFiles(t.record.reportPath, null) : this.reportStat(t.record.reportPath) != null;
      if (reported) { t.record.status = 'done'; this.logRestoredOutcome(t, ri); out.finished.push(id); addDigest(t.record.orchestratorId, `- ${id}${ri.title ? ` "${ri.title}"` : ''}: had already reported — kept done; read it with kora_wait and merge it`); log(`swarm: restart — task ${id} had reported; kept done`); continue; }
      const orch = t.record.orchestratorId;
      const orchOk = orch.startsWith('chat:') ? (() => { try { return this.io.threadMode(orch) === 'swarm'; } catch { return false; } })()
        : !!opts.restoredPaneIds?.has(orch) && this.isPaneOrchestrator(orch);
      if (!orchOk) { drop(`its orchestrator ${orch} is gone`); continue; }
      if (ri.worktree && !fs.existsSync(ri.worktree.path)) { drop(`its worktree ${ri.worktree.path} is gone`); continue; }
      let model: SwarmModelInfo | null = null;
      try { model = this.deps.setup.pickableModels().find((m) => m.id === ri.model && this.deps.health.isAvailable(m.id)) ?? null; } catch { /* pick below */ }
      model ??= this.pickModel([], ri.type ? { type: ri.type } : { task: ri.task });
      if (!model) { drop('no free model is available'); continue; }
      const cfg = (() => { try { return this.io.config(); } catch { return null; } })();
      const unattended = ri.runtimeMode === 'full-access' || ri.runtimeMode === 'auto';
      const check = ri.check && unattended ? ri.check : null;
      const retries = Math.max(0, Math.min(5, Number(cfg?.foremanRetries ?? 0) || 0));
      const review = cfg?.foremanReview === true;
      Object.assign(t, {
        restored: false, lost: false, resumeLoaded: null, cwd: ri.cwd, task: ri.task, title: ri.title, runtimeMode: ri.runtimeMode, worktree: ri.worktree,
        backend: ri.backend, type: ri.type ?? classifySwarmTask(ri.task), nudged: false, handledReportAt: 0, timers: [], failing: null, fmStartedAt: Date.now(), fmNoReportPane: null,
        fm: retries > 0 || check || review ? { state: 'working', attempt: 1, maxAttempts: 1 + retries, check, review, verdicts: [], result: null } : null,
      } satisfies Partial<TaskState>);
      const digest = ri.backend === 'koragent' ? koragentDigest({ report: null, recent: ri.recent ?? [] }) : '';
      const continuation = [
        `NOTE: Kora's daemon restarted while this task was running, and the previous worker${ri.model ? ` (${ri.model})` : ''} was stopped mid-task. Its work so far is in this worktree: run \`git status\` and \`git diff\` first, keep what is right, and finish the task — do not start over.`,
        digest,
      ].filter(Boolean).join('\n\n');
      try {
        const pane = await this.launch(t, model, { attempt: (ri.attempt || 1) + 1, attempts: [], previousPaneIds: t.record.paneIds.filter((x) => x !== oldId), continuation, keepPaneId: oldId });
        if (oldId && pane.id !== oldId) this.aliases.set(oldId, pane.id);
        t.note = `[kora] the daemon restarted; swarm task ${id} was resumed${pane.id !== oldId ? ` as ${pane.id} (was ${oldId})` : ` in ${pane.id}`} on ${model.id}, same worktree, with a digest of the work so far.`;
        out.resumed.push(id);
        addDigest(t.record.orchestratorId, `- ${id}${ri.title ? ` "${ri.title}"` : ''}: still running — resumed as ${pane.id} in its worktree; kora_wait for its report`);
        log(`swarm: restart — task ${id} resumed in ${pane.id} on ${model.id}`);
      } catch (e: any) {
        t.restored = true;
        drop(`could not relaunch: ${e?.message ?? e}`);
      }
    }
    this.persist();
    return out;
  }

  // ── X2: verify-and-bounce ─────────────────────────────────────────────────────────────────────────────
  /** X2: run mergeVerify (child process) on the worker's worktree; bounce findings to the same worker ≤ maxBounces. */
  async verifyAndBounce(paneId: string): Promise<FleetSwarmVerify> {
    const pane = this.rt.panes.get(this.follow(paneId));
    const t = pane ? this.taskOf(pane.id) : null;
    if (!pane || !pane.swarm || !t) return { state: 'skipped', bounces: 0, summary: 'not a live swarm worker' };
    const prev = pane.swarm.verify;
    const bounces = prev?.bounces ?? 0;
    const set = (v: FleetSwarmVerify): FleetSwarmVerify => { if (pane.swarm) { pane.swarm = { ...pane.swarm, verify: v }; this.touch(pane); } return v; };
    if (!pane.worktree) return set({ state: 'skipped', bounces, summary: 'no worktree to verify' });
    set({ state: 'pending', bounces, summary: null });
    const siblings = this.liveSwarmPanes().filter((x) => x.id !== pane.id && x.orchestratorId === pane.orchestratorId && x.worktree).map((x) => ({ paneId: x.id, worktree: x.worktree!.path }));
    let pairs: MergePair[];
    // Bounded: under a 10-leader load the gate never answered for one worker (e2e), and a verify stuck in 'pending'
    // held the task's report (and every kora_wait on it) for 5+ minutes. A slow gate is a skipped check, not a hang.
    try {
      const r = await withTimeout(this.gated(() => this.io.verifyGate({ paneId: pane.id, worktree: pane.worktree!.path, mainRoot: pane.worktree!.mainRoot, siblings })).then((x) => ({ x })), VERIFY_BUDGET_MS, null);
      if (!r) return set({ state: 'skipped', bounces, summary: `merge gate did not answer within ${Math.round(VERIFY_BUDGET_MS / 1000)} s — not verified; review the diff` });
      pairs = r.x;
    }
    catch (e: any) { return set({ state: 'skipped', bounces, summary: `merge gate did not run: ${String(e?.message ?? e).slice(0, 200)}` }); }
    // File-level attributions (line ≤ 1) are the engine saying "something in this file" — never evidence of a broken
    // caller. With a done-check on the task, a name-level overlap is advisory too: the (baseline-aware) check runs in
    // this worktree and the lead re-runs it after merging, while the gate matches symbols by NAME across files — a
    // local `current` in one module "collided" with `current` in another, and correct fixes were bounced until their
    // task ran out of models (bench5x Z4). Only a REMOVED symbol that others still reference still bounces there.
    const real = (b: import('../protocol/types').MergeBlame) => !b.compatible && (b.line ?? 0) > 1;
    const hasCheck = !!t.fm?.check;
    const scoped = pairs.filter((p) => (p.a === pane.id || p.b === pane.id) && p.status === 'semantic');
    const findings = scoped.filter((p) => (p.blame ?? []).some((b) => real(b) && (!hasCheck || b.removed)) || (!p.blame?.length && !hasCheck));
    const advisory = scoped.filter((p) => !findings.includes(p) && (p.blame ?? []).some(real));
    if (!findings.length) {
      if (advisory.length) {
        const names = [...new Set(advisory.flatMap((p) => (p.blame ?? []).filter(real).map((b) => `${b.file}:${b.line} ${b.symbol}`)))].slice(0, 6).join(', ');
        return set({ state: 'passed', bounces, summary: `merge gate: name-level overlaps only, advisory (the done-check decides): ${names}` });
      }
      const human = pairs.filter((p) => (p.a === pane.id || p.b === pane.id) && p.status === 'needs-human');
      const base = bounces ? `merge gate clean after ${bounces} bounce${bounces === 1 ? '' : 's'}` : 'merge gate clean';
      return set({ state: 'passed', bounces, summary: human.length ? `${base}; ${human.length} pair(s) need a human look: ${human.map((h) => h.reason ?? `${h.a} × ${h.b}`).join('; ').slice(0, 300)}` : base });
    }
    const lines = findings.flatMap((p) => {
      const other = p.a === pane.id ? p.b : p.a;
      const blame = (p.blame ?? []).filter((b) => !b.compatible).slice(0, 12).map((b) => `  - ${b.file}:${b.line} ${b.symbol} (${b.removed ? 'removed' : 'changed'} by ${b.byWorker === pane.id ? 'you' : b.byWorker}${b.kind === 'reference' ? ', new reference' : ''})`);
      return [`vs ${other === 'main' ? 'the target branch (already merged work)' : other}: ${p.reason ?? 'broken callers'}`, ...blame];
    });
    const summary = lines.join('\n').slice(0, 2000);
    const { maxBounces } = this.io.config();
    if (bounces >= maxBounces) return set({ state: 'failed', bounces, summary });
    const v = set({ state: 'bounced', bounces: bounces + 1, summary });
    this.setPhase(t, pane, 'running');
    this.emitWorker(t, { kind: 'bounced', paneId: pane.id, taskId: t.record.taskId, verify: v });
    const text = `The Kora merge gate found problems with your change (bounce ${bounces + 1} of ${maxBounces}):\n${summary}\nFix every broken caller listed (update the call sites or keep the old signature), re-run your checks, then update your report at ${t.record.reportPath}.`;
    this.say(pane, text, true, 120_000).catch((e: any) => log(`swarm: bounce to ${pane.id} not delivered: ${e?.message ?? e}`));
    return v;
  }

  // ── plugin events + failover (B9) ─────────────────────────────────────────────────────────────────────
  /** From the opencode plugin (socket `swarm.reportEvent`). */
  reportEvent(e: SwarmPaneEvent): void {
    try {
      const pane = this.rt.panes.get(e.paneId);
      const t = this.taskOf(e.paneId);
      if (!pane || !pane.swarm || !t || pane.swarm.supersededBy) return;
      if (this.backendOf(t).eventDriven) return; // the OpenCode plugin's channel; Koragent speaks on its event stream
      const msg = e.message ?? '';
      if (e.type === 'session.status' && e.status === 'busy') {
        this.releasePending(pane);
        if (t.wd) t.wd.idleSince = null;
        if (pane.swarm.phase === 'starting') this.setPhase(t, pane, 'running');
        return;
      }
      if (e.type === 'session.idle' || (e.type === 'session.status' && e.status === 'idle')) {
        if (!pane.promptPending) this.onIdle(t, pane);
        return;
      }
      if (e.type === 'session.status' && e.status === 'retry') {
        if (e.next) t.lastRetryNext = e.next;
        if (RATE_LIMIT_RE.test(msg)) {
          this.setPhase(t, pane, 'rate-limited');
          if ((e.attempt ?? 0) >= 2) this.failover(t.record.taskId, 'rate-limited').catch((x) => log('swarm: failover failed', x));
        } else if (UNREACHABLE_RE.test(msg) && (e.attempt ?? 0) >= 3) {
          this.failover(t.record.taskId, 'unreachable').catch((x) => log('swarm: failover failed', x));
        }
        return;
      }
      if (e.type === 'session.error') {
        const reason: SwarmFailReason | null = RATE_LIMIT_RE.test(msg) || PROVIDER_DOWN_RE.test(msg) ? 'rate-limited' : MODEL_GONE_RE.test(msg) ? 'model-gone' : AUTH_RE.test(msg) ? 'auth-failed' : null;
        if (reason) this.failover(t.record.taskId, reason).catch((x) => log('swarm: failover failed', x));
      }
    } catch (err) { log('swarm: reportEvent failed', err); }
  }

  async failover(taskId: string, reason: SwarmFailReason): Promise<void> {
    const t = this.registry().get(taskId);
    if (!t) return;
    if (t.failing) return t.failing;
    t.failing = this.doFailover(t, reason).finally(() => { t.failing = null; });
    return t.failing;
  }

  private async doFailover(t: TaskState, reason: SwarmFailReason): Promise<void> {
    const oldId = t.record.paneIds[t.record.paneIds.length - 1];
    const old = oldId ? this.rt.panes.get(oldId) : undefined;
    if (!old || !old.swarm || old.swarm.supersededBy) return;
    const meta = old.swarm;
    const now = Date.now();
    try { this.deps.health.markCooling(meta.model, cooldownUntil(meta.model, reason, now, t.lastRetryNext), reason, { gone: reason === 'model-gone' }); } catch { /* advisory */ }
    t.lastRetryNext = null;
    const attempts = meta.attempts.map((x) => (x.paneId === oldId ? { ...x, outcome: reason } : x));
    const tried = [...new Set(attempts.map((x) => x.model))];
    // A task that spent its paid cap is not moved to another paid model.
    const noPaid = t.wd?.budgetStopAt != null ? (() => { try { return this.deps.setup.pickableModels().filter((x) => modelTier(x.id) === 'paid').map((x) => x.id); } catch { return []; } })() : [];
    // …otherwise a task that started on a paid model stays on paid models.
    const paidOnly = !noPaid.length && modelTier(attempts[0]?.model ?? meta.model) === 'paid';
    // Chat tasks that stall twice are usually blocked by their sources (bot walls, paywalls), not the model: hand
    // them back to the leader with what is known instead of cycling free models for an hour.
    const chatStalls = isBlobsCwd(t.cwd) ? attempts.filter((x) => x.outcome === 'stalled').length : 0;
    const chatGiveUp = reason === 'stalled' && chatStalls >= 2;
    // Per-task budget (master cost plan 7): a worker that stalled or crashed burned tokens and time. The original plus two
    // failovers is the limit for those; a provider-side failure (rate limit, no connection, model gone) costs nothing
    // and keeps the full MAX_ATTEMPTS.
    const costlyFails = attempts.filter((x) => x.outcome === 'stalled' || x.outcome === 'crashed').length;
    const next = attempts.length >= MAX_ATTEMPTS || chatGiveUp || costlyFails >= MAX_COSTLY_ATTEMPTS ? null : this.pickModel([...tried, ...noPaid], { ...(t.type ? { type: t.type } : {}), ...(reason === 'stalled' ? { preferFast: true } : {}), ...(paidOnly ? { paidOnly } : {}) });
    if (!next) {
      old.swarm = { ...meta, attempts, phase: 'exhausted' };
      t.record.status = 'exhausted';
      this.logOutcome(t, old);
      t.note = chatGiveUp
        ? `[kora] swarm task ${t.record.taskId} stalled on ${chatStalls} workers (${tried.join(', ')}) — its sources may block automated access. Kora stopped it; any partial notes are in ${path.dirname(t.record.reportPath)}. Narrow the task, try other sources, or say what you could not verify.`
        : swarmExhaustedNote(t.record.taskId, tried, this.nextFreeAt(), attempts.map((x) => x.outcome));
      this.persist();
      this.touch(old);
      log(`swarm: task ${t.record.taskId} exhausted (${tried.join(', ')})`);
      this.emitWorker(t, { kind: 'exhausted', paneId: oldId, taskId: t.record.taskId, tried });
      this.dispatchQueued(t.record.orchestratorId);
      await this.killAndWait(old);
      return;
    }
    // Before the kill: a kora_wait parked on the old pane must see "respawning", never a bare EXITED (journey d).
    old.swarm = { ...meta, attempts, phase: 'respawning' };
    t.record.status = 'respawning';
    this.touch(old);
    await this.killAndWait(old); // never two writers in one worktree (risk 10)
    try {
      const stale = t.record.reportPath;
      if (fs.existsSync(stale)) fs.renameSync(stale, stale.replace(/\.md$/, `.attempt${meta.attempt}.md`));
    } catch { /* keep going */ }
    if (this.backendOf(t).eventDriven) this.retireKoragentReport(t, `.attempt${meta.attempt}`);
    const digest = this.backendOf(t).eventDriven ? koragentDigest(t.kg ?? null) : '';
    const continuation = `NOTE: a previous worker (${meta.model}) was cut off (${reason}); ${isBlobsCwd(t.cwd) ? `check ${path.dirname(t.record.reportPath)} for any partial notes` : 'run `git status`'} — partial work may already be here. Continue the task.${digest ? `\n\n${digest}` : ''}`;
    let pane: PaneLike;
    try {
      pane = await this.launch(t, next, { attempt: meta.attempt + 1, attempts, previousPaneIds: [...meta.previousPaneIds, oldId], continuation });
    } catch (e: any) {
      old.swarm = { ...old.swarm!, phase: 'failed' };
      t.record.status = 'failed';
      t.note = `[kora] swarm task ${t.record.taskId} could not be respawned after ${reason} on ${meta.model}: ${e?.message ?? e}`;
      this.persist();
      this.dispatchQueued(t.record.orchestratorId);
      return;
    }
    old.swarm = { ...old.swarm!, supersededBy: pane.id };
    this.aliases.set(oldId, pane.id);
    t.note = swarmFailoverNote(oldId, meta.model, reason, pane.id, next.id);
    this.persist();
    this.emitWorker(t, { kind: 'failover', paneId: oldId, taskId: t.record.taskId, newPaneId: pane.id, fromModel: meta.model, toModel: next.id });
  }

  private async killAndWait(p: PaneLike, ms = 5000): Promise<void> {
    if (p.exited) { try { this.rt.killPane(p.id); } catch { /* already reaped */ } return; }
    const exited = new Promise<void>((r) => p.once('exit', () => r()));
    try { this.rt.killPane(p.id); } catch { p.kill('SIGKILL'); }
    await withTimeout(exited, ms, undefined);
  }

  /** A thread left swarm or was deleted. kill = stop its swarm workers (worktrees are kept); queued tasks are dropped. */
  async cleanupThread(orchestratorId: string, opts: { kill?: boolean; reason?: 'stopped' | 'left-swarm' } = {}): Promise<void> {
    const tasks = [...this.registry().values()].filter((t) => t.record.orchestratorId === orchestratorId);
    const waits: Promise<void>[] = [];
    for (const t of tasks) {
      for (const x of t.timers) clearTimeout(x);
      t.timers = [];
      if (!opts.kill) continue;
      if (t.record.status === 'queued') { t.record.status = 'failed'; t.note = `[kora] swarm task ${t.record.taskId} was dropped: ${opts.reason === 'stopped' ? 'the user stopped the thread' : 'its orchestrator left swarm'} before a slot freed.`; continue; }
      const cur = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
      if (cur && !cur.exited) {
        if (cur.swarm && cur.swarm.phase !== 'done') { cur.swarm = { ...cur.swarm, phase: 'failed' }; t.record.status = 'failed'; }
        waits.push(this.killAndWait(cur, 3000));
      }
    }
    if (opts.kill) this.queues.delete(orchestratorId);
    await Promise.all(waits);
    this.persist();
  }

  // ── thought bubble: a worker's latest step (swarm-step.ts) ──────────────────────────────────────────────────
  private stepTimer: NodeJS.Timeout | null = null;

  private startStepTicker(): void {
    if (this.stepTimer) return;
    this.stepTimer = setInterval(() => { try { this.tickSteps(); } catch (e) { log('swarm: step tick failed', e); } }, STEP_TICK_MS);
    this.stepTimer.unref?.();
  }

  /** One pass over the live OpenCode workers. Public for tests; Koragent's step is set inline from `tool.start`. */
  tickSteps(now = Date.now()): void {
    const live: { t: TaskState; pane: PaneLike }[] = [];
    for (const t of this.registry().values()) {
      if (t.restored || t.failing) continue;
      const pane = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
      if (!pane || pane.exited || !pane.swarm || pane.swarm.supersededBy) continue;
      if (!LIVE_SWARM_PHASES.has(pane.swarm.phase) || this.backendOf(t).eventDriven) continue;
      live.push({ t, pane });
    }
    if (!live.length) { if (this.stepTimer) { clearInterval(this.stepTimer); this.stepTimer = null; } return; }
    // Code workers: one worktree each. Chat workers share their project folder, so each is matched by the
    // `scratch/<taskId>/` report path its own prompt names.
    const keyOf = (t: TaskState) => t.worktree ? t.worktree.path : `task:${t.record.taskId}`;
    const dirs = live.filter((x) => x.t.worktree || isBlobsCwd(x.t.cwd)).map((x) => ({
      dir: x.t.worktree ? x.t.worktree.path : realPath(x.t.cwd), // OpenCode records the resolved folder
      sinceMs: x.t.wd?.attemptAt ?? x.t.startedAt ?? now - 60_000,
      key: keyOf(x.t),
      ...(x.t.worktree ? {} : { match: `/scratch/${x.t.record.taskId}/` }),
    }));
    let steps = new Map<string, SwarmStep | null>();
    try { if (dirs.length) steps = this.io.step?.(dirs) ?? steps; } catch { /* the pane keeps its last known step */ }
    for (const { t, pane } of live) {
      if (!t.worktree && !isBlobsCwd(t.cwd)) continue;
      this.setStep(pane, steps.get(keyOf(t)) ?? null);
    }
  }

  /** Sets a worker's step and touches its pane, but ONLY when the text actually changed (never re-emit a snapshot for nothing). */
  private setStep(pane: PaneLike, step: SwarmStep | null): void {
    if (!pane.swarm) return;
    if ((pane.swarm.step?.text ?? null) === (step?.text ?? null)) return;
    pane.swarm = { ...pane.swarm, step };
    this.touch(pane);
  }

  // ── human fleet actions: retry on another model, buy the worker more time (fleet.retry / fleet.extend) ────────

  /**
   * `fleet.retry`: the human moved this worker to a different model. Reuses the automatic failover path (reason
   * 'stalled': kill the old pane, respawn the task on the next free model in the same worktree) and overwrites the
   * note it leaves with a human-attributed one. null = paneId is not a live swarm worker, or it already ended
   * (done / exhausted / failed) — the caller turns that into a FleetError.
   */
  async retryWorker(paneId: string): Promise<{ taskId: string; newPaneId: string } | null> {
    const t = this.taskOf(paneId);
    if (!t) return null;
    const oldId = t.record.paneIds[t.record.paneIds.length - 1] ?? paneId;
    const pane = this.rt.panes.get(oldId);
    if (!pane || pane.exited || !pane.swarm || pane.swarm.supersededBy || !LIVE_SWARM_PHASES.has(pane.swarm.phase)) return null;
    log(`swarm: human asked to retry ${oldId} on another model`);
    await this.failover(t.record.taskId, 'stalled');
    const newId = t.record.paneIds[t.record.paneIds.length - 1] ?? oldId;
    // A worker moved to a new pane: say so with the human's own attribution (doFailover's own note otherwise stands —
    // e.g. "exhausted", when no free model was left).
    if (newId !== oldId) { t.note = `[kora] the user moved swarm worker ${oldId} to another model (${newId}).`; this.persist(); }
    return { taskId: t.record.taskId, newPaneId: newId };
  }

  /** orchestratorId → what resumeAfterRestart did to its tasks; taken once by the lead's next turn (takeRestartDigest). */
  private restartDigests = new Map<string, string[]>();
  private restartDigestTaken = new Set<string>();
  /** A digest whose turn failed to start: handed back by restoreRestartDigest, taken again by the next turn. */
  private restartDigestBack = new Map<string, string>();
  restoreRestartDigest(orchestratorId: string, digest: string): void { this.restartDigestBack.set(orchestratorId, digest); }
  takeRestartDigest(orchestratorId: string): string | null {
    const back = this.restartDigestBack.get(orchestratorId);
    if (back) { this.restartDigestBack.delete(orchestratorId); return back; }
    // Once per daemon process per lead: its first turn after a restart. What happened to the tasks in flight at the
    // restart (resumed / kept done / dropped), plus every other task of this lead from before the restart — those may
    // have finished while no turn of the lead was running (live: two finished tasks, and the lead spawned both again).
    if (this.restartDigestTaken.has(orchestratorId)) return null;
    const lines = [...(this.restartDigests.get(orchestratorId) ?? [])];
    const named = new Set(lines.map((l) => /^- (s\d+)/.exec(l)?.[1]).filter(Boolean) as string[]);
    const earlier = [...this.registry().values()].filter((t) => t.fromDisk && t.record.orchestratorId === orchestratorId && !named.has(t.record.taskId) && t.record.status !== 'queued');
    // A thread whose swarm work is long over hears nothing: only when something was in flight at the restart, or a
    // task reported recently (2 h), is the lead's picture of its tasks in doubt.
    const recent = (t: TaskState) => { try { return Date.now() - fs.statSync(t.record.reportPath).mtimeMs < 2 * 3600_000; } catch { return false; } };
    if (!lines.length && !earlier.some(recent)) { this.restartDigests.delete(orchestratorId); return null; }
    for (const t of earlier.slice(-10)) {
      const title = t.title || t.resumeLoaded?.title || '';
      const st = t.record.userStopped ? 'stopped by the human — do not redo it' : t.record.status === 'done' ? 'finished — read its report with kora_wait, then merge it if you have not' : MID_FLIGHT.has(t.record.status) ? 'running' : `${t.record.status}`;
      lines.push(`- ${t.record.taskId}${title ? ` "${title}"` : ''}: ${st}`);
    }
    this.restartDigests.delete(orchestratorId);
    if (!lines.length) return null;
    this.restartDigestTaken.add(orchestratorId);
    return [`[kora] Kora's daemon restarted since your last turn. A kora_spawn / kora_wait result of that turn may be lost (a call that reads as "rejected by the user" was cut by the restart, not refused). Your swarm tasks are NOT lost — do not spawn these again; kora_workers shows them all:`, ...lines].join('\n');
  }

  /**
   * Tasks restored from tasks.json for one orchestrator whose panes died with the previous daemon (finished, failed,
   * stopped by the human): what the Workers panel lists after a restart, instead of the task vanishing. Newest last,
   * at most 20. Resumed tasks are live again and come from their panes.
   */
  restoredTasks(orchestratorId: string): Array<{ taskId: string; title: string; status: SwarmWorkerPhase; userStopped: boolean; model: string; provider: string; attempt: number; paneIds: string[]; worktree: { path: string; branch: string; mainRoot: string } | null; report: { bytes: number; updatedAt: number; preview: string } | null }> {
    const out = [];
    for (const t of this.registry().values()) {
      if (!t.restored || t.record.orchestratorId !== orchestratorId || t.record.status === 'queued') continue;
      const ri = t.resumeLoaded ?? null;
      const model = ri?.model ?? '';
      let report: { bytes: number; updatedAt: number; preview: string } | null = null;
      try {
        const st = fs.statSync(t.record.reportPath);
        const fd = fs.openSync(t.record.reportPath, 'r');
        try { const buf = Buffer.alloc(Math.min(st.size, 4096)); fs.readSync(fd, buf, 0, buf.length, 0); report = { bytes: st.size, updatedAt: st.mtimeMs, preview: buf.toString('utf8').slice(0, PREVIEW_CHARS) }; } finally { fs.closeSync(fd); }
      } catch { /* no report */ }
      out.push({ taskId: t.record.taskId, title: t.title || ri?.title || t.record.taskId, status: t.record.status, userStopped: t.record.userStopped === true || t.userStopped === true,
        model, provider: ri?.provider || providerOfModel(model), attempt: ri?.attempt ?? 1, paneIds: [...t.record.paneIds], worktree: t.worktree ?? ri?.worktree ?? null, report });
    }
    return out.slice(-20);
  }

  /**
   * `fleet.kill` on a swarm worker: the human stopped it. Leaves a human-attributed note the lead reads through
   * kora_wait / kora_workers (it otherwise saw "no longer running (failed)" and respawned the task). null = not a
   * swarm task this service knows.
   */
  userStopped(paneId: string): { taskId: string } | null {
    const t = this.taskOf(paneId);
    if (!t) return null;
    t.userStopped = true; t.record.userStopped = true;
    t.note = `[kora] the human stopped swarm worker ${paneId} (task ${t.record.taskId}). Do not respawn it or redo the task unless they ask${t.worktree ? `; its branch ${t.worktree.branch} is kept` : ''}.`;
    log(`swarm: human stopped ${paneId} (task ${t.record.taskId})`);
    this.persist();
    return { taskId: t.record.taskId };
  }

  /**
   * The human pressed Stop on this orchestrator's thread: its queued (not yet started) tasks must never start later
   * on their own. They are dropped and recorded as human-stopped. Returns the dropped task ids.
   */
  cancelQueued(orchestratorId: string): string[] {
    const q = this.queues.get(orchestratorId) ?? [];
    this.queues.delete(orchestratorId);
    const out: string[] = [];
    for (const taskId of q) {
      const t = this.registry().get(taskId);
      if (!t || t.record.status !== 'queued') continue;
      t.record.status = 'failed'; t.record.userStopped = true; t.userStopped = true; t.queuedParams = undefined;
      t.note = `[kora] the human pressed Stop before swarm task ${taskId} started; it was dropped. Do not respawn it unless they ask.`;
      out.push(taskId);
    }
    if (out.length) { log(`swarm: Stop dropped ${out.length} queued task(s) for ${orchestratorId}`); this.persist(); }
    return out;
  }

  /**
   * `fleet.extend`: postpone this task's watchdog deadlines (nudge at T1, reassign at T2) by `minutes`, cumulative
   * across repeated calls. null = paneId is not a live swarm worker, or it already ended.
   */
  extendWorker(paneId: string, minutes: number): { taskId: string } | null {
    const t = this.taskOf(paneId);
    if (!t || !t.wd) return null;
    const pane = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
    if (!pane || pane.exited || !pane.swarm || pane.swarm.supersededBy || !LIVE_SWARM_PHASES.has(pane.swarm.phase)) return null;
    t.wd.extendMs = (t.wd.extendMs ?? 0) + Math.max(0, minutes) * 60_000;
    t.note = `[kora] the user gave swarm worker ${pane.id} ${minutes} more minute${minutes === 1 ? '' : 's'}.`;
    log(`swarm: human gave ${pane.id} ${minutes} more minutes`);
    this.persist();
    return { taskId: t.record.taskId };
  }

  // ── dynamic workflow: milestones, races, progress ──────────────────────────────────────────────────────────
  private msTimer: ReturnType<typeof setInterval> | null = null;
  private startMilestoneTicker(): void {
    if (this.msTimer) return;
    this.msTimer = setInterval(() => { try { this.tickMilestones(); } catch (e) { log('swarm: milestone tick failed', e); } }, 3000);
    this.msTimer.unref?.();
  }

  /** Read new worker milestones; a race-winning one stops the rest of its race group. Public for tests. */
  tickMilestones(): void {
    for (const t of this.registry().values()) {
      if (t.restored || !t.msFile) continue;
      const r = readMilestones(t.msFile, t.msOffset ?? 0);
      if (!r.items.length) continue;
      t.msOffset = r.offset;
      t.milestones = [...(t.milestones ?? []), ...r.items].slice(-20);
      for (const m of r.items) log(`swarm: ${t.record.taskId} milestone ${m.kind}: ${m.note.slice(0, 160)}`);
      const win = r.items.find((m) => RACE_WIN_KINDS.has(m.kind));
      if (win) void this.raceWon(t, win.kind);
    }
  }

  /** `t` won its race: stop every other live task in the same group (same lead). */
  private async raceWon(t: TaskState, why: string): Promise<void> {
    if (!t.race) return;
    const losers = [...this.registry().values()].filter((x) => x !== t && !x.restored && x.race === t.race && x.record.orchestratorId === t.record.orchestratorId);
    let stopped = 0;
    for (const x of losers) {
      const pane = this.rt.panes.get(x.record.paneIds[x.record.paneIds.length - 1] ?? '');
      if (!pane || pane.exited || !pane.swarm || !SLOT_PHASES.has(pane.swarm.phase)) continue;
      for (const tm of x.timers) clearTimeout(tm);
      x.timers = [];
      x.note = `[kora] stopped: ${t.record.taskId} won race "${t.race}" (${why})`;
      pane.swarm = { ...pane.swarm, phase: 'failed' };
      x.record.status = 'failed';
      log(`swarm: race ${t.race}: ${t.record.taskId} won (${why}); stopping ${x.record.taskId}`);
      await this.killAndWait(pane, 3000);
      stopped++;
    }
    if (stopped) { this.persist(); this.dispatchQueued(t.record.orchestratorId); }
  }

  /** One digest per pane for the lead (kora_wait mode:"event", kora_workers). */
  async progress(paneIds: string[]): Promise<SwarmProgress[]> {
    this.tickMilestones();
    const out: SwarmProgress[] = [];
    for (const id of paneIds) {
      const t = this.taskOf(this.follow(id)) ?? this.taskOf(id);
      if (!t) continue;
      const pane = this.rt.panes.get(t.record.paneIds[t.record.paneIds.length - 1] ?? '');
      const dir = t.worktree?.path ?? null;
      const changed = dir ? await this.io.changedFiles(dir).then((f) => (Array.isArray(f) ? f : [])).catch(() => [] as string[]) : [];
      const cleaned = changed.filter((f) => !f.startsWith('.kora/') && !/(^|\/)(AGENTS|CLAUDE)\.md$/.test(f));
      if (cleaned.join('\n') !== (t.lastChanged ?? []).join('\n')) { t.lastChanged = cleaned; t.lastChangeAt = Date.now(); }
      const phase = pane?.swarm?.phase ?? String(t.record.status);
      const base = { phase, startedAt: t.startedAt ?? Date.now(), milestones: t.milestones ?? [], changedFiles: cleaned, lastChangeAt: t.lastChangeAt ?? null };
      out.push({ paneId: pane?.id ?? id, taskId: t.record.taskId, title: t.title, phase, race: t.race ?? null, runningMs: Date.now() - base.startedAt,
        milestones: base.milestones, changedFiles: cleaned, quiet: isQuiet(base), note: t.note });
    }
    return out;
  }

  /** The worker's report, capped at 256 KB; null when none was written. Serves `fleet.readReport`. */
  async readReport(paneId: string): Promise<{ text: string; truncated: boolean; updatedAt: number } | null> {
    const live = this.rt.panes.get(this.follow(paneId));
    const file = live?.swarm?.reportPath ?? (this.taskOf(paneId) ?? this.taskOf(paneId, { restored: true }))?.record.reportPath;
    if (!file) return null;
    try {
      const st = await fs.promises.lstat(file); // never follow a symlinked report (see reportStat)
      if (!st.isFile() || st.size === 0) return null;
      const fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const n = Math.min(st.size, REPORT_CAP);
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: st.size > REPORT_CAP, updatedAt: Math.round(st.mtimeMs) };
      } finally { await fh.close(); }
    } catch { return null; }
  }
}

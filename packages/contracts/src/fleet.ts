import * as Schema from "effect/Schema";
import { IsoInstant, WholeNumber, ThreadId, NonblankString } from "./primitives.ts";
import { SwarmProviderId } from "./swarm.ts";

/**
 * The fleet contract — an ORCHESTRATOR thread's live worker roster, plan and event feed.
 *
 * A thread in `agentMode: "orchestrator"` spawns worker agents (real `claude` / `codex` CLI
 * processes in PTY panes, each usually in its own git worktree). The web client renders each
 * worker as a live terminal tile in the right panel and can steer it by typing (the daemon
 * detects human-origin input and tells the orchestrator), so this stream is the read model
 * behind that panel. A worker's terminal is attached through the ordinary `terminal.attach`
 * RPC with `terminalId = "worker:<paneId>"`.
 */

export const FLEET_METHODS = {
  subscribe: "fleet.subscribe",
  steer: "fleet.steer",
  kill: "fleet.kill",
  mergeVerify: "fleet.mergeVerify",
  merge: "fleet.merge",
  setPlan: "fleet.setPlan",
  /** A swarm worker's report file (never carried in the snapshot). */
  readReport: "fleet.readReport",
  /** Swarm worker: stop this attempt and restart the same task on a different model (same folder/worktree). */
  retry: "fleet.retry",
  /** Swarm worker: postpone the watchdog's nudge/reassign deadlines by `minutes` (the human says "give it time"). */
  extend: "fleet.extend",
  /** One worker's activity feed (the worker box body): a snapshot, then upserts. */
  subscribeWorker: "fleet.subscribeWorker",
  /** Answer a worker's open approval (a GUI worker asks through its box, not its screen). */
  respondApproval: "fleet.respondApproval",
} as const;

/** Mirrors the kora pane agent state words. */
export const FleetWorkerState = Schema.Literals([
  "working",
  "blocked",
  "idle",
  "unknown",
  "exited",
  // A chat lead's CLI worker put to sleep after work: process closed, folder removed, work on its branch, its
  // transcript and final answer readable; Wake resumes the same session (runtime server/worker-sleep.ts).
  "asleep",
]);
export type FleetWorkerState = Schema.Schema.Type<typeof FleetWorkerState>;

// ── Swarm workers (agentMode "swarm"): an OpenCode worker on a free model ──────────────────
// A worker is a swarm worker when `FleetWorker.swarm` is present (`agent` stays "opencode").
// Mirrors the runtime's `SwarmWorkerMeta` minus `reportPath` (runtime/src/protocol/types.ts).

export const FleetSwarmPhase = Schema.Literals([
  "starting",
  "running",
  "rate-limited",
  "respawning",
  "exhausted",
  "failed",
  "done",
]);
export type FleetSwarmPhase = Schema.Schema.Type<typeof FleetSwarmPhase>;

export const FleetSwarmAttempt = Schema.Struct({
  paneId: Schema.String,
  provider: SwarmProviderId,
  model: Schema.String,
  outcome: Schema.Literals([
    "running",
    "ok",
    "rate-limited",
    "model-gone",
    "crashed",
    "auth-failed",
    "stalled",
  ]),
  at: Schema.Number,
});
export type FleetSwarmAttempt = Schema.Schema.Type<typeof FleetSwarmAttempt>;

export const FleetSwarmReportRef = Schema.Struct({
  bytes: WholeNumber,
  updatedAt: Schema.Number,
  /** First ≤280 chars of the report. The full text comes from `fleet.readReport`. */
  preview: Schema.String,
});
export type FleetSwarmReportRef = Schema.Schema.Type<typeof FleetSwarmReportRef>;

/** Verify-and-bounce (PLAN X2): the merge gate run on the worker's worktree when it goes idle with a report. */
export const FleetSwarmVerify = Schema.Struct({
  state: Schema.Literals(["pending", "passed", "bounced", "failed", "skipped"]),
  /** Times the findings were sent back to this same worker (≤ config `swarm.maxBounces`). */
  bounces: WholeNumber,
  summary: Schema.NullOr(Schema.String),
});
export type FleetSwarmVerify = Schema.Schema.Type<typeof FleetSwarmVerify>;

/**
 * The swarm foreman (runtime `SwarmForemanState`): the done-check / auto-retry / reviewer stage between a worker
 * finishing and the leader hearing about it. Absent when the foreman is off.
 */
export const FleetSwarmForemanVerdict = Schema.Struct({
  attempt: Schema.Number,
  paneId: Schema.String,
  model: Schema.String,
  check: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(["passed", "failed", "timeout", "error"]),
      exitCode: Schema.NullOr(Schema.Number),
      durationMs: Schema.Number,
      /** Last ≤20 lines of the check's output. */
      tail: Schema.String,
    }),
  ),
  gate: Schema.NullOr(Schema.Literals(["pending", "passed", "bounced", "failed", "skipped"])),
  review: Schema.NullOr(
    Schema.Struct({
      verdict: Schema.Literals(["pass", "fail", "error"]),
      model: Schema.NullOr(Schema.String),
      reasons: Schema.String,
    }),
  ),
  /** Why this attempt was not accepted; null = accepted. */
  failure: Schema.NullOr(
    Schema.Literals(["check", "gate", "no-report", "crashed", "reviewer", "report", "no-change"]),
  ),
  durationMs: Schema.Number,
  at: Schema.Number,
});
export type FleetSwarmForemanVerdict = Schema.Schema.Type<typeof FleetSwarmForemanVerdict>;

export const FleetSwarmForeman = Schema.Struct({
  state: Schema.Literals(["working", "checking", "retrying", "passed", "escalated"]),
  attempt: Schema.Number,
  maxAttempts: Schema.Number,
  check: Schema.NullOr(Schema.String),
  review: Schema.Boolean,
  verdicts: Schema.Array(FleetSwarmForemanVerdict),
  result: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["pass", "escalation"]),
      attempts: Schema.Number,
      worktree: Schema.NullOr(Schema.String),
      diffStat: Schema.NullOr(Schema.String),
      checkTail: Schema.NullOr(Schema.String),
      lastFailure: Schema.NullOr(Schema.String),
    }),
  ),
});
export type FleetSwarmForeman = Schema.Schema.Type<typeof FleetSwarmForeman>;

/**
 * What a swarm worker is doing right now, in a few words ("reading imdb.com", "searching \"best sitcoms\"",
 * "writing report"), from its latest tool step. The UI shows it as a thought bubble. Null when unknown.
 */
export const FleetSwarmActivity_ = Schema.Struct({
  text: Schema.String,
  /** Epoch ms of the step. */
  at: Schema.Number,
  kind: Schema.Literals(["read", "search", "fetch", "write", "think", "run", "other"]),
});
export type FleetSwarmStep = typeof FleetSwarmActivity_.Type;

export const FleetSwarmWorker = Schema.Struct({
  taskId: Schema.String,
  provider: SwarmProviderId,
  /** opencode `-m` id, e.g. `opencode/big-pickle`. */
  model: Schema.String,
  modelLabel: Schema.String,
  phase: FleetSwarmPhase,
  /** 1-based; >1 after a failover. */
  attempt: Schema.Number,
  attempts: Schema.Array(FleetSwarmAttempt),
  report: Schema.NullOr(FleetSwarmReportRef),
  /** The pane that replaced this one after a failover (this pane is then on its way out). */
  supersededBy: Schema.NullOr(Schema.String),
  /** Panes this task ran on before this one (oldest first). */
  previousPaneIds: Schema.Array(Schema.String),
  verify: Schema.NullOr(FleetSwarmVerify),
  /** The foreman's attempts and verdict (absent when the foreman is off). */
  foreman: Schema.optionalKey(Schema.NullOr(FleetSwarmForeman)),
  /** The worker's latest step (thought bubble). Optional so older daemons' snapshots still decode. */
  step: Schema.optionalKey(Schema.NullOr(FleetSwarmActivity_)),
});
export type FleetSwarmWorker = Schema.Schema.Type<typeof FleetSwarmWorker>;

/**
 * Measured model tokens (never an estimate). `input` excludes cache reads, `cached` is the cache reads,
 * `output` includes reasoning.
 */
export const FleetWorkerTokens = Schema.Struct({
  input: WholeNumber,
  cached: WholeNumber,
  output: WholeNumber,
});
export type FleetWorkerTokens = Schema.Schema.Type<typeof FleetWorkerTokens>;

/** Honest, measured counts only (PLAN X5): no dollars, no "saved". Derived from the workers. */
export const FleetSwarmActivity = Schema.Struct({
  delegated: WholeNumber,
  reportsReturned: WholeNumber,
  respawns: WholeNumber,
  passedFirstTry: WholeNumber,
  bounced: WholeNumber,
  byModel: Schema.Array(
    Schema.Struct({
      provider: SwarmProviderId,
      model: Schema.String,
      modelLabel: Schema.String,
      workers: WholeNumber,
    }),
  ),
  /** Every free model is cooling or gone. */
  exhausted: Schema.Boolean,
  /** The workers' own tokens, summed over the tasks OpenCode has measured (`tasks` of `delegated`). */
  workerTokens: Schema.optionalKey(
    Schema.Struct({ ...FleetWorkerTokens.fields, tasks: WholeNumber }),
  ),
  /** The Claude leader's tokens in this thread, summed over its settled turns (the SDK's own turn usage). */
  leaderTokens: Schema.optionalKey(
    Schema.Struct({ ...FleetWorkerTokens.fields, turns: WholeNumber }),
  ),
});
export type FleetSwarmActivity = Schema.Schema.Type<typeof FleetSwarmActivity>;

export const FleetWorker = Schema.Struct({
  /** kora pane id (`p12`). Also the suffix of the worker's terminal id (`worker:p12`). */
  paneId: NonblankString,
  /** The terminal id to `terminal.attach` for this worker's live PTY. */
  terminalId: NonblankString,
  /** kora agent slug: `claude`, `codex`, `gemini`, … */
  agent: NonblankString,
  account: Schema.NullOr(Schema.String),
  /** The slice the orchestrator handed this worker (first line of its prompt), or the agent name. */
  title: Schema.String,
  state: FleetWorkerState,
  blocker: Schema.NullOr(Schema.String),
  /** True while the human's last steer of this worker is recent (a few seconds). */
  steered: Schema.Boolean,
  steeredAt: Schema.NullOr(Schema.Number),
  cwd: Schema.String,
  worktree: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.String,
      mainRoot: Schema.String,
      dirty: Schema.optional(Schema.Number),
      ahead: Schema.optional(Schema.Number),
    }),
  ),
  costUsd: Schema.NullOr(Schema.Number),
  contextPct: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Int),
  createdAt: Schema.Number,
  lastOutputAt: Schema.Number,
  /** Present only on swarm workers. */
  swarm: Schema.optionalKey(FleetSwarmWorker),
  /** A swarm worker's task tokens as OpenCode measured them (every attempt in its worktree); absent when unknown. */
  tokens: Schema.optionalKey(FleetWorkerTokens),
  /** The human stopped this worker (fleet.kill): its tile/task stays listed as stopped, not as a crash. */
  stoppedByUser: Schema.optionalKey(Schema.Boolean),
  /** Its worktree branch has landed in the main checkout (kora_merge, or a merge by hand the runtime saw). Durable: the
   *  activity feed only keeps the last events, so a busy fleet used to scroll the "merged" event out and the tile fell
   *  back to "NOT merged". */
  branchMerged: Schema.optionalKey(Schema.Boolean),
  /** The model the worker runs on (full id or the harness's own name); null when unknown. */
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * How the worker box renders its body. "gui": the worker has a structured activity feed (`fleet.subscribeWorker`) —
   * a chat-like transcript. "terminal": no feed (an agent Kora can only see through its screen); the box shows its
   * terminal (`terminalId`). Absent = "terminal" (older daemons).
   */
  surface: Schema.optionalKey(Schema.Literals(["gui", "terminal"])),
  /** An approval the worker is waiting on (GUI workers); mirrored as an `approval` feed item. */
  pendingApproval: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ requestId: Schema.String, title: Schema.String })),
  ),
  /** The worker stopped on an API/transport error and Kora is retrying it (attempt of max); null otherwise. */
  retrying: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        attempt: Schema.Number,
        max: Schema.Number,
        message: Schema.String,
        nextAt: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  /** An idle worker that worked and then went idle: when that turn ended. Its answer is ready; the box reads "Done" and
   *  its clock stops here. Absent while working, before its first turn, and once exited or asleep. */
  turnEndedAt: Schema.optionalKey(Schema.Number),
  /** Its last turn stopped on an API error that Kora's automatic retries did not get past: the error line. */
  stoppedOnError: Schema.optionalKey(Schema.String),
  /** The worker's record (sleep / wake / transcript); present on chat leads' CLI workers. */
  recordId: Schema.optionalKey(Schema.String),
  /** Asleep only: its final answer, what it changed and whether its branch is kept. */
  asleep: Schema.optionalKey(
    Schema.Struct({
      sleptAt: Schema.Number,
      finalReport: Schema.NullOr(Schema.String),
      ahead: Schema.Number,
      files: Schema.Array(Schema.String),
      branchKept: Schema.Boolean,
      canResume: Schema.Boolean,
    }),
  ),
});
export type FleetWorker = Schema.Schema.Type<typeof FleetWorker>;

export const FleetEventKind = Schema.Literals([
  "worker-spawned",
  "worker-done",
  "human-steered",
  "blocked",
  "plan",
  "merge-verified",
  "merged",
  "note",
]);
export type FleetEventKind = Schema.Schema.Type<typeof FleetEventKind>;

export const FleetEvent = Schema.Struct({
  at: Schema.Number,
  kind: FleetEventKind,
  text: Schema.String,
  workerId: Schema.optional(Schema.String),
});
export type FleetEvent = Schema.Schema.Type<typeof FleetEvent>;

export const FleetMergePair = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  status: Schema.Literals(["clean", "semantic", "needs-human"]),
  /** Why the pair is not clean, in words (present on every semantic / needs-human pair). */
  reason: Schema.optional(Schema.String),
  blame: Schema.optional(
    Schema.Array(
      Schema.Struct({
        file: Schema.String,
        line: Schema.Number,
        symbol: Schema.String,
        byWorker: Schema.String,
        /** 'dependent' = a base-graph dependent of the touched symbol lives in the other side's changed file;
         *  'reference' = a line the other side ADDED names the touched symbol (a new caller the index cannot know). */
        kind: Schema.optional(Schema.Literals(["dependent", "reference"])),
        /** The other side edited that very line. */
        inHunk: Schema.optional(Schema.Boolean),
        /** The symbol no longer exists on the side that touched it (renamed / deleted). */
        removed: Schema.optional(Schema.Boolean),
        /** Every call the other side's file makes to this symbol fits its NEW signature (arity check). */
        compatible: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type FleetMergePair = Schema.Schema.Type<typeof FleetMergePair>;

export const FleetMergeVerdict = Schema.Struct({
  pairs: Schema.Array(FleetMergePair),
  order: Schema.Array(Schema.String),
  verifiedAt: IsoInstant,
});
export type FleetMergeVerdict = Schema.Schema.Type<typeof FleetMergeVerdict>;

export const FleetSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** The orchestrator id kora panes carry (`chat:<kora thread id>`). */
  orchestratorId: Schema.String,
  workers: Schema.Array(FleetWorker),
  plan: Schema.String,
  events: Schema.Array(FleetEvent),
  lastVerdict: Schema.NullOr(FleetMergeVerdict),
  updatedAt: IsoInstant,
  /** Present only when the thread has swarm workers. */
  swarm: Schema.optionalKey(FleetSwarmActivity),
});
export type FleetSnapshot = Schema.Schema.Type<typeof FleetSnapshot>;

export const FleetSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type FleetSubscribeInput = Schema.Schema.Type<typeof FleetSubscribeInput>;

/** The stream is snapshot-only: every change re-emits the whole (small) fleet. */
export const FleetStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: FleetSnapshot,
});
export type FleetStreamEvent = Schema.Schema.Type<typeof FleetStreamEvent>;

/**
 * Send a line to a worker AS THE HUMAN (a steer): the daemon types it into the worker's
 * PTY and submits it, and the orchestrator is told out of band exactly as if the human had
 * typed into the tile. `submit: false` types without pressing Enter.
 */
export const FleetSteerInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
  text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(16_384)),
  submit: Schema.optional(Schema.Boolean),
});
export type FleetSteerInput = Schema.Schema.Type<typeof FleetSteerInput>;

export const FleetKillInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
});
export type FleetKillInput = Schema.Schema.Type<typeof FleetKillInput>;

export const FleetRetryInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
});
export type FleetRetryInput = Schema.Schema.Type<typeof FleetRetryInput>;

export const FleetExtendInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
  minutes: Schema.Number.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(120)),
});
export type FleetExtendInput = Schema.Schema.Type<typeof FleetExtendInput>;

export const FleetMergeVerifyInput = Schema.Struct({
  threadId: ThreadId,
  /** Restrict to these workers; default = every worker with a worktree. */
  paneIds: Schema.optional(Schema.Array(NonblankString)),
});
export type FleetMergeVerifyInput = Schema.Schema.Type<typeof FleetMergeVerifyInput>;

export const FleetMergeInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
  /** Commit the worker's uncommitted work first (default true). */
  commitFirst: Schema.optional(Schema.Boolean),
});
export type FleetMergeInput = Schema.Schema.Type<typeof FleetMergeInput>;

export const FleetMergeResult = Schema.Struct({
  ok: Schema.Boolean,
  branch: Schema.String,
  into: Schema.String,
  message: Schema.String,
  conflicts: Schema.Array(Schema.String),
});
export type FleetMergeResult = Schema.Schema.Type<typeof FleetMergeResult>;

export const FleetSetPlanInput = Schema.Struct({
  threadId: ThreadId,
  plan: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type FleetSetPlanInput = Schema.Schema.Type<typeof FleetSetPlanInput>;

export const FleetReadReportInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
});
export type FleetReadReportInput = Schema.Schema.Type<typeof FleetReadReportInput>;

/** The report text, capped at 256 KB (`truncated` when cut). */
export const FleetReadReportResult = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  updatedAt: Schema.Number,
});
export type FleetReadReportResult = Schema.Schema.Type<typeof FleetReadReportResult>;

// ── Worker activity feed (the worker box body) ───────────────────────────────────────────────────
// A chat-like transcript of ONE worker: what it was told, what it said, the tools it ran, what it is asking, what went
// wrong. Items are upserted by `id` (a streaming assistant message and a running tool are re-sent as they change).

const FeedBase = { id: Schema.String, at: Schema.Number };

/** A prompt the worker received: the lead's task / steer, the human's steer from the box, or a Kora notice. */
export const WorkerFeedUser = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("user"),
  text: Schema.String,
  source: Schema.Literals(["leader", "human", "kora"]),
});
/** The worker's own text (markdown). `streaming` while it is still being written. */
export const WorkerFeedAssistant = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("assistant"),
  text: Schema.String,
  streaming: Schema.Boolean,
});
/**
 * One tool call. `tool` is the display verb ("Read", "Edited", "Bash", "Explore", "Search", "Web", "Write", "Tool"),
 * `title` the short subject (a path, a command, a query), `detail` an optional excerpt (output tail / error).
 * `added` / `removed` are line counts for edits when known.
 */
export const WorkerFeedTool = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("tool"),
  tool: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "done", "failed"]),
  added: Schema.NullOr(Schema.Number),
  removed: Schema.NullOr(Schema.Number),
});
/** The worker asks permission. Answer with `fleet.respondApproval`; `status` flips when answered. */
export const WorkerFeedApproval = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("approval"),
  requestId: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  status: Schema.Literals(["open", "accepted", "declined", "expired"]),
});
/** A turn failed (API stream cut, rate limit, crash). `retry` when Kora retries it on its own. */
export const WorkerFeedError = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("error"),
  text: Schema.String,
  retry: Schema.NullOr(
    Schema.Struct({
      attempt: Schema.Number,
      max: Schema.Number,
      nextAt: Schema.NullOr(Schema.Number),
    }),
  ),
});
/** A quiet one-liner (turn finished, model switched, put to sleep, failover to another model). */
export const WorkerFeedNotice = Schema.Struct({
  ...FeedBase,
  kind: Schema.Literal("notice"),
  text: Schema.String,
});
export const WorkerFeedItem = Schema.Union([
  WorkerFeedUser,
  WorkerFeedAssistant,
  WorkerFeedTool,
  WorkerFeedApproval,
  WorkerFeedError,
  WorkerFeedNotice,
]);
export type WorkerFeedItem = Schema.Schema.Type<typeof WorkerFeedItem>;

export const FleetSubscribeWorkerInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
});
export type FleetSubscribeWorkerInput = Schema.Schema.Type<typeof FleetSubscribeWorkerInput>;

/** `snapshot` first (the last ≤300 items, oldest first), then `upsert`s (replace the item with the same id, else append). */
export const WorkerFeedStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    paneId: Schema.String,
    items: Schema.Array(WorkerFeedItem),
  }),
  Schema.Struct({ type: Schema.Literal("upsert"), paneId: Schema.String, item: WorkerFeedItem }),
]);
export type WorkerFeedStreamEvent = Schema.Schema.Type<typeof WorkerFeedStreamEvent>;

export const FleetRespondApprovalInput = Schema.Struct({
  threadId: ThreadId,
  paneId: NonblankString,
  requestId: NonblankString,
  decision: Schema.Literals(["accept", "acceptForSession", "decline"]),
});
export type FleetRespondApprovalInput = Schema.Schema.Type<typeof FleetRespondApprovalInput>;

export class FleetThreadNotFoundError extends Schema.TaggedError<FleetThreadNotFoundError>()(
  "FleetThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message() {
    return `Unknown thread: ${this.threadId}`;
  }
}

export class FleetWorkerNotFoundError extends Schema.TaggedError<FleetWorkerNotFoundError>()(
  "FleetWorkerNotFoundError",
  { threadId: Schema.String, paneId: Schema.String },
) {
  override get message() {
    return `Unknown worker ${this.paneId} on thread ${this.threadId}`;
  }
}

export class FleetOperationError extends Schema.TaggedError<FleetOperationError>()(
  "FleetOperationError",
  { threadId: Schema.String, operation: Schema.String, message: Schema.String },
) {}

export const FleetError = Schema.Union([
  FleetThreadNotFoundError,
  FleetWorkerNotFoundError,
  FleetOperationError,
]);
export type FleetError = Schema.Schema.Type<typeof FleetError>;

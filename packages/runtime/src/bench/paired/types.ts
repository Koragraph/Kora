// Paired benchmark: shared types. See docs/bench/PAIRED-HARNESS.md.

export type TaskKind = 'bug-report' | 'feature' | 'fix-failing-tests' | 'rename-refactor' | 'callers' | 'long-session' | 'long-file-change';

export interface AnswerCheck {
  /** every string must appear (case-insensitive) in the final assistant message */
  all?: string[];
  /** none of these may appear, except on a line that also matches `exceptLine` (a line that says "not a caller") */
  none?: string[];
  exceptLine?: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  kind: TaskKind;
  /** a folder under bench/paired/repos */
  repo: string;
  /** one prompt per user turn; turn N+1 resumes the session of turn N */
  prompts: string[];
  timeLimitSec: number;
  maxTurns: number;
  startState: {
    /** a folder (relative to the task) whose files are copied over the repo to make the start state, e.g. a planted bug */
    overlay?: string;
    /** what the repo's own visible suite must do in the start state (checked by `verify`) */
    visibleTests: 'pass' | 'fail';
  };
  grade: {
    /** a folder (relative to the task) of hidden tests; the agent never sees it */
    hidden?: string;
    /** add: copy over the repo. replace-test-dir: delete the repo's test/ first (so edits to tests cannot help) */
    hiddenMode?: 'add' | 'replace-test-dir';
    /** node arguments run in the repo root after the hidden files are in place; every one must exit 0 */
    commands?: string[][];
    /** the repository must be unchanged (read-only tasks) */
    mustNotEdit?: boolean;
    answer?: AnswerCheck;
  };
  reference: {
    /** files restored from the base repo (for a planted bug) */
    revert?: string[];
    /** a folder (relative to the task) copied over the start state */
    overlay?: string;
    /** a file (relative to the task) holding a correct final answer */
    answer?: string;
  };
  notes?: string;
}

export interface LoadedTask extends TaskSpec {
  dir: string;
  repoDir: string;
}

export interface GradeResult {
  ok: boolean;
  /** human-readable one-liners: which command failed, which required word was missing, ... */
  detail: string[];
  commands: { cmd: string; code: number | null; tail: string }[];
  answerOk: boolean | null;
  editedOk: boolean | null;
}

// ---------------------------------------------------------------------------------------------------------------
// arms

export interface ArmContext {
  task: LoadedTask;
  rep: number;
  /** the fresh copy of the task repo the agent works in (its own git repo, deterministic HEAD) */
  workdir: string;
  /** folder for this run's artifacts (stream, answer, diff) */
  runDir: string;
  /** the bench root; arms keep their own caches (indexes) under `<root>/arms/<armId>/` */
  root: string;
  /** same for every run of the same start state: an index built for it stays valid */
  stateKey: string;
  model: string;
  effort: string;
  /** an isolated KORA_HOME for this arm (cost log, injection telemetry, hook state) */
  koraHome: string;
  koraGraphHome: string;
  /** the environment every arm starts from (Kora vars isolated, shims off PATH); a plan's env is layered on top */
  baseEnv: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export interface ArmPlan {
  /** extra arguments for `claude` (an --append-system-prompt here is merged with the run nonce) */
  args: string[];
  /** environment overrides, layered over `baseEnv` */
  env: Record<string, string>;
  notes: string[];
  /** wall time and tokens spent on one-time setup (an index build) in THIS call; 0 when it was cached */
  setupMs?: number;
}

export interface Arm {
  id: string;
  label: string;
  /** this arm's model, overriding the run's --model (set by an `<arm>@<model>` id such as `plain@haiku`) */
  model?: string;
  /** this arm's effort, overriding the run's --effort (set by an `<arm>@<model>:<effort>` id such as `kora@opus:low`) */
  effort?: string;
  /** names the arm's repo copy and graph store (default: the id); model/effort variants share their base arm's, so
   *  `kora@opus` and `kora@sonnet:high` run on one index of each start state. KORA_HOME stays per id. */
  home?: string;
  /** Called before every run, after the fresh repo copy exists. Index, install hooks, write config; cache by ctx.stateKey. */
  prepare(ctx: ArmContext): Promise<ArmPlan>;
  /** Called after the run: arm-specific telemetry merged into the run record under `arm`. */
  collect?(ctx: ArmContext, session: { sessionIds: string[]; startedAt: number }): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------------------------------
// run records

export interface CallUsage {
  id: string;
  model: string | null;
  input: number;
  cacheWrite: number;
  cacheWrite1h: number | undefined;
  cacheRead: number;
  output: number;
}

export interface UsageTotals { input: number; cacheWrite: number; cacheRead: number; output: number }

export interface ToolMix { grep: number; glob: number; read: number; wholeFileRead: number; rangeRead: number; graph: number; bashSearch: number; edit: number; subagent: number; other: number; total: number }

export interface RunRecord {
  schema: 1;
  task: string;
  kind: TaskKind;
  arm: string;
  rep: number;
  /** position of this arm inside its (task, rep) pair: 0 = ran first */
  order: number;
  model: string;
  effort: string;
  startedAt: string;
  wallMs: number;
  turns: number;
  apiCalls: number;
  usage: UsageTotals;
  /** tokens by model, including side calls that never show up as assistant messages */
  usageByModel: Record<string, UsageTotals>;
  /** list-price cost of every API call of the run (cache writes at the 1-hour rate), main + side calls */
  cost: number;
  /** same, but the first call's whole prompt priced as a cache write: removes cache-warmth luck */
  coldCost: number;
  /** what Claude Code reported (total_cost_usd). Diagnostic only: it mis-prices some models. */
  reportedCost: number;
  /** cost of tokens that Claude Code billed but that are not in any assistant message (title / summary side calls) */
  sideCost: number;
  firstCall: { input: number; cacheWrite: number; cacheRead: number } | null;
  tools: ToolMix;
  passed: boolean;
  grade: GradeResult | null;
  timedOut: boolean;
  /** killed because the run's own list-price cost passed the per-run cap */
  capped: boolean;
  /** the run did not measure the arm (no API call, login/network/rate-limit failure): excluded from every statistic */
  invalid: string | null;
  error: string | null;
  filesChanged: string[];
  sessionIds: string[];
  /** arm telemetry (e.g. Kora's injected tokens) */
  armData: Record<string, unknown>;
  setupMs: number;
}

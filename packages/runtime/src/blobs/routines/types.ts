// Routines (Phase 4): recurring work a blob does on its own, plus webhook triggers. Pure data shapes; the runtime never
// imports @kora/contracts, so these are the structural twins the ui-server adapts (see WIRING.md).

/** `interval`: every N minutes (5-1440) aligned to `anchor`. `weekly`: selected weekdays (0 = Sunday) at HH:MM in `tz`.
 *  `cron`: a 5-field expression evaluated in `tz` (the only way to say "first Monday" / "last day of the month").
 *  `once`: one instant. */
export type RoutineCadence =
  | { kind: 'interval'; everyMinutes: number; anchor: number }
  | { kind: 'weekly'; days: number[]; time: string; tz: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'once'; at: number };

export type ResultsTarget =
  /** Post reports into an existing thread. */
  | { mode: 'thread'; threadId: string }
  /** One dedicated results thread, created on the first report (`threadId` is then remembered). */
  | { mode: 'dedicated'; threadId: string | null };

export interface WebhookTrigger {
  id: string;
  label: string;
  /** sha256 hex of the secret. The secret itself is shown once and never stored. */
  secretHash: string;
  createdAt: number;
  rotatedAt: number | null;
  lastEventAt: number | null;
}

export type CatchUp = 'none' | 'one';

export interface Routine {
  id: string;
  blobId: string;
  title: string;
  prompt: string;
  cadence: RoutineCadence;
  /** Paused routines never fire (and never record missed runs). */
  paused: boolean;
  results: ResultsTarget;
  /** Start each run with the previous run's report (at most REMEMBER_CHARS). */
  rememberLastRun: boolean;
  /** Stop a run that is still going after this many minutes. null = never (explicitly chosen; a new routine defaults to DEFAULT_RUN_LIMIT_MINUTES). */
  maxRunMinutes: number | null;
  /** Runs missed while the daemon was off: `one` = run once on wake (only if the miss is recent), `none` = just record. */
  catchUp: CatchUp;
  triggers: WebhookTrigger[];
  /** Occurrences up to this instant are accounted for (fired, missed or skipped). */
  cursor: number;
  /** A template's suggested timing in its own words ("Weekdays at 9:00 and 16:00") when it could not be mapped exactly. */
  suggestedCadence: string | null;
  /** Who made it, for the receipt text. */
  createdBy: 'user' | 'self' | 'kora' | 'template';
  skipped: number;
  /** Consecutive failed runs; AUTO_PAUSE_AFTER_FAILURES in a row pauses the routine. Any other outcome resets it. */
  failStreak?: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = 'queued' | 'active' | 'waiting' | 'completed' | 'missed' | 'failed' | 'cancelled';
export const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set(['completed', 'missed', 'failed', 'cancelled']);
export const LIVE_RUN: ReadonlySet<RunStatus> = new Set(['queued', 'active', 'waiting']);

export type RunSource = 'schedule' | 'catch-up' | 'manual' | 'webhook';

export interface RoutineRun {
  id: string;
  routineId: string;
  blobId: string;
  title: string;
  status: RunStatus;
  source: RunSource;
  /** The occurrence this run stands for (scheduled instant), or when it was asked for. */
  dueAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The hidden execution thread ("Open run"). */
  threadId: string | null;
  koraThreadId: string | null;
  /** Where the report went. */
  resultsThreadId: string | null;
  /** The report text (also fed to the next run when rememberLastRun). */
  report: string | null;
  reason: string | null;
  outputs: string[];
  webhookId: string | null;
  /** Untrusted webhook body, kept only while the run is live. */
  eventPayload: string | null;
  updatedAt: number;
}

/** The dated report card a finished run posts into the results thread (a new `routine-report` card kind). */
export interface RoutineReportCard {
  cardKind: 'routine-report';
  cardId: string;
  version: number;
  routineId: string;
  runId: string;
  blobId: string;
  title: string;
  status: 'completed' | 'failed' | 'cancelled';
  ranAt: number;
  text: string;
  outputs: string[];
  /** The hidden execution thread: "Open run" navigates there. */
  executionThreadId: string | null;
  resultsThreadId: string;
}

/** Asks before a routine change lands (another blob's routine without Full access, or the 20-routine guard). */
export interface RoutineConfirmCard {
  cardKind: 'routine-confirm';
  cardId: string;
  version: number;
  token: string;
  blobId: string;
  summary: string;
  details: string[];
  state: 'open' | 'confirmed' | 'dismissed' | 'failed';
  result: string | null;
}

export interface RoutineSelfChangeCard { cardKind: 'self-change'; cardId: string; version: number; what: string; undoToken: string; undone: boolean }

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
export const REMEMBER_CHARS = 2000;
export const MAX_ACTIVE_ROUTINES_PER_BLOB = 20;
/** An agent (not the user) starting a routine always asks; past this many active ones it asks even when it normally would not. */
export const AGENT_ASK_ACTIVE_ROUTINES = 5;
/** A new routine stops a run after this long unless the user chose otherwise. */
export const DEFAULT_RUN_LIMIT_MINUTES = 15;
/** This many failed runs in a row pause the routine (a limit-blocked or broken routine must not re-fire every tick forever). */
export const AUTO_PAUSE_AFTER_FAILURES = 3;
/** Scheduled / catch-up / webhook runs one blob may start per rolling 24 h (a manual "Run now" is always allowed). */
export const MAX_RUNS_PER_BLOB_PER_DAY = 24;
/** Routine runs live at once across every blob; the rest wait their turn (queued). */
export const MAX_CONCURRENT_RUNS = 3;
/** Catch-up runs started per tick after a sleep: the rest follow on the next ticks ("never a burst"). */
export const MAX_CATCH_UPS_PER_TICK = 2;
export const MAX_TITLE_CHARS = 80;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_QUEUED_EVENTS = 5;

// Defensive read of a `job` card payload (contracts: JobCardPayload) plus the display rules of the Job card:
// stages (what runs together, what waits), one status word per step, the blob's animation state. Pure.
import type { BlobVisualState } from "~/components/blobs/avatar";
import type { BlobCardRef } from "../../../thread/timeline";

export type StepStatus = "queued" | "running" | "needs-you" | "done" | "failed" | "cancelled";
export type JobStatus = "planned" | "running" | "done" | "failed" | "cancelled";

export interface StepView {
  readonly id: string;
  readonly blobId: string;
  readonly blobName: string;
  readonly title: string;
  readonly task: string;
  readonly kind: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly status: StepStatus;
  readonly threadId: string | null;
  readonly resultGist: string | null;
  readonly outputs: ReadonlyArray<string>;
  /** Epoch ms the step reached an end state; null while it is live (or an older daemon did not send it). */
  readonly finishedAt: number | null;
}

export interface JobView {
  readonly cardId: string;
  readonly version: number;
  readonly title: string;
  readonly status: JobStatus;
  readonly steps: ReadonlyArray<StepView>;
  readonly createdAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const STEP_STATUSES = new Set<string>([
  "queued",
  "running",
  "needs-you",
  "done",
  "failed",
  "cancelled",
]);
const JOB_STATUSES = new Set<string>(["planned", "running", "done", "failed", "cancelled"]);

function parseStep(value: unknown, index: number): StepView | null {
  if (!isRecord(value)) return null;
  const status = str(value.status, "queued");
  return {
    id: str(value.id, `step-${index}`),
    blobId: str(value.blobId),
    blobName: str(value.blobName),
    title: str(value.title, "Step"),
    task: str(value.task),
    kind: str(value.kind),
    dependsOn: Array.isArray(value.dependsOn)
      ? value.dependsOn.filter((d): d is string => typeof d === "string")
      : [],
    status: STEP_STATUSES.has(status) ? (status as StepStatus) : "queued",
    threadId: typeof value.threadId === "string" && value.threadId ? value.threadId : null,
    resultGist:
      typeof value.resultGist === "string" && value.resultGist.trim() ? value.resultGist : null,
    outputs: Array.isArray(value.outputs)
      ? value.outputs.filter((o): o is string => typeof o === "string" && o.length > 0)
      : [],
    finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
  };
}

/** Read a payload (a card row's, or the result of `blobs.job.cancel`) into a view. */
export function parseJobPayload(
  payload: Record<string, unknown>,
  fallback: { cardId: string; version: number },
): JobView | null {
  if (payload.cardKind !== "job") return null;
  const status = str(payload.status, "planned");
  return {
    cardId: typeof payload.cardId === "string" ? payload.cardId : fallback.cardId,
    version: typeof payload.version === "number" ? payload.version : fallback.version,
    title: str(payload.title, "Job"),
    status: JOB_STATUSES.has(status) ? (status as JobStatus) : "planned",
    steps: (Array.isArray(payload.steps) ? payload.steps : []).flatMap((s, i) => {
      const step = parseStep(s, i);
      return step ? [step] : [];
    }),
    createdAt: typeof payload.createdAt === "number" ? payload.createdAt : 0,
  };
}

export function parseJob(card: BlobCardRef): JobView | null {
  return parseJobPayload(card.payload, { cardId: card.cardId, version: card.version });
}

/** Keep the higher version (a late, older frame never rolls the card back). Equal versions: the newer arrival. */
export function latestJob(prev: JobView | null, next: JobView): JobView {
  if (prev === null || prev.cardId !== next.cardId) return next;
  return next.version >= prev.version ? next : prev;
}

// ── stages ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Longest chain of dependencies behind each step (0 = starts right away). Cycles and unknown ids are ignored. */
function stageIndex(steps: ReadonlyArray<StepView>): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const step = byId.get(id);
    let d = 0;
    for (const dep of step?.dependsOn ?? []) if (byId.has(dep)) d = Math.max(d, depth(dep) + 1);
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const s of steps) depth(s.id);
  return memo;
}

/** Steps grouped by stage, stages in order; steps within a stage keep plan order. */
export function stages(steps: ReadonlyArray<StepView>): StepView[][] {
  const idx = stageIndex(steps);
  const out: StepView[][] = [];
  for (const s of steps) {
    const i = idx.get(s.id) ?? 0;
    (out[i] ??= []).push(s);
  }
  return out.filter((g) => g !== undefined && g.length > 0);
}

/** "after Popo" / "after Popo and Junip": the plain-language wait, hidden once every dependency is done. */
export function waitsOn(step: StepView, steps: ReadonlyArray<StepView>): string | null {
  const open = step.dependsOn
    .map((id) => steps.find((s) => s.id === id))
    .filter((s): s is StepView => s !== undefined && s.status !== "done");
  if (open.length === 0) return null;
  const names = [...new Set(open.map((s) => s.blobName || s.title))];
  const joined =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  return `after ${joined}`;
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────

export const STEP_WORD: Record<StepStatus, string> = {
  queued: "waiting",
  running: "working",
  "needs-you": "needs you",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const JOB_WORD: Record<JobStatus, string> = {
  planned: "Planned",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Steps parked on the user (an approval, an answer): the card says so on its header, not only on the step. */
export function needsYouCount(job: JobView): number {
  return job.steps.filter((s) => s.status === "needs-you").length;
}

/**
 * How long after its last step ended a "done" job still counts as the one Kora is putting together. Older cards in the
 * same thread (a job from earlier that day) never read as combining when a later question makes Kora's turn run.
 */
export const COMBINING_WINDOW_MS = 15 * 60_000;

/**
 * A job is done when its steps are; Kora's turn is done when she has written the answer. While her turn still runs
 * after the last step finished, the card says "Combining…" instead of "Done" (live QA #3: "Done" showed for ~3 minutes
 * while Kora was still working). `koraWorking` = the thread the card sits in is running a turn.
 */
export function isCombining(job: JobView, koraWorking: boolean, now: number = Date.now()): boolean {
  if (!koraWorking || job.status !== "done" || job.steps.length === 0) return false;
  const ends = job.steps.map((s) => s.finishedAt).filter((t): t is number => t !== null);
  // An older daemon that sent no end times: the card's own age is the best guide.
  const last = ends.length ? Math.max(...ends) : job.createdAt;
  return last === 0 || now - last <= COMBINING_WINDOW_MS;
}

/** The header word: "Waiting on you" while a step needs the user, "Combining…" while Kora finishes, else the status word. */
export function jobWord(job: JobView, combining = false): string {
  if (combining && job.status === "done") return "Combining…";
  // A job that ended with a cancelled or failed step did not do everything it planned: never plain "Done".
  if (
    job.status === "done" &&
    job.steps.some((s) => s.status === "cancelled" || s.status === "failed")
  )
    return "Finished";
  return job.status === "running" && needsYouCount(job) > 0
    ? "Waiting on you"
    : JOB_WORD[job.status];
}

export function avatarStateFor(status: StepStatus): BlobVisualState {
  switch (status) {
    case "running":
      return "working";
    case "needs-you":
      return "waiting";
    case "done":
      return "done";
    case "cancelled":
      return "offline";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function jobProgress(job: JobView): { done: number; total: number } {
  return {
    done: job.steps.filter((s) => s.status === "done").length,
    total: job.steps.length,
  };
}

export function isFinal(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** A step can be edited or cancelled until it starts. */
export function canChangeStep(job: JobView, step: StepView): boolean {
  return !isFinal(job.status) && step.status === "queued";
}

/** A step can be cancelled on its own until it is over: queued, running or waiting on the user. Same interrupt path as Cancel job; later steps that need it are cancelled with it. */
export function canCancelStep(job: JobView, step: StepView): boolean {
  return (
    !isFinal(job.status) &&
    (step.status === "queued" || step.status === "running" || step.status === "needs-you")
  );
}

export function allOutputs(job: JobView): string[] {
  return [...new Set(job.steps.flatMap((s) => s.outputs))];
}

export function outputName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).at(-1) || clean;
}

export function compactSummary(job: JobView, combining = false): string {
  const { done, total } = jobProgress(job);
  if (combining && job.status === "done")
    return `${total} ${total === 1 ? "step" : "steps"} done, Kora is putting the answer together`;
  if (job.status === "done") {
    const skipped = job.steps.filter((s) => s.status === "cancelled").length;
    const broke = job.steps.filter((s) => s.status === "failed").length;
    if (skipped + broke > 0)
      return `${done} of ${total} done${skipped ? `, ${skipped} cancelled` : ""}${broke ? `, ${broke} failed` : ""}`;
    return `${total} ${total === 1 ? "step" : "steps"} done`;
  }
  if (job.status === "cancelled") return `Cancelled after ${done} of ${total}`;
  if (job.status === "failed") return `${done} of ${total} done, then a step failed`;
  return `${done} of ${total} done`;
}

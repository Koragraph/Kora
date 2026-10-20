/**
 * Fleet (orchestrator / swarm) activity helpers. Our daemon appends these activity kinds to a
 * fleet thread as its workers come and go, so the transcript can show a bespoke row (with a
 * jump to the fleet panel) instead of a plain summary line.
 */
const WORKER_ACTIVITY_KINDS = [
  "worker.attached",
  "worker.detached",
  "worker.steered",
  "worker.blocked",
  "worker.done",
  // A CLI worker finished its turn (or stopped on an error) and is waiting.
  "worker.idle",
  "fleet.plan",
  // Swarm workers (the ui-server turns S2's swarm worker events into these).
  "worker.report",
  "worker.respawned",
  "worker.rate-limited",
  "worker.bounced",
  // The composer's Chat | Orchestrator | Swarm toggle, and the leader's own rate limit (X4).
  "agent-mode.switched",
  "leader.rate-limited",
] as const;

export type WorkerActivityKind = (typeof WORKER_ACTIVITY_KINDS)[number];

const WORKER_ACTIVITY_KIND_SET = new Set<string>(WORKER_ACTIVITY_KINDS);

export function isWorkerActivityKind(variant: string | undefined): variant is WorkerActivityKind {
  return variant !== undefined && WORKER_ACTIVITY_KIND_SET.has(variant);
}

export interface WorkerActivityFields {
  paneId: string | null;
  agent: string | null;
  title: string | null;
  text: string | null;
  blocker: string | null;
  exitCode: number | null;
  plan: string | null;
  /** worker.respawned: the pane the task moved to, and the model hop. */
  newPaneId: string | null;
  fromModel: string | null;
  toModel: string | null;
  /** worker.report / worker.bounced: the verify gate's state, bounce count and summary. */
  verifyState: string | null;
  verifyBounces: number | null;
  verifySummary: string | null;
  /** worker.idle: the error line the worker stopped on (usage limit, auth, …), null when it just finished. */
  problem: string | null;
  /** worker.rate-limited: the models the task tried. */
  tried: string[];
  /** agent-mode.switched */
  from: string | null;
  to: string | null;
  /** leader.rate-limited: epoch ms the leader's limit resets; null once it has reset. */
  until: number | null;
}

function asTrimmedString(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const stripped = val.trim();
  return stripped.length > 0 ? stripped : null;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === "object" ? (val as Record<string, unknown>) : null;
}

export function parseWorkerActivity(payload: unknown): WorkerActivityFields {
  const fields = asRecord(payload);
  const verify = asRecord(fields?.verify);
  return {
    paneId: asTrimmedString(fields?.paneId),
    agent: asTrimmedString(fields?.agent),
    title: asTrimmedString(fields?.title),
    text: asTrimmedString(fields?.text),
    blocker: asTrimmedString(fields?.blocker),
    exitCode: typeof fields?.exitCode === "number" ? fields.exitCode : null,
    plan: asTrimmedString(fields?.plan),
    newPaneId: asTrimmedString(fields?.newPaneId),
    fromModel: asTrimmedString(fields?.fromModel),
    toModel: asTrimmedString(fields?.toModel),
    verifyState: asTrimmedString(verify?.state),
    verifyBounces: typeof verify?.bounces === "number" ? verify.bounces : null,
    verifySummary: asTrimmedString(verify?.summary),
    problem: asTrimmedString(fields?.problem),
    tried: Array.isArray(fields?.tried)
      ? fields.tried.filter((tt): tt is string => typeof tt === "string")
      : [],
    from: asTrimmedString(fields?.from),
    to: asTrimmedString(fields?.to),
    until: typeof fields?.until === "number" ? fields.until : null,
  };
}

/**
 * X4: when the thread's leader is rate-limited, the epoch ms its limit resets — read from the
 * latest `leader.rate-limited` activity (the daemon appends one when the limit hits and one with
 * `until: null` when it resets). Null when not limited, or when that time has passed.
 */
export function leaderRateLimitedUntil(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  clock: number,
): number | null {
  for (let idx = activities.length - 1; idx >= 0; idx--) {
    const act = activities[idx]!;
    if (act.kind !== "leader.rate-limited") continue;
    const until = parseWorkerActivity(act.payload).until;
    return until !== null && until > clock ? until : null;
  }
  return null;
}

const MODE_LABELS: Record<string, string> = {
  chat: "Chat",
  orchestrator: "Orchestrator",
  swarm: "Stretch",
};

/** "Swarm", "Orchestrator", … for an agent mode (unknown modes pass through). */
export function agentModeLabel(flavor: string | null): string {
  return flavor === null ? "" : (MODE_LABELS[flavor] ?? flavor);
}

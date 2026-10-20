type LatestTurnTiming = {
  readonly turnId: string | null;
  /** Set when the turn is created; `startedAt` waits for the provider. */
  readonly completedAt: string | null;
  readonly startedAt: string | null;
  readonly requestedAt?: string | null;
};

type SessionActivityState = {
  readonly status: string;
  readonly activeTurnId?: string | null;
};

function formatShortDuration(ms: number): string {
  if (ms < 1_000) return Math.max(1, Math.round(ms)) + "ms";
  const tenths = Math.round(ms / 100) / 10;
  return tenths >= 10 ? "10s" : tenths.toFixed(1) + "s";
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 10_000) return formatShortDuration(durationMs);
  if (durationMs < 60_000) return Math.round(durationMs / 1_000) + "s";
  const whole = Math.round(durationMs / 1_000);
  const units: Array<[amount: number, suffix: string]> = [
    [Math.floor(whole / 3_600), "h"],
    [Math.floor((whole % 3_600) / 60), "m"],
    [whole % 60, "s"],
  ];
  return units
    .filter(([amount]) => amount > 0)
    .map(([amount, suffix]) => amount + suffix)
    .join(" ");
}

/** Finished, and no session is still running it. */
const hasSettled = (turn: LatestTurnTiming, session: SessionActivityState | null): boolean =>
  Boolean(turn.completedAt) && session?.status !== "running";

/**
 * When the working indicator should be counting, and from when.
 *
 * `requestedAt` is the floor for an unsettled turn. The projector only stamps
 * `startedAt` in the same update that moves the session to "running", so while
 * the provider spins up (session "starting") a requested turn has no
 * `startedAt` at all — and returning null there blinks the indicator out for
 * the whole spin-up. A settled turn still falls through to `sendStartedAt`, so
 * this cannot leave the indicator counting after the work is done.
 */
export function deriveActiveWorkStartedAt(
  turn: LatestTurnTiming | null,
  current: SessionActivityState | null,
  sentAt: string | null,
): string | null {
  const activeId = current?.activeTurnId;
  const supersededTurn = Boolean(activeId) && activeId !== turn?.turnId;
  if (turn === null || supersededTurn || hasSettled(turn, current)) return sentAt;
  return turn.startedAt ?? turn.requestedAt ?? sentAt;
}

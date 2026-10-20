import type { ChatLatestTurn } from "@kora/contracts";

import type { SessionPhase, Thread, ThreadSession } from "../../types";

type TurnTimes = Pick<ChatLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionState = Pick<NonNullable<Thread["session"]>, "status" | "activeTurnId">;

/** The latest turn has both started and finished, and the session is not still running one. */
export function isLatestTurnSettled(turn: TurnTimes | null, session: SessionState | null): boolean {
  return Boolean(turn?.startedAt && turn.completedAt) && session?.status !== "running";
}

/**
 * When the work now under way began, for the elapsed-time label: the running turn's start (or, before the daemon
 * has reported it, when the message was sent); an unsettled turn's start; else the send time.
 */
export function deriveActiveWorkStartedAt(
  turn: TurnTimes | null,
  session: SessionState | null,
  sendStartedAt: string | null,
  latestUserMessageAt: string | null = null,
): string | null {
  const running = session?.status === "running" ? session.activeTurnId : null;
  if (running !== null) {
    const known = turn?.turnId === running ? turn.startedAt : null;
    return known ?? sendStartedAt ?? latestUserMessageAt;
  }
  return isLatestTurnSettled(turn, session) ? sendStartedAt : (turn?.startedAt ?? sendStartedAt);
}

const PHASE: Partial<Record<ThreadSession["status"], SessionPhase>> = {
  running: "running",
  starting: "connecting",
  error: "disconnected",
  stopped: "disconnected",
  interrupted: "disconnected",
};

/** No session, or one that ended, is disconnected; any other live status is ready. */
export const derivePhase = (session: ThreadSession | null): SessionPhase =>
  session ? (PHASE[session.status] ?? "ready") : "disconnected";

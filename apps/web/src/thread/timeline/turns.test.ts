import { TurnId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { at } from "./testActivities";
import { deriveActiveWorkStartedAt, derivePhase, isLatestTurnSettled } from "./turns";

const finished = { turnId: TurnId.make("t1"), startedAt: at(0), completedAt: at(6) };
const idle = { status: "ready", activeTurnId: null } as const;
const runningTurn = (turn: string) =>
  ({ status: "running", activeTurnId: TurnId.make(turn) }) as const;

describe("is the latest turn settled?", () => {
  it.each([
    ["it never started", { ...finished, startedAt: null }, null, false],
    ["it has no end yet", { ...finished, completedAt: null }, null, false],
    ["it ended and nothing runs", finished, idle, true],
    ["it ended and there is no session", finished, null, true],
    ["another turn is running (no stale banner)", finished, runningTurn("t2"), false],
    ["the session still runs it", finished, runningTurn("t1"), false],
  ] as const)("%s: %s", (_, turn, session, expected) => {
    expect(isLatestTurnSettled(turn, session)).toBe(expected);
  });
});

describe("when the work under way started (the elapsed-time label)", () => {
  it.each([
    ["a fresh send after the last turn ended", finished, null, at(60), null, at(60)],
    ["a fresh send while idle", finished, idle, at(60), null, at(60)],
    ["the running turn's own start", finished, runningTurn("t1"), at(60), null, at(0)],
    [
      "a new turn the daemon has not reported yet: the send",
      finished,
      runningTurn("t2"),
      at(60),
      null,
      at(60),
    ],
    [
      "a new turn, no send time known: the user's message",
      finished,
      runningTurn("t2"),
      null,
      at(61),
      at(61),
    ],
    ["an unsettled turn: its start", { ...finished, completedAt: null }, null, at(60), null, at(0)],
  ] as const)("%s", (_, turn, session, sent, userMessage, expected) => {
    expect(deriveActiveWorkStartedAt(turn, session, sent, userMessage)).toBe(expected);
  });
});

it.each([
  [null, "disconnected"],
  ["stopped", "disconnected"],
  ["interrupted", "disconnected"],
  ["error", "disconnected"],
  ["starting", "connecting"],
  ["running", "running"],
  ["ready", "ready"],
] as const)("a session that is %s reads as %s", (status, phase) => {
  const session = status === null ? null : ({ status } as Parameters<typeof derivePhase>[0]);
  expect(derivePhase(session)).toBe(phase);
});

// @effect-diagnostics globalDate:off -- Tests exercise local calendar snooze boundaries.
import { ThreadId, TurnId, type ChatThreadHead } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadSnoozeShell } from "./threadSettled.ts";
import * as Settled from "./threadSettled.ts";

const { canSnooze, threadWokeAt, effectiveSnoozed, threadRaisedHandWhileSnoozed } = Settled;
const { hasQueuedTurnStart, resolveSnoozePresets } = Settled;

// All clock values are on 2026-05-14 unless a test says otherwise.
const NOW = "2026-05-14T12:00:00.000Z";
const SNOOZED_AT = "2026-05-14T09:00:00.000Z";
const WAKE_TOMORROW = "2026-05-15T09:00:00.000Z";
const WAKE_ALREADY_PAST = "2026-05-14T10:00:00.000Z";
const AT_NOW = { now: NOW } as const;

const localTime = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

type SessionStatus = NonNullable<ThreadSnoozeShell["session"]>["status"];

type ShellSpec = Partial<{
  pending: "approval" | "user-input";
  sessionStatus: Extract<SessionStatus, "starting" | "running" | "ready" | "error">;
  snoozedAt: string | null;
  snoozedUntil: string | null;
  turnCompletedAt: string | null;
}>;

/** A Codex session row; only the fields a test cares about vary. */
const sessionRow = (
  id: string,
  status: SessionStatus,
  lastError: string | null,
  updatedAt: string,
): NonNullable<ThreadSnoozeShell["session"]> => ({
  status,
  lastError,
  updatedAt,
  threadId: ThreadId.make(id),
  activeTurnId: null,
  runtimeMode: "full-access",
  providerName: "Codex",
});

/** A latest-turn row that has not started streaming an answer. */
const turnRow = (
  id: string,
  state: "running" | "completed",
  requestedAt: string,
  completedAt: string | null,
): NonNullable<ThreadSnoozeShell["latestTurn"]> => ({
  completedAt,
  requestedAt,
  state,
  turnId: TurnId.make(id),
  assistantMessageId: null,
  startedAt: null,
});

const shellOf = (spec: ShellSpec): ThreadSnoozeShell => {
  const { sessionStatus, turnCompletedAt, pending } = spec;
  const snoozedUntil = spec.snoozedUntil ?? null;
  return {
    latestTurn:
      turnCompletedAt === undefined
        ? null
        : turnRow("turn-4", "completed", SNOOZED_AT, turnCompletedAt),
    session:
      sessionStatus === undefined
        ? null
        : sessionRow(
            "thread-4",
            sessionStatus,
            sessionStatus === "error" ? "boom" : null,
            "2026-05-14T11:00:00.000Z",
          ),
    hasPendingUserInput: pending === "user-input",
    hasPendingApprovals: pending === "approval",
    snoozedAt: spec.snoozedAt ?? (snoozedUntil === null ? null : SNOOZED_AT),
    snoozedUntil,
  };
};

/** A snoozed-until-tomorrow shell with extra state on top. */
const snoozedShell = (extra: Omit<ShellSpec, "snoozedUntil"> = {}) =>
  shellOf({ snoozedUntil: WAKE_TOMORROW, ...extra });

const withMessageAt = (spec: ShellSpec, latestUserMessageAt: string | null) => ({
  ...shellOf(spec),
  latestUserMessageAt,
});

type QueuedTurnShell = Pick<ChatThreadHead, "latestUserMessageAt" | "latestTurn" | "session">;

const queuedShell = (overrides: Partial<QueuedTurnShell> = {}): QueuedTurnShell => ({
  latestUserMessageAt: null,
  latestTurn: null,
  session: null,
  ...overrides,
});

describe("effectiveSnoozed", () => {
  it("hides a thread that is still before its wake time", () => {
    expect(effectiveSnoozed(snoozedShell(), AT_NOW)).toBe(true);
  });

  it("stops treating the thread as snoozed once the wake time passes, with no event needed", () => {
    expect(effectiveSnoozed(shellOf({ snoozedUntil: WAKE_ALREADY_PAST }), AT_NOW)).toBe(false);
  });

  it("does not snooze a thread that has no snooze state", () => {
    expect(effectiveSnoozed(shellOf({}), AT_NOW)).toBe(false);
  });

  it("does not hide a thread because of an unparseable wake time", () => {
    expect(effectiveSnoozed(shellOf({ snoozedUntil: "not-a-date" }), AT_NOW)).toBe(false);
  });

  it.each(["approval", "user-input"] as const)("wakes early when blocked on %s", (pending) => {
    expect(effectiveSnoozed(snoozedShell({ pending }), AT_NOW)).toBe(false);
  });

  it("wakes early on an error that came after the snooze", () => {
    // The shell helper stamps session.updatedAt at 11:00, after SNOOZED_AT (9:00).
    expect(effectiveSnoozed(snoozedShell({ sessionStatus: "error" }), AT_NOW)).toBe(false);
  });

  it("stays snoozed if the error was already there when the user snoozed — they saw it", () => {
    const shell = snoozedShell({
      sessionStatus: "error",
      // Snoozed AFTER the error's status edge.
      snoozedAt: "2026-05-14T11:30:00.000Z",
    });

    expect(effectiveSnoozed(shell, AT_NOW)).toBe(true);
  });

  it("stays snoozed while the session keeps running, because snoozing never pauses the agent", () => {
    expect(effectiveSnoozed(snoozedShell({ sessionStatus: "running" }), AT_NOW)).toBe(true);
  });

  it("wakes early when a run finishes after the snooze was set", () => {
    const shell = snoozedShell({ turnCompletedAt: "2026-05-14T10:30:00.000Z" });

    expect(effectiveSnoozed(shell, AT_NOW)).toBe(false);
  });

  it("ignores a run that finished before the snooze, since the user saw that result", () => {
    const shell = snoozedShell({ turnCompletedAt: "2026-05-14T08:00:00.000Z" });

    expect(effectiveSnoozed(shell, AT_NOW)).toBe(true);
  });
});

describe("threadRaisedHandWhileSnoozed", () => {
  it("is false when nothing happened to the snoozed thread", () => {
    expect(threadRaisedHandWhileSnoozed(snoozedShell())).toBe(false);
  });

  it.each([
    { what: "an approval request", extra: { pending: "approval" } as const },
    { what: "a question for the user", extra: { pending: "user-input" } as const },
    { what: "a failure", extra: { sessionStatus: "error" } as const },
  ])("is true after $what", ({ extra }) => {
    expect(threadRaisedHandWhileSnoozed(snoozedShell(extra))).toBe(true);
  });
});

describe("canSnooze", () => {
  it("lets both idle and busy threads be snoozed", () => {
    expect(canSnooze(withMessageAt({}, null), AT_NOW)).toBe(true);
    expect(canSnooze(withMessageAt({ sessionStatus: "running" }, null), AT_NOW)).toBe(true);
  });

  it.each(["approval", "user-input"] as const)("refuses a thread waiting on %s", (pending) => {
    expect(canSnooze(withMessageAt({ pending }, null), AT_NOW)).toBe(false);
  });

  it("refuses while a turn start is queued, by the same hidden-work rule as settling", () => {
    // A fresh user message that no turn has picked up, inside the grace window.
    expect(canSnooze(withMessageAt({}, "2026-05-14T11:59:30.000Z"), AT_NOW)).toBe(false);
    // Past the grace window the message is stale data, not queued work.
    expect(canSnooze(withMessageAt({}, "2026-05-14T11:00:00.000Z"), AT_NOW)).toBe(true);
  });
});

describe("hasQueuedTurnStart", () => {
  it("lets the queued state lapse after two minutes", () => {
    const thread = queuedShell({ latestUserMessageAt: "2026-05-14T11:57:59.000Z" });

    expect(hasQueuedTurnStart(thread, AT_NOW)).toBe(false);
  });

  it("ends the queued state once a turn picks the message up or the session fails", () => {
    const sentAt = "2026-05-14T11:59:00.000Z";
    const endings = [
      { latestTurn: turnRow("turn-picked-up", "running", sentAt, null) },
      { session: sessionRow("thread-failed", "error", "failed", NOW) },
    ];
    for (const ending of endings) {
      const thread = queuedShell({ ...ending, latestUserMessageAt: sentAt });
      expect(hasQueuedTurnStart(thread, AT_NOW)).toBe(false);
    }
  });

  it("limits how far into the future a client clock may be ahead", () => {
    const wayAhead = queuedShell({ latestUserMessageAt: "2026-05-14T12:03:00.000Z" });
    const justAhead = queuedShell({ latestUserMessageAt: "2026-05-14T12:01:00.000Z" });

    expect(hasQueuedTurnStart(wayAhead, AT_NOW)).toBe(false);
    expect(hasQueuedTurnStart(justAhead, AT_NOW)).toBe(true);
  });
});

describe("threadWokeAt", () => {
  it("is null for a thread that was never snoozed or is still snoozed", () => {
    expect(threadWokeAt(shellOf({}), AT_NOW)).toBe(null);
    expect(threadWokeAt(snoozedShell(), AT_NOW)).toBe(null);
  });

  it("gives the scheduled time when the timer woke it", () => {
    expect(threadWokeAt(shellOf({ snoozedUntil: WAKE_ALREADY_PAST }), AT_NOW)).toBe(
      WAKE_ALREADY_PAST,
    );
  });

  it("gives the completion time when a finished run woke it early", () => {
    const finishedAt = "2026-05-14T10:30:00.000Z";

    expect(threadWokeAt(snoozedShell({ turnCompletedAt: finishedAt }), AT_NOW)).toBe(finishedAt);
  });

  it("uses session activity for an early wake caused by a block or a failure", () => {
    expect(threadWokeAt(snoozedShell({ sessionStatus: "error" }), AT_NOW)).toBe(
      "2026-05-14T11:00:00.000Z",
    );
  });

  it("keeps the early wake as the answer even after the scheduled time has passed too", () => {
    // It woke early at 9:30 through a finished run; by NOW the scheduled wake time (10:00)
    // is also in the past. Reporting that scheduled time would bring back a "woke" marker the
    // user already cleared by visiting in between.
    const shell = shellOf({
      snoozedUntil: WAKE_ALREADY_PAST,
      turnCompletedAt: "2026-05-14T09:30:00.000Z",
    });

    expect(threadWokeAt(shell, AT_NOW)).toBe("2026-05-14T09:30:00.000Z");
  });
});

describe("resolveSnoozePresets", () => {
  const idsAt = (when: Date) => resolveSnoozePresets(when).map((preset) => preset.id);
  const presetNamed = (presets: ReturnType<typeof resolveSnoozePresets>, id: string) =>
    presets.find((preset) => preset.id === id);

  it("offers the same choices on desktop and mobile", () => {
    const presets = resolveSnoozePresets(localTime(2026, 4, 8, 10));

    expect(presets.map(({ id }) => id).join(" ")).toBe(
      "hour three-hours evening tomorrow next-week",
    );
    expect(presetNamed(presets, "three-hours")?.snoozedUntil).toBe(
      localTime(2026, 4, 8, 13).toISOString(),
    );
    expect(presetNamed(presets, "three-hours")?.label).toBe("In 3 hours");
    expect(presetNamed(presets, "evening")?.label).toBe("This evening");
    expect(new Date(presetNamed(presets, "tomorrow")!.snoozedUntil).getHours()).toBe(9);
  });

  it("leaves out the evening choice when evening is close or gone", () => {
    expect(idsAt(localTime(2026, 4, 8, 17, 30))).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("sets next week to the following Monday", () => {
    const monday = new Date(
      presetNamed(resolveSnoozePresets(localTime(2026, 4, 6, 10)), "next-week")!.snoozedUntil,
    );

    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(13);
  });

  it("leaves out next week on a Sunday, when it would equal tomorrow's Monday", () => {
    // Sunday 2026-08-30 07:01: both "Tomorrow" and "Next week" would be Monday 9:00.
    const presets = resolveSnoozePresets(localTime(2026, 8, 30, 7, 1));

    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
    ]);
    expect(new Date(presetNamed(presets, "tomorrow")!.snoozedUntil).getDay()).toBe(1);
  });
});

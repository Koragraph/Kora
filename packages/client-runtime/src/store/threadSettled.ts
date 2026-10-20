// @effect-diagnostics globalDate:off -- Snooze presets are defined in the viewer's local calendar.
import type { ChatThreadHead } from "@kora/contracts";

const QUEUED_TURN_WINDOW_MS = 120_000;

const parseTime = (iso: string): number => Date.parse(iso);

/**
 * A user message that no turn has adopted yet: turn.start was dispatched but the session is still
 * unset. Only trusted within a short window either side of "now" so stale or skewed data can't
 * pin the state.
 */
export function hasQueuedTurnStart(
  shell: Pick<ChatThreadHead, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { now: string },
): boolean {
  const messageAt = shell.latestUserMessageAt;
  if (!messageAt || shell.session?.status === "error") return false;
  const message = parseTime(messageAt);
  const now = parseTime(options.now);
  if (Number.isNaN(message) || Number.isNaN(now)) return false;
  if (Math.abs(now - message) > QUEUED_TURN_WINDOW_MS) return false;

  const turn = shell.latestTurn;
  if (!turn) return true;
  const stamps = [turn.requestedAt, turn.startedAt, turn.completedAt];
  return stamps.every((stamp) => stamp == null || parseTime(stamp) < message);
}

export type ThreadSnoozeShell = Pick<
  ChatThreadHead,
  | "session"
  | "latestTurn"
  | "snoozedAt"
  | "snoozedUntil"
  | "hasPendingUserInput"
  | "hasPendingApprovals"
>;

type RaisedHand = "none" | "blocked" | "failed" | "completed";

const classifyRaisedHand = (shell: ThreadSnoozeShell): RaisedHand => {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "blocked";
  const snoozedAt = shell.snoozedAt;
  const session = shell.session;
  if (
    session?.status === "error" &&
    (!snoozedAt || parseTime(session.updatedAt) > parseTime(snoozedAt))
  ) {
    return "failed";
  }
  const completedAt = shell.latestTurn?.completedAt;
  if (
    snoozedAt &&
    shell.latestTurn?.state === "completed" &&
    completedAt &&
    parseTime(completedAt) > parseTime(snoozedAt)
  ) {
    return "completed";
  }
  return "none";
};

export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  return classifyRaisedHand(shell) !== "none";
}

export function canSnooze(
  shell: Pick<
    ChatThreadHead,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  return !hasQueuedTurnStart(shell, options);
}

export function effectiveSnoozed(shell: ThreadSnoozeShell, options: { now: string }): boolean {
  if (!shell.snoozedUntil) return false;
  const wake = parseTime(shell.snoozedUntil);
  if (Number.isNaN(wake)) return false;
  if (wake <= parseTime(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(shell: ThreadSnoozeShell, options: { now: string }): string | null {
  if (!shell.snoozedUntil) return null;
  const wake = parseTime(shell.snoozedUntil);
  if (Number.isNaN(wake)) return null;

  const hand = classifyRaisedHand(shell);
  if (hand === "completed") return shell.latestTurn?.completedAt ?? null;
  if (hand !== "none") return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  return wake <= parseTime(options.now) ? shell.snoozedUntil : null;
}

export type SnoozePresetId = "next-week" | "tomorrow" | "evening" | "three-hours" | "hour";

export interface SnoozePreset {
  readonly label: string;
  readonly id: SnoozePresetId;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const HOUR_MS = 3_600_000;
const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

const atHour = (base: Date, dayOffset: number, hour: number): Date => {
  const result = new Date(base);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(hour, 0, 0, 0);
  return result;
};

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const clock = (date: Date) => date.toLocaleTimeString([], timeFormat);
  const make = (id: SnoozePresetId, label: string, date: Date, whenLabel = clock(date)) => ({
    id,
    label,
    whenLabel,
    snoozedUntil: date.toISOString(),
  });

  const presets: SnoozePreset[] = [
    make("hour", "In 1 hour", new Date(now.getTime() + HOUR_MS)),
    make("three-hours", "In 3 hours", new Date(now.getTime() + 3 * HOUR_MS)),
  ];

  const evening = atHour(now, 0, 18);
  if (evening.getTime() - now.getTime() > HOUR_MS)
    presets.push(make("evening", "This evening", evening));

  const tomorrow = atHour(now, 1, 9);
  presets.push(make("tomorrow", "Tomorrow", tomorrow));

  const untilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const monday = atHour(now, untilMonday, 9);
  if (monday.getTime() !== tomorrow.getTime()) {
    const weekday = monday.toLocaleDateString([], { weekday: "short" });
    presets.push(make("next-week", "Next week", monday, `${weekday} ${clock(monday)}`));
  }
  return presets;
}

export type CustomSnoozeInput =
  | {
      readonly unit: "minutes" | "hours" | "days";
      readonly amount: string;
      readonly mode: "duration";
    }
  | { readonly time: string; readonly date: string; readonly mode: "date" };

const UNIT_MS = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS } as const;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function localSnoozeDate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localSnoozeTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOCAL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_SHAPE = /^\d{2}:\d{2}$/;

function wakeFromCustomInput(input: CustomSnoozeInput, now: Date): Date | null {
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!(Number.isFinite(amount) && amount > 0)) return null;
    return new Date(now.getTime() + amount * UNIT_MS[input.unit]);
  }
  if (!LOCAL_DATE_SHAPE.test(input.date) || !LOCAL_TIME_SHAPE.test(input.time)) return null;
  const wake = new Date(`${input.date}T${input.time}:00`);
  if (Number.isNaN(wake.getTime())) return null;
  // Rolled-over days (Feb 30) and skipped DST times don't survive a round trip.
  const roundTrips = localSnoozeDate(wake) === input.date && localSnoozeTime(wake) === input.time;
  return roundTrips ? wake : null;
}

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  const wake = wakeFromCustomInput(input, now);
  if (wake === null) return null;
  const at = wake.getTime();
  return Number.isFinite(at) && at > now.getTime() ? wake.toISOString() : null;
}

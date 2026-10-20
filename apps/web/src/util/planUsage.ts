/**
 * Presentation maths for the account's plan limits (`AgentStatus.usageLimits`, kept by the daemon's
 * usage store): which windows to show, how a reset is phrased, and whether the provider is refusing turns
 * right now. Pure; `now` is always passed in so the views and tests agree.
 */
import type { AgentUsageLimits, AgentUsageWindow } from "@kora/contracts";

export interface PlanWindowView {
  readonly id: string;
  readonly label: string;
  readonly kind: AgentUsageWindow["kind"];
  /** 0..100, already 0 once the window's reset time has passed. */
  readonly usedPercent: number;
  /** The window's reset time passed since the last reading: the bar shows it empty. */
  readonly hasReset: boolean;
  readonly resetsAt: number | null;
  readonly tone: "normal" | "warning" | "critical";
}

const parseTime = (iso: string | undefined | null): number | null => {
  if (!iso) return null;
  const tt = Date.parse(iso);
  // Claude reports a reset as hh:59:59.89: unrounded, "2:29 AM" printed a minute before the real 2:30.
  return Number.isFinite(tt) ? Math.round(tt / 60_000) * 60_000 : null;
};

export function usageTone(usedPercent: number): PlanWindowView["tone"] {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 75) return "warning";
  return "normal";
}

export function planWindowViews(
  limits: AgentUsageLimits | null | undefined,
  clock: number,
): PlanWindowView[] {
  if (!limits) return [];
  return limits.windows.map((w) => {
    const resetsAt = parseTime(w.resetsAt);
    const hasReset = resetsAt !== null && resetsAt <= clock;
    const usedPercent = hasReset ? 0 : Math.max(0, Math.min(100, w.usedPercent));
    return {
      id: w.id,
      label: w.label,
      kind: w.kind,
      usedPercent,
      hasReset,
      resetsAt: hasReset ? null : resetsAt,
      tone: usageTone(usedPercent),
    };
  });
}

/** The provider refuses turns right now: a limit was hit and its reset (if it named one) is still ahead. */
export function activePlanLimit(
  limits: AgentUsageLimits | null | undefined,
  clock: number,
): { resetsAt: number | null; message: string | null } | null {
  const limited = limits?.limited;
  if (!limited) return null;
  const resetsAt = parseTime(limited.resetsAt);
  if (resetsAt !== null && resetsAt <= clock) return null;
  return { resetsAt, message: limited.message ?? null };
}

/** "in 2h 14m", "in 45m", "in 3d 4h" — how long until `at`. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * "resets in 2h 14m" (same day-ish), "resets Thu 9:00 PM" (this week), "resets Oct 16, 8:25 PM" (later).
 * `timeZone` is for tests; the app formats in the viewer's own zone.
 */
export function formatResetPhrase(
  when: number | null,
  clock: number,
  timeZone?: string,
): string | null {
  if (when === null) return null;
  const ms = when - clock;
  if (ms <= 0) return "reset";
  const tz = timeZone ? { timeZone } : {};
  if (ms < 12 * 3_600_000) return `resets in ${formatDuration(ms)}`;
  if (ms < 6 * 86_400_000) {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", ...tz }).format(when);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      ...tz,
    }).format(when);
    return `resets ${day} ${time}`;
  }
  const date = new Intl.DateTimeFormat("en-US", {
    minute: "2-digit",
    hour: "numeric",
    day: "numeric",
    month: "short",
    ...tz,
  }).format(when);
  return `resets ${date}`;
}

/** The one window worth a glance in the composer: the most used one (ties → the shorter window). */
export function headlineWindow(views: ReadonlyArray<PlanWindowView>): PlanWindowView | null {
  let best: PlanWindowView | null = null;
  for (const view of views) {
    if (!best || view.usedPercent > best.usedPercent) best = view;
  }
  return best;
}

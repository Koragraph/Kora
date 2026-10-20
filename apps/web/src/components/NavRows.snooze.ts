import { formatShortTimestamp, parseTimestampDate } from "../timeFormat";
import type { ClockFormat } from "@kora/contracts/clientPrefs";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  type SnoozePreset,
} from "@kora/client-runtime/store/thread-settled";

export { type SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;

function timeOfDayLabel(date: Date, timestampFormat: ClockFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: ClockFormat,
): ReadonlyArray<SnoozePreset> {
  const labelPreset = (preset: SnoozePreset): SnoozePreset => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const clock = timeOfDayLabel(wake, timestampFormat);
    const whenLabel =
      preset.id === "next-week"
        ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`
        : clock;
    return { ...preset, whenLabel };
  };
  return resolveSharedSnoozePresets(now).map(labelPreset);
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: ClockFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) {
    return "";
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const time = timeOfDayLabel(wake, timestampFormat);
  const dayDelta = Math.floor((wake.getTime() - midnight.getTime()) / DAY_MS);
  if (dayDelta === 0) {
    return time;
  }
  if (dayDelta === 1) {
    return `tomorrow ${time}`;
  }
  const weekday = wake.toLocaleDateString(undefined, { weekday: "short" });
  if (dayDelta < 7) {
    return `${weekday} ${time}`;
  }
  const date = wake.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

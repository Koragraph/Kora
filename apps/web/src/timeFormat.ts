import type { ClockFormat } from "@kora/contracts/clientPrefs";

export function resolveTimestampLocale(localeTag: string | null | undefined): string | undefined {
  const candidate = localeTag?.trim();
  if (!candidate) return undefined;
  try {
    Intl.DateTimeFormat.supportedLocalesOf([candidate]);
  } catch {
    return undefined; // structurally invalid tag
  }
  return candidate;
}

// Fixed at load: the host locale does not change while the page lives.
const timestampLocale = resolveTimestampLocale(
  typeof window === "undefined" ? null : (window.shellBridge?.getSystemLocale?.() ?? null),
);

export function parseTimestampDate(isoDate: string): Date | null {
  const parsedAt = new Date(isoDate);
  if (Number.isNaN(parsedAt.getTime())) return null;
  return parsedAt;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(format: ClockFormat, withSeconds = false): Intl.DateTimeFormat {
  const keyName = `${format}:${withSeconds ? "seconds" : "minutes"}`;
  let formatter = timeFormatters.get(keyName);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(timestampLocale, {
      hour: "numeric",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" as const } : {}),
      ...(format === "locale" ? {} : { hour12: format === "12-hour" }),
    });
    timeFormatters.set(keyName, formatter);
  }
  return formatter;
}

export function formatShortTimestamp(isoDate: string, timestampFormat: ClockFormat): string {
  const date = parseTimestampDate(isoDate);
  return date ? timeFormatter(timestampFormat).format(date) : "";
}

const englishMonth = new Intl.DateTimeFormat("en-US", { month: "long" });

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** The month name is always English: the ordinal and day-before-month order are English too. */
export function formatChatTimestampTooltip(isoDate: string, timestampFormat: ClockFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return `${timeFormatter(timestampFormat).format(date)}, ${ordinal(date.getDate())} ${englishMonth.format(date)} ${date.getFullYear()}`;
}

const DAY_MS = 86_400_000;
const startOfLocalDay = (day: Date) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();

export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: ClockFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (date === null) return "";
  const clock = new Date(nowMs);
  // Rounding absorbs 23- and 25-hour daylight-saving days.
  const daysAgo = Math.round((startOfLocalDay(clock) - startOfLocalDay(date)) / DAY_MS);
  const time = timeFormatter(timestampFormat).format(date);
  if (daysAgo <= 0) return time;
  if (daysAgo === 1) return `yesterday at ${time}`;
  const sameYear = date.getFullYear() === clock.getFullYear();
  const day = new Intl.DateTimeFormat(timestampLocale, {
    month: "numeric",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  }).format(date);
  return `${day} ${time}`;
}

export type RelativeTimeState =
  | { suffix: string | null; value: string; status: "relative" }
  | { status: "invalid" }
  | { status: "missing" };

export function formatRelativeTime(
  isoDate: string,
): { value: string; suffix: string | null } | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const elapsedSeconds = (Date.now() - date.getTime()) / 1000;
  if (elapsedSeconds < 60) return { suffix: null, value: "just now" };
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return { suffix: "ago", value: `${elapsedMinutes}m` };
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return { suffix: "ago", value: `${elapsedHours}h` };
  return { suffix: "ago", value: `${Math.floor(elapsedHours / 24)}d` };
}

export function formatRelativeTimeLabel(isoDate: string): string {
  const parts = formatRelativeTime(isoDate);
  if (parts === null) return "";
  return parts.suffix ? [parts.value, parts.suffix].join(" ") : parts.value;
}

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/** Replaces machine timestamps inside a sentence with the reader's own day-aware clock. */
export function humanizeIsoTimestamps(
  str: string,
  timestampFormat: ClockFormat = "locale",
): string {
  return str.replace(
    ISO_INSTANT,
    (matched) => formatDayAwareTimestamp(matched, timestampFormat) || matched,
  );
}

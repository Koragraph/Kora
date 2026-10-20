// Routines, client side: wire shapes (the JSON the daemon's routine service returns; see
// packages/runtime/src/blobs/routines/WIRING.md for the contract mapping), plain-words descriptions of a schedule, the
// editor's draft <-> cadence conversion, and run status presentation. Pure: no React, no clock except what is passed in.
// ── wire ─────────────────────────────────────────────────────────────────────────────────────────────

export type CadenceWire =
  | { kind: "interval"; everyMinutes: number; anchor: number }
  | { kind: "weekly"; days: number[]; time: string; tz: string }
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "once"; at: number };

export type ResultsWire =
  | { mode: "thread"; threadId: string }
  | { mode: "dedicated"; threadId: string | null };

export type RunStatus =
  | "queued"
  | "active"
  | "waiting"
  | "completed"
  | "missed"
  | "failed"
  | "cancelled";
export type RunSource = "schedule" | "catch-up" | "manual" | "webhook";

export interface TriggerWire {
  id: string;
  label: string;
  url: string;
  createdAt: number;
  rotatedAt: number | null;
  lastEventAt: number | null;
}

export interface RunWire {
  id: string;
  routineId: string;
  blobId: string;
  title: string;
  status: RunStatus;
  source: RunSource;
  dueAt: number;
  startedAt: number | null;
  endedAt: number | null;
  threadId: string | null;
  resultsThreadId: string | null;
  report: string | null;
  reason: string | null;
}

export interface RoutineWire {
  id: string;
  blobId: string;
  title: string;
  prompt: string;
  cadence: CadenceWire;
  paused: boolean;
  results: ResultsWire;
  rememberLastRun: boolean;
  maxRunMinutes: number | null;
  catchUp: "none" | "one";
  triggers: TriggerWire[];
  nextRunAt: number | null;
  live: RunWire | null;
  lastRun: RunWire | null;
  suggestedCadence: string | null;
  createdBy: "user" | "self" | "kora" | "template";
  skipped: number;
}

export interface RoutineReportCardWire {
  cardKind: "routine-report";
  cardId: string;
  routineId: string;
  runId: string;
  blobId: string;
  title: string;
  status: "completed" | "failed" | "cancelled";
  ranAt: number;
  text: string;
  outputs: string[];
  executionThreadId: string | null;
  resultsThreadId: string;
}

export interface RoutineConfirmCardWire {
  cardKind: "routine-confirm";
  cardId: string;
  token: string;
  blobId: string;
  summary: string;
  details: string[];
  state: "open" | "confirmed" | "dismissed" | "failed";
  result: string | null;
}

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const ORDINAL = ["first", "second", "third", "fourth", "fifth"] as const;

function clock12(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return time;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function andList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function daysWords(days: ReadonlyArray<number>): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (set.length === 1) return `Every ${WEEKDAY_LONG[set[0]!]}`;
  return andList(set.map((d) => WEEKDAY_SHORT[d]!));
}

const ordinalDay = (n: number): string => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

// ── cron in plain words ──────────────────────────────────────────────────────────────────────────────
interface Field {
  any: boolean;
  values: number[];
  rawStep: number | null;
}

const MONTH_ABBR = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DOW_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function field(
  src: string,
  min: number,
  max: number,
  names: string[] | null,
  base: number,
): Field | string {
  if (src === "*" || src === "?") return { any: true, values: [], rawStep: null };
  const out = new Set<number>();
  const rawStep = /^\*\/(\d+)$/.exec(src);
  const toNum = (t: string): number | null => {
    const i = names ? names.indexOf(t.toUpperCase()) : -1;
    if (i >= 0) return i + base;
    return /^\d{1,2}$/.test(t) ? Number(t) : null;
  };
  for (const part of src.split(",")) {
    const [range = "", stepSrc, extra] = part.split("/");
    if (extra !== undefined || range === "") return `"${part}" is not valid here`;
    const step = stepSrc === undefined ? 1 : Number(stepSrc);
    if (!Number.isInteger(step) || step < 1) return `"${part}" has a bad step`;
    let lo: number | null;
    let hi: number | null;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = toNum(a);
      hi = toNum(b);
    } else {
      lo = toNum(range);
      hi = stepSrc === undefined ? lo : max;
    }
    if (lo === null || hi === null || lo < min || hi > max || lo > hi)
      return `"${part}" is outside ${min}-${max}`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return {
    any: false,
    values: [...out].sort((a, b) => a - b),
    rawStep: rawStep ? Number(rawStep[1]) : null,
  };
}

export type CronWords = { ok: true; words: string } | { ok: false; error: string };

/** A 5-field cron rule in plain words. Anything this cannot say exactly is reported as unreadable, never guessed. */
export function cronWords(expr: string): CronWords {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5 || f[0] === "")
    return {
      ok: false,
      error: "A cron rule has 5 fields: minute hour day-of-month month day-of-week",
    };
  const [mS, hS, domS, monS, dowS] = f as [string, string, string, string, string];
  const m = field(mS, 0, 59, null, 0);
  if (typeof m === "string") return { ok: false, error: `Minute: ${m}` };
  const h = field(hS, 0, 23, null, 0);
  if (typeof h === "string") return { ok: false, error: `Hour: ${h}` };
  const domLast = /^L$/i.test(domS);
  const dom = domLast
    ? ({ any: false, values: [], rawStep: null } as Field)
    : field(domS, 1, 31, null, 0);
  if (typeof dom === "string") return { ok: false, error: `Day of month: ${dom}` };
  const mon = field(monS, 1, 12, MONTH_ABBR, 1);
  if (typeof mon === "string") return { ok: false, error: `Month: ${mon}` };

  // day of week: plain values plus `1#2` (nth) and `5L` (last)
  const nth: Array<{ dow: number; n: number }> = [];
  const last: number[] = [];
  const plain: string[] = [];
  for (const part of dowS.split(",")) {
    const a = /^([A-Za-z]{3}|\d)#([1-5])$/.exec(part);
    const b = /^([A-Za-z]{3}|\d)L$/i.exec(part);
    const num = (t: string): number | null => {
      const i = DOW_ABBR.indexOf(t.toUpperCase());
      if (i >= 0) return i;
      return /^\d$/.test(t) && Number(t) <= 7 ? Number(t) % 7 : null;
    };
    if (a) {
      const d = num(a[1]!);
      if (d === null) return { ok: false, error: `Day of week: "${part}" is not valid` };
      nth.push({ dow: d, n: Number(a[2]) });
    } else if (b) {
      const d = num(b[1]!);
      if (d === null) return { ok: false, error: `Day of week: "${part}" is not valid` };
      last.push(d);
    } else plain.push(part);
  }
  let dow: Field = { any: true, values: [], rawStep: null };
  if (plain.length) {
    const d = field(plain.join(","), 0, 7, DOW_ABBR, 0);
    if (typeof d === "string") return { ok: false, error: `Day of week: ${d}` };
    dow = d.any
      ? d
      : { ...d, values: [...new Set(d.values.map((v) => v % 7))].sort((x, y) => x - y) };
  }
  const dowExt = nth.length > 0 || last.length > 0;
  if (!dom.any && !domLast && dom.values.length && mon.any === false) {
    const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!mon.values.some((mo) => dom.values.some((d) => d <= maxDays[mo - 1]!)))
      return { ok: false, error: "That date never happens (for example February 30)" };
  }

  // time
  let time: string;
  const minuteOnly = !m.any && m.values.length === 1 ? m.values[0]! : null;
  if (m.any && h.any) time = "every minute";
  else if (m.rawStep && h.any) time = `every ${m.rawStep} minutes`;
  else if (minuteOnly !== null && h.any)
    time =
      minuteOnly === 0 ? "every hour, on the hour" : `every hour at ${minuteOnly} minutes past`;
  else if (minuteOnly !== null && h.rawStep)
    time = `every ${h.rawStep} hours${minuteOnly === 0 ? "" : ` at ${minuteOnly} minutes past`}`;
  else if (m.rawStep && !h.any) {
    const hs = h.values;
    const contiguous = hs.every((v, i) => i === 0 || v === hs[i - 1]! + 1);
    if (!contiguous) return { ok: true, words: `Custom rule (${expr.trim()})` };
    time = `every ${m.rawStep} minutes between ${clock12(`${hs[0]}:00`)} and ${clock12(`${hs[hs.length - 1]}:59`)}`;
  } else if (!m.any && !h.any) {
    const stamps: string[] = [];
    for (const hh of h.values)
      for (const mm of m.values) stamps.push(clock12(`${hh}:${String(mm).padStart(2, "0")}`));
    time = `at ${stamps.length > 4 ? `${andList(stamps.slice(0, 4))} and ${stamps.length - 4} more times` : andList(stamps)}`;
  } else return { ok: true, words: `Custom rule (${expr.trim()})` };
  const every = time.startsWith("every");

  // days
  const domBit = domLast
    ? "on the last day of the month"
    : dom.any
      ? null
      : `on the ${andList(dom.values.map(ordinalDay))} of the month`;
  const dowBits: string[] = [];
  if (!dow.any) {
    const w = daysWords(dow.values);
    dowBits.push(
      w === "Weekdays"
        ? "weekdays"
        : w === "Weekends"
          ? "weekends"
          : w.startsWith("Every ")
            ? `every ${w.slice(6)}`
            : `on ${w}`,
    );
  }
  for (const n of nth)
    dowBits.push(`on the ${ORDINAL[n.n - 1]} ${WEEKDAY_LONG[n.dow]} of the month`);
  for (const d of last) dowBits.push(`on the last ${WEEKDAY_LONG[d]} of the month`);
  // classic cron: day-of-month OR day-of-week. With L / # the rule is "both must hold", which has no short honest wording.
  if (domBit && dowBits.length && dowExt)
    return { ok: true, words: `Custom rule (${expr.trim()})` };
  const joined =
    domBit && dowBits.length
      ? `${domBit} or ${dowBits.join(" or ")}`
      : [domBit, ...dowBits].filter(Boolean).join(" and ") || "every day";
  const bits = domBit || dowBits.length ? [joined] : [];
  const months = mon.any ? "" : ` in ${andList(mon.values.map((v) => MONTH_LONG[v - 1]!))}`;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (every)
    return {
      ok: true,
      words: bits.length === 0 && !months ? cap(time) : `${cap(time)}, ${joined}${months}`,
    };
  return { ok: true, words: `${cap(joined)}${months} ${time}` };
}

/** One line for any cadence ("Weekdays at 8:00 AM", "Every 30 minutes", "On the first Monday of the month at 9:00 AM"). */
function cadenceWords(c: CadenceWire): { words: string; zone: string | null } {
  switch (c.kind) {
    case "interval":
      return {
        words:
          c.everyMinutes === 60
            ? "Every hour"
            : c.everyMinutes % 60 === 0
              ? `Every ${c.everyMinutes / 60} hours`
              : `Every ${c.everyMinutes} minutes`,
        zone: null,
      };
    case "weekly":
      return { words: `${daysWords(c.days)} at ${clock12(c.time)}`, zone: c.tz };
    case "cron": {
      const r = cronWords(c.expr);
      return { words: r.ok ? r.words : "Unreadable rule", zone: c.tz };
    }
    case "once":
      return {
        words: `Once, ${new Date(c.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        zone: null,
      };
  }
}

export function cadenceLine(c: CadenceWire): string {
  const { words, zone } = cadenceWords(c);
  return zone ? `${words} · ${zone}` : words;
}

// ── editor draft ─────────────────────────────────────────────────────────────────────────────────────
export type CadenceKind = CadenceWire["kind"];

export interface CadenceDraft {
  kind: CadenceKind;
  everyMinutes: string;
  days: number[];
  time: string;
  tz: string;
  cron: string;
  /** `datetime-local` value, in this Mac's zone. */
  onceLocal: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function draftFromCadence(c: CadenceWire | null, now: number): CadenceDraft {
  const base: CadenceDraft = {
    kind: "weekly",
    everyMinutes: "30",
    days: [1, 2, 3, 4, 5],
    time: "08:00",
    tz: localTimeZone(),
    cron: "0 9 * * 1#1",
    onceLocal: toDateTimeLocal(now + 3_600_000),
  };
  if (!c) return base;
  switch (c.kind) {
    case "interval":
      return { ...base, kind: "interval", everyMinutes: String(c.everyMinutes) };
    case "weekly":
      return { ...base, kind: "weekly", days: [...c.days], time: c.time, tz: c.tz };
    case "cron":
      return { ...base, kind: "cron", cron: c.expr, tz: c.tz };
    case "once":
      return { ...base, kind: "once", onceLocal: toDateTimeLocal(c.at) };
  }
}

export type DraftResult = { ok: true; cadence: CadenceWire } | { ok: false; error: string };

export function cadenceFromDraft(d: CadenceDraft): DraftResult {
  switch (d.kind) {
    case "interval": {
      const n = Number(d.everyMinutes);
      if (!Number.isInteger(n) || n < 5 || n > 1440)
        return { ok: false, error: "Choose between 5 and 1,440 minutes." };
      return { ok: true, cadence: { kind: "interval", everyMinutes: n, anchor: 0 } };
    }
    case "weekly":
      if (d.days.length === 0) return { ok: false, error: "Pick at least one day." };
      if (!/^\d{1,2}:\d{2}$/.test(d.time)) return { ok: false, error: "Pick a time." };
      if (!isValidTimeZone(d.tz)) return { ok: false, error: "That time zone is not recognised." };
      return {
        ok: true,
        cadence: {
          kind: "weekly",
          days: [...d.days].sort((a, b) => a - b),
          time: d.time,
          tz: d.tz,
        },
      };
    case "cron": {
      if (!isValidTimeZone(d.tz))
        return { ok: false, error: "A cron rule needs a time zone, like America/New_York." };
      const r = cronWords(d.cron);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        cadence: { kind: "cron", expr: d.cron.trim().replace(/\s+/g, " "), tz: d.tz },
      };
    }
    case "once": {
      const at = new Date(d.onceLocal).getTime();
      if (!Number.isFinite(at)) return { ok: false, error: "Pick a date and time." };
      if (at <= Date.now())
        return { ok: false, error: "That time has already passed. Pick a time in the future." };
      return { ok: true, cadence: { kind: "once", at } };
    }
  }
}

/** The sentence under the cadence picker: what this will do, in words. */
export function draftSentence(d: CadenceDraft): { ok: boolean; text: string } {
  const r = cadenceFromDraft(d);
  if (!r.ok) return { ok: false, text: r.error };
  const w = cadenceWords(r.cadence);
  return { ok: true, text: w.zone ? `${w.words} (${w.zone})` : w.words };
}

// ── next times, in the zone the routine runs in ──────────────────────────────────────────────────────
/** The zone a cadence runs in; null for "every N minutes" and "once", which are instants (shown in this Mac's zone). */
export function cadenceZone(c: CadenceWire): string | null {
  return c.kind === "weekly" || c.kind === "cron" ? c.tz : null;
}

const NEXT_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  day: "numeric",
  // the sentence above says "8:00 AM" (12-hour, whatever the locale); the times under it read the same way
  hour12: true,
};

/**
 * One fire time as a person reads it. A routine says "8:00 AM Asia/Calcutta", so its next times are shown in THAT zone
 * (formatting them in the viewer's zone made 08:00 IST read as 7:30 PM, which looked like a wrong schedule). When the
 * viewer's own zone differs, `here` carries the same instant in their zone.
 */
export function formatNextTime(
  ms: number,
  zone: string | null,
  viewerZone: string = localTimeZone(),
  locale?: string,
): { label: string; here: string | null } {
  const tz = zone && isValidTimeZone(zone) ? zone : viewerZone;
  const label = new Date(ms).toLocaleString(locale, { ...NEXT_FORMAT, timeZone: tz });
  const here =
    tz !== viewerZone && utcOffsetMinutes(ms, tz) !== utcOffsetMinutes(ms, viewerZone)
      ? new Date(ms).toLocaleString(locale, { ...NEXT_FORMAT, timeZone: viewerZone })
      : null;
  return { label, here };
}

function utcOffsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    second: "numeric",
    minute: "numeric",
    month: "numeric",
    hourCycle: "h23",
    year: "numeric",
    hour: "numeric",
    day: "numeric",
    timeZone: tz,
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

// ── run presentation ─────────────────────────────────────────────────────────────────────────────────
export interface StatusMeta {
  label: string;
  tone: "live" | "wait" | "good" | "muted" | "bad";
}
export const STATUS_META: Record<RunStatus, StatusMeta> = {
  queued: { label: "Queued", tone: "live" },
  active: { label: "Running", tone: "live" },
  waiting: { label: "Waiting for you", tone: "wait" },
  completed: { label: "Done", tone: "good" },
  missed: { label: "Missed", tone: "muted" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const SOURCE_LABEL: Record<RunSource, string> = {
  schedule: "Scheduled",
  "catch-up": "Catch-up",
  manual: "Run now",
  webhook: "Webhook",
};

export function whenLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now - 86_400_000).toDateString() === d.toDateString();
  if (yesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export function relativeUntil(ms: number | null, now: number): string {
  if (ms === null) return "";
  const delta = ms - now;
  if (delta <= 0) return "due now";
  const min = 60_000;
  if (delta < 90 * min) return `in ${Math.max(1, Math.round(delta / min))} min`;
  if (delta < 36 * 60 * min) return `in ${Math.round(delta / (60 * min))} hr`;
  return `in ${Math.round(delta / (24 * 60 * min))} days`;
}

export function routineState(
  r: RoutineWire,
  now: number,
): { label: string; tone: StatusMeta["tone"] } {
  if (r.live) return STATUS_META[r.live.status];
  if (r.paused)
    return { label: r.createdBy === "template" ? "Suggested" : "Paused", tone: "muted" };
  return {
    label: relativeUntil(r.nextRunAt, now) ? `Next ${relativeUntil(r.nextRunAt, now)}` : "Finished",
    tone: "good",
  };
}

export const RUN_LIMIT_CHOICES = [
  { value: "", label: "No limit" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "180", label: "3 hours" },
] as const;

export function curlExample(url: string, secret: string | null): string {
  return `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${secret ?? "<your-secret>"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"event":"deploy.finished","status":"ok"}'`;
}

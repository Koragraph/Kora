// Schedule math for routines: interval alignment, weekdays at a time, 5-field cron, all in an explicit IANA zone.
// Pure (no clock, no fs): every function takes the instant it reasons about. Calendar rules are evaluated on the calendar,
// never approximated by adding 24h or 30 days: "last day of the month" is `0 9 L * *`, "first Monday" is `0 9 * * 1#1`.
//
// DST policy (documented in docs/bots/ROUTINES.md):
//   - a wall time that does not exist (spring forward, 02:30) runs shifted forward by the gap (03:30), once;
//   - a wall time that happens twice (fall back, 01:30) runs at its first occurrence only;
//   - wildcard-minute/hour crons (`*/15 * * * *`) never fire twice for a repeated hour and skip the missing one.
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, type RoutineCadence } from './types';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// ── time zones ───────────────────────────────────────────────────────────────────────────────────────
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { fmtFor(tz); return true; } catch { return false; }
}

export function systemTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
export function offsetMs(epoch: number, tz: string): number {
  const parts = fmtFor(tz).formatToParts(new Date(epoch));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** Wall-clock parts of an instant in a zone. `day` is days since 1970-01-01 of the zone's calendar date. */
export function wallParts(epoch: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number; day: number } {
  const local = new Date(epoch + offsetMs(epoch, tz));
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth() + 1, d: local.getUTCDate(), h: local.getUTCHours(), mi: local.getUTCMinutes(), dow: local.getUTCDay(), day: Math.floor((epoch + offsetMs(epoch, tz)) / DAY_MS) };
}

interface Civil { y: number; mo: number; d: number; dow: number; last: number }
function civil(day: number): Civil {
  const t = new Date(day * DAY_MS);
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1;
  return { y, mo, d: t.getUTCDate(), dow: t.getUTCDay(), last: new Date(Date.UTC(y, mo, 0)).getUTCDate() };
}

/** Wall time -> instant. Repeated time: the earlier instant. Missing time: shifted forward by the gap. */
export function wallToEpoch(day: number, h: number, mi: number, tz: string): { t: number; gap: boolean } {
  const guess = day * DAY_MS + h * 3_600_000 + mi * MINUTE_MS;
  const offs = new Set([offsetMs(guess - DAY_MS, tz), offsetMs(guess + DAY_MS, tz)]);
  let best: number | null = null;
  for (const o of offs) {
    const t = guess - o;
    if (offsetMs(t, tz) === o && (best === null || t < best)) best = t;
  }
  if (best !== null) return { t: best, gap: false };
  // a gap: neither offset maps back. Use the offset from before the gap (the smaller one) => forward shift.
  return { t: guess - Math.min(...offs), gap: true };
}

// ── cron ─────────────────────────────────────────────────────────────────────────────────────────────
export interface CronSpec {
  minutes: number[];
  hours: number[];
  /** null = `*` */
  dom: Set<number> | null;
  domLast: boolean;
  months: Set<number>;
  /** null = `*` */
  dow: Set<number> | null;
  /** `1#2` (second Monday) and `5L` (last Friday). */
  dowNth: Array<{ dow: number; nth: number }>;
  dowLast: number[];
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function numOf(tok: string, names: string[] | null, base: number): number | null {
  const up = tok.toUpperCase();
  if (names) { const i = names.indexOf(up); if (i >= 0) return i + base; }
  return /^\d{1,2}$/.test(tok) ? Number(tok) : null;
}

/** One field -> its value set, or an error. `null` set = the field was a bare `*`. */
function parseField(src: string, min: number, max: number, names: string[] | null, nameBase: number): { set: Set<number> | null } | { error: string } {
  if (src === '*' || src === '?') return { set: null };
  const out = new Set<number>();
  for (const part of src.split(',')) {
    if (!part) return { error: `empty item in "${src}"` };
    const [range, stepSrc, extra] = part.split('/');
    if (extra !== undefined) return { error: `bad step in "${part}"` };
    let step = 1;
    if (stepSrc !== undefined) {
      if (!/^\d+$/.test(stepSrc) || Number(stepSrc) < 1) return { error: `bad step in "${part}"` };
      step = Number(stepSrc);
    }
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range!.includes('-')) {
      const [a, b, c] = range!.split('-');
      const x = numOf(a ?? '', names, nameBase), y = numOf(b ?? '', names, nameBase);
      if (c !== undefined || x === null || y === null) return { error: `bad range "${range}"` };
      lo = x; hi = y;
    } else {
      const x = numOf(range!, names, nameBase);
      if (x === null) return { error: `bad value "${range}"` };
      lo = x; hi = stepSrc !== undefined ? max : x;
    }
    if (lo < min || hi > max || lo > hi) return { error: `"${part}" is out of range (${min}-${max})` };
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { set: out };
}

export function parseCron(expr: string): CronSpec | { error: string } {
  const f = String(expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return { error: 'A cron rule has 5 fields: minute hour day-of-month month day-of-week' };
  const [mS, hS, domS, monS, dowS] = f as [string, string, string, string, string];
  const m = parseField(mS, 0, 59, null, 0); if ('error' in m) return { error: `minute: ${m.error}` };
  const h = parseField(hS, 0, 23, null, 0); if ('error' in h) return { error: `hour: ${h.error}` };
  let domLast = false;
  let domSrc = domS;
  if (/^L$/i.test(domS)) { domLast = true; domSrc = '*'; }
  const dom = domLast ? { set: new Set<number>() } : parseField(domSrc, 1, 31, null, 0); if ('error' in dom) return { error: `day-of-month: ${dom.error}` };
  const mon = parseField(monS, 1, 12, MONTH_NAMES, 1); if ('error' in mon) return { error: `month: ${mon.error}` };
  // day-of-week: plain list/range/step, plus the Quartz-style `d#n` and `dL`.
  const dowNth: CronSpec['dowNth'] = [], dowLast: number[] = [];
  const plain: string[] = [];
  for (const part of dowS.split(',')) {
    const nth = /^([A-Za-z]{3}|\d)#([1-5])$/.exec(part), last = /^([A-Za-z]{3}|\d)L$/i.exec(part);
    if (nth) { const d = numOf(nth[1]!, DOW_NAMES, 0); if (d === null || d > 7) return { error: `day-of-week: bad value "${part}"` }; dowNth.push({ dow: d % 7, nth: Number(nth[2]) }); }
    else if (last) { const d = numOf(last[1]!, DOW_NAMES, 0); if (d === null || d > 7) return { error: `day-of-week: bad value "${part}"` }; dowLast.push(d % 7); }
    else plain.push(part);
  }
  let dow: Set<number> | null = null;
  if (plain.length) {
    const d = parseField(plain.join(','), 0, 7, DOW_NAMES, 0); if ('error' in d) return { error: `day-of-week: ${d.error}` };
    dow = d.set ? new Set([...d.set].map((v) => v % 7)) : null;
    if (d.set === null && (dowNth.length || dowLast.length)) return { error: 'day-of-week: cannot mix * with # or L' };
  } else if (dowNth.length || dowLast.length) dow = new Set();
  const domRestricted = domLast || dom.set !== null;
  const spec: CronSpec = {
    minutes: [...(m.set ?? range(0, 59))].sort((a, b) => a - b),
    hours: [...(h.set ?? range(0, 23))].sort((a, b) => a - b),
    dom: domLast ? new Set() : dom.set, domLast,
    months: mon.set ?? new Set(range(1, 12)),
    dow, dowNth, dowLast,
  };
  // Feb 30 style rules can never fire: refuse them at save time rather than loop for years.
  if (!domLast && dom.set && !spec.dowNth.length && dow === null) {
    const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (![...spec.months].some((mo) => [...dom.set!].some((d) => d <= maxDays[mo - 1]!))) return { error: 'That date never happens (for example February 30)' };
  }
  void domRestricted;
  return spec;
}
function range(a: number, b: number): number[] { const r: number[] = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function cronDayMatches(s: CronSpec, c: Civil): boolean {
  if (!s.months.has(c.mo)) return false;
  const domRestricted = s.domLast || s.dom !== null;
  const dowRestricted = s.dow !== null;
  const domOk = domRestricted && ((s.dom?.has(c.d) ?? false) || (s.domLast && c.d === c.last));
  let dowOk = false;
  if (dowRestricted) {
    dowOk = s.dow!.has(c.dow)
      || s.dowNth.some((n) => n.dow === c.dow && Math.ceil(c.d / 7) === n.nth)
      || s.dowLast.some((d) => d === c.dow && c.d + 7 > c.last);
  }
  const extended = s.dowNth.length > 0 || s.dowLast.length > 0 || s.domLast;
  if (domRestricted && dowRestricted) return extended ? domOk && dowOk : domOk || dowOk; // classic cron: OR; with L/# both must hold
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

/** The first instant strictly after `after` that the rule fires in `tz`, or null (never, within 9 years). */
export function nextCron(spec: CronSpec, tz: string, after: number): number | null {
  const start = wallParts(after, tz).day;
  for (let i = 0; i < 366 * 9; i++) {
    const day = start + i;
    const c = civil(day);
    if (!cronDayMatches(spec, c)) continue;
    const lo = wallToEpoch(day, 0, 0, tz).t, hi = wallToEpoch(day + 1, 0, 0, tz).t;
    const flat = offsetMs(lo, tz) === offsetMs(hi - 1, tz);
    let best: number | null = null;
    if (flat) {
      const off = offsetMs(lo, tz);
      scan: for (const h of spec.hours) for (const mi of spec.minutes) {
        const t = day * DAY_MS + h * 3_600_000 + mi * MINUTE_MS - off;
        if (t > after) { best = t; break scan; }
      }
    } else {
      // a DST day: resolve every time properly and take the earliest that is after `after`.
      for (const h of spec.hours) for (const mi of spec.minutes) {
        const w = wallToEpoch(day, h, mi, tz);
        if (w.t > after && (best === null || w.t < best)) best = w.t;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

// ── cadences ─────────────────────────────────────────────────────────────────────────────────────────
export function parseTime(time: string): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

/** The shortest gap, in minutes, between two firings of a cron rule (within an hour, and across the hour boundary). */
export function cronMinGapMinutes(s: CronSpec): number {
  const mins = [...new Set(s.minutes)].sort((a, b) => a - b);
  if (!mins.length) return Infinity;
  let gap = Infinity;
  for (let i = 1; i < mins.length; i++) gap = Math.min(gap, mins[i]! - mins[i - 1]!);
  // last minute of one hour -> first minute of the next, when two consecutive hours both fire (23 -> 0 included)
  const hours = new Set(s.hours);
  const consecutive = [...hours].some((h) => hours.has((h + 1) % 24));
  if (consecutive) gap = Math.min(gap, 60 - mins[mins.length - 1]! + mins[0]!);
  return gap;
}

/** null = valid. */
export function validateCadence(c: RoutineCadence): string | null {
  switch (c.kind) {
    case 'interval':
      if (!Number.isInteger(c.everyMinutes) || c.everyMinutes < MIN_INTERVAL_MINUTES || c.everyMinutes > MAX_INTERVAL_MINUTES) return `Every N minutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`;
      if (!Number.isFinite(c.anchor)) return 'An interval needs a start time';
      return null;
    case 'weekly':
      if (!Array.isArray(c.days) || !c.days.length || c.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Pick at least one weekday';
      if (!parseTime(c.time)) return 'Time must look like 09:00';
      return isValidTimeZone(c.tz) ? null : `Unknown time zone "${c.tz}"`;
    case 'cron': {
      if (!isValidTimeZone(c.tz)) return `Unknown time zone "${c.tz}" (a cron rule needs an explicit zone like America/New_York)`;
      const s = parseCron(c.expr);
      if ('error' in s) return s.error;
      // The same floor as Every N minutes: `* * * * *` went around it and fired every minute on any model (pl7 S2-5).
      const gap = cronMinGapMinutes(s);
      return gap < MIN_INTERVAL_MINUTES ? `A custom rule can run at most every ${MIN_INTERVAL_MINUTES} minutes (this one runs ${gap === 1 ? 'every minute' : `every ${gap} minutes`})` : null;
    }
    case 'once':
      return Number.isFinite(c.at) ? null : 'Pick a date and time';
    default:
      return 'Unknown schedule';
  }
}

/** The first occurrence strictly after `after`, or null when there is none (a finished `once`, an impossible rule). */
export function nextOccurrence(c: RoutineCadence, after: number): number | null {
  switch (c.kind) {
    case 'interval': {
      const step = c.everyMinutes * MINUTE_MS;
      return c.anchor + Math.max(1, Math.floor((after - c.anchor) / step) + 1) * step;
    }
    case 'weekly': {
      const tm = parseTime(c.time); if (!tm || !c.days.length) return null;
      const start = wallParts(after, c.tz).day;
      for (let i = 0; i < 9; i++) {
        const day = start + i;
        if (!c.days.includes(civil(day).dow)) continue;
        const { t } = wallToEpoch(day, tm.h, tm.mi, c.tz);
        if (t > after) return t;
      }
      return null;
    }
    case 'cron': {
      const s = parseCron(c.expr);
      return 'error' in s ? null : nextCron(s, c.tz, after);
    }
    case 'once':
      return c.at > after ? c.at : null;
  }
}

/** Occurrences in (from, to]: the last `keep` of them (ascending) and the total counted (capped at 5000). */
export function occurrencesBetween(c: RoutineCadence, from: number, to: number, keep = 20): { recent: number[]; total: number } {
  if (c.kind === 'interval') {
    const step = c.everyMinutes * MINUTE_MS;
    const first = nextOccurrence(c, from);
    if (first === null || first > to) return { recent: [], total: 0 };
    const total = Math.floor((to - first) / step) + 1;
    const n = Math.min(keep, total);
    return { recent: Array.from({ length: n }, (_, i) => first + (total - n + i) * step), total };
  }
  const ring: number[] = [];
  let total = 0, cur = from;
  for (let i = 0; i < 5000; i++) {
    const n = nextOccurrence(c, cur);
    if (n === null || n > to) return { recent: ring, total };
    total++; ring.push(n); if (ring.length > keep) ring.shift();
    cur = n;
  }
  return { recent: ring, total };
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatClock(time: string): string {
  const t = parseTime(time); if (!t) return time;
  return `${t.h % 12 === 0 ? 12 : t.h % 12}:${String(t.mi).padStart(2, '0')} ${t.h >= 12 ? 'PM' : 'AM'}`;
}

export function describeDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  const names = set.map((d) => DAY_SHORT[d]!);
  return names.length === 1 ? `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][set[0]!]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One line for receipts and tool replies. */
export function describeCadence(c: RoutineCadence): string {
  switch (c.kind) {
    case 'interval':
      return c.everyMinutes % 60 === 0 ? (c.everyMinutes === 60 ? 'Every hour' : `Every ${c.everyMinutes / 60} hours`) : `Every ${c.everyMinutes} minutes`;
    case 'weekly': return `${describeDays(c.days)} at ${formatClock(c.time)} (${c.tz})`;
    case 'cron': return `Cron "${c.expr}" (${c.tz})`;
    case 'once': return `Once, ${new Date(c.at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

/** How many clock times a suggestion text names ("Weekdays at 9:00 and 16:00" = 2). */
export function timesIn(text: string): number {
  return [...String(text ?? '').toLowerCase().matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)].length;
}

/** A cadence from a template's suggestion text ("Weekdays at 8:00", "Sundays at 18:00", "Weekdays at 9:00 and 16:00"), or null. */
export function parseCadenceText(text: string, tz = systemTimeZone()): RoutineCadence | null {
  const s = String(text ?? '').trim().toLowerCase();
  // every clock time in the text ("9:00 and 16:00"); "9am" / "5 pm" read as 12-hour
  const times: Array<{ h: number; mi: number }> = [];
  for (const m of s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)) {
    let h = Number(m[1]); const mi = Number(m[2] ?? 0);
    if (m[3] === 'pm' && h < 12) h += 12; if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    times.push({ h, mi });
  }
  if (!times.length) return null;
  const hhmm = (t: { h: number; mi: number }) => `${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}`;
  const names: Array<[RegExp, number]> = [[/sunday/, 0], [/monday/, 1], [/tuesday/, 2], [/wednesday/, 3], [/thursday/, 4], [/friday/, 5], [/saturday/, 6]];
  let days: number[] | null = null;
  if (/weekday/.test(s)) days = [1, 2, 3, 4, 5];
  else if (/weekend/.test(s)) days = [0, 6];
  else if (/daily|every day/.test(s)) days = [0, 1, 2, 3, 4, 5, 6];
  else { const hit = names.filter(([re]) => re.test(s)).map(([, d]) => d); if (hit.length) days = hit; }
  if (!days) return null;
  // several times a day that share their minute are one cron rule ("0 9,16 * * 1-5"): nothing is dropped
  const first = times[0]!;
  if (times.length > 1 && times.every((t) => t.mi === first.mi)) {
    const hours = [...new Set(times.map((t) => t.h))].sort((a, b) => a - b);
    const sorted = [...days].sort((a, b) => a - b);
    const dow = sorted.length === 7 ? '*' : sorted.join(',') === '1,2,3,4,5' ? '1-5' : sorted.join(',');
    return { kind: 'cron', expr: `${first.mi} ${hours.join(',')} * * ${dow}`, tz };
  }
  return { kind: 'weekly', days, time: hhmm(first), tz };
}

export const __test = { DAY_MS };

// Schedule math: interval alignment, weekdays, cron (incl. DST in a non-UTC zone, last day of month, nth weekday).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCadence, nextOccurrence, occurrencesBetween, parseCadenceText, parseCron, validateCadence, wallToEpoch } from './schedule';
import type { RoutineCadence } from './types';

const U = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const cron = (expr: string, tz: string): RoutineCadence => ({ kind: 'cron', expr, tz });

test('interval: aligned to the start time, strictly after, first run one step after the anchor', () => {
  const c: RoutineCadence = { kind: 'interval', everyMinutes: 30, anchor: U(2026, 10, 5, 10, 7) };
  assert.equal(nextOccurrence(c, U(2026, 10, 5, 10, 20)), U(2026, 10, 5, 10, 37));
  assert.equal(nextOccurrence(c, U(2026, 10, 5, 10, 37)), U(2026, 10, 5, 11, 7)); // exactly on a tick -> the next one
  assert.equal(nextOccurrence(c, U(2026, 10, 5, 9, 0)), U(2026, 10, 5, 10, 37)); // before the anchor
  assert.equal(nextOccurrence(c, U(2026, 10, 5, 10, 7)), U(2026, 10, 5, 10, 37));
});

test('interval bounds: 5..1440 minutes', () => {
  const mk = (n: number): RoutineCadence => ({ kind: 'interval', everyMinutes: n, anchor: 0 });
  assert.match(validateCadence(mk(4))!, /between 5 and 1440/);
  assert.match(validateCadence(mk(1441))!, /between 5 and 1440/);
  assert.equal(validateCadence(mk(5)), null);
  assert.equal(validateCadence(mk(1440)), null);
  assert.match(validateCadence(mk(7.5))!, /between/);
});

test('weekdays at a time in a zone: Friday evening -> Monday morning', () => {
  const c: RoutineCadence = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'America/New_York' };
  // Fri 9 Oct 2026 09:00 EDT = 13:00Z; the next run is Mon 12 Oct 08:00 EDT = 12:00Z.
  assert.equal(nextOccurrence(c, U(2026, 10, 9, 13, 0)), U(2026, 10, 12, 12, 0));
  // before 08:00 the same day still counts
  assert.equal(nextOccurrence(c, U(2026, 10, 9, 11, 0)), U(2026, 10, 9, 12, 0));
  // Saturday only
  assert.equal(nextOccurrence({ kind: 'weekly', days: [6], time: '10:30', tz: 'UTC' }, U(2026, 10, 5)), U(2026, 10, 10, 10, 30));
});

test('weekly time keeps its wall-clock hour across the DST change (never drifts by 24h arithmetic)', () => {
  const c: RoutineCadence = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', tz: 'America/New_York' };
  // Sat 7 Mar 09:00 EST = 14:00Z; Sun 8 Mar (clocks spring forward at 02:00) 09:00 EDT = 13:00Z.
  assert.equal(nextOccurrence(c, U(2026, 3, 7, 14, 0)), U(2026, 3, 8, 13, 0));
});

test('cron spring forward (New York 8 Mar 2026): the missing 02:30 runs once, shifted to 03:30', () => {
  const c = cron('30 2 * * *', 'America/New_York');
  assert.equal(nextOccurrence(c, U(2026, 3, 7, 7, 30)), U(2026, 3, 8, 7, 30)); // 03:30 EDT, exactly once
  assert.equal(nextOccurrence(c, U(2026, 3, 8, 7, 30)), U(2026, 3, 9, 6, 30)); // Monday 02:30 EDT as normal
});

test('cron fall back (New York 1 Nov 2026): a repeated 01:30 runs at its first occurrence only', () => {
  const c = cron('30 1 * * *', 'America/New_York');
  assert.equal(nextOccurrence(c, U(2026, 10, 31, 12, 0)), U(2026, 11, 1, 5, 30)); // 01:30 EDT
  assert.equal(nextOccurrence(c, U(2026, 11, 1, 5, 30)), U(2026, 11, 2, 6, 30)); // next day 01:30 EST, not the repeat at 06:30Z on the 1st
});

test('cron */30 across the fall-back day does not run the repeated hour twice', () => {
  const c = cron('*/30 * * * *', 'America/New_York');
  // after 01:30 EDT (05:30Z) the next is 02:00 EST (07:00Z): the repeated 01:xx hour is skipped
  assert.equal(nextOccurrence(c, U(2026, 11, 1, 5, 30)), U(2026, 11, 1, 7, 0));
});

test('cron last day of the month (L) in Los Angeles, incl. a leap February', () => {
  const c = cron('0 9 L * *', 'America/Los_Angeles');
  assert.equal(nextOccurrence(c, U(2026, 2, 10)), U(2026, 2, 28, 17, 0)); // PST
  assert.equal(nextOccurrence(c, U(2026, 2, 28, 17, 0)), U(2026, 3, 31, 16, 0)); // PDT
  assert.equal(nextOccurrence(c, U(2028, 2, 10)), U(2028, 2, 29, 17, 0)); // leap year
  assert.equal(nextOccurrence(c, U(2026, 3, 31, 16, 0)), U(2026, 4, 30, 16, 0));
});

test('cron first Monday (1#1) and last Friday (5L); never approximated by day ranges', () => {
  const first = cron('0 9 * * 1#1', 'UTC');
  assert.equal(nextOccurrence(first, U(2026, 10, 5, 9, 0)), U(2026, 11, 2, 9, 0)); // 5 Oct was the first Monday
  assert.equal(nextOccurrence(first, U(2026, 11, 2, 9, 0)), U(2026, 12, 7, 9, 0));
  const last = cron('0 18 * * 5L', 'UTC');
  assert.equal(nextOccurrence(last, U(2026, 10, 1)), U(2026, 10, 30, 18, 0));
  assert.equal(nextOccurrence(last, U(2026, 10, 30, 18, 0)), U(2026, 11, 27, 18, 0));
});

test('cron classic day-of-month OR day-of-week, ranges, steps, names, lists', () => {
  assert.equal(nextOccurrence(cron('0 0 13 * 5', 'UTC'), U(2026, 10, 5)), U(2026, 10, 9)); // a Friday, before the 13th
  assert.equal(nextOccurrence(cron('15 10 * * MON-FRI', 'UTC'), U(2026, 10, 9, 11, 0)), U(2026, 10, 12, 10, 15));
  assert.equal(nextOccurrence(cron('0 8,20 * JAN,JUL *', 'UTC'), U(2026, 10, 5)), U(2027, 1, 1, 8, 0));
  assert.equal(nextOccurrence(cron('*/20 3 * * 7', 'UTC'), U(2026, 10, 5)), U(2026, 10, 11, 3, 0)); // 7 = Sunday
});

test('cron errors name the problem, and impossible dates are refused', () => {
  for (const [expr, re] of [['* * * *', /5 fields/], ['61 * * * *', /minute/], ['* 25 * * *', /hour/], ['* * 0 * *', /day-of-month/], ['* * * 13 *', /month/], ['* * * * 9', /day-of-week/], ['0 0 30 2 *', /never happens/], ['*/0 * * * *', /step/]] as const) {
    const r = parseCron(expr);
    assert.ok('error' in r && re.test(r.error), `${expr}: ${JSON.stringify(r)}`);
  }
  assert.match(validateCadence(cron('0 9 * * *', 'Mars/Olympus'))!, /time zone/);
  assert.equal(validateCadence(cron('0 9 * * *', 'Europe/Lisbon')), null);
});

test('wallToEpoch: gap shifts forward, repeat picks the earlier instant', () => {
  const day = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  assert.equal(wallToEpoch(day(2026, 3, 8), 2, 30, 'America/New_York').t, U(2026, 3, 8, 7, 30));
  assert.equal(wallToEpoch(day(2026, 3, 8), 2, 30, 'America/New_York').gap, true);
  assert.equal(wallToEpoch(day(2026, 11, 1), 1, 30, 'America/New_York').t, U(2026, 11, 1, 5, 30));
  // London falls back at 02:00 BST -> 01:00 GMT: 01:30 happens twice, first is BST
  assert.equal(wallToEpoch(day(2026, 10, 25), 1, 30, 'Europe/London').t, U(2026, 10, 25, 0, 30));
});

test('occurrencesBetween keeps the most recent and counts all', () => {
  const c: RoutineCadence = { kind: 'interval', everyMinutes: 60, anchor: U(2026, 10, 5) };
  const r = occurrencesBetween(c, U(2026, 10, 5), U(2026, 10, 6), 3);
  assert.equal(r.total, 24);
  assert.deepEqual(r.recent, [U(2026, 10, 5, 22), U(2026, 10, 5, 23), U(2026, 10, 6)]);
  const d = occurrencesBetween({ kind: 'weekly', days: [1, 3], time: '07:00', tz: 'UTC' }, U(2026, 10, 5), U(2026, 10, 20), 10);
  assert.deepEqual(d.recent, [U(2026, 10, 5, 7), U(2026, 10, 7, 7), U(2026, 10, 12, 7), U(2026, 10, 14, 7), U(2026, 10, 19, 7)]);
  assert.equal(d.total, 5);
});

test('once: only while in the future', () => {
  assert.equal(nextOccurrence({ kind: 'once', at: 1000 }, 999), 1000);
  assert.equal(nextOccurrence({ kind: 'once', at: 1000 }, 1000), null);
});

test('words and template text', () => {
  assert.equal(describeCadence({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'UTC' }), 'Weekdays at 8:00 AM (UTC)');
  assert.equal(describeCadence({ kind: 'interval', everyMinutes: 90, anchor: 0 }), 'Every 90 minutes');
  assert.equal(describeCadence({ kind: 'interval', everyMinutes: 120, anchor: 0 }), 'Every 2 hours');
  // two times a day that share their minute are ONE cron rule: the 16:00 is not dropped
  assert.deepEqual(parseCadenceText('Weekdays at 9:00 and 16:00', 'UTC'), { kind: 'cron', expr: '0 9,16 * * 1-5', tz: 'UTC' });
  assert.deepEqual(parseCadenceText('Weekdays at 9:30 and 16:00', 'UTC'), { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:30', tz: 'UTC' }); // different minutes: no exact cron, the first time (the text stays as the suggestion)
  assert.deepEqual(parseCadenceText('Daily at 8am and 6pm', 'UTC'), { kind: 'cron', expr: '0 8,18 * * *', tz: 'UTC' });
  assert.deepEqual(parseCadenceText('Sundays at 18:00', 'UTC'), { kind: 'weekly', days: [0], time: '18:00', tz: 'UTC' });
  assert.equal(parseCadenceText('whenever', 'UTC'), null);
});

test('a custom cron rule obeys the 5-minute floor too (pl7 S2-5)', () => {
  const v = (expr: string) => validateCadence({ kind: 'cron', expr, tz: 'UTC' });
  assert.match(String(v('* * * * *')), /at most every 5 minutes/);
  assert.match(String(v('*/2 * * * *')), /every 2 minutes/);
  assert.match(String(v('0-59 9 * * *')), /every minute/);
  assert.equal(v('*/5 * * * *'), null);
  assert.equal(v('0 9 * * 1-5'), null);
  assert.equal(v('0,30 * * * *'), null);
  assert.match(String(v('59,1 * * * *')), /every 2 minutes/, 'across the hour boundary');
});

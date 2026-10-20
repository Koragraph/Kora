// A schedule means what it says in the zone it names. These are the "08:00 Asia/Calcutta" cases: the next runs are the right
// instants (02:30 UTC), whatever zone this Mac or the viewer is in, across half-hour and quarter-hour zones, the weekend
// skip, and DST in both directions. (A screenshot once showed 7:20 for an 08:00 Calcutta rule and skipped a Monday: the
// engine was right; the scratch page's fake clock and a viewer-zone label were wrong. The UI now prints these instants in the
// routine's own zone, see apps/web routineModel.formatNextTime.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCadence, nextOccurrence, occurrencesBetween, offsetMs, wallParts } from './schedule';
import type { RoutineCadence } from './types';

const U = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const weekdays = (time: string, tz: string): RoutineCadence => ({ kind: 'weekly', days: [1, 2, 3, 4, 5], time, tz });
const next = (c: RoutineCadence, from: number, n: number) => { const out: number[] = []; let cur = from; for (let i = 0; i < n; i++) { const t = nextOccurrence(c, cur); if (t === null) break; out.push(t); cur = t; } return out; };
const iso = (ms: number) => new Date(ms).toISOString();
const wall = (ms: number, tz: string) => { const p = wallParts(ms, tz); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

test('weekdays 08:00 Asia/Calcutta: Fri 9 Oct 2026 -> Mon 12, Tue 13, Wed 14, Thu 15 at 02:30 UTC (+05:30, no DST), Monday included', () => {
  const c = weekdays('08:00', 'Asia/Calcutta');
  const runs = next(c, U(2026, 10, 9, 10, 0), 4); // Friday 15:30 IST: today's 08:00 already passed
  assert.deepEqual(runs.map(iso), ['2026-10-12T02:30:00.000Z', '2026-10-13T02:30:00.000Z', '2026-10-14T02:30:00.000Z', '2026-10-15T02:30:00.000Z']);
  assert.deepEqual(runs.map((t) => wall(t, 'Asia/Calcutta')), ['2026-10-12 08:00', '2026-10-13 08:00', '2026-10-14 08:00', '2026-10-15 08:00']);
  assert.equal(new Date(runs[0]!).getUTCDay(), 1); // the Monday that a wrong preview skipped
});

test('the same instants come out whatever zone the process runs in (the TZ env of the Mac must not leak into a named zone)', () => {
  const c = weekdays('08:00', 'Asia/Calcutta');
  const saved = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata']) {
      process.env.TZ = tz;
      assert.equal(iso(nextOccurrence(c, U(2026, 10, 9, 10, 0))!), '2026-10-12T02:30:00.000Z', `process zone ${tz}`);
    }
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('the user\'s own zone (New York, EDT -04:00 in October) and a non-local one (Tokyo) agree with hand-computed UTC', () => {
  assert.deepEqual(next(weekdays('08:00', 'America/New_York'), U(2026, 10, 9, 13, 0), 2).map(iso), ['2026-10-12T12:00:00.000Z', '2026-10-13T12:00:00.000Z']);
  assert.deepEqual(next(weekdays('08:00', 'Asia/Tokyo'), U(2026, 10, 8, 0, 0), 3).map(iso), ['2026-10-08T23:00:00.000Z', '2026-10-11T23:00:00.000Z', '2026-10-12T23:00:00.000Z']);
  // Tokyo 08:00 on Thu 8 Oct is already Wed 23:00Z, and Fri 9 Oct 08:00 JST is Thu 23:00Z: weekdays are the zone's weekdays, not UTC's
  assert.deepEqual(next(weekdays('08:00', 'Asia/Tokyo'), U(2026, 10, 7, 12, 0), 3).map((t) => wall(t, 'Asia/Tokyo')), ['2026-10-08 08:00', '2026-10-09 08:00', '2026-10-12 08:00']);
});

test('quarter-hour and half-hour zones (Kathmandu +05:45, Adelaide +10:30/+09:30, Lord Howe) land on the wall time', () => {
  for (const tz of ['Asia/Kathmandu', 'Australia/Adelaide', 'Asia/Calcutta', 'America/St_Johns', 'Australia/Lord_Howe']) {
    const runs = next(weekdays('08:15', tz), U(2026, 10, 9, 0, 0), 6);
    assert.equal(runs.length, 6, tz);
    for (const t of runs) assert.match(wall(t, tz), / 08:15$/, tz);
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i]! > runs[i - 1]!, `${tz} ascending`);
  }
});

test('weekday routines never fire on a weekend, and Friday -> Monday is one step', () => {
  const runs = next(weekdays('08:00', 'Asia/Calcutta'), U(2026, 10, 5, 0, 0), 10);
  for (const t of runs) assert.ok(![0, 6].includes(wallParts(t, 'Asia/Calcutta').dow));
  const fri = runs.find((t) => wallParts(t, 'Asia/Calcutta').dow === 5)!;
  assert.equal(wallParts(runs[runs.indexOf(fri) + 1]!, 'Asia/Calcutta').dow, 1);
});

test('DST spring forward, New York 14 Mar 2027: daily 02:30 runs once at 03:30 EDT; 08:00 keeps its wall hour', () => {
  const daily02: RoutineCadence = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '02:30', tz: 'America/New_York' };
  const runs = next(daily02, U(2027, 3, 13, 12, 0), 3);
  assert.deepEqual(runs.map((t) => wall(t, 'America/New_York')), ['2027-03-14 03:30', '2027-03-15 02:30', '2027-03-16 02:30']);
  assert.equal(iso(runs[0]!), '2027-03-14T07:30:00.000Z');
  const eight = next(weekdays('08:00', 'America/New_York'), U(2027, 3, 11, 20, 0), 3); // Thu evening
  assert.deepEqual(eight.map(iso), ['2027-03-12T13:00:00.000Z', '2027-03-15T12:00:00.000Z', '2027-03-16T12:00:00.000Z']); // Fri 12 Mar is still EST (13:00Z); Mon 15 Mar is EDT (12:00Z)
});

test('DST fall back, New York 7 Nov 2027: a repeated 01:30 runs once (first occurrence); the day after is back on the new offset', () => {
  const daily0130: RoutineCadence = { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '01:30', tz: 'America/New_York' };
  const runs = next(daily0130, U(2027, 11, 6, 12, 0), 3);
  assert.equal(iso(runs[0]!), '2027-11-07T05:30:00.000Z'); // 01:30 EDT, the first of the two
  assert.equal(iso(runs[1]!), '2027-11-08T06:30:00.000Z'); // 01:30 EST
  assert.equal(runs.filter((t) => wall(t, 'America/New_York').startsWith('2027-11-07')).length, 1);
});

test('southern hemisphere DST (Sydney spring forward 3 Oct 2027) and a zone that skipped a whole day is not our problem but never loops', () => {
  const c = weekdays('08:00', 'Australia/Sydney');
  const runs = next(c, U(2027, 9, 30, 0, 0), 4);
  assert.deepEqual(runs.map((t) => wall(t, 'Australia/Sydney')), ['2027-10-01 08:00', '2027-10-04 08:00', '2027-10-05 08:00', '2027-10-06 08:00']);
  assert.equal(iso(runs[0]!), '2027-09-30T22:00:00.000Z'); // AEST +10
  assert.equal(iso(runs[1]!), '2027-10-03T21:00:00.000Z'); // AEDT +11 after the change
});

test('cron in Calcutta ("0 8 * * 1-5") is the same schedule as weekly weekdays 08:00', () => {
  const a = next(weekdays('08:00', 'Asia/Calcutta'), U(2026, 10, 9, 10, 0), 5);
  const b = next({ kind: 'cron', expr: '0 8 * * 1-5', tz: 'Asia/Calcutta' }, U(2026, 10, 9, 10, 0), 5);
  assert.deepEqual(b, a);
});

test('occurrencesBetween counts weekday runs in a zone over a week (Mon-Fri = 5)', () => {
  const r = occurrencesBetween(weekdays('08:00', 'Asia/Calcutta'), U(2026, 10, 4, 0, 0), U(2026, 10, 11, 0, 0));
  assert.equal(r.total, 5);
});

test('offsetMs knows half-hour offsets and DST edges', () => {
  assert.equal(offsetMs(U(2026, 10, 9), 'Asia/Calcutta'), 5.5 * 3_600_000);
  assert.equal(offsetMs(U(2026, 10, 9), 'America/New_York'), -4 * 3_600_000);
  assert.equal(offsetMs(U(2026, 11, 9), 'America/New_York'), -5 * 3_600_000);
});

test('describeCadence names the zone and the day set the way the editor does', () => {
  assert.equal(describeCadence(weekdays('08:00', 'Asia/Calcutta')), 'Weekdays at 8:00 AM (Asia/Calcutta)');
  assert.equal(describeCadence({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', tz: 'UTC' }), 'Every day at 8:00 AM (UTC)');
  assert.equal(describeCadence({ kind: 'weekly', days: [0, 6], time: '10:00', tz: 'UTC' }), 'Weekends at 10:00 AM (UTC)');
});

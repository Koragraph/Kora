// Self tools: a blob arming a routine (its own or, as Kora, another's) asks the user first; pausing / editing / deleting its own
// is free (receipt + Undo); another blob's is Kora-only and asks unless Full access; the 6th active routine always asks;
// undo restores, bad input is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, tempHome, type Harness } from './testkit';
tempHome('routines-tools-');

import { routineToolSpecs, cadenceFromArgs, type RoutineToolContext } from './routine-tools';

const U = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

function tools(h: Harness, blobId: string, o: { full?: boolean } = {}) {
  const cards: any[] = [];
  const ctx: RoutineToolContext = { blobId, threadId: `t-${blobId}`, agent: 'claude', cwd: '/x', emitCard: (c) => { cards.push(c); }, fullAccess: () => o.full === true };
  const by = new Map(routineToolSpecs(h.svc, ctx).map((t) => [t.name, t] as const));
  return { cards, call: (name: string, args: Record<string, unknown> = {}) => by.get(name)!.handler(args) };
}
/** Schedule through the tool the way a user-approved flow ends: the call asks, the user's OK applies it. */
async function armed(h: Harness, z: ReturnType<typeof tools>, args: Record<string, unknown>) {
  const r = await z.call('schedule_routine', args);
  if (args.paused === true) return r;
  assert.match(r.text, /needs the user's OK/, 'an agent never arms a routine on its own');
  const card = [...z.cards].reverse().find((c) => c.cardKind === 'routine-confirm');
  const done = h.svc.confirm(card.token, true);
  assert.ok(done.ok && done.value.state === 'confirmed', done.ok ? done.value.result ?? '' : done.message);
  return r;
}
const real = (h: Harness, id: string) => h.svc.list(id).filter((v) => v.createdBy !== 'template');
const BRIEF = { title: 'Morning brief', prompt: 'Summarise the news and my calendar.', days: ['weekdays'], time: '07:30', timezone: 'America/New_York' };

test('the three tools exist', () => {
  const h = harness();
  const t = routineToolSpecs(h.svc, { blobId: h.tibbo.id, threadId: 't', agent: 'claude', cwd: '/x' });
  assert.deepEqual(t.map((x) => x.name), ['list_routines', 'schedule_routine', 'change_routine']);
});

test('a blob scheduling its OWN routine asks first; on the user\'s OK there is one receipt line with Undo', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  const r = await z.call('schedule_routine', BRIEF);
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /needs the user's OK/);
  assert.equal(h.svc.list(h.tibbo.id).filter((v) => v.createdBy === 'self').length, 0, 'nothing armed yet');
  assert.equal(z.cards[0].cardKind, 'routine-confirm');
  const done = h.svc.confirm(z.cards[0].token, true);
  assert.ok(done.ok && done.value.state === 'confirmed');
  const mine = h.svc.list(h.tibbo.id).filter((v) => v.title === 'Morning brief' && v.createdBy === 'self');
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0]!.cadence, { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '07:30', tz: 'America/New_York' });
  assert.equal(mine[0]!.maxRunMinutes, 15, 'a new routine has a run limit by default');
  assert.equal(z.cards[1].cardKind, 'self-change');
  assert.match(z.cards[1].what, /Tibbo scheduled "Morning brief" · Weekdays at 7:30 AM/);
  assert.match(z.cards[1].undoToken, /^undo_rt_/);
  // dismissing arms nothing
  const z2 = tools(h, h.tibbo.id);
  await z2.call('schedule_routine', { ...BRIEF, title: 'Nope' });
  h.svc.confirm(z2.cards[0].token, false);
  assert.ok(!h.svc.list(h.tibbo.id).some((v) => v.title === 'Nope'));
});

test('a blob creating a PAUSED routine of its own needs no OK (nothing runs)', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  const r = await z.call('schedule_routine', { ...BRIEF, title: 'Parked', paused: true });
  assert.ok(!r.isError && !/needs the user/.test(r.text), r.text);
  assert.equal(h.svc.list(h.tibbo.id).find((v) => v.title === 'Parked')!.paused, true);
});

test('undo of a self-created routine deletes it; undo is single-use', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  await armed(h, z, { ...BRIEF, title: 'Temp' });
  const token = z.cards.find((c) => c.cardKind === 'self-change').undoToken as string;
  assert.ok(h.svc.list(h.tibbo.id).some((v) => v.title === 'Temp'));
  assert.equal(await h.svc.undo(token), true);
  assert.ok(!h.svc.list(h.tibbo.id).some((v) => v.title === 'Temp'));
  assert.equal(await h.svc.undo(token), false);
  assert.equal(h.svc.isUndone(token), true);
});

test('undo of a self change (edit, pause, delete) restores the previous routine', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  await armed(h, z, { ...BRIEF, title: 'Keep' });
  const id = h.svc.list(h.tibbo.id).find((v) => v.title === 'Keep')!.id;
  const changes = () => z.cards.filter((c) => c.cardKind === 'self-change');
  const edit = await z.call('change_routine', { routine: id, action: 'update', time: '09:00', days: ['mon'] });
  assert.ok(!edit.isError, edit.text);
  assert.equal((h.svc.get(id)!.cadence as any).time, '09:00');
  assert.equal(await h.svc.undo(changes()[1].undoToken), true);
  assert.equal((h.svc.get(id)!.cadence as any).time, '07:30');

  await z.call('change_routine', { routine: 'Keep', action: 'pause' });
  assert.equal(h.svc.get(id)!.paused, true);
  assert.equal(await h.svc.undo(changes()[2].undoToken), true);
  assert.equal(h.svc.get(id)!.paused, false);

  await z.call('change_routine', { routine: id, action: 'delete' });
  assert.equal(h.svc.get(id), null);
  assert.equal(await h.svc.undo(changes()[3].undoToken), true);
  assert.equal(h.svc.get(id)!.title, 'Keep');
});

test('undoing an edit never resurrects an old webhook secret', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  await armed(h, z, { ...BRIEF, title: 'Hooked' });
  const id = h.svc.list(h.tibbo.id).find((v) => v.title === 'Hooked')!.id;
  const first = h.svc.createTrigger(id, 'ci'); assert.ok(first.ok);
  await z.call('change_routine', { routine: id, action: 'pause' });
  const rotated = h.svc.rotateTrigger(id, first.ok ? first.value.trigger.id : ''); assert.ok(rotated.ok);
  const hashNow = h.svc.get(id)!.triggers[0]!.secretHash;
  await h.svc.undo(z.cards.filter((c) => c.cardKind === 'self-change')[1].undoToken);
  assert.equal(h.svc.get(id)!.triggers[0]!.secretHash, hashNow);
});

test('a non-Kora blob cannot touch another blob\'s routines', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  const r = await z.call('schedule_routine', { ...BRIEF, blob: 'Popo' });
  assert.equal(r.isError, true);
  assert.match(r.text, /only change your own/);
  assert.equal(real(h, h.popo.id).length, 0);
  const l = await z.call('list_routines', { blob: 'Popo' });
  assert.equal(l.isError, true);
});

test('Kora scheduling for another blob asks (a card), and only the user\'s OK applies it', async () => {
  const h = harness();
  const k = tools(h, h.kora.id);
  const r = await k.call('schedule_routine', { ...BRIEF, blob: 'Popo' });
  assert.ok(!r.isError);
  assert.match(r.text, /needs the user's OK/);
  assert.equal(real(h, h.popo.id).length, 0, 'nothing happened yet');
  const card = k.cards[0];
  assert.equal(card.cardKind, 'routine-confirm');
  assert.equal(card.state, 'open');
  const dismissed = h.svc.confirm(card.token, false);
  assert.ok(dismissed.ok && dismissed.value.state === 'dismissed');
  assert.equal(real(h, h.popo.id).length, 0);
  // ask again, accept
  const k2 = tools(h, h.kora.id);
  await k2.call('schedule_routine', { ...BRIEF, blob: 'Popo' });
  const done = h.svc.confirm(k2.cards[0].token, true);
  assert.ok(done.ok && done.value.state === 'confirmed');
  assert.equal(real(h, h.popo.id)[0]!.createdBy, 'kora');
  assert.equal(h.svc.confirm(k2.cards[0].token, true).ok, false, 'a card answers once');
});

test('Kora with Full access changes another blob\'s routine directly, with a receipt', async () => {
  const h = harness();
  const k = tools(h, h.kora.id, { full: true });
  const r = await k.call('schedule_routine', { ...BRIEF, blob: 'Popo' });
  assert.ok(!r.isError);
  assert.equal(real(h, h.popo.id).length, 1);
  assert.match(k.cards[0].what, /Kora scheduled "Morning brief" for Popo/);
});

test('past 5 active routines a blob asks before enabling another (even Kora on Full access); paused ones do not count', async () => {
  const h = harness();
  const z = tools(h, h.kora.id, { full: true });
  for (let i = 0; i < 5; i++) {
    const r = await z.call('schedule_routine', { ...BRIEF, blob: 'Popo', title: `Routine ${i}`, every_minutes: 60 + i, days: undefined });
    assert.ok(!r.isError, r.text);
  }
  assert.equal(h.svc.store.activeCount(h.popo.id), 5);
  const over = await z.call('schedule_routine', { ...BRIEF, blob: 'Popo', title: 'One too many' });
  assert.match(over.text, /already has 5 active routines/);
  assert.equal(h.svc.list(h.popo.id).filter((v) => v.title === 'One too many').length, 0);
  assert.equal(z.cards.at(-1).cardKind, 'routine-confirm');
  // a PAUSED one is fine: it is not active
  const paused = await z.call('schedule_routine', { ...BRIEF, blob: 'Popo', title: 'Parked', paused: true });
  assert.ok(!paused.isError); assert.doesNotMatch(paused.text, /OK/);
  // resuming it would be the 6th active -> asks
  const id = h.svc.list(h.popo.id).find((v) => v.title === 'Parked')!.id;
  const resume = await z.call('change_routine', { routine: id, action: 'resume', blob: 'Popo' });
  assert.match(resume.text, /needs the user's OK/);
  assert.equal(h.svc.get(id)!.paused, true);
});

test('bad input is refused with a reason the model can act on', async () => {
  const h = harness();
  const z = tools(h, h.tibbo.id);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y', every_minutes: 2 })).text, /between 5 and 1440/);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y', cron: '0 9 * * 1', timezone: 'Nope/Zone' })).text, /Unknown time zone/);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y' })).text, /exactly one/i);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y', every_minutes: 10, cron: '* * * * *' })).text, /exactly one/i);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y', days: ['funday'], time: '09:00' })).text, /Unknown day/);
  assert.match((await z.call('schedule_routine', { title: 'x', prompt: 'y', cron: '0 0 30 2 *', timezone: 'UTC' })).text, /never happens/);
  assert.match((await z.call('change_routine', { routine: 'nope', action: 'pause' })).text, /no routine "nope"/);
  assert.equal(z.cards.length, 0);
});

test('list_routines shows ids, timing and state', async () => {
  const h = harness(U(2026, 10, 5));
  const z = tools(h, h.tibbo.id);
  await armed(h, z, { ...BRIEF, title: 'Daily' });
  const l = await z.call('list_routines');
  assert.match(l.text, /rt_[0-9a-f]+ "Daily": Weekdays at 7:30 AM \(America\/New_York\); next 2026-10-05 07:30 America\/New_York/);
  assert.match(l.text, /"Morning brief".*paused/);
});

test('cadenceFromArgs: once_at in a zone, and with an offset', () => {
  const a = cadenceFromArgs({ once_at: '2026-10-12T09:00', timezone: 'America/New_York' });
  assert.deepEqual(a, { kind: 'once', at: U(2026, 10, 12, 13, 0) });
  assert.deepEqual(cadenceFromArgs({ once_at: '2026-10-12T09:00:00Z' }), { kind: 'once', at: U(2026, 10, 12, 9, 0) });
});

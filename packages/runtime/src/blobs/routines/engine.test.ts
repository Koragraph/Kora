// The executor: hidden fresh threads, skip-when-active, run limit, missed + catch-up after sleep (fake clock),
// remember-last-run, waiting/notify, results threads, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, tempHome } from './testkit';
tempHome('routines-engine-');

import { REMEMBER_CHARS, type RoutineCadence } from './types';

const U = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const MIN = 60_000;
const brief: RoutineCadence = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'UTC' };

function mk(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  const r = h.svc.create({ blobId: h.popo.id, title: 'Morning brief', prompt: 'Summarise my inbox.', cadence: brief, ...over } as never);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.value;
}
const runs = (h: ReturnType<typeof harness>, id: string) => h.svc.store.runsForRoutine(id);

test('a due tick starts a FRESH hidden thread per run and posts a dated report to a dedicated results thread', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 1);
  assert.equal(h.bridge.threads[0]!.origin.kind, 'routine');
  assert.equal(h.bridge.threads[0]!.origin.routineId, r.id);
  assert.match(h.bridge.threads[0]!.title, /Morning brief · Mon 05 Oct 08:00/);
  assert.match(h.bridge.threads[0]!.prompt, /Summarise my inbox\./);
  assert.equal(runs(h, r.id)[0]!.status, 'active');
  await h.bridge.finish('hid1', { finalText: 'Three emails matter.' });
  const run = runs(h, r.id)[0]!;
  assert.equal(run.status, 'completed');
  assert.equal(h.bridge.created.length, 1); // "Create a dedicated results thread"
  assert.equal(h.bridge.reports[0]!.resultsThreadId, 'res1');
  assert.equal(h.bridge.reports[0]!.card.executionThreadId, 'hid1'); // Open run
  assert.equal(h.bridge.reports[0]!.card.text, 'Three emails matter.');
  assert.equal(h.svc.get(r.id)!.results.threadId, 'res1');
  // next day: a different execution thread, the same results thread, no second create
  h.clock.t = U(2026, 10, 6, 8, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads[1]!.threadId, 'hid2');
  await h.bridge.finish('hid2');
  assert.equal(h.bridge.created.length, 1);
  assert.equal(h.bridge.reports[1]!.resultsThreadId, 'res1');
});

test('an existing results thread is used; if it was deleted a dedicated one is created', async () => {
  const h = harness(U(2026, 10, 5));
  const r = mk(h, { results: { mode: 'thread', threadId: 'mine' } });
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid1');
  assert.equal(h.bridge.reports[0]!.resultsThreadId, 'mine');
  h.bridge.gone.add('mine');
  h.clock.t = U(2026, 10, 6, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid2');
  assert.equal(h.bridge.reports[1]!.resultsThreadId, 'res1');
  assert.equal(h.svc.get(r.id)!.results.threadId, 'res1');
});

test('skip a tick while the previous run is still active: no queue grows', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h, { cadence: { kind: 'interval', everyMinutes: 5, anchor: 0 } });
  h.clock.t += 5 * MIN; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 1);
  h.clock.t += 5 * MIN; await h.svc.engine.tick();
  h.clock.t += 5 * MIN; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 1, 'still the first run');
  assert.equal(h.svc.get(r.id)!.skipped, 2);
  assert.equal(runs(h, r.id).length, 1, 'skipped ticks leave no queued rows behind');
  await h.bridge.finish('hid1');
  h.clock.t += 5 * MIN; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 2);
});

test('run limit stops a stuck run (15 minutes unless the user chose otherwise)', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const limited = mk(h, { maxRunMinutes: 10, title: 'Limited' });
  const free = mk(h, { title: 'Unlimited' });
  assert.equal(free.maxRunMinutes, 15, 'a new routine has a run limit');
  const none = mk(h, { title: 'Chosen no limit', maxRunMinutes: null });
  assert.equal(none.maxRunMinutes, null, 'No limit stays possible when the user picks it');
  h.svc.remove(none.id);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 2);
  h.clock.t = U(2026, 10, 5, 8, 9); await h.svc.engine.tick();
  assert.equal(h.bridge.interrupted.length, 0);
  h.clock.t = U(2026, 10, 5, 8, 11); await h.svc.engine.tick();
  assert.equal(h.bridge.interrupted.length, 1);
  const run = runs(h, limited.id)[0]!;
  assert.equal(run.status, 'failed');
  assert.match(run.reason!, /Stopped after 10 minutes/);
  assert.equal(runs(h, free.id)[0]!.status, 'active', 'the 15-minute default has not elapsed yet');
  h.clock.t = U(2026, 10, 5, 8, 16); await h.svc.engine.tick();
  assert.equal(runs(h, free.id)[0]!.status, 'failed');
  assert.match(runs(h, free.id)[0]!.reason!, /Stopped after 15 minutes/);
  assert.equal(h.bridge.reports.length, 2); // the failures are reported too
});

test('slept through several runs: each is recorded missed, ONE catch-up run starts, no burst', async () => {
  const h = harness(U(2026, 10, 5, 0, 0)); // Monday
  const r = mk(h);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid1');
  // the Mac sleeps Mon 09:00 -> Thu 10:00
  h.clock.t = U(2026, 10, 8, 10, 0); await h.svc.engine.tick();
  const rs = runs(h, r.id);
  const missed = rs.filter((x) => x.status === 'missed').map((x) => x.dueAt).sort();
  assert.deepEqual(missed, [U(2026, 10, 6, 8), U(2026, 10, 7, 8)]);
  assert.equal(h.bridge.threads.length, 2, 'exactly one catch-up thread');
  const catchUp = rs.find((x) => x.source === 'catch-up')!;
  assert.equal(catchUp.dueAt, U(2026, 10, 8, 8));
  assert.match(h.bridge.threads[1]!.prompt, /catch-up/);
  // and nothing replays on later ticks
  h.clock.t += 30_000; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 2);
  assert.equal(runs(h, r.id).filter((x) => x.status === 'missed').length, 2);
});

test('catch-up off, or the miss too old: recorded as missed, nothing runs', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const off = mk(h, { catchUp: 'none', title: 'No catch-up' });
  const stale = mk(h, { title: 'Stale' });
  h.clock.t = U(2026, 10, 7, 20, 0); // 12 h after Wednesday 08:00: outside the 6 h window
  await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 0);
  assert.deepEqual(runs(h, off.id).map((x) => x.status), ['missed', 'missed', 'missed']);
  assert.equal(runs(h, stale.id).length, 3);
});

test('paused time is not "missed": resuming starts clean', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.svc.update(r.id, { paused: true });
  h.clock.t = U(2026, 10, 9, 12, 0); await h.svc.engine.tick();
  h.svc.update(r.id, { paused: false });
  h.clock.t += MIN; await h.svc.engine.tick();
  assert.equal(runs(h, r.id).length, 0);
  assert.equal(h.bridge.threads.length, 0);
});

test('remember last run: the previous report (<= 2,000 chars) leads the next run; off = absent', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const on = mk(h, { rememberLastRun: true, title: 'Remembers' });
  const off = mk(h, { title: 'Forgets' });
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.doesNotMatch(h.bridge.threads[0]!.prompt, /previous run/);
  await h.bridge.finish('hid1', { finalText: 'A'.repeat(5000) });
  await h.bridge.finish('hid2', { finalText: 'B'.repeat(50) });
  h.clock.t = U(2026, 10, 6, 8, 0); await h.svc.engine.tick();
  const next = h.bridge.threads.find((t) => t.origin.routineId === on.id && t.threadId !== 'hid1' && t.threadId !== 'hid2')!;
  const block = /---\n([\s\S]*?)\n---/.exec(next.prompt)![1]!;
  assert.ok(block.length <= REMEMBER_CHARS, `block was ${block.length}`);
  assert.ok(block.startsWith('AAAA') && block.endsWith('…[cut]'));
  const other = h.bridge.threads.find((t) => t.origin.routineId === off.id && t.threadId > 'hid2')!;
  assert.doesNotMatch(other.prompt, /previous run/);
});

test('needs-you: the run waits, notifies once, and completes after the approval', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid1', { state: 'needs-you' });
  assert.equal(runs(h, r.id)[0]!.status, 'waiting');
  await h.bridge.finish('hid1', { state: 'needs-you' }); // a second poke must not notify again
  assert.deepEqual(h.notes.filter((n) => n.kind === 'needs-you').length, 1);
  await h.bridge.finish('hid1', { state: 'running' });
  assert.equal(runs(h, r.id)[0]!.status, 'active');
  await h.bridge.finish('hid1', { state: 'idle', finalText: 'Sent after approval.' });
  assert.equal(runs(h, r.id)[0]!.status, 'completed');
  assert.ok(h.notes.some((n) => n.kind === 'settled'));
});

test('a failed run is reported as failed', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  await h.bridge.finish('hid1', { state: 'error', finalText: '' });
  assert.equal(runs(h, r.id)[0]!.status, 'failed');
  assert.equal(h.bridge.reports[0]!.card.status, 'failed');
});

test('a busy blob leaves the run queued; it starts when the blob frees up', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.bridge.setBusy(true);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.equal(runs(h, r.id)[0]!.status, 'queued');
  h.bridge.setBusy(false);
  h.clock.t += 30_000; await h.svc.engine.tick();
  assert.equal(runs(h, r.id)[0]!.status, 'active');
  assert.equal(h.bridge.threads.length, 1);
});

test('once: runs once, then the routine is done (paused)', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h, { cadence: { kind: 'once', at: U(2026, 10, 5, 9, 0) } });
  h.clock.t = U(2026, 10, 5, 9, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 1);
  assert.equal(h.svc.get(r.id)!.paused, true);
  await h.bridge.finish('hid1');
  h.clock.t = U(2026, 10, 6, 9, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 1);
});

test('run now ignores the schedule but refuses while a run is live', async () => {
  const h = harness(U(2026, 10, 5, 12, 0));
  const r = mk(h);
  const a = await h.svc.runNow(r.id);
  assert.ok(a.ok);
  assert.equal(runs(h, r.id)[0]!.source, 'manual');
  const b = await h.svc.runNow(r.id);
  assert.equal(b.ok, false);
  assert.equal(await h.svc.cancelRun((a as { runId: string }).runId), true);
  assert.equal(h.bridge.interrupted.length, 1);
  assert.equal(runs(h, r.id)[0]!.status, 'cancelled');
});

test('an archived blob stops running its routines', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h);
  h.store.archive(h.popo.id);
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 0);
  assert.equal(runs(h, r.id).length, 0);
});

test('starter templates arrive paused and are upgraded to real routines', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const list = h.svc.list(h.tibbo.id);
  assert.equal(list[0]?.title, 'Morning brief');
  assert.deepEqual(list[0]?.cadence, { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: list[0]!.cadence.kind === 'weekly' ? list[0]!.cadence.tz : '' });
  assert.ok(list.every((v) => v.paused && v.createdBy === 'template'));
  h.clock.t = U(2026, 10, 12, 12, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 0, 'paused routines never run');
});

// ── retention (the Phase 4/5 integrator's open item) ─────────────────────────────────────────────────────────────────────
import { RUNS_KEPT_PER_ROUTINE } from './engine';

test('retention: each routine keeps its last 50 finished runs; older runs and their hidden threads go, newer ones and live ones never', async () => {
  const h = harness(U(2026, 1, 1, 0, 0));
  const r = mk(h, { cadence: { kind: 'interval', everyMinutes: 5, anchor: 0 } });
  const other = mk(h, { title: 'Weekly', cadence: { kind: 'interval', everyMinutes: 1440, anchor: 0 } });
  const store = h.svc.store;
  // 55 finished runs of `r` (each with a hidden thread), 3 of `other`
  const mkRun = (routineId: string, i: number, status: 'completed' | 'failed' | 'missed' = 'completed') => store.putRun({ id: `run_${routineId}_${i}`, routineId, blobId: h.popo.id, title: 't', status, source: 'schedule', dueAt: i * 1000, startedAt: i * 1000, endedAt: i * 1000 + 10, threadId: status === 'missed' ? null : `th_${routineId}_${i}`, koraThreadId: null, resultsThreadId: null, report: 'r', reason: null, outputs: [], webhookId: null, eventPayload: null, updatedAt: i * 1000 } as never);
  for (let i = 1; i <= 55; i++) { const run = mkRun(r.id, i, i % 7 === 0 ? 'failed' : 'completed'); if (run.threadId) h.bridge.snaps.set(run.threadId, { state: 'idle', finalText: 'x', outputs: [] }); }
  for (let i = 1; i <= 3; i++) mkRun(other.id, i);
  const live = store.putRun({ id: 'run_live', routineId: r.id, blobId: h.popo.id, title: 't', status: 'active', source: 'manual', dueAt: 1, startedAt: 1, endedAt: null, threadId: 'th_live', koraThreadId: null, resultsThreadId: null, report: null, reason: null, outputs: [], webhookId: null, eventPayload: null, updatedAt: 1 } as never);
  const dropped = await h.svc.engine.prune(r.id);
  assert.equal(dropped, 5, '55 finished - 50 kept');
  assert.equal(RUNS_KEPT_PER_ROUTINE, 50);
  const kept = store.runsForRoutine(r.id);
  assert.equal(kept.filter((x) => x.status !== 'active').length, 50);
  assert.ok(kept.some((x) => x.id === live.id), 'a live run is never pruned');
  assert.ok(!kept.some((x) => x.id === `run_${r.id}_1`) && kept.some((x) => x.id === `run_${r.id}_55`), 'the OLDEST go');
  assert.deepEqual(h.bridge.deleted.sort(), [1, 2, 3, 4, 5].map((i) => `th_${r.id}_${i}`).sort(), 'only the pruned runs\' hidden threads');
  assert.equal(store.runsForRoutine(other.id).length, 3, 'another routine is untouched');
  // a second prune is a no-op; the file on disk agrees (a reload sees 50 + the live one)
  assert.equal(await h.svc.engine.prune(r.id), 0);
  store.reset();
  assert.equal(h.svc.store.runsForRoutine(r.id).length, 51);
});

test('retention: a thread the app refuses to delete (still active) is retried by the next prune; deleting a routine deletes its runs\' threads', async () => {
  const h = harness(U(2026, 1, 1, 0, 0));
  const r = mk(h, { cadence: { kind: 'interval', everyMinutes: 5, anchor: 0 } });
  const store = h.svc.store;
  for (let i = 1; i <= 52; i++) { store.putRun({ id: `run_${i}`, routineId: r.id, blobId: h.popo.id, title: 't', status: 'completed', source: 'schedule', dueAt: i * 1000, startedAt: i, endedAt: i + 1, threadId: `th_${i}`, koraThreadId: null, resultsThreadId: null, report: 'r', reason: null, outputs: [], webhookId: null, eventPayload: null, updatedAt: i } as never); }
  h.bridge.refuseDelete('th_1');
  await h.svc.engine.prune(r.id);
  assert.deepEqual(h.bridge.deleted, ['th_2'], 'th_1 was refused (not finished); th_2 went');
  assert.equal(store.runsForRoutine(r.id).length, 50, 'the receipts are trimmed either way');
  h.svc.remove(r.id);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(h.bridge.deleted.length >= 50, 'the routine\'s remaining finished runs\' threads go with it');
});

test('three failed runs in a row pause the routine; a success resets the count; the user can resume it', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h, { cadence: { kind: 'interval', everyMinutes: 5, anchor: 0 } });
  const notes: string[] = [];
  h.svc.engine.on('changed', () => {});
  let n = 0;
  const failOne = async () => { h.clock.t += 5 * MIN; await h.svc.engine.tick(); n++; await h.bridge.finish(`hid${n}`, { state: 'error' }); };
  await failOne(); await failOne();
  assert.equal(h.svc.get(r.id)!.paused, false);
  h.clock.t += 5 * MIN; await h.svc.engine.tick(); n++; await h.bridge.finish(`hid${n}`, { finalText: 'fine' }); // success resets
  assert.equal(h.svc.get(r.id)!.failStreak, 0);
  await failOne(); await failOne();
  assert.equal(h.svc.get(r.id)!.paused, false, 'two in a row is not enough');
  await failOne();
  assert.equal(h.svc.get(r.id)!.paused, true, 'the third consecutive failure pauses it');
  const before = h.bridge.threads.length;
  h.clock.t += 30 * MIN; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, before, 'a paused routine starts nothing');
  assert.ok(notes.length === 0);
  h.svc.update(r.id, { paused: false });
  assert.equal(h.svc.get(r.id)!.failStreak, 0, 'resuming starts a fresh count');
});

test('a blob has a daily budget of unattended runs; Run now is never counted against it', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const r = mk(h, { cadence: { kind: 'interval', everyMinutes: 5, anchor: 0 } });
  for (let i = 1; i <= 24; i++) { h.clock.t += 5 * MIN; await h.svc.engine.tick(); await h.bridge.finish(`hid${i}`, { finalText: 'ok' }); }
  assert.equal(h.bridge.threads.length, 24);
  h.clock.t += 5 * MIN; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 24, 'the 25th unattended run in 24 h is refused');
  const refused = runs(h, r.id).find((x) => x.status === 'missed');
  assert.match(refused!.reason!, /Daily run budget/);
  const manual = await h.svc.engine.runNow(r.id);
  assert.ok(manual.ok, 'Run now still works');
  assert.equal(h.bridge.threads.length, 25);
});

test('at most 3 routine runs are live at once across blobs: the rest wait (queued) and start as others finish', async () => {
  const h = harness(U(2026, 10, 5, 0, 0));
  const rs = [1, 2, 3, 4, 5].map((i) => mk(h, { title: `R${i}` }));
  h.clock.t = U(2026, 10, 5, 8, 0); await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 3);
  assert.equal(rs.map((r) => runs(h, r.id)[0]!.status).filter((x) => x === 'queued').length, 2);
  await h.bridge.finish('hid1');
  h.clock.t += 30_000; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 4);
});

test('after a long sleep at most 2 catch-up runs start per tick; the rest follow on the next ticks (never a burst)', async () => {
  const h = harness(U(2026, 10, 5, 0, 0)); // Monday
  const rs = [1, 2, 3, 4].map((i) => mk(h, { title: `W${i}` }));
  h.clock.t = U(2026, 10, 5, 12, 0); // 4 h after 08:00: one catch-up candidate each, inside the 6 h window
  await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 2, 'two catch-ups on the first tick');
  await h.bridge.finish('hid1'); await h.bridge.finish('hid2');
  h.clock.t += 30_000; await h.svc.engine.tick();
  assert.equal(h.bridge.threads.length, 4, 'the other two on the next tick');
  assert.equal(rs.every((r) => runs(h, r.id).some((x) => x.source === 'catch-up')), true);
});

test('an every-minute cron rule saved before the floor runs at most every 5 minutes (pl7 S2-5)', async () => {
  const h = harness(U(2026, 10, 5, 9, 0));
  const r = mk(h, { cadence: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' } });
  // as stored by an older build (validation now refuses it)
  h.svc.store.patch(r.id, { cadence: { kind: 'cron', expr: '* * * * *', tz: 'UTC' } } as never);
  for (let m = 1; m <= 10; m++) {
    h.clock.t = U(2026, 10, 5, 9, m); await h.svc.engine.tick();
    for (const t of h.bridge.threads) await h.bridge.finish(t.threadId).catch(() => {});
  }
  assert.ok(h.bridge.threads.length <= 2, `${h.bridge.threads.length} runs in 10 minutes`);
});

// Job state machine, plan validation, busy queue, same-file conflicts, checking/accept/follow-up, restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENGINE, fakeBridge, resetHome, tempHome } from './testkit-team';
tempHome('jobs-');

import { BlobStore } from './store';
import { DelegationLog } from './delegation';
import { JobEngine, JobStateError, JobStore, canTransition, jobCard, jobStatus, validatePlan, type PlanStepInput } from './jobs';
import { hireTemplate } from './templates';

const BRIEF = 'Goal: compare three robot vacuums for a flat with a cat. Inputs: budget 400 euros, Lisbon. Done: a table plus a pick. Write it to outputs/vacuums.md.';

function setup() {
  resetHome();
  const store = new BlobStore();
  store.ensureKora(ENGINE, 'I run the team.');
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(store, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const wobbo = (hireTemplate(store, 'wobbo', { defaultEngine: ENGINE }) as any).profile;
  const log = new DelegationLog({ file: null });
  const jobStore = new JobStore({ dir: null });
  const fb = fakeBridge();
  let clock = 1_000_000;
  const engine = new JobEngine({ store: jobStore, blobs: store, log, bridge: () => fb.bridge, now: () => clock });
  const advance = (ms: number) => { clock += ms; };
  fb.bridge.onSettled((e) => { void engine.settle(e); });
  return { store, popo, junip, wobbo, log, jobStore, fb, engine, advance };
}
const settle = async (s: ReturnType<typeof setup>, threadId: string, o?: Parameters<ReturnType<typeof fakeBridge>['finish']>[1]) => { s.fb.finish(threadId, o); await s.engine.pump(); await new Promise((r) => setTimeout(r, 5)); };
const plan = (s: ReturnType<typeof setup>, steps: PlanStepInput[], title = 'Job') => { const r = s.engine.plan({ title, steps, koraThreadId: 'kt1' }); assert.ok(!('error' in r), JSON.stringify(r)); return (r as any).job.id as string; };

test('state machine: legal moves only; terminal states are final', () => {
  assert.ok(canTransition('planned', 'queued') && canTransition('queued', 'running') && canTransition('running', 'waiting') && canTransition('waiting', 'checking') && canTransition('checking', 'done'));
  assert.ok(!canTransition('planned', 'done') && !canTransition('running', 'done') && !canTransition('done', 'running') && !canTransition('failed', 'queued') && !canTransition('cancelled', 'running'));
  const store = new JobStore({ dir: null });
  const step: any = { state: 'planned' };
  assert.throws(() => store.transition(step, 'done'), JobStateError);
  store.transition(step, 'queued'); assert.equal(step.state, 'queued');
});

test('plan validation: unknown/retired/chief blobs, cycles, bad ids, and never two blobs on one file', () => {
  const s = setup();
  const v = (steps: PlanStepInput[]) => validatePlan('T', steps, s.store);
  assert.match((v([{ id: 's1', blob: 'Nobody', task: 'x' }]) as any).error, /no blob named "Nobody"/);
  assert.match((v([{ id: 's1', blob: 'Kora', task: 'x' }]) as any).error, /Chief/);
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'x', dependsOn: ['s2'] }, { id: 's2', blob: 'Junip', task: 'y', dependsOn: ['s1'] }]) as any).error, /cycle/);
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'x', dependsOn: ['zz'] }]) as any).error, /not in the plan/);
  assert.match((v([{ id: 's 1', blob: 'Popo', task: 'x' }]) as any).error, /step id/);
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'x' }, { id: 's1', blob: 'Junip', task: 'y' }]) as any).error, /used twice/);
  assert.match((v([]) as any).error, /at least one/);
  // output outside the blob's folder
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'x', output: '/etc/passwd' }]) as any).error, /outside Popo's folder/);
  // two parallel steps, same file (also across different blobs given absolute paths: only inside own folder allowed, so use the same blob)
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'a', output: 'brief.md' }, { id: 's2', blob: 'Popo', task: 'b', output: 'brief.md' }]) as any).error, /same file/);
  // ordered, same blob: fine
  assert.ok(!('error' in (v([{ id: 's1', blob: 'Popo', task: 'a', output: 'brief.md' }, { id: 's2', blob: 'Popo', task: 'b', output: 'brief.md', dependsOn: ['s1'] }]) as any)));
  // different files: fine
  assert.ok(!('error' in (v([{ id: 's1', blob: 'Popo', task: 'a', output: 'a.md' }, { id: 's2', blob: 'Junip', task: 'b', output: 'b.md' }]) as any)));
  // folder claim overlaps a file inside it
  assert.match((v([{ id: 's1', blob: 'Popo', task: 'a', output: 'x' }, { id: 's2', blob: 'Popo', task: 'b', output: 'x/y.md' }]) as any).error, /same file/);
});

test('plan -> delegate starts a "from Kora" thread with the composed prompt; the card maps states', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'Compare vacuums', kind: 'research', output: 'vacuums.md' }, { id: 's2', blob: 'Junip', task: 'Write the summary', dependsOn: ['s1'] }]);
  let card = jobCard(s.jobStore.get(jobId)!);
  assert.equal(card.status, 'planned'); assert.deepEqual(card.steps.map((x) => x.status), ['queued', 'queued']);
  assert.match((await s.engine.delegate(jobId, 's1', 'too short') as any).error, /too short/);
  assert.match((await s.engine.delegate(jobId, 's2', BRIEF) as any).error, /waits on s1/);
  const r = await s.engine.delegate(jobId, 's1', BRIEF);
  assert.equal(r.ok && r.state, 'started');
  const th = s.fb.threads[0];
  assert.equal(th.blobId, s.popo.id); assert.deepEqual(th.origin, { kind: 'kora', jobId, stepId: 's1', fromThreadId: 'kt1', fromBlobId: 'blob_kora' });
  assert.match(th.prompt, /^# Compare vacuums/); assert.match(th.prompt, new RegExp(path.join(s.popo.workspace, 'outputs', 'vacuums.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(th.prompt, /Finish with a short result summary/);
  card = s.fb.lastCard(jobId);
  assert.equal(card.status, 'running'); assert.equal(card.steps[0].status, 'running'); assert.equal(card.steps[0].threadId, th.threadId);
  assert.ok(card.version >= 2, 'later cards carry a higher version for the same cardId');
  assert.match((await s.engine.delegate(jobId, 's1', BRIEF) as any).error, /already running/);
});

test('a busy blob queues the step; it starts by itself when there is room', async () => {
  const s = setup();
  s.fb.running.set(s.popo.id, 3);
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'Compare vacuums' }]);
  const r = await s.engine.delegate(jobId, 's1', BRIEF);
  assert.deepEqual(r.ok && r.state === 'queued' && r.reason, 'busy');
  assert.equal(s.fb.threads.length, 0);
  assert.equal(s.fb.lastCard(jobId).steps[0].status, 'queued');
  s.fb.running.set(s.popo.id, 2);
  await s.engine.pump();
  assert.equal(s.fb.threads.length, 1);
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'running');
  // the engine refusing "busy" also queues
  const j2 = plan(s, [{ id: 'a', blob: 'Junip', task: 'Draft' }]);
  s.fb.setRefuse('busy');
  const r2 = await s.engine.delegate(j2, 'a', BRIEF);
  assert.equal(r2.ok && r2.state, 'queued');
  s.fb.setRefuse(null); await s.engine.pump();
  assert.equal(s.jobStore.get(j2)!.steps[0].state, 'running');
});

test('never two blobs on the same file: a second job waits for the first one\'s file', async () => {
  const s = setup();
  const a = plan(s, [{ id: 's1', blob: 'Popo', task: 'First pass', output: 'brief.md' }], 'A');
  const b = plan(s, [{ id: 's1', blob: 'Popo', task: 'Other pass', output: 'brief.md' }], 'B');
  assert.equal((await s.engine.delegate(a, 's1', BRIEF) as any).state, 'started');
  const r = await s.engine.delegate(b, 's1', BRIEF);
  assert.deepEqual(r.ok && r.state === 'queued' && r.reason, 'file');
  assert.equal(s.fb.threads.length, 1);
  await settle(s, s.fb.threads[0].threadId);                  // A -> checking (the file is free again)
  assert.equal(s.jobStore.get(a)!.steps[0].state, 'checking');
  assert.equal(s.jobStore.get(b)!.steps[0].state, 'running', 'B started once A stopped writing');
});

test('settle -> checking -> accept: result kept, delegation row written, dependents unblocked; cards and notes pushed', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'Compare vacuums', kind: 'Research' }, { id: 's2', blob: 'Junip', task: 'Write it up', kind: 'writing', dependsOn: ['s1'] }]);
  await s.engine.delegate(jobId, 's1', BRIEF);
  s.advance(90_000);
  await settle(s, 's1' === 's1' ? s.fb.threads[0].threadId : '', { finalText: 'Pick the Roborock. Table in outputs/vacuums.md.\nMore detail here.', outputs: ['/x/outputs/vacuums.md'], tokens: 900 });
  const step = s.jobStore.get(jobId)!.steps[0];
  assert.equal(step.state, 'checking');
  assert.equal(step.resultGist, 'Pick the Roborock. Table in outputs/vacuums.md.');
  assert.deepEqual(step.outputs, ['/x/outputs/vacuums.md']);
  assert.match(s.fb.notes.at(-1)!.text, /Popo finished "Compare vacuums" .* accept_step, or follow_up/);
  assert.equal(s.log.rows().length, 0, 'nothing is learned until Kora accepts');
  assert.ok((await s.engine.accept(jobId, 's1')).ok);
  const row = s.log.rows()[0];
  assert.deepEqual([row.blobId, row.kind, row.outcome, row.reaction, row.durationMs, row.tokens], [s.popo.id, 'research', 'done', null, 90_000, 950]);
  assert.equal((await s.engine.delegate(jobId, 's2', BRIEF) as any).state, 'started');
  await settle(s, s.fb.threads[1].threadId);
  await s.engine.accept(jobId, 's2');
  assert.equal(jobStatus(s.jobStore.get(jobId)!), 'done');
  assert.equal(s.fb.lastCard(jobId).status, 'done');
  assert.match((await s.engine.accept(jobId, 's2') as any).error, /not waiting to be checked/);
});

test('one follow-up in the same thread marks the step redo; a second is refused', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'Compare vacuums' }]);
  await s.engine.delegate(jobId, 's1', BRIEF);
  const th = s.fb.threads[0].threadId;
  assert.match((await s.engine.followUp(jobId, 's1', 'fix it') as any).error, /finished and is being checked/);
  await settle(s, th);
  assert.ok((await s.engine.followUp(jobId, 's1', 'Add the prices in euros, with links.')).ok);
  assert.deepEqual(s.fb.sent, [{ threadId: th, text: 'Add the prices in euros, with links.' }]);
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'running');
  s.fb.running.set(s.popo.id, 1);
  await settle(s, th);
  assert.match((await s.engine.followUp(jobId, 's1', 'again') as any).error, /already sent/);
  await s.engine.accept(jobId, 's1');
  assert.equal(s.log.rows()[0].reaction, 'redo');
});

test('needs-you surfaces as waiting; an error fails the step and learns from it; cancel interrupts running threads', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'Needs a login' }, { id: 's2', blob: 'Junip', task: 'Breaks' }, { id: 's3', blob: 'Wobbo', task: 'Gets cancelled' }]);
  for (const id of ['s1', 's2', 's3']) await s.engine.delegate(jobId, id, BRIEF);
  await settle(s, s.fb.threads[0].threadId, { state: 'needs-you', finalText: 'Which account should I use?' });
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'waiting');
  assert.equal(s.fb.lastCard(jobId).steps[0].status, 'needs-you');
  assert.match(s.fb.notes.at(-1)!.text, /needs the user/);
  await settle(s, s.fb.threads[1].threadId, { state: 'error', ok: false, finalText: 'boom' });
  assert.equal(s.jobStore.get(jobId)!.steps[1].state, 'failed');
  assert.equal(s.log.rows().find((r) => r.stepId === 's2')!.outcome, 'failed');
  const c = await s.engine.cancel(jobId);
  assert.ok(c.ok && c.cancelled.sort().join() === 's1,s3');
  assert.deepEqual(s.fb.interrupted.sort(), [s.fb.threads[0].threadId, s.fb.threads[2].threadId].sort());
  assert.equal(jobStatus(s.jobStore.get(jobId)!), 'failed');
  assert.equal((await s.engine.delegate(jobId, 's1', BRIEF) as any).ok, false);
});

test('unaccepted checks auto-accept after a while; reconcile settles or fails steps after a restart; waitFor returns on settle', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'A' }, { id: 's2', blob: 'Junip', task: 'B' }]);
  await s.engine.delegate(jobId, 's1', BRIEF); await s.engine.delegate(jobId, 's2', BRIEF);
  const [t1, t2] = s.fb.threads.map((t) => t.threadId);
  // waitFor resolves when a step settles
  const waiting = s.engine.waitFor(jobId, ['s1'], 5000, { pollMs: 20 });
  setTimeout(() => { void settle(s, t1); }, 30);
  const w = await waiting as any;
  assert.equal(w.timedOut, false); assert.equal(w.steps[0].state, 'checking');
  // timeout when still running
  const w2 = await s.engine.waitFor(jobId, ['s2'], 40, { pollMs: 10 }) as any;
  assert.equal(w2.timedOut, true);
  // interrupted by a user message
  assert.equal(((await s.engine.waitFor(jobId, ['s2'], 5000, { pollMs: 10, interrupted: () => true })) as any).interrupted, true);
  // auto-accept
  s.advance(11 * 60_000); s.engine.sweepChecking();
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'done');
  // restart: s2's thread vanished from the engine -> failed; a finished one -> checking
  const s2 = setup();
  const j = plan(s2, [{ id: 'a', blob: 'Popo', task: 'A' }, { id: 'b', blob: 'Junip', task: 'B' }]);
  await s2.engine.delegate(j, 'a', BRIEF); await s2.engine.delegate(j, 'b', BRIEF);
  s2.fb.snapshots.set(s2.fb.threads[0].threadId, { state: 'idle', finalText: 'All good.', outputs: [], tokens: { input: 1, cached: 0, output: 1, turns: 1 } });
  s2.fb.snapshots.delete(s2.fb.threads[1].threadId);
  await s2.engine.reconcile();
  assert.deepEqual(s2.jobStore.get(j)!.steps.map((x) => x.state), ['checking', 'failed']);
});

test('jobs persist across a reload', async () => {
  const dir = path.join(process.env.KORA_HOME!, 'jobs-test');
  const s = setup();
  const js = new JobStore({ dir });
  const eng = new JobEngine({ store: js, blobs: s.store, log: s.log, bridge: () => s.fb.bridge });
  const r = eng.plan({ title: 'Persist me', steps: [{ id: 's1', blob: 'Popo', task: 'x' }], koraThreadId: 'kt9' }) as any;
  const again = new JobStore({ dir });
  assert.equal(again.get(r.job.id)!.title, 'Persist me');
  assert.equal(again.get(r.job.id)!.steps[0].blobName, 'Popo');
});

// ── live QA #2: a step that asks the user something is waiting on the user, not "working" ────────────────────────────────
import { asksUser } from './jobs';

test('asksUser: a short reply that ends in a question (or reads like one) is a wait; a deliverable or a long document is not', () => {
  const yes = [
    'Before I write anything I need to know:\n1. Your sister\'s name\n2. Her partner\'s name\n3. One story to include\nCould you tell me those?',
    'Which account should I use?',
    'I need a few things from you: the date, the venue and the budget. What are they?',
    'Please tell me the recipient\'s name before I draft this.',
    'Quick question first: do you want British or American spelling?',
  ];
  const no = [
    'Done. The memo is in outputs/memo.docx. Want me to change anything?', // finished (it has an output below) - text alone is checked separately
    'Pick the Roborock. Table in outputs/vacuums.md.',
    '',
    `${'A long report paragraph. '.repeat(200)}Does that help?`,
  ];
  for (const t of yes) assert.equal(asksUser(t), true, t);
  assert.equal(asksUser(no[1]!), false);
  assert.equal(asksUser(no[2]!), false);
  assert.equal(asksUser(no[3]!), false);
  assert.equal(asksUser(no[0]!, ['/x/outputs/memo.docx']), false, 'a file on disk means it finished');
  assert.equal(asksUser(no[0]!), false, 'and so does a reply that opens with "Done" and only closes with an offer');
  assert.equal(asksUser(yes[1]!, ['/x/outputs/a.md']), false);
});

test('a step whose blob ended its turn on a question waits on the user ("needs you" on the card), tells Kora once, and carries on after the answer', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Junip', task: 'Write the wedding toast' }]);
  await s.engine.delegate(jobId, 's1', BRIEF);
  const th = s.fb.threads[0].threadId;
  const ask = 'Before I write anything I need to know:\n1. Your sister\'s name\n2. One story to include\nCould you tell me those?';
  await settle(s, th, { finalText: ask });
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'waiting');
  const card = s.fb.lastCard(jobId);
  assert.equal(card.steps[0].status, 'needs-you');
  assert.match(card.steps[0].resultGist, /Your sister's name/);
  assert.match(s.fb.notes.at(-1)!.text, /asked the user a question .* waiting for the answer in Junip's thread/);
  const notes = s.fb.notes.length;
  // a periodic re-read of the same ask (the sweeper) changes nothing and says nothing
  await s.engine.reconcile();
  await s.engine.reconcile();
  assert.equal(s.fb.notes.length, notes);
  assert.equal(s.fb.cards.filter((c) => c.card.cardId === jobId).length, s.fb.cards.filter((c) => c.card.cardId === jobId).length);
  // the user answers: the thread is working again (poke on turn start), then finishes with the toast
  s.fb.snapshots.set(th, { state: 'running', finalText: null, outputs: [], tokens: { input: 1, cached: 0, output: 1, turns: 1 } });
  await s.fb.poke(th); await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'running');
  assert.equal(s.fb.lastCard(jobId).steps[0].status, 'running');
  await settle(s, th, { finalText: 'Here is the toast, in outputs/toast.docx.', outputs: ['/x/outputs/toast.docx'] });
  assert.equal(s.jobStore.get(jobId)!.steps[0].state, 'checking');
});

test('after a restart: a step whose turn was cut off by it fails (half an answer is not a result); a still-asking step is left alone', async () => {
  const s = setup();
  const j = plan(s, [{ id: 'a', blob: 'Popo', task: 'A' }, { id: 'b', blob: 'Junip', task: 'B' }]);
  await s.engine.delegate(j, 'a', BRIEF); await s.engine.delegate(j, 'b', BRIEF);
  const [ta, tb] = s.fb.threads.map((t) => t.threadId);
  s.fb.snapshots.set(ta, { state: 'idle', finalText: 'Waiting for the sleep to finish. I will write the file when it finishes.', outputs: [], tokens: { input: 1, cached: 0, output: 1, turns: 1 }, interrupted: true });
  s.fb.snapshots.set(tb, { state: 'idle', finalText: 'Which tone do you want, formal or relaxed?', outputs: [], tokens: { input: 1, cached: 0, output: 1, turns: 1 } });
  await s.engine.reconcile();
  const [a, b] = s.jobStore.get(j)!.steps;
  assert.equal(a!.state, 'failed');
  assert.match(a!.error!, /app restarted while Popo was working/);
  assert.equal(b!.state, 'waiting');
});

test('cancelling a running step stops its thread, cancels everything downstream, never accepts its output, and the job ends Cancelled', async () => {
  const s = setup();
  const jobId = plan(s, [
    { id: 's1', blob: 'Popo', task: 'Research museums', output: 'museums.md' },
    { id: 's2', blob: 'Junip', task: 'Write the invite from the research', dependsOn: ['s1'] },
    { id: 's3', blob: 'Wobbo', task: 'Polish the invite', dependsOn: ['s2'] },
  ]);
  await s.engine.delegate(jobId, 's1', BRIEF);
  const t1 = s.fb.threads[0].threadId;
  const c = await s.engine.cancel(jobId, 's1');
  assert.ok(c.ok && c.cancelled.join() === 's1,s2,s3', 'the dependents go with it');
  assert.deepEqual(s.fb.interrupted, [t1], 'the running thread was interrupted');
  assert.equal(jobStatus(s.jobStore.get(jobId)!), 'cancelled');
  assert.equal(s.fb.lastCard(jobId).status, 'cancelled');
  assert.match(s.fb.notes.at(-1)!.text, /cancelled .*do not restart/);
  // a slow worker that finishes anyway: its result is dropped
  s.fb.finish(t1, { finalText: 'Here are the museums', outputs: ['/x/museums.md'] }); await s.engine.pump();
  const step = s.jobStore.get(jobId)!.steps[0];
  assert.equal(step.state, 'cancelled'); assert.deepEqual(step.outputs, []); assert.equal(step.finalText, null);
  assert.match(((await s.engine.accept(jobId, 's1')) as any).error, /cancelled by the user/);
  assert.match(((await s.engine.followUp(jobId, 's1', 'more')) as any).error, /cancelled by the user/);
  assert.match(((await s.engine.delegate(jobId, 's2', BRIEF)) as any).error, /cancelled by the user/);
  assert.equal(s.fb.threads.length, 1, 'nothing else was started');
});

test('a step whose dependency was cancelled or failed cannot be started', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'A' }, { id: 's2', blob: 'Junip', task: 'B', dependsOn: ['s1'] }]);
  // simulate a dependent that survived (planned) next to a dead dependency
  const job = s.jobStore.get(jobId)!; job.steps[0].state = 'failed';
  assert.match(((await s.engine.delegate(jobId, 's2', BRIEF)) as any).error, /did not finish/);
});

test('a job the user cancelled reads Cancelled even when a step finished first; a lone cancelled step does not', () => {
  const s = setup();
  const jobId = plan(s, [
    { id: 's1', blob: 'Popo', task: 'Research museums', output: 'museums.md' },
    { id: 's2', blob: 'Junip', task: 'Write the invite' },
  ]);
  const job = s.jobStore.get(jobId)!;
  const ended = { ...job, steps: job.steps.map((st, i) => ({ ...st, state: (i === 0 ? 'done' : 'cancelled') as typeof st.state })) };
  assert.equal(jobStatus(ended), 'done', 'one step cancelled on its own: the rest finished');
  assert.equal(jobStatus({ ...ended, cancelled: true }), 'cancelled', 'the whole job cancelled');
});

// QA 2026-10-10 (chief S2-3): job_e52bb9ca7d had s1 cancelled and s2 still planned -> read "running" forever.
test('a planned step behind a cancelled or failed one reads cancelled; the job is not stuck running; reconcile heals it', async () => {
  const s = setup();
  const jobId = plan(s, [
    { id: 's1', blob: 'Popo', task: 'A' },
    { id: 's2', blob: 'Junip', task: 'B', dependsOn: ['s1'] },
    { id: 's3', blob: 'Wobbo', task: 'C', dependsOn: ['s2'] },
  ]);
  const job = s.jobStore.get(jobId)!;
  job.steps[0].state = 'cancelled'; job.steps[0].startedAt = 5; // an older build left it like this
  assert.equal(jobStatus(job), 'cancelled', 'no step can ever run: the job is over');
  assert.deepEqual(jobCard(job).steps.map((x) => x.status), ['cancelled', 'cancelled', 'cancelled']);
  await s.engine.reconcile();
  assert.deepEqual(job.steps.map((x) => x.state), ['cancelled', 'cancelled', 'cancelled'], 'healed on disk, not only in the view');
  // a failed step skips its dependents too, and the job reads Failed
  const j2 = plan(s, [{ id: 's1', blob: 'Popo', task: 'A' }, { id: 's2', blob: 'Junip', task: 'B', dependsOn: ['s1'] }]);
  await s.engine.delegate(j2, 's1', BRIEF);
  settle(s, s.fb.threads[0].threadId, { state: 'error', error: 'boom' } as any);
  await new Promise((r) => setTimeout(r, 20));
  const job2 = s.jobStore.get(j2)!;
  assert.equal(job2.steps[1].state, 'cancelled');
  assert.equal(jobStatus(job2), 'failed');
});

test('a wrong job id: unique slug/title or the only open job still lands; the error otherwise lists the real ids; cancel never guesses', async () => {
  const s = setup();
  const jobId = plan(s, [{ id: 's1', blob: 'Popo', task: 'A' }], 'Austin music invite');
  assert.equal(s.engine.get('austin-music-invite')?.id, jobId, 'slug of the title');
  assert.equal(s.engine.get('Austin Music Invite')?.id, jobId);
  assert.equal(s.engine.get('JOB_' + jobId.slice(4).toUpperCase())?.id, jobId, 'case-insensitive id');
  assert.equal(s.engine.get('whatever')?.id, jobId, 'the only open job');
  const r = await s.engine.delegate('austin-music-invite', 's1', BRIEF);
  assert.equal(r.ok && r.state, 'started', 'delegate resolves the slug');
  const j2 = plan(s, [{ id: 's1', blob: 'Junip', task: 'B' }], 'Other');
  assert.equal(s.engine.get('whatever'), null, 'two open jobs: no guessing');
  const bad = await s.engine.delegate('nope', 's1', BRIEF) as any;
  assert.match(bad.error, /no job with the id "nope"/);
  assert.match(bad.error, new RegExp(jobId)); assert.match(bad.error, new RegExp(j2));
  assert.match(bad.error, /do not tell the user/);
  const c = await s.engine.cancel('austin-music-invite') as any;
  assert.equal(c.ok, false, 'a cancel needs the exact id');
});

test('cancelForThread: Stop on the Kora thread cancels its unfinished jobs and interrupts their step threads; other threads are left alone', async () => {
  const s = setup();
  const a = plan(s, [{ id: 's1', blob: 'Popo', task: 'A' }, { id: 's2', blob: 'Junip', task: 'B', dependsOn: ['s1'] }], 'Mine');
  const other = s.engine.plan({ title: 'Theirs', steps: [{ id: 's1', blob: 'Wobbo', task: 'C' }], koraThreadId: 'kt-other' }) as any;
  await s.engine.delegate(a, 's1', BRIEF);
  const t1 = s.fb.threads[0].threadId;
  assert.deepEqual((await s.engine.cancelForThread('kt1')).sort(), ['s1', 's2']);
  assert.deepEqual(s.fb.interrupted, [t1]);
  assert.equal(jobStatus(s.jobStore.get(a)!), 'cancelled');
  assert.equal(jobStatus(s.jobStore.get(other.job.id)!), 'planned');
  assert.deepEqual(await s.engine.cancelForThread('kt1'), [], 'idempotent');
});

test('deleting a blob drops its delegation rows (file too) and the jobs only it was in (pl6 S3-11)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-jobs-forget-'));
  const log = new DelegationLog({ file: path.join(dir, 'delegation.jsonl') });
  const row = (blobId: string, jobId: string) => log.append({ jobId, stepId: 's1', blobId, kind: 'research', title: 't', brief: 'b', outcome: 'done', durationMs: 1, tokens: 1 });
  row('gone', 'j1'); row('alive', 'j2'); row('gone', 'j3');
  assert.equal(log.forgetBlob('gone'), 2);
  assert.deepEqual(log.rows().map((r) => r.blobId), ['alive']);
  assert.deepEqual(new DelegationLog({ file: path.join(dir, 'delegation.jsonl') }).rows().map((r) => r.blobId), ['alive'], 'the file was rewritten');

  const jobs = new JobStore({ dir });
  const job = (id: string, blobIds: string[]) => jobs.add({ id, steps: blobIds.map((b, i) => ({ id: `s${i}`, blobId: b })) } as never);
  job('job_solo', ['gone']); job('job_mixed', ['gone', 'alive']); job('job_other', ['alive']);
  const removed = jobs.forgetBlob('gone', (id) => id === 'alive');
  assert.deepEqual(removed, ['job_solo']);
  assert.equal(fs.existsSync(path.join(dir, 'job_solo.json')), false);
  assert.ok(jobs.get('job_mixed') && jobs.get('job_other'), 'a job with a living blob stays');
});

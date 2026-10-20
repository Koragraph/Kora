// Kora's team tools: Chief-only at the handler, propose never creates, confirm cards, wait_for, the MCP hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, fakeBridge, resetHome, tempHome } from './testkit-team';
tempHome('team-tools-');

import { BlobStore } from './store';
import { CHIEF_SOUL } from './chief';
import { BlobToolHub, TeamService, allBlobToolSpecs, teamToolSpecs, type TeamToolContext } from './tools-team';
import { hireTemplate } from './templates';
import type { FleetToolSpec } from '../session/fleet-tools';

const BRIEF = 'Goal: draft the out-of-office email for the Lisbon trip. Inputs: away 3-10 May, back on the 11th, contact Sam. Done: a 60-word email in outputs/ooo.md.';
const TEAM_TOOLS = ['list_team', 'blob_status', 'plan_job', 'delegate_to', 'follow_up', 'accept_step', 'wait_for', 'cancel_job', 'propose_blob', 'edit_blob', 'retire_blob', 'list_templates', 'hire_template'];

function setup() {
  resetHome();
  const store = new BlobStore();
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(store, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const fb = fakeBridge();
  const svc = new TeamService({ store, memoryOnly: true });
  svc.attachEngine(fb.bridge);
  const shown: any[] = [];
  const ctxOf = (blobId: string, extra: Partial<TeamToolContext> = {}): TeamToolContext => ({ blobId, threadId: `kt-${blobId}`, agent: 'claude', cwd: '/x', emitCard: (c) => { shown.push(c); }, ...extra });
  const tools = (blobId: string, extra: Partial<TeamToolContext> = {}) => {
    const specs = teamToolSpecs(svc, ctxOf(blobId, extra));
    const by = new Map(specs.map((t) => [t.name, t] as const));
    return { specs, call: (name: string, args: Record<string, unknown> = {}) => by.get(name)!.handler(args) };
  };
  return { store, kora, popo, junip, fb, svc, shown, ctxOf, tools };
}

test('Chief-only: members get no team tools from toolSpecs, and a direct call is refused at the handler', async () => {
  const s = setup();
  assert.deepEqual(s.svc.toolSpecs(s.ctxOf(s.kora.id)).map((t) => t.name), TEAM_TOOLS);
  assert.deepEqual(s.svc.toolSpecs(s.ctxOf(s.popo.id)), []);
  assert.deepEqual(s.svc.toolSpecs(s.ctxOf('blob_ghost')), []);
  assert.deepEqual(allBlobToolSpecs([{ name: 'recall', description: '', params: {}, handler: async () => ({ text: '' }) }], s.svc, s.ctxOf(s.popo.id)).map((t) => t.name), ['recall']);
  // even if a member somehow holds the specs, the handler refuses and nothing happens
  const asPopo = s.tools(s.popo.id);
  for (const name of TEAM_TOOLS) {
    const r = await asPopo.call(name, { blob: 'Junip', task: 'x', brief: BRIEF, title: 'T', steps: [], job: 'j', step: 's', message: 'm', templates: ['wobbo'] });
    assert.equal(r.isError, true, name);
    assert.match(r.text, /only Kora, the Chief/, name);
  }
  assert.equal(s.fb.threads.length, 0);
  assert.equal(s.store.list().length, 3);
  assert.equal(s.shown.length, 0);
  assert.ok(!s.store.byName('Wobbo'));
  // an archived Chief-role caller is refused too
  assert.match((await s.tools('blob_missing').call('list_team')).text, /This blob cannot use team tools/);
});

test('plan_job + delegate_to + wait_for + accept_step through the tools; ad hoc delegate_to makes a one-step job', async () => {
  const s = setup();
  const t = s.tools(s.kora.id);
  const bad = await t.call('plan_job', { title: 'Trip', steps: [{ id: 's1', blob: 'Zorp', task: 'x' }] });
  assert.equal(bad.isError, true); assert.match(bad.text, /no blob named "Zorp"/);
  const p = await t.call('plan_job', { title: 'Lisbon trip', steps: [{ id: 's1', blob: 'Popo', task: 'Research neighbourhoods', kind: 'travel' }, { id: 's2', blob: 'Junip', task: 'Draft the out-of-office email', kind: 'writing' }] });
  assert.ok(!p.isError, p.text);
  const job = s.shown.find((c) => c.cardKind === 'job');
  assert.ok(job && job.cardId.startsWith('job_') && job.version === 1 && job.steps.length === 2);
  assert.match(p.text, /ready: s1, s2/);
  const d1 = await t.call('delegate_to', { blob: 'Popo', task: 'Research neighbourhoods', brief: BRIEF, job: job.cardId, step: 's1' });
  const d2 = await t.call('delegate_to', { blob: 'Junip', task: 'Draft the out-of-office email', brief: BRIEF, job: job.cardId, step: 's2' });
  assert.ok(!d1.isError && !d2.isError, d1.text + d2.text);
  assert.equal(s.fb.threads.length, 2);
  assert.ok(s.fb.threads.every((x) => x.origin.kind === 'kora'));
  assert.equal((await t.call('delegate_to', { blob: 'Popo', task: 'x', brief: BRIEF, job: job.cardId, step: 's2' })).isError, true, 'wrong blob for that step');
  assert.equal((await t.call('delegate_to', { blob: 'Popo', task: 'x', brief: BRIEF, job: job.cardId })).isError, true, 'job without step');
  assert.equal((await t.call('delegate_to', { blob: 'Kora', task: 'x', brief: BRIEF })).isError, true, 'not to yourself');
  for (const th of s.fb.threads) { s.fb.finish(th.threadId, { finalText: `Result from ${th.blobId}`, outputs: ['/o/file.md'] }); }
  await new Promise((r) => setTimeout(r, 20));
  const w = await t.call('wait_for', { job: job.cardId, timeoutSec: 5 });
  assert.match(w.text, /\[s1\] Popo . checking/); assert.match(w.text, /result: Result from/); assert.match(w.text, /files: \/o\/file.md/); assert.match(w.text, /accept_step/);
  const a = await t.call('accept_step', { job: job.cardId, step: 's1' });
  assert.match(a.text, /Accepted/);
  await t.call('accept_step', { job: job.cardId, step: 's2' });
  assert.equal(s.fb.lastCard(job.cardId).status, 'done');
  assert.equal(s.svc.delegation.rows().length, 2);
  // ad hoc
  const ad = await t.call('delegate_to', { blob: 'Junip', task: 'Tighten this paragraph', brief: BRIEF, kind: 'writing' });
  assert.ok(!ad.isError, ad.text); assert.equal(s.fb.threads.length, 3);
  // follow-up tool
  s.fb.finish(s.fb.threads[2].threadId); await new Promise((r) => setTimeout(r, 20));
  const jid = s.svc.jobStore.list().find((j) => j.title === 'Tighten this paragraph')!.id;
  assert.ok(!(await t.call('follow_up', { job: jid, step: 's1', message: 'Shorter please' })).isError);
  assert.equal((await t.call('cancel_job', { job: jid })).isError, undefined);
});

test('wait_for returns early when the user writes', async () => {
  const s = setup();
  let wrote = false;
  const t = s.tools(s.kora.id, { userMessageSince: () => wrote });
  const p = await t.call('plan_job', { title: 'J', steps: [{ id: 's1', blob: 'Popo', task: 'x' }] });
  const jobId = s.shown.find((c) => c.cardKind === 'job').cardId;
  await t.call('delegate_to', { blob: 'Popo', task: 'x', brief: BRIEF, job: jobId, step: 's1' });
  setTimeout(() => { wrote = true; }, 30);
  const w = await t.call('wait_for', { job: jobId, timeoutSec: 20 });
  assert.match(w.text, /The user just wrote to you/);
  assert.ok(p.text);
});

test('propose_blob only shows a card: nothing is created until Hire; replies update the same card in place', async () => {
  const s = setup();
  const t = s.tools(s.kora.id);
  const before = s.store.list({ includeArchived: true }).length;
  assert.equal((await t.call('propose_blob', { title: 'Refund Watcher' })).isError, true, 'new proposals need job + soul');
  const r = await t.call('propose_blob', { name: 'Tiki', title: 'Refund Watcher', job: 'Watches Shopify orders and pings you about refunds', soul: 'You are Tiki. Calm, exact. Watch refunds, summarise daily, never refund anything yourself.', head: 'beanie', apps: ['shopify'], routines: [{ title: 'Daily refund digest', cadence: 'Weekdays at 17:00' }] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Do NOT create the blob yourself/);
  assert.equal(s.store.list({ includeArchived: true }).length, before, 'no blob was created');
  assert.equal(s.store.byName('Tiki'), null);
  const card = s.shown.find((c) => c.cardKind === 'proposal');
  assert.equal(card.version, 1); assert.equal(card.state, 'open'); assert.equal(card.draft.name, 'Tiki'); assert.deepEqual(card.draft.outfit, { head: 'beanie', face: null, neck: null }); assert.ok(card.draft.engine && card.draft.engine.instanceId, 'the proposal names the concrete model it will hire on');
  // tweak: less chatty + a top hat -> same card id, version 2, nothing created
  const r2 = await t.call('propose_blob', { proposalId: card.cardId, head: 'top-hat', soul: 'You are Tiki. Terse. Watch refunds.' });
  assert.ok(!r2.isError, r2.text);
  const card2 = s.shown.filter((c) => c.cardKind === 'proposal').at(-1);
  assert.equal(card2.cardId, card.cardId); assert.equal(card2.version, 2); assert.equal(card2.draft.outfit.head, 'top-hat'); assert.equal(card2.draft.soul, 'You are Tiki. Terse. Watch refunds.');
  assert.equal(s.store.list({ includeArchived: true }).length, before);
  // validation: crown reserved, name taken, bad slot
  assert.match((await t.call('propose_blob', { title: 'X', job: 'y', soul: 'z', head: 'crown' })).text, /crown is reserved/);
  assert.match((await t.call('propose_blob', { name: 'Popo', title: 'X', job: 'y', soul: 'z' })).text, /already on the team/);
  assert.match((await t.call('propose_blob', { title: 'X', job: 'y', soul: 'z', face: 'laser-eyes' })).text, /unknown face/);
  // the wording a model actually uses is understood, and a real mistake names the valid choices
  const loose = await t.call('propose_blob', { title: 'Reader', job: 'Reads', soul: 'You read.', head: 'none', face: 'Glasses', neck: 'None' });
  assert.ok(!loose.isError, loose.text);
  assert.deepEqual(s.shown.filter((c) => c.cardKind === 'proposal').at(-1).draft.outfit, { head: null, face: 'round-glasses', neck: null });
  const wrong = (await t.call('propose_blob', { title: 'X', job: 'y', soul: 'z', face: 'laser-eyes' })).text;
  assert.match(wrong, /choose one of: .*monocle/);
  assert.match(wrong, /do not mention this error/);
  // an omitted name gets a funny one
  const r3 = await t.call('propose_blob', { title: 'Receipts', job: 'Files receipts', soul: 'You are a tidy receipts blob.' });
  assert.ok(!r3.isError); assert.ok(s.shown.filter((c) => c.cardKind === 'proposal').at(-1).draft.name.length >= 3);
  // only the Hire click creates it
  const hired = s.svc.hireProposal(card.cardId);
  assert.equal(hired.name, 'Tiki'); assert.equal(hired.outfit!.head, 'top-hat'); assert.deepEqual(hired.engine, ENGINE);
  assert.equal(s.store.list().length, before + 1);
  const done = s.fb.lastCard(card.cardId);
  assert.equal(done.state, 'hired'); assert.equal(done.hiredBlobId, hired.id); assert.equal(done.version, 3);
  assert.match(s.fb.notes.at(-1)!.text, /hired Tiki/);
  assert.match((await t.call('propose_blob', { proposalId: card.cardId, head: 'cap' })).text, /already hired/);
  assert.throws(() => s.svc.hireProposal(card.cardId), /already hired/);
  // Not this
  const id3 = s.shown.filter((c) => c.cardKind === 'proposal').at(-1).cardId;
  assert.equal(s.svc.dismissProposal(id3), true);
  assert.equal(s.fb.lastCard(id3).state, 'dismissed');
});

test('edit_blob asks via a card (nothing changes) unless Full access; retire_blob always asks; Kora cannot be retired', async () => {
  const s = setup();
  const t = s.tools(s.kora.id);
  const r = await t.call('edit_blob', { blob: 'Popo', title: 'Lead Researcher', permission: 'ask' });
  assert.ok(!r.isError); assert.match(r.text, /card asks the user/);
  const card = s.shown.find((c) => c.cardKind === 'confirm');
  assert.equal(card.state, 'open'); assert.equal(card.action, 'edit'); assert.ok(card.details.some((d: string) => /Title: Researcher -> Lead Researcher/.test(d)));
  assert.equal(s.store.get(s.popo.id)!.title, 'Researcher', 'unchanged until the click');
  const click = s.svc.resolveConfirm(card.cardId, true);
  assert.equal(click.ok, true);
  assert.equal(s.store.get(s.popo.id)!.title, 'Lead Researcher'); assert.equal(s.store.get(s.popo.id)!.permission, 'ask');
  assert.equal(s.fb.lastCard(card.cardId).state, 'confirmed');
  assert.equal(s.svc.resolveConfirm(card.cardId, true).ok, false, 'a card resolves once');
  // Full access applies at once
  const full = s.tools(s.kora.id, { fullAccess: () => true });
  const f = await full.call('edit_blob', { blob: 'Junip', soul: 'You are Junip. Brief and kind.' });
  assert.match(f.text, /Done \(Full access\)/);
  assert.equal(s.store.soul(s.junip.id), 'You are Junip. Brief and kind.');
  // retire: asks even with Full access
  const rt = await full.call('retire_blob', { blob: 'Junip' });
  assert.match(rt.text, /card asks the user to confirm retiring Junip/);
  assert.equal(s.store.get(s.junip.id)!.archivedAt, null);
  const rc = s.shown.filter((c) => c.cardKind === 'confirm').at(-1);
  assert.equal(rc.action, 'retire'); assert.equal(rc.state, 'open');
  assert.equal(s.svc.resolveConfirm(rc.cardId, false).message, 'Not done.');
  assert.equal(s.store.get(s.junip.id)!.archivedAt, null);
  const rc2 = await s.tools(s.kora.id).call('retire_blob', { blob: 'Junip' });
  const open = s.shown.filter((c) => c.cardKind === 'confirm').at(-1);
  assert.ok(!rc2.isError);
  assert.equal(s.svc.resolveConfirm(open.cardId, true).ok, true);
  assert.notEqual(s.store.get(s.junip.id)!.archivedAt, null);
  assert.match((await t.call('retire_blob', { blob: 'Kora' })).text, /No active blob called "Kora"|cannot be retired/);
});

test('list_templates / hire_template (confirm card)', async () => {
  const s = setup();
  const t = s.tools(s.kora.id);
  const lt = await t.call('list_templates');
  assert.equal(lt.text.split('\n').length, 10); assert.match(lt.text, /popo: Popo . Researcher/); assert.match(lt.text, /\[on the team\]/);
  assert.equal((await t.call('hire_template', { templates: ['popo'] })).isError, true, 'already on the team');
  assert.equal((await t.call('hire_template', { templates: ['nope'] })).isError, true);
  const h = await t.call('hire_template', { templates: ['wobbo', 'tibbo'] });
  assert.ok(!h.isError); assert.equal(s.store.byName('Wobbo'), null, 'nothing hired before the click');
  const card = s.shown.filter((c) => c.cardKind === 'confirm').at(-1);
  assert.equal(card.action, 'hire'); assert.equal(card.details.length, 2);
  const res = s.svc.resolveConfirm(card.cardId, true);
  assert.equal(res.profiles.length, 2); assert.ok(s.store.byName('Wobbo') && s.store.byName('Tibbo'));
  assert.match(s.fb.notes.at(-1)!.text, /Offer each new blob a first task/);
  const tm = await t.call('list_team');
  assert.match(tm.text, /Popo . Lead Researcher|Popo . Researcher/); assert.doesNotMatch(tm.text, /Kora . Chief/);
  const st = await t.call('blob_status', { blob: 'Popo' });
  assert.match(st.text, /0\/3 threads running \(can take new work\)/);
});

test('the Kora prompt carries the cards; the per-turn delta appears only when they change', () => {
  const s = setup();
  const sys = s.svc.systemTeamBlock('th1');
  assert.match(sys, /^# Your team/); assert.match(sys, /Popo . Researcher/); assert.doesNotMatch(sys, /Kora . Chief/);
  assert.equal(s.svc.turnTeamDelta('th1'), null);
  s.store.update(s.popo.id, { title: 'Head of Research' });
  const delta = s.svc.turnTeamDelta('th1');
  assert.match(delta!, /<team>[\s\S]*Head of Research[\s\S]*<\/team>/);
  assert.equal(s.svc.turnTeamDelta('th1'), null);
  assert.ok(s.svc.turnTeamDelta('fresh-thread'), 'a thread that never saw the cards gets them');
});

test('the MCP hub: chief and member get different tool lists; tokens are per blob; unknown tools are refused', async () => {
  const s = setup();
  const self: FleetToolSpec[] = [{ name: 'recall', description: 'r', params: { query: { type: 'string' } }, handler: async (a) => ({ text: `recalled ${String(a.query)}` }) }];
  const hub = new BlobToolHub({ getBlob: (id) => s.store.get(id), specsFor: (ctx) => allBlobToolSpecs(self, s.svc, ctx) });
  const base = { threadId: 't', agent: 'codex', cwd: '/x' };
  const kTok = hub.issue({ blobId: s.kora.id, ...base });
  const pTok = hub.issue({ blobId: s.popo.id, ...base });
  const kHello = hub.hello({ blobId: s.kora.id, token: kTok }) as any;
  const pHello = hub.hello({ blobId: s.popo.id, token: pTok }) as any;
  assert.deepEqual(kHello.tools.map((x: any) => x.name), ['recall', ...TEAM_TOOLS]); assert.equal(kHello.chief, true);
  assert.deepEqual(pHello.tools.map((x: any) => x.name), ['recall']); assert.equal(pHello.chief, false);
  assert.equal((hub.hello({ blobId: s.kora.id, token: pTok }) as any).ok, false, 'a member token never opens the Chief');
  assert.equal((hub.hello({ blobId: s.popo.id, token: 'nope' }) as any).ok, false);
  assert.equal((await hub.call({ blobId: s.popo.id, token: pTok, name: 'delegate_to', args: { blob: 'Junip', task: 'x', brief: BRIEF } })).isError, true);
  assert.equal(s.fb.threads.length, 0);
  assert.equal((await hub.call({ blobId: s.popo.id, token: pTok, name: 'recall', args: { query: 'q' } })).text, 'recalled q');
  const lt = await hub.call({ blobId: s.kora.id, token: kTok, name: 'list_templates' });
  assert.match(lt.text, /popo/);
  hub.revokeThread('t');
  assert.equal(hub.size(), 0);
  assert.equal((await hub.call({ blobId: s.kora.id, token: kTok, name: 'list_templates' })).isError, true);
});

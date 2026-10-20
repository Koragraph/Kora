// Group chats: store, mentions, router, orchestrator. No real model: the one-shot and the member bridge are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, resetHome, tempHome } from '../testkit-team';
const root = tempHome('groups-');

import { BlobStore } from '../store';
import { buildCard } from '../cards';
import { hireTemplate } from '../templates';
import { CHIEF_BLOB_ID } from '../types';
import { GroupStore, GroupStoreError, blobDirectoryOf } from './store';
import { parseMentions } from './mentions';
import { readPick, routeMessage } from './router';
import { GroupOrchestrator, MAX_CHAIN_DEPTH, MemoryTranscript, MAX_TURNS_PER_MESSAGE, type GroupBridge, type MemberTurnRequest } from './orchestrator';
import { buildMemberPrompt, unseenFor } from './context';
import { groupToolSpecs } from './tools';
import type { OneShot } from '../types';

function team() {
  resetHome();
  fs.rmSync(path.join(process.env.KORA_HOME!, 'groups'), { recursive: true, force: true });
  const blobs = new BlobStore();
  blobs.ensureKora(ENGINE, 'I run the team.');
  const popo = (hireTemplate(blobs, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(blobs, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const wobbo = (hireTemplate(blobs, 'wobbo', { defaultEngine: ENGINE }) as any).profile;
  const groups = new GroupStore({ members: blobDirectoryOf(blobs) });
  return { blobs, groups, popo, junip, wobbo };
}
const names = (...p: Array<{ id: string; name: string }>) => p.map((x) => ({ id: x.id, name: x.name }));

// ── store ────────────────────────────────────────────────────────────────────────────────────────
test('a group needs 2+ real members, a lead that is a member, a unique name; Kora leads by default', () => {
  const { groups, popo, junip } = team();
  assert.throws(() => groups.create({ name: 'solo', memberIds: [popo.id] }), (e: any) => e instanceof GroupStoreError && e.code === 'bad-members');
  assert.throws(() => groups.create({ name: 'ghost', memberIds: [popo.id, 'blob_nope'] }), /Not on the team/);
  assert.throws(() => groups.create({ name: 'x', memberIds: [popo.id, junip.id], leadId: CHIEF_BLOB_ID }), /lead must be one of/);
  const g = groups.create({ name: 'Launch Week', memberIds: [popo.id, CHIEF_BLOB_ID, junip.id] });
  assert.equal(g.leadId, CHIEF_BLOB_ID);
  assert.equal(g.rule, 'auto');
  assert.ok(g.workspace.endsWith(path.join('_groups', 'launch-week')) && fs.existsSync(path.join(g.workspace, 'outputs')));
  assert.throws(() => groups.create({ name: 'launch week', memberIds: [popo.id, junip.id] }), (e: any) => e.code === 'name-taken');
  const g2 = groups.create({ name: 'Pair', memberIds: [popo.id, junip.id] });
  assert.equal(g2.leadId, popo.id);
});

test('groups persist, update keeps the lead valid, prune drops retired members, delete goes to the trash', () => {
  const { blobs, groups, popo, junip, wobbo } = team();
  const g = groups.create({ name: 'Trio', memberIds: [popo.id, junip.id, wobbo.id], leadId: junip.id, rule: 'lead', instructions: '  be brief  ' });
  assert.equal(g.instructions, 'be brief');
  const again = new GroupStore({ members: blobDirectoryOf(blobs) });
  assert.equal(again.get(g.id)?.rule, 'lead');
  const upd = groups.update(g.id, { memberIds: [popo.id, wobbo.id] });
  assert.equal(upd.leadId, popo.id, 'removed lead falls back');
  blobs.archive(wobbo.id);
  assert.deepEqual(groups.prune(), [g.id]);
  assert.ok(groups.get(g.id)!.archivedAt != null, 'under two members -> archived, not a one-person chat');
  const g3 = groups.create({ name: 'Other', memberIds: [popo.id, CHIEF_BLOB_ID] });
  const trash = path.join(root, 'trash');
  assert.throws(() => groups.delete(g3.id, 'nope', trash), /Type the group/);
  const { trashed } = groups.delete(g3.id, 'Other', trash);
  assert.equal(trashed.length, 2);
  assert.equal(groups.get(g3.id), null);
  assert.ok(!fs.existsSync(g3.workspace));
});

// ── mentions ─────────────────────────────────────────────────────────────────────────────────────
test('mentions: names, order, dedupe, @all, code spans, emails, longest name, word boundary', () => {
  const m = [{ id: 'a', name: 'Popo' }, { id: 'b', name: 'Junip' }, { id: 'c', name: 'Mr Bean' }, { id: 'd', name: 'Pop' }];
  assert.deepEqual(parseMentions('hey @junip and @Popo, also @junip', m).ids, ['b', 'a']);
  assert.deepEqual(parseMentions('@Popo!', m).ids, ['a']);
  assert.deepEqual(parseMentions('@Pop what', m).ids, ['d']);
  assert.deepEqual(parseMentions('@mr   bean help', m).ids, ['c']);
  assert.deepEqual(parseMentions('mail me at x@popo.com', m).ids, []);
  assert.deepEqual(parseMentions('use `@Popo` in code\n```\n@Junip\n```', m).ids, []);
  assert.deepEqual(parseMentions('@Popos', m).ids, [], 'not a prefix match');
  const all = parseMentions('@all please look', m, { exclude: 'b' });
  assert.equal(all.all, true); assert.deepEqual(all.ids, ['a', 'c', 'd']);
  assert.equal(parseMentions('@everyone', m).all, true);
  assert.equal(parseMentions('no mentions', m).any, false);
});

// ── router ───────────────────────────────────────────────────────────────────────────────────────
const ms = [{ id: 'k', name: 'Kora' }, { id: 'p', name: 'Popo' }, { id: 'q', name: 'Junip' }];
const grp = (rule: 'auto' | 'lead' | 'mention') => ({ memberIds: ['k', 'p', 'q'], leadId: 'k', rule });
const shot = (text: string | null, delay = 0): OneShot => async () => { if (delay) await new Promise((r) => setTimeout(r, delay)); return text == null ? null : { text, model: 'fake-free' }; };

test('router: @mentions always win, whatever the rule; @all is everyone but the author', async () => {
  for (const rule of ['mention', 'lead', 'auto'] as const) {
    const d = await routeMessage({ group: grp(rule), members: ms, text: 'hi @Junip', authorId: 'user', oneShot: shot('{"pick":"Popo"}') });
    assert.deepEqual(d.recipients, ['q']); assert.equal(d.reason, 'mention');
  }
  const two = await routeMessage({ group: grp('lead'), members: ms, text: '@Popo @Junip go', authorId: 'user' });
  assert.deepEqual(two.recipients, ['p', 'q']);
  const all = await routeMessage({ group: grp('mention'), members: ms, text: '@all thoughts?', authorId: 'user' });
  assert.deepEqual(all.recipients, ['k', 'p', 'q']); assert.equal(all.reason, 'all');
  const fromMember = await routeMessage({ group: grp('auto'), members: ms, text: '@all agree?', authorId: 'p' });
  assert.deepEqual(fromMember.recipients, ['k', 'q']);
  const silent = await routeMessage({ group: grp('auto'), members: ms, text: 'done, thanks', authorId: 'p', oneShot: shot('{"pick":"Kora"}') });
  assert.deepEqual(silent.recipients, [], 'a member who mentions nobody starts no chain');
});

test('router: rule mention -> nobody, lead -> the lead', async () => {
  assert.deepEqual((await routeMessage({ group: grp('mention'), members: ms, text: 'anyone?', authorId: 'user' })).recipients, []);
  const l = await routeMessage({ group: { ...grp('lead'), leadId: 'q' }, members: ms, text: 'anyone?', authorId: 'user' });
  assert.deepEqual(l.recipients, ['q']); assert.equal(l.reason, 'lead');
});

test('router auto: the fake one-shot picks one member from the cards; garbage, "none", unknown names and no model all fall back to the lead', async () => {
  const seen: string[] = [];
  const spy: OneShot = async (p) => { seen.push(p); return { text: '```json\n{"pick":"popo"}\n```', model: 'm1' }; };
  const cards = ms.map((m) => buildCard({ id: m.id, name: m.name, title: 'T', engine: ENGINE, permission: 'auto', toolGrants: { apps: { mode: 'none', allow: [] }, mcp: [], computer: { browser: false, vm: false } }, templateId: null } as any, { does: `${m.name} does things` }));
  const d = await routeMessage({ group: grp('auto'), members: ms, text: 'find me 5 competitors', authorId: 'user', oneShot: spy, cards });
  assert.deepEqual(d.recipients, ['p']); assert.equal(d.reason, 'auto'); assert.equal(d.model, 'm1');
  assert.match(seen[0], /Popo · T/); assert.match(seen[0], /find me 5 competitors/);

  const fb = async (text: string | null) => routeMessage({ group: grp('auto'), members: ms, text: 'hmm', authorId: 'user', oneShot: shot(text) });
  for (const [raw, detail] of [['{"pick":"none"}', 'doubt'], ['I think maybe', 'bad-answer'], ['{"pick":"Zed"}', 'bad-answer'], [null, 'no-model']] as const) {
    const r = await fb(raw);
    assert.deepEqual(r.recipients, ['k'], String(raw)); assert.equal(r.reason, 'auto-fallback'); assert.equal(r.detail, detail);
  }
  const noModel = await routeMessage({ group: grp('auto'), members: ms, text: 'x', authorId: 'user', oneShot: null });
  assert.equal(noModel.detail, 'no-model');
});

test('router auto: a clear role match decides instantly with no model call; ambiguity goes to the model', async () => {
  const mk = (m: { id: string; name: string }, title: string, does: string) => buildCard({ id: m.id, name: m.name, title, engine: ENGINE, permission: 'auto', toolGrants: { apps: { mode: 'none', allow: [] }, mcp: [], computer: { browser: false, vm: false } }, templateId: null } as any, { does });
  const cards = [mk(ms[0], 'Chief of staff', 'Coordinates the team'), mk(ms[1], 'Analyst', 'Builds spreadsheets and checks numbers'), mk(ms[2], 'Researcher', 'Finds sources and links')];
  let calls = 0;
  const spy: OneShot = async () => { calls++; return { text: '{"pick":"Kora"}', model: 'm' }; };
  const a = await routeMessage({ group: grp('auto'), members: ms, text: 'make me a spreadsheet of monthly costs', authorId: 'user', oneShot: spy, cards });
  assert.deepEqual(a.recipients, ['p']); assert.equal(a.reason, 'auto'); assert.equal(a.detail, 'keyword'); assert.equal(calls, 0, 'no model call');
  const r = await routeMessage({ group: grp('auto'), members: ms, text: 'research three vegan places and give me the links', authorId: 'user', oneShot: spy, cards });
  assert.deepEqual(r.recipients, ['q']); assert.equal(r.detail, 'keyword'); assert.equal(calls, 0);
  // works with no model at all (the first message of a cold session)
  const cold = await routeMessage({ group: grp('auto'), members: ms, text: 'what do the totals look like in this spreadsheet', authorId: 'user', oneShot: null, cards });
  assert.deepEqual(cold.recipients, ['p']);
  // two roles in one message, no keyword at all, and a mention each fall through to the right place
  const both = await routeMessage({ group: grp('auto'), members: ms, text: 'research competitors and build a spreadsheet of them', authorId: 'user', oneShot: spy, cards });
  assert.equal(both.reason, 'auto'); assert.equal(both.detail, undefined); assert.equal(calls, 1, 'ambiguous: the model decides');
  const none = await routeMessage({ group: grp('auto'), members: ms, text: 'how is everyone doing?', authorId: 'user', oneShot: spy, cards });
  assert.equal(none.detail, undefined); assert.equal(calls, 2);
  const men = await routeMessage({ group: grp('auto'), members: ms, text: '@Junip a spreadsheet please', authorId: 'user', oneShot: spy, cards });
  assert.deepEqual(men.recipients, ['q']); assert.equal(men.reason, 'mention');
});

test('router auto: a slow picker times out in ~budget and the lead answers', async () => {
  const t0 = Date.now();
  const r = await routeMessage({ group: grp('auto'), members: ms, text: 'x', authorId: 'user', oneShot: shot('{"pick":"Popo"}', 500), budgetMs: 40 });
  assert.deepEqual(r.recipients, ['k']); assert.equal(r.detail, 'timeout');
  assert.ok(Date.now() - t0 < 300);
  const thrower: OneShot = async () => { throw new Error('boom'); };
  assert.equal((await routeMessage({ group: grp('auto'), members: ms, text: 'x', authorId: 'user', oneShot: thrower })).reason, 'auto-fallback');
});

test('readPick reads json, fenced json, bare names and doubt', () => {
  assert.equal(readPick('{"pick":"Junip"}', ms), 'q');
  assert.equal(readPick('Popo.', ms), 'p');
  assert.equal(readPick('@kora', ms), 'k');
  assert.equal(readPick('{"pick":"none"}', ms), 'none');
  assert.equal(readPick('', ms), null);
});

// ── orchestrator ─────────────────────────────────────────────────────────────────────────────────
function rig(script: Record<string, (r: MemberTurnRequest) => Promise<string> | string>, o: { memberTimeoutMs?: number; rule?: 'auto' | 'lead' | 'mention'; oneShot?: OneShot } = {}) {
  const t = team();
  const group = t.groups.create({ name: 'Crew', memberIds: [CHIEF_BLOB_ID, t.popo.id, t.junip.id], rule: o.rule ?? 'lead' });
  const calls: MemberTurnRequest[] = [];
  const events: any[] = [];
  const bridge: GroupBridge = {
    async runMemberTurn(req) {
      calls.push(req);
      const f = script[t.blobs.get(req.blobId)!.name];
      if (!f) throw new Error('no script');
      return { text: await f(req) };
    },
  };
  const orch = new GroupOrchestrator({ bridge, members: blobDirectoryOf(t.blobs), titleOf: (id) => t.blobs.get(id)?.title ?? '', onEvent: (e) => events.push(e), ...(o.oneShot ? { oneShot: () => o.oneShot! } : {}), ...(o.memberTimeoutMs ? { memberTimeoutMs: o.memberTimeoutMs } : {}) });
  const transcript = new MemoryTranscript();
  const send = (text: string) => orch.handleUserMessage({ group, threadId: 'th1', transcript, text });
  return { ...t, group, calls, events, orch, transcript, send };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('orchestrator: @Popo @Junip run in PARALLEL, replies land in the shared transcript, the label reads "Popo and Junip"', async () => {
  const r = rig({ Popo: async () => { await sleep(120); return 'Popo here.'; }, Junip: async () => { await sleep(120); return 'Junip here.'; } });
  const t0 = Date.now();
  const res = await r.send('@Popo @Junip thoughts?');
  assert.ok(Date.now() - t0 < 230, 'parallel, not 240ms serial');
  assert.deepEqual(res.replies.map((m) => m.authorName).sort(), ['Junip', 'Popo']);
  const routed = r.events.find((e) => e.type === 'routed');
  assert.equal(routed.label, 'Popo and Junip');
  assert.deepEqual(r.transcript.list()[0].to.length, 2);
  assert.equal(r.calls[0].cwd, r.group.workspace);
  assert.match(r.calls[0].prompt, /Group chat "Crew"/);
});

test('orchestrator: turns of ONE member are serial, even across two user messages', async () => {
  let active = 0, maxActive = 0;
  const r = rig({ Popo: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(40); active--; return 'ok'; } });
  await Promise.all([r.send('@Popo one'), r.send('@Popo two')]);
  assert.equal(maxActive, 1);
  assert.equal(r.calls.length, 2);
});

test('orchestrator: a slow member times out with a note; the others are not blocked and nothing hangs', async () => {
  const r = rig({ Popo: async () => { await sleep(2000); return 'late'; }, Junip: () => 'fast' }, { memberTimeoutMs: 60 });
  const t0 = Date.now();
  const res = await r.send('@all status?');
  assert.ok(Date.now() - t0 < 700);
  assert.deepEqual(res.timedOut, [r.popo.id]);
  assert.ok(res.replies.some((m) => m.authorName === 'Junip'));
  assert.ok(r.transcript.list().some((m) => m.kind === 'note' && /Popo is taking too long/.test(m.text)));
  assert.equal(r.calls.find((c) => c.blobId === r.popo.id)!.signal.aborted, true);
});

test('orchestrator: a failing member is reported, the group carries on', async () => {
  const r = rig({ Popo: () => { throw new Error('engine down'); }, Junip: () => 'fine' });
  const res = await r.send('@Popo @Junip go');
  assert.equal(res.failed[0].blobId, r.popo.id); assert.match(res.failed[0].error, /engine down/);
  assert.equal(res.replies.length, 1);
});

test('orchestrator: a mention hands the floor over (depth+1) and the chain is capped at MAX_CHAIN_DEPTH', async () => {
  // Popo and Junip mention each other forever
  const r = rig({ Popo: () => 'over to @Junip', Junip: () => 'back to @Popo' });
  const res = await r.send('@Popo start');
  assert.equal(res.replies.length, MAX_CHAIN_DEPTH + 1);
  assert.deepEqual(res.replies.map((m) => m.authorName), ['Popo', 'Junip', 'Popo', 'Junip']);
  assert.equal(res.capped, true);
  assert.equal(r.calls[MAX_CHAIN_DEPTH].depth, MAX_CHAIN_DEPTH);
  assert.match(r.calls[MAX_CHAIN_DEPTH].prompt, /Do not @mention anyone/);
  assert.deepEqual(res.replies[MAX_CHAIN_DEPTH].to, [], 'the last reply invites nobody');
  assert.ok(r.events.some((e) => e.type === 'chain-capped' && e.reason === 'depth'));
  assert.ok(r.transcript.list().some((m) => m.kind === 'note'));
});

test('orchestrator: @all inside a chain cannot run away (turn cap)', async () => {
  const r = rig({ Kora: () => '@all again', Popo: () => '@all again', Junip: () => '@all again' });
  const res = await r.send('@all go');
  assert.ok(res.turns <= MAX_TURNS_PER_MESSAGE);
  assert.ok(r.calls.length <= MAX_TURNS_PER_MESSAGE);
  assert.equal(res.capped, true);
});

test('orchestrator: members never delegate - only Kora is told allowDelegation; a mention is just an invitation', async () => {
  const r = rig({ Kora: () => 'Junip, over to you @Junip', Popo: () => 'ok', Junip: () => 'sure' });
  await r.send('@Kora and @Popo');
  const flag = (id: string) => r.calls.filter((c) => c.blobId === id).map((c) => c.allowDelegation);
  assert.deepEqual(flag(CHIEF_BLOB_ID), [true]);
  assert.deepEqual(flag(r.popo.id), [false]);
  assert.deepEqual(flag(r.junip.id), [false]);
  assert.match(r.calls.find((c) => c.blobId === r.popo.id)!.prompt, /only Kora delegates/);
});

test('orchestrator: rule lead / mention / auto drive un-addressed messages', async () => {
  const lead = rig({ Kora: () => 'on it' });
  assert.deepEqual((await lead.send('plan the week')).replies.map((m) => m.authorName), ['Kora']);
  const none = rig({ Kora: () => 'x' }, { rule: 'mention' });
  const nr = await none.send('anyone there?');
  assert.deepEqual(nr.replies, []); assert.equal(nr.decision.reason, 'no-mention');
  const auto = rig({ Junip: () => 'my area' }, { rule: 'auto', oneShot: async () => ({ text: '{"pick":"Junip"}', model: 'f' }) });
  assert.deepEqual((await auto.send('numbers please')).replies.map((m) => m.authorName), ['Junip']);
});

test('context: a member sees only what was said since its last reply', () => {
  const t = new MemoryTranscript();
  t.append({ authorId: 'user', authorName: 'You', text: 'q1', to: [], kind: 'message' });
  t.append({ authorId: 'p', authorName: 'Popo', text: 'a1', to: [], kind: 'message' });
  t.append({ authorId: 'q', authorName: 'Junip', text: 'b1', to: [], kind: 'message' });
  const trig = t.append({ authorId: 'user', authorName: 'You', text: 'q2 @Popo', to: ['p'], kind: 'message' });
  assert.deepEqual(unseenFor('p', t.list(), trig.seq).map((m) => m.text), ['b1']);
  const prompt = buildMemberPrompt({ group: { name: 'G', instructions: 'Be kind', workspace: '/w', leadId: 'k' }, self: { id: 'p', name: 'Popo' }, members: [{ id: 'k', name: 'Kora', title: 'Chief', chief: true }, { id: 'p', name: 'Popo', title: 'R', chief: false }], trigger: trig, transcript: t.list(), depth: 0, maxDepth: 3 });
  assert.match(prompt, /Be kind/); assert.match(prompt, /Since you last spoke:\nJunip: b1/); assert.match(prompt, /You said:\nq2 @Popo/);
});

test('create_group tool: Kora only, resolves names, adds Kora, reports errors', async () => {
  const { blobs, groups, popo, junip } = team();
  const resolveBlob = (ref: string) => blobs.byName(ref) ?? blobs.get(ref);
  const mk = (callerId: string) => groupToolSpecs({ groups, resolveBlob, callerId }).find((s) => s.name === 'create_group')!;
  assert.equal((await mk(popo.id).handler({ name: 'x', members: ['Junip'] })).isError, true);
  const res = await mk(CHIEF_BLOB_ID).handler({ name: 'Launch', members: ['Popo', 'Junip'], rule: 'mention', instructions: 'ship it' });
  assert.ok(!res.isError, res.text);
  const g = groups.byName('Launch')!;
  assert.deepEqual(g.memberIds, [CHIEF_BLOB_ID, popo.id, junip.id]); assert.equal(g.rule, 'mention'); assert.equal(g.leadId, CHIEF_BLOB_ID);
  assert.match((await mk(CHIEF_BLOB_ID).handler({ name: 'Bad', members: ['Nobody'] })).text, /No active blob/);
  const ls = await groupToolSpecs({ groups, resolveBlob, callerId: CHIEF_BLOB_ID }).find((s) => s.name === 'list_groups')!.handler({});
  assert.match(ls.text, /Launch: Kora, Popo, Junip/);
});

test('orchestrator: an empty reply settles the member\'s turn (turn-empty), never leaves a thinking bubble, adds nothing to the transcript', async () => {
  const r = rig({ Popo: () => '   ', Junip: () => 'Ready.' });
  const res = await r.send('@all ready?');
  assert.deepEqual(res.replies.map((m) => m.authorName), ['Junip']);
  const empty = r.events.filter((e) => e.type === 'turn-empty');
  assert.equal(empty.length, 1); assert.equal(empty[0].blobId, r.popo.id);
  // every turn-start has exactly one closing event
  const starts = r.events.filter((e) => e.type === 'turn-start').length;
  const closes = r.events.filter((e) => ['turn-end', 'turn-empty', 'turn-timeout', 'turn-error', 'turn-aborted'].includes(e.type)).length;
  assert.equal(starts, closes);
});

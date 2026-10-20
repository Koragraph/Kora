// Phases 3 and 8 as the daemon wires them: a real BlobRuntimeImpl whose chat-engine bridge can run member turns and answer
// outside-access reads. Groups (rules, hand-overs, stop, create_group), team files (export from the stores, the import plan
// held server-side, safe defaults) and outside access (tokens, tools, revoke, audit) through the same objects the ui-server
// and the socket methods call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, fakeBridge, resetHome, tempHome } from './testkit-team';
tempHome('p38-wiring-');

import { BlobStore } from './store';
import { BlobRuntimeImpl } from './runtime';
import { inlineMemoryHost } from './memory-host';
import { openMemory } from '../memory';
import { CHIEF_SOUL } from './chief';
import { hireTemplate } from './templates';
import { blobHome } from './home';
import { CHIEF_BLOB_ID, type OneShot } from './types';
import { MemoryTranscript } from './groups';
import type { MemberTurnRequest } from './groups';
import type { OutsideEngine } from './outside/host';
import { IMPORT_TOOL_GRANTS } from './teamfile';

function setup(o: { oneShot?: OneShot } = {}) {
  resetHome();
  fs.rmSync(path.join(process.env.KORA_HOME!, 'groups'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem, () => {}), oneShot: o.oneShot ?? (async () => null), koraCmd: 'kora', userSkillDirs: [], webhookPort: 0 });
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(store, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const wobbo = (hireTemplate(store, 'wobbo', { defaultEngine: ENGINE }) as any).profile;
  return { store, rt, kora, popo, junip, wobbo };
}

/** A bridge with the team's methods plus a scriptable member-turn runner and an outside engine. */
function bridgeWith(script: Record<string, (r: MemberTurnRequest) => string | Promise<string>>, store: BlobStore, popoId = 'blob_popo') {
  const team = fakeBridge();
  const calls: MemberTurnRequest[] = [];
  const outsideLog: any[] = [];
  const outside: OutsideEngine = {
    threads: () => [{ id: 't1', blobId: popoId, title: 'Lisbon', status: 'settled', updatedAt: 5, messageCount: 2 }],
    thread: (id) => (id === 't1' ? { id: 't1', blobId: popoId, title: 'Lisbon', status: 'settled', updatedAt: 5, messageCount: 2 } : null),
    rows: () => [{ role: 'user', text: 'hi', at: 1 }, { role: 'assistant', text: 'hello', at: 2 }],
    blobState: () => 'idle',
    search: () => [],
    models: () => [{ model: 'claude-sonnet-5-5', label: 'Sonnet' }, { model: 'claude-haiku-5', label: 'Haiku' }],
    async send(i) { outsideLog.push(i); return { threadId: 't9', blobId: i.blobId ?? 'x' }; },
    async interrupt() { return true; },
    async groupSend(i) { outsideLog.push({ group: i }); return { ok: true }; },
  };
  const bridge: any = {
    ...team.bridge,
    async runMemberTurn(req: MemberTurnRequest) {
      calls.push(req);
      const f = script[store.get(req.blobId)!.name];
      if (!f) throw new Error('no script');
      return { text: await f(req) };
    },
    outside,
  };
  return { bridge, calls, outsideLog };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repliers = (res: { replies: Array<{ authorName: string }> }) => res.replies.map((m) => m.authorName).sort();

// ── groups ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('create_group / list_groups are Kora-only tools and make a real group; a retired member prunes it', async () => {
  const s = setup();
  const kora = new Map(s.rt.toolSpecs({ blobId: s.kora.id, threadId: 'kt', agent: 'claude', cwd: '/x' }).map((t) => [t.name, t] as const));
  assert.ok(kora.has('create_group') && kora.has('list_groups'));
  const popoTools = s.rt.toolSpecs({ blobId: s.popo.id, threadId: 'pt', agent: 'claude', cwd: '/x' }).map((t) => t.name);
  assert.ok(!popoTools.includes('create_group') && !popoTools.includes('list_groups'), 'members never see group tools');
  const made = await kora.get('create_group')!.handler({ name: 'Launch', members: ['Popo', 'Junip'], rule: 'mention', instructions: 'ship it' });
  assert.ok(!made.isError, made.text);
  const g = s.rt.groups.groups.byName('Launch')!;
  assert.deepEqual(g.memberIds, [CHIEF_BLOB_ID, s.popo.id, s.junip.id]);
  assert.match((await kora.get('list_groups')!.handler({})).text, /Launch: Kora, Popo, Junip/);
  // the Kora prompt tells her groups exist
  assert.match(s.rt.systemPrompt({ blobId: CHIEF_BLOB_ID, threadId: 'kt', agent: 'claude' }), /create_group/);
  // retiring a member prunes; under two members the group is archived
  s.store.archive(s.junip.id);
  assert.deepEqual(s.rt.groups.groups.get(g.id)!.memberIds, [CHIEF_BLOB_ID, s.popo.id]);
  s.store.archive(s.popo.id);
  assert.ok(s.rt.groups.groups.get(g.id)!.archivedAt != null);
});

test('who answers: the lead is silent unless addressed, the rule is lead, or auto picked her; @all means every MEMBER', async () => {
  const s = setup({ oneShot: async (p) => ({ text: /numbers/.test(p) ? '{"pick":"Junip"}' : '{"pick":"none"}', model: 'fake' }) });
  const b = bridgeWith({ Kora: () => 'Kora here', Popo: () => 'Popo here', Junip: () => 'Junip here', Wobbo: () => 'Wobbo here' }, s.store);
  s.rt.attachEngine(b.bridge);
  const g = s.rt.groups.groups.create({ name: 'Crew', memberIds: [CHIEF_BLOB_ID, s.popo.id, s.junip.id], rule: 'auto' });
  const send = (text: string, t = new MemoryTranscript()) => s.rt.groups.send({ groupId: g.id, threadId: 'th1', transcript: t, text });

  // 1. @Popo: only Popo, even though Kora leads
  assert.deepEqual(repliers(await send('@Popo what do you think?')), ['Popo']);
  // 2. auto picks Junip: only Junip
  assert.deepEqual(repliers(await send('crunch the numbers')), ['Junip']);
  // 3. auto in doubt -> the lead answers (documented fallback)
  const doubt = await send('hmm what now?');
  assert.deepEqual(repliers(doubt), ['Kora']);
  assert.equal(doubt.decision.reason, 'auto-fallback');
  // 4. @all = every member, the lead included because she IS a member
  assert.deepEqual(repliers(await send('@all status')), ['Junip', 'Kora', 'Popo']);
  // 5. a group WITHOUT Kora: @all never involves her, an unaddressed message goes to the first member (lead)
  const g2 = s.rt.groups.groups.create({ name: 'Trio', memberIds: [s.popo.id, s.junip.id, s.wobbo.id], rule: 'lead' });
  const send2 = (text: string) => s.rt.groups.send({ groupId: g2.id, threadId: 'th2', transcript: new MemoryTranscript(), text });
  assert.deepEqual(repliers(await send2('@all status')), ['Junip', 'Popo', 'Wobbo']);
  assert.deepEqual(repliers(await send2('plan it')), ['Popo']);
  assert.ok(!b.calls.some((c) => c.groupId === g2.id && c.blobId === CHIEF_BLOB_ID));
  // 6. rule mention: nobody unless mentioned
  s.rt.groups.groups.update(g.id, { rule: 'mention' });
  const none = await send('anyone?');
  assert.deepEqual(none.replies, []); assert.equal(none.decision.reason, 'no-mention');
  // 7. mentioning only Popo (not the lead) under the lead rule still goes to Popo alone
  s.rt.groups.groups.update(g.id, { rule: 'lead' });
  assert.deepEqual(repliers(await send('@Popo and only you')), ['Popo']);
  // only Kora is told she may delegate
  assert.ok(b.calls.filter((c) => c.blobId === CHIEF_BLOB_ID).every((c) => c.allowDelegation));
  assert.ok(b.calls.filter((c) => c.blobId !== CHIEF_BLOB_ID).every((c) => !c.allowDelegation));
});

test('timeouts get a note, Stop in one thread ends quietly and never touches another thread', async () => {
  const s = setup();
  const slow = new Promise<string>(() => { /* never answers */ });
  const b = bridgeWith({ Popo: () => slow as unknown as string, Junip: () => 'fast' }, s.store);
  // a fresh runtime with short timeouts
  const rt2 = new BlobRuntimeImpl({ store: s.store, memory: inlineMemoryHost(openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) }), () => {}), oneShot: async () => null, koraCmd: 'kora', userSkillDirs: [], webhookPort: 0 });
  // (GroupsService takes the timeout from its options; build one directly for the short budget)
  const { GroupsService } = await import('./groups');
  const svc = new GroupsService({ store: s.store, oneShot: () => null, cardsOf: () => [], memberTimeoutMs: 80 });
  svc.attach({ runMemberTurn: (r) => b.bridge.runMemberTurn(r) });
  const g = svc.groups.create({ name: 'Slow', memberIds: [s.popo.id, s.junip.id], rule: 'mention' });
  const t = new MemoryTranscript();
  const res = await svc.send({ groupId: g.id, threadId: 'a', transcript: t, text: '@all go' });
  assert.deepEqual(res.timedOut, [s.popo.id]);
  assert.deepEqual(repliers(res), ['Junip']);
  assert.ok(t.list().some((m) => m.kind === 'note' && /Popo is taking too long/.test(m.text)), 'a per-member timeout note');

  // Stop: thread A is stopped while Popo hangs; thread B's Popo turn is untouched
  const svc2 = new GroupsService({ store: s.store, oneShot: () => null, cardsOf: () => [], memberTimeoutMs: 5_000 });
  let aborted: string[] = [];
  svc2.attach({
    runMemberTurn: (r) => new Promise((resolve, reject) => {
      r.signal.addEventListener('abort', () => { aborted.push(r.threadId); reject(new Error('Stopped.')); });
      if (r.threadId === 'B') setTimeout(() => resolve({ text: 'B finished' }), 120);
    }),
  });
  const g2 = svc2.groups.create({ name: 'Stoppable', memberIds: [s.popo.id, s.junip.id], rule: 'mention' });
  const ta = new MemoryTranscript(); const tb = new MemoryTranscript();
  const pa = svc2.send({ groupId: g2.id, threadId: 'A', transcript: ta, text: '@Popo long task' });
  const pb = svc2.send({ groupId: g2.id, threadId: 'B', transcript: tb, text: '@Popo quick' });
  await sleep(30);
  assert.equal(svc2.stop('A'), 1);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.deepEqual(aborted, ['A']);
  assert.deepEqual(ra.replies, []); assert.deepEqual(ra.timedOut, []);
  assert.ok(!ta.list().some((m) => m.kind === 'note' && /too long/.test(m.text)), 'a stop is not a timeout');
  assert.deepEqual(rb.replies.map((m) => m.text), ['B finished']);
  await rt2.close(); svc.dispose(); svc2.dispose();
});

// ── team files ───────────────────────────────────────────────────────────────────────────────────────────────────
test('export reads the stores (no chats, memory, ids, models); import is a server-side plan applied with the safe defaults', () => {
  const s = setup();
  s.store.writeSoul(s.popo.id, 'You are Popo. Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 stays out.');
  const g = s.rt.groups.groups.create({ name: 'Crew', memberIds: [CHIEF_BLOB_ID, s.popo.id, s.junip.id], instructions: 'be brief' });
  const opts = s.rt.teamfile.options();
  assert.deepEqual(opts.blobs.map((b) => b.name).sort(), ['Junip', 'Popo', 'Wobbo']);
  const sel = { blobIds: [s.popo.id, s.junip.id], groupIds: [g.id], chief: true, routines: true, skills: true, name: 'My crew' };
  const report = s.rt.teamfile.preview(sel);
  assert.ok(report.scrubNote && /API key/.test(report.scrubNote), report.scrubNote ?? 'no note');
  const out = s.rt.teamfile.export(sel);
  assert.doesNotMatch(out.markdown, /sk-ant-api03/); assert.doesNotMatch(out.markdown, new RegExp(s.popo.id)); assert.doesNotMatch(out.markdown, /claude-sonnet/);
  assert.match(out.fileName, /my-crew\.kora-team\.md$/);

  // import it back: a plan first, nothing created
  const before = s.store.list({ includeArchived: true }).length;
  const planned = s.rt.teamfile.planFromText(out.markdown.replace(/Popo/g, 'Mimi').replace(/Junip/g, 'Nono'));
  assert.ok(planned.ok, JSON.stringify(planned));
  if (!planned.ok) return;
  assert.equal(s.store.list({ includeArchived: true }).length, before, 'planning creates nothing');
  assert.deepEqual(planned.plan.blobs.map((b) => b.name).sort(), ['Mimi', 'Nono']);
  assert.ok(planned.plan.groups.some((x) => x.members.includes('Kora')), 'a group that names Kora keeps your Kora');
  const done = s.rt.teamfile.apply(planned.plan.planId, { blobs: [], groups: [] }, ENGINE);
  assert.equal(done.errors.length, 0, JSON.stringify(done.errors));
  const mimi = s.store.byName('Mimi')!;
  assert.equal(mimi.permission, 'ask'); assert.deepEqual(mimi.toolGrants, IMPORT_TOOL_GRANTS); assert.equal(mimi.role, 'member');
  assert.equal(s.store.list({ includeArchived: true }).filter((b) => b.role === 'chief').length, 1, 'Kora is never created or replaced');
  assert.equal(done.groups.length, 1);
  // routines travel as words and land PAUSED (the routine service adopts routines.json); none of them can fire
  const sourceRoutines = s.rt.routines.list(s.popo.id);
  assert.ok(sourceRoutines.length > 0, 'the starter has suggested routines to carry');
  const imported = s.rt.routines.list(mimi.id);
  assert.equal(imported.length, sourceRoutines.length);
  assert.ok(imported.every((r) => r.paused === true), 'imported routines are paused');
  const skillsDir = path.join(blobHome(mimi.id), 'skills');
  assert.deepEqual(fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [], [], 'nothing is copied into skills/: skills are suggestions only');
  assert.throws(() => s.rt.teamfile.apply(planned.plan.planId, { blobs: [], groups: [] }, ENGINE), /expired|review it/, 'a plan is one use');
  // a plan the client never saw does not exist
  assert.throws(() => s.rt.teamfile.apply('plan_nope', { blobs: [], groups: [] }, ENGINE));
});

test('import: skips are by name, hostile text is refused, an expired plan is gone', () => {
  const s = setup();
  const md = '---\nkora_team: 1\nname: T\nblobs:\n  - name: Zed\n    title: Helper\n    soul: be nice\n  - name: Yan\n    title: Helper\n    soul: be nice\n---\n# body';
  const p = s.rt.teamfile.planFromText(md);
  assert.ok(p.ok); if (!p.ok) return;
  const r = s.rt.teamfile.apply(p.plan.planId, { blobs: ['Yan'], groups: [] }, ENGINE);
  assert.deepEqual(r.blobs.map((b) => b.name), ['Zed']);
  const bad = s.rt.teamfile.planFromText('not a team file');
  assert.equal(bad.ok, false);
  const p2 = s.rt.teamfile.planFromText(md.replace(/Zed/g, 'Zoe').replace(/Yan/g, 'Yin'));
  assert.ok(p2.ok); if (!p2.ok) return;
  let now = Date.now();
  const tf = new (s.rt.teamfile.constructor as any)({ store: s.store, groups: s.rt.groups.groups, skillsOf: () => [], routinesOf: () => [], now: () => now });
  const p3 = tf.planFromText(md.replace(/Zed/g, 'Xan').replace(/Yan/g, 'Xin'));
  now += 16 * 60_000;
  assert.throws(() => tf.apply(p3.plan.planId, {}, ENGINE), /expired/);
});

// ── outside access ───────────────────────────────────────────────────────────────────────────────────────────────
test('outside: a created token lists blobs, sends a message "via" its client, waits, reads; a revoked token is refused and audited', async () => {
  const s = setup();
  const b = bridgeWith({}, s.store, s.popo.id);
  s.rt.attachEngine(b.bridge);
  const made = s.rt.outside.createToken('Claude Desktop');
  assert.ok(made.ok); if (!made.ok) return;
  assert.match(made.token, /^kbo_/);
  const hello = s.rt.outside.hello({ token: made.token });
  assert.ok(hello.ok);
  const names = hello.tools!.map((t) => t.name);
  for (const must of ['list_blobs', 'send_message', 'read_thread', 'wait_for', 'interrupt']) assert.ok(names.includes(must), must);
  assert.ok(!names.some((n) => /approv|delete|secret|memory|grant|setting/i.test(n)), 'no approvals, deletes, settings, secrets, memory');
  assert.ok(!names.includes('list_groups'), 'no groups yet -> the group tools are not offered');

  const list = await s.rt.outside.call({ token: made.token, tool: 'list_blobs', args: {} });
  assert.ok(!list.isError, list.text);
  assert.match(list.text, /Kora/); assert.match(list.text, /Popo/);
  const sent = await s.rt.outside.call({ token: made.token, tool: 'send_message', args: { blob: 'Popo', text: 'plan lisbon' }, clientInfo: { name: 'claude-ai' } });
  assert.ok(!sent.isError, sent.text);
  assert.deepEqual(b.outsideLog[0].via.client, 'Claude Desktop');
  const read = await s.rt.outside.call({ token: made.token, tool: 'read_thread', args: { thread: 't1' } });
  assert.match(read.text, /hello/);
  // groups appear once one exists
  s.rt.groups.groups.create({ name: 'Crew', memberIds: [s.popo.id, s.junip.id] });
  assert.ok(s.rt.outside.hello({ token: made.token }).tools!.some((t) => t.name === 'send_to_group'));
  const gs = await s.rt.outside.call({ token: made.token, tool: 'send_to_group', args: { group: 'Crew', text: 'hey crew' } });
  assert.ok(!gs.isError, gs.text);
  assert.ok(b.outsideLog.some((x) => x.group?.text === 'hey crew'));

  assert.ok(s.rt.outside.revokeToken(made.record.id));
  const after = await s.rt.outside.call({ token: made.token, tool: 'list_blobs', args: {} });
  assert.equal(after.isError, true); assert.match(after.text, /revoked/);
  assert.equal(s.rt.outside.hello({ token: made.token }).ok, false);
  const audit = s.rt.outside.auditPage({ limit: 50 }).rows;
  assert.ok(audit.some((r) => r.tool === 'list_blobs' && r.ok === false && /revoked/.test(r.note ?? '')));
  assert.ok(audit.every((r) => !JSON.stringify(r).includes('plan lisbon')), 'message text is never logged');
  assert.equal(JSON.stringify(s.rt.outside.listTokens()).includes(made.token), false, 'only a hash is stored');
});

test('outside before the engine attaches: calls answer "still starting" instead of throwing', async () => {
  const s = setup();
  const made = s.rt.outside.createToken('Cursor');
  assert.ok(made.ok); if (!made.ok) return;
  const r = await s.rt.outside.call({ token: made.token, tool: 'send_message', args: { blob: 'Popo', text: 'hi' } });
  assert.equal(r.isError, true);
  assert.match(r.text, /still starting/);
});

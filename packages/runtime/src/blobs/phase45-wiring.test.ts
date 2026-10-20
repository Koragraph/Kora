// Phases 4 and 5 as the daemon wires them: a real BlobRuntimeImpl over a bridge that has the routine methods and an
// AppsService over a fake Composio backend. Routines run as hidden threads and report into a results thread; app tools exist only
// for a blob with a grant; an outbound app action waits for the user's answer on every engine (in-process and over the MCP hub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, fakeBridge, resetHome, tempHome } from './testkit-team';
tempHome('p45-wiring-');

import { BlobStore } from './store';
import { BlobRuntimeImpl, routineBridgeFrom } from './runtime';
import { inlineMemoryHost } from './memory-host';
import { openMemory } from '../memory';
import { CHIEF_SOUL } from './chief';
import { hireTemplate } from './templates';
import { blobHome } from './home';
import { fakeRoutineBridge } from './routines/testkit';
import { AppsService, MemorySecretStore, ParkedApprovals, askVia, approvalCopy, argsSummary, APPROVAL_TIMEOUT_MS } from './apps';
import type { AppAccount, AppsBackend, AppTool } from './apps/types';
import type { BlobToolContext } from './types';
import { blobSystemPromptText } from './prompt';
import { FileSecretStore, defaultSecretStore, keychainService } from './apps/secrets';
import { isKoraOwnSecret } from '../util/child-env';

// ── a bridge with everything: the team's methods (Phase 2) and the routine methods (Phase 4) ─────────────────────────
function fullBridge() {
  const team = fakeBridge();
  const routine = fakeRoutineBridge();
  const posted: Array<{ id: string; card: any }> = [];
  const bridge: any = {
    ...team.bridge,
    startHiddenThread: (p: any) => routine.bridge.startHiddenThread(p),
    createResultsThread: (p: any) => routine.bridge.createResultsThread(p),
    threadExists: (id: string) => routine.bridge.threadExists!(id),
    postRoutineReport: async (id: string, card: any) => { posted.push({ id, card }); return routine.bridge.postReport(id, card); },
    snapshot: (id: string) => (routine.snaps.get(id) ? { ...routine.snaps.get(id)!, tokens: { input: 0, cached: 0, output: 0, turns: 0 } } : team.bridge.snapshot(id)),
    onSettled: (cb: any) => { const a = team.bridge.onSettled(cb); const b = routine.bridge.onSettled(cb); return () => { a(); b(); }; },
  };
  return { bridge, team, routine, posted };
}

// ── a fake Composio backend (the AppsService seam), with the account / tool shapes the broker returns ────────────────
function fakeBackend(o: { accounts?: AppAccount[] } = {}) {
  const st = { accounts: o.accounts ?? ([] as AppAccount[]), executed: [] as any[], used: 0, limit: 750 as number | null };
  const tools = (tk: string): AppTool[] => {
    const P = tk.toUpperCase();
    return [`${P}_FETCH_EMAILS`, `${P}_SEND_EMAIL`, `${P}_DELETE_EMAIL`].map((slug) => ({ slug, name: slug, description: 'd', toolkit: tk, inputSchema: { properties: { q: { type: 'string' } } }, readOnly: slug.includes('FETCH') ? true : null }));
  };
  const backend: AppsBackend = {
    kind: 'broker',
    async usage() { return { used: st.used, limit: st.limit, month: '2026-10', resetsAt: Date.UTC(2026, 10, 1) }; },
    async toolkits() { return { toolkits: [], nextCursor: null }; },
    async accounts(tk) { return st.accounts.filter((a) => !tk || a.toolkit === tk); },
    async link() { return { url: 'https://connect.composio.dev/x', expiresAt: Date.now() + 600_000 }; },
    async disconnect(id) { const n = st.accounts.length; st.accounts = st.accounts.filter((a) => a.id !== id); return { removed: n - st.accounts.length }; },
    async tools(tk) { return tools(tk); },
    async execute(i) {
      const act = st.accounts.filter((a) => a.toolkit === i.toolkit && a.status === 'ACTIVE');
      if (!act.length) { const { AppsError } = await import('./apps/types'); throw new AppsError('not_connected', `No ${i.toolkit} account is connected.`); }
      st.executed.push(i); st.used++;
      return { ok: true, data: { done: i.tool }, error: null, account: { id: act[0]!.id, alias: act[0]!.alias }, usage: { used: st.used, limit: st.limit } };
    },
  };
  return Object.assign(st, { backend });
}

function setup(o: { accounts?: AppAccount[] } = {}) {
  resetHome();
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) });
  const fb = fakeBackend(o);
  const apps = new AppsService({ dir: path.join(process.env.KORA_HOME!, 'blobs', 'apps'), secrets: new MemorySecretStore(), brokerUrl: 'https://broker.test', makeBackend: () => fb.backend });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem, () => {}), oneShot: async () => null, koraCmd: 'kora', userSkillDirs: [], apps, webhookPort: 0 });
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const tibbo = (hireTemplate(store, 'tibbo', { defaultEngine: ENGINE }) as any).profile;
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const bobble = (hireTemplate(store, 'bobble', { defaultEngine: ENGINE }) as any).profile;
  const shown: any[] = [];
  const asked: Array<{ title: string; detail: string; args: any }> = [];
  let answer = true;
  const ctx = (blobId: string, extra: Partial<BlobToolContext> & { fullAccess?: () => boolean } = {}) => ({
    blobId, threadId: `kt-${blobId}`, agent: 'claude', cwd: '/x', emitCard: (c: any) => { shown.push(c); },
    askApproval: async (p: any) => { asked.push(p); return answer; }, ...extra,
  });
  const tools = (blobId: string, extra: Record<string, unknown> = {}) => {
    const by = new Map(rt.toolSpecs(ctx(blobId, extra as any)).map((t) => [t.name, t] as const));
    return { names: [...by.keys()], call: (name: string, args: Record<string, unknown> = {}) => by.get(name)!.handler(args) };
  };
  return { store, rt, fb, apps, kora, tibbo, popo, bobble, shown, asked, ctx, tools, setAnswer: (v: boolean) => { answer = v; } };
}

const grantAll = (s: ReturnType<typeof setup>, id: string) => s.store.update(id, { toolGrants: { ...s.store.get(id)!.toolGrants, apps: { mode: 'all', allow: [] } } });
const tick = () => new Promise((r) => setTimeout(r, 30));

// ── Phase 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('routineBridgeFrom: an older bridge without the hidden-thread methods gives no routine engine (nothing half-wired)', () => {
  assert.equal(routineBridgeFrom(fakeBridge().bridge), null);
  assert.ok(routineBridgeFrom(fullBridge().bridge));
});

test('a routine run: hidden execution thread with the routine origin, then the dated report in a results thread, then a notification event', async () => {
  const s = setup();
  const f = fullBridge();
  const attention: any[] = [];
  s.rt.onRoutineAttention((e) => attention.push(e));
  s.rt.attachEngine(f.bridge);
  const r = s.rt.routines.create({ blobId: s.popo.id, title: 'Watch', prompt: 'Look things up.', cadence: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'Asia/Calcutta' } });
  assert.ok(r.ok);
  const run = await s.rt.routines.runNow(r.ok ? r.value.id : '');
  assert.ok(run.ok);
  assert.equal(f.routine.threads.length, 1);
  const t = f.routine.threads[0]!;
  assert.equal(t.origin.kind, 'routine'); assert.equal(t.origin.routineId, r.ok ? r.value.id : ''); assert.equal(t.blobId, s.popo.id);
  assert.match(t.prompt, /Look things up\./);
  await f.routine.finish(t.threadId, { finalText: 'Three things changed.' });
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0]!.card.cardKind, 'routine-report');
  assert.equal(f.posted[0]!.card.executionThreadId, t.threadId);
  assert.match(f.posted[0]!.card.text, /Three things changed/);
  assert.deepEqual(attention.map((a) => a.kind), ['settled']);
  assert.equal(attention[0].blobId, s.popo.id);
  await s.rt.close();
});

test('every blob gets the routine tools; Kora can schedule for another blob but only behind a confirm card, and Undo routes to the routine service', async () => {
  const s = setup();
  s.rt.attachEngine(fullBridge().bridge);
  const p = s.tools(s.popo.id);
  for (const n of ['schedule_routine', 'change_routine', 'list_routines']) assert.ok(p.names.includes(n), n);
  // own routine: the user is asked first; once they approve, a receipt with Undo
  const own = await p.call('schedule_routine', { title: 'Monday scan', prompt: 'Scan.', days: ['mon'], time: '09:00' });
  assert.ok(!own.isError, own.text);
  assert.match(own.text, /needs the user's OK/);
  assert.equal(s.rt.routines.list(s.popo.id).filter((x) => x.title === 'Monday scan').length, 0);
  const ownCard = s.shown.find((c) => c.cardKind === 'routine-confirm');
  assert.ok(ownCard);
  assert.ok(s.rt.routines.confirm(ownCard.token, true).ok);
  const receipt = s.shown.find((c) => c.cardKind === 'self-change');
  assert.ok(receipt && String(receipt.undoToken).startsWith('undo_rt_'));
  assert.equal(s.rt.routines.list(s.popo.id).filter((x) => x.title === 'Monday scan').length, 1);
  assert.equal(await s.rt.undoSelfChange(receipt.undoToken), true);
  assert.equal(s.rt.routines.list(s.popo.id).filter((x) => x.title === 'Monday scan').length, 0);
  // Kora for another blob: a confirm card, nothing created yet
  const k = s.tools(s.kora.id);
  const asked = await k.call('schedule_routine', { blob: 'Popo', title: 'Friday wrap', prompt: 'Wrap.', days: ['fri'], time: '16:00' });
  assert.ok(!asked.isError, asked.text);
  const card = s.shown.filter((c) => c.cardKind === 'routine-confirm').at(-1);
  assert.ok(card && card.state === 'open' && card !== ownCard);
  assert.equal(s.rt.routines.list(s.popo.id).filter((x) => x.title === 'Friday wrap').length, 0);
  const done = s.rt.routines.confirm(card.token, true);
  assert.ok(done.ok && done.value.state === 'confirmed');
  assert.equal(s.rt.routines.list(s.popo.id).filter((x) => x.title === 'Friday wrap').length, 1);
  // any other blob is refused
  const other = await s.tools(s.tibbo.id).call('schedule_routine', { blob: 'Popo', title: 'x', prompt: 'x', days: ['mon'], time: '09:00' });
  assert.ok(other.isError);
  await s.rt.close();
});

test('starter routines arrive paused with a real prompt and a real schedule (Tibbo weekdays 08:00; Bobble 09:00 and 16:00 as one cron rule)', () => {
  const s = setup();
  const z = s.rt.routines.list(s.tibbo.id);
  assert.equal(z.length, 1);
  assert.equal(z[0]!.title, 'Morning brief'); assert.equal(z[0]!.paused, true); assert.equal(z[0]!.createdBy, 'template');
  assert.equal(z[0]!.cadence.kind, 'weekly');
  assert.deepEqual((z[0]!.cadence as any).days, [1, 2, 3, 4, 5]); assert.equal((z[0]!.cadence as any).time, '08:00');
  assert.match(z[0]!.prompt, /morning brief/i);
  assert.equal(z[0]!.suggestedCadence, null, 'the schedule mapped exactly, so no "suggested in other words" note');
  assert.equal(z[0]!.nextRunAt, null); // paused: never scheduled
  const b = s.rt.routines.list(s.bobble.id);
  assert.equal(b[0]!.cadence.kind, 'cron');
  assert.equal((b[0]!.cadence as any).expr, '0 9,16 * * 1-5');
});

test('deleting a blob stops its live runs and forgets its routines (no file is written into the folder that is gone)', async () => {
  const s = setup();
  const f = fullBridge();
  s.rt.attachEngine(f.bridge);
  const r = s.rt.routines.create({ blobId: s.popo.id, title: 'Watch', prompt: 'x', cadence: { kind: 'weekly', days: [1], time: '08:00', tz: 'UTC' } });
  assert.ok(r.ok);
  assert.ok((await s.rt.routines.runNow(r.ok ? r.value.id : '')).ok);
  const thread = f.routine.threads[0]!.threadId;
  s.store.delete(s.popo.id, s.popo.name, path.join(process.env.KORA_HOME!, 'trash'));
  await tick();
  assert.deepEqual(f.team.interrupted, [thread]);
  assert.equal(fs.existsSync(path.join(blobHome(s.popo.id), 'routines.json')), false);
  await s.rt.close();
});

test('the system prompt tells every blob about routines, and only a blob with an app grant about apps', () => {
  const s = setup();
  assert.match(s.rt.systemPrompt({ blobId: s.popo.id, threadId: 'T', agent: 'claude' }), /schedule_routine/);
  assert.doesNotMatch(s.rt.systemPrompt({ blobId: s.popo.id, threadId: 'T', agent: 'claude' }), /apps_run/);
  grantAll(s, s.popo.id);
  assert.match(s.rt.systemPrompt({ blobId: s.popo.id, threadId: 'T2', agent: 'claude' }), /apps_connected.*apps_tools.*apps_run/s);
  assert.match(blobSystemPromptText({ ...({} as any), blob: s.popo, soul: '', aboutMe: '', core: { you: '', blob: '' }, agent: 'claude', blobHome: '/x', skillIndex: '', koraCmd: 'kora', canDelegateLegwork: false, hasApps: true }), /Connected apps/);
});

// ── Phase 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('apps: a blob with no grant is not even told apps exist; with a grant it gets exactly the three meta-tools', () => {
  const s = setup();
  assert.ok(!s.tools(s.popo.id).names.some((n) => n.startsWith('apps_')));
  grantAll(s, s.popo.id);
  assert.deepEqual(s.tools(s.popo.id).names.filter((n) => n.startsWith('apps_')).sort(), ['apps_connected', 'apps_run', 'apps_tools']);
});

test('an outbound app action waits for the user: allowed -> runs once with the card\'s tool + key args; denied -> never runs; Auto does not skip it', async () => {
  const s = setup({ accounts: [{ id: 'ca1', toolkit: 'gmail', alias: 'work', status: 'ACTIVE' }] });
  grantAll(s, s.popo.id);
  s.store.update(s.popo.id, { permission: 'auto' });
  const t = s.tools(s.popo.id);
  const args = JSON.stringify({ to: 'sam@acme.com', subject: 'Invoice 12', body: 'Hi Sam, attached.' });
  const ok = await t.call('apps_run', { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments_json: args });
  assert.ok(!ok.isError, ok.text);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0]!.title, /Popo wants to/);
  assert.match(s.asked[0]!.detail, /to: sam@acme\.com/); assert.match(s.asked[0]!.detail, /subject: Invoice 12/);
  assert.equal(s.asked[0]!.args.kind, 'app-action'); assert.equal(s.asked[0]!.args.appName, 'Gmail'); assert.equal(s.asked[0]!.args.account, 'work');
  assert.equal(s.fb.executed.length, 1);
  // a read never asks
  await t.call('apps_run', { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '{}' });
  assert.equal(s.asked.length, 1);
  assert.equal(s.fb.executed.length, 2);
  // denied
  s.setAnswer(false);
  const no = await t.call('apps_run', { tool: 'GMAIL_DELETE_EMAIL', toolkit: 'gmail', arguments_json: '{}' });
  assert.ok(no.isError); assert.match(no.text, /said no/);
  assert.equal(s.fb.executed.length, 2);
  // the decision log has both, without argument values
  const log = s.apps.decisions.recent(20, s.popo.id);
  assert.ok(log.some((r) => r.reason === 'user_approved') && log.some((r) => r.reason === 'user_denied'));
  assert.ok(!JSON.stringify(log).includes('sam@acme.com'));
});

test('no way to ask (no askApproval) fails closed; per-blob Full access skips the ask', async () => {
  const s = setup({ accounts: [{ id: 'ca1', toolkit: 'gmail', alias: null, status: 'ACTIVE' }] });
  grantAll(s, s.popo.id);
  const closed = s.tools(s.popo.id, { askApproval: undefined });
  const r = await closed.call('apps_run', { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments_json: '{"to":"a@b.c"}' });
  assert.ok(r.isError); assert.equal(s.fb.executed.length, 0);
  s.store.update(s.popo.id, { permission: 'full' });
  const full = await s.tools(s.popo.id).call('apps_run', { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments_json: '{"to":"a@b.c"}' });
  assert.ok(!full.isError, full.text);
  assert.equal(s.fb.executed.length, 1);
  assert.equal(s.asked.length, 0);
});

test('Codex / OpenCode reach the same tools over the MCP hub, and the approval is awaited inside blobs.mcp.call', async () => {
  const s = setup({ accounts: [{ id: 'ca1', toolkit: 'gmail', alias: null, status: 'ACTIVE' }] });
  grantAll(s, s.popo.id);
  let release: (v: boolean) => void = () => {};
  const pending = new Promise<boolean>((r) => { release = r; });
  const token = s.rt.mcpIssue({ blobId: s.popo.id, threadId: 'T-mcp', agent: 'codex', cwd: '/x', askApproval: async () => pending });
  const hello = s.rt.hub.hello({ blobId: s.popo.id, token });
  assert.ok(hello.ok && hello.tools.some((x) => x.name === 'apps_run'));
  assert.ok(hello.ok && ['schedule_routine', 'change_routine', 'list_routines'].every((n) => hello.tools.some((x) => x.name === n)), 'a Codex / OpenCode blob can schedule its own routines too');
  let done = false;
  const call = s.rt.hub.call({ blobId: s.popo.id, token, name: 'apps_run', args: { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments_json: '{"to":"a@b.c"}' } }).then((r) => { done = true; return r; });
  await tick();
  assert.equal(done, false, 'the call waits for the user');
  assert.equal(s.fb.executed.length, 0);
  release(true);
  const res = await call;
  assert.ok(!res.isError, res.text);
  assert.equal(s.fb.executed.length, 1);
});

test('reaching for an app that is not connected leaves a Connect chip card in the chat', async () => {
  const s = setup();
  grantAll(s, s.popo.id);
  const r = await s.tools(s.popo.id).call('apps_run', { tool: 'SLACK_FETCH_MESSAGES', toolkit: 'slack', arguments_json: '{}' });
  assert.ok(r.isError);
  const card = s.shown.find((c) => c.cardKind === 'app-connect');
  assert.ok(card); assert.equal(card.toolkit, 'slack'); assert.equal(card.reason, 'not_connected'); assert.equal(card.blobId, s.popo.id);
});

test('hiring a starter allows the apps it comes with, but only those already connected (a hire never opens a closed door)', async () => {
  const s = setup({ accounts: [{ id: 'ca1', toolkit: 'gmail', alias: null, status: 'ACTIVE' }] });
  s.store.archive(s.tibbo.id); // hire it fresh through the runtime's click path
  s.store.delete(s.tibbo.id, s.tibbo.name, path.join(process.env.KORA_HOME!, 'trash'));
  const hired = s.rt.hireTemplates(['tibbo']);
  await tick(); await tick();
  const grants = s.store.get(hired[0]!.id)!.toolGrants.apps;
  assert.equal(grants.mode, 'list');
  assert.deepEqual(grants.allow, ['toolkit:gmail']); // Tibbo works with Calendar too, which is not connected: not allowed
});

test('ParkedApprovals: answers resolve, a stop or a timeout is a denial, the resolved event always follows', async () => {
  const p = new ParkedApprovals();
  const events: any[] = [];
  const ask = askVia(p, 'T1', (e) => events.push(e), () => ({ turnId: 'u1' }));
  const a = ask({ title: 'x', detail: 'y', args: { kind: 'app-action' } });
  const opened = events[0];
  assert.equal(opened.type, 'approval.opened'); assert.equal(opened.requestKind, 'mcp_elicitation_approval'); assert.equal(opened.turnId, 'u1');
  assert.equal(p.respond('OTHER', opened.requestId, 'accept'), false); // another thread cannot answer it
  assert.equal(p.respond('T1', opened.requestId, 'accept'), true);
  assert.equal(await a, true);
  assert.equal(events[1].type, 'approval.resolved');
  // cancel on stop
  const b = ask({ title: 'x', detail: 'y', args: {} });
  p.cancelThread('T1');
  assert.equal(await b, false);
  assert.equal(events.at(-1).decision, 'cancel');
  // timeout
  const c = new ParkedApprovals().ask('T9', { opened() {}, resolved(_id, d) { events.push(d); } }, 20);
  assert.equal(await c, false);
  assert.equal(events.at(-1), 'cancel');
  assert.ok(APPROVAL_TIMEOUT_MS < 600_000); // under Codex's 600 s tool timeout
});

test('approval copy and the key-args summary show what a person decides on, not the whole JSON', () => {
  assert.equal(argsSummary({ body: 'x'.repeat(300), to: 'a@b.c', subject: 'Hi', zzz: 1, extra: 2, more: 3 }, 3), 'to: a@b.c\nsubject: Hi\nbody: "' + 'x'.repeat(89) + '…"\n+ 3 more');
  const c = approvalCopy({ blobId: 'b', threadId: 't', tool: 'SLACK_SEND_MESSAGE', toolkit: 'slack', account: null, summary: 'Send message on slack', reason: 'sends', argsPreview: '', args: { channel: '#ops', text: 'deploying' } }, { channel: '#ops', text: 'deploying' }, 'Popo');
  assert.equal(c.title, 'Popo wants to: Send message on slack');
  assert.match(c.detail, /channel: #ops/); assert.match(c.detail, /text: "deploying"/);
  assert.equal((c.args as any).appName, 'Slack');
});

test('secrets: the file vault switch survives the daemon\'s env scrub; every home has its own Keychain service (QA and Kora Dev never touch the real install\'s)', () => {
  // KORA_SECRET_STORE would have matched /KORA_\w*SECRET/ and been deleted from the daemon's env at start: a QA stack then
  // wrote its fake broker token into the user's login Keychain. The switch must not look like a secret.
  assert.equal(isKoraOwnSecret('KORA_APPS_VAULT'), false);
  assert.equal(isKoraOwnSecret('KORA_COMPOSIO_BROKER_URL'), false);
  assert.equal(isKoraOwnSecret('KORA_COMPOSIO_API_BASE'), false);
  const was = process.env.KORA_APPS_VAULT;
  try {
    process.env.KORA_APPS_VAULT = 'file';
    assert.ok(defaultSecretStore('/tmp/x') instanceof FileSecretStore, 'file vault forced');
  } finally { if (was === undefined) delete process.env.KORA_APPS_VAULT; else process.env.KORA_APPS_VAULT = was; }
  assert.equal(keychainService('/Users/me/.kora'), 'kora-apps');
  assert.equal(keychainService('/Users/me/.kora-dev'), 'kora-apps-dev');
  assert.match(keychainService('/tmp/qa/stack2/home'), /^kora-apps-[0-9a-f]{10}$/);
  assert.notEqual(keychainService('/tmp/qa/stack2/home'), keychainService('/tmp/qa/stack3/home'), 'two QA stacks never share a Keychain item');
  assert.notEqual(keychainService('/Users/me/.kora'), keychainService('/Users/me/.kora-dev'));
});

test('the local "used up" memory is dropped as soon as the broker reports calls left (a raised cap is not ignored until the old reset date)', async () => {
  const s = setup({ accounts: [{ id: 'ca1', toolkit: 'gmail', alias: null, status: 'ACTIVE' }] });
  grantAll(s, s.popo.id);
  s.fb.used = 750; s.fb.limit = 750;
  assert.equal((await s.apps.usage()).capReached, true);
  const t = s.tools(s.popo.id);
  const capped = await t.call('apps_run', { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '{}' });
  assert.ok(capped.isError && /used up/i.test(capped.text));
  assert.equal(s.fb.executed.length, 0, 'a capped call is never made');
  s.fb.limit = 1000; // the owner raised MONTHLY_CAP
  assert.equal((await s.apps.usage()).capReached, false);
  const ok = await t.call('apps_run', { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '{}' });
  assert.ok(!ok.isError, ok.text);
  assert.equal(s.fb.executed.length, 1);
});

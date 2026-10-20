// Connected apps daemon client against a fake broker and a fake Composio (documented shapes only; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppsService, BYO_KEY_SECRET, MemorySecretStore, FileSecretStore, KeychainSecretStore, WindowsCredentialSecretStore, defaultSecretStore, AppsError, allowsTool, visibleToolkits, classifyTool, appToolSpecs, CAP_MESSAGE, type AppsCaller } from './index';

const BROKER = 'https://broker.test';
const BYO_KEY = 'ak_user_own_project_key_123';
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

interface Acct { id: string; toolkit: string; alias: string | null; status: string }
/** Mirrors the Worker's contract (services/composio-broker). `cap` is calls per month. */
function fakeBroker(o: { cap?: number } = {}) {
  const f = { cap: o.cap ?? 750, used: 0, accounts: [] as Acct[], registered: 0, calls: [] as { m: string; p: string; auth: string | null; body: any }[], down: false, executed: [] as any[], resetsAt: Date.UTC(2026, 10, 1) };
  const fetchImpl = (async (input: any, init: any = {}) => {
    if (f.down) throw new TypeError('offline');
    const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers?.authorization ?? null;
    f.calls.push({ m: init.method ?? 'GET', p: u.pathname + u.search, auth, body });
    if (u.pathname === '/v1/register') { f.registered++; return j({ installId: 'i1', token: 'kbk_' + 'a'.repeat(40) }, 201); }
    if (auth !== 'Bearer kbk_' + 'a'.repeat(40)) return j({ error: { code: 'unauthorized', message: 'no' } }, 401);
    if (u.pathname === '/v1/usage') return j({ used: f.used, limit: f.cap, month: '2026-10', resetsAt: f.resetsAt });
    if (u.pathname === '/v1/accounts' && (init.method ?? 'GET') === 'GET') { const tk = u.searchParams.get('toolkit'); return j({ accounts: f.accounts.filter((a) => !tk || a.toolkit === tk) }); }
    if (u.pathname === '/v1/link') return j({ url: 'https://connect.composio.dev/l/1', expiresAt: 1_000 + 600_000 });
    const del = /^\/v1\/accounts\/(.+)$/.exec(u.pathname);
    if (del && init.method === 'DELETE') { const n = f.accounts.length; f.accounts = f.accounts.filter((a) => a.id !== del[1]); return j({ removed: n - f.accounts.length }); }
    if (u.pathname === '/v1/tools') {
      const tk = u.searchParams.get('toolkit')!;
      const P = tk.toUpperCase();
      return j({ tools: [`${P}_FETCH_EMAILS`, `${P}_SEND_EMAIL`, `${P}_DELETE_EMAIL`].map((s) => ({ slug: s, name: s, description: 'd', toolkit: tk, inputSchema: { properties: { q: { type: 'string' } } }, readOnly: null })) });
    }
    if (u.pathname === '/v1/execute') {
      const act = f.accounts.filter((a) => a.toolkit === body.toolkit && a.status === 'ACTIVE');
      if (!act.length) return j({ error: { code: 'not_connected', message: 'none' } }, 409);
      if (!body.account_id && act.length > 1) return j({ error: { code: 'account_required', message: 'which', accounts: act.map((a) => ({ id: a.id, alias: a.alias })) } }, 409);
      if (f.used >= f.cap) return j({ error: { code: 'cap_reached', message: 'cap', used: f.used, limit: f.cap, month: '2026-10', resetsAt: f.resetsAt } }, 429);
      f.used++; f.executed.push(body);
      const a = act.find((x) => x.id === body.account_id) ?? act[0];
      return j({ ok: true, data: { done: body.tool }, error: null, account: { id: a.id, alias: a.alias }, usage: { used: f.used, limit: f.cap } });
    }
    return j({ error: { code: 'not_found', message: 'nf' } }, 404);
  }) as typeof fetch;
  return Object.assign(f, { fetch: fetchImpl });
}

function rig(o: { cap?: number; brokerUrl?: string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const broker = fakeBroker({ cap: o.cap });
  const secrets = new MemorySecretStore();
  let now = Date.UTC(2026, 9, 9, 12);
  const svc = new AppsService({ dir, secrets, ...(o.brokerUrl === null ? {} : { brokerUrl: BROKER }), fetch: broker.fetch, now: () => now });
  const ALL = { mode: 'all' as const, allow: [] as string[] };
  const caller = (over: Partial<AppsCaller> = {}): AppsCaller => ({ blobId: 'blob_a', threadId: 't1', permission: 'auto', grants: ALL, ...over });
  const connect = (toolkit: string, alias: string | null = null, id = `ca_${toolkit}_${alias ?? 'x'}`) => broker.accounts.push({ id, toolkit, alias, status: 'ACTIVE' });
  return { dir, broker, secrets, svc, caller, connect, ALL, setNow: (t: number) => { now = t; }, now: () => now };
}

test('registers once, stores the token in the secret store only, and reuses it', async () => {
  const r = rig(); r.connect('gmail');
  await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  assert.equal(r.broker.registered, 1);
  assert.equal(await r.secrets.get('broker-token'), 'kbk_' + 'a'.repeat(40));
  for (const f of fs.readdirSync(r.dir)) assert.ok(!fs.readFileSync(path.join(r.dir, f), 'utf8').includes('kbk_a'), `${f} must not hold the token`);
});

test('concurrent first calls register exactly once', async () => {
  const r = rig(); r.connect('gmail');
  await Promise.all([1, 2, 3, 4].map(() => r.svc.accounts()));
  assert.equal(r.broker.registered, 1);
});

test('broker down: one clear error, nothing thrown, no URL or token in the text', async () => {
  const r = rig(); r.connect('gmail');
  r.broker.down = true;
  const res = await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'broker_down');
  assert.match(res.text, /unreachable/);
  assert.match(res.text, /Nothing was used/);
  assert.ok(!res.text.includes('broker.test') && !res.text.includes('kbk_'));
  await assert.rejects(() => r.svc.accounts(), (e: any) => e instanceof AppsError && e.code === 'broker_down');
  r.broker.down = false;
  assert.equal((await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} })).ok, true, 'recovers by itself');
});

test('no broker URL and no key: a clear "not set up" message', async () => {
  const r = rig({ brokerUrl: null });
  assert.equal(await r.svc.mode(), 'unavailable');
  const res = await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  assert.equal(res.code, 'not_configured');
});

test('cap: clear Kora Pro message, then paused locally until next month, then resumes', async () => {
  const r = rig({ cap: 2 }); r.connect('gmail');
  const run = () => r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  assert.equal((await run()).ok, true);
  assert.equal((await run()).ok, true);
  const calls = r.broker.calls.length;
  const hit = await run();
  assert.equal(hit.ok, false); assert.equal(hit.code, 'cap_reached');
  assert.match(hit.text, /Monthly free app calls used up \(2\/2\)/);
  assert.match(hit.text, /Kora Pro \(coming soon\)/);
  assert.match(hit.text, /Composio key/);
  const after = r.broker.calls.length;
  const again = await run();
  assert.equal(again.code, 'cap_reached');
  assert.equal(r.broker.calls.length, after, 'paused: the broker is not called again this month');
  assert.equal(after, calls, 'the 2nd call already saw the cap in its usage reply, so the 3rd never leaves the machine');
  r.setNow(Date.UTC(2026, 10, 1, 0, 1)); r.broker.cap = 5; r.broker.used = 0; // the broker's month rolled over
  assert.equal((await run()).ok, true);
  assert.equal((await r.svc.usage()).capReached, false);
});

test('cap reported by the broker itself (another process used the calls): same message, then paused', async () => {
  const r = rig({ cap: 3 }); r.connect('gmail'); r.broker.used = 3;
  const run = () => r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  const hit = await run();
  assert.equal(hit.code, 'cap_reached'); assert.match(hit.text, /3\/3.*Kora Pro \(coming soon\)/);
  const n = r.broker.calls.length;
  assert.equal((await run()).code, 'cap_reached');
  assert.equal(r.broker.calls.length, n);
});

test('usage reports used/limit/month for the cap card', async () => {
  const r = rig(); r.connect('gmail');
  await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  const u = await r.svc.usage();
  assert.deepEqual([u.mode, u.used, u.limit, u.month, u.capReached], ['broker', 1, 750, '2026-10', false]);
});

// ---- BYO ----
function fakeComposioFetch() {
  const calls: { url: string; key: string | undefined; method: string; body: any }[] = [];
  const accounts: any[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const u = new URL(String(input)); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), key: init.headers?.['x-api-key'], method: init.method ?? 'GET', body });
    if (u.hostname !== 'backend.composio.dev') return j({}, 404);
    if (init.headers?.['x-api-key'] !== BYO_KEY) return j({ error: { message: 'invalid key' } }, 401);
    const p = u.pathname.replace('/api/v3.1', '');
    if (p === '/connected_accounts' && (init.method ?? 'GET') === 'GET') return j({ items: accounts.filter((a) => !u.searchParams.get('toolkit_slugs') || a.toolkit.slug === u.searchParams.get('toolkit_slugs')), next_cursor: null });
    if (p.startsWith('/tools/execute/')) return j({ successful: true, data: { account: body.connected_account_id, user: body.user_id } });
    if (p === '/tools') return j({ items: [{ slug: 'GMAIL_FETCH_EMAILS', toolkit: { slug: 'gmail' }, description: 'd', input_parameters: {}, tags: [] }] });
    if (p === '/tool_router/session') return j({ session_id: 's1' });
    if (p.endsWith('/link')) return j({ redirect_url: 'https://connect.composio.dev/l/9' });
    return j({}, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, accounts };
}

test('BYO key: validated before saving, takes priority over the broker, no cap, key only goes to Composio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const broker = fakeBroker(); const comp = fakeComposioFetch();
  const secrets = new MemorySecretStore();
  const fetchImpl = ((i: any, n: any) => (String(i).startsWith(BROKER) ? broker.fetch(i, n) : comp.fetch(i, n))) as typeof fetch;
  const svc = new AppsService({ dir, secrets, brokerUrl: BROKER, fetch: fetchImpl });
  assert.equal(await svc.mode(), 'broker');
  await assert.rejects(() => svc.setByoKey('ak_wrong_key_value_000'), (e: any) => e.code === 'bad_key');
  await assert.rejects(() => svc.setByoKey('not-a-key'), (e: any) => e.code === 'bad_key');
  assert.equal(await secrets.get(BYO_KEY_SECRET), null, 'a bad key is never stored');
  await svc.setByoKey(BYO_KEY);
  assert.equal(await svc.mode(), 'byo');
  comp.accounts.push({ id: 'ca1', status: 'ACTIVE', alias: null, toolkit: { slug: 'gmail' } });
  const brokerCallsBefore = broker.calls.length;
  const compBefore = comp.calls.length;
  const res = await svc.run({ blobId: 'b', permission: 'auto', grants: { mode: 'all', allow: [] } }, { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {} });
  assert.equal(res.ok, true, res.text);
  assert.equal(broker.calls.length, brokerCallsBefore, 'broker untouched in BYO mode');
  assert.ok(comp.calls.slice(compBefore).length > 0 && comp.calls.slice(compBefore).every((c) => c.key === BYO_KEY && c.url.startsWith('https://backend.composio.dev/api/v3.1')));
  const u = await svc.usage();
  assert.equal(u.limit, null); assert.equal(u.mode, 'byo');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(BYO_KEY), `${f} must not hold the key`);
  await svc.clearByoKey();
  assert.equal(await svc.mode(), 'broker');
});

test('BYO: link, label rules, max 5 per app', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const comp = fakeComposioFetch(); const secrets = new MemorySecretStore();
  const svc = new AppsService({ dir, secrets, fetch: comp.fetch });
  await svc.setByoKey(BYO_KEY);
  const l = await svc.connect('gmail');
  assert.match(l.url, /^https:\/\/connect\.composio\.dev\//);
  comp.accounts.push({ id: 'a1', status: 'ACTIVE', alias: 'personal', toolkit: { slug: 'gmail' } });
  await assert.rejects(() => svc.connect('gmail'), (e: any) => e.code === 'alias_required');
  await assert.rejects(() => svc.connect('gmail', 'Personal'), (e: any) => e.code === 'alias_in_use');
  assert.ok(await svc.connect('gmail', 'work'));
  for (const n of ['b', 'c', 'd', 'e']) comp.accounts.push({ id: n, status: 'ACTIVE', alias: n, toolkit: { slug: 'gmail' } });
  await assert.rejects(() => svc.connect('gmail', 'sixth'), (e: any) => e.code === 'account_limit');
});

test('connect links expire', async () => {
  const r = rig();
  const l = { url: 'https://connect.composio.dev/x', expiresAt: r.now() + 1000 };
  assert.equal(r.svc.assertLinkFresh(l), l);
  r.setNow(r.now() + 1001);
  assert.throws(() => r.svc.assertLinkFresh(l), (e: any) => e.code === 'link_expired');
});

// ---- grants ----
test('grants: none / all / exact list / toolkit shorthand; a wrong toolkit label never widens a grant', () => {
  assert.equal(allowsTool(undefined, 'GMAIL_FETCH_EMAILS', 'gmail'), false);
  assert.equal(allowsTool({ mode: 'none', allow: ['GMAIL_FETCH_EMAILS'] }, 'GMAIL_FETCH_EMAILS', 'gmail'), false);
  assert.equal(allowsTool({ mode: 'all', allow: [] }, 'GMAIL_FETCH_EMAILS', 'gmail'), true);
  const list = { mode: 'list', allow: ['gmail_fetch_emails', 'toolkit:slack'] };
  assert.equal(allowsTool(list, 'GMAIL_FETCH_EMAILS', 'gmail'), true);
  assert.equal(allowsTool(list, 'GMAIL_SEND_EMAIL', 'gmail'), false);
  assert.equal(allowsTool(list, 'SLACK_SEND_MESSAGE', 'slack'), true);
  assert.equal(allowsTool(list, 'GMAIL_SEND_EMAIL', 'slack'), false, 'GMAIL tool claimed as slack');
  assert.equal(allowsTool({ mode: 'list' }, 'X_Y', 'x'), false);
  assert.equal(allowsTool({ mode: 'bogus', allow: [] }, 'GMAIL_FETCH_EMAILS', 'gmail'), false);
  assert.deepEqual(visibleToolkits(list, ['gmail', 'slack', 'github']), ['gmail', 'slack']);
  assert.deepEqual(visibleToolkits({ mode: 'none', allow: [] }, ['gmail']), []);
});

test('ungranted tools are never offered; ungranted runs are denied, logged, and never reach the broker', async () => {
  const r = rig(); r.connect('gmail');
  const grants = { mode: 'list' as const, allow: ['GMAIL_FETCH_EMAILS'] };
  assert.deepEqual((await r.svc.grantedTools(grants, 'gmail')).map((t) => t.slug), ['GMAIL_FETCH_EMAILS']);
  assert.deepEqual(await r.svc.grantedTools({ mode: 'none', allow: [] }, 'gmail'), []);
  const before = r.broker.executed.length;
  const res = await r.svc.run(r.caller({ grants }), { tool: 'GMAIL_DELETE_EMAIL', toolkit: 'gmail', arguments: { id: 'secret-subject-line' } });
  assert.equal(res.code, 'not_granted');
  assert.equal(r.broker.executed.length, before);
  const rows = r.svc.decisions.recent();
  const last = rows[rows.length - 1];
  assert.deepEqual([last.decision, last.reason, last.tool, last.blobId], ['deny', 'not_granted', 'GMAIL_DELETE_EMAIL', 'blob_a']);
  assert.ok(!JSON.stringify(rows).includes('secret-subject-line'), 'argument values are never logged');
  assert.deepEqual(last.argKeys, ['id']);
});

test('a blob with no app grant gets no app tools at all; with a grant it gets exactly three', () => {
  const r = rig();
  const mk = (grants: unknown) => appToolSpecs(r.svc, { blobId: 'b', permission: () => 'auto', grants: () => grants });
  assert.equal(mk({ mode: 'none', allow: [] }).length, 0);
  assert.equal(mk(undefined).length, 0);
  assert.deepEqual(mk({ mode: 'all', allow: [] }).map((s) => s.name), ['apps_connected', 'apps_tools', 'apps_run']);
});

test('model tools end to end: list, discover granted tools only, run with an explicit account', async () => {
  const r = rig(); r.connect('gmail', 'personal', 'ca_p'); r.connect('gmail', 'work', 'ca_w'); r.connect('slack');
  let grants: any = { mode: 'list', allow: ['GMAIL_FETCH_EMAILS'] };
  const specs = appToolSpecs(r.svc, { blobId: 'b', permission: () => 'auto', grants: () => grants });
  const t = (n: string) => specs.find((s) => s.name === n)!;
  const conn = await t('apps_connected').handler({});
  assert.match(conn.text, /gmail: personal, work/); assert.ok(!/slack/.test(conn.text), 'slack is not granted so it is not even mentioned');
  const tools = await t('apps_tools').handler({ toolkit: 'gmail' });
  assert.match(tools.text, /GMAIL_FETCH_EMAILS/); assert.ok(!/SEND_EMAIL|DELETE_EMAIL/.test(tools.text));
  const amb = await t('apps_run').handler({ tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '{"q":"x"}' });
  assert.equal(amb.isError, true); assert.match(amb.text, /Several gmail accounts.*"personal".*"work"/);
  const good = await t('apps_run').handler({ tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '{"q":"x"}', account: 'Work' });
  assert.equal(good.isError, undefined);
  assert.equal(r.broker.executed.at(-1).account_id, 'ca_w');
  assert.equal((await t('apps_run').handler({ tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments_json: '[1]' })).isError, true);
  grants = { mode: 'none', allow: [] }; // revoked mid-thread
  assert.match((await t('apps_run').handler({ tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', account: 'work' })).text, /do not have access/);
});

test('an unknown account label lists the real ones; a label from another app does not resolve', async () => {
  const r = rig(); r.connect('gmail', 'work', 'ca_w');
  const res = await r.svc.run(r.caller(), { tool: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', arguments: {}, account: 'home' });
  assert.equal(res.code, 'unknown_account'); assert.match(res.text, /"work"/);
});

// ---- outbound ----
test('outbound: send/post/delete ask even on Auto; deny and missing approver both fail closed; Full skips; reads never ask', async () => {
  const r = rig(); r.connect('gmail');
  const asked: string[] = [];
  const yes = async (q: { tool: string }) => { asked.push(q.tool); return true; };
  const no = async (q: { tool: string }) => { asked.push(q.tool); return false; };
  const run = (c: AppsCaller, tool: string) => r.svc.run(c, { tool, toolkit: 'gmail', arguments: { to: 'a@b.c' } });

  assert.equal((await run(r.caller({ permission: 'auto', approve: yes }), 'GMAIL_SEND_EMAIL')).ok, true);
  assert.deepEqual(asked, ['GMAIL_SEND_EMAIL']);
  const n = r.broker.executed.length;
  const denied = await run(r.caller({ permission: 'auto', approve: no }), 'GMAIL_DELETE_EMAIL');
  assert.equal(denied.ok, false); assert.equal(denied.code, 'denied'); assert.equal(r.broker.executed.length, n);
  const none = await run(r.caller({ permission: 'auto' }), 'GMAIL_SEND_EMAIL');
  assert.equal(none.code, 'denied'); assert.equal(r.broker.executed.length, n);
  assert.equal((await run(r.caller({ permission: 'ask', approve: yes }), 'GMAIL_FETCH_EMAILS')).ok, true);
  assert.deepEqual(asked, ['GMAIL_SEND_EMAIL', 'GMAIL_DELETE_EMAIL'], 'reads never ask');
  assert.equal((await run(r.caller({ permission: 'full' }), 'GMAIL_SEND_EMAIL')).ok, true, 'Full access skips the ask');
  const reasons = r.svc.decisions.recent().filter((x) => x.kind === 'decision').map((x) => `${x.tool}:${x.decision}:${x.reason}`);
  assert.deepEqual(reasons, ['GMAIL_SEND_EMAIL:allow:user_approved', 'GMAIL_DELETE_EMAIL:deny:user_denied', 'GMAIL_SEND_EMAIL:deny:no_approval_channel', 'GMAIL_FETCH_EMAILS:allow:granted', 'GMAIL_SEND_EMAIL:allow:full_access_skip']);
});

test('an approver that throws counts as a no', async () => {
  const r = rig(); r.connect('gmail');
  const res = await r.svc.run(r.caller({ approve: async () => { throw new Error('ui gone'); } }), { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments: {} });
  assert.equal(res.code, 'denied');
});

test('classifier table', () => {
  const out = (s: string) => classifyTool(s).outbound;
  for (const s of ['GMAIL_SEND_EMAIL', 'GMAIL_DELETE_EMAIL', 'SLACK_SEND_MESSAGE', 'SLACK_CHAT_POST_MESSAGE', 'GITHUB_CREATE_AN_ISSUE', 'GITHUB_MERGE_A_PULL_REQUEST', 'STRIPE_CREATE_CHARGE', 'GOOGLECALENDAR_CREATE_EVENT', 'NOTION_UPDATE_PAGE', 'GMAIL_SEND_DRAFT', 'LINEAR_DELETE_ISSUE', 'FOO_DO_THING', 'GOOGLEDOCS_FIND_AND_REPLACE'])
    assert.equal(out(s), true, s);
  for (const s of ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_LABELS', 'GMAIL_CREATE_EMAIL_DRAFT', 'GOOGLECALENDAR_EVENTS_LIST', 'SLACK_SEARCH_MESSAGES', 'GITHUB_GET_A_REPOSITORY', 'NOTION_SEARCH_NOTION_PAGE', 'LINEAR_LIST_LINEAR_ISSUES'])
    assert.equal(out(s), false, s);
  assert.equal(classifyTool('FOO_DO_THING', { readOnly: true }).outbound, false);
  assert.equal(classifyTool('FOO_SEND_THING', { readOnly: true }).outbound, true, 'a read-only hint never overrides a send verb');
});

// ---- revoke ----
test('disconnect revokes via the backend and drops the account', async () => {
  const r = rig(); r.connect('slack', null, 'ca_s');
  assert.deepEqual(await r.svc.disconnect('ca_s'), { removed: 1 });
  assert.equal((await r.svc.accounts()).length, 0);
  assert.ok(r.broker.calls.some((c) => c.m === 'DELETE' && c.p === '/v1/accounts/ca_s'));
});

// ---- secrets ----
test('file secret store is 0600 and rejects odd names; keychain store sends the value over stdin, never argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const f = new FileSecretStore(path.join(dir, 's'));
  await f.set('composio-byo-key', BYO_KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 's', 'composio-byo-key')).mode & 0o777, 0o600);
  assert.equal(await f.get('composio-byo-key'), BYO_KEY);
  await assert.rejects(() => f.set('../evil', 'x'));
  const seen: { args: string[]; stdin?: string }[] = [];
  const kc = new KeychainSecretStore('kora-apps-test', async (args, stdin) => { seen.push({ args, stdin }); return { code: 0, stdout: 'v\n' }; });
  await kc.set('composio-byo-key', BYO_KEY);
  assert.ok(!seen[0].args.join(' ').includes(BYO_KEY));
  assert.match(seen[0].stdin!, /add-generic-password -U -s kora-apps-test -a composio-byo-key -w ak_/);
  await assert.rejects(() => kc.set('composio-byo-key', 'a b; rm -rf /'));
  assert.equal(await kc.get('composio-byo-key'), 'v');
});

test('Windows Credential Manager store: value only over stdin (base64), target <service>/<name>, not found = null', async () => {
  const seen: { op: string; target: string; user: string; stdin?: string }[] = [];
  let stored: string | null = null;
  const cm = new WindowsCredentialSecretStore('kora-apps-test', async (op, target, user, stdin) => {
    seen.push({ op, target, user, stdin });
    if (op === 'set') { stored = stdin!; return { code: 0, stdout: '' }; }
    if (op === 'get') return stored ? { code: 0, stdout: stored + '\r\n' } : { code: 3, stdout: '' };
    stored = null; return { code: 0, stdout: '' };
  });
  assert.equal(await cm.get('composio-byo-key'), null);
  const odd = 'sk-ant-api03+/=~"$(rm${IFS}-rf${IFS}~)`;\'x';
  await cm.set('composio-byo-key', odd);
  const set = seen.find((s) => s.op === 'set')!;
  assert.equal(set.target, 'kora-apps-test/composio-byo-key');
  assert.equal(set.user, 'composio-byo-key');
  assert.equal(set.stdin, Buffer.from(odd, 'utf8').toString('base64'));
  assert.ok(!set.target.includes(odd) && !set.user.includes(odd));
  assert.equal(await cm.get('composio-byo-key'), odd);
  await cm.delete('composio-byo-key');
  assert.equal(await cm.get('composio-byo-key'), null);
  await assert.rejects(() => cm.set('../evil', BYO_KEY), /bad secret name/);
  await assert.rejects(() => cm.set('composio-byo-key', 'a b'), /valid key/);
  const refused = new WindowsCredentialSecretStore('kora-apps-test', async () => ({ code: 4, stdout: '' }));
  await assert.rejects(() => refused.set('composio-byo-key', BYO_KEY), /Credential Manager/);
  assert.equal(await refused.get('composio-byo-key'), null);
});

test('defaultSecretStore: Keychain on macOS, Credential Manager on Windows, a file elsewhere or when forced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const prev = process.env.KORA_APPS_VAULT;
  delete process.env.KORA_APPS_VAULT;
  try {
    assert.equal(defaultSecretStore(dir, 'darwin').kind, 'keychain+file');
    assert.equal(defaultSecretStore(dir, 'win32').kind, 'credman+file');
    assert.equal(defaultSecretStore(dir, 'linux').kind, 'file');
    process.env.KORA_APPS_VAULT = 'file';
    assert.equal(defaultSecretStore(dir, 'win32').kind, 'file');
  } finally { if (prev === undefined) delete process.env.KORA_APPS_VAULT; else process.env.KORA_APPS_VAULT = prev; }
});

// The real PowerShell + advapi32 round trip. Windows only (CI's runner): it writes, reads and deletes one throwaway
// credential under its own random service, never a real one.
test('Windows Credential Manager store: real round trip', { skip: process.platform !== 'win32' && 'needs Windows (Credential Manager)' }, async () => {
  const cm = new WindowsCredentialSecretStore(`kora-apps-citest-${process.pid}-${Date.now().toString(36)}`);
  const v = 'ci-test-value+/=~' + Date.now();
  try {
    await cm.set('round-trip', v);
    assert.equal(await cm.get('round-trip'), v);
  } finally { await cm.delete('round-trip'); }
  assert.equal(await cm.get('round-trip'), null);
});

test('CAP_MESSAGE text', () => {
  assert.match(CAP_MESSAGE(750, 750, Date.UTC(2026, 10, 1)), /750\/750.*Kora Pro \(coming soon\).*2026-11-01/);
});

// The Engines service (Settings > Engines): config file with no secrets, ACP overrides + custom CLIs, API endpoints
// (https rule, preset defaults), write-only keys through a store, explicit executables, accounts, the route table and
// the picker list. Unavailable engines are rows with a reason, never missing or thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { Engines } from './engines';
import { MemorySecretStore } from '../blobs/apps/secrets';
import { ClaudeAccounts } from '../session/claude-accounts';
import { engineBinaryOverride, resetEngineBinaryCacheForTests } from '../detect/engine-binary';
// Windows runs only files with a PATHEXT extension.
const EXE = process.platform === 'win32' ? '.exe' : '';

function make(over: Partial<ConstructorParameters<typeof Engines>[0]> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-'));
  const secrets = new MemorySecretStore();
  const e = new Engines({ home, secrets, accounts: new ClaudeAccounts({ home, status: async () => ({ code: 1, stdout: '{"loggedIn":false}' }) }), detect: { resolve: () => null }, resolveOpencode: () => null, ...over });
  return { e, home, secrets };
}

test('ACP: built-ins are listed with a reason when missing; overrides and custom CLIs persist; ids are validated', async () => {
  const { e, home } = make();
  const v = await e.view();
  const grok = v.acp.find((a) => a.agentId === 'grok')!;
  assert.equal(grok.status.available, false);
  assert.match(grok.status.reason!, /grok.*not found.*Settings > Engines/);
  assert.deepEqual(grok.args, ['agent', 'stdio']);
  assert.equal(grok.custom, false);
  assert.equal(v.acp.some((a) => a.agentId === 'gemini'), false, 'Gemini CLI is no longer a built-in row');

  const fake = path.join(home, 'my-agent'); fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
  e.acpSave({ agentId: 'acp-mine', label: 'Mine', command: 'my-agent', executable: fake, args: ['--stdio'] });
  e.acpSave({ agentId: 'grok', args: ['agent', 'stdio', '--debug'] });
  const v2 = await e.view();
  const mine = v2.acp.find((a) => a.agentId === 'acp-mine')!;
  assert.equal(mine.status.available, true);
  assert.equal(mine.custom, true);
  assert.deepEqual(v2.acp.find((a) => a.agentId === 'grok')!.args, ['agent', 'stdio', '--debug']);
  assert.deepEqual(v2.acp.find((a) => a.agentId === 'grok')!.defaultArgs, ['agent', 'stdio']);
  assert.equal(e.acpEngine('acp-mine')?.executable, fake);
  assert.deepEqual(e.route('acp-mine'), { driver: 'acp-mine', koraAgent: 'acp-mine' });
  assert.equal(e.route('claude'), null);
  assert.equal(e.route('nonsense'), null);

  assert.throws(() => e.acpSave({ agentId: 'evil', label: 'x', command: 'x' }), /acp-my-agent/);
  assert.throws(() => e.acpSave({ agentId: 'acp-x', label: '', command: '' }), /name and a command/);
  assert.throws(() => e.acpSave({ agentId: 'grok', executable: 'relative/path' }), /absolute/);

  e.acpRemove('grok'); // a built-in only loses its overrides
  assert.deepEqual((await e.view()).acp.find((a) => a.agentId === 'grok')!.args, ['agent', 'stdio']);
  e.acpRemove('acp-mine');
  assert.ok(!(await e.view()).acp.some((a) => a.agentId === 'acp-mine'));
  assert.ok(fs.existsSync(path.join(home, 'engines.json')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'engines.json')).mode & 0o777, 0o600);
});

test('ACP: idle minutes are bounded; the driver gets them in ms', () => {
  const { e } = make();
  assert.equal(e.idleMs(), 10 * 60_000);
  e.setIdleMinutes(3);
  assert.equal(e.idleMs(), 180_000);
  assert.throws(() => e.setIdleMinutes(0), /between 1 and 240/);
  assert.throws(() => e.setIdleMinutes(9999), /between 1 and 240/);
});

test('API: https for remote hosts, http only for localhost; presets fill the URL; a missing key is a reason, not an error', async () => {
  const { e } = make();
  assert.throws(() => e.apiSave({ id: 'x', baseUrl: 'http://api.example.com/v1' }), /https/);
  assert.throws(() => e.apiSave({ id: 'Bad Id', baseUrl: 'https://x.com' }), /lowercase/);
  const groq = e.apiSave({ id: 'groq' }); // preset: no URL typed
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(groq.agentId, 'api-groq');
  e.apiSave({ id: 'lm', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' });
  const v = await e.view();
  const g = v.endpoints.find((x) => x.id === 'groq')!;
  assert.equal(g.status.available, false);
  assert.equal(g.status.needsKey, true);
  assert.match(g.status.reason!, /needs an API key/);
  assert.equal(v.endpoints.find((x) => x.id === 'lm')!.status.available, true, 'a local server needs no key');
  assert.deepEqual(e.route('api-groq'), { driver: 'api-groq', koraAgent: 'api-groq' });
  assert.ok(v.presets.some((p) => p.id === 'openrouter'));
});

test('API: a key goes to the store, never to engines.json or a view; Test sends GET /models only', async () => {
  const seen: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization as string | undefined, body });
      if (req.headers.authorization !== 'Bearer sk-test-123456') { res.statusCode = 401; return res.end('{"error":"bad key"}'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { e, home, secrets } = make();
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
    e.apiSave({ id: 'fake', label: 'Fake', baseUrl: url, requiresKey: true });
    const bad = await e.apiTest('fake', 'sk-wrong-000000');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /rejected the API key|key/i);
    const good = await e.apiTest('fake', 'sk-test-123456');
    assert.equal(good.ok, true);
    assert.equal(good.modelCount, 2);
    assert.ok(seen.every((s) => s.method === 'GET' && s.url.endsWith('/models') && s.body === ''), 'a Test is a model-list GET: no chat, no body');
    assert.equal(await e.keys.has('fake'), false, 'testing a typed key does not save it');

    await e.apiSetKey('fake', 'sk-test-123456');
    assert.equal(await secrets.get('api-fake'), 'sk-test-123456');
    assert.equal((await e.apiTest('fake')).ok, true, 'the saved key is used');
    const v = await e.view();
    assert.equal(v.endpoints[0]!.hasKey, true);
    assert.ok(!JSON.stringify(v).includes('sk-test-123456'), 'no key in a view');
    assert.ok(!fs.readFileSync(path.join(home, 'engines.json'), 'utf8').includes('sk-test'), 'no key in engines.json');
    assert.deepEqual((await e.pickerEngines()).find((p) => p.id === 'api-fake')!.models.map((m) => m.id), ['m-one', 'm-two']);

    await e.apiClearKey('fake');
    assert.equal(await e.keys.has('fake'), false);
    await e.apiSetKey('fake', 'sk-test-123456');
    await e.apiRemove('fake');
    assert.equal(await secrets.get('api-fake'), null, 'removing an endpoint removes its key');
    await assert.rejects(() => e.apiSetKey('fake', 'x'), /not set up/);
  } finally { srv.close(); }
});

test('executables: an explicit path wins, a bad one is a reason, and Codex / Claude resolve through it', () => {
  resetEngineBinaryCacheForTests();
  const { e, home } = make();
  const codex = path.join(home, `codex${EXE}`); fs.writeFileSync(codex, '#!/bin/sh\n', { mode: 0o755 });
  const st = e.setExecutable('codex', codex);
  assert.equal((st as any).available, true);
  assert.equal(engineBinaryOverride('codex'), codex);
  const bad = e.setExecutable('claude', path.join(home, 'missing'));
  assert.equal((bad as any).available, false);
  assert.match((bad as any).reason, /does not exist or is not executable/);
  assert.throws(() => e.setExecutable('codex', 'codex'), /absolute/);
  e.setExecutable('codex', null);
  assert.equal(engineBinaryOverride('codex'), null);
  e.setExecutable('claude', null);
  resetEngineBinaryCacheForTests();
});

test('accounts: add creates an empty folder and the sign-in command; Check reads status; nothing is copied or rotated', async () => {
  const { e, home } = make();
  const a = e.accountAdd({ name: 'work', label: 'Work' });
  assert.match(a.signInCommand, /CLAUDE_CONFIG_DIR=.*claude auth login/);
  assert.deepEqual(fs.readdirSync(a.configDir), [], 'an empty folder: no login was copied');
  assert.throws(() => e.accountAdd({ name: 'work' }), /already exists/);
  assert.throws(() => e.accountAdd({ name: 'Bad Name' }), /lowercase/);
  const v = await e.view();
  assert.equal(v.accounts[0]!.signIn, 'signed-out');
  assert.deepEqual(e.accountList(), [{ name: 'work', label: 'Work' }]);
  assert.deepEqual(e.accounts.env('work'), { CLAUDE_CONFIG_DIR: a.configDir });
  assert.deepEqual(e.accounts.env(null), {}, 'the default login sets nothing');
  assert.ok(!('HOME' in e.accounts.env('work')), 'never a fake HOME');
  e.accountRename('work', 'Work (Acme)');
  assert.equal(e.accountList()[0]!.label, 'Work (Acme)');
  e.accountRemove('work');
  assert.equal(e.accountList().length, 0);
  assert.equal(fs.existsSync(a.configDir), false, 'the folder Kora made for it goes with the account (pl9 S2-2; a Keychain login is not touched)');
  void home;
});

test('acpModels: the discovered list feeds the picker; a failure is a sentence', async () => {
  const { e } = make({ discoverModels: async (eng) => (eng.agentId === 'grok' ? { models: [{ id: 'g-pro', name: 'Gemini Pro' }], current: 'g-pro' } : { models: [], current: null, error: 'It did not answer.' }) });
  const fake = path.join(os.tmpdir(), 'engines-fake-bin'); fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
  e.acpSave({ agentId: 'grok', executable: fake });
  const ok = await e.acpModels('grok');
  assert.deepEqual(ok.models, [{ id: 'g-pro', name: 'Gemini Pro' }]);
  const p = (await e.pickerEngines()).find((x) => x.id === 'grok')!;
  assert.equal(p.available, true);
  assert.deepEqual(p.models.map((m) => m.id), ['g-pro']);
  assert.equal(p.defaultModel, 'g-pro');
  assert.match((await e.acpModels('nope')).error!, /not set up/);
});

test('the picker lists installed ACP agents and every configured endpoint, unavailable ones with their reason', async () => {
  const { e } = make();
  e.apiSave({ id: 'groq' });
  const p = await e.pickerEngines();
  assert.ok(!p.some((x) => x.family === 'acp'), 'ACP agents that are not installed are not offered');
  const g = p.find((x) => x.id === 'api-groq')!;
  assert.equal(g.available, false);
  assert.match(g.reason!, /needs an API key/);
  e.acpSave({ agentId: 'acp-custom', label: 'Custom', command: 'nothing-here' });
  const c = (await e.pickerEngines()).find((x) => x.id === 'acp-custom')!;
  assert.equal(c.available, false, 'a custom agent is listed even when missing');
  assert.match(c.reason!, /not found/);
});

test('the Keychain store takes any provider key: odd characters travel hex-encoded, spaces and control characters are refused', async () => {
  const { KeychainSecretStore } = await import('../blobs/apps/secrets');
  const seen: Array<{ args: string[]; stdin?: string }> = [];
  const kc = new KeychainSecretStore('kora-apps-test', async (args, stdin) => { seen.push({ args, stdin }); return { code: 0, stdout: '' }; });
  const key = 'sk-ant-api03-AbC+/=~!@#$%^&*()_xyz';
  await kc.set('api-anthropic-api', key);
  assert.ok(!seen[0]!.args.join(' ').includes(key));
  assert.match(seen[0]!.stdin!, /^add-generic-password -U -s kora-apps-test -a api-anthropic-api -X [0-9a-f]+\n$/);
  assert.equal(Buffer.from(seen[0]!.stdin!.match(/-X ([0-9a-f]+)/)![1]!, 'hex').toString('utf8'), key);
  await kc.set('api-groq', 'gsk_abcdefgh12345678'); // the old safe set keeps its plain form
  assert.match(seen[1]!.stdin!, /-w gsk_abcdefgh12345678/);
  await assert.rejects(() => kc.set('api-x', 'has a space in it'), /valid key/);
  await assert.rejects(() => kc.set('api-x', 'line\nbreak-in-the-key'), /valid key/);
  await assert.rejects(() => kc.set('api-x', 'short'), /valid key/);
});

test('ACP start failure: the engine is parked with its reason (status + picker), survives a restart, only a re-check clears it, discovery never runs on its own', async () => {
  let probes = 0;
  const fake = (home: string) => { const f = path.join(home, 'gem'); fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); return f; };
  const { e, home } = make({ discoverModels: async () => { probes++; return { models: [], current: null, error: 'This client is no longer supported.', failed: true }; } });
  e.acpSave({ agentId: 'grok', executable: fake(home) });
  assert.equal((await e.pickerEngines()).find((x) => x.id === 'grok')?.available, true);
  e.acpMarkFailed('grok', 'Gemini CLI reports: no longer supported.');
  const row = (await e.view()).acp.find((a) => a.agentId === 'grok')!;
  assert.equal(row.status.available, false); assert.match(row.status.reason!, /no longer supported/);
  assert.equal((await e.pickerEngines()).some((x) => x.id === 'grok'), false, 'a parked built-in is not selectable');
  assert.equal(e.acpBlocked('grok') !== null, true);
  // a restart remembers
  const again = new Engines({ home, secrets: new MemorySecretStore(), detect: { resolve: () => null }, resolveOpencode: () => null });
  assert.match(again.acpBlocked('grok')!, /no longer supported/);
  assert.equal(probes, 0, 'nothing probed the agent on its own');
  // the user's re-check
  e.acpRecheck();
  assert.equal(e.acpBlocked('grok'), null);
  assert.equal((await e.pickerEngines()).find((x) => x.id === 'grok')?.available, true);
  // the explicit Discover click is a re-check + one probe; a failing probe parks it again
  const r = await e.acpModels('grok');
  assert.equal(probes, 1); assert.equal((r as any).failed, undefined); assert.match(r.error!, /no longer supported/);
  assert.match(e.acpBlocked('grok')!, /did not start/);
});

test('OpenCode: Engines finds the copy Swarm uses when there is no `opencode` on PATH (pl9 S2-3)', async () => {
  const own = '/Users/x/.kora/tools/opencode/current/opencode';
  const { e } = make({ resolveOpencode: () => own });
  const native = (await e.nativeStatus()).find((s) => s.id === 'opencode')!;
  assert.equal(native.available, true);
  assert.equal(native.executable, own);
  const acp = (await e.view()).acp.find((a) => a.agentId === 'acp-opencode')!;
  assert.equal(acp.status.available, true);
  // Without Kora's copy either, it still says what is missing.
  const { e: none } = make();
  assert.equal((await none.nativeStatus()).find((s) => s.id === 'opencode')!.available, false);
});

test('Antigravity is a built-in engine found as `agy` (PATH or an explicit path); not installed = a row with a reason', async () => {
  const found = '/Users/x/.local/bin/agy';
  const { e } = make({ detect: { resolve: (n) => (n === 'agy' ? found : null) } });
  const row = (await e.nativeStatus()).find((s) => s.id === 'antigravity')!;
  assert.deepEqual(row, { id: 'antigravity', label: 'Antigravity', family: 'antigravity', available: true, executable: found });
  const { e: none, home } = make();
  const missing = (await none.nativeStatus()).find((s) => s.id === 'antigravity')!;
  assert.equal(missing.available, false);
  assert.match(missing.reason!, /`agy` was not found.*Install Antigravity/);
  // an explicit path wins and reaches the driver's resolver
  const exe = path.join(home, `agy${EXE}`); fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  const set = none.setExecutable('antigravity', exe);
  assert.equal(set.available, true);
  assert.equal(engineBinaryOverride('agy'), exe);
  none.setExecutable('antigravity', null);
  assert.equal(engineBinaryOverride('agy'), null);
  resetEngineBinaryCacheForTests();
});

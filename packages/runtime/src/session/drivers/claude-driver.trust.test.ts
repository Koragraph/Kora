// Folder trust in the Claude SDK chat lane: an untrusted folder never loads the repo's own Claude settings.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, buildSessionOptions, untrustedKoraHooks, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import { trustFolder, _resetTrustCacheForTests } from '../../trust/store';

// Kora's compaction point rides in every session's flag settings env (buildSessionOptions); these checks are about the rest.
const noEnv = (s: any) => { if (!s) return s; const { env: _env, ...rest } = s; return Object.keys(rest).length ? rest : undefined; };

function fakeQuery() {
  const control = { options: undefined as any };
  const iterator: any = {
    next: () => new Promise(() => {}),
    async return() { return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return this; },
    interrupt: () => Promise.resolve(), setModel: () => Promise.resolve(), setPermissionMode: () => Promise.resolve(),
  };
  return { iterator, control };
}

function makeDriver(over: Partial<DriverDeps> = {}) {
  const fake = fakeQuery();
  const queryFn: QueryFn = (params) => { fake.control.options = params.options; return fake.iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }),
    spawnWorker: async (p) => ({ id: 'p1', agent: p.agent, account: null }),
    spawnEnv: () => ({}),
    appendSystemPrompt: () => undefined,
    prepareSession: async (i) => ({ env: { KORA_PANE_ID: `chat:${i.threadId}`, KORA_BIN: '/opt/kora/bin/kora.js' }, appendSystemPrompt: 'RULEBOOK', notes: ['ok'] }),
    ...over,
  };
  return { driver: new ClaudeDriver(deps, queryFn), fake };
}

test('untrusted folder: only user settings, Kora hooks as flag settings, strict MCP', async () => {
  const { driver, fake } = makeDriver({ isFolderTrusted: () => false });
  await driver.startSession({ threadId: 'U1', agent: 'claude', cwd: '/some/clone', account: null });
  const o = fake.control.options;
  assert.deepEqual(o.settingSources, ['user'], 'no project/local settings: the repo .claude hooks never load');
  assert.equal(o.strictMcpConfig, true, 'project .mcp.json servers stay out');
  const hooks = o.settings?.hooks;
  assert.ok(hooks, 'Kora hooks are injected as flag settings');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
    const cmd = hooks[ev]?.[0]?.hooks?.[0]?.command as string;
    assert.match(cmd, /kora\.js\}?"? hook /, `${ev} runs only kora's own hook`);
    assert.ok(cmd.includes('/opt/kora/bin/kora.js'), 'built from this install, not read from the repo');
  }
  await driver.stopSession('U1').catch(() => {});
});

test('trusted folder: exactly as before (user + project + local, no injected settings)', async () => {
  const { driver, fake } = makeDriver({ isFolderTrusted: () => true });
  await driver.startSession({ threadId: 'T1', agent: 'claude', cwd: '/some/repo', account: null });
  const o = fake.control.options;
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(noEnv(o.settings), undefined);
  assert.equal(o.strictMcpConfig, undefined, 'strict MCP follows the preparation, as before');
  await driver.stopSession('T1').catch(() => {});
});

test('without an injected check the persistent trust store decides', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-trust-drv-'));
  const prev = process.env.KORA_HOME; process.env.KORA_HOME = path.join(home, 'kora');
  try {
    const repo = path.join(home, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const a = makeDriver();
    await a.driver.startSession({ threadId: 'S1', agent: 'claude', cwd: repo, account: null });
    assert.deepEqual(a.fake.control.options.settingSources, ['user'], 'new folder: restricted');
    trustFolder(repo); _resetTrustCacheForTests();
    const b = makeDriver();
    await b.driver.startSession({ threadId: 'S2', agent: 'claude', cwd: path.join(repo), account: null });
    assert.deepEqual(b.fake.control.options.settingSources, ['user', 'project', 'local'], 'after trust: full settings');
    await a.driver.stopSession('S1').catch(() => {}); await b.driver.stopSession('S2').catch(() => {});
  } finally {
    if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildSessionOptions fails closed when trust is not stated; no prep → no injected hooks', () => {
  const o = buildSessionOptions({ threadId: 'T', agent: 'claude', cwd: '/r', account: null } as any, null, undefined, {}, { mcpServers: {}, canUseTool: null });
  assert.deepEqual(o.settingSources, ['user']);
  assert.equal(noEnv(o.settings), undefined, 'an unprepared session (home / system folder) gets no Kora hooks, as before');
  assert.equal(untrustedKoraHooks({ env: {}, notes: [] }), null, 'no rulebook ⇒ the enforcer skipped this folder');
});

test('every session carries Kora\'s compaction point as flag settings env (a user env block would beat the process env)', async () => {
  const { driver, fake } = makeDriver({ isFolderTrusted: () => true });
  await driver.startSession({ threadId: 'E1', agent: 'claude', cwd: '/some/repo', account: null, model: { model: 'claude-opus-5-5' } });
  assert.equal(fake.control.options.settings?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
  await driver.stopSession('E1').catch(() => {});
});

// Kora-started Claude sessions: "default" is not sent to the SDK (it is Opus there), the compaction window rides in the
// env, and the composer's per-turn model is not set again when nothing changed (aud3 S1-1, S1-2, S3-5).
import { test } from 'node:test';
import assert from 'node:assert';
import { buildSessionOptions, ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

const input = (model?: string) => ({ threadId: 'C', agent: 'claude', cwd: '/r', account: null, ...(model ? { model: { provider: 'claude', model } } : {}) }) as never;
const extra = { mcpServers: {}, canUseTool: () => {}, trusted: true };

test('"default" is rewritten (never sent as --model default); an explicit Opus pick is untouched', () => {
  const d = buildSessionOptions(input('default'), null, undefined, {}, extra);
  assert.notEqual(d.model, 'default');
  assert.ok(typeof d.model === 'string' && d.model.length > 0);
  assert.equal(buildSessionOptions(input('opus'), null, undefined, {}, extra).model, 'opus');
  assert.equal(buildSessionOptions(input('claude-opus-5-5'), null, undefined, {}, extra).model, 'claude-opus-5-5');
  assert.equal(buildSessionOptions(input(), null, undefined, {}, extra).model, undefined);
});

test('the account config dir decides what Default follows', () => {
  const d = buildSessionOptions(input('default'), null, undefined, { CLAUDE_CONFIG_DIR: '/nonexistent/claude-acct' }, extra);
  assert.equal(d.model, 'sonnet');
});

test('an unchanged per-turn model is not set again, a changed one is', async () => {
  const sets: (string | undefined)[] = [];
  const iterator: any = {
    next: () => new Promise(() => {}), async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; },
    interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async (m?: string) => { sets.push(m); },
  };
  const queryFn: QueryFn = () => iterator;
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async (p) => ({ id: 'p', agent: p.agent, account: null }),
    spawnEnv: () => ({ CLAUDE_CONFIG_DIR: '/nonexistent/claude-acct' }), appendSystemPrompt: () => undefined, isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  await driver.startSession(input('default'));
  await driver.sendTurn({ threadId: 'C', text: 'a', model: { provider: 'claude', model: 'default' } } as never);
  await driver.sendTurn({ threadId: 'C', text: 'b', model: { provider: 'claude', model: 'default' } } as never);
  assert.deepEqual(sets, [], 'same model: no setModel');
  assert.equal(events.filter((e) => e.type === 'model.rerouted').length, 0);
  await driver.sendTurn({ threadId: 'C', text: 'c', model: { provider: 'claude', model: 'opus' } } as never);
  assert.deepEqual(sets, ['opus']);
  assert.equal(events.filter((e) => e.type === 'model.rerouted').length, 1);
  await driver.stopSession?.('C');
});

test('an untouched composer sends the Medium it shows; an explicit effort and Haiku are left alone', () => {
  assert.equal(buildSessionOptions(input('sonnet'), null, undefined, {}, extra).effort, 'medium');
  assert.equal(buildSessionOptions({ ...(input('sonnet') as object), model: { provider: 'claude', model: 'sonnet', effort: 'high' } } as never, null, undefined, {}, extra).effort, 'high');
  assert.equal(buildSessionOptions(input('claude-haiku-5-5'), null, undefined, {}, extra).effort, undefined);
  assert.equal(buildSessionOptions(input(), null, undefined, {}, extra).effort, undefined);
});

test('A3-6: Default that follows a Haiku setting sends no effort (Haiku has none)', () => {
  const fs = require('node:fs') as typeof import('node:fs'); const os = require('node:os') as typeof import('node:os'); const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'haiku' }));
    const o = buildSessionOptions(input('default'), null, undefined, { CLAUDE_CONFIG_DIR: dir }, extra);
    assert.equal(o.model, 'haiku');
    assert.equal(o.effort, undefined);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    assert.equal(buildSessionOptions(input('default'), null, undefined, { CLAUDE_CONFIG_DIR: dir }, extra).effort, 'medium');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

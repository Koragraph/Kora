// A refused live model switch shows one calm line; the CLI's catalog internals stay in the log (plv S3-3).
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, friendlyModelName, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

test('friendlyModelName', () => {
  assert.equal(friendlyModelName('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(friendlyModelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(friendlyModelName('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(friendlyModelName('sonnet'), 'Sonnet');
  assert.equal(friendlyModelName('gpt-5.4'), 'gpt-5.4');
});

test('setModel refused: resolve false, warn in plain words, no CLI internals in the message', async () => {
  const iterator: any = {
    next: () => new Promise(() => {}), async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; },
    interrupt: async () => {}, setPermissionMode: async () => {},
    setModel: async () => { throw new Error("claude-haiku-5-5 isn't described by this version's model catalog; update Claude Code, or map it with behavesAs on a modelPicker row (or modelOverrides)"); },
  };
  const queryFn: QueryFn = () => iterator;
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async (p) => ({ id: 'p', agent: p.agent, account: null }),
    spawnEnv: () => ({}), appendSystemPrompt: () => undefined, isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  await driver.startSession({ threadId: 'M', agent: 'claude', cwd: '/r', account: null, model: { model: 'claude-sonnet-5-5' } });
  await driver.sendTurn({ threadId: 'M', text: 'hi' });
  const ok = await driver.setModel('M', { provider: 'claude', model: 'claude-opus-5-5' } as never);
  assert.equal(ok, false);
  const warn = events.find((e) => e.type === 'runtime.warning') as { message: string } | undefined;
  assert.equal(warn?.message, 'Switching to Opus 5.5 restarts the session before your next message.');
  await driver.stopSession?.('M');
});

test('setModel across a compaction point (Haiku 5.5 compacts at 100k): restart, never a live switch', async () => {
  const sets: (string | undefined)[] = [];
  const iterator: any = {
    next: () => new Promise(() => {}), async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; },
    interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async (m?: string) => { sets.push(m); },
  };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async (p) => ({ id: 'p', agent: p.agent, account: null }),
    spawnEnv: () => ({}), appendSystemPrompt: () => undefined, isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, () => iterator);
  await driver.startSession({ threadId: 'H', agent: 'claude', cwd: '/r', account: null, model: { model: 'claude-haiku-5-5' } });
  assert.equal(await driver.setModel('H', { model: 'claude-opus-5-5' }), false);
  assert.deepEqual(sets, [], 'no live switch');
  await driver.stopSession?.('H');
});

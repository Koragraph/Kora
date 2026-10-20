// ClaudeDriver: a Kora notice turn skips graph injection; a pending mode notice is prepended to the user's prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';

const EXPLORE = '3 match(es) for "buildDriver". Focus: 1 symbol(s).\n\n■ METHOD buildDriver @ src/session/session-manager.ts:80 — buildDriver(input)\n  callers: startSession@src/session/session-manager.ts:120\n';

function makeDriver() {
  let prompt: AsyncGenerator<any> | null = null;
  const iterator: any = {
    next: () => new Promise(() => {}),
    return: async () => ({ value: undefined, done: true }),
    [Symbol.asyncIterator]() { return this; },
  };
  const queryFn: QueryFn = (params: any) => { prompt = params.prompt; return iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: EXPLORE, data: null, ms: 1 }),
    graphStatus: async () => ({ indexed: true }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }),
    spawnEnv: () => ({}),
    appendSystemPrompt: () => undefined,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const nextPrompt = async (): Promise<string> => (await prompt!.next()).value.message.content;
  return { driver, nextPrompt };
}

test('an origin:kora-notice turn is sent verbatim — no graph injection', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const { driver, nextPrompt } = makeDriver();
  const threadId = `N-${process.pid}-${Date.now()}`;
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  const text = '[kora] worker p4 wrote its report. how does buildDriver pick a driver?';
  await driver.sendTurn({ threadId, text, origin: 'kora-notice' });
  assert.equal(await nextPrompt(), text);
});

test('koraNotice rides ahead of the user prompt; injection is computed on the user text only', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const { driver, nextPrompt } = makeDriver();
  const threadId = `K-${process.pid}-${Date.now()}`;
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  const notice = '[kora] User has switched to Swarm mode. Load /koraswarm.';
  await driver.sendTurn({ threadId, text: 'how does buildDriver pick a driver?', koraNotice: notice });
  const sent = await nextPrompt();
  assert.ok(sent.startsWith(`${notice}\n\n`), sent.slice(0, 120));
  assert.ok(sent.endsWith('how does buildDriver pick a driver?'));
});

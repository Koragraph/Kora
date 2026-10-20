// ClaudeDriver on a RESUMED session: the SDK first replays a zero-usage result for whatever the old process left
// running (found live in the swarm e2e — a mode flip mid-turn). That leftover must not settle the new turn.
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';

function makeDriver(script: any[]) {
  let i = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const iterator: any = {
    // The SDK only answers once the prompt went in: hold the scripted messages until sendTurn released them.
    next: async () => { await gate; return i < script.length ? { value: script[i++], done: false } : new Promise(() => {}); },
    return: async () => ({ value: undefined, done: true }),
    [Symbol.asyncIterator]() { return this; },
  };
  const queryFn: QueryFn = () => iterator;
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }),
    graphStatus: async () => ({ indexed: false }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }),
    spawnEnv: () => ({}),
    appendSystemPrompt: () => undefined,
  };
  return { driver: new ClaudeDriver(deps, queryFn), release: () => release!() };
}

const leftover = { type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 0, output_tokens: 0 } };
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'TWO' }], usage: { input_tokens: 10, output_tokens: 2 } } };
const real = { type: 'result', subtype: 'success', is_error: false, result: 'TWO', usage: { input_tokens: 10, output_tokens: 2 } };

async function settles(script: any[], resume: string | undefined): Promise<any[]> {
  process.env.KORA_INJECT_LOG = '0';
  const { driver, release } = makeDriver(script);
  const threadId = `R-${process.pid}-${Date.now()}-${Math.random()}`;
  const events: any[] = [];
  driver.streamEvents((e: any) => { if (e.threadId === threadId || !e.threadId) events.push(e); });
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null, ...(resume ? { resume } : {}) });
  await driver.sendTurn({ threadId, text: 'Reply with exactly: TWO' });
  release();
  await new Promise((r) => setTimeout(r, 50));
  return events.filter((e) => e.type === 'turn.settled');
}

test('a resumed session’s leftover zero-usage result does not settle the new turn; the real result does', async () => {
  const settled = await settles([leftover, assistant, real], 'provider-session-1');
  assert.equal(settled.length, 1, JSON.stringify(settled));
  assert.equal(settled[0].turnId?.startsWith('turn_'), true);
});

test('a fresh (not resumed) session settles on its first result, as before', async () => {
  const settled = await settles([leftover], undefined);
  assert.equal(settled.length, 1);
});

// F7 (2026-10-02): turn ids came from a per-process counter, so after every daemon restart new turns were `turn_1`
// again and the timeline folded them into the old turn_1's rows (a compaction row vanished). A fresh driver — what a
// restarted daemon builds — must never hand out an id an earlier driver already used.
test('turn ids stay unique across driver instances (daemon restarts)', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const seen = new Set<string>();
  for (let restart = 0; restart < 3; restart++) {
    const { driver, release } = makeDriver([assistant, real, assistant, real]);
    const threadId = 'same-thread';
    const ids: string[] = [];
    driver.streamEvents((e: any) => { if (e.type === 'turn.started') ids.push(e.turnId); });
    await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null, resume: 'provider-session-1' });
    await driver.sendTurn({ threadId, text: 'one' });
    release();
    await new Promise((r) => setTimeout(r, 20));
    await driver.sendTurn({ threadId, text: 'two' });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ids.length >= 2, JSON.stringify(ids));
    for (const id of ids) {
      assert.match(id, /^turn_[0-9a-z]+$/);
      assert.ok(!seen.has(id), `turn id ${id} reused after a restart`);
      seen.add(id);
    }
  }
});

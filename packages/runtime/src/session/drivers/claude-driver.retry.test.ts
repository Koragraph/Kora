// B7 (night 2026-10-04): with no network Claude Code retries every request 10 times (~3 min of backoff) and only then
// fails the turn. Kora dropped its `system/api_retry` messages, so the user sat on a silent spinner. Now the first retry
// of a turn says what is happening, once — not once per retry.
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, describeApiRetry, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

// Recorded from the bundled Claude Code (SDK 0.3.286) with HTTPS_PROXY pointing at a dead port.
const RETRY = (attempt: number, delay: number) => ({
  type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: delay, error_status: null, error: 'unknown',
  session_id: '1f2e42ad-38ed-4c09-b685-ddc7ae7375e4', uuid: `u-${attempt}`,
});

function makeDriver() {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  const iterator: any = {
    async next() {
      while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      return { value: queue.shift(), done: false };
    },
    return: async () => ({ value: undefined, done: true }),
    [Symbol.asyncIterator]() { return this; },
  };
  const feed = (...msgs: any[]) => { queue.push(...msgs); const w = wake; wake = null; w?.(); };
  const queryFn: QueryFn = () => iterator;
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }),
    graphStatus: async () => ({ indexed: false }),
    spawnWorker: async () => ({ id: 'p', agent: 'claude', account: null }),
    spawnEnv: () => ({}),
    appendSystemPrompt: () => undefined,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  return { driver, feed, events };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('api_retry during a turn: one calm "can\'t reach Claude" line for the turn, not one per retry', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const { driver, feed, events } = makeDriver();
  const threadId = `R-${process.pid}-${Date.now()}`;
  await driver.startSession({ threadId, agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId, text: 'say hi' });
  const turn = events.find((e) => e.type === 'turn.started')!.turnId;
  feed(RETRY(1, 520), RETRY(2, 1167), RETRY(3, 2274));
  await tick();
  const warnings = events.filter((e) => e.type === 'runtime.warning');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const w = warnings[0] as Extract<ChatEvent, { type: 'runtime.warning' }>;
  assert.equal(w.turnId, turn);
  assert.match(w.message, /Can't reach Claude/);
  assert.match(w.message, /internet connection/);
  assert.match(w.message, /press Stop to give up/);
  assert.ok(w.message.length <= 100, `one work-log row: ${w.message.length} chars`);
  // The turn is still open: retries are not a verdict.
  assert.equal(events.some((e) => e.type === 'turn.settled'), false);

  // A later turn that also hits retries gets its own single line.
  feed({ type: 'result', subtype: 'success', is_error: false, result: 'hi', usage: { input_tokens: 1, output_tokens: 1 } });
  await tick();
  await driver.sendTurn({ threadId, text: 'again' });
  feed(RETRY(1, 500), RETRY(2, 1000));
  await tick();
  assert.equal(events.filter((e) => e.type === 'runtime.warning').length, 2);
});

test('describeApiRetry names the cause the user can act on', () => {
  assert.match(describeApiRetry({ error_status: null, error: 'unknown' }), /Can't reach Claude/);
  assert.match(describeApiRetry({ error_status: 529, error: 'overloaded' }), /overloaded/);
  assert.match(describeApiRetry({ error_status: null, error: 'overloaded' }), /Can't reach Claude/);
  assert.match(describeApiRetry({ error_status: 429, error: 'rate_limit' }), /rate-limiting/);
  assert.match(describeApiRetry({ error_status: 503, error: 'server_error' }), /HTTP 503/);
  assert.match(describeApiRetry({ error_status: 408, error: 'unknown' }), /HTTP 408/);
  for (const s of [null, 529, 429, 500, 400]) assert.match(describeApiRetry({ error_status: s }), /Still retrying; press Stop to give up/);
});

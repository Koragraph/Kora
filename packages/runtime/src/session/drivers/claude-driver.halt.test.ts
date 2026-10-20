// A stopped turn must really stop (launch QA: a cancelled job step kept writing its file for 34 s). Slow fake SDK query:
// interrupt() is accepted but the "agent" keeps working.
import { test } from 'node:test';
import assert from 'node:assert';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import type { ChatEvent } from '../events';

function slowQuery() {
  const buffer: any[] = [];
  let waiting: ((v: IteratorResult<any>) => void) | null = null;
  let ended = false;
  const control = { interrupts: 0, closed: 0, options: undefined as any };
  const iterator: any = {
    async next() {
      if (buffer.length) return { value: buffer.shift(), done: false };
      if (ended) return { value: undefined, done: true };
      return new Promise<IteratorResult<any>>((r) => { waiting = r; });
    },
    async return() { ended = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return this; },
    interrupt() { control.interrupts++; return Promise.resolve(); }, // accepted, but ignored by the "agent"
    close() { control.closed++; ended = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } },
    setModel: async () => {}, setPermissionMode: async () => {},
  };
  const push = (msg: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); } else buffer.push(msg); };
  return { iterator, control, push };
}
function make() {
  const fake = slowQuery();
  const queryFn: QueryFn = (params) => { fake.control.options = params.options; return fake.iterator; };
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async (p) => ({ id: 'p', agent: p.agent, account: null }),
    spawnEnv: () => ({}), appendSystemPrompt: () => undefined, isFolderTrusted: () => true,
  };
  const driver = new ClaudeDriver(deps, queryFn);
  const events: ChatEvent[] = [];
  driver.streamEvents((e) => events.push(e));
  return { driver, events, fake };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const assistantText = (t: string) => ({ type: 'assistant', message: { id: 'm' + t, role: 'assistant', content: [{ type: 'text', text: t }], usage: {} }, parent_tool_use_id: null });

test('a stopped turn refuses every tool, and a session that keeps producing output is ended', async () => {
  const { driver, events, fake } = make();
  await driver.startSession({ threadId: 'H', agent: 'claude', cwd: '/r', account: null });
  await driver.sendTurn({ threadId: 'H', text: 'research museums' });
  fake.push(assistantText('working'));
  await flush();
  await driver.interruptTurn('H');
  assert.equal(fake.control.interrupts, 1);
  // the agent tries one more tool: refused, and told to stop
  const verdict = await fake.control.options.canUseTool('Write', { file_path: '/r/austin_museums.md', content: 'x' }, { toolUseID: 't1' });
  assert.equal(verdict.behavior, 'deny');
  assert.equal(verdict.interrupt, true);
  // ...and it still streams: the session is torn down at once, not left to finish its work
  fake.push(assistantText('still going'));
  await flush();
  assert.equal(fake.control.closed, 1, 'the SDK process was closed');
  assert.ok(events.some((e) => e.type === 'session.exited'), 'the session reports it ended (it resumes on the next turn)');
});

test('a stopped turn whose interrupt never lands is ended after the grace period; a normal stop is left alone', async () => {
  const a = make();
  await a.driver.startSession({ threadId: 'H2', agent: 'claude', cwd: '/r', account: null });
  await a.driver.sendTurn({ threadId: 'H2', text: 'x' });
  await a.driver.interruptTurn('H2');
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(a.fake.control.closed, 1, 'no result within the grace period: the process is closed');

  const b = make();
  await b.driver.startSession({ threadId: 'H3', agent: 'claude', cwd: '/r', account: null });
  await b.driver.sendTurn({ threadId: 'H3', text: 'x' });
  await b.driver.interruptTurn('H3');
  b.fake.push({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', usage: {}, session_id: 's' });
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(b.fake.control.closed, 0, 'the SDK answered the interrupt: the session lives on');
  await b.driver.sendTurn({ threadId: 'H3', text: 'next' });
  const v = await b.fake.control.options.canUseTool('mcp__kora__ping', {}, { toolUseID: 't2' });
  assert.equal(v.behavior, 'allow', 'tools work again on the next turn');
});

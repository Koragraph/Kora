// cost.jsonl keeps rows for a thread across a /compact (S5b reported rows stopping after one). The SDK is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, type QueryFn } from './claude-driver';
import type { DriverDeps } from '../session-driver';
import { flushCostLog, readCostLog } from '../../util/cost-log';

function makeDriver() {
  const buffer: any[] = [];
  let waiting: ((v: IteratorResult<any>) => void) | null = null;
  const iterator: any = {
    async next() { if (buffer.length) return { value: buffer.shift(), done: false }; return new Promise<IteratorResult<any>>((r) => { waiting = r; }); },
    async return() { return { value: undefined, done: true }; },
    async throw(e: any) { throw e; },
    [Symbol.asyncIterator]() { return this; },
    async getContextUsage() { return { totalTokens: 1000, maxTokens: 1_000_000, categories: [] }; },
  };
  const push = (msg: any) => { if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); } else buffer.push(msg); };
  const queryFn: QueryFn = () => iterator;
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const driver = new ClaudeDriver(deps, queryFn);
  driver.streamEvents(() => {});
  return { driver, push };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const call = (id: string, cr: number, cc: number) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-haiku-5-5', usage: { input_tokens: 2, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 5 }, content: [{ type: 'text', text: 'x' }] } });

test('cost rows continue for a thread after a /compact (boundary, summary result, then a normal turn)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cost-'));
  const prev = process.env.KORA_HOME; process.env.KORA_HOME = home; delete process.env.KORA_COST_LOG;
  try {
    const { driver, push } = makeDriver();
    await driver.startSession({ threadId: 'T', agent: 'claude', cwd: '/tmp/x', account: null } as any);
    await driver.sendTurn({ threadId: 'T', text: 'hello' } as any);
    push(call('m1', 1000, 100)); push({ type: 'result', subtype: 'success', is_error: false, result: 'x', usage: {} }); await settle();
    await driver.sendTurn({ threadId: 'T', text: '/compact' } as any);
    push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1100, post_tokens: 200 } });
    push({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} }); await settle();
    await driver.sendTurn({ threadId: 'T', text: 'next' } as any);
    push(call('m2', 0, 400)); push({ type: 'result', subtype: 'success', is_error: false, result: 'y', usage: {} }); await settle();
    push(call('m3', 400, 50)); push({ type: 'result', subtype: 'success', is_error: false, result: 'z', usage: {} }); await settle();
    await flushCostLog(home);
    const rows = readCostLog({ home }).filter((r) => r.k === 'call') as any[];
    assert.equal(rows.length, 3, JSON.stringify(rows));
    assert.equal(rows[1].cause, 'compaction', 'the first call after the compaction is labelled');
    assert.equal(rows[1].miss, true);
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
});

test('a session stopped while it was still preparing never launches a Claude process', async () => {
  let launched = 0;
  const iterator: any = { async next() { return new Promise(() => {}); }, async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; } };
  const queryFn: QueryFn = () => { launched++; return iterator; };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 1 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined, prepareSession: async () => { await gate; return null; } } as unknown as DriverDeps;
  const driver = new ClaudeDriver(deps, queryFn);
  driver.streamEvents(() => {});
  const starting = driver.startSession({ threadId: 'S', agent: 'claude', cwd: '/tmp/x', account: null } as any);
  await new Promise((r) => setTimeout(r, 20));
  await driver.stopSession('S');
  release();
  await starting;
  assert.equal(launched, 0);
});

test('a call row carries the real output count from the stream message_delta, not the few tokens on the assistant message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cost-'));
  const prev = process.env.KORA_HOME; process.env.KORA_HOME = home; delete process.env.KORA_COST_LOG;
  const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  try {
    const { driver, push } = makeDriver();
    await driver.startSession({ threadId: 'O', agent: 'claude', cwd: '/tmp/x', account: null } as any);
    await driver.sendTurn({ threadId: 'O', text: 'hello' } as any);
    // the SDK's order: message_start, the assistant message for a block, then message_delta with the final usage
    push(ev({ type: 'message_start', message: { id: 'a1' } })); push(call('a1', 1000, 100));
    push(ev({ type: 'message_delta', usage: { output_tokens: 900 } }));
    // and a delta that lands before the assistant message
    push(ev({ type: 'message_start', message: { id: 'a2' } })); push(ev({ type: 'message_delta', usage: { output_tokens: 1234 } })); push(call('a2', 1100, 50));
    push({ type: 'result', subtype: 'success', is_error: false, result: 'x', usage: {} }); await settle();
    await flushCostLog(home);
    const rows = readCostLog({ home }).filter((r) => r.k === 'call') as any[];
    assert.deepEqual(rows.map((r) => r.out), [900, 1234]);
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
});

test('an auto-compaction in the middle of a turn labels the call AFTER it, not the call before it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cost-'));
  const prev = process.env.KORA_HOME; process.env.KORA_HOME = home; delete process.env.KORA_COST_LOG;
  try {
    const { driver, push } = makeDriver();
    await driver.startSession({ threadId: 'A', agent: 'claude', cwd: '/tmp/x', account: null } as any);
    await driver.sendTurn({ threadId: 'A', text: 'go' } as any);
    push(call('c1', 1000, 100)); push(call('c2', 1100, 50));
    push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1150, post_tokens: 200 } });
    push(call('c3', 0, 400)); push({ type: 'result', subtype: 'success', is_error: false, result: 'x', usage: {} }); await settle();
    await flushCostLog(home);
    const rows = readCostLog({ home }).filter((r) => r.k === 'call') as any[];
    assert.equal(rows.length, 3, JSON.stringify(rows));
    assert.equal(rows[1].miss, false);
    assert.equal(rows[1].cause, undefined);
    assert.equal(rows[2].miss, true);
    assert.equal(rows[2].cause, 'compaction');
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
});

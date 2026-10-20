// B17: a pure "who calls X" in the composer is answered from the graph with no agent turn, queued as a one-shot note for the
// next real turn, dropped when the user sends the question to the agent anyway, and never touches a message that is not clearly
// such a question.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import { resetSavingsSettingsCache } from '../util/savings-settings';

function harness(opts: { indexed?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-qa-'));
  const toolCalls: string[] = [];
  const turns: any[] = [];
  const driver: any = {
    agent: 'claude', capabilities: { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true },
    started: new Set<string>(), streamEvents: () => () => {}, hasSession(id: string) { return this.started.has(id); },
    async startSession(i: any) { this.started.add(i.threadId); return { threadId: i.threadId }; },
    async sendTurn(i: any) { turns.push(i); return { threadId: i.threadId, turnId: 't1' }; },
    async interruptTurn() {}, async stopSession() {},
  };
  const runtime: ManagerRuntime = {
    notify: () => {},
    graph: {
      callTool: async (name: any) => { toolCalls.push(name); return { text: '  src/a.ts: FUNCTION runThing:12\n  src/b.ts: FUNCTION other:3', data: null, ms: 1 }; },
      status: async () => ({ indexed: opts.indexed !== false }),
    },
    agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any),
  };
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: () => driver });
  return { mgr, toolCalls, turns };
}

test('a pure callers question is answered from the graph with no agent turn, and rides once on the next turn', async () => {
  const { mgr, toolCalls, turns } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  const a = await mgr.quickAnswer(t.id, 'who calls runThing?');
  assert.ok(a && a.kind === 'callers' && a.name === 'runThing', 'answered');
  assert.deepEqual(toolCalls, ['neighbours']);
  assert.equal(turns.length, 0, 'no agent turn');
  await mgr.sendTurn({ threadId: t.id, text: 'ok now rename it' });
  assert.match(turns[0].koraNotice, /answered it from the code graph without a turn/);
  assert.match(turns[0].koraNotice, /Callers of runThing/);
  await mgr.sendTurn({ threadId: t.id, text: 'and again' });
  assert.equal(turns[1].koraNotice, undefined, 'one-shot');
});

test('"send to agent anyway" discards the queued answer', async () => {
  const { mgr, turns } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  await mgr.quickAnswer(t.id, 'where is runThing defined?');
  mgr.discardQuickNotes(t.id);
  await mgr.sendTurn({ threadId: t.id, text: 'where is runThing defined?' });
  assert.equal(turns[0].koraNotice, undefined);
});

test('anything that is not clearly such a question is left for the agent; so is an unindexed repo, a blob folder and the off switch', async () => {
  const { mgr, toolCalls } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r' });
  for (const text of ['who calls runThing and why is it slow?', 'where is the button', 'fix runThing', 'who calls it', '/compact', 'explain runThing', '']) {
    assert.equal(await mgr.quickAnswer(t.id, text), null, text);
  }
  assert.equal(await mgr.quickAnswer('no-such-thread', 'who calls runThing'), null);
  assert.deepEqual(toolCalls, [], 'the graph was never asked');
  const un = harness({ indexed: false });
  const t2 = un.mgr.create({ agent: 'claude', cwd: '/r' });
  assert.equal(await un.mgr.quickAnswer(t2.id, 'who calls runThing'), null, 'not indexed: the agent answers');
  assert.deepEqual(un.toolCalls, []);
  const prev = process.env.KORA_QUICK_ANSWERS; process.env.KORA_QUICK_ANSWERS = '0'; resetSavingsSettingsCache();
  try { assert.equal(await mgr.quickAnswer(t.id, 'who calls runThing'), null, 'switched off in Settings'); }
  finally { if (prev === undefined) delete process.env.KORA_QUICK_ANSWERS; else process.env.KORA_QUICK_ANSWERS = prev; }
});

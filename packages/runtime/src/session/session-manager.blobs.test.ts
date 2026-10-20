// SessionManager with the Blobs runtime attached: the blob prompt replaces the chat leader prompt, the per-turn memory
// context rides as the agent-only notice, the profile's posture is the default mode, a SOUL edit restarts the session
// before its next turn, usage reaches the blob ledger, and non-blob threads are untouched.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-blobs-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');

import { SessionManager, type ManagerRuntime, type ManagerBlobs } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, DriverDeps } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';
import { BlobStore } from '../blobs/store';
import { BlobRuntimeImpl } from '../blobs/runtime';
import { inlineMemoryHost } from '../blobs/memory-host';
import { openMemory } from '../memory';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  live = new Set<ThreadId>(); starts: SessionStartInput[] = []; turns: SendTurnInput[] = []; stops = 0;
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.live.has(id); }
  async startSession(input: SessionStartInput) { this.starts.push(input); this.live.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: SendTurnInput) { this.turns.push(input); const turnId = `turn_${this.turns.length}`; this.emit(input.threadId, { type: 'turn.started', turnId }); return { threadId: input.threadId, turnId }; }
  async interruptTurn() {}  async respondToApproval() {}  async respondToUserInput() {}  async setModel() {}
  async stopSession(id: ThreadId) { this.stops++; this.live.delete(id); this.emit(id, { type: 'session.exited', recoverable: true }); }
}

function harness() {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: async () => '{"ops":[]}' });
  const blobs = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem), oneShot: async () => null, userSkillDirs: [] });
  const popo = store.create({ name: 'Popo', title: 'Researcher', soul: 'Warm and dry.', engine: { instanceId: 'claude', model: 'sonnet', effort: null }, permission: 'auto' });
  const bobble = store.create({ name: 'Bobble', title: 'Inbox', soul: 'Tidy.', engine: { instanceId: 'codex', model: 'gpt-5', effort: null }, permission: 'auto' });
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any), blobs: blobs as unknown as ManagerBlobs };
  const driver = new FakeDriver();
  let deps: DriverDeps | null = null;
  const mgr = new SessionManager(runtime, new ChatThreadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'))), { driverFactory: (_a, d) => { deps = d; return driver; } });
  return { mgr, driver, store, blobs, mem, popo, bobble, deps: () => deps! };
}

test('a blob thread: swarm-wired assistant folder, blob prompt (not the chat leader), posture from the profile', async () => {
  const { mgr, driver, deps, popo, bobble } = harness();
  const t = mgr.create({ agent: 'claude', cwd: popo.workspace });
  assert.equal(t.agentMode, 'swarm');
  await mgr.start(t.id);
  assert.equal(driver.starts[0].runtimeMode, 'auto', 'Claude Auto = the SDK auto mode');
  const prompt = deps().appendSystemPrompt(driver.starts[0])!;
  assert.match(prompt, /You are Popo, a Researcher/);
  assert.match(prompt, /Warm and dry\./);
  assert.doesNotMatch(prompt, /general-purpose assistant — research/, 'not the Chat leader prompt');
  const t2 = mgr.create({ agent: 'codex', cwd: bobble.workspace });
  await mgr.start(t2.id);
  assert.equal(driver.starts[1].runtimeMode, 'auto-accept-edits', 'Codex Auto = workspace-write');
  mgr.setPermissionMode(t.id, 'supervised');
  const t9 = mgr.create({ agent: 'claude', cwd: popo.workspace });
  await mgr.start(t9.id);
  assert.equal(driver.starts[2].runtimeMode, 'auto', 'a new thread starts from the profile again');
});

test('sendTurn carries the memory context as the agent-only notice; notices and empty text skip recall; a plain chat thread is untouched', async () => {
  const { mgr, driver, mem, popo } = harness();
  await mem.addFact({ scope: 'you', text: 'Prefers espresso coffee.' });
  const t = mgr.create({ agent: 'claude', cwd: popo.workspace });
  await mgr.sendTurn({ threadId: t.id, text: 'which coffee should I order?' });
  assert.match(driver.turns[0].koraNotice!, /<memory>[\s\S]*espresso[\s\S]*<\/memory>/);
  await mgr.sendTurn({ threadId: t.id, text: '[kora] worker finished', origin: 'kora-notice' });
  assert.equal(driver.turns[1].koraNotice, undefined);
  await mgr.sendTurn({ threadId: t.id, text: 'another coffee question please', koraNotice: '[kora] mode notice' });
  assert.equal(driver.turns[2].koraNotice, '[kora] mode notice', 'the fact was injected two turns ago: deduped, so only the notice');
  const plain = mgr.create({ agent: 'claude', cwd: '/some/repo' });
  await mgr.sendTurn({ threadId: plain.id, text: 'which coffee should I order?' });
  assert.equal(driver.turns[3].koraNotice, undefined);
});

test('a SOUL edit restarts the blob\'s live session before its next turn (not mid-turn); other blobs and plain threads are left alone', async () => {
  const { mgr, driver, store, popo, bobble } = harness();
  const a = mgr.create({ agent: 'claude', cwd: popo.workspace });
  const b = mgr.create({ agent: 'claude', cwd: bobble.workspace });
  const c = mgr.create({ agent: 'claude', cwd: '/some/repo' });
  for (const t of [a, b, c]) await mgr.start(t.id);
  store.writeSoul(popo.id, 'A new soul.');
  assert.equal(driver.stops, 0, 'no restart while a turn might be running');
  await mgr.sendTurn({ threadId: b.id, text: 'hi' });
  await mgr.sendTurn({ threadId: c.id, text: 'hi' });
  assert.equal(driver.stops, 0);
  await mgr.sendTurn({ threadId: a.id, text: 'hi' });
  assert.equal(driver.stops, 1);
  assert.equal(driver.starts.filter((s) => s.threadId === a.id).length, 2);
  store.setAboutMe('I am Alex');
  await mgr.sendTurn({ threadId: b.id, text: 'hi again' });
  assert.equal(driver.stops, 2, 'about-me is for every blob');
});

test('settled turn usage reaches the blob ledger', async () => {
  const { mgr, driver, blobs, popo } = harness();
  const t = mgr.create({ agent: 'claude', cwd: popo.workspace });
  await mgr.sendTurn({ threadId: t.id, text: 'hello' });
  driver.emit(t.id, { type: 'turn.settled', turnId: 'turn_1', state: 'completed', usage: { usageStatus: 'complete', inputTokens: 120, cachedInputTokens: 800, outputTokens: 40 } });
  assert.deepEqual(blobs.usage.total(popo.id), { input: 120, cached: 800, output: 40, turns: 1 });
});

test('Stop on a blob thread (a job step\'s Cancel too) kills its helpers, queued ones included; Stop on a plain thread leaves workers alone', async () => {
  const { mgr, popo } = harness();
  const cleanups: Array<{ id: string; opts: any }> = [];
  (mgr as any).runtime.swarm = { spawn: async () => ({}), cleanupThread: async (id: string, opts: any) => { cleanups.push({ id, opts }); } };
  const t = mgr.create({ agent: 'claude', cwd: popo.workspace });
  await mgr.start(t.id);
  await mgr.interrupt(t.id);
  assert.deepEqual(cleanups, [{ id: `chat:${t.id}`, opts: { kill: true, reason: 'stopped' } }]);
  // an interrupt with no live session still stops the helpers (the session was reaped while they ran)
  const t2 = mgr.create({ agent: 'claude', cwd: popo.workspace });
  await mgr.interrupt(t2.id);
  assert.equal(cleanups.length, 2);
  const plain = mgr.create({ agent: 'claude', cwd: '/some/repo' });
  await mgr.start(plain.id);
  await mgr.interrupt(plain.id);
  assert.equal(cleanups.length, 2, 'a Code thread keeps its workers across a Stop (the human steers them from the panel)');
});

// SessionManager: the Auto model (session/auto-model.ts) - the first prompt picks, the pick sticks, a light thread moves up once.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, DriverDeps } from './session-driver';
import type { ChatEvent, UnsequencedChatEvent, ThreadId } from './events';

// Auto is off by default (2026-10-19): these tests are about what it does when it is on.
process.env.KORA_AUTO_MODEL = '1';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  private listeners = new Set<(e: ChatEvent) => void>();
  live = new Set<ThreadId>();
  starts: SessionStartInput[] = [];
  turns: SendTurnInput[] = [];
  stops = 0;
  emit(threadId: ThreadId, ev: UnsequencedChatEvent) { const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent; for (const l of this.listeners) l(full); }
  streamEvents(on: (e: ChatEvent) => void) { this.listeners.add(on); return () => this.listeners.delete(on); }
  hasSession(id: ThreadId) { return this.live.has(id); }
  async startSession(input: SessionStartInput) { this.starts.push(input); this.live.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: SendTurnInput) { this.turns.push(input); const turnId = `turn_${this.turns.length}`; this.emit(input.threadId, { type: 'turn.started', turnId }); return { threadId: input.threadId, turnId }; }
  async interruptTurn() {}
  async respondToApproval() {}
  async respondToUserInput() {}
  async setModel() {}
  async stopSession(id: ThreadId) { this.stops++; this.live.delete(id); this.emit(id, { type: 'session.exited', recoverable: true }); }
}

function harness(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-auto-'))) {
  const cleanups: { orchestratorId: string; opts?: { kill?: boolean } }[] = [];
  const runtime: ManagerRuntime = {
    notify: () => {},
    graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) },
    agentSpawn: async () => ({} as any),
    swarm: {
      spawn: async () => { throw new Error('unused'); },
      taskForPane: () => null,
      readReport: async () => null,
      cleanupThread: async (orchestratorId, opts) => { cleanups.push({ orchestratorId, ...(opts ? { opts } : {}) }); },
    },
  };
  const driver = new FakeDriver();
  let deps: DriverDeps | null = null;
  const mgr = new SessionManager(runtime, new ChatThreadStore(dir), { driverFactory: (_a, d) => { deps = d; return driver; } });
  return { mgr, driver, dir, cleanups, deps: () => deps! };
}


const auto = { model: 'auto', effort: 'medium' };
const events = (mgr: SessionManager, id: string) => mgr.store.read(id).events.filter((e: any) => e.type === 'model.auto') as any[];

test('auto: a light first prompt runs on Haiku 5.5 from the first call and the pick sticks', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'where is the retry backoff configured?', model: auto });
  assert.equal(driver.starts[0].model?.model, 'claude-haiku-5-5', 'launched on the light model');
  assert.equal(driver.turns[0].model?.model, 'claude-haiku-5-5');
  assert.equal(driver.turns[0].model?.effort, 'medium');
  await mgr.sendTurn({ threadId: t.id, text: 'and who calls it?', model: auto });
  assert.equal(driver.turns[1].model?.model, 'claude-haiku-5-5', 'sticky');
  assert.equal(mgr.get(t.id).model?.model, 'auto', 'the picker still says Auto');
  const ev = events(mgr, t.id);
  assert.equal(ev.length, 1); assert.equal(ev[0].escalated, false);
});

test('auto: real work runs on the Default; a session opened before the first prompt is relaunched on a light pick', async () => {
  const a = harness();
  const t = a.mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await a.mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
  assert.equal(a.driver.turns[0].model?.model, 'default');
  assert.equal(events(a.mgr, t.id).length, 0, 'no line when Auto keeps your model');
  const b = harness();
  const u = b.mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await b.mgr.start(u.id);
  assert.equal(b.driver.starts[0].model?.model, 'default');
  await b.mgr.sendTurn({ threadId: u.id, text: 'rename fetchUser to loadUser', model: auto });
  assert.equal(b.driver.stops, 1, 'the unused session was relaunched');
  assert.equal(b.driver.starts[1].model?.model, 'claude-haiku-5-5');
});

test('auto: a light thread moves up once when the user complains; never back down', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'fix the typo in the README intro', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: "that's wrong, it is in docs/intro.md", model: auto });
  assert.equal(driver.turns[1].model?.model, 'default');
  await mgr.sendTurn({ threadId: t.id, text: 'where is the logger?', model: auto });
  assert.equal(driver.turns[2].model?.model, 'default', 'up only');
  const ev = events(mgr, t.id);
  assert.equal(ev.length, 2); assert.equal(ev[1].escalated, true);
});

test('auto: a stuck turn on the light model moves the next prompt up', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'run the tests and tell me the result', model: auto });
  driver.emit(t.id, { type: 'turn.stuck', kind: 'refail', message: 'looks stuck' });
  await mgr.sendTurn({ threadId: t.id, text: 'ok', model: auto });
  assert.equal(driver.turns[1].model?.model, 'default');
});

test('auto: a resumed thread, a lead, a picture, a notice turn and the switch off all keep the Default', async () => {
  const { mgr, driver } = harness();
  const lead = mgr.create({ agent: 'claude', cwd: '/r', model: auto, agentMode: 'swarm' });
  await mgr.sendTurn({ threadId: lead.id, text: 'where is the router?', model: auto });
  assert.equal(driver.turns.at(-1)!.model?.model, 'default');
  const pic = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: pic.id, text: 'where is this button?', model: auto, attachments: [{ type: 'image', path: '/x.png' }] });
  assert.equal(driver.turns.at(-1)!.model?.model, 'default');
  const off = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  process.env.KORA_AUTO_MODEL = '0';
  try { await mgr.sendTurn({ threadId: off.id, text: 'where is the router?', model: auto }); } finally { process.env.KORA_AUTO_MODEL = '1'; }
  assert.equal(driver.turns.at(-1)!.model?.model, 'default');
  const manual = mgr.create({ agent: 'claude', cwd: '/r', model: { model: 'sonnet' } });
  await mgr.sendTurn({ threadId: manual.id, text: 'where is the router?', model: { model: 'sonnet' } });
  assert.equal(driver.turns.at(-1)!.model?.model, 'sonnet', 'a picked model is never touched');
});

test('auto: a light thread that asks for workers moves up at its next prompt', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'where is the scheduler?', model: auto });
  driver.emit(t.id, { type: 'worker-picker.requested', requestId: 'r1', picks: [], catalog: {} } as any);
  await mgr.sendTurn({ threadId: t.id, text: 'ok go', model: auto });
  assert.equal(driver.turns[1].model?.model, 'default');
  assert.match(events(mgr, t.id).at(-1).reason, /delegating/);
});

test('auto: moving up restarts a resumed thread on the Default with a cold-cache start (masked resume)', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'where is the scheduler?', model: auto });
  mgr.store.update(t.id, { resume: 'sess-1' });
  await mgr.sendTurn({ threadId: t.id, text: 'use opus for this', model: auto });
  assert.equal(driver.stops, 1);
  const last = driver.starts.at(-1)!;
  assert.equal(last.model?.model, 'default');
  assert.equal(last.coldCache, true);
  assert.equal(driver.turns.at(-1)!.model?.model, 'default');
});

// The middle tier needs an Opus (or Fable) Default and the switch; each test sets both and restores them.
async function withMidTier<T>(model: string, env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-auto-cfg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
  const saved: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CLAUDE_CONFIG_DIR = dir;
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('auto middle tier: an Opus user with Sonnet-for-ordinary-work on gets Sonnet at high effort; light stays Haiku; off by default', async () => {
  await withMidTier('opus', { KORA_AUTO_SONNET: '1' }, async () => {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
    assert.equal(driver.starts[0].model?.model, 'claude-sonnet-5-5');
    assert.equal(driver.starts[0].model?.effort, 'high', 'Sonnet runs its own default effort, not medium');
    assert.equal(driver.turns[0].model?.effort, 'high');
    assert.equal(driver.starts[0].advisorModel, undefined, 'no advisor unless the experiment is on');
    const ev = events(mgr, t.id);
    assert.equal(ev.length, 1); assert.equal(ev[0].model, 'claude-sonnet-5-5');
    const light = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: light.id, text: 'where is the retry backoff configured?', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'claude-haiku-5-5');
    const deep = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: deep.id, text: 'ultrathink: implement the new scheduler', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'default', 'asking for the strongest model keeps the Default');
  });
  await withMidTier('opus', {}, async () => {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
    assert.equal(driver.turns[0].model?.model, 'default', 'off by default');
  });
  await withMidTier('sonnet', { KORA_AUTO_SONNET: '1' }, async () => {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
    assert.equal(driver.turns[0].model?.model, 'default', 'no tier under a Sonnet Default');
  });
});

test('auto middle tier: light -> Sonnet on real work, Sonnet -> Default on a complaint (up only); the switch off decides new threads only', async () => {
  await withMidTier('opus', { KORA_AUTO_SONNET: '1' }, async () => {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'where is the scheduler?', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'now refactor it into a class with tests', model: auto });
    assert.equal(driver.turns[1].model?.model, 'claude-sonnet-5-5', 'light moves to the middle tier, not straight to Opus');
    await mgr.sendTurn({ threadId: t.id, text: 'add the missing case', model: auto });
    assert.equal(driver.turns[2].model?.model, 'claude-sonnet-5-5', 'ordinary work stays');
    await mgr.sendTurn({ threadId: t.id, text: 'that is wrong, it still fails', model: auto });
    assert.equal(driver.turns[3].model?.model, 'default');
    await mgr.sendTurn({ threadId: t.id, text: 'where is the config?', model: auto });
    assert.equal(driver.turns[4].model?.model, 'default', 'never back down');
    const u = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: u.id, text: 'implement credit notes', model: auto });
    process.env.KORA_AUTO_SONNET = '0';
    await mgr.stop(u.id);
    await mgr.start(u.id);
    assert.equal(driver.starts.at(-1)!.model?.model, 'claude-sonnet-5-5', 'a running Sonnet thread stays on Sonnet (no re-write)');
    assert.equal(driver.starts.at(-1)!.model?.effort, 'high');
    await mgr.sendTurn({ threadId: u.id, text: 'add the missing case', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'claude-sonnet-5-5', 'its next turn agrees with its launch');
    const v = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: v.id, text: 'implement refunds', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'default', 'a new thread follows the switch');
  });
});

test('auto middle tier: KORA_AUTO_ADVISOR=1 starts Sonnet with the Default as advisor', async () => {
  await withMidTier('opus', { KORA_AUTO_SONNET: '1', KORA_AUTO_ADVISOR: '1' }, async () => {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
    assert.equal(driver.starts[0].model?.model, 'claude-sonnet-5-5');
    assert.equal(driver.starts[0].advisorModel, 'claude-opus-5-5');
  });
});

test('auto: a light thread whose context grew past 80k moves up at its next prompt, before Haiku compacts (M1 replay: one stayed on Haiku 28 turns)', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'what next. whats left', model: auto });
  assert.equal(driver.turns[0].model?.model, 'claude-haiku-5-5');
  driver.emit(t.id, { type: 'thread.token-usage', usage: { usedTokens: 60_000 } } as any);
  await mgr.sendTurn({ threadId: t.id, text: 'thanks', model: auto });
  assert.equal(driver.turns[1].model?.model, 'claude-haiku-5-5', 'under 80k it stays light');
  driver.emit(t.id, { type: 'thread.token-usage', usage: { usedTokens: 84_000 } } as any);
  await mgr.sendTurn({ threadId: t.id, text: 'thanks', model: auto });
  assert.equal(driver.turns[2].model?.model, 'default');
  assert.match(events(mgr, t.id).at(-1).reason, /80k/);
});

test('auto plan headroom: a tight Claude window starts NEW ordinary work on Sonnet even with the middle tier off; never a running thread', async () => {
  await withMidTier('opus', {}, async () => {
    const { mgr, driver } = harness();
    const before = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: before.id, text: 'implement credit notes for invoices', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'default', 'room left: the Default');
    driver.emit(before.id, { type: 'usage.limits', report: { provider: 'claude', windows: [{ id: 'seven_day', kind: 'weekly', label: 'Weekly · all models', windowMinutes: 10080, usedPercent: 90, resetsAt: Date.now() + 86_400_000 }] } } as any);
    await mgr.sendTurn({ threadId: before.id, text: 'now add the export', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'default', 'a running thread is never switched');
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement refunds for invoices', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'claude-sonnet-5-5');
    assert.equal(driver.turns.at(-1)!.model?.effort, 'high');
    assert.match(events(mgr, t.id).at(-1).reason, /Weekly · all models limit is at 90%/);
    assert.equal(mgr.store.get(t.id).autoModel?.headroom, true);
    const light = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: light.id, text: 'where is the invoice total computed?', model: auto });
    assert.equal(driver.turns.at(-1)!.model?.model, 'claude-haiku-5-5', 'light work still goes to Haiku');
    process.env.KORA_AUTO_HEADROOM = '0';
    try {
      const off = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
      await mgr.sendTurn({ threadId: off.id, text: 'implement taxes for invoices', model: auto });
      assert.equal(driver.turns.at(-1)!.model?.model, 'default', 'switch off: the Default');
    } finally { delete process.env.KORA_AUTO_HEADROOM; }
  });
});

test('effort change: a driver that applies it live is not restarted; one that cannot is restarted before the next turn', async () => {
  const { mgr, driver } = harness();
  const efforts: (string | null)[] = [];
  let accept = true;
  (driver as any).setEffort = async (_id: string, e: string | null) => { efforts.push(e); return accept; };
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: { model: 'sonnet', effort: 'medium' } });
  await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes', model: { model: 'sonnet', effort: 'medium' } });
  await mgr.changeModel(t.id, { model: 'sonnet', effort: 'low' });
  await mgr.sendTurn({ threadId: t.id, text: 'run the tests', model: { model: 'sonnet', effort: 'low' } });
  assert.deepEqual(efforts, ['low']);
  assert.equal(driver.stops, 0, 'applied live: no restart');
  accept = false;
  await mgr.changeModel(t.id, { model: 'sonnet', effort: 'high' });
  await mgr.sendTurn({ threadId: t.id, text: 'fix the failing one', model: { model: 'sonnet', effort: 'high' } });
  assert.equal(driver.stops, 1, 'refused: restarted before the next turn');
});

test('auto effort: a chore runs at low, a complaint right after it at high once, then the thread effort; off by default; never on Haiku', async () => {
  const run = async (env: Record<string, string>, prompts: string[], first = 'implement credit notes for invoices') => withMidTier('sonnet', env, async () => {
    const { mgr, driver } = harness();
    const efforts: (string | null)[] = [];
    (driver as any).setEffort = async (_id: string, e: string | null) => { efforts.push(e); return true; };
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    for (const text of [first, ...prompts]) await mgr.sendTurn({ threadId: t.id, text, model: auto });
    return { efforts, stops: driver.stops };
  });
  const on = await run({ KORA_AUTO_EFFORT: '1' }, ['commit and push', 'still fails', 'add a retry to the fetch', 'run the tests', 'yes']);
  assert.deepEqual(on.efforts, ['medium', 'low', 'high', 'medium', 'low', 'medium']);
  assert.equal(on.stops, 0, 'every change applied live');
  // A notice turn after a chore runs at the thread's effort again; the user's complaint after it still flips to high.
  const notice = await withMidTier('sonnet', { KORA_AUTO_EFFORT: '1' }, async () => {
    const { mgr, driver } = harness();
    const efforts: (string | null)[] = [];
    (driver as any).setEffort = async (_id: string, e: string | null) => { efforts.push(e); return true; };
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'implement credit notes for invoices', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'commit and push', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: '[kora] worker p2 finished', model: auto, origin: 'kora-notice' });
    await mgr.sendTurn({ threadId: t.id, text: 'still fails', model: auto });
    return efforts;
  });
  assert.deepEqual(notice, ['medium', 'low', 'medium', 'high']);
  const complaintNoLow = await run({ KORA_AUTO_EFFORT: '1' }, ['still fails']);
  assert.deepEqual(complaintNoLow.efforts, ['medium', 'medium'], 'a complaint after a normal turn keeps the thread effort');
  assert.deepEqual((await run({}, ['commit and push', 'still fails'])).efforts, [], 'off by default');
  assert.deepEqual((await run({ KORA_AUTO_EFFORT: '1' }, ['commit'], 'where is the retry backoff configured?')).efforts, [], 'Haiku has no effort');
});

test('auto: Claude routed through a gateway in the user\'s Claude settings env runs the Default (Auto\'s picks are first-party ids)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-auto-route-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' } }));
  const saved = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { mgr, driver } = harness();
    const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'where is the retry backoff configured?', model: auto });
    assert.equal(driver.turns[0].model?.model, 'default');
  } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
});

test('auto switched off while a light session is live: it restarts (masked) instead of switching live across Haiku\'s compaction point', async () => {
  const { mgr, driver } = harness();
  const t = mgr.create({ agent: 'claude', cwd: '/r', model: auto });
  await mgr.sendTurn({ threadId: t.id, text: 'where is the retry backoff configured?', model: auto });
  mgr.store.update(t.id, { resume: 'sess-1' } as any);
  const stops = driver.stops;
  process.env.KORA_AUTO_MODEL = '0';
  try {
    await mgr.sendTurn({ threadId: t.id, text: 'and the jitter?', model: auto });
    assert.equal(driver.stops, stops + 1, 'restarted');
    assert.equal(driver.starts.at(-1)!.model?.model, 'default');
    await mgr.sendTurn({ threadId: t.id, text: 'and the max delay?', model: auto });
    await mgr.sendTurn({ threadId: t.id, text: 'thanks', model: auto });
    assert.equal(driver.stops, stops + 1, 'once: later turns do not restart again');
    assert.equal(driver.turns.at(-1)!.model?.model, 'default');
  } finally { process.env.KORA_AUTO_MODEL = '1'; }
});

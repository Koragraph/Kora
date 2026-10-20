// Folder trust and the SessionManager: the upgrade migration runs at construction (daemon start), and a trust change
// restarts a live session in that folder before its next turn (never mid-turn).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import type { SessionDriver, DriverCapabilities, SessionStartInput } from './session-driver';
import type { ChatEvent, ThreadId } from './events';
import { isFolderTrusted, trustFolder, revokeFolderTrust, trustMigrationMarker, _resetTrustCacheForTests } from '../trust/store';

class FakeDriver implements SessionDriver {
  readonly agent = 'claude' as const;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: true, conversationRollback: false, manualCompaction: true, canSpawnWorkers: true };
  started = new Set<ThreadId>();
  starts = 0; stops = 0;
  streamEvents(_on: (e: ChatEvent) => void) { return () => {}; }
  hasSession(id: ThreadId) { return this.started.has(id); }
  async startSession(input: SessionStartInput) { this.starts++; this.started.add(input.threadId); return { threadId: input.threadId }; }
  async sendTurn(input: any) { return { threadId: input.threadId, turnId: 'turn_1' }; }
  async interruptTurn() {}
  async respondToApproval() {}
  async respondToUserInput() {}
  async setModel() {}
  async stopSession(id: ThreadId) { this.stops++; this.started.delete(id); }
}

function withHome(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mgr-trust-')));
    const prev = process.env.KORA_HOME; process.env.KORA_HOME = path.join(dir, 'kora');
    fs.mkdirSync(process.env.KORA_HOME, { recursive: true });
    _resetTrustCacheForTests();
    try { await fn(dir); } finally {
      if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev;
      _resetTrustCacheForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({ id: 'p', agent: 'claude', account: null } as any) };

test('constructing the manager migrates folders of existing threads once; threads created after are untrusted', withHome(async (dir) => {
  const old = path.join(dir, 'old'); fs.mkdirSync(path.join(old, '.git'), { recursive: true });
  const fresh = path.join(dir, 'fresh'); fs.mkdirSync(path.join(fresh, '.git'), { recursive: true });
  const store = new ChatThreadStore(path.join(process.env.KORA_HOME!, 'chat'));
  store.create({ agent: 'claude', cwd: old } as any);
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, store, { driverFactory: () => driver });
  assert.ok(fs.existsSync(trustMigrationMarker()));
  assert.equal(isFolderTrusted(old), true, 'a folder in use before the upgrade keeps working');
  mgr.create({ agent: 'claude', cwd: fresh });
  new SessionManager(runtime, store, { driverFactory: () => driver }); // a second start (daemon restart)
  assert.equal(isFolderTrusted(fresh), false, 'a folder opened after the upgrade asks first');
  await mgr.shutdown();
}));

test('trust granted / revoked while a session is live restarts it before the next turn', withHome(async (dir) => {
  const r = path.join(dir, 'r'); fs.mkdirSync(path.join(r, '.git'), { recursive: true });
  const other = path.join(dir, 'other'); fs.mkdirSync(other);
  const store = new ChatThreadStore(path.join(dir, 'store'));
  const driver = new FakeDriver();
  const mgr = new SessionManager(runtime, store, { driverFactory: () => driver, trustMigration: false });
  const t = mgr.create({ agent: 'claude', cwd: path.join(r) });
  const u = mgr.create({ agent: 'claude', cwd: other });
  await mgr.start(t.id); await mgr.start(u.id);
  await mgr.sendTurn({ threadId: t.id, text: 'hi' });
  assert.equal(driver.stops, 0);
  trustFolder(r);
  await mgr.sendTurn({ threadId: u.id, text: 'hi' });
  assert.equal(driver.stops, 0, 'a session in another folder is untouched');
  await mgr.sendTurn({ threadId: t.id, text: 'again' });
  assert.equal(driver.stops, 1, 'restarted once, at the turn boundary');
  revokeFolderTrust(r);
  await mgr.sendTurn({ threadId: t.id, text: 'once more' });
  assert.equal(driver.stops, 2);
  await mgr.shutdown();
}));

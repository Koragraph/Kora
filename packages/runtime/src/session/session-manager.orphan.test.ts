// Restart mid-approval on the socket/CLI chat path: the approval died with the daemon.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';

const runtime = (): ManagerRuntime => ({ notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({ id: 'p9', agent: 'claude', account: null } as any) });

test('a fresh manager closes approvals left open by a dead daemon, and the thread leaves waiting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-orphan-'));
  const store = new ChatThreadStore(dir);
  const t = store.create({ agent: 'claude', cwd: '/r' } as any);
  store.append(t.id, { type: 'approval.opened', requestId: 'r1', requestKind: 'command_execution_approval', title: 'Run x' } as any);
  store.update(t.id, { state: 'waiting' });
  // "restart": a new manager over the same store
  const mgr = new SessionManager(runtime(), new ChatThreadStore(dir), { driverFactory: () => ({}) as any });
  const types = mgr.store.read(t.id).events.map((e: any) => `${e.type}:${e.decision ?? ''}`);
  assert.ok(types.includes('approval.resolved:cancel'), types.join(','));
  assert.equal(mgr.store.get(t.id).state, 'idle');
  await assert.rejects(() => mgr.respondApproval(t.id, 'r1', 'accept'), /no such pending approval/);
});

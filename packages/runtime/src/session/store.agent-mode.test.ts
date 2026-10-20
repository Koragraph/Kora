// ChatThreadStore: the agentMode migration on read (meta.json written before swarm) and create({agentMode}).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatThreadStore, normalizeMeta } from './store';

function tmp(): { dir: string; store: ChatThreadStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-store-mode-'));
  return { dir, store: new ChatThreadStore(dir) };
}

/** Rewrite a thread's meta.json as an old daemon would have left it. */
function writeLegacy(dir: string, id: string, patch: Record<string, unknown>, drop: string[]) {
  const p = path.join(dir, id, 'meta.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of drop) delete raw[k];
  fs.writeFileSync(p, JSON.stringify({ ...raw, ...patch }));
}

test('legacy meta.json: isOrchestrator true reads as agentMode orchestrator, false as chat', () => {
  const { dir, store } = tmp();
  const a = store.create({ agent: 'claude', cwd: '/r' });
  const b = store.create({ agent: 'claude', cwd: '/r' });
  const drop = ['agentMode', 'pendingModeNotice', 'announcedAgentMode'];
  writeLegacy(dir, a.id, { isOrchestrator: true }, drop);
  writeLegacy(dir, b.id, { isOrchestrator: false }, drop);
  const ma = store.get(a.id);
  const mb = store.get(b.id);
  assert.equal(ma.agentMode, 'orchestrator');
  assert.equal(ma.isOrchestrator, true);
  assert.equal(ma.announcedAgentMode, 'orchestrator', 'a legacy agent already knows its mode');
  assert.equal(ma.pendingModeNotice, null);
  assert.equal(mb.agentMode, 'chat');
  assert.equal(mb.isOrchestrator, true, 'every mode is fleet-wired now: a chat delegates through kora_spawn');
});

test('an unknown mode falls back to the legacy flag; isOrchestrator is always re-derived', () => {
  const m = normalizeMeta({ id: 'x', isOrchestrator: false, agentMode: 'hive' } as any);
  assert.equal(m.agentMode, 'chat');
  const s = normalizeMeta({ id: 'y', isOrchestrator: false, agentMode: 'swarm' } as any);
  assert.equal(s.isOrchestrator, true, 'swarm wires the fleet tools');
});

test('create takes agentMode (winning over isOrchestrator) and a pending notice', () => {
  const { store } = tmp();
  const t = store.create({ agent: 'claude', cwd: '/r', agentMode: 'swarm', isOrchestrator: false, pendingModeNotice: { from: 'chat', to: 'swarm', text: 'n' } });
  const m = store.get(t.id);
  assert.equal(m.agentMode, 'swarm');
  assert.equal(m.isOrchestrator, true);
  assert.deepEqual(m.pendingModeNotice, { from: 'chat', to: 'swarm', text: 'n' });
  assert.equal(m.announcedAgentMode, 'chat');
  const o = store.create({ agent: 'claude', cwd: '/r', isOrchestrator: true });
  assert.equal(store.get(o.id).agentMode, 'orchestrator');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorkerInfo, STALL_MS } from './fleet-ops';
import { formatWorker } from '../session/fleet-tools';

const pane = (over: Record<string, unknown> = {}): any => ({
  id: 'p7', name: 'w', agent: 'claude', account: null, state: 'working', blocker: null, exited: false, exitCode: null,
  cwd: '/r', liveCwd: null, worktree: null, ledger: null, steeredAt: null, createdAt: 1000, lastOutputAt: 1000, ...over,
});

test('a working pane silent for STALL_MS is reported stalled; output, idle or exit clears it', () => {
  const now = 1000 + STALL_MS + 5000;
  const w = toWorkerInfo(pane(), now);
  assert.equal(w.stalled, true); assert.ok(w.quietMs >= STALL_MS);
  assert.match(formatWorker(w), /STALLED\? no output for 5 min while "working"/);
  assert.equal(toWorkerInfo(pane({ lastOutputAt: now - 1000 }), now).stalled, false, 'recent output');
  assert.equal(toWorkerInfo(pane({ state: 'idle' }), now).stalled, false, 'idle is not stalled — it is waiting for us');
  assert.equal(toWorkerInfo(pane({ exited: true }), now).stalled, false, 'exited never shows as working or stalled');
  assert.equal(toWorkerInfo(pane({ exited: true }), now).state, 'exited');
  assert.doesNotMatch(formatWorker(toWorkerInfo(pane({ lastOutputAt: now - 1000 }), now)), /STALLED/);
});

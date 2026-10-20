// The lead's view of its workers: `error-stalled` in kora_workers/kora_wait lines, and the "since you last looked" digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo } from '../server/fleet-ops';
import { formatWorker, sinceLastLooked, workerStateLabel } from './fleet-tools';

const w = (o: Partial<WorkerInfo>): WorkerInfo => ({ id: 'p1', name: 'tests', agent: 'claude', account: null, state: 'working', blocker: null, exited: false, exitCode: null, cwd: '/r', worktree: null, costUsd: null, contextPct: null, steeredAt: null, createdAt: 0, lastOutputAt: 0, quietMs: 0, stalled: false, errorStall: null, swarm: null, ...o });

test('an error-stalled worker reads as error-stalled with its error and the retry budget', () => {
  const retrying = w({ state: 'idle', errorStall: { line: 'API Error: The response stopped arriving', at: 1, retries: 1, retrying: true } });
  assert.equal(workerStateLabel(retrying), 'error-stalled');
  assert.match(formatWorker(retrying), /p1 {2}error-stalled .*API error: "API Error: The response stopped arriving" — kora sent "continue" \(1\/6\)/);
  const spent = w({ state: 'idle', errorStall: { line: 'E', at: 1, retries: 6, retrying: false } });
  assert.match(formatWorker(spent), /auto-continue used 6\/6; kora_prompt it "continue" or re-dispatch/);
  assert.equal(workerStateLabel(w({ exited: true, state: 'exited', errorStall: { line: 'E', at: 1, retries: 1, retrying: false } })), 'exited');
});

test('since you last looked: changes only, first look silent, skip the ones being waited on', () => {
  const first = sinceLastLooked(undefined, [w({ id: 'p1' }), w({ id: 'p2' })]);
  assert.deepEqual(first.lines, []);
  const second = sinceLastLooked(first.next, [
    w({ id: 'p1', state: 'idle' }),
    w({ id: 'p2', state: 'idle', errorStall: { line: 'E', at: 1, retries: 6, retrying: false } }),
    w({ id: 'p3' }), // new: the lead's own spawn
  ]);
  assert.deepEqual(second.lines, ['p1 "tests" working → idle', 'p2 "tests" working → error-stalled']);
  const third = sinceLastLooked(second.next, [w({ id: 'p1', state: 'idle' }), w({ id: 'p3', stalled: true })], new Set(['p1']));
  assert.deepEqual(third.lines, ['p3 "tests" working → stalled', 'p2 error-stalled → gone (closed or asleep)']);
  const fourth = sinceLastLooked(third.next, [w({ id: 'p3', exited: true, state: 'exited' })]);
  assert.deepEqual(fourth.lines, ['p3 "tests" stalled → exited', 'p1 idle → gone (closed or asleep)']);
});

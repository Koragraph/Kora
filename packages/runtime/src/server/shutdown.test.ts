// A SIGTERM must end the daemon in seconds even when a shutdown step hangs (live QA #4: the daemon survived SIGTERM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSignalStop, withDeadline } from './daemon';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<void>(() => {});

test('withDeadline: a step that never finishes is abandoned after its deadline, a failing one is logged, a fast one is untouched', async () => {
  const logs: string[] = [];
  const t0 = Date.now();
  await withDeadline(never(), 60, 'browsers', (m) => logs.push(m));
  assert.ok(Date.now() - t0 < 500);
  assert.ok(logs.some((l) => /browsers did not finish in 60 ms/.test(l)));
  logs.length = 0;
  await withDeadline(Promise.reject(new Error('boom')), 1000, 'routines', (m) => logs.push(m));
  assert.deepEqual(logs, ['routines failed']);
  logs.length = 0;
  await withDeadline(sleep(5), 1000, 'quick', (m) => logs.push(m));
  assert.deepEqual(logs, []);
});

test('makeSignalStop: the first signal closes; a close that hangs is cut off at the grace period; a second signal exits at once', async () => {
  let closes = 0;
  const exits: number[] = [];
  const logs: string[] = [];
  const stop = makeSignalStop(() => { closes++; return never(); }, { graceMs: 80, exit: (c) => exits.push(c), log: (m) => logs.push(m) });
  stop('SIGTERM');
  assert.equal(closes, 1);
  assert.deepEqual(exits, []);
  await sleep(150);
  assert.deepEqual(exits, [0], 'forced exit after the grace period');
  assert.ok(logs.some((l) => /still running after 80 ms/.test(l)));

  const exits2: number[] = [];
  const stop2 = makeSignalStop(() => never(), { graceMs: 60_000, exit: (c) => exits2.push(c), log: () => {} });
  stop2('SIGTERM');
  assert.deepEqual(exits2, []);
  stop2('SIGINT');
  assert.deepEqual(exits2, [0], 'a second signal does not wait');
});

test('makeSignalStop: a close that finishes does not force an exit', async () => {
  const exits: number[] = [];
  const stop = makeSignalStop(async () => {}, { graceMs: 50, exit: (c) => exits.push(c), log: () => {} });
  stop('SIGTERM');
  await sleep(120);
  assert.deepEqual(exits, [], 'the grace timer is only a backstop: a finished close cancels it');
});

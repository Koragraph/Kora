// The stall detector must still catch a real event-loop block after moving to the monotonic clock (which, unlike the
// wall clock, does not count a sleeping Mac as a 20-minute stall).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-stall-'));

test('a real 600 ms block of the event loop is reported', async () => {
  const { startStallDetector, stallStatsForTests } = require('./daemon');
  const before = stallStatsForTests().count;
  const stop = startStallDetector(50, 300);
  try {
    await new Promise((r) => setTimeout(r, 120));
    const until = Date.now() + 600;
    while (Date.now() < until) { /* block */ }
    await new Promise((r) => setTimeout(r, 120));
    const after = stallStatsForTests();
    assert.ok(after.count > before, 'the block was counted');
    assert.ok(after.maxMs >= 300, `lag measured: ${after.maxMs}`);
  } finally { stop(); }
});

test('a stall is attributed to the socket RPC that was running during it', async () => {
  const { noteRpc, describeStall } = require('./daemon');
  const from = performance.now();
  const done = noteRpc('worktree.sweep');
  const until = Date.now() + 80;
  while (Date.now() < until) { /* block */ }
  done();
  const text: string = describeStall(from, performance.now());
  assert.match(text, /worktree\.sweep\(\d+ms\)/);
  assert.match(text, /last rpc worktree\.sweep/);
  assert.match(describeStall(performance.now() + 10, performance.now() + 20), /no socket RPC/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Job } from '../src/job.js';
import { main } from '../src/cli/index.js';
import { createContext } from '../src/cli/context.js';

test('timeoutMs defaults to null, must be a positive integer, and round-trips', () => {
  assert.equal(new Job({ type: 'a' }).timeoutMs, null);
  assert.throws(() => new Job({ type: 'a', timeoutMs: 0 }), /timeoutMs/);
  assert.equal(Job.fromJSON(new Job({ type: 'a', timeoutMs: 40 }).toJSON()).timeoutMs, 40);
});

test('submit --timeout is echoed', async () => {
  const lines = [];
  await main(['submit', 'a', '--timeout', '500'], { ctx: createContext(), out: (l) => lines.push(l) });
  assert.match(lines[0], / timeout 500ms$/);
});

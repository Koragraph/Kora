import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main, usage } from '../src/cli/index.js';
import { createContext } from '../src/cli/context.js';

test('parseArgs separates positionals and options and coerces numbers', () => {
  assert.deepEqual(parseArgs(['submit', 'email', '--priority', '5', '--delay', '250', '--tag', 'x']), {
    command: 'submit',
    positional: ['email'],
    options: { priority: 5, delay: 250, tag: 'x' },
  });
});

test('parseArgs rejects an option without a value', () => {
  assert.throws(() => parseArgs(['submit', 'email', '--priority']), /needs a value/);
});

test('submit schedules a job', async () => {
  const ctx = createContext();
  const lines = [];
  assert.equal(await main(['submit', 'email', '--delay', '10'], { ctx, out: (l) => lines.push(l) }), 0);
  assert.equal(ctx.queue.size(), 1);
  assert.match(lines[0], /^scheduled job_/);
});

test('status reports counters', async () => {
  const ctx = createContext();
  const lines = [];
  await main(['submit', 'a'], { ctx, out: () => {} });
  await main(['status'], { ctx, out: (l) => lines.push(l) });
  assert.match(lines[0], /queued 1/);
});

test('retry-info prints the delay schedule', async () => {
  const lines = [];
  await main(['retry-info', '--attempts', '4'], { ctx: createContext(), out: (l) => lines.push(l) });
  assert.equal(lines[1], 'delays: 100, 200, 400');
});

test('unknown commands print usage and exit 2', async () => {
  const lines = [];
  assert.equal(await main(['nope'], { ctx: createContext(), out: (l) => lines.push(l) }), 2);
  assert.equal(lines[0], usage());
});

test('worker runs the queued jobs', async () => {
  const ctx = createContext();
  ctx.worker.register('a', async () => {});
  await main(['submit', 'a'], { ctx, out: () => {} });
  const lines = [];
  await main(['worker'], { ctx, out: (l) => lines.push(l) });
  assert.equal(lines[0], 'ran 1 job(s)');
});

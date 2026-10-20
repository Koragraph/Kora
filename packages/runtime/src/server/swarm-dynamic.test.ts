import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { carryOver, digestLine, isQuiet, QUIET_AFTER_MS, readMilestones } from './swarm-dynamic';

test('readMilestones: incremental, ignores torn and unknown lines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), 'm.jsonl');
  fs.writeFileSync(f, '{"at":1,"kind":"reproduced","note":"test x fails"}\n{"kind":"bogus"}\n');
  const a = readMilestones(f, 0);
  assert.deepEqual(a.items.map((m) => m.kind), ['reproduced']);
  fs.appendFileSync(f, '{"at":2,"kind":"root-cause","note":"a.js:3"}\n{"at":3,"kind":"fix');
  const b = readMilestones(f, a.offset);
  assert.deepEqual(b.items.map((m) => m.kind), ['root-cause'], 'the torn last line waits for its newline');
  assert.equal(readMilestones(f, b.offset).items.length, 0);
});

test('isQuiet / digestLine / carryOver', () => {
  const now = 10 * QUIET_AFTER_MS;
  const base = { phase: 'running', startedAt: now - 2 * QUIET_AFTER_MS, milestones: [] as any[], changedFiles: [] as string[], lastChangeAt: null };
  assert.equal(isQuiet(base, now), true);
  assert.equal(isQuiet({ ...base, milestones: [{ at: now - 1000, kind: 'note', note: 'x' }] }, now), false);
  assert.equal(isQuiet({ ...base, startedAt: now - 1000 }, now), false, 'too early to say');
  assert.equal(isQuiet({ ...base, phase: 'done' }, now), false);
  const line = digestLine({ paneId: 'p2', taskId: 's2', title: 'bug 4', phase: 'running', race: 'bug4', runningMs: 7 * 60_000, milestones: [{ at: 1, kind: 'reproduced', note: 'limiter test fails' }], changedFiles: ['a.js'], quiet: true, note: null });
  assert.match(line, /^p2 running 7m "bug 4" race=bug4 \| reproduced: limiter test fails \| changed: a\.js  ⚠ QUIET/);
  assert.match(carryOver({ paneId: 'p1', milestones: [{ at: 1, kind: 'rejected', note: 'not the limiter' }], changedFiles: [], report: null }), /rejected: not the limiter/);
  assert.match(carryOver({ paneId: 'p1', milestones: [], changedFiles: [], report: null }), /Take a different approach/);
});

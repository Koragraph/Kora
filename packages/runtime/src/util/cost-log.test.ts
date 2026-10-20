import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallTracker, flushCostLog, logCost, logCostSync, readCostLog, summarizeCostLog, costLogPath, type CostLine } from './cost-log';
import { boundedReadsMode, leanContextOn, resetSavingsSettingsCache } from './savings-settings';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cost-'));
const T = (n: number) => 1_000_000 + n * 1000;

test('CallTracker: first call is never a miss; a cold start is named', () => {
  const t = new CallTracker(false);
  const a = t.record({ model: 'm', in: 3, cr: 0, cc: 30000, out: 100 }, T(0), 'th');
  assert.equal(a.miss, false);
  assert.equal(a.cause, 'start');
  assert.equal(new CallTracker(true).record({ model: 'm', in: 3, cr: 0, cc: 30000, out: 1 }, T(0), 'th').cause, 'resume');
  assert.equal(new CallTracker(true).record({ model: 'm', in: 3, cr: 30000, cc: 100, out: 1 }, T(0), 'th').cause, undefined);
});

test('CallTracker: a warm follow-up is a hit; losing the cache is a miss with the best-known cause', () => {
  const t = new CallTracker(false);
  t.record({ model: 'm', in: 3, cr: 0, cc: 30000, out: 100 }, T(0), 'th');
  const hit = t.record({ model: 'm', in: 3, cr: 30000, cc: 400, out: 50 }, T(10), 'th');
  assert.equal(hit.miss, false);
  const sw = t.record({ model: 'other', in: 3, cr: 0, cc: 31000, out: 50 }, T(20), 'th');
  assert.equal(sw.miss && sw.cause, 'model-switch');
  const idle = t.record({ model: 'other', in: 3, cr: 100, cc: 31000, out: 50 }, T(20) + 3_700_000, 'th');
  assert.equal(idle.miss && idle.cause, 'idle');
  t.note('compaction');
  const comp = t.record({ model: 'other', in: 3, cr: 0, cc: 9000, out: 50 }, T(30) + 3_700_000, 'th');
  assert.equal(comp.miss && comp.cause, 'compaction');
  const unk = t.record({ model: 'other', in: 3, cr: 0, cc: 9000, out: 50 }, T(40) + 3_700_000, 'th');
  assert.equal(unk.miss && unk.cause, 'unknown');
});

test('cost log: buffered writes land, reads tolerate junk, summary computes cache-hit and read stats', async () => {
  const h = home();
  const tr = new CallTracker(false);
  logCost(tr.record({ model: 'm', in: 3, cr: 0, cc: 30000, out: 100 }, T(0), 'a'), h);
  logCost(tr.record({ model: 'm', in: 3, cr: 30000, cc: 1000, out: 100 }, T(5), 'a', 1), h);
  logCost({ k: 'tool', ts: T(5), thread: 'a', tool: 'Read', bytes: 40000 }, h);
  logCost({ k: 'read-bound', ts: T(5), thread: 'a', file: 'x.ts', offset: 1, limit: 250, total: 600, source: 'head', avoided: 5000 }, h);
  logCostSync({ k: 'read-expand', ts: T(6), thread: 'a', file: 'x.ts' }, h);
  await flushCostLog(h);
  fs.appendFileSync(costLogPath(h), 'not json\n{"k":"call"}\n');
  const lines = readCostLog({ home: h });
  assert.equal(lines.length, 5);
  const s = summarizeCostLog(lines);
  assert.equal(s.calls, 2); assert.equal(s.threads, 1);
  assert.ok(Math.abs(s.cacheHit! - 30000 / 61006) < 1e-6);
  assert.deepEqual(s.reads, { bounded: 1, shadow: 0, expanded: 1, avoidedTokens: 5000, expandRate: 1 });
  assert.deepEqual(s.topTools, [['Read', 1, 40000]]);
  assert.equal(readCostLog({ home: h, sinceMs: T(5) }).length, 4);
  assert.deepEqual(summarizeCostLog([]).cacheHit, null);
  const none: CostLine[] = readCostLog({ home: home() });
  assert.deepEqual(none, []);
});

test('savings settings: bounded reads default, file, env override; lean context opt-in', () => {
  const h = home();
  resetSavingsSettingsCache();
  const defaultMode = boundedReadsMode(h, {});
  assert.ok(['off', 'shadow', 'on'].includes(defaultMode));
  assert.equal(leanContextOn(h, {}), false);
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ boundedReads: 'shadow', leanContext: true }));
  resetSavingsSettingsCache();
  assert.equal(boundedReadsMode(h, {}), 'shadow');
  assert.equal(leanContextOn(h, {}), true);
  assert.equal(boundedReadsMode(h, { KORA_BOUNDED_READS: 'on' }), 'on');
  assert.equal(boundedReadsMode(h, { KORA_BOUNDED_READS: '0' }), 'off');
  assert.equal(leanContextOn(h, { KORA_LEAN_CONTEXT: '0' }), false);
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({ boundedReads: 'maybe', leanContext: 'yes' }));
  resetSavingsSettingsCache();
  assert.equal(boundedReadsMode(h, {}), defaultMode);
  assert.equal(leanContextOn(h, {}), false);
});

test('summarizeCostLog counts cold-resume trims', () => {
  const s = summarizeCostLog([{ k: 'prune', ts: 1, thread: 'a', stubbed: 4, saved: 30000, ctx: 90000 }, { k: 'prune', ts: 2, thread: 'b', stubbed: 2, saved: 12000, ctx: 50000 }]);
  assert.deepEqual(s.pruned, { resumes: 2, tokens: 42000 });
});

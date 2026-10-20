// swarm-routing: the task classifier (on real mined prompt shapes), outcome → counts (quality vs supply), decay,
// cold-start determinism, Thompson exploration, the time and load penalties, and the per-model table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySwarmTask, loadRoutingStats, modelStatsTable, rankModels, sampleBeta, scoreModel, statsFromOutcomes, type RoutingOutcomeRow } from './swarm-routing';

test('classifySwarmTask: research / edit / test-fix from the leader\'s task text', () => {
  // Shapes from the 118 mined worker prompts: "create … verify with `node --test`" is an EDIT, not a test-fix.
  assert.equal(classifySwarmTask('In this repo, create src/strings.js exporting `slugify`. Verify by running `node --test test/strings.test.js` and make sure it passes. Report back.'), 'edit');
  assert.equal(classifySwarmTask('WHAT TO REPORT: a per-target factual brief, each claim with a source URL. Explicitly write the report to the file.'), 'research');
  assert.equal(classifySwarmTask('Find every caller of parseConfig and list them with file:line. Do not edit any files.'), 'research');
  assert.equal(classifySwarmTask('Where is the retry budget enforced? Summarize how it works.'), 'research');
  assert.equal(classifySwarmTask('The auth tests are failing after the refactor — fix them.'), 'test-fix');
  assert.equal(classifySwarmTask('Fix the type errors in packages/web and make the build green.'), 'test-fix');
  assert.equal(classifySwarmTask('Rename getUser to fetchUser across the repo.'), 'edit');
  assert.equal(classifySwarmTask('Use ESM syntax. Do not touch any other files. Create src/a.js'), 'edit', '"other files" is not a read-only brief');
  assert.equal(classifySwarmTask(''), 'edit');
});

const NOW = 1_790_000_000_000;
const row = (model: string, o: Partial<RoutingOutcomeRow> & { outcomes?: string[]; models?: string[] } = {}): RoutingOutcomeRow => {
  const models = o.models ?? [model];
  const outcomes = o.outcomes ?? models.map((_, i) => (i === models.length - 1 ? 'ok' : 'rate-limited'));
  return { ts: o.ts ?? NOW, status: o.status ?? 'done', attempts: models.map((m, i) => ({ model: m, outcome: outcomes[i], at: (o.ts ?? NOW) - 300_000 + i * 1000 })), verify: o.verify === undefined ? { state: 'passed', bounces: 0 } : o.verify, type: o.type ?? 'edit' };
};

test('statsFromOutcomes: rate limits count against SUPPLY only; crash / stall / skipped report against QUALITY', () => {
  const s = statsFromOutcomes([
    row('m/a'),
    row('m/b', { models: ['m/a', 'm/b'] }), // m/a refused (429), m/b passed
    row('m/a', { status: 'failed', verify: null, outcomes: ['running'] }), // m/a ran, never reported
    row('m/c', { models: ['m/c', 'm/b'], outcomes: ['stalled', 'ok'] }),
    row('m/b', { verify: { state: 'passed', bounces: 1 } }), // a bounced pass is half credit
  ], NOW);
  const a = s.models.get('m/a')!.all, b = s.models.get('m/b')!.all, c = s.models.get('m/c')!.all;
  assert.deepEqual([a.ran, a.passed, a.refused, a.reportSkipped], [2, 1, 1, 1]);
  assert.deepEqual([b.ran, b.passed, b.bounced], [3, 2.5, 1]);
  assert.deepEqual([c.ran, c.passed, c.stalled], [1, 0, 1]);
  assert.equal(a.durations.length, 1);
  assert.ok(s.models.get('m/a')!.byType.edit);
});

test('statsFromOutcomes: old rows fade (supply faster than quality)', () => {
  const old = NOW - 6 * 24 * 3600_000;
  const s = statsFromOutcomes([row('m/x', { ts: old, models: ['m/x', 'm/y'] })], NOW);
  const x = s.models.get('m/x')!.all, y = s.models.get('m/y')!.all;
  assert.ok(x.refused > 0.2 && x.refused < 0.3, `supply half-life 3 d: ${x.refused}`);
  assert.ok(y.ran > 0.7 && y.ran < 0.8, `quality half-life 14 d: ${y.ran}`);
});

test('scoreModel: seed priors at cold start; the user\'s own outcomes take over', () => {
  const empty = statsFromOutcomes([], NOW);
  const ultra = scoreModel(empty, 'opencode/nemotron-3-ultra-free', 'edit');
  const ling = scoreModel(empty, 'opencode/ling-3.0-flash-fin-free', 'edit');
  const unknown = scoreModel(empty, 'opencode/brand-new', 'edit');
  assert.ok(ling.score > unknown.score && unknown.score > ultra.score, `${ling.score} > ${unknown.score} > ${ultra.score}`);
  // ten clean passes on the measured-worst model outweigh its prior
  const good = statsFromOutcomes(Array.from({ length: 10 }, () => row('opencode/nemotron-3-ultra-free')), NOW);
  assert.ok(scoreModel(good, 'opencode/nemotron-3-ultra-free', 'edit').quality > 0.85);
});

test('scoreModel: per-type counts once there are two of them, else the all-type counts', () => {
  const rows = [...Array.from({ length: 6 }, () => row('m/a', { type: 'edit' })), row('m/a', { type: 'research', status: 'failed', verify: null, outcomes: ['running'] }), row('m/a', { type: 'research', status: 'failed', verify: null, outcomes: ['running'] })];
  const s = statsFromOutcomes(rows, NOW);
  assert.ok(scoreModel(s, 'm/a', 'edit').quality > 0.75);
  assert.ok(scoreModel(s, 'm/a', 'research').quality < 0.5);
  assert.ok(scoreModel(s, 'm/a', 'test-fix').quality > 0.6, 'no test-fix data: falls back to all types');
});

test('rankModels: deterministic without data (input order breaks ties); load spreads workers; preferFast favours speed', () => {
  const empty = statsFromOutcomes([], NOW);
  const c = [{ id: 'z/one' }, { id: 'z/two' }, { id: 'z/three' }];
  assert.deepEqual(rankModels(c, 'edit', { stats: empty }).map((m) => m.id), ['z/one', 'z/two', 'z/three']);
  assert.equal(rankModels(c, 'edit', { stats: empty, load: (id) => (id === 'z/one' ? 1 : 0) })[0].id, 'z/two');
  // lightning (100% but 343 s) vs mimo (83%, 142 s, flaky supply): speed decides only when preferred
  const fast = [{ id: 'opencode/nemotron-3.5-lightning-free' }, { id: 'opencode/mimo-v2.6-flash-free' }];
  assert.equal(rankModels(fast, 'edit', { stats: empty })[0].id, 'opencode/nemotron-3.5-lightning-free');
  assert.equal(rankModels(fast, 'edit', { stats: empty, preferFast: true })[0].id, 'opencode/mimo-v2.6-flash-free');
});

test('rankModels: Thompson sampling explores once there is data, but the proven model wins most draws', () => {
  const rows = [...Array.from({ length: 12 }, () => row('m/good')), ...Array.from({ length: 4 }, () => row('m/bad', { status: 'failed', verify: null, outcomes: ['running'] }))];
  const stats = statsFromOutcomes(rows, NOW);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let good = 0, newbie = 0;
  for (let i = 0; i < 400; i++) {
    const top = rankModels([{ id: 'm/bad' }, { id: 'm/new' }, { id: 'm/good' }], 'edit', { stats, rnd })[0].id;
    if (top === 'm/good') good++; if (top === 'm/new') newbie++;
  }
  assert.ok(good > 250, `good won ${good}/400`);
  assert.ok(newbie > 5, `an untried model still gets explored (${newbie}/400)`);
  for (let i = 0; i < 50; i++) { const x = sampleBeta(2, 5, rnd); assert.ok(x > 0 && x < 1); }
});

test('loadRoutingStats + modelStatsTable read outcomes.jsonl (tail, bad lines skipped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-route-'));
  const file = path.join(dir, 'outcomes.jsonl');
  fs.writeFileSync(file, [JSON.stringify(row('m/a')), 'not json', JSON.stringify(row('m/b', { models: ['m/a', 'm/b'] })), ''].join('\n'));
  const s = loadRoutingStats(file, NOW);
  assert.equal(s.rows, 2);
  assert.ok(s.models.has('m/a') && s.models.has('m/b'));
  const t = modelStatsTable([row('m/a'), row('m/a', { status: 'failed', verify: null, outcomes: ['running'] })]);
  const a = t.find((x) => x.model === 'm/a' && x.type === 'all')!;
  assert.deepEqual([a.attempts, a.firstTryPass, a.reportSkipRate, a.refusedRate], [2, 0.5, 0.5, 0]);
  assert.equal(loadRoutingStats(path.join(dir, 'missing.jsonl')).rows, 0);
});

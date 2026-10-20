import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contrast, makePairs, mulberry32, wilson, type Pair, type Point } from './stats';
import { CallBook, billedFromStream, coldCostOf, costOfCalls, repriceRecord, sideCostOf, turnUsageOf, zeroTotals } from './usage';
import { buildBaseEnv, isShimDir, parentContextFiles, pathWithoutShims, plainArm, resolveArm, withModel } from './arms';
import { mergeAppendSystemPrompt, invalidReason, runOne, schedule } from './run';
import { checkAnswer, loadTasks, stateKeyOf, verifyTask } from './fixtures';
import { renderReport } from './report';
import { estimateFullRun } from './estimate';
import type { RunRecord } from './types';

const pt = (cost: number, passed: boolean): Point => ({ cost, coldCost: cost, passed, calls: 10, wallMs: 1000 });
const pair = (task: string, rep: number, a: Point, b: Point): Pair => ({ task, kind: 'k', rep, a, b });

test('mulberry32 is deterministic', () => {
  const x = mulberry32(7); const y = mulberry32(7);
  assert.deepEqual([x(), x(), x()], [y(), y(), y()]);
});

test('wilson interval brackets the rate and handles zero trials', () => {
  const w = wilson(8, 10);
  assert.ok(w.lo < 0.8 && w.hi > 0.8 && w.lo > 0.4 && w.hi < 1);
  assert.ok(Number.isNaN(wilson(0, 0).lo));
});

test('contrast: a clear 30% saving is reported as cheaper, and the bootstrap is deterministic', () => {
  const pairs: Pair[] = [];
  for (let t = 0; t < 6; t++) for (let r = 0; r < 5; r++) pairs.push(pair(`t${t}`, r, pt(1 + 0.05 * r, true), pt(0.7 + 0.03 * r, true)));
  const c1 = contrast(pairs, 'plain', 'kora');
  const c2 = contrast(pairs, 'plain', 'kora');
  assert.equal(c1.verdict, 'cheaper');
  assert.ok(c1.ratio.ci && c1.ratio.ci.hi < 1);
  assert.deepEqual(c1.ratio, c2.ratio);
  assert.equal(c1.evidence, 'ok');
});

test('contrast: a saving whose interval crosses zero is NOT called a saving', () => {
  // noisy: B is cheaper on average but the spread across tasks is huge
  const pairs: Pair[] = [
    pair('a', 1, pt(1, true), pt(0.5, true)), pair('a', 2, pt(1, true), pt(0.6, true)),
    pair('b', 1, pt(1, true), pt(1.8, true)), pair('b', 2, pt(1, true), pt(1.7, true)),
    pair('c', 1, pt(1, true), pt(0.4, true)), pair('c', 2, pt(1, true), pt(1.6, true)),
    pair('d', 1, pt(1, true), pt(1.4, true)), pair('d', 2, pt(1, true), pt(0.3, true)),
  ];
  const c = contrast(pairs, 'plain', 'kora');
  assert.notEqual(c.verdict, 'cheaper');
  assert.match(c.verdictText, /NOT a saving|no clear/);
  assert.equal(c.evidence, 'anecdote');
});

test('contrast: costlier is flagged and failures count against cost per passing task', () => {
  const pairs: Pair[] = [];
  for (let t = 0; t < 5; t++) for (let r = 0; r < 4; r++) pairs.push(pair(`t${t}`, r, pt(1, true), pt(1.0, r % 2 === 0)));
  const c = contrast(pairs, 'plain', 'kora');
  assert.equal(c.verdict, 'costlier'); // same spend, half the passes
  assert.ok(c.passDiff.est < 0);
});

test('contrast: no passing run in an arm cannot be compared', () => {
  const pairs = [pair('a', 1, pt(1, true), pt(1, false)), pair('b', 1, pt(1, true), pt(1, false))];
  assert.equal(contrast(pairs, 'plain', 'kora').verdict, 'cannot-compare');
});

function rec(p: Partial<RunRecord>): RunRecord {
  return {
    schema: 1, task: 't', kind: 'feature', arm: 'plain', rep: 1, order: 0, model: 'claude-haiku-5-5', effort: 'medium', startedAt: '', wallMs: 1000, turns: 1, apiCalls: 3,
    usage: { input: 10, cacheWrite: 100, cacheRead: 1000, output: 50 }, usageByModel: { 'claude-haiku-5-5': { input: 10, cacheWrite: 100, cacheRead: 1000, output: 50 } },
    cost: 0.1, coldCost: 0.12, reportedCost: 0.2, sideCost: 0, firstCall: null, tools: {} as any, passed: true, grade: null, timedOut: false, capped: false, invalid: null, error: null,
    filesChanged: [], sessionIds: [], armData: {}, setupMs: 0, ...p,
  };
}

test('makePairs drops a whole pair when either run is invalid', () => {
  const runs = [rec({ task: 'a', arm: 'plain' }), rec({ task: 'a', arm: 'kora', invalid: 'login' }), rec({ task: 'b', arm: 'plain' }), rec({ task: 'b', arm: 'kora' })];
  const ps = makePairs(runs, 'plain', 'kora');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].task, 'b');
});

test('report states the verdict plainly and never calls a crossing interval a saving', () => {
  const runs: RunRecord[] = [];
  const bCost = [0.5, 1.8, 0.4, 1.4];
  for (let t = 0; t < 4; t++) for (let r = 1; r <= 2; r++) {
    runs.push(rec({ task: 't' + t, rep: r, arm: 'plain', cost: 1, coldCost: 1 }));
    runs.push(rec({ task: 't' + t, rep: r, arm: 'kora', cost: bCost[t] + 0.05 * r, coldCost: bCost[t] }));
  }
  const md = renderReport(runs, { baseline: 'plain' });
  assert.match(md, /cost per passing task/i);
  assert.doesNotMatch(md, /is cheaper per passing task/);
  assert.match(md, /anecdote/);
});

test('CallBook: one API call streamed as several events counts once, using the max of every field', () => {
  const b = new CallBook();
  b.foldEvent({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 3 }, content: [{ type: 'thinking' }] } });
  b.foldEvent({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 40 }, content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } });
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].output, 40);
  assert.equal(b.tools.grep, 1);
});

test('CallBook.foldTranscript merges with the stream by message id (max wins)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-t-'));
  try {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 2 } } }) + '\n');
    const b = new CallBook();
    b.foldEvent({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }, content: [] } });
    b.foldTranscript(f);
    const c = b.list()[0];
    assert.equal(b.list().length, 1);
    assert.deepEqual([c.cacheWrite, c.cacheRead, c.output], [500, 2000, 40]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pricing: sonnet 5.5 prices follow the list (reads 0.1, 1h writes 4, in 2, out 10 per M); cold cost is never below warm cost', () => {
  const b = new CallBook();
  b.merge({ id: 'a', model: 'claude-sonnet-5-5', input: 0, cacheWrite: 0, cacheWrite1h: undefined, cacheRead: 1_000_000, output: 0 });
  assert.ok(Math.abs(costOfCalls(b.list()) - 0.1) < 1e-9, 'a million cache reads cost $0.10, not $0.20');
  const w = new CallBook();
  w.merge({ id: 'a', model: 'claude-sonnet-5-5', input: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 0, output: 1_000_000 });
  assert.ok(Math.abs(costOfCalls(w.list()) - 14) < 1e-6);
  const c = new CallBook();
  c.merge({ id: 'a', model: 'claude-sonnet-5-5', input: 10, cacheWrite: 0, cacheWrite1h: undefined, cacheRead: 50_000, output: 10 });
  assert.ok(coldCostOf(c.list()) > costOfCalls(c.list()), 'a warm first prompt is priced as a write in the cold variant');
});

test('sideCost: tokens the result counts beyond the assistant messages we saw are priced, never negative', () => {
  const seen = { 'claude-haiku-5-5': { input: 10, cacheWrite: 0, cacheRead: 100, output: 20 } };
  assert.equal(sideCostOf(seen, seen), 0);
  assert.ok(sideCostOf(seen, { 'claude-haiku-5-5': { input: 1010, cacheWrite: 0, cacheRead: 100, output: 20 } }) > 0);
  assert.equal(sideCostOf(seen, { 'claude-haiku-5-5': { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } }), 0);
  assert.equal(sideCostOf({}, { 'claude-haiku-5-5': zeroTotals() }), 0);
});

test('arms: the base env overrides Kora variables (never deletes one) and takes the Kora shims off PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-env-'));
  try {
    const shims = path.join(dir, 'shims'); fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'claude'), '#!/bin/sh\n# kora shim\nexec real\n');
    const real = path.join(dir, 'bin'); fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'claude'), '#!/bin/sh\necho real\n');
    assert.equal(isShimDir(shims), true);
    assert.equal(isShimDir(real), false);
    const base = { PATH: [shims, real].join(path.delimiter), KORA_AGENT: 'claude', KORA_ENV: '1', KORA_PANE_ID: 'p9', KORA_SOCKET_PATH: '/real/kora.sock', KORA_HOME: '/real/home', CLAUDECODE: '1', CLAUDE_CODE_SESSION: 'x', HOME: '/h' };
    const env = buildBaseEnv({ koraHome: '/iso/home', koraGraphHome: '/iso/graph', base });
    assert.equal(env.KORA_HOME, '/iso/home');
    assert.notEqual(env.KORA_SOCKET_PATH, '/real/kora.sock');
    assert.equal(env.KORA_PANE_ID, '');
    assert.equal(env.KORA_AGENT, 'claude', 'the agent marker is kept');
    assert.equal(env.KORA_ENV, '1');
    assert.equal(env.KORAGRAPH_HOME, '/iso/graph');
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION, undefined);
    assert.equal(env.HOME, '/h', 'the real HOME is kept (a fake HOME breaks the login)');
    assert.equal(env.PATH, real);
    assert.equal(pathWithoutShims(undefined), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('arms: parentContextFiles finds a CLAUDE.md above the repo copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-ctx-'));
  try {
    const work = path.join(dir, 'a', 'b', 'repo'); fs.mkdirSync(work, { recursive: true });
    const before = parentContextFiles(work).filter((f) => f.startsWith(dir));
    assert.deepEqual(before, []);
    fs.writeFileSync(path.join(dir, 'a', 'CLAUDE.md'), 'x');
    assert.deepEqual(parentContextFiles(work).filter((f) => f.startsWith(dir)), [path.join(dir, 'a', 'CLAUDE.md')]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run: the nonce is appended to an existing --append-system-prompt, or added', () => {
  assert.deepEqual(mergeAppendSystemPrompt(['-p', 'x'], 'N'), ['-p', 'x', '--append-system-prompt', 'N']);
  assert.deepEqual(mergeAppendSystemPrompt(['--append-system-prompt', 'RULES'], 'N'), ['--append-system-prompt', 'RULES\n\nN']);
});

test('run: invalid runs are excluded, a timeout or cap is a failed measurement, not an invalid one', () => {
  const base = { apiCalls: 5, code: 0, timedOut: false, capped: false, interrupted: false, result: null, stderr: '', error: null };
  assert.match(invalidReason({ ...base, apiCalls: 0 })!, /no API call/);
  assert.equal(invalidReason({ ...base, timedOut: true, result: null, code: null }), null);
  assert.equal(invalidReason({ ...base, capped: true, code: null }), null);
  assert.match(invalidReason({ ...base, interrupted: true })!, /interrupted/);
  assert.match(invalidReason({ ...base, result: { sessionId: 's', isError: true, text: 'rate limit exceeded', numTurns: 1, reported: 0, modelUsage: {}, subtype: null } })!, /transient/);
  assert.equal(invalidReason({ ...base, result: { sessionId: 's', isError: false, text: 'done', numTurns: 1, reported: 0, modelUsage: {}, subtype: null } }), null);
});

test('schedule: repetition-major, every arm once per pair, order reproducible from the seed', () => {
  const tasks = loadTasks().slice(0, 3);
  const arms = [{ id: 'plain' }, { id: 'kora' }] as any;
  const s1 = schedule(tasks, arms, 2, 5);
  const s2 = schedule(tasks, arms, 2, 5);
  assert.deepEqual(s1.map((p) => p.order), s2.map((p) => p.order));
  assert.equal(s1.length, 6);
  assert.deepEqual(s1.slice(0, 3).map((p) => p.rep), [1, 1, 1]);
  for (const p of s1) assert.deepEqual([...p.order].sort(), ['kora', 'plain']);
  const firsts = new Set(schedule(loadTasks(), arms, 6, 5).map((p) => p.order[0]));
  assert.equal(firsts.size, 2, 'the order is shuffled, not fixed');
});

test('answer check: required symbols, forbidden ones allowed only on a negating line', () => {
  const check = { all: ['nextDelay'], none: ['formatRetryNotice'], exceptLine: 'not a caller' };
  assert.equal(checkAnswer(check, 'nextDelay calls it').ok, true);
  assert.equal(checkAnswer(check, 'nextDelay and formatRetryNotice').ok, false);
  assert.equal(checkAnswer(check, 'nextDelay\nformatRetryNotice is not a caller').ok, true);
  assert.equal(checkAnswer(check, 'nothing').ok, false);
});

test('estimate: re-prices calibration tokens at the target model and scales to the full run', () => {
  const runs: RunRecord[] = [];
  for (const arm of ['plain', 'kora']) for (const task of ['T1', 'T2']) for (let r = 1; r <= 2; r++) runs.push(rec({ task, arm, rep: r, usageByModel: { 'claude-haiku-5-5': { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 0 } } }));
  const e = estimateFullRun(runs, { targetModel: 'claude-sonnet-5-5', reps: 10, taskIds: ['T1', 'T2', 'T9', 'T4'], safetyFactor: 1.5 });
  assert.equal(e.runs, 2 * 4 * 10);
  assert.ok(Math.abs(e.perArm.plain.perRun - 0.1) < 1e-9, 'a million cache reads at the sonnet list price');
  assert.ok(Math.abs(e.base - 0.1 * 80) < 1e-6);
  assert.ok(Math.abs(e.padded - e.base * 1.5) < 1e-9);
  assert.deepEqual(e.extrapolatedTasks, ['T9', 'T4']);
});

test('fixtures: every task has a unique id, a repo that exists and one state key per start state', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 8 && tasks.length <= 16);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const t of tasks) { assert.ok(fs.existsSync(t.repoDir), t.id); assert.ok(stateKeyOf(t).includes(t.repo)); }
  assert.equal(stateKeyOf(tasks.find((t) => t.id.startsWith('T1'))!), stateKeyOf(tasks.find((t) => t.id.startsWith('T2'))!), 'T1 and T2 share one start state (one index)');
});

test('fixtures: the hidden tests are not in any start state the agent sees', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-verify-'));
  try {
    for (const t of loadTasks()) {
      if (!t.grade.hidden) continue;
      const r = verifyTask(t, scratch);
      assert.deepEqual(r.problems, [], t.id);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});


test('estimate: an arm calibrated on fewer tasks is scaled from the reference arm, never NaN', () => {
  const big = { 'claude-haiku-5-5': { input: 10, cacheWrite: 1000, cacheRead: 100000, output: 5000 } };
  const runs = [
    rec({ task: 'A', arm: 'plain' }), rec({ task: 'B', arm: 'plain', usageByModel: big }),
    rec({ task: 'A', arm: 'kora' }),
  ];
  const e = estimateFullRun(runs, { targetModel: 'claude-sonnet-5-5', reps: 10, taskIds: ['A', 'B'] });
  assert.ok(Number.isFinite(e.base) && Number.isFinite(e.padded));
  // kora ran A at the same tokens as plain (ratio 1), so its B is plain's B, not the average of A
  assert.equal(e.perArm.kora.perTask.B, e.perArm.plain.perTask.B);
  assert.ok(e.notes.some((n) => n.includes('kora was measured on 1 task')));
});

test('arms: <arm>@<model> is that arm on its own model; a bare id is unchanged', () => {
  const avail = { plain: plainArm, kora: { id: 'kora', label: 'Kora', prepare: plainArm.prepare } };
  assert.equal(resolveArm('plain', avail), plainArm, 'the default arm is untouched');
  assert.equal(resolveArm('plain', avail).model, undefined);
  const h = resolveArm('plain@haiku', avail);
  assert.equal(h.id, 'plain@haiku');
  assert.equal(h.model, 'claude-haiku-5-5');
  assert.equal(h.prepare, plainArm.prepare, 'same preparation as the base arm');
  assert.equal(resolveArm('kora@claude-sonnet-5-5', avail).model, 'claude-sonnet-5-5');
  assert.equal(resolveArm('kora@opus', avail).id, 'kora@opus');
  assert.throws(() => resolveArm('nope@haiku', avail), /unknown arm "nope@haiku"/);
  assert.throws(() => resolveArm('plain@', avail), /unknown arm/);
  assert.throws(() => resolveArm('codegraph', avail), /unknown arm "codegraph"/);
  // @<model>:<effort>: that model at that effort; variants share the base arm's repo copy + graph store (home)
  const low = resolveArm('kora@opus:low', avail);
  assert.equal(low.id, 'kora@opus:low');
  assert.equal(low.model, 'claude-opus-5-5');
  assert.equal(low.effort, 'low');
  assert.equal(low.home, 'kora');
  assert.equal(h.effort, undefined, 'no effort suffix keeps the run effort');
  assert.equal(h.home, 'plain');
  assert.throws(() => resolveArm('kora@opus:fast', avail), /effort must be one of/);
});

test('run: an arm with its own model runs claude on it and records it; others keep the run model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-model-'));
  const argvLog = path.join(dir, 'argv.jsonl');
  const bin = path.join(dir, 'fake-claude');
  // a stand-in for `claude -p --output-format stream-json`: logs its argv, answers with one priced call on --model
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
const model = argv[argv.indexOf('--model') + 1];
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } };
console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_' + Math.random().toString(36).slice(2), model, usage, content: [{ type: 'text', text: 'done' }] } }));
console.log(JSON.stringify({ type: 'result', session_id: 'fake-session', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, modelUsage: {} }));
`);
  fs.chmodSync(bin, 0o755);
  try {
    const task = loadTasks().find((t) => t.id.startsWith('T2'))!;
    const cfg = { root: path.join(dir, 'root'), outDir: path.join(dir, 'out'), model: 'claude-sonnet-5-5', effort: 'low', reps: 1, seed: 1, tasks: [task], arms: [], budgetUsd: 1, runCapUsd: 1, claudeBin: bin, log: () => {} };
    const onHaiku = await runOne(cfg, task, withModel(plainArm, 'haiku'), 1, 0);
    const onRunModel = await runOne(cfg, task, plainArm, 1, 1);
    const onOpusHigh = await runOne(cfg, task, withModel(plainArm, 'opus', 'high'), 1, 2);
    const argvs = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    const modelOf = (a: string[]) => a[a.indexOf('--model') + 1];
    const effortOf = (a: string[]) => a[a.indexOf('--effort') + 1];
    assert.deepEqual(argvs.map(modelOf), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(argvs.map(effortOf), ['low', 'low', 'high'], 'an arm effort overrides the run effort; others keep it');
    assert.equal(onOpusHigh.effort, 'high');
    assert.equal(onHaiku.effort, 'low');
    assert.equal(onHaiku.arm, 'plain@haiku');
    assert.equal(onHaiku.model, 'claude-haiku-5-5');
    assert.equal(onRunModel.model, 'claude-sonnet-5-5');
    // priced at each model's own list price: 1000 1h-write + 10 in + 100 out
    assert.ok(Math.abs(onHaiku.cost - (1000 * 0.2 + 10 * 0.1 + 100 * 0.5) / 1e6) < 1e-12, `haiku cost ${onHaiku.cost}`);
    assert.ok(Math.abs(onRunModel.cost - (1000 * 4 + 10 * 2 + 100 * 10) / 1e6) < 1e-12, `sonnet cost ${onRunModel.cost}`);
    // each arm id gets its own isolated home under the root; variants share the base arm's repo copy
    assert.ok(fs.existsSync(path.join(cfg.root, 'arms', 'plain@haiku', 'home')));
    assert.ok(fs.existsSync(path.join(cfg.root, 'arms', 'plain@opus:high', 'home')));
    assert.ok(fs.existsSync(path.join(cfg.root, 'arms', 'plain', 'home')));
    assert.deepEqual(fs.readdirSync(path.join(cfg.root, 'work')), ['plain']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('usage: a resumed session reports cumulatively; each turn counts once (real T4 numbers, 2026-10-16)', () => {
  const h = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ 'claude-haiku-5-5': { input, cacheWrite, cacheRead, output } });
  const turns = [h(14, 19894, 179135, 7094), h(28, 38074, 495078, 19465), h(36, 43403, 723381, 23391), h(44, 51183, 973915, 27451)];
  assert.deepEqual(turnUsageOf(turns[0], turns[1]), h(14, 18180, 315943, 12371), 'turn 2 alone = its result.usage');
  assert.deepEqual(turnUsageOf(null, turns[0]), turns[0]);
  assert.deepEqual(turnUsageOf(turns[1], h(1, 1, 1, 1)), h(1, 1, 1, 1), 'a result smaller than the last is the turn\'s own');
  const stream = turns.map((mu, i) => JSON.stringify({ type: 'result', total_cost_usd: [0.0093, 0.0223, 0.0276, 0.0337][i], modelUsage: Object.fromEntries(Object.entries(mu).map(([m, u]) => [m, { inputTokens: u.input, cacheCreationInputTokens: u.cacheWrite, cacheReadInputTokens: u.cacheRead, outputTokens: u.output }])) })).join('\n');
  const { billed, reported } = billedFromStream(stream);
  assert.deepEqual(billed, turns[3], 'four resumed turns bill the last cumulative total, not the sum');
  assert.ok(Math.abs(reported - 0.0337) < 1e-12);
  // the record as the old harness wrote it: side cost from summing the four cumulative results
  const seen = turns[3];
  const old = { cost: 0.3299, coldCost: 0.333, sideCost: 0.2962, reportedCost: 0.0929, usageByModel: seen };
  const fixed = repriceRecord(old, stream);
  assert.equal(fixed.sideCost, 0);
  assert.ok(Math.abs(fixed.cost - (0.3299 - 0.2962)) < 1e-12);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentAlias, ApprovedPicks, checkWorker, cliModelId, loadWorkerCatalog, noSubagentArgs, normalizeEffort, sameModel, stretchPicks, workerCatalogText, type WorkerCatalog, type WorkerPick, type WorkerPickerAnswer } from './worker-picker';
import { fleetToolSpecs, workerLaunchArgs } from './fleet-tools';

const catalog: WorkerCatalog = {
  agents: {
    claude: { installed: true, models: [
      { id: 'default', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'opus[1m]', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'haiku', efforts: [] },
    ] },
    codex: { installed: true, models: [
      { id: 'gpt-5.5', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ] },
    gemini: { installed: false, models: [] },
  },
};

test('catalog check: valid picks pass, impossible ones are refused with what is valid', () => {
  assert.deepEqual(checkWorker({ agent: 'codex', model: 'gpt-5.5', effort: 'med' }, catalog), { ok: true, model: 'gpt-5.5', effort: 'medium' });
  assert.match((checkWorker({ agent: 'codex', model: 'opus' }, catalog) as any).error, /does not accept the model id "opus".*gpt-5.5/);
  assert.match((checkWorker({ agent: 'codex', model: 'gpt-5.5', effort: 'max' }, catalog) as any).error, /no effort "max"/);
  assert.match((checkWorker({ agent: 'claude', model: 'haiku', effort: 'high' }, catalog) as any).error, /no effort setting/);
  assert.match((checkWorker({ agent: 'gemini' }, catalog) as any).error, /not installed/);
  assert.match((checkWorker({ agent: 'cursor' }, catalog) as any).error, /not installed/);
  assert.equal(checkWorker({ agent: 'claude', model: 'claude-sonnet-5' }, catalog).ok, true, 'full claude ids are fine');
  assert.deepEqual(checkWorker({ agent: 'claude', model: 'haiku', effort: 'high' }, catalog, true), { ok: true, model: 'haiku' }, 'lenient drops the effort');
  assert.equal(normalizeEffort(' HIGH '), 'high');
});

test('sameModel: a full claude id and its alias match; codex ids must be exact', () => {
  assert.ok(sameModel('claude', 'haiku', 'claude-haiku-4-5-20251001'));
  assert.ok(sameModel('claude', 'opus[1m]', 'opus'));
  assert.ok(!sameModel('claude', 'default', 'opus'));
  assert.ok(!sameModel('codex', 'gpt-5.5', 'gpt-5.6-luna'));
});

test('ApprovedPicks: one spawn per pick, matched by agent (and model when named)', () => {
  const a = new ApprovedPicks();
  a.add([{ title: 'a', agent: 'codex', model: 'gpt-5.5', effort: 'low' }, { title: 'b', agent: 'claude', model: 'haiku' }]);
  assert.equal(a.take('codex', 'gpt-5.6-luna'), null, 'a model the user did not approve');
  assert.equal(a.take('claude', 'claude-haiku-4-5-20251001')!.title, 'b');
  assert.equal(a.take('codex')!.title, 'a', 'no model named: the approved one');
  assert.equal(a.take('codex'), null, 'used up');
  assert.deepEqual(a.unused(), []);
});

test('catalog text lists installed CLIs only', () => {
  const t = workerCatalogText(catalog);
  assert.match(t, /codex: models gpt-5.5\*, gpt-5.6-luna · effort low\|medium\|high\|xhigh\|max/);
  assert.doesNotMatch(t, /gemini/);
});

test('workers never get harness-native subagents; codex skips its update screen', () => {
  assert.deepEqual(noSubagentArgs('claude'), ['--disallowedTools=Agent,Task,Workflow']);
  assert.deepEqual(noSubagentArgs('codex'), ['--disable', 'multi_agent', '-c', 'check_for_update_on_startup=false']);
  assert.ok(workerLaunchArgs({ agent: 'claude' }, 'codex', {}).args.join(' ').includes('--disable multi_agent'));
});

function harness(ask?: (p: WorkerPick[]) => Promise<WorkerPickerAnswer>, extra: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-picker-'));
  fs.writeFileSync(path.join(home, 'worker-catalog.json'), JSON.stringify(catalog));
  const spawned: any[] = [];
  const asked: WorkerPick[][] = [];
  const specs = fleetToolSpecs({
    fleet: undefined, orchestratorId: 'chat:x', agent: 'claude', cwd: '/tmp', account: null, agentMode: 'chat', koraHome: home,
    spawnWorker: async (p: any) => { spawned.push(p); return { id: `p${spawned.length}`, agent: p.agent, account: null }; },
    ...(ask ? { askWorkers: async (p: WorkerPick[]) => { asked.push(p); return ask(p); } } : {}),
    ...extra,
  } as any);
  const tool = (n: string) => specs.find((s) => s.name === n)!;
  assert.equal(loadWorkerCatalog(home).agents.codex!.models.length, 2);
  return { ask: tool('kora_ask_workers'), spawn: tool('kora_spawn'), spawned, asked };
}

test('kora_spawn without an approved pick is refused — ask first', async () => {
  const h = harness(async (p) => ({ picks: p }));
  const r = await h.spawn.handler({ agent: 'codex', prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Call kora_ask_workers/);
  assert.equal(h.spawned.length, 0);
});

test('ask → the user changes a model → spawn launches the USER\'s choice, not the lead\'s', async () => {
  const h = harness(async (p) => ({ picks: [{ ...p[0]!, model: 'gpt-5.6-luna', effort: 'max' }, p[1]!] }));
  const r = await h.ask.handler({ tasks: [
    { title: 'refactor', agent: 'codex', model: 'gpt-5.5', effort: 'high', why: 'big' },
    { title: 'tests', agent: 'claude', model: 'opus', effort: 'nonsense' },
    { title: 'bad', agent: 'codex', model: 'claude-opus-5' },
  ] });
  // The proposal shown to the user is fixed up: an impossible model → CLI default, a bad effort dropped.
  assert.deepEqual(h.asked[0]![1], { title: 'tests', agent: 'claude', model: 'opus[1m]' });
  assert.deepEqual(h.asked[0]![2], { title: 'bad', agent: 'codex' });
  assert.match(r.text, /The user approved:\n  1\. "refactor" → codex gpt-5.6-luna max\n  2\. "tests" → claude opus\[1m\]/);
  assert.match(r.text, /Removed by the user \(do not spawn\): bad/);
  const s1 = await h.spawn.handler({ agent: 'codex', model: 'gpt-5.5', prompt: 'go' });
  assert.equal(s1.isError, true, 'the lead\'s original model was not approved');
  const s2 = await h.spawn.handler({ agent: 'codex', prompt: 'go', title: 'refactor' });
  assert.ok(!s2.isError, s2.text);
  assert.match(s2.text, /codex, gpt-5.6-luna max/);
  const args = h.spawned[0].args.join(' ');
  assert.ok(args.includes('--model gpt-5.6-luna') && args.includes('model_reasoning_effort="max"'), args);
  const s3 = await h.spawn.handler({ agent: 'codex', prompt: 'again' });
  assert.equal(s3.isError, true, 'one spawn per approved pick');
  assert.match(s3.text, /Still approved: "tests" → claude opus\[1m\]/);
});

test('a full claude id is shown as the catalog model; an approved pick never inherits the lead\'s model or effort', async () => {
  const h = harness(async (p) => ({ picks: p }), { model: { model: 'haiku', effort: 'low' } });
  await h.ask.handler({ tasks: [{ title: 'a', agent: 'claude', model: 'claude-haiku-4-5-20251001' }, { title: 'b', agent: 'claude' }] });
  assert.equal(h.asked[0]![0]!.model, 'haiku');
  await h.spawn.handler({ agent: 'claude', model: 'haiku', prompt: 'x' });
  await h.spawn.handler({ agent: 'claude', prompt: 'y' });
  assert.equal(h.spawned[0].args.join(' ').includes('--effort'), false, 'no effort was picked');
  assert.equal(h.spawned[1].args.includes('--model'), false, '"CLI default" means the CLI default');
});

test('decline → the lead is told to do it itself; nothing can spawn', async () => {
  const h = harness(async () => ({ picks: [], cancelled: true }));
  const r = await h.ask.handler({ tasks: [{ title: 'a', agent: 'codex' }] });
  assert.match(r.text, /declined/);
  assert.equal((await h.spawn.handler({ agent: 'codex', prompt: 'x' })).isError, true);
});

test('no UI to ask (or "don\'t ask again"): the proposal is approved as-is', async () => {
  const h = harness();
  const r = await h.ask.handler({ tasks: [{ title: 'a', agent: 'claude', model: 'haiku' }] });
  assert.match(r.text, /Approved as proposed/);
  assert.ok(!(await h.spawn.handler({ agent: 'claude', prompt: 'x' })).isError);
});

test('a Swarm (Stretch) thread: kora_ask_workers is the cheap fallback tier, still a real approval for kora_spawn', async () => {
  const h = harness(undefined, { agentMode: 'swarm', swarm: { taskForPane: () => null } });
  assert.match(h.ask.description, /Stretch fallback/);
  const r = await h.ask.handler({ tasks: [{ title: 'x', agent: 'claude', model: 'haiku' }] });
  assert.ok(!r.isError);
  assert.match(r.text, /Approved as proposed/);
  assert.ok(!(await h.spawn.handler({ agent: 'claude', prompt: 'x' })).isError);
  // no approved pick, no worker: the fallback is not an open door
  assert.equal((await h.spawn.handler({ agent: 'codex', prompt: 'x' })).isError, true);
});

test('kora_spawn agent:claude with tasks:[…] is refused, not silently turned into one empty worker (live 2026-10-19)', async () => {
  const h = harness(undefined, { agentMode: 'swarm', swarm: { taskForPane: () => null } });
  await h.ask.handler({ tasks: [{ title: 'a', agent: 'claude', model: 'haiku' }, { title: 'b', agent: 'claude', model: 'haiku' }] });
  const r = await h.spawn.handler({ agent: 'claude', tasks: [{ prompt: 'one' }, { prompt: 'two' }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /once per worker/);
  assert.equal(h.spawned.length, 0);
  assert.ok(!(await h.spawn.handler({ agent: 'claude', prompt: 'one' })).isError, 'the approved picks are still intact');
});

test('stretchPicks: only Claude Haiku and Codex Luna run, whatever was proposed; other agents drop; effort capped at low', () => {
  const picks: WorkerPick[] = [
    { title: 'a', agent: 'claude', model: 'opus[1m]', effort: 'max' },
    { title: 'b', agent: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
    { title: 'c', agent: 'gemini' },
    { title: 'd', agent: 'antigravity', model: 'gemini-3.8-flash-high' },
  ];
  assert.deepEqual(stretchPicks(picks, catalog), [
    { title: 'a', agent: 'claude', model: 'haiku' },
    { title: 'b', agent: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
  ]);
  const withNewer: WorkerCatalog = { agents: { ...catalog.agents, claude: { installed: true, models: [{ id: 'haiku' }, { id: 'claude-haiku-4-5' }, { id: 'claude-haiku-5-5' }] }, codex: { installed: true, models: [{ id: 'gpt-5.6-luna', efforts: ['low'] }, { id: 'gpt-6-luna', efforts: ['low', 'high'] }] } } };
  assert.deepEqual(stretchPicks(picks.slice(0, 2), withNewer).map((p) => p.model), ['claude-haiku-5-5', 'gpt-6-luna']);
  assert.deepEqual(stretchPicks(picks.slice(0, 2), { agents: { claude: { installed: false, models: [] } } }), []);
});

// Live 2026-10-02: the picker said "Sonnet 5.5"; the worker ran `claude --model sonnet` and the older CLI on PATH
// resolved the alias to claude-sonnet-5. The argv now carries the catalog's resolved full id.
test('a Claude alias launches as the full id the catalog resolved it to; the pick still reads as the alias', () => {
  const catalog = { agents: { claude: { installed: true, models: [
    { id: 'sonnet', name: 'Sonnet 5.5', efforts: ['medium'], resolved: 'claude-sonnet-5-5' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: ['medium'] },
  ] } } };
  assert.equal(cliModelId('claude', 'sonnet', catalog), 'claude-sonnet-5-5');
  assert.equal(cliModelId('claude', 'sonnet[1m]', catalog), 'claude-sonnet-5-5[1m]');
  assert.equal(cliModelId('claude', 'claude-sonnet-5', catalog), 'claude-sonnet-5', 'a full id is kept');
  assert.equal(cliModelId('claude', 'haiku', catalog), 'haiku', 'no resolution known → as given');
  assert.equal(cliModelId('codex', 'sonnet', catalog), 'sonnet', 'only Claude aliases');
  const r = workerLaunchArgs({ agent: 'claude' }, 'claude', { model: 'sonnet', effort: 'medium' }, { catalog });
  assert.equal(r.model, 'sonnet');
  assert.deepEqual(r.args.slice(0, 4), ['--model', 'claude-sonnet-5-5', '--effort', 'medium']);
});

// Live 2026-10-02 (qa/e2e/model/orchestrator.cjs): every approved pick was for an agent the catalog lists as not
// installed; the filter left nothing, the tool still said "The user approved:" and the lead looped spawn → refused.
test('approved picks that cannot run here are named; an all-impossible approval is an error, not "approved"', async () => {
  const h = harness(async (p) => ({ picks: p }));
  const r = await h.ask.handler({ tasks: [{ title: 'hello', agent: 'opencode' }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /^None of the approved workers can run on this machine: "hello" \(opencode is not installed/);
  const mixed = await h.ask.handler({ tasks: [{ title: 'a', agent: 'codex' }, { title: 'b', agent: 'opencode' }] });
  assert.ok(!mixed.isError);
  assert.match(mixed.text, /1\. "a" → codex/);
  assert.match(mixed.text, /Cannot run here \(not spawned\): "b" \(opencode is not installed/);
});

test('a worker on Default never launches `--model default` (Opus): the catalog\'s resolved id, else the user\'s setting or Sonnet', () => {
  const withResolved = { agents: { claude: { installed: true, models: [{ id: 'default', name: 'Default · Sonnet 5.5', efforts: [], isDefault: true, resolved: 'claude-sonnet-5-5' }] } } };
  assert.equal(cliModelId('claude', 'default', withResolved), 'claude-sonnet-5-5');
  const bare = { agents: { claude: { installed: true, models: [{ id: 'default', name: 'Default', efforts: [] }] } } };
  assert.notEqual(cliModelId('claude', 'default', bare), 'default');
  assert.equal(cliModelId('codex', 'default', bare), 'default', 'only Claude');
});

test('ApprovedPicks: a released pick can be taken again (failed spawn does not burn the approval)', () => {
  const a = new ApprovedPicks();
  const p: WorkerPick = { title: 't', agent: 'codex', model: 'gpt-x' };
  a.add([p]);
  const hit = a.take('codex')!;
  assert.equal(a.take('codex'), null);
  a.release(hit);
  assert.notEqual(a.take('codex'), null);
});

test("agentAlias: the CLI's name `agy` is Kora's `antigravity`; other ids pass through", () => {
  assert.equal(agentAlias('agy'), 'antigravity');
  assert.equal(agentAlias(' AGY '), 'antigravity');
  assert.equal(agentAlias('codex'), 'codex');
});

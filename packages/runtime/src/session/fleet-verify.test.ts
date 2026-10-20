// B13: kora_verify (the task checks, once, bounded), failingNames, the git summary on kora_merge, the failover budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FleetControl, FleetToolContext, SwarmSpawner } from './fleet-tools';
import { fleetToolSpecs, inferFocus, formatVerifyResult, mergeGitSummary, mergeHead, FLEET_TOOL_NAMES } from './fleet-tools';
import { failingNames } from '../server/swarm-foreman';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-verify-'));
  git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), '1\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  return d;
}
const fleetStub = (over: Partial<FleetControl> = {}): FleetControl => ({
  list: async () => [], prompt: async () => ({ state: 'idle' }), wait: async () => ({ state: 'idle', blocker: null, timedOut: false, exited: false }), read: async () => '', report: async () => '', kill: async () => {},
  mergeVerify: async () => ({ pairs: [], order: [] }), merge: async () => ({ ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }), setPlan: async () => {}, ...over,
}) as any;
const ctxFor = (cwd: string, swarm: Partial<SwarmSpawner> | undefined, over: Partial<FleetToolContext> = {}): FleetToolContext => ({
  fleet: fleetStub(), orchestratorId: 'chat:t', agent: 'claude', cwd, account: null, agentMode: 'swarm',
  spawnWorker: async () => { throw new Error('no'); },
  ...(swarm ? { swarm: { spawn: async () => { throw new Error('no'); }, taskForPane: () => null, readReport: async () => null, ...swarm } as SwarmSpawner } : {}), ...over,
}) as any;
const tool = (c: FleetToolContext, name: string) => fleetToolSpecs(c).find((t) => t.name === name)!;

test('failingNames: node:test, TAP, vitest/jest, pytest, go, cargo and tsc failure lines; deduped, bounded', () => {
  const out = [
    '✔ fine (1ms)', '✖ parses trailing commas (3.2ms)', '✖ parses trailing commas (3.2ms)', 'not ok 4 - handles empty input',
    ' FAIL  src/a.test.ts > suite > does a thing', '  ● Suite › renders', 'FAILED tests/test_x.py::test_y - AssertionError', '--- FAIL: TestRoute (0.00s)',
    'test mod::it_works ... FAILED', "src/x.ts(10,5): error TS2322: Type 'a' is not assignable", 'src/y.ts:3:9 - error TS7006: implicit any',
    '\u001b[31m✖ coloured one\u001b[39m',
  ].join('\n');
  const r = failingNames(out);
  assert.deepEqual(r.names, ['parses trailing commas', 'handles empty input', 'src/a.test.ts > suite > does a thing', 'Suite › renders', 'tests/test_x.py::test_y', 'TestRoute', 'mod::it_works', 'src/x.ts(10,5) TS2322', 'src/y.ts:3:9 TS7006', 'coloured one']);
  assert.equal(r.total, 10);
  const many = failingNames(Array.from({ length: 30 }, (_, i) => `✖ case ${i}`).join('\n'));
  assert.equal(many.names.length, 10); assert.equal(many.total, 30);
  assert.deepEqual(failingNames('all good\n'), { names: [], total: 0 });
});

test('kora_verify: runs the recorded checks once in the checkout, PASS/FAIL with failing names; refuses without a recorded check or over the remote bridge', async () => {
  const d = repo();
  const asked: any[] = [];
  const sw = { checksFor: (o: string, ids?: string[]) => { asked.push([o, ids]); return [{ taskId: 's2', check: `node -e "console.log('✖ broken thing'); process.exit(1)"` }, { taskId: 's1', check: 'node -e "process.exit(0)"' }]; } };
  const r = await tool(ctxFor(d, sw), 'kora_verify').handler({});
  assert.equal(r.isError, undefined);
  assert.match(r.text, /^kora_verify: FAIL \(1 of 2 checks failed\)/);
  assert.match(r.text, /FAIL {2}node -e .*\(exit 1, [\d.]+ s\) — 1 failing: broken thing/);
  assert.match(r.text, /PASS {2}node -e "process\.exit\(0\)"/);
  assert.deepEqual(asked, [['chat:t', undefined]]);
  await tool(ctxFor(d, sw), 'kora_verify').handler({ paneIds: ['p3'] });
  assert.deepEqual(asked[1], ['chat:t', ['p3']]);
  const ok = await tool(ctxFor(d, { checksFor: () => [{ taskId: 's1', check: 'true' }] }), 'kora_verify').handler({});
  assert.match(ok.text, /^kora_verify: PASS \(1 check\)/);
  // S6: a thread that asks before running commands does not get an unapproved command run for it.
  for (const runtimeMode of ['approval-required', 'auto-accept-edits'] as const) {
    let ran = false;
    const refused = await tool(ctxFor(d, { checksFor: () => { ran = true; return [{ taskId: 's1', check: 'true' }]; } }, { runtimeMode }), 'kora_verify').handler({});
    assert.equal(refused.isError, true); assert.match(refused.text, /asks before running commands/); assert.equal(ran, false, runtimeMode);
  }
  for (const runtimeMode of ['full-access', 'auto'] as const) {
    const allowed = await tool(ctxFor(d, { checksFor: () => [{ taskId: 's1', check: 'true' }] }, { runtimeMode }), 'kora_verify').handler({});
    assert.match(allowed.text, /^kora_verify: PASS/, runtimeMode);
  }
  const none = await tool(ctxFor(d, { checksFor: () => [] }), 'kora_verify').handler({});
  assert.equal(none.isError, true); assert.match(none.text, /no done-check was recorded/);
  const remote = await tool(ctxFor(d, {}), 'kora_verify').handler({});
  assert.equal(remote.isError, true); assert.match(remote.text, /not available over this bridge/);
  assert.ok((FLEET_TOOL_NAMES as readonly string[]).includes('kora_verify'));
  assert.ok(fleetToolSpecs(ctxFor(d, sw)).some((t) => t.name === 'kora_verify'), 'offered to a Swarm lead');
  // output stays bounded
  const noisy = formatVerifyResult('x', { state: 'failed', exitCode: 1, durationMs: 1500, tail: 'y'.repeat(5000), output: Array.from({ length: 40 }, (_, i) => `✖ n${i}`).join('\n') });
  assert.ok(noisy.length < 1200, String(noisy.length));
  fs.rmSync(d, { recursive: true, force: true });
});

test('kora_merge answers with a short git summary of what landed (and nothing extra when nothing landed)', async () => {
  const d = repo();
  const feat = (name: string, file: string) => { git(d, 'checkout', '-qb', name); fs.writeFileSync(path.join(d, file), 'x\ny\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', `add ${file}`); git(d, 'checkout', '-q', 'main'); };
  feat('w1', 'b.txt'); feat('w2', 'c.txt');
  const fleet = fleetStub({
    list: async () => [{ id: 'p1', worktree: { path: d, branch: 'w1', mainRoot: d } }] as any,
    merge: async (id) => { git(d, 'merge', '-q', '--no-edit', id === 'p1' ? 'w1' : 'w2'); return { ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }; },
  });
  const before = await mergeHead(d);
  const r = await tool(ctxFor(d, undefined, { fleet, agentMode: 'chat' }), 'kora_merge').handler({ paneId: 'p1' });
  assert.match(r.text, /^merged: ok \(1 commit\(s\)\)\ngit: [0-9a-f]{7}\.\.[0-9a-f]{7} — 1 file\(s\) 2\+/);
  assert.match(r.text, /add b\.txt/);
  assert.ok(r.text.length < 400);
  assert.equal(await mergeGitSummary(d, await mergeHead(d)), '', 'nothing landed: no summary');
  assert.equal(await mergeGitSummary(d, null), '');
  assert.equal(await mergeGitSummary('/definitely/not/a/repo', before), '', 'not a repo: fail soft');
  fs.rmSync(d, { recursive: true, force: true });
});

test('inferFocus: only recent locate queries that share a significant word with the task; at most 3', () => {
  const loc = { at: 1_000, queries: ['where the stop button handler lives', 'chooseWindow in read window', 'unrelated telemetry exporter', 'token ceiling'] };
  assert.deepEqual(inferFocus('Make the stop button handler ask first, then update chooseWindow tests', loc, 2_000), ['where the stop button handler lives', 'chooseWindow in read window']);
  assert.deepEqual(inferFocus('Rename a variable', loc, 2_000), [], 'nothing shared: no focus');
  assert.deepEqual(inferFocus('Make the stop button handler ask first', loc, 1_000 + 16 * 60_000), [], 'a stale locate is not the lead\'s plan any more');
  assert.deepEqual(inferFocus('anything about handler', null, 5), []);
});

test('kora_spawn: a task about located things gets the lead\'s locate queries as focus; an explicit focus wins', async () => {
  const d = repo();
  const calls: any[] = [];
  const swarm: any = { spawn: async (p: any) => { calls.push(p); return { paneId: 'p1', taskId: 's1', provider: 'zen', model: 'm', modelLabel: 'm', reportPath: '/r.md', overlaps: [] }; }, taskForPane: () => null, readReport: async () => null };
  const c = ctxFor(d, undefined, { swarm, locate: async () => 'ok' } as any);
  const specs = fleetToolSpecs(c);   // one set per session, as the driver builds it: kora_locate and kora_spawn share its memory
  const t = (n: string) => specs.find((x) => x.name === n)!;
  await t('kora_locate').handler({ queries: ['stop button handler'] });
  await t('kora_spawn').handler({ prompt: 'Make the stop button handler confirm first', title: 't' });
  assert.deepEqual(calls[0].focus, ['stop button handler']);
  await t('kora_spawn').handler({ prompt: 'Make the stop button handler confirm first', title: 't', focus: ['other.ts'] });
  assert.deepEqual(calls[1].focus, ['other.ts']);
  await t('kora_spawn').handler({ prompt: 'Reformat the readme', title: 't' });
  assert.equal(calls[2].focus, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

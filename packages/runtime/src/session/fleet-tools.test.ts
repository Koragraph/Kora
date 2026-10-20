// fleet-tools (S2): the `swarm` agent alias and default agent, the not-ready error text, kora_wait returning the
// swarm report and following a failed-over worker without a false EXITED, the screen-tail fallback, the restart
// ("lost") answer, the overlap warning and formatWorker's swarm suffix. FleetControl and the SwarmSpawner are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { FleetControl, FleetToolContext, SwarmSpawner } from './fleet-tools';
import { insideGitCheckout, sharedFolderNote, resetLastLookedForTests, fleetToolSpecs, formatWorker, compactReport, compactScreen, toJsonSchema, SWARM_REPORT_WAIT_CAP, SWARM_REPORT_COMPACT_CAP } from './fleet-tools';
import type { WorkerInfo } from '../server/fleet-ops';
import type { SwarmWorkerMeta } from '../protocol/types';

// The "since you last looked" digest remembers each lead's last look: every test here is lead chat:t1.
test.beforeEach(() => resetLastLookedForTests());
import { SwarmNotReadyError } from '../server/swarm-errors';
import { SWARM_THREAD_REQUIRED } from '../server/swarm';

const meta = (over: Partial<SwarmWorkerMeta> = {}): SwarmWorkerMeta => ({
  taskId: 's3', provider: 'zen', model: 'opencode/big-pickle', modelLabel: 'big-pickle', phase: 'running', attempt: 1,
  attempts: [{ paneId: 'p5', provider: 'zen', model: 'opencode/big-pickle', outcome: 'running', at: 1 }],
  reportPath: '/wt/.kora/swarm/s3.md', report: null, supersededBy: null, previousPaneIds: [], verify: null, ...over,
});
const worker = (id: string, over: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id, name: 'w', agent: 'opencode', account: null, state: 'idle', blocker: null, exited: false, exitCode: null, cwd: '/wt',
  worktree: { path: '/wt', branch: 'kora/opencode-1', mainRoot: '/r' }, costUsd: null, contextPct: null, steeredAt: null,
  createdAt: 1, lastOutputAt: 1, quietMs: 0, stalled: false, swarm: null, ...over,
});

function fleet(over: Partial<FleetControl> & { workers?: WorkerInfo[] } = {}): FleetControl & { waits: string[] } {
  const waits: string[] = [];
  return {
    waits,
    list: async () => over.workers ?? [],
    prompt: async () => ({ state: 'working' }),
    wait: async (id: string) => { waits.push(id); return { state: 'idle', blocker: null, timedOut: false, exited: false }; },
    read: async () => 'SCREEN LINE 1\nSCREEN LINE 2',
    report: async () => '',
    kill: async () => {},
    mergeVerify: async () => ({ pairs: [], order: [] }),
    merge: async () => ({ ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }),
    setPlan: async () => {},
    ...over,
  } as any;
}

function ctx(over: Partial<FleetToolContext> = {}): FleetToolContext & { spawned: any[] } {
  const spawned: any[] = [];
  return {
    spawned,
    fleet: fleet(), orchestratorId: 'chat:t1', agent: 'claude', cwd: '/r', account: null,
    spawnWorker: async (p: any) => { spawned.push(p); return { id: 'p9', agent: p.agent, account: null }; },
    ...over,
  } as any;
}

const tool = (c: FleetToolContext, name: string) => fleetToolSpecs(c).find((t) => t.name === name)!;

function spawner(over: Partial<SwarmSpawner> = {}): SwarmSpawner & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    spawn: async (p: any) => { calls.push(p); return { paneId: 'p5', taskId: 's3', provider: 'zen', model: 'opencode/big-pickle', modelLabel: 'big-pickle', reportPath: '/wt/.kora/swarm/s3.md', overlaps: [] }; },
    taskForPane: () => null,
    readReport: async () => null,
    ...over,
  } as any;
}

test('swarm thread: agent defaults to the swarm alias → SwarmService.spawn (never spawnWorker); a CLI worker needs an approved pick (the cheap fallback tier)', async () => {
  const sw = spawner();
  const c = ctx({ agentMode: 'swarm', swarm: sw, runtimeMode: 'full-access' });
  const spawn = tool(c, 'kora_spawn');
  assert.equal(spawn.params.agent.optional, true);
  assert.match(spawn.params.agent.description!, /^swarm \(DEFAULT/);
  const r = await spawn.handler({ prompt: 'add validation\nmore', title: 'validate' });
  assert.equal(r.isError, undefined);
  assert.equal(sw.calls.length, 1);
  assert.deepEqual(sw.calls[0], { orchestratorId: 'chat:t1', cwd: '/r', task: 'add validation\nmore', title: 'validate', runtimeMode: 'full-access' });
  assert.equal(c.spawned.length, 0);
  assert.match(r.text, /^spawned swarm worker p5 \(task s3, big-pickle via zen\) "validate" in its own worktree\. It writes its report to \/wt\/\.kora\/swarm\/s3\.md; kora_wait p5 returns the report\.$/);
  const mixed = await spawn.handler({ agent: 'claude', prompt: 'x' });
  assert.equal(mixed.isError, true);
  assert.match(mixed.text, /no approved pick for claude/); // the cheap fallback tier needs kora_ask_workers first
  assert.equal(c.spawned.length, 0);
  assert.equal(sw.calls.length, 1);
});

test('orchestrator thread: no swarm alias offered; agent:"swarm" is refused with the swarm-thread text', async () => {
  const sw = spawner();
  const c = ctx({ agentMode: 'orchestrator', swarm: sw });
  // One tool set per session (the approved picks live in it), as the drivers build them.
  const specs = fleetToolSpecs(c);
  const spawn = specs.find((t) => t.name === 'kora_spawn')!;
  assert.doesNotMatch(spawn.params.agent.description!, /swarm/);
  assert.equal(spawn.params.agent.optional, undefined);
  const r = await spawn.handler({ agent: 'swarm', prompt: 'x' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(SWARM_THREAD_REQUIRED));
  assert.equal(sw.calls.length, 0);
  // default stays claude (after the worker picker approves it; no UI here ⇒ approved as proposed)
  await specs.find((t) => t.name === 'kora_ask_workers')!.handler({ tasks: [{ title: 'x', agent: 'claude' }] });
  await spawn.handler({ prompt: 'x' });
  assert.equal(c.spawned[0].agent, 'claude');
});

test('not ready: SwarmNotReadyError text is the tool\'s isError answer', async () => {
  const sw = spawner({ spawn: async () => { throw new SwarmNotReadyError([{ code: 'opencode-missing', message: 'OpenCode is not installed' }]); } });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw }), 'kora_spawn').handler({ prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^swarm unavailable: OpenCode is not installed\. Tell the user what is missing and that they can fix it in Settings → Swarm or with `kora swarm setup`\. Do not do this task on your own tokens without asking\. In Stretch you can hand the slice to the cheap paid tier instead: kora_ask_workers \(claude Haiku or codex Luna\), then kora_spawn it/);
});

test('X3: overlaps ride on the kora_spawn reply as an advisory warning', async () => {
  const sw = spawner({ spawn: async () => ({ paneId: 'p6', taskId: 's4', provider: 'zen', model: 'm', modelLabel: 'm', reportPath: '/r.md', overlaps: [{ paneId: 'p4', files: ['src/auth.ts'] }] }) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw }), 'kora_spawn').handler({ prompt: 'x' });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /\n⚠ overlaps p4 \(src\/auth\.ts\) — consider sequencing$/);
});

test('kora_wait full:true returns the whole swarm report (capped at 16000 chars)', async () => {
  const long = 'x'.repeat(SWARM_REPORT_WAIT_CAP + 50);
  const w = worker('p5', { swarm: meta({ report: { bytes: long.length, updatedAt: Date.now(), preview: 'x' }, verify: { state: 'passed', bounces: 0, summary: 'merge gate clean' } }) });
  const sw = spawner({ readReport: async () => ({ text: long, truncated: false, updatedAt: Date.now() - 14_000 }) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: fleet({ workers: [w] }) }), 'kora_wait').handler({ paneId: 'p5', full: true });
  assert.match(r.text, /^p5: idle\n/);
  assert.match(r.text, /swarm=opencode\/big-pickle task=s3/);
  assert.match(r.text, /\nverify: passed — merge gate clean\n/);
  assert.match(r.text, /\n--- report s3 \(\/wt\/\.kora\/swarm\/s3\.md, [\d.]+ KB, written 1[45]s ago\) ---\nx+\n…truncated — kora_read for the rest$/);
  assert.equal((r.text.match(/x{100,}/)![0]).length, SWARM_REPORT_WAIT_CAP);
});

test('kora_wait on a queued task id (no pane yet) blocks until it starts, then answers with its report', async () => {
  let started = false;
  setTimeout(() => { started = true; }, 40); // the slot frees mid-wait, well inside kora_wait's own timeout
  const sw = spawner({
    taskForPane: (id) => (id !== 's9' ? null : started
      ? { taskId: 's9', orchestratorId: 'chat:t1', paneIds: ['p9'], reportPath: '/wt/.kora/swarm/s9.md', status: 'running' }
      : { taskId: 's9', orchestratorId: 'chat:t1', paneIds: [], reportPath: '', status: 'queued' }),
    readReport: async () => ({ text: '## Status\ndone — s9', truncated: false, updatedAt: Date.now() }),
  });
  const f = fleet({
    list: async () => (started ? [worker('p9', { swarm: meta({ taskId: 's9' }) })] : []),
    follow: async (id) => (started && id === 's9' ? 'p9' : id),
  });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: f }), 'kora_wait').handler({ paneId: 's9', mode: 'all', timeoutMs: 5000 });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /^s9 → p9\np9: idle\n/, 'resolved from the task id to the pane it started on');
  assert.match(r.text, /## Status\ndone — s9$/);
});

test('kora_wait on a queued task id still queued at the deadline says so plainly (not "gone")', async () => {
  const sw = spawner({ taskForPane: () => ({ taskId: 's9', orchestratorId: 'chat:t1', paneIds: [], reportPath: '', status: 'queued' }) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: fleet({ workers: [] }) }), 'kora_wait').handler({ paneId: 's9', mode: 'all', timeoutMs: 120 });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /^s9: still queued/);
});

test('journey d: kora_wait on p5 follows the failover to p7 — no false EXITED — and returns p7\'s report', async () => {
  let failedOver = false;
  const p7 = worker('p7', { swarm: meta({ model: 'opencode/grok-code', modelLabel: 'grok-code', attempt: 2, previousPaneIds: ['p5'], attempts: [{ paneId: 'p5', provider: 'zen', model: 'opencode/big-pickle', outcome: 'rate-limited', at: 1 }, { paneId: 'p7', provider: 'zen', model: 'opencode/grok-code', outcome: 'ok', at: 2 }] }) });
  const f = fleet({
    list: async () => (failedOver ? [p7] : [worker('p5', { state: 'working', swarm: meta() })]),
    wait: async (id) => {
      f.waits.push(id);
      if (id === 'p5') { failedOver = true; return { state: 'idle', blocker: null, timedOut: false, exited: true }; }
      return { state: 'idle', blocker: null, timedOut: false, exited: false };
    },
    follow: async (id) => (failedOver && id === 'p5' ? 'p7' : id),
  });
  const sw = spawner({ readReport: async (id) => (id === 'p7' ? { text: '## Done\nfixed it', truncated: false, updatedAt: Date.now() } : null) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: f }), 'kora_wait').handler({ paneId: 'p5' });
  assert.deepEqual(f.waits, ['p5', 'p7']);
  assert.match(r.text, /^p5 → p7 \(rate-limited on opencode\/big-pickle, now opencode\/grok-code\)\np7: idle\n/);
  assert.doesNotMatch(r.text, /p5: exited|EXITED/);
  assert.match(r.text, /## Done\nfixed it$/);
});

test('every paneId goes through follow: kora_prompt / kora_kill on an old id reach the replacement', async () => {
  const prompts: string[] = []; const kills: string[] = [];
  const f = fleet({ workers: [worker('p7', { swarm: meta() })], follow: async (id) => (id === 'p5' ? 'p7' : id), prompt: async (id) => { prompts.push(id); return { state: 'working' }; }, kill: async (id) => { kills.push(id); } });
  const c = ctx({ agentMode: 'swarm', swarm: spawner(), fleet: f });
  assert.match((await tool(c, 'kora_prompt').handler({ paneId: 'p5', text: 'more' })).text, /^delivered to p7/);
  await tool(c, 'kora_kill').handler({ paneId: 'p5' });
  assert.deepEqual([prompts, kills], [['p7'], ['p7']]);
});

test('journey l: idle with no report → the screen tail, labelled', async () => {
  const w = worker('p5', { swarm: meta() });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: spawner(), fleet: fleet({ workers: [w] }) }), 'kora_wait').handler({ paneId: 'p5' });
  assert.match(r.text, /\n\(no report file — screen tail\)\nSCREEN LINE 1\nSCREEN LINE 2\n\(kora_prompt it: "write your report to \/wt\/\.kora\/swarm\/s3\.md now"\)$/);
});

test('X2: kora_wait keeps waiting while the report is being verified / bounced, then returns the pass', async () => {
  let n = 0;
  const states: SwarmWorkerMeta['verify'][] = [{ state: 'pending', bounces: 0, summary: null }, { state: 'bounced', bounces: 1, summary: 'broken caller' }, { state: 'passed', bounces: 1, summary: 'merge gate clean after 1 bounce' }];
  const f = fleet({ list: async () => [worker('p5', { swarm: meta({ verify: states[Math.min(n++, 2)] }) })] });
  const sw = spawner({ readReport: async () => ({ text: 'R', truncated: false, updatedAt: Date.now() }) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: f }), 'kora_wait').handler({ paneId: 'p5' });
  assert.match(r.text, /\nverify: passed after 1 bounce — merge gate clean after 1 bounce\n--- report s3/);
});

test('journey c: a pane lost in a daemon restart answers from the task registry with its report', async () => {
  const sw = spawner({
    taskForPane: (id) => (id === 'p5' ? { taskId: 's3', orchestratorId: 'chat:t1', paneIds: ['p5'], reportPath: '/wt/.kora/swarm/s3.md', status: 'running' } : null),
    lostInRestart: () => true,
    readReport: async () => ({ text: 'partial findings', truncated: false, updatedAt: 1 }),
  });
  const c = ctx({ agentMode: 'swarm', swarm: sw });
  const r = await tool(c, 'kora_wait').handler({ paneId: 'p5' });
  assert.equal(r.isError, undefined);
  assert.equal(r.text, 'worker p5 was lost in a daemon restart (swarm task s3); report (if written): partial findings');
  const other = await tool(c, 'kora_wait').handler({ paneId: 'p99' });
  assert.equal(other.isError, true);
  assert.match(other.text, /^no worker p99 in this fleet/);
});

test('an exhausted task answers with its note', async () => {
  const note = '[kora] swarm task s3 failed on every free model (a, b; next reset 10:00:00). Rewrite or split it.';
  const sw = spawner({ taskForPane: () => ({ taskId: 's3', orchestratorId: 'chat:t1', paneIds: ['p5'], reportPath: '/r.md', status: 'exhausted' }), note: () => note });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw }), 'kora_wait').handler({ paneId: 'p5' });
  assert.equal(r.text, `${note} report (if written): (none)`);
});

test('formatWorker: swarm suffix with model, task, attempt and verify', () => {
  const s = formatWorker(worker('p7', { swarm: meta({ attempt: 2, phase: 'done', verify: { state: 'passed', bounces: 1, summary: null } }) }));
  assert.match(s, /  swarm=opencode\/big-pickle task=s3 attempt=2 phase=done verify=passed\(1 bounce\)/);
  assert.doesNotMatch(formatWorker(worker('p1', { agent: 'claude' })), /swarm=/);
});

// ── leader-lean: fewer leader calls (batch spawn, wait many, merge many) and compact reports ──

const report = (n: number) => ['## Status', 'done — added titleCase', '## Changes', ...Array.from({ length: n }, (_, i) => `src/f${i}.ts:${i} changed line ${i}`),
  '## Check', ...Array.from({ length: n }, (_, i) => `test output line ${i}`), 'ℹ tests 12  pass 12  fail 0', '## Findings', ...Array.from({ length: n }, (_, i) => `finding ${i} at src/x.ts:${i}`),
  '## Blockers', 'none'].join('\n');

test('compactReport: a short report is untouched; a long one keeps every section, the Check TAIL and a path to the rest', () => {
  assert.equal(compactReport('## Status\ndone', '/r.md'), '## Status\ndone');
  const long = report(200);
  const c = compactReport(long, '/wt/.kora/swarm/s3.md');
  assert.ok(long.length > 5 * SWARM_REPORT_COMPACT_CAP);
  assert.ok(c.length < SWARM_REPORT_COMPACT_CAP + 400, `${c.length}`);
  for (const h of ['## Status\ndone — added titleCase', '## Changes\nsrc/f0.ts:0', '## Check\n…', '## Findings\nfinding 0', '## Blockers\nnone']) assert.ok(c.includes(h), h);
  assert.match(c, /pass 12 {2}fail 0/, 'the check verdict (the end of its output) survives');
  assert.match(c, /\(compact — full report: \/wt\/\.kora\/swarm\/s3\.md, [\d.]+ KB; Read it or kora_wait full:true only if this is not enough\)$/);
  const free = compactReport('y'.repeat(9000), '/r.md');
  assert.ok(free.startsWith('y'.repeat(SWARM_REPORT_COMPACT_CAP)) && free.endsWith('only if this is not enough)'), 'no sections: the head + the path');
});

test('kora_wait (swarm) returns a compact report by default', async () => {
  const w = worker('p5', { swarm: meta({ verify: { state: 'passed', bounces: 0, summary: null } }) });
  const sw = spawner({ readReport: async () => ({ text: report(200), truncated: false, updatedAt: Date.now() }) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: fleet({ workers: [w] }) }), 'kora_wait').handler({ paneId: 'p5' });
  assert.match(r.text, /\n--- report s3 \(\/wt\/\.kora\/swarm\/s3\.md, [\d.]+ KB/);
  assert.match(r.text, /Read it or kora_wait full:true only if this is not enough\)$/);
  assert.ok(r.text.length < SWARM_REPORT_COMPACT_CAP + 1200, `${r.text.length}`);
});

test('kora_wait paneIds: all → every worker in one answer; any → the first finished plus where the rest stand', async () => {
  const ws = [worker('p5', { swarm: meta() }), worker('p6', { state: 'working', swarm: meta({ taskId: 's4', reportPath: '/wt/.kora/swarm/s4.md' }) })];
  const reports: Record<string, string> = { p5: '## Status\ndone A', p6: '## Status\ndone B' };
  const sw = spawner({ readReport: async (id) => ({ text: reports[id], truncated: false, updatedAt: Date.now() }) });
  const all = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: fleet({ workers: ws }) }), 'kora_wait').handler({ paneIds: ['p5', 'p6', 'p5'] });
  assert.equal(all.isError, undefined);
  assert.match(all.text, /^p5: idle\n[\s\S]*done A\n\np6: idle\n[\s\S]*done B$/);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = fleet({ workers: ws, wait: async (id) => { if (id === 'p6') await gate; return { state: 'idle', blocker: null, timedOut: false, exited: false }; } });
  const any = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: f }), 'kora_wait').handler({ paneIds: ['p6', 'p5'], mode: 'any' });
  release();
  assert.match(any.text, /^p5: idle\n[\s\S]*done A\n\nstill waiting on \(kora_wait them next\):\np6: working$/);
  const bad = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: fleet({ workers: ws }) }), 'kora_wait').handler({ paneIds: ['p5', 'p99'] });
  assert.match(bad.text, /\n\np99: no worker p99 in this fleet/);
  assert.equal((await tool(ctx(), 'kora_wait').handler({})).isError, true);
});

test('kora_spawn tasks:[…] spawns a batch in one call; wait:"all" returns the reports in the same call', async () => {
  let n = 4;
  const sw = spawner({
    spawn: async (p: any) => { sw.calls.push(p); n++; return { paneId: `p${n}`, taskId: `s${n}`, provider: 'zen', model: 'm', modelLabel: 'm', reportPath: `/wt/.kora/swarm/s${n}.md`, overlaps: [] }; },
    readReport: async (id) => ({ text: `## Status\ndone ${id}`, truncated: false, updatedAt: Date.now() }),
  });
  const f = fleet({ list: async () => [worker('p5', { swarm: meta() }), worker('p6', { swarm: meta({ taskId: 's6' }) })] });
  const c = ctx({ agentMode: 'swarm', swarm: sw, fleet: f });
  const spawn = tool(c, 'kora_spawn');
  assert.equal(spawn.params.prompt.optional, true);
  assert.deepEqual((toJsonSchema(spawn.params) as any).properties.tasks, { type: 'array', items: { type: 'object', properties: { prompt: { type: 'string' }, title: { type: 'string' }, check: { type: 'string' }, include_request: { type: 'boolean' }, focus: { type: 'array', items: { type: 'string' } }, race: { type: 'string' }, continues: { type: 'string' }, permission: { type: 'string', enum: ['supervised', 'auto-edits', 'full'] } }, required: ['prompt'], additionalProperties: false }, description: 'swarm: several tasks spawned in this one call (instead of prompt); each may carry its own done-check and permission' });
  const r = await spawn.handler({ tasks: [{ prompt: 'do A', title: 'A', check: 'node --test a' }, { prompt: 'do B', title: 'B' }], wait: 'all' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(sw.calls.map((x) => [x.task, x.title]), [['do A', 'A'], ['do B', 'B']]);
  assert.deepEqual(sw.calls.map((x) => x.check ?? null), ['node --test a', null], 'each batch task carries its own done-check');
  assert.match(r.text, /^spawned swarm worker p5 [^\n]*"A"[^\n]*\nspawned swarm worker p6 [^\n]*"B"[^\n]*\n\np5: idle\n[\s\S]*done p5\n\np6: idle\n[\s\S]*done p6$/);
});

test('kora_spawn batch: a refusal mid-batch stops it and names what did not start', async () => {
  let k = 0;
  const sw = spawner({ spawn: async () => { if (++k === 2) throw new Error('swarm: 1 workers already running (maxWorkers 1)'); return { paneId: 'p5', taskId: 's3', provider: 'zen', model: 'm', modelLabel: 'm', reportPath: '/r.md', overlaps: [] }; } });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw }), 'kora_spawn').handler({ tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /^spawned swarm worker p5 [^\n]*\ntask 2–3 NOT spawned: swarm: 1 workers already running \(maxWorkers 1\)$/);
});

test('kora_merge paneIds: verify first; a collision merges nothing; clean → all merged in the suggested order', async () => {
  const merged: string[] = [];
  const ws = [worker('p5'), worker('p6'), worker('p7', { worktree: null })];
  const clean = fleet({ workers: ws, mergeVerify: async () => ({ pairs: [{ a: 'p5', b: 'p6', status: 'clean' }] as any, order: ['p6', 'p5'] }), merge: async (id) => { merged.push(id); return { ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }; } });
  const r = await tool(ctx({ fleet: clean }), 'kora_merge').handler({ paneIds: ['p5', 'p6', 'p7'] });
  assert.equal(r.isError, undefined);
  assert.deepEqual(merged, ['p6', 'p5']);
  assert.match(r.text, /^p7: works in the shared checkout — nothing to merge\nverify: 1 pair\(s\) clean\np6: merged: ok \(1 commit\(s\)\)\np5: merged: ok \(1 commit\(s\)\)$/);
  merged.length = 0;
  const clash = fleet({ workers: ws, mergeVerify: async () => ({ pairs: [{ a: 'p5', b: 'p6', status: 'semantic', reason: 'p6 removed foo', blame: [{ file: 'src/a.ts', line: 3, symbol: 'foo', removed: true, byWorker: 'p6' }] }] as any, order: ['p5', 'p6'] }), merge: async (id) => { merged.push(id); return { ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }; } });
  const bad = await tool(ctx({ fleet: clash }), 'kora_merge').handler({ paneIds: ['p5', 'p6'] });
  assert.equal(bad.isError, true);
  assert.deepEqual(merged, []);
  assert.match(bad.text, /^NOT merged — kora_merge_verify found 1 colliding pair[\s\S]*p5 × p6: semantic — p6 removed foo\n {4}src\/a\.ts:3 {2}foo {2}\(removed by p6\)$/);
  assert.match((await tool(ctx({ fleet: clean }), 'kora_merge').handler({ paneId: 'p5' })).text, /^merged: ok/, 'single paneId unchanged');
});

test('security: kora_merge refuses an `into` that is not a plain branch name, before any merge', async () => {
  const merged: string[] = [];
  const ws = [worker('p5'), worker('p6')];
  const f = fleet({ workers: ws, mergeVerify: async () => ({ pairs: [], order: ['p5', 'p6'] }), merge: async (id) => { merged.push(id); return { ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }; } });
  for (const into of ['-f', '--orphan=x', 'main --', 'a..b', 'HEAD~1', 'src/file.ts:1']) {
    const one = await tool(ctx({ fleet: f }), 'kora_merge').handler({ paneId: 'p5', into });
    assert.equal(one.isError, true, into); assert.match(one.text, /plain branch name/);
    const many = await tool(ctx({ fleet: f }), 'kora_merge').handler({ paneIds: ['p5', 'p6'], into });
    assert.equal(many.isError, true, into);
  }
  assert.deepEqual(merged, []);
  assert.match((await tool(ctx({ fleet: f }), 'kora_merge').handler({ paneId: 'p5', into: 'feature/x' })).text, /^merged: ok/);
});

test('compactScreen: TUI art and blank rows go, text lines stay (last 12)', () => {
  const screen = ['▄', '   █▀▀█ █▀▀█ █▀▀█', '   ▀▀▀▀ █▀▀▀ ▀▀▀▀', '', '   ┃  Ask anything… "Fix a TODO"', '   ┃  Build auto · Muse Spark 1.3', '   ╹▀▀▀▀▀▀▀▀', '    ', '  /wt/opencode-x:kora/opencode-x    ⊙ 1 MCP /status   1.18.32'].join('\n');
  assert.equal(compactScreen(screen), 'Ask anything… "Fix a TODO"\nBuild auto · Muse Spark 1.3\n/wt/opencode-x:kora/opencode-x ⊙ 1 MCP /status 1.18.32');
  assert.equal(compactScreen(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')).split('\n')[0], 'line 18');
});

test('kora_wait does not return on a swarm worker\'s start-up idle: it waits until the worker has confirmed working', async () => {
  const f = fleet({ list: async () => [worker('p5', { swarm: meta({ phase: f.waits.length < 3 ? 'starting' : 'done' }) })] });
  const sw = spawner({ readReport: async () => (f.waits.length >= 3 ? { text: '## Status\ndone', truncated: false, updatedAt: Date.now() } : null) });
  const r = await tool(ctx({ agentMode: 'swarm', swarm: sw, fleet: f }), 'kora_wait').handler({ paneId: 'p5' });
  assert.ok(f.waits.length >= 3, `re-waited after the start-up idle (${f.waits.length})`);
  assert.match(r.text, /## Status\ndone$/);
  assert.doesNotMatch(r.text, /no report file/);
});

test('withUserRequest pastes the user message (minus kora notices) above the lead instructions; stripAnsi', () => {
  const { withUserRequest, stripAnsi } = require('./fleet-tools') as typeof import('./fleet-tools');
  const t = withUserRequest('Only the resolver part. Check: npx vitest run', '[kora] User has switched to Swarm mode.\n\nPlease add X.\n- must keep Y');
  assert.match(t, /^## The user's request \(verbatim/);
  assert.ok(t.includes('Please add X.\n- must keep Y'));
  assert.ok(!t.includes('[kora]'));
  assert.match(t, /## Lead's instructions\nOnly the resolver part/);
  assert.equal(withUserRequest('do it', null), 'do it');
  assert.match(withUserRequest('bug 3 only', 'six bugs', { split: true }), /context only — other workers own the other parts[\s\S]*## YOUR part — do only this\nbug 3 only/);
  assert.equal(stripAnsi('\u001b[31mred\u001b[39m \u001b[2mdim\u001b[22m'), 'red dim');
  assert.ok(!compactReport('## Status\n\u001b[32mdone\u001b[39m', '/r.md').includes('\u001b'));
});

test('kora_spawn (swarm) pastes the user request by default; include_request:false opts out', async () => {
  const spawned: string[] = [];
  const swarm = { spawn: async (p: any) => { spawned.push(p.task); return { paneId: `p${spawned.length}`, taskId: 's1', reportPath: '/r.md', modelLabel: 'm', provider: 'openrouter', overlaps: [], foreman: null }; } } as any;
  const ctx = { fleet: undefined, orchestratorId: 'chat:t', agent: 'claude', cwd: '/r', account: null, agentMode: 'swarm', swarm, spawnWorker: async () => ({ id: 'x', agent: 'claude', account: null }), lastUserRequest: () => 'Build the thing.\n- req A' } as any;
  const spawn = fleetToolSpecs(ctx).find((t) => t.name === 'kora_spawn')!;
  await spawn.handler({ prompt: 'Only part 1. Check: npm test', title: 't' });
  await spawn.handler({ prompt: 'Just this.', title: 't', include_request: false });
  assert.match(spawned[0], /^## The user's request[^\n]*\nBuild the thing\.\n- req A\n\n## Lead's instructions\nOnly part 1/);
  assert.equal(spawned[1], 'Just this.');
});

test('a BLOB thread\'s helpers: the user\'s message is not pasted above the brief, memory lines are scrubbed out of it, and at most 2 run at once', async () => {
  const spawned: Array<{ task: string; maxConcurrent?: number }> = [];
  const swarm = { spawn: async (p: any) => { spawned.push({ task: p.task, ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}) }); return { paneId: `p${spawned.length}`, taskId: 's1', reportPath: '/r.md', modelLabel: 'm', provider: 'zen', overlaps: [], foreman: null }; } } as any;
  const base = { fleet: undefined, orchestratorId: 'chat:t', agent: 'claude', cwd: '/r', account: null, agentMode: 'swarm', swarm, spawnWorker: async () => ({ id: 'x', agent: 'claude', account: null }), lastUserRequest: () => 'Plan my wife Anna\'s birthday trip, she loves Lisbon.' } as any;
  const ctx = { ...base, blobThread: { maxWorkers: 2, scrubBrief: (t: string) => t.split('\n').filter((l) => !/Anna/.test(l)).join('\n') } };
  const spawn = fleetToolSpecs(ctx).find((t) => t.name === 'kora_spawn')!;
  await spawn.handler({ prompt: 'Find three flight options Dallas to Lisbon in May.\nThe user\'s wife Anna loves Lisbon.\nReturn a table.', title: 't' });
  assert.equal(spawned[0]!.task, 'Find three flight options Dallas to Lisbon in May.\nReturn a table.', 'no request pasted, personal line removed');
  assert.equal(spawned[0]!.maxConcurrent, 2);
  await spawn.handler({ prompt: 'Only this.', title: 't', include_request: true });
  assert.match(spawned[1]!.task, /^## The user's request/, 'pasted only when the blob asks for it');
  assert.doesNotMatch(spawned[1]!.task, /Anna/, 'and even then the personal line is scrubbed');
  // a Code thread is unchanged: the request is pasted by default and there is no cap
  const code = fleetToolSpecs(base).find((t) => t.name === 'kora_spawn')!;
  await code.handler({ prompt: 'Part 1.', title: 't' });
  assert.match(spawned[2]!.task, /^## The user's request/);
  assert.equal(spawned[2]!.maxConcurrent, undefined);
  const said = await spawn.handler({ prompt: 'Another piece.', title: 't' });
  assert.doesNotMatch(said.text, /swarm|worktree|foreman|orchestrator/i, `a blob chat's tool answers say helpers: ${said.text}`);
});

test('blobSpeak: swarm / worktree / foreman wording becomes helpers / working folder / Kora', async () => {
  const { blobSpeak } = await import('./fleet-tools');
  assert.equal(blobSpeak('spawned swarm worker p1 in its own worktree. foreman: up to 3 attempts'), 'spawned helper p1 in its own working folder. Kora: up to 3 attempts');
  assert.equal(blobSpeak('queued swarm task s3 (swarm mode)'), 'queued helper task s3 (helper mode)');
});

test('kora_wait mode:"event" wakes on a decision milestone (rejected) with a digest per worker; kora_locate batches graph queries', async () => {
  let calls = 0;
  const prog = (n: number) => [
    { paneId: 'p1', taskId: 's1', title: 'A', phase: 'running', race: 'b', runningMs: 60_000, milestones: n > 1 ? [{ at: 1, kind: 'reproduced', note: 'red test' }, { at: 2, kind: 'rejected', note: 'x.js:3 is not it' }] : [], changedFiles: [], quiet: false, note: null },
    { paneId: 'p2', taskId: 's2', title: 'B', phase: 'running', race: 'b', runningMs: 60_000, milestones: [], changedFiles: [], quiet: false, note: null },
  ];
  const swarm = { spawn: async () => ({}), taskForPane: () => null, readReport: async () => null, progress: async () => prog(++calls) } as any;
  const ctx = { fleet: { list: async () => [], follow: async (p: string) => p } as any, orchestratorId: 'chat:t', agent: 'claude', cwd: '/r', account: null, agentMode: 'swarm', swarm, spawnWorker: async () => ({ id: 'x', agent: 'claude', account: null }), locate: async (q: string[]) => q.map((x) => `## ${x}\n■ f @ a.js:1`).join('\n') } as any;
  const specs = fleetToolSpecs(ctx);
  const wait = specs.find((t) => t.name === 'kora_wait')!;
  const r = await wait.handler({ paneIds: ['p1', 'p2'], mode: 'event', timeoutMs: 20_000 });
  const txt = (r as any).content?.[0]?.text ?? String((r as any).text ?? JSON.stringify(r));
  assert.match(txt, /^event \(p1\):/);
  assert.match(txt, /p1 running 1m "A" race=b \| rejected: x\.js:3 is not it \(\+1 earlier\)/);
  assert.match(txt, /p2 running 1m "B" race=b \| no milestone yet/);
  const loc = specs.find((t) => t.name === 'kora_locate')!;
  const l = await loc.handler({ queries: ['limiter', 'chunk start line'] });
  assert.match(JSON.stringify(l), /## limiter.*## chunk start line/);
});

test('kora_plan with slices appends the graph check; without slices (or without planCheck) it only publishes', async () => {
  let plan = '';
  const f = fleet({ setPlan: async (_id: string, p: string) => { plan = p; } } as any);
  const seen: any[] = [];
  const c = ctx({ fleet: f, planCheck: async (s: any) => { seen.push(s); return 'slices 1 and 2 both edit a.js: merge them or run them in order'; } } as any);
  const slices = [{ title: 'a', files: ['a.js'] }, { title: 'b', files: ['a.js'] }];
  const r = await tool(c, 'kora_plan').handler({ plan: '1. a 2. b', slices });
  assert.equal(plan, '1. a 2. b');
  assert.equal(r.text, 'plan published\nslices 1 and 2 both edit a.js: merge them or run them in order');
  assert.deepEqual(seen[0], slices);
  assert.equal((await tool(c, 'kora_plan').handler({ plan: 'x' })).text, 'plan published');
  assert.equal((await tool(ctx({ fleet: f }), 'kora_plan').handler({ plan: 'x', slices })).text, 'plan published');
});

test('kora_map: one template spawns one worker per item, substituting {{item}}', async () => {
  const sw = spawner();
  const c = ctx({ agentMode: 'swarm', swarm: sw });
  const map = tool(c, 'kora_map');
  const r = await map.handler({ template: 'summarize {{item}}', items: ['https://a.example', 'https://b.example'] });
  assert.equal(sw.calls.length, 2);
  assert.equal(sw.calls[0].task, 'summarize https://a.example');
  assert.equal(sw.calls[1].task, 'summarize https://b.example');
  assert.match(r.text, /kora_wait paneIds:\["p5", "p5"\]/); // the fake spawner always answers p5 — still proves the hint shape
});

test('kora_map requires {{item}} in the template and a non-empty items list', async () => {
  const c = ctx({ agentMode: 'swarm', swarm: spawner() });
  const map = tool(c, 'kora_map');
  const noPlaceholder = await map.handler({ template: 'summarize it', items: ['a'] });
  assert.equal(noPlaceholder.isError, true);
  assert.match(noPlaceholder.text, /\{\{item\}\}/);
  const noItems = await map.handler({ template: 'do {{item}}', items: [] });
  assert.equal(noItems.isError, true);
});

test('kora_map caps at 24 items and says so', async () => {
  const sw = spawner();
  const c = ctx({ agentMode: 'swarm', swarm: sw });
  const map = tool(c, 'kora_map');
  const items = Array.from({ length: 30 }, (_, i) => `item${i}`);
  const r = await map.handler({ template: 'do {{item}}', items });
  assert.equal(sw.calls.length, 24);
  assert.match(r.text, /6 item\(s\) over the 24 cap were not spawned/);
});

test('kora_map stops (without spamming every item) on a pool-full refusal', async () => {
  let n = 0;
  const sw = spawner({ spawn: async () => { if (++n === 2) throw new Error('swarm: 1 workers already running (maxWorkers 1)'); return { paneId: 'p5', taskId: 's3', provider: 'zen', model: 'm', modelLabel: 'm', reportPath: '/r.md', overlaps: [] }; } });
  const c = ctx({ agentMode: 'swarm', swarm: sw });
  const map = tool(c, 'kora_map');
  const r = await map.handler({ template: 'do {{item}}', items: ['a', 'b', 'c'] });
  assert.equal(n, 2, 'stopped at the first refusal instead of retrying every remaining item');
  assert.match(r.text, /NOT spawned: swarm: 1 workers already running/);
});

test('kora_map is only offered on a swarm thread (like kora_locate) — not on a plain orchestrator', () => {
  const specs = fleetToolSpecs(ctx({ agentMode: 'orchestrator' }));
  assert.ok(!specs.some((t) => t.name === 'kora_map'));
});

// ── CLI workers (chat threads): kora_wait carries the answer, and waits through auto-answered start-up dialogs ──
test('kora_wait (CLI worker): waits through the trust dialog Kora auto-answers, then returns the worker\'s last message', async () => {
  const states = [
    { state: 'blocked', blocker: 'Do you trust the contents of this directory? Working with untrusted contents …', timedOut: false, exited: false },
    { state: 'idle', blocker: null, timedOut: false, exited: false },
  ];
  const f = fleet({
    workers: [worker('p1', { agent: 'codex', worktree: null })],
    wait: async () => states.shift() ?? { state: 'idle', blocker: null, timedOut: false, exited: false },
    report: async () => 'pong',
  });
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_wait').handler({ paneId: 'p1' });
  assert.match(r.text, /^p1: idle/);
  assert.match(r.text, /--- worker's last message ---\npong$/);
  assert.equal(states.length, 0, 'waited again after the auto-answered dialog');
});

test('kora_wait (CLI worker): a real permission prompt still returns at once (a decision for the lead)', async () => {
  const f = fleet({
    workers: [worker('p1', { agent: 'claude', worktree: null, state: 'blocked', blocker: 'Allow Bash(rm -rf build)?' })],
    wait: async () => ({ state: 'blocked', blocker: 'Allow Bash(rm -rf build)?', timedOut: false, exited: false }),
  });
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_wait').handler({ paneId: 'p1' });
  assert.match(r.text, /^p1: blocked \(Allow Bash/);
  assert.doesNotMatch(r.text, /last message|end of its screen/);
});

test('kora_wait (CLI worker): no transcript → the end of its screen, so an error like a usage limit reaches the lead', async () => {
  const f = fleet({
    workers: [worker('p1', { agent: 'codex', worktree: null })],
    report: async () => '',
    read: async () => '› Reply with one word\n■ You’ve hit your usage limit. Try again later.\n› Ask Codex to do anything',
  });
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_wait').handler({ paneId: 'p1' });
  assert.match(r.text, /no answer in its transcript; end of its screen ---\n[\s\S]*usage limit/);
});

// ── a worker that dies on an error must not cost the lead a long wait ─────────────────────────────
test('kora_wait all: a worker that STOPPED on a usage limit wakes the lead at once; the others are listed as still going', async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => { release = r; });
  const f = fleet({
    workers: [worker('p1', { agent: 'codex', worktree: null }), worker('p2', { agent: 'claude', worktree: null, state: 'working' })],
    wait: async (id: string) => {
      if (id === 'p2') { await hold; return { state: 'idle', blocker: null, timedOut: true, exited: false }; }
      return { state: 'idle', blocker: null, timedOut: false, exited: false };
    },
    report: async () => '',
    read: async () => '› Research task\n■ You’ve hit your usage limit. Upgrade to Plus or try again at Oct 16th.\n› Ask Codex to do anything',
  });
  const started = Date.now();
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_wait').handler({ paneIds: ['p1', 'p2'] });
  release();
  assert.ok(Date.now() - started < 2000, 'returned without waiting for p2');
  assert.match(r.text, /^Returned early — p1 stopped on an error/);
  assert.match(r.text, /⚠ STOPPED on an error — it will not continue on its own: ■ You’ve hit your usage limit/);
  assert.match(r.text, /p2: working — still going/);
});

test('kora_workers: a "now:" line per CLI worker, and a STOPPED line for one that died on an error', async () => {
  const f = fleet({
    workers: [worker('p1', { agent: 'codex', worktree: null }), worker('p2', { agent: 'claude', worktree: null, state: 'working' })],
    read: async (id: string) => (id === 'p1' ? '■ You’ve hit your usage limit.\n› Ask Codex to do anything' : '⏺ Searching the web for A-MEM\n❯ \n? for shortcuts'),
  });
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_workers').handler({});
  assert.match(r.text, /p1 .*\n    ⚠ STOPPED on an error — not continuing: ■ You’ve hit your usage limit/);
  assert.match(r.text, /p2 .*\n    now: ⏺ Searching the web for A-MEM/);
});

// ── workers asleep after work: readable, listed, woken by a prompt ─────────────────────────────────
function sleepyFleet() {
  const woke: string[] = [];
  let awake = false;
  const f = fleet({
    workers: [],
    list: async () => (awake ? [worker('p9', { agent: 'claude', worktree: null })] : []),
    prompt: async () => ({ state: 'working' }),
  } as any) as any;
  f.asleep = async () => [{ recordId: 'w_1', lastPaneId: 'p3', agent: 'claude', title: 'refactor', sleptAt: Date.now() - 120_000, finalReport: 'done: refactored a.ts', ahead: 2, files: ['a.ts'], branch: 'kora/claude-x', canResume: true }];
  f.history = async (_o: string, id: string) => (id === 'w_1' || id === 'p3' ? 'w_1 (asleep, was p3) claude "refactor"\nfinal answer:\ndone: refactored a.ts' : null);
  f.wake = async (_o: string, id: string) => { woke.push(id); awake = true; return { paneId: 'p9' }; };
  return { f, woke };
}

test('kora_workers lists asleep workers; kora_read returns an asleep worker\'s history', async () => {
  const { f } = sleepyFleet();
  const c = ctx({ fleet: f, agentMode: 'chat' });
  const list = await tool(c, 'kora_workers').handler({});
  assert.match(list.text, /w_1  asleep 2 min \(was p3\)  claude  "refactor"  2 commit\(s\) on kora\/claude-x/);
  assert.match(list.text, /answered: done: refactored a\.ts/);
  const read = await tool(c, 'kora_read').handler({ paneId: 'p3' });
  assert.match(read.text, /final answer:\ndone: refactored a\.ts/);
  assert.match(read.text, /kora_prompt p3 wakes it/);
});

test('kora_prompt to an asleep worker wakes it (same session) and then delivers', async () => {
  const { f, woke } = sleepyFleet();
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_prompt').handler({ paneId: 'w_1', text: 'also add tests' });
  assert.deepEqual(woke, ['w_1']);
  assert.match(r.text, /^woke w_1 as p9 \(its session resumed\); delivered to p9/);
});

test('kora_wait returns early when the user sends a message, listing where the workers stand', async () => {
  const w = worker('p1', { agent: 'claude', state: 'working', swarm: null });
  // A wait that would block for the whole timeout: the worker never finishes.
  const blocking = fleet({ workers: [w], wait: async () => new Promise(() => {}) as any });
  let userAt = 0;
  const c = ctx({ fleet: blocking, userMessageSince: (since) => userAt > since });
  const started = Date.now();
  const pending = tool(c, 'kora_wait').handler({ paneId: 'p1', timeoutMs: 600_000 });
  setTimeout(() => { userAt = Date.now(); }, 50);
  const r = await pending;
  assert.ok(Date.now() - started < 3000, `returned after ${Date.now() - started} ms`);
  assert.match(r.text, /^\[kora\] the user sent you a message/);
  assert.match(r.text, /p1: working/);
});

test('kora_wait ignores a user message sent before the wait began', async () => {
  const w = worker('p1', { agent: 'claude' });
  const c = ctx({ fleet: fleet({ workers: [w] }), userMessageSince: (since) => since < 0 });
  const r = await tool(c, 'kora_wait').handler({ paneId: 'p1' });
  assert.match(r.text, /^p1: idle/);
});

test('kora_kill on an asleep worker says it is asleep instead of "no worker"', async () => {
  const { f } = sleepyFleet();
  f.kill = async () => { throw new Error('no worker p3 in this fleet'); };
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_kill').handler({ paneId: 'p3' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^p3 is asleep — no process to stop/);
});

test('kora_kill follows a woken worker from its old id to its live pane', async () => {
  const killed: string[] = [];
  const f = fleet({ workers: [worker('p9', { agent: 'claude' })], kill: async (id: string) => { killed.push(id); } } as any) as any;
  f.follow = async (id: string) => (id === 'p3' ? 'p9' : id);
  const r = await tool(ctx({ fleet: f, agentMode: 'chat' }), 'kora_kill').handler({ paneId: 'p3' });
  assert.deepEqual(killed, ['p9']);
  assert.equal(r.text, 'killed p9 (was p3)');
});

test('kora_open_preview never claims it opened a page: no desktop window says so, otherwise it says it asked (pl4 S2-3)', async () => {
  const { openPreviewAck } = await import('./fleet-tools');
  const { setDesktopClientProbe } = await import('../server/desktop-clients');
  const none = openPreviewAck('https://example.com', 0);
  assert.match(none, /^NOT opened/);
  assert.match(none, /https:\/\/example\.com/);
  for (const n of [1, null]) {
    const ack = openPreviewAck('http://localhost:5173', n);
    assert.doesNotMatch(ack, /^Opened/);
    assert.match(ack, /can't confirm/);
  }
  // Through the tool itself, with the daemon's probe saying no desktop window is connected.
  setDesktopClientProbe(() => 0);
  try {
    const ctx = { orchestratorId: 'o1', fleet: {} } as unknown as FleetToolContext;
    const tool = fleetToolSpecs(ctx).find((t) => t.name === 'kora_open_preview')!;
    const r = await tool.handler({ url: 'https://example.com' });
    assert.match(r.text, /^NOT opened/);
  } finally { setDesktopClientProbe(null); }
});

test('kora_spawn: a lead whose folder is no git checkout is told its workers share every file and have nothing to merge', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-plain-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
  try {
    assert.equal(insideGitCheckout(plain), false);
    assert.equal(insideGitCheckout(repo), true);
    assert.equal(insideGitCheckout(path.join(repo, 'pkg', 'src')), true, 'a subfolder of a checkout counts');
    const first = sharedFolderNote(plain, 'p1', 0);
    assert.match(first, /not a git repository/);
    assert.match(first, /nothing to merge/);
    assert.doesNotMatch(first, /other worker/);
    assert.match(sharedFolderNote(plain, 'p2', 1), /and 1 other worker\(s\) here/);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// test/fleet 2026-10-14: the note was guessed from the folder, so a worker left in the lead's files inside a checkout (a
// repository with no commits, a symlink out of the checkout, worktrees off) got no warning at all.
test('kora_spawn: the shared-files note follows whether the worker actually got a worktree', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  try {
    const run = async (cwd: string, worktree: boolean | undefined) => {
      const specs = fleetToolSpecs(ctx({ cwd, spawnWorker: async (p: any) => ({ id: 'p9', agent: p.agent, account: null, ...(worktree === undefined ? {} : { worktree }) }) }));
      await specs.find((t) => t.name === 'kora_ask_workers')!.handler({ tasks: [{ title: 'a', agent: 'claude' }, { title: 'b', agent: 'claude' }] });
      const spawn = specs.find((t) => t.name === 'kora_spawn')!;
      return [(await spawn.handler({ agent: 'claude', prompt: 'x' })).text, (await spawn.handler({ agent: 'claude', prompt: 'y' })).text];
    };
    const [a, b] = await run(repo, false);
    assert.match(a, /p9 got no worktree of its own/);
    assert.match(b, /and 1 other worker\(s\) here/);
    assert.doesNotMatch((await run(repo, true))[0], /NOTE/);
    assert.doesNotMatch((await run('/r', true))[0], /NOTE/, 'a worktree outside a checkout the lead sees (a symlink into one) is not shared');
    assert.match((await run('/r', undefined))[0], /is not a git repository/, 'an older daemon that does not say still gets the folder guess');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('kora_wait: a CLI worker that exits (or is removed) mid-wait is answered at once as exited, not as a timeout', async () => {
  for (const listed of [true, false]) {
    let waited = false;
    const f = fleet({
      list: async () => (listed || !waited ? [worker('p6', { agent: 'codex', state: 'idle', exited: listed, exitCode: listed ? 1 : null })] : []),
      wait: async () => { waited = true; return ({ state: 'idle', blocker: null, timedOut: false, exited: true }); },
    });
    const t0 = Date.now();
    const r = await tool(ctx({ fleet: f }), 'kora_wait').handler({ paneId: 'p6', timeoutMs: 600_000 });
    assert.ok(Date.now() - t0 < 5_000, 'returns promptly');
    assert.match(r.text, /p6: exited/);
    assert.doesNotMatch(r.text, /timed out/);
  }
});

// SwarmService (S2): pick order / concurrency / cooling, spawn gates (consent + swarm thread), always-a-worktree,
// X1 context packet (incl. its timeout), X3 overlap, failover (same worktree, alias, give-up note), the task registry
// across a new instance, the report nudge, and X2 verify-and-bounce. The runtime is a small fake (panes are
// EventEmitters); the worktree is real git in a temp repo. The real-Runtime spawn path is in swarm-spawn.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { MergePair, SwarmModelInfo, SwarmStatus, SwarmWorkerMeta } from '../protocol/types';
import { SwarmService, SWARM_THREAD_REQUIRED, swarmExhaustedNote, cooldownUntil } from './swarm';
import { SwarmHealth } from './swarm-health';
import { SwarmNotReadyError } from './swarm-errors';
import { statsFromOutcomes, type RoutingOutcomeRow } from './swarm-routing';

process.env.KORA_WORKTREES = path.join(process.env.KORA_HOME || os.tmpdir(), 'wt');

const M = (id: string, provider: SwarmModelInfo['provider'], rank: number, maxConcurrent: number | null = null): SwarmModelInfo => ({ id, provider, label: id.split('/').pop()!, rank, maxConcurrent });
const MODELS = [M('opencode/big-pickle', 'zen', 0, 1), M('opencode/grok-code', 'zen', 1, 2), M('openrouter/qwen/qwen3-coder:free', 'openrouter', 10), M('openrouter/z-ai/glm-4.5-air:free', 'openrouter', 11), M('openrouter/x/third:free', 'openrouter', 12), M('cerebras/gpt-oss-120b', 'cerebras', 20, 1)];

function readyStatus(ready = true): SwarmStatus {
  return JSON.parse(JSON.stringify({
    ready, blockers: ready ? [] : [{ code: 'consent-missing', message: 'privacy consent has not been given' }],
    opencode: { installed: true, path: '/x', source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: true },
    install: { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null },
    consent: { requiredVersion: 1, acceptedVersion: ready ? 1 : null, acceptedAt: ready ? 1 : null },
    providers: [], models: { available: MODELS, cooling: [] }, preferences: { providerOrder: ['zen', 'openrouter', 'cerebras'], defaultModel: null, maxWorkers: 4 },
    keyStorage: 'file', checkedAt: 1,
  }));
}

class FakePane extends EventEmitter {
  swarm: SwarmWorkerMeta | null = null; promptPending = false; exited = false; state = 'idle'; blocker: string | null = null;
  screen = 'Ask anything'; role = 'worker';
  constructor(public id: string, public orchestratorId: string, public worktree: { path: string; branch: string; mainRoot: string } | null, public args: string[], public env: Record<string, string>) { super(); }
  info() { return { id: this.id, swarm: this.swarm } as any; }
  read() { return this.screen; }
  kill() { this.exit(); }
  exit() { if (this.exited) return; this.exited = true; setImmediate(() => this.emit('exit', 0)); }
  setState(s: string) { this.state = s; this.emit('state', s, null, 'x'); }
}

function fakeRuntime() {
  let n = 1;
  const rt: any = new EventEmitter();
  rt.panes = new Map<string, FakePane>();
  rt.spawns = [] as any[];
  rt.prompts = [] as { paneId: string; text: string }[];
  rt.notes = [] as { method: string; params: any }[];
  rt.notify = (method: string, params: any) => rt.notes.push({ method, params });
  rt.agentSpawn = async (p: any) => {
    rt.spawns.push(p);
    const id = `p${n++}`;
    const pane = new FakePane(id, p.orchestratorId, p.reuseWorktree ?? null, p.args, p.env);
    rt.panes.set(id, pane);
    return { id };
  };
  rt.killPane = (id: string) => { const p = rt.panes.get(id); rt.panes.delete(id); p?.kill(); };
  rt.prompt = async (paneId: string, text: string) => { rt.prompts.push({ paneId, text }); return { ok: true, state: 'working' }; };
  rt.graph = { callTool: async () => ({ text: '', data: null, ms: 0 }) };
  return rt;
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-repo-'));
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

// Each service gets its own KORA_HOME (tasks.json) unless keepHome — the registry test reuses the previous one.
const BASE_HOME = process.env.KORA_HOME!;
function service(over: { status?: SwarmStatus; models?: SwarmModelInfo[]; io?: Record<string, unknown>; health?: SwarmHealth; rt?: any; keepHome?: boolean } = {}) {
  if (!over.keepHome) process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
  const rt = over.rt ?? fakeRuntime();
  const health = over.health ?? new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-h-')), 'health.json'));
  const setup: any = { getStatus: async () => over.status ?? readyStatus(), pickableModels: () => (over.models ?? MODELS).filter((m) => health.isAvailable(m.id)) };
  const svc = new SwarmService({ runtime: rt, setup, health, io: {
    threadMode: (id: string) => (id === 'chat:swarm' ? 'swarm' : 'orchestrator'),
    apiKey: () => null, opencodePath: () => '/fake/opencode',
    paneEnv: (meta: SwarmWorkerMeta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_MODEL: meta.model }),
    preamble: ({ reportPath }: { reportPath: string }) => `REPORT TO ${reportPath}`,
    permissionArgs: (m: string | undefined) => (m === 'full-access' ? ['--auto'] : []),
    contextPacket: async () => ({ text: '', files: [] }),
    overlap: () => [], changedFiles: async () => [],
    verifyGate: async () => [],
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4 }),
    nudgeMs: 30, screenPollMs: 0,
    ...(over.io ?? {}),
  } as any });
  return { svc, rt, health };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A blob workspace (the assistant folder): <KORA_BLOBS_ROOT>/popo, created fresh for the test. */
function blobCwd(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-blobs-')));
  process.env.KORA_BLOBS_ROOT = base;
  const cwd = path.join(base, 'popo');
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test('pickModel: preference order, per-model maxConcurrent, OpenRouter shared cap, cooling and exclusions', () => {
  const { svc, rt, health } = service();
  assert.equal(svc.pickModel()!.id, 'opencode/big-pickle');
  const busy = (id: string, model: string, provider: string) => { const p = new FakePane(id, 'chat:swarm', null, [], {}); p.swarm = { model, provider, supersededBy: null } as any; rt.panes.set(id, p); };
  busy('x1', 'opencode/big-pickle', 'zen');
  assert.equal(svc.pickModel()!.id, 'opencode/grok-code', 'big-pickle is at maxConcurrent 1');
  busy('x2', 'opencode/grok-code', 'zen'); busy('x3', 'opencode/grok-code', 'zen');
  assert.equal(svc.pickModel()!.id, 'openrouter/qwen/qwen3-coder:free');
  busy('x4', 'openrouter/qwen/qwen3-coder:free', 'openrouter'); busy('x5', 'openrouter/z-ai/glm-4.5-air:free', 'openrouter');
  assert.equal(svc.pickModel()!.id, 'cerebras/gpt-oss-120b', 'OpenRouter is at its 2-worker shared cap');
  health.markCooling('cerebras/gpt-oss-120b', Date.now() + 60_000, '429');
  assert.equal(svc.pickModel(), null, 'everything busy or cooling');
  rt.panes.clear();
  health.markCooling('opencode/big-pickle', Date.now() + 60_000, '429');
  assert.equal(svc.pickModel()!.id, 'opencode/grok-code', 'a cooling model is skipped');
  assert.equal(svc.pickModel(['opencode/grok-code'])!.id, 'openrouter/qwen/qwen3-coder:free', 'tried models are excluded');
});

test('SwarmHealth persists cooldowns across instances and expires them', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-h-')), 'health.json');
  const a = new SwarmHealth(file);
  a.markCooling('opencode/big-pickle', Date.now() + 60_000, 'Free limit reached');
  a.markCooling('openrouter/gone:free', Date.now() - 1, 'old');
  const b = new SwarmHealth(file);
  assert.equal(b.isAvailable('opencode/big-pickle'), false);
  assert.equal(b.isAvailable('openrouter/gone:free'), true);
  assert.deepEqual(b.cooling().map((c) => [c.model, c.provider]), [['opencode/big-pickle', 'zen']]);
  assert.equal(cooldownUntil('opencode/x', 'rate-limited', 0), 15 * 60_000, 'Zen free limit: 15 min floor');
  assert.equal(cooldownUntil('openrouter/x', 'rate-limited', 0, 5000), 60_000, "opencode's retry time (seconds away) never undercuts the floor");
  assert.equal(cooldownUntil('openrouter/x', 'rate-limited', 0, 120_000), 120_000, 'a later reset time than the floor is kept');
});

test('spawn: consent/readiness and the persisted swarm-thread mode are enforced on every path', async () => {
  const { svc } = service({ status: readyStatus(false) });
  await assert.rejects(svc.spawn({ orchestratorId: 'chat:orch', cwd: repo(), task: 't' }), (e: any) => e.message.startsWith(SWARM_THREAD_REQUIRED));
  await assert.rejects(svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' }), (e: any) => e instanceof SwarmNotReadyError && /^swarm unavailable: privacy consent has not been given\./.test(e.message));
  assert.equal(svc.isSwarmThread('chat:swarm'), true);
  assert.equal(svc.isSwarmThread('chat:orch'), false);
});

test('isSwarmThread reads the thread\'s persisted meta.json (default io)', () => {
  const home = BASE_HOME; process.env.KORA_HOME = home;
  fs.mkdirSync(path.join(home, 'chat', 't_sw'), { recursive: true });
  fs.writeFileSync(path.join(home, 'chat', 't_sw', 'meta.json'), JSON.stringify({ id: 't_sw', agentMode: 'swarm' }));
  fs.mkdirSync(path.join(home, 'chat', 't_or'), { recursive: true });
  fs.writeFileSync(path.join(home, 'chat', 't_or', 'meta.json'), JSON.stringify({ id: 't_or', agentMode: 'orchestrator', isOrchestrator: true }));
  const svc = new SwarmService({ runtime: fakeRuntime(), setup: {} as any, health: new SwarmHealth() });
  assert.equal(svc.isSwarmThread('chat:t_sw'), true);
  assert.equal(svc.isSwarmThread('chat:t_or'), false);
  assert.equal(svc.isSwarmThread('chat:missing'), false);
  assert.equal(svc.isSwarmThread('p3'), false);
});

test('spawn: the FIRST worker gets its own worktree; report inside it; argv prompt; no worker-permission doubling; promptPending until working', async () => {
  const { svc, rt } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'add validation', title: 'validate', runtimeMode: 'full-access' });
  assert.equal(r.taskId, 's1');
  assert.equal(r.model, 'opencode/big-pickle');
  const sp = rt.spawns[0];
  assert.ok(sp.reuseWorktree, 'spawned inside a pre-created worktree');
  assert.ok(fs.existsSync(path.join(sp.reuseWorktree.path, '.git')));
  assert.notEqual(fs.realpathSync(sp.reuseWorktree.path), fs.realpathSync(cwd), 'never the user\'s checkout');
  assert.equal(r.reportPath, path.join(sp.reuseWorktree.path, '.kora', 'swarm', 's1.md'));
  assert.equal(sp.skipWorkerPermission, true);
  assert.equal(sp.isolatedEnv, true, 'a third-party model never inherits the user\'s shell credentials');
  assert.equal(sp.agent, 'opencode');
  assert.equal(sp.command, '/fake/opencode');
  assert.equal(sp.prompt, undefined, 'the prompt rides in argv (--prompt), not the re-type loop');
  assert.deepEqual(sp.args.slice(0, 3), ['-m', 'opencode/big-pickle', '--auto']);
  assert.equal(sp.args.filter((a: string) => a === '--auto').length, 1);
  const prompt = sp.args[sp.args.indexOf('--prompt') + 1];
  assert.match(prompt, /^REPORT TO .*s1\.md/);
  assert.match(prompt, /add validation\n\n## Tools Kora gives you[\s\S]*\.kora\/bin\/milestone[\s\S]*\n\nWhen you are done, write your report to .*s1\.md\.$/);
  const pane = rt.panes.get(r.paneId!);
  assert.equal(pane.promptPending, true, 'the start-up idle screen must not satisfy a wait');
  assert.equal(pane.swarm.phase, 'starting');
  pane.setState('working');
  assert.equal(pane.promptPending, false);
  assert.equal(pane.swarm.phase, 'running');
});

test('X1: the context packet is prepended; a packet that never answers costs ≤ ~1.6 s and the spawn proceeds', async () => {
  const { svc, rt } = service({ io: { contextPacket: async () => ({ text: '## Context (from Kora graph)\nfoo()', files: ['a.ts'] }) } });
  await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  const prompt = rt.spawns[0].args[rt.spawns[0].args.indexOf('--prompt') + 1];
  assert.ok(prompt.indexOf('## Context (from Kora graph)') < prompt.indexOf('the task'));
  const slow = service({ io: { contextPacket: () => new Promise(() => {}) } });
  const t0 = Date.now();
  const r = await slow.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  const ms = Date.now() - t0;
  // Lower bound: the 1.5 s cap was actually waited out. Upper bound is loose on purpose: the packet NEVER answers, so
  // any finite time proves the cap; a tight wall-clock bound flaked under the monorepo-wide parallel test run.
  assert.ok(ms >= 1400 && ms < 30_000, `spawn took ${ms} ms`);
  assert.ok(r.paneId!);
  assert.doesNotMatch(slow.rt.spawns[0].args.join(' '), /Context \(from Kora graph\)/);
});

test('X3: overlap with a running worker\'s touched files is reported (advisory, spawn still succeeds)', async () => {
  const calls: any[] = [];
  const { svc } = service({ io: {
    contextPacket: async () => ({ text: '', files: ['src/auth.ts'] }),
    changedFiles: async () => ['src/auth.ts', 'README.md'],
    overlap: (input: any) => { calls.push(input); return input.running.filter((r: any) => r.files.some((f: string) => input.files.includes(f))).map((r: any) => ({ paneId: r.paneId!, files: r.files.filter((f: string) => input.files.includes(f)) })); },
  } });
  const a = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'one' });
  assert.deepEqual(a.overlaps, [], 'nothing running yet');
  const b = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'two' });
  assert.deepEqual(b.overlaps, [{ paneId: a.paneId!, files: ['src/auth.ts'] }]);
  assert.deepEqual(calls.at(-1).running, [{ paneId: a.paneId!, files: ['src/auth.ts', 'README.md'] }]);
});

test('blob folder: spawn gets no worktree, no context packet, no overlap check, and reports under the project scratch/ dir', async () => {
  let contextPacketCalled = false, overlapCalled = false;
  const { svc, rt } = service({ io: {
    contextPacket: async () => { contextPacketCalled = true; return { text: 'graph stuff', files: [] }; },
    overlap: () => { overlapCalled = true; return []; },
  } });
  const cwd = blobCwd(); // a blob's workspace: not a repo
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'research something', title: 'research' });
  const sp = rt.spawns[0];
  assert.ok(!sp.reuseWorktree, 'no worktree for a non-repo assistant-lane cwd');
  assert.equal(r.reportPath, path.join(cwd, 'scratch', r.taskId, 'report.md'));
  assert.equal(contextPacketCalled, false, 'no graph context packet on the assistant lane');
  assert.equal(overlapCalled, false, 'no overlap warning on the assistant lane');
  const prompt = sp.args[sp.args.indexOf('--prompt') + 1];
  assert.doesNotMatch(prompt, /graph stuff/);
});

test('failover budget: a task whose workers stalled or crashed three times is handed back (original + 2 failovers); rate limits keep the full four', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  assert.ok(r.paneId);
  await svc.failover('s1', 'crashed');
  await svc.failover('s1', 'stalled');
  assert.equal(svc.taskForPane(r.paneId!)!.status !== 'exhausted', true, 'two failures: the third attempt is still running');
  assert.equal(svc.taskForPane(r.paneId!)!.paneIds.length, 3);
  await svc.failover('s1', 'crashed');
  const rec = svc.taskForPane(r.paneId!)!;
  assert.equal(rec.status, 'exhausted', 'three costly failures: no fourth worker');
  assert.equal(rec.paneIds.length, 3);
  assert.equal(rt.spawns.length, 3);
  const b = service();
  const r2 = await b.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  for (let i = 0; i < 3; i++) await b.svc.failover('s1', 'rate-limited');
  assert.equal(b.svc.taskForPane(r2.paneId!)!.paneIds.length, 4, 'provider-side failures cost nothing: all four attempts');
});

test('failover: 429 retry → cooled model, same worktree, alias, supersededBy before the kill; gives up after 4 attempts with the note', async () => {
  const { svc, rt, health } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  const p1 = rt.panes.get(r.paneId!);
  p1.setState('working');
  const phases: string[] = [];
  p1.on('exit', () => phases.push(p1.swarm.phase + ':' + String(p1.swarm.supersededBy)));
  svc.reportEvent({ paneId: r.paneId!, type: 'session.status', status: 'retry', attempt: 1, message: 'Rate limited (429)' });
  assert.equal(rt.spawns.length, 1, 'first retry only marks rate-limited');
  assert.equal(p1.swarm.phase, 'rate-limited');
  svc.reportEvent({ paneId: r.paneId!, type: 'session.status', status: 'retry', attempt: 2, message: 'Free limit reached', next: Date.now() + 90_000 });
  const p2id = await svc.followSettled(r.paneId!);
  assert.notEqual(p2id, r.paneId!);
  assert.equal(svc.follow(r.paneId!), p2id);
  assert.deepEqual(phases, ['respawning:null'], 'the old pane read "respawning" (not done/failed) when it exited');
  assert.equal(p1.swarm.supersededBy, p2id);
  assert.equal(health.isAvailable('opencode/big-pickle'), false);
  const sp2 = rt.spawns[1];
  assert.equal(sp2.reuseWorktree.path, rt.spawns[0].reuseWorktree.path, 'same worktree');
  assert.match(sp2.args[sp2.args.indexOf('--prompt') + 1], /a previous worker \(opencode\/big-pickle\) was cut off/);
  const p2 = rt.panes.get(p2id);
  assert.equal(p2.swarm.attempt, 2);
  assert.deepEqual(p2.swarm.previousPaneIds, [r.paneId!]);
  assert.deepEqual(p2.swarm.attempts.map((a: any) => [a.paneId!, a.outcome]), [[r.paneId!, 'rate-limited'], [p2id, 'running']]);
  assert.equal(p2.swarm.reportPath, r.reportPath);
  const ev = rt.notes.filter((n: any) => n.method === 'swarm.worker').map((n: any) => n.params.event);
  assert.deepEqual(ev[0], { kind: 'failover', paneId: r.paneId!, taskId: 's1', newPaneId: p2id, fromModel: 'opencode/big-pickle', toModel: 'opencode/grok-code' });
  assert.match(svc.note(r.paneId!)!, /^\[kora\] swarm worker p1 \(opencode\/big-pickle\) hit a rate limit; respawned as p2 on opencode\/grok-code, same task, same worktree\. kora_wait p1 follows it\.$/);
  // three more failures → attempt 4 fails → exhausted
  for (let i = 0; i < 3; i++) await svc.failover('s1', 'rate-limited');
  const cur = svc.follow(r.paneId!);
  const rec = svc.taskForPane(r.paneId!)!;
  assert.equal(rec.paneIds.length, 4);
  assert.equal(rec.status, 'exhausted');
  assert.equal(rt.panes.has(cur), false, 'the exhausted pane is stopped');
  const tried = ['opencode/big-pickle', 'opencode/grok-code', 'openrouter/qwen/qwen3-coder:free', 'openrouter/z-ai/glm-4.5-air:free'];
  const last = rt.notes.filter((n: any) => n.method === 'swarm.worker').at(-1).params.event;
  assert.deepEqual(last, { kind: 'exhausted', paneId: cur, taskId: 's1', tried });
  // Every attempt hit a rate limit: the providers are down/limited, not the task — the note says so (B5, night 2026-10-04).
  assert.match(svc.note(cur)!, /^\[kora\] swarm task s1 could not run: every free model is rate-limited or unavailable right now \(opencode\/big-pickle, opencode\/grok-code, openrouter\/qwen\/qwen3-coder:free, openrouter\/z-ai\/glm-4\.5-air:free; next reset .+\)\. This is the free providers, not the task\./);
  assert.match(svc.note(cur)!, /Settings → Swarm/);
  assert.equal(swarmExhaustedNote('s9', ['a'], null), '[kora] swarm task s9 failed on every free model (a; next reset unknown). Rewrite or split it, or hand it to the cheap paid tier (kora_ask_workers: claude Haiku or codex Luna, then kora_spawn it).');
  assert.equal(swarmExhaustedNote('s9', ['a', 'b'], null, ['rate-limited', 'stalled']), '[kora] swarm task s9 failed on every free model (a, b; next reset unknown). Rewrite or split it, or hand it to the cheap paid tier (kora_ask_workers: claude Haiku or codex Luna, then kora_spawn it).', 'a task that also stalled may be the task');
});

test('failover: a model that disappears is marked gone; no model left → exhausted immediately', async () => {
  const { svc, rt, health } = service({ models: [M('opencode/big-pickle', 'zen', 0)] });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  svc.reportEvent({ paneId: r.paneId!, type: 'session.error', message: 'Model not found: opencode/big-pickle' });
  await svc.followSettled(r.paneId!);
  assert.equal(health.isAvailable('opencode/big-pickle'), false);
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'exhausted');
  assert.equal(rt.spawns.length, 1);
});

test('task registry: a NEW SwarmService (daemon restart) still knows the task and says it was lost', async () => {
  const { svc } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  fs.writeFileSync(r.reportPath, '## Done\nall good');
  const fresh = service({ keepHome: true }); // same KORA_HOME, empty runtime
  const rec = fresh.svc.taskForPane(r.paneId!)!;
  assert.equal(rec.taskId, 's1');
  assert.equal(rec.orchestratorId, 'chat:swarm');
  assert.equal(rec.reportPath, r.reportPath);
  assert.equal(fresh.svc.lostInRestart(r.paneId!), true);
  assert.equal((await fresh.svc.readReport(r.paneId!))!.text, '## Done\nall good');
  const next = await fresh.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'u' });
  assert.equal(next.taskId, 's2', 'task ids never repeat across restarts');
});

test('after a restart, a NEW worker reusing a restored pane id belongs to its own task, not the restored one', async () => {
  const { svc } = service();
  const old = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'old task' });
  const fresh = service({ keepHome: true }); // pane ids restart with the daemon
  const now = await fresh.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'new task' });
  assert.equal(now.paneId!, old.paneId!, 'the fake runtime reuses the id, like a restarted daemon');
  const rec = fresh.svc.taskForPane(now.paneId!)!;
  assert.equal(rec.taskId, now.taskId);
  assert.equal(rec.orchestratorId, 'chat:swarm');
  assert.equal(fresh.svc.lostInRestart(now.paneId!), false, 'a live task owns the id now');
});

test('journey l: idle without a report → exactly one automatic nudge', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working'); p.setState('idle');
  await tick(80);
  p.setState('working'); p.setState('idle');
  await tick(80);
  assert.equal(rt.prompts.length, 1);
  assert.equal(rt.prompts[0].paneId!, r.paneId!);
  assert.match(rt.prompts[0].text, new RegExp(`^Write your report to ${r.reportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} now`));
});

test('X2 verify-and-bounce: a broken-callers verdict bounces the findings to the SAME worker once, then passes', async () => {
  const semantic: MergePair[] = [{ a: 'main', b: 'p1', status: 'semantic', reason: 'p1 changed login() which src/app.ts calls', blame: [{ file: 'src/app.ts', line: 12, symbol: 'login', byWorker: 'p1', kind: 'dependent' }] }];
  let calls = 0;
  const { svc, rt } = service({ io: { verifyGate: async () => (calls++ === 0 ? semantic : []) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  fs.writeFileSync(r.reportPath, '## Done\nchanged login()');
  p.setState('idle');
  assert.equal(p.swarm.verify.state, 'pending', 'pending synchronously, so a woken kora_wait keeps waiting');
  await tick(30);
  assert.deepEqual({ state: p.swarm.verify.state, bounces: p.swarm.verify.bounces }, { state: 'bounced', bounces: 1 });
  assert.equal(rt.prompts.length, 1);
  assert.equal(rt.prompts[0].paneId!, r.paneId!, 'findings go back to the same worker');
  assert.match(rt.prompts[0].text, /src\/app\.ts:12 login/);
  let events = rt.notes.filter((n: any) => n.method === 'swarm.worker').map((n: any) => n.params.event);
  assert.deepEqual(events.map((e: any) => e.kind), ['bounced'], 'Claude does not hear the failing report');
  p.setState('working'); p.setState('idle');
  await tick(30);
  assert.deepEqual(p.swarm.verify, { state: 'passed', bounces: 1, summary: 'merge gate clean after 1 bounce' });
  assert.equal(p.swarm.phase, 'done');
  events = rt.notes.filter((n: any) => n.method === 'swarm.worker').map((n: any) => n.params.event);
  assert.deepEqual(events.at(-1), { kind: 'report', paneId: r.paneId!, taskId: 's1', verify: { state: 'passed', bounces: 1, summary: 'merge gate clean after 1 bounce' } });
  assert.equal(p.swarm.report.preview, '## Done\nchanged login()');
});

test('X2: failures left after maxBounces are reported as failed; a gate crash is skipped, never bounced', async () => {
  const bad: MergePair[] = [{ a: 'p1', b: 'p9', status: 'semantic', blame: [{ file: 'x.ts', line: 12, symbol: 'f', byWorker: 'p1' }] }];
  const { svc, rt } = service({ io: { verifyGate: async () => bad, config: () => ({ autoVerify: true, maxBounces: 0, maxWorkers: 4 }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const v = await svc.verifyAndBounce(r.paneId!);
  assert.equal(v.state, 'failed');
  assert.equal(rt.prompts.length, 0);
  const crash = service({ io: { verifyGate: async () => { throw new Error('boom'); } } });
  const r2 = await crash.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  assert.equal((await crash.svc.verifyAndBounce(r2.paneId!)).state, 'skipped');
  assert.equal(crash.rt.prompts.length, 0);
});

test('cleanupThread kill stops the thread\'s swarm workers (worktrees kept)', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const wt = rt.spawns[0].reuseWorktree.path;
  await svc.cleanupThread('chat:swarm', { kill: true });
  assert.equal(rt.panes.has(r.paneId!), false);
  assert.ok(fs.existsSync(wt));
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'failed');
});

test('maxConcurrent caps ONE orchestrator below the global limit (a blob thread runs 2 helpers); the rest queue and start as slots free; a stop drops the queued ones too', async () => {
  const { svc, rt } = service();
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'one', maxConcurrent: 2, queue: true });
  const b = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'two', maxConcurrent: 2, queue: true });
  const c = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'three', maxConcurrent: 2, queue: true });
  assert.ok(a.paneId && b.paneId, 'the first two start');
  assert.equal(c.queued, true, 'the third waits although the global limit is 4');
  assert.equal(rt.spawns.length, 2);
  // without the cap the same thread would have started all three
  const d = await service().svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'free', queue: true });
  assert.ok(d.paneId);
  // and without queue:true the cap refuses, saying so
  await assert.rejects(svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'four', maxConcurrent: 2 }), /2 workers already running/);
  // the user stops the thread: the running workers die and the queued task is dropped with a note that says why
  await svc.cleanupThread('chat:swarm', { kill: true, reason: 'stopped' });
  assert.equal(svc.taskForPane(a.paneId!)!.status, 'failed');
  assert.equal(svc.taskForPane(b.paneId!)!.status, 'failed');
  assert.deepEqual(svc.queuedTasks('chat:swarm'), []);
});

test('a report path turned into a symlink is never followed (it would leak the file it points at)', async () => {
  const { svc } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-secret-')), 'id_rsa');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  fs.mkdirSync(path.dirname(r.reportPath), { recursive: true });
  fs.symlinkSync(secret, r.reportPath);
  assert.equal(await svc.readReport(r.paneId!), null);
  fs.rmSync(r.reportPath); fs.writeFileSync(r.reportPath, '## Done');
  assert.equal((await svc.readReport(r.paneId!))!.text, '## Done');
});

// ---- routing, watchdog, registry status ------------------------------------------------------------------------------


const outcome = (model: string, ok: boolean): RoutingOutcomeRow => ({
  ts: Date.now(), status: ok ? 'done' : 'failed', attempts: [{ model, outcome: ok ? 'ok' : 'running', at: Date.now() - 120_000 }],
  verify: ok ? { state: 'passed', bounces: 0 } : null, type: 'edit',
});

test('pickModel routes by measured outcomes inside the first tier; pickModelOtherThan excludes a model', () => {
  const rows = [...Array.from({ length: 8 }, () => outcome('opencode/grok-code', true)), ...Array.from({ length: 6 }, () => outcome('opencode/big-pickle', false))];
  const stats = statsFromOutcomes(rows);
  let seed = 3; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const { svc } = service({ io: { routingStats: () => stats, random } });
  const picks = Array.from({ length: 40 }, () => svc.pickModel([], { task: 'rename foo to bar' })!.id);
  assert.ok(picks.filter((id) => id === 'opencode/grok-code').length >= 34, picks.join(','));
  assert.ok(picks.every((id) => id.startsWith('opencode/')), 'never leaves the first available tier');
  assert.equal(svc.pickModelOtherThan('opencode/grok-code', { task: 'x' })!.id, 'opencode/big-pickle');
  assert.equal(svc.pickModelOtherThan(['opencode/grok-code', 'opencode/big-pickle'])!.provider, 'openrouter');
});

test('pickModel: the OpenRouter 2-worker cap is the FREE tier only; paid OpenRouter models are not under it', () => {
  const paid = M('openrouter/qwen/qwen3.7-flash', 'openrouter', 60);
  const { svc, rt } = service({ models: [M('openrouter/a/b:free', 'openrouter', 10), paid] });
  for (const id of ['x1', 'x2']) { const p = new FakePane(id, 'chat:swarm', null, [], {}); p.swarm = { model: 'openrouter/a/b:free', provider: 'openrouter', supersededBy: null } as any; rt.panes.set(id, p); }
  assert.equal(svc.pickModel()!.id, paid.id);
});

test('watchdog: a tick that skips a task still in its prompt hold keeps the timer for that task (found live 2026-10-19)', async () => {
  const { svc, rt } = service({ io: { watchdogTickMs: 60_000 } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'refactor the parser' });
  rt.panes.get(r.paneId!).promptPending = true; // skipped this tick
  svc.tickWatchdog();
  const timer = (svc as any).wdTimer;
  assert.ok(timer, 'the watchdog must still be armed for the held task');
  clearInterval(timer); (svc as any).wdTimer = null;
});

test('watchdog: T1 nudge typed into the busy worker, then at T2 the task moves to another model in the SAME worktree', async () => {
  const { svc, rt, health } = service({ io: { config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, watchdog: { nudgeAfterMs: 60_000, reassignAfterMs: 120_000 } }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'refactor the parser' });
  const p1 = rt.panes.get(r.paneId!);
  p1.setState('working');
  const t0 = p1.swarm.attempts[0].at;
  svc.tickWatchdog(t0 + 30_000);
  assert.equal(rt.prompts.length, 0);
  svc.tickWatchdog(t0 + 61_000);
  await tick();
  assert.equal(rt.prompts.length, 1);
  assert.match(rt.prompts[0].text, /^Kora: you have been on this task for 1 min\. .*write your report to .*s1\.md now/);
  svc.tickWatchdog(t0 + 90_000);
  assert.equal(rt.prompts.length, 1, 'one nudge per attempt');
  svc.tickWatchdog(t0 + 121_000);
  const p2id = await svc.followSettled(r.paneId!);
  assert.notEqual(p2id, r.paneId!);
  const p2 = rt.panes.get(p2id);
  assert.equal(rt.spawns[1].reuseWorktree.path, rt.spawns[0].reuseWorktree.path, 'same worktree');
  assert.deepEqual(p2.swarm.attempts.map((a: any) => a.outcome), ['stalled', 'running']);
  assert.equal(health.isAvailable('opencode/big-pickle'), false, 'a model whose worker stalled is parked for 10 min, so the next spawn does not draw it again');
  assert.match(svc.note(r.paneId!)!, /was too slow \(no report in time\); respawned as/);
  assert.match(rt.spawns[1].args[rt.spawns[1].args.indexOf('--prompt') + 1], /was cut off \(stalled\)/);
});

test('watchdog: a worker that went idle without its report is reassigned after the idle nudge + 2 min', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working'); p.setState('idle');
  await tick(80); // the automatic idle nudge (nudgeMs 30 in tests)
  assert.equal(rt.prompts.length, 1);
  svc.tickWatchdog(Date.now() + 60_000);
  assert.equal(rt.spawns.length, 1);
  svc.tickWatchdog(Date.now() + 2 * 60_000 + 1000);
  await svc.followSettled(r.paneId!);
  assert.equal(rt.spawns.length, 2);
});

test('watchdog: a paid worker over its spend cap is told to stop, then stopped; the note says why', async () => {
  const paid = M('openrouter/qwen/qwen3.7-flash', 'openrouter', 0);
  let cost = 0.01;
  const { svc, rt } = service({ models: [paid], io: {
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, paidMaxTaskUsd: 0.05 }),
    activity: (dirs: { dir: string }[]) => new Map(dirs.map((d) => [d.dir, { lastAt: Date.now(), costUsd: cost }])),
  } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  svc.tickWatchdog(Date.now());
  assert.equal(rt.prompts.length, 0);
  cost = 0.06;
  const at = Date.now();
  svc.tickWatchdog(at);
  await tick();
  assert.match(rt.prompts[0].text, /spend cap \(\$0\.060 of \$0\.05\)/);
  assert.match(svc.note(r.paneId!)!, /reached its paid spend cap/);
  svc.tickWatchdog(at + 91_000);
  await tick(30);
  assert.equal(p.exited, true);
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'failed', 'no report was written');
});

test('registry status follows the live pane: a finished task never reads "running" (tasks.json included)', async () => {
  const { svc, rt } = service({ io: { config: () => ({ autoVerify: false, maxBounces: 2, maxWorkers: 4 }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'running');
  fs.writeFileSync(r.reportPath, '## Done');
  p.setState('idle');
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'done');
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.KORA_HOME!, 'swarm', 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(onDisk.status, 'done');
  // A pane reaped without an exit event (killed out from under us): not "running" either.
  const r2 = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'u' });
  rt.panes.get(r2.paneId!).setState('working');
  rt.panes.delete(r2.paneId!);
  assert.equal(svc.taskForPane(r2.paneId!)!.status, 'failed');
});

test('outcomes.jsonl rows carry the task type and nudge count for routing', async () => {
  const { svc, rt } = service({ io: { config: () => ({ autoVerify: false, maxBounces: 2, maxWorkers: 4 }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'The login tests are failing — fix them' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  fs.writeFileSync(r.reportPath, '## Done');
  p.setState('idle');
  const row = JSON.parse(fs.readFileSync(path.join(process.env.KORA_HOME!, 'swarm', 'outcomes.jsonl'), 'utf8').trim().split('\n').at(-1)!);
  assert.equal(row.type, 'test-fix');
  assert.equal(row.nudges, 0);
  assert.equal(row.status, 'done');
});

test('pickModel paidOnly: a paid task never falls back to a free model', () => {
  const models = [
    { id: 'openrouter/qwen/qwen3-coder:free', provider: 'openrouter', label: 'qwen', rank: 1, maxConcurrent: null },
    { id: 'openrouter/deepseek/deepseek-v4.1-flash', provider: 'openrouter', label: 'ds', rank: 60, maxConcurrent: null },
    { id: 'openrouter/deepseek/deepseek-v4-flash', provider: 'openrouter', label: 'ds4', rank: 61, maxConcurrent: null },
  ] as any;
  const { svc } = service({ models });
  assert.equal(svc.pickModel(['openrouter/deepseek/deepseek-v4.1-flash'], { paidOnly: true })!.id, 'openrouter/deepseek/deepseek-v4-flash');
  assert.equal(svc.pickModel(['openrouter/deepseek/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-v4-flash'], { paidOnly: true }), null);
  assert.equal(svc.pickModel(['openrouter/deepseek/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-v4-flash'])!.id, 'openrouter/qwen/qwen3-coder:free');
});

test('dynamic workflow: milestones via the worker helper, a race winner stops its siblings, progress digests', async () => {
  const { svc, rt } = service();
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'hypothesis A: the limiter uses >', title: 'A', runtimeMode: 'full-access', race: 'bug4' });
  const b = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'hypothesis B: the counter is not decremented', title: 'B', runtimeMode: 'full-access', race: 'bug4' });
  const c = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'unrelated', title: 'C', runtimeMode: 'full-access' });
  for (const id of [a.paneId!, b.paneId!, c.paneId!]) rt.panes.get(id).setState('working');
  const wtA = rt.spawns[0].reuseWorktree.path;
  // the worker posts through its helper script, from its own worktree
  const r = spawnSync('sh', [path.join(wtA, '.kora', 'bin', 'milestone'), 'root-cause', 'abuse-controls.js:60 uses > instead of >='], { cwd: wtA, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(wtA, '.kora', 'bin', 'graph')), 'the graph helper is there too');
  svc.tickMilestones();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(rt.panes.get(b.paneId!)?.swarm?.phase ?? 'failed', 'failed', 'B lost the race and was stopped');
  assert.notEqual(rt.panes.get(c.paneId!).swarm.phase, 'failed', 'C is not in the race');
  const [pa, pc] = await svc.progress([a.paneId!, c.paneId!]);
  assert.equal(pa.milestones[0].kind, 'root-cause');
  assert.match(pa.milestones[0].note, /abuse-controls\.js:60/);
  assert.equal(pa.race, 'bug4');
  assert.equal(pc.milestones.length, 0);
  assert.equal(spawnSync('sh', [path.join(wtA, '.kora', 'bin', 'milestone'), 'bogus', 'x'], { cwd: wtA }).status, 2, 'unknown kinds are refused');
});

test('merge gate with a done-check: name-level overlaps are advisory, a removed symbol still bounces, file-level blame is ignored', async () => {
  const run = async (blame: any[], check?: string) => {
    const { svc } = service({ io: { verifyGate: async () => [{ a: 'p1', b: 'p9', status: 'semantic', blame }], config: () => ({ autoVerify: true, maxBounces: 0, maxWorkers: 4 }), runCheck: async () => ({ state: 'passed', exitCode: 0, durationMs: 1, tail: '' }) } });
    const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't', ...(check ? { check, runtimeMode: 'full-access' } : {}) } as any);
    return svc.verifyAndBounce(r.paneId!);
  };
  const named = await run([{ file: 'a.js', line: 60, symbol: 'current', byWorker: 'p1' }], 'npm test');
  assert.equal(named.state, 'passed'); assert.match(String(named.summary), /advisory/);
  assert.equal((await run([{ file: 'a.js', line: 60, symbol: 'f', byWorker: 'p1', removed: true }], 'npm test')).state, 'failed');
  assert.equal((await run([{ file: 'a.js', line: 1, symbol: 'x', byWorker: 'p1' }])).state, 'passed', 'file-level attribution is not evidence');
  assert.equal((await run([{ file: 'a.js', line: 60, symbol: 'current', byWorker: 'p1' }])).state, 'failed', 'without a check the gate still decides');
});

// ── fleet.retry / fleet.extend (human fleet actions) ─────────────────────────────────────────────────────────

test('retryWorker: fails the task over to another model in the same worktree and leaves a human-attributed note', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p1 = rt.panes.get(r.paneId!);
  p1.setState('working');
  const out = await svc.retryWorker(r.paneId!);
  assert.ok(out);
  const p2id = out!.newPaneId;
  assert.notEqual(p2id, r.paneId!);
  assert.equal(out!.taskId, 's1');
  assert.equal(rt.spawns[1].reuseWorktree.path, rt.spawns[0].reuseWorktree.path, 'same worktree');
  assert.equal(svc.note(r.paneId!), `[kora] the user moved swarm worker ${r.paneId} to another model (${p2id}).`);
  const p2 = rt.panes.get(p2id);
  assert.deepEqual(p2.swarm.attempts.map((a: any) => a.outcome), ['stalled', 'running']);
});

test('retryWorker: a non-swarm pane, or an already-exhausted task, is not retried (null)', async () => {
  const { svc, rt } = service({ models: [M('opencode/big-pickle', 'zen', 0)] }); // exactly one model: 'gone' exhausts immediately
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  svc.reportEvent({ paneId: r.paneId!, type: 'session.error', message: 'Model not found: opencode/big-pickle' });
  await svc.followSettled(r.paneId!);
  assert.equal(svc.taskForPane(r.paneId!)!.status, 'exhausted');
  assert.equal(await svc.retryWorker(r.paneId!), null, 'already exhausted');
  assert.equal(await svc.retryWorker('p999'), null, 'unknown pane');
});

test('extendWorker: pushes the watchdog\'s nudge/reassign thresholds out by the given minutes and leaves a note', async () => {
  const { svc, rt } = service({ io: { config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, watchdog: { nudgeAfterMs: 60_000, reassignAfterMs: 120_000 } }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p1 = rt.panes.get(r.paneId!);
  p1.setState('working');
  const t0 = p1.swarm.attempts[0].at;
  const out = svc.extendWorker(r.paneId!, 10);
  assert.deepEqual(out, { taskId: 's1' });
  assert.equal(svc.note(r.paneId!), `[kora] the user gave swarm worker ${r.paneId} 10 more minutes.`);
  // Without the extension, T2 (120s) would have reassigned here.
  svc.tickWatchdog(t0 + 121_000);
  assert.equal(rt.spawns.length, 1, 'reassign delayed past the original T2');
  // 10 extra minutes (600s) pushes both T1 and T2 out; well past the extended T2 it still reassigns.
  svc.tickWatchdog(t0 + 600_000 + 121_000);
  const p2id = await svc.followSettled(r.paneId!);
  assert.notEqual(p2id, r.paneId!, 'reassigns once the extension itself elapses');
});

test('extendWorker: a non-swarm pane, or an already-done task, is not extended (null)', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  p.swarm = { ...p.swarm, phase: 'done' };
  assert.equal(svc.extendWorker(r.paneId!, 5), null);
  assert.equal(svc.extendWorker('p999', 5), null, 'unknown pane');
});

test('tickSteps: an OpenCode worker\'s step comes from io.step and a snapshot is re-emitted only when the text changes', async () => {
  const steps = new Map<string, { text: string; at: number; kind: string } | null>();
  const { svc, rt } = service({ io: { step: (dirs: { dir: string }[]) => new Map(dirs.map((d) => [d.dir, steps.get(d.dir) ?? null])) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!);
  p.setState('working');
  const dir = rt.spawns[0].reuseWorktree.path;
  assert.equal(p.swarm.step, undefined, 'nothing yet');
  svc.tickSteps();
  assert.equal(p.swarm.step ?? null, null, 'io.step answered null: no step, not an emit either way');
  steps.set(dir, { text: 'reading example.com', at: 1, kind: 'fetch' });
  svc.tickSteps();
  assert.deepEqual(p.swarm.step, { text: 'reading example.com', at: 1, kind: 'fetch' });
  const notesBefore = rt.notes.length;
  svc.tickSteps(); // same text again → no re-emit
  assert.equal(rt.notes.length, notesBefore);
  steps.set(dir, { text: 'writing report', at: 2, kind: 'write' });
  svc.tickSteps();
  assert.equal(p.swarm.step.text, 'writing report');
  assert.ok(rt.notes.length > notesBefore, 'a changed step IS emitted');
});

// Swarm QA 2026-10-02: the lead read a human stop as a failure and respawned the task.
test('userStopped: a human-attributed note tells the lead not to respawn; unknown panes → null', async () => {
  const { svc } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  assert.deepEqual(svc.userStopped(r.paneId!), { taskId: 's1' });
  assert.match(svc.note(r.paneId!)!, /^\[kora\] the human stopped swarm worker p\d+ \(task s1\)\. Do not respawn it/);
  assert.equal(svc.userStopped('p999'), null);
});

// Live 2026-10-02: five assistant-lane research helpers idled on (~1.4 GB) after the lead had written its answer.
test('a finished helper with nothing to merge (no worktree) is closed after retireDoneMs; its report stays readable', async () => {
  const { svc, rt } = service({ io: { retireDoneMs: 30 } });
  const cwd = blobCwd();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd, task: 'research', title: 'research' });
  const p = rt.panes.get(r.paneId!);
  fs.mkdirSync(path.dirname(r.reportPath), { recursive: true });
  fs.writeFileSync(r.reportPath, '## Found\nfacts');
  const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(r.paneId!));
  (svc as any).setPhase(t, p, 'done');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(p.retired, true);
  assert.equal(p.exited, true, 'closed');
  assert.match((await svc.readReport(r.paneId!))!.text, /facts/);
  // A worktree worker with CHANGES is never closed this way (it waits for its merge).
  const { svc: svc2, rt: rt2 } = service({ io: { retireDoneMs: 30, worktreeClean: async () => false } });
  const r2 = await svc2.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'code' });
  const p2 = rt2.panes.get(r2.paneId!);
  const t2 = [...(svc2 as any).registry().values()].find((x: any) => x.record.paneIds.includes(r2.paneId!));
  (svc2 as any).setPhase(t2, p2, 'done');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(p2.exited, false);
});

test('a completed-but-unmerged swarm worker is retired after retireUnmergedMs idle; user held open stays', async () => {
  const { svc, rt } = service({ io: { retireDoneMs: 30, retireUnmergedMs: 50, worktreeClean: async () => false } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'code' });
  const p = rt.panes.get(r.paneId!);
  const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(r.paneId!));

  // Held open by user: not retired
  p.sizeOwnerConnId = 'conn-1';
  (svc as any).setPhase(t, p, 'done');
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(Boolean(p.retired), false);
  assert.equal(p.exited, false);

  // User releases hold: retired
  p.sizeOwnerConnId = null;
  await (svc as any).retireUnmergedNow(t, p);
  assert.equal(p.retired, true);
  assert.equal(p.exited, true);
});


// QA 2026-10-10: read-only helpers (kora_map) each kept a worktree, a branch and an idle OpenCode (~200 MB-1 GB).
test('a finished worker whose worktree is clean is closed, its report copied out, and its worktree swept at once', async () => {
  const swept: any[] = [];
  const { svc, rt } = service({ io: { retireDoneMs: 30, worktreeClean: async () => true } });
  rt.worktreeSweep = async (p: any) => { swept.push(p); return {}; };
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'read-only map' });
  const p = rt.panes.get(r.paneId!);
  fs.mkdirSync(path.dirname(r.reportPath), { recursive: true });
  fs.writeFileSync(r.reportPath, '## Found\nthe facts');
  const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(r.paneId!));
  (svc as any).setPhase(t, p, 'done');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(p.retired, true);
  assert.equal(p.exited, true);
  assert.notEqual(t.record.reportPath, r.reportPath, 'the report moved out of the worktree');
  assert.match(fs.readFileSync(t.record.reportPath, 'utf8'), /the facts/);
  await new Promise((res) => setTimeout(res, 3200));
  assert.equal(swept.length, 1, 'the sweep ran right after the close, not at the next periodic one');
  assert.equal(swept[0].repos.length, 1);
});

// B5 (night 2026-10-04): a worker that cannot reach its provider (OpenCode 1.18.32 offline, recorded) retried quietly
// until the watchdog's 8–15 min. After a few retries it moves on, with a short cool (it is often this Mac's network).
test('failover: a worker that cannot connect to its provider moves on after 3 retries, with a short cooldown', async () => {
  const { svc, rt, health } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'the task' });
  rt.panes.get(r.paneId!).setState('working');
  const OFFLINE = 'Cannot connect to API: Unable to connect. Is the computer able to access the url?';
  for (const attempt of [1, 2]) svc.reportEvent({ paneId: r.paneId!, type: 'session.status', status: 'retry', attempt, message: OFFLINE });
  assert.equal(rt.spawns.length, 1, 'two retries are OpenCode\'s business');
  svc.reportEvent({ paneId: r.paneId!, type: 'session.status', status: 'retry', attempt: 3, message: OFFLINE });
  const p2 = await svc.followSettled(r.paneId!);
  assert.notEqual(p2, r.paneId!);
  assert.match(svc.note(r.paneId!)!, /could not reach its provider \(no connection\)/);
  assert.equal(health.isAvailable('opencode/big-pickle'), false);
  const until = cooldownUntil('opencode/big-pickle', 'unreachable', 0);
  assert.equal(until, 2 * 60_000, 'not the 15-minute Zen rate-limit floor');
  assert.match(swarmExhaustedNote('s1', ['a', 'b'], null, ['unreachable', 'unreachable']), /every free model is rate-limited or unavailable/);
  // never a licence to spend the user's own tokens unasked (pl5 S2-3)
  assert.match(swarmExhaustedNote('s1', ['a', 'b'], null, ['unreachable', 'unreachable']), /Do not do it yourself without asking/);
  assert.doesNotMatch(swarmExhaustedNote('s1', ['a', 'b'], null, ['unreachable', 'unreachable']), /then do it yourself/);
});

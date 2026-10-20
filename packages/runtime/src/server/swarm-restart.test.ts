// Koragent E2E fixes on the Kora side (docs: koragent/docs/koragent/E2E-REPORT.md):
//   D16 finished workers no longer hold a maxWorkers slot · D5 a pane orchestrator's workers inherit an explicit
//   permission (or the orchestrator's own mode), never a silent `supervised` · D31 the worker.attached label is the
//   real worker program · D21 a Koragent retry brief carries its report + events, never the TUI screen ·
//   D17/D18 a daemon restart resumes unfinished tasks (same pane id, digest continuation), keeps finished ones finished,
//   and kora_wait still answers for both; the state file keeps fleet links and never re-spawns swarm panes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { SwarmModelInfo, SwarmStatus } from '../protocol/types';
import { SwarmService, swarmRuntimeMode } from './swarm';
import { SwarmHealth } from './swarm-health';
import { koragentDigest, recentEventLine } from './koragent-backend';
import { reportStatus } from './swarm-foreman';
import { fleetToolSpecs, type FleetControl, type SwarmSpawner } from '../session/fleet-tools';

process.env.KORA_WORKTREES = path.join(process.env.KORA_HOME || os.tmpdir(), 'wt-restart');

class Pane extends EventEmitter {
  swarm: any = null; exited = false; state = 'idle'; blocker: string | null = null; promptPending = false; screen = '';
  constructor(public id: string, public agent: string, public role: 'orchestrator' | 'worker' | null, public orchestratorId: string | null = null, public workspaceId = 'w1', public worktree: any = null, public args: string[] = []) { super(); }
  info() { return { id: this.id, swarm: this.swarm } as any; }
  read() { return this.screen; }
  kill() { if (this.exited) return; this.exited = true; setImmediate(() => this.emit('exit', 0)); }
}

const MODELS: SwarmModelInfo[] = [{ id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: null }, { id: 'opencode/ling', provider: 'zen', label: 'ling', rank: 1, maxConcurrent: null }];
function ready(maxWorkers = 4): SwarmStatus {
  return JSON.parse(JSON.stringify({
    ready: true, blockers: [], opencode: { installed: true, path: '/x', source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: true },
    install: { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null },
    consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1 }, providers: [], models: { available: MODELS, cooling: [] },
    preferences: { providerOrder: ['zen'], defaultModel: null, maxWorkers }, keyStorage: 'file', checkedAt: 1,
  }));
}

function runtime() {
  let n = 10;
  const rt: any = new EventEmitter();
  rt.panes = new Map<string, Pane>();
  rt.spawns = [] as any[];
  rt.notify = () => {};
  rt.agentSpawn = async (p: any) => {
    rt.spawns.push(p);
    const id = p.paneId! && !rt.panes.has(p.paneId!) ? p.paneId! : `p${n++}`;
    rt.panes.set(id, new Pane(id, p.agent, 'worker', p.orchestratorId, p.workspaceId ?? 'w0', p.reuseWorktree ?? null, p.args));
    return { id };
  };
  rt.killPane = (id: string) => { const p = rt.panes.get(id); rt.panes.delete(id); p?.kill(); };
  rt.prompt = async () => ({ ok: true, state: 'working' });
  rt.graph = { callTool: async () => ({ text: '', data: null, ms: 0 }) };
  return rt;
}

function service(opts: { home?: string; maxWorkers?: number; io?: Record<string, unknown> } = {}) {
  process.env.KORA_HOME = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rs-home-'));
  const rt = runtime();
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rs-h-')), 'health.json'));
  const setup: any = { getStatus: async () => ready(opts.maxWorkers ?? 4), pickableModels: () => MODELS };
  const modes: (string | undefined)[] = [];
  const svc = new SwarmService({ runtime: rt, setup, health, io: {
    threadMode: (o: string) => (o.startsWith('chat:') ? 'swarm' : null), apiKey: () => null, opencodePath: () => '/fake/opencode',
    paneEnv: () => ({}), preamble: () => 'REPORT', permissionArgs: (m: string | undefined) => { modes.push(m); return []; }, contextPacket: async () => ({ text: '', files: [] }),
    overlap: () => [], changedFiles: async () => [], verifyGate: async () => [],
    config: () => ({ autoVerify: false, maxBounces: 0, maxWorkers: 4, foremanRetries: 0 }), nudgeMs: 0, screenPollMs: 0, watchdogTickMs: 0,
    ...(opts.io ?? {}),
  } as any });
  return { svc, rt, home: process.env.KORA_HOME!, modes };
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rs-repo-'));
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

// 20 s: dispatchQueued's startTask does a real worktree checkout off the event loop; a busy monorepo-wide test run
// can take several seconds to get there.
const until = async (f: () => boolean, ms = 20_000): Promise<boolean> => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return f(); };

const setPhase = (svc: SwarmService, paneId: string, phase: string) => {
  const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(paneId));
  (svc as any).setPhase(t, (svc as any).rt.panes.get(paneId), phase);
};

// ── D16 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('D16: only workers still at work hold a maxWorkers slot — a done (still open) worker frees its slot', async () => {
  const { svc } = service({ maxWorkers: 2 });
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', runtimeMode: 'full-access' });
  await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', runtimeMode: 'full-access' });
  await assert.rejects(svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c', runtimeMode: 'full-access' }), /2 workers already running \(maxWorkers 2\)/);
  setPhase(svc, a.paneId!, 'done'); // reported; its pane is still open (not merged, not killed)
  const c = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c again', runtimeMode: 'full-access' });
  assert.ok(c.paneId!, 'the retry dispatch is accepted');
  setPhase(svc, c.paneId!, 'failed');
  await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix d', runtimeMode: 'full-access' });
});

// ── swarm spawn queue ────────────────────────────────────────────────────────────────────────────────────────
test('spawn queue: over maxWorkers with queue:true queues FIFO instead of refusing; a slot freeing starts the next queued task', async () => {
  const { svc } = service({ maxWorkers: 2 });
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', runtimeMode: 'full-access' });
  const b = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', runtimeMode: 'full-access' });
  // Without queue:true, still refused exactly as before.
  await assert.rejects(svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c', runtimeMode: 'full-access' }), /2 workers already running \(maxWorkers 2\)/);
  // With queue:true: a stable task id right away, no pane yet.
  const c = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c', runtimeMode: 'full-access', queue: true });
  assert.equal(c.queued, true);
  assert.equal(c.paneId, null);
  assert.match(c.taskId, /^s\d+$/);
  const d = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix d', runtimeMode: 'full-access', queue: true });
  assert.equal(d.queued, true);
  assert.deepEqual(svc.queuedTasks('chat:t').map((x) => x.taskId), [c.taskId, d.taskId], 'FIFO order');
  assert.deepEqual(svc.queuedTasks('chat:t').map((x) => x.position), [1, 2]);
  assert.equal(svc.taskForPane(c.taskId)?.status, 'queued');
  assert.equal(svc.taskForPane(d.taskId)?.status, 'queued');
  // kora_workers-style ref resolution already works on the bare task id (no pane exists yet).
  assert.equal(svc.follow(c.taskId), c.taskId, 'nothing to follow to yet');

  // Free A's slot: the next queued task (c, FIFO) starts automatically — no new spawn() call needed. Dispatch runs
  // off the event loop (a real worktree checkout), so poll for it instead of a fixed sleep.
  setPhase(svc, a.paneId!, 'done');
  assert.ok(await until(() => svc.taskForPane(c.taskId)?.status !== 'queued'), 'c started');
  assert.ok(svc.taskForPane(c.taskId)!.paneIds.length > 0, 'c now has a pane');
  assert.notEqual(svc.follow(c.taskId), c.taskId, 'follow(taskId) now resolves to its pane');
  assert.deepEqual(svc.queuedTasks('chat:t').map((x) => x.taskId), [d.taskId], 'd is still queued, still position 1');
  assert.equal(svc.queuedTasks('chat:t')[0].position, 1);

  // Free B's slot too: d starts next.
  setPhase(svc, b.paneId!, 'failed');
  assert.ok(await until(() => svc.taskForPane(d.taskId)?.status !== 'queued'), 'd started');
  assert.deepEqual(svc.queuedTasks('chat:t'), [], 'nothing left queued');
});

test('restart drops a queued-but-unstarted task plainly, never resumes it', async () => {
  const cwd = repo();
  const one = service({ maxWorkers: 1 });
  const a = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', runtimeMode: 'full-access' });
  const q = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', runtimeMode: 'full-access', queue: true });
  assert.equal(q.queued, true);
  fs.writeFileSync(a.reportPath, '## Status\ndone — fixed a');
  setPhase(one.svc, a.paneId!, 'done'); // already finished before the stop — nothing to resume for it either
  one.svc.shutdown();
  for (const id of [...one.rt.panes.keys()]) one.rt.killPane(id);
  await new Promise((r) => setTimeout(r, 20));
  const rows = JSON.parse(fs.readFileSync(path.join(one.home, 'swarm', 'tasks.json'), 'utf8')).tasks;
  const qRow = rows.find((r: any) => r.taskId === q.taskId);
  assert.equal(qRow.status, 'queued', 'persisted as queued, exactly as it stood');
  assert.equal(qRow.resume, undefined, 'no resume info: never dropped a worktree, nothing to relaunch');

  const two = service({ home: one.home, maxWorkers: 1 });
  const r = await two.svc.resumeAfterRestart({ restoredPaneIds: new Set() });
  assert.deepEqual(r.resumed, [], 'the queued task is never relaunched');
  assert.equal(two.rt.spawns.length, 0, 'no worktree, no pane — dropped, not resumed');
  assert.equal(two.svc.taskForPane(q.taskId)?.status, 'failed', 'dropped, plainly');
  assert.match(two.svc.note(q.taskId) ?? '', /was queued but never started before a daemon restart.*dropped/);
  assert.equal(two.svc.queuedTasks('chat:t').length, 0, 'the in-memory queue starts empty for the new daemon');
});

// ── D5 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('D5: swarmRuntimeMode — explicit permission, capped by runtimeMode; else runtimeMode; else the orchestrator fallback', () => {
  assert.equal(swarmRuntimeMode({ permission: 'auto-edits' }, null), 'auto-accept-edits');
  assert.equal(swarmRuntimeMode({ permission: 'full' }, 'approval-required'), 'full-access', 'an explicit request wins over the fallback');
  assert.equal(swarmRuntimeMode({ permission: 'full', runtimeMode: 'approval-required' }), 'approval-required', 'never above the thread');
  assert.equal(swarmRuntimeMode({ permission: 'supervised', runtimeMode: 'full-access' }), 'approval-required', 'a leader may lower it');
  assert.equal(swarmRuntimeMode({ runtimeMode: 'auto' }, 'approval-required'), 'auto');
  assert.equal(swarmRuntimeMode({}, 'full-access'), 'full-access');
  assert.equal(swarmRuntimeMode({ permission: 'bogus' }, 'auto-accept-edits'), 'auto-accept-edits');
});

test('D5: workers of a Koragent lead pane are not supervised: explicit permission, else the daemon default runtime mode', async () => {
  const { svc, rt, home, modes } = service({ io: { threadMode: () => null } }); // orchestratorMode: the real default (settings.json)
  rt.panes.set('p1', new Pane('p1', 'koragent', null, null, 'wsLead'));
  const cwd = repo();
  const d = await svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix a' });
  assert.equal(d.permission, 'full', 'no settings saved: DEFAULT_RUNTIME_MODE (full-access)');
  assert.equal(modes.at(-1), 'full-access');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ defaultRuntimeMode: 'auto-accept-edits' }));
  assert.equal((await svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix b' })).permission, 'auto-edits', 'the daemon default runtime mode');
  assert.equal((await svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix c', permission: 'full' })).permission, 'auto-edits', 'A1 D5: a pane lead\'s explicit `full` is capped at the daemon default');
  assert.equal((await svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix d', permission: 'supervised' })).permission, 'supervised');
});

test('D5 + D31: kora_spawn passes `permission` (top level and per task) and labels the worker with the backend it launched', async () => {
  const calls: any[] = []; const attached: any[] = [];
  const swarm: SwarmSpawner = {
    spawn: async (p) => { calls.push(p); return { paneId: `p${10 + calls.length}`, taskId: `s${calls.length}`, provider: 'zen', model: 'm', modelLabel: 'm', reportPath: '/r.md', overlaps: [], agent: 'koragent', permission: 'auto-edits' } as any; },
    taskForPane: () => null, readReport: async () => null,
  };
  const specs = fleetToolSpecs({ fleet: {} as FleetControl, orchestratorId: 'p1', agent: 'koragent' as any, cwd: '/r', account: null, spawnWorker: async () => { throw new Error('no'); }, agentMode: 'swarm', swarm, onSpawned: (w) => attached.push(w) });
  const spawn = specs.find((s) => s.name === 'kora_spawn')!;
  assert.deepEqual(spawn.params.permission?.enum, ['supervised', 'auto-edits', 'full']);
  const r = await spawn.handler({ agent: 'swarm', permission: 'auto-edits', tasks: [{ prompt: 'a' }, { prompt: 'b', permission: 'full' }] });
  assert.equal(r.isError, undefined, r.text);
  assert.deepEqual(calls.map((c) => c.permission), ['auto-edits', 'full']);
  assert.deepEqual(attached.map((w) => w.agent), ['koragent', 'koragent'], 'D31: not "opencode"');
});

// ── D21 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('D21: a Koragent retry brief is its last report + events; the screen (HUD chrome) never goes in', () => {
  const recent = [
    { type: 'tool.start', tool: 'edit', title: 'src/a.js' }, { type: 'tool.end', status: 'completed' }, { type: 'budget.update' },
    { type: 'permission.request', tool: 'bash', summary: 'rm -rf build' }, { type: 'tool.end', status: 'error', exitCode: 1 },
  ].map((e) => recentEventLine(e as any)).filter(Boolean) as string[];
  assert.deepEqual(recent, ['edit: src/a.js', 'waited on permission: bash — rm -rf build', '  → error (exit 1)']);
  const report = { v: 1, taskId: 's1', sessionId: 'x', status: 'blocked', summary: 'tests need a DB', changes: [{ path: 'src/a.js', added: 1, removed: 0 }], check: { command: 'node --test', exitCode: 1, outputTail: '', ranBy: 'harness' }, findings: [], blockers: ['no DB'], attempts: [], usage: { steps: 3, tokens: {}, costUsd: 0, refCostUsd: 0, bySource: {} } } as any;
  const d = koragentDigest({ report, recent });
  assert.match(d, /^previous worker \(koragent\):\nlast report: status blocked — tests need a DB\nchanges: src\/a\.js\ncheck `node --test` → exit 1\nblocker: no DB\nlast events:\n- edit: src\/a\.js/);
  assert.equal(koragentDigest(null), '');
  assert.equal(reportStatus('blocked', '## Status\ndone'), 'blocked', 'Koragent\'s TaskReport status wins over the .md');
  assert.equal(reportStatus(null, '## Status\npartial (budget reached) — x'), 'partial');

  const { svc, rt } = service();
  const pane = new Pane('p7', 'koragent', 'worker'); pane.screen = '✓ done · $0.00 · big-pickle·free · 15.9K tok · ctx 8% · graph ✓';
  rt.panes.set('p7', pane);
  const kgTail = (svc as any).workerTail({ backend: 'koragent', kg: { report, recent } }, pane);
  assert.doesNotMatch(kgTail, /ctx 8%|graph ✓/);
  assert.match(kgTail, /last report: status blocked/);
  assert.match((svc as any).workerTail({ backend: 'opencode' }, pane), /^worker screen \(tail\):\n✓ done/, 'OpenCode keeps its screen tail');
});

// ── D17 / D18 ────────────────────────────────────────────────────────────────────────────────────────────────
test('D17/D18: restart — a done task stays done, an unfinished one resumes on its pane id with a digest; kora_wait answers both', async () => {
  const cwd = repo();
  const one = service();
  const done = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', title: 'a', runtimeMode: 'full-access' });
  const running = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b in b.ts', title: 'b', runtimeMode: 'full-access' });
  const reported = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c', title: 'c', runtimeMode: 'full-access' });
  fs.writeFileSync(done.reportPath, '## Status\ndone — fixed a\n\n## Changes\n- a.ts');
  setPhase(one.svc, done.paneId!, 'done');
  setPhase(one.svc, running.paneId!, 'running');
  setPhase(one.svc, reported.paneId!, 'running');
  fs.writeFileSync(reported.reportPath, '## Status\ndone — fixed c'); // reported just before the stop, not yet verified
  // The daemon stops: tasks.json is written as it stands; the dying panes must not rewrite it.
  one.svc.shutdown();
  for (const id of [...one.rt.panes.keys()]) one.rt.killPane(id);
  await new Promise((r) => setTimeout(r, 20));
  const rows = JSON.parse(fs.readFileSync(path.join(one.home, 'swarm', 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(rows.map((r: any) => r.status), ['done', 'running', 'running']);
  assert.ok(String(rows[1].resume.task).startsWith('fix b in b.ts\n')); assert.match(String(rows[1].resume.task), /\.kora\/bin\/milestone/, 'the worker helpers ride along');

  const two = service({ home: one.home });
  const r = await two.svc.resumeAfterRestart({ restoredPaneIds: new Set() });
  assert.deepEqual(r, { resumed: [running.taskId], finished: [reported.taskId], dropped: [] });
  assert.equal(two.rt.spawns.length, 1, 'one relaunch: finished tasks are never re-run');
  // QA 2026-10-10: a task that reported before the stop used to vanish from outcomes.jsonl (the pass-rate data)
  const outcomes = fs.readFileSync(path.join(one.home, 'swarm', 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(outcomes.some((o: any) => o.taskId === reported.taskId && o.status === 'done' && o.restored === true), 'the restored task got its outcome line');
  const sp = two.rt.spawns[0];
  assert.equal(sp.paneId!, running.paneId!, 'asks for its old pane id');
  assert.equal(sp.orchestratorId, 'chat:t');
  assert.equal(sp.reuseWorktree.path, one.rt.spawns[1].reuseWorktree.path, 'same worktree');
  const prompt = sp.args[sp.args.indexOf('--prompt') + 1];
  assert.match(prompt, /Kora's daemon restarted while this task was running/);
  assert.match(prompt, /fix b in b\.ts/);
  const live = two.rt.panes.get(running.paneId!);
  assert.ok(live && live.swarm?.taskId === running.taskId, 'the leader\'s id names the resumed worker');

  // kora_wait from the (restarted) leader: the done task answers with its report, the reported one too.
  const mergeCalls: string[] = [];
  const fleet: FleetControl = {
    list: async (o) => [...two.rt.panes.values()].filter((p: Pane) => p.orchestratorId === o).map((p: Pane) => ({ id: p.id, name: p.id, agent: 'opencode', state: 'working', blocker: null, exited: false, exitCode: null, cwd, worktree: p.worktree, createdAt: 1, lastOutputAt: Date.now(), orchestratorId: o, swarm: p.swarm } as any)),
    prompt: async () => ({ state: 'idle' }), wait: async () => ({ state: 'working', blocker: null, timedOut: true, exited: false }), read: async () => '', report: async () => '',
    kill: async () => {}, mergeVerify: async () => ({ pairs: [], order: [] }), merge: async (id) => { mergeCalls.push(id); return { ok: true, conflicts: [], message: 'ok', commitsMerged: 1 }; }, setPlan: async () => {},
  };
  const specs = fleetToolSpecs({ fleet, orchestratorId: 'chat:t', agent: 'claude', cwd, account: null, spawnWorker: async () => { throw new Error('no'); }, agentMode: 'swarm', swarm: two.svc });
  const wait = specs.find((s) => s.name === 'kora_wait')!;
  const a = await wait.handler({ paneId: done.paneId!, timeoutMs: 1000 });
  assert.equal(a.isError, undefined, a.text);
  assert.match(a.text, new RegExp(`worker ${done.paneId!} \\(swarm task ${done.taskId}\\) is no longer running \\(done\\)`));
  assert.match(a.text, /## Status\ndone — fixed a/);
  assert.equal(two.svc.lostInRestart(done.paneId!), false, 'finished before the restart is not "lost"');
  // kora_merge of the finished task: no pane any more, its worktree still merges (the daemon resolves it).
  assert.equal(two.svc.finishedWorktree(done.paneId!)?.path, one.rt.spawns[0].reuseWorktree.path);
  assert.equal(two.svc.finishedWorktree(running.paneId!), null, 'a live pane merges through its pane');
  const merged = await specs.find((s) => s.name === 'kora_merge')!.handler({ paneId: done.paneId! });
  assert.equal(merged.isError, undefined, merged.text);
  assert.deepEqual(mergeCalls, [done.paneId!]);
  // kora_merge paneIds:[…] with a finished-before-restart id and a live one (found live: the finished one was "skipped"
  // and the Claude leader re-did its fix by hand).
  const many = await specs.find((s) => s.name === 'kora_merge')!.handler({ paneIds: [reported.paneId!, running.paneId!] });
  assert.equal(many.isError, undefined, many.text);
  assert.deepEqual(mergeCalls, [done.paneId!, reported.paneId!, running.paneId!]);
  const workers = await specs.find((s) => s.name === 'kora_workers')!.handler({});
  assert.match(workers.text, new RegExp(`${running.paneId!} .*task=${running.taskId}`), 'kora_workers lists the resumed worker');
  // …and the tasks that finished before the restart (a Claude leader that saw only the resumed one re-did the other).
  assert.match(workers.text, new RegExp(`${done.paneId!}  finished before a daemon restart  swarm task=${done.taskId} phase=done .*kora_wait ${done.paneId!} returns its report`));
  assert.match(workers.text, new RegExp(`${reported.paneId!}  finished before a daemon restart  swarm task=${reported.taskId}`));
  assert.deepEqual(two.svc.finishedTasks('p1'), [], 'a pane orchestrator this daemon did not restore has none');
});

test('D17: a Koragent task resumes with its last events in the continuation; a pane orchestrator that did not come back drops its tasks', async () => {
  const cwd = repo();
  const one = service({ io: { workerBackend: () => 'koragent', koragentPath: () => '/fake/koragent', koragentClient: () => ({ on() {}, start() {}, send() {}, close() {}, connects: 0, lastSeq: 0, connected: false }) } });
  one.rt.panes.set('p1', new Pane('p1', 'koragent', null, null, 'wsLead'));
  const k = await one.svc.spawn({ orchestratorId: 'chat:k', cwd, task: 'fix k', runtimeMode: 'full-access' });
  const lead = await one.svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix l', permission: 'full' });
  const t = [...(one.svc as any).registry().values()].find((x: any) => x.record.taskId === k.taskId);
  (one.svc as any).onKoragentEvent(t, one.rt.panes.get(k.paneId!), { v: 1, seq: 1, ts: 1, type: 'tool.start', callID: 'c', tool: 'edit', title: 'src/k.js' });
  (one.svc as any).onKoragentEvent(t, one.rt.panes.get(k.paneId!), { v: 1, seq: 2, ts: 2, type: 'session.state', state: 'working' });
  one.svc.shutdown();

  const two = service({ home: one.home, io: { workerBackend: () => 'koragent', koragentPath: () => '/fake/koragent', koragentClient: () => ({ on() {}, start() {}, send() {}, close() {}, connects: 0, lastSeq: 0, connected: false }) } });
  const r = await two.svc.resumeAfterRestart({ restoredPaneIds: new Set() }); // p1 was not restored
  assert.deepEqual(r.resumed, [k.taskId]);
  assert.deepEqual(r.dropped, [lead.taskId]);
  assert.equal(two.svc.lostInRestart(lead.paneId!), true);
  const spec = JSON.parse(fs.readFileSync(two.rt.spawns[0].args[1], 'utf8'));
  assert.match(spec.goal, /---\nNOTE: Kora's daemon restarted[\s\S]*last events:\n- edit: src\/k\.js/);
  assert.equal(spec.permission, 'full');
});

test('D17/D18: the state file keeps fleet links, never re-spawns a swarm pane, and restore sets role + orchestratorId back', async () => {
  const home = fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'kr-'));
  process.env.KORA_HOME = home; process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0';
  const sock = path.join(home, 's.sock');
  const { stateFileFor } = require('./state') as typeof import('./state');
  const sleeper = process.platform === 'win32' ? { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] } : { command: '/bin/sleep', args: ['30'] };
  const pane = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...sleeper, cwd: home, agent: 'shell', agentSessionId: null, cols: 80, rows: 24, ...extra });
  fs.writeFileSync(stateFileFor(sock), JSON.stringify({ version: 1, savedAt: 1, activeWorkspaceId: 'w1', workspaces: [{ id: 'w1', name: 'w', cwd: home, activePaneId: 'p1', panes: [
    pane('p1', { role: 'orchestrator' }), pane('p2', { role: 'worker', orchestratorId: 'p1' }), pane('p3', { args: ['--task-spec', '/x/s1.task.json', '--event-stream', 'unix:/x.sock'] }),
  ] }] }));
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: sock, sweep: false });
  try {
    const rt = h.runtime;
    assert.equal(rt.panes.get('p1')?.role, 'orchestrator');
    assert.equal(rt.panes.get('p2')?.role, 'worker');
    assert.equal(rt.panes.get('p2')?.orchestratorId, 'p1', 'D18: the worker still belongs to its orchestrator');
    assert.equal(rt.panes.has('p3'), false, 'D17: a swarm worker is not re-run from its argv');
    assert.deepEqual([...rt.restoredPaneIds].sort(), ['p1', 'p2']);
    rt.panes.get('p2')!.swarm = null;
    const snap = (rt as any).snapshotState();
    const saved = snap.workspaces[0].panes;
    assert.deepEqual(saved.map((p: any) => [p.id, p.role ?? null, p.orchestratorId ?? null]), [['p1', 'orchestrator', null], ['p2', 'worker', 'p1']]);
    (rt.panes.get('p2') as any).swarm = { taskId: 's9' };
    assert.deepEqual((rt as any).snapshotState().workspaces[0].panes.map((p: any) => p.id), ['p1'], 'a live swarm pane is left to SwarmService');
  } finally { await h.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test('restore: a Koragent (or OpenCode) pane comes back without its first-message --prompt', () => {
  const { stripResume } = require('./state') as typeof import('./state');
  assert.deepEqual(stripResume('koragent', ['--lead', '--prompt', 'fix the three bugs']), ['--lead']);
  assert.deepEqual(stripResume('opencode', ['-m', 'x', '--prompt=hi']), ['-m', 'x']);
  assert.deepEqual(stripResume('shell', ['--prompt', 'x']), ['--prompt', 'x']);
});

// Swarm QA 2026-10-02 #5: a stopped swarm task vanished from the Tasks list after a restart, and a task stopped while
// still running would have been resumed by the next daemon.
test('a human-stopped task survives a restart as stopped (never resumed) and restored tasks are listable', async () => {
  const one = service();
  const cwd = repo();
  const a = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', title: 'tax', runtimeMode: 'full-access' });
  const b = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', title: 'cart', runtimeMode: 'full-access' });
  setPhase(one.svc, b.paneId!, 'running');
  assert.deepEqual(one.svc.userStopped(b.paneId!), { taskId: b.taskId });
  setPhase(one.svc, a.paneId!, 'done');
  one.svc.shutdown(); // b's pane never got to exit: the row is still mid-flight
  const two = service({ home: one.home });
  const r = await two.svc.resumeAfterRestart();
  assert.ok(!r.resumed.includes(b.taskId), `a stopped task is not resumed (${JSON.stringify(r)})`);
  const rows = two.svc.restoredTasks('chat:t');
  const rb = rows.find((x) => x.taskId === b.taskId)!;
  assert.equal(rb.userStopped, true);
  assert.equal(rb.status, 'failed');
  assert.equal(rb.title, 'cart');
  assert.equal(rb.provider, 'zen');
  const ra = rows.find((x) => x.taskId === a.taskId)!;
  assert.equal(ra.status, 'done');
  assert.equal(ra.userStopped, false);
  assert.deepEqual(two.svc.restoredTasks('chat:other'), []);
});

// Live 2026-10-02 (midwait e2e): the restart cut the lead's kora_spawn; the resumed session replayed it as "rejected by
// the user" and the lead spawned both tasks AGAIN beside the resumed workers.
test('after a restart the lead gets ONE digest of its in-flight tasks (resumed / kept done), not per-call guessing', async () => {
  const one = service();
  const cwd = repo();
  const a = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', title: 'tax', runtimeMode: 'full-access' });
  const b = await one.svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', title: 'cart', runtimeMode: 'full-access' });
  setPhase(one.svc, a.paneId!, 'running'); setPhase(one.svc, b.paneId!, 'running');
  fs.mkdirSync(path.dirname(b.reportPath), { recursive: true }); fs.writeFileSync(b.reportPath, '## Status\ndone');
  one.svc.shutdown();
  const two = service({ home: one.home });
  const r = await two.svc.resumeAfterRestart();
  assert.deepEqual(r.resumed, [a.taskId]); assert.deepEqual(r.finished, [b.taskId]);
  const d = two.svc.takeRestartDigest('chat:t')!;
  assert.match(d, /do not spawn these again/);
  assert.match(d, new RegExp(`${a.taskId} "tax": still running — resumed as p\\d+`));
  assert.match(d, new RegExp(`${b.taskId} "cart": had already reported`));
  assert.equal(two.svc.takeRestartDigest('chat:t'), null, 'delivered once');
  two.svc.restoreRestartDigest('chat:t', d);
  assert.equal(two.svc.takeRestartDigest('chat:t'), d, 'a digest handed back is taken again');
  assert.equal(two.svc.takeRestartDigest('chat:t'), null);
  assert.equal(two.svc.takeRestartDigest('chat:other'), null);
  // A second restart with nothing in flight: the task that reported a moment ago is still listed (it may have finished
  // while no turn of the lead ran), the resumed one is listed as it stands.
  two.svc.shutdown();
  const three = service({ home: one.home });
  await three.svc.resumeAfterRestart();
  const d3 = three.svc.takeRestartDigest('chat:t')!;
  assert.match(d3, new RegExp(`${b.taskId} "cart": finished`));
  // Long-over swarm work: no report written recently, nothing in flight → nothing to say.
  fs.utimesSync(b.reportPath, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000));
  three.svc.shutdown();
  const four = service({ home: one.home });
  const reg = (four.svc as any).registry();
  for (const t of reg.values()) if (t.record.taskId === a.taskId) { t.record.status = 'failed'; t.resume = null; }
  assert.equal(four.svc.takeRestartDigest('chat:t'), null);
});

// QA 2026-10-10: Stop on the lead must also drop queued (not yet started) tasks, or they start on their own later.
test('cancelQueued: a human Stop drops the thread\'s queued tasks; a freed slot starts nothing', async () => {
  const { svc } = service({ maxWorkers: 1 });
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', runtimeMode: 'full-access' });
  const b = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', runtimeMode: 'full-access', queue: true });
  assert.equal(b.queued, true);
  assert.deepEqual(svc.cancelQueued('chat:t'), [b.taskId]);
  assert.deepEqual(svc.queuedTasks('chat:t'), []);
  assert.equal(svc.taskForPane(b.taskId)?.status, 'failed');
  assert.deepEqual(svc.cancelQueued('chat:t'), [], 'idempotent');
  setPhase(svc, a.paneId!, 'done');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(svc.taskForPane(b.taskId)?.paneIds.length, 0, 'the dropped task never got a pane');
});

test('deep audit 2026-10-13 A1-2: a chat lead cannot raise its workers above the thread mode Kora stored', async () => {
  const { svc, home } = service();
  const cwd = repo();
  fs.mkdirSync(path.join(home, 'chat', 't'), { recursive: true });
  fs.writeFileSync(path.join(home, 'chat', 't', 'meta.json'), JSON.stringify({ runtimeMode: 'approval-required' }));
  // A raw socket call (no runtimeMode) or a Codex bridge with a stale launch-time mode asking for Full access + a check.
  const a = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix a', permission: 'full', check: 'echo pwned' } as any);
  assert.equal(a.permission, 'supervised', 'capped by the stored thread mode');
  assert.match(String((a as any).foreman?.checkRefused ?? ''), /check not run/, 'the done-check does not run unattended');
  const b = await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix b', runtimeMode: 'full-access', permission: 'full' } as any);
  assert.equal(b.permission, 'supervised', 'a caller-supplied runtimeMode is no ceiling');
  fs.writeFileSync(path.join(home, 'chat', 't', 'meta.json'), JSON.stringify({ runtimeMode: 'full-access' }));
  assert.equal((await svc.spawn({ orchestratorId: 'chat:t', cwd, task: 'fix c', permission: 'auto-edits' } as any)).permission, 'auto-edits', 'a lead may still lower it');
});

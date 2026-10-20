// The koragent WorkerBackend end to end: a swarm task through the REAL Runtime (node-pty pane, real worktree, real
// unix socket) and the fake koragent (test/fixtures/fake-koragent.cjs). spawn → TaskSpec + `--event-stream` →
// events → pane state / phase → task.report → verify (X2) → bounce as a `steer` → round 2 → kora_wait, whose answer
// has the same shape as an OpenCode worker's. Plus: a leader's kora_prompt as a steer, in-session route failover (no
// respawn), blocked on a permission, the report-file fallback, outcomes.jsonl `backend`, and the readiness blocker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { MergePair, SwarmModelInfo } from '../protocol/types';
import type { TaskSpec } from '../protocol/koragent';
import { SwarmService } from './swarm';
import { SwarmHealth } from './swarm-health';
import { SwarmSetup } from './swarm-setup';
import { makeFleetOps } from './fleet-ops';
import { fleetControlFrom, fleetToolSpecs } from '../session/fleet-tools';
import { invalidateConfig } from '../config';
import { setEditionForTests } from '../edition';

// Koragent (Kora Pro, Bun, a unix:<path> socket) is not ported to Windows yet (docs/windows/PORT.md).
const winSkip = { skip: process.platform === 'win32' };

// Koragent workers are Kora Pro: these tests exercise the Pro path.
setEditionForTests('pro');

const FAKE = path.resolve(__dirname, '../../test/fixtures/fake-koragent.cjs');
const home = process.env.KORA_HOME!;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
const koragentBin = path.join(bin, 'koragent');
fs.writeFileSync(koragentBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });

function git(cwd: string, ...args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kg-'));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const until = async (f: () => boolean, ms = 20_000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25)); return f(); };

const MODELS: SwarmModelInfo[] = [
  { id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: 4 },
  { id: 'openrouter/qwen/qwen3-coder:free', provider: 'openrouter', label: 'qwen3-coder', rank: 10, maxConcurrent: null },
];

let h: any;
const notes: { method: string; params: any }[] = [];
test.before(async () => {
  const { createServer } = require('./daemon');
  // sweep: false — the daemon's start-up orphan sweep (1.5 s in, no minAgeMs) removes a worktree whose pane is not
  // live yet; under a loaded parallel run it raced these spawns (pre-existing; see the hand-back notes).
  h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false, sweep: false });
  const orig = h.runtime.notify.bind(h.runtime);
  h.runtime.notify = (method: string, params: any) => { notes.push({ method, params }); return orig(method, params); };
});
test.after(async () => { await h?.close(); });

function service(io: Record<string, unknown> = {}) {
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kg-h-')), 'h.json'));
  const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS.filter((m) => health.isAvailable(m.id)) };
  const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
    threadMode: () => 'swarm', workerBackend: () => 'koragent', koragentPath: () => koragentBin,
    apiKey: (p: string) => (p === 'openrouter' ? 'sk-or-test' : null), random: () => 0.5,
    contextPacket: async () => ({ text: '## Context (from Kora graph)\n■ CONST a @ a.ts:1 — export const a = 1', files: ['a.ts'] }),
    screenPollMs: 0, nudgeMs: 60_000, watchdogTickMs: 0,
    verifyGate: async () => [],
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4 }),
    ...io,
  } as any });
  h.runtime.swarm = svc; // makeFleetOps follows panes through runtime.swarm
  return { svc, health };
}

function tools(svc: SwarmService, cwd: string) {
  const ctl = fleetControlFrom(makeFleetOps(h.runtime));
  const specs = fleetToolSpecs({ fleet: ctl, orchestratorId: 'chat:kg', agent: 'claude', cwd, account: null, agentMode: 'swarm', swarm: svc, spawnWorker: async () => { throw new Error('not here'); } } as any);
  return (name: string) => specs.find((t) => t.name === name)!;
}

test('a swarm task on the koragent backend: TaskSpec, events → state, report → verify → bounce as a steer → kora_wait', winSkip, async () => {
  let gates = 0;
  const bounce = (paneId: string): MergePair[] => [{ a: paneId, b: 'main', status: 'semantic', reason: 'broken callers', blame: [{ file: 'b.ts', line: 3, symbol: 'a', removed: false, byWorker: paneId, compatible: false } as any] }];
  const { svc } = service({ verifyGate: async ({ paneId }: { paneId: string }) => (++gates === 1 ? bounce(paneId) : []) });
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'Add the thing to a.ts', title: 'kg one', runtimeMode: 'full-access' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    // launch: the koragent agent, the spec file, the event stream on ~/.kora/panes/<paneId>.sock
    assert.equal(pane.agent, 'koragent');
    assert.equal(pane.command, koragentBin);
    const sock = path.join(home, 'panes', `${pane.id}.sock`);
    assert.equal(pane.eventDriven, true);
    assert.equal(pane.eventSocketPath, sock);
    assert.deepEqual(pane.args.slice(-2), ['--event-stream', `unix:${sock}`]);
    assert.equal(pane.args[0], '--task-spec');
    assert.ok(!pane.args.includes('--prompt') && !pane.args.includes('-m'), 'nothing OpenCode-shaped in argv');
    const spec: TaskSpec = JSON.parse(fs.readFileSync(pane.args[1], 'utf8'));
    assert.equal(spec.taskId, r.taskId);
    assert.ok(spec.goal.startsWith('Add the thing to a.ts\n'), 'the task verbatim: no preamble, no path rewrite'); assert.match(spec.goal, /\.kora\/bin\/milestone/, 'the worker helpers ride along');
    assert.deepEqual(spec.route.map((x) => (x as { model: string }).model), [r.model, ...MODELS.map((m) => m.id).filter((m) => m !== r.model)]);
    assert.equal(spec.permission, 'full');
    assert.equal(spec.report.path, r.reportPath.replace(/\.md$/, '.json'));
    // Canonical (symlink-resolved) paths: Koragent compares tool targets against its realpath'd cwd.
    assert.deepEqual(spec.worktree, { path: fs.realpathSync(pane.worktree!.path), mainRoot: fs.realpathSync(pane.worktree!.mainRoot), branch: pane.worktree!.branch });
    assert.deepEqual(spec.context!.symbols, [{ kind: 'const', name: 'a', file: 'a.ts', line: 1, signature: 'export const a = 1' }]);
    assert.deepEqual(spec.parent, { kind: 'kora', orchestratorId: 'chat:kg' });
    assert.ok(fs.realpathSync(pane.worktree!.path) !== fs.realpathSync(cwd), 'its own worktree');
    assert.equal(pane.promptPending, false, 'no prompt-pending hold');

    // round 1 → report → gate finds a broken caller → bounced back to the SAME pane as a kora steer → round 2 → pass
    assert.ok(await until(() => pane.swarm?.phase === 'done'), `phase ${pane.swarm?.phase} verify ${JSON.stringify(pane.swarm?.verify)}`);
    assert.equal(gates, 2);
    assert.equal(pane.swarm!.verify!.state, 'passed');
    assert.equal(pane.swarm!.verify!.bounces, 1);
    assert.equal(pane.state, 'idle');
    assert.equal(h.runtime.panes.has(pane.id), true, 'never respawned');
    const md = fs.readFileSync(r.reportPath, 'utf8');
    assert.match(md, /round 2 on opencode\/big-pickle; follow-up: The Kora merge gate found problems/);
    assert.match(md, /steer: The Kora merge gate found problems[\s\S]*?\(kora, queue\)/, 'Kora\'s own bounce is a kora-sourced queued steer');
    assert.deepEqual(md.split('\n').filter((l) => l.startsWith('## ')), ['## Status', '## Changes', '## Check', '## Findings', '## Blockers']);
    const kinds = notes.filter((n) => n.method === 'swarm.worker' && n.params.event.paneId! === pane.id).map((n) => n.params.event.kind);
    assert.deepEqual(kinds, ['bounced', 'report']);

    // kora_wait: same answer shape as an OpenCode worker's
    const out = (await tools(svc, cwd)('kora_wait').handler({ paneId: r.paneId! })).text;
    const lines = out.split('\n');
    assert.match(lines[0], new RegExp(`^${pane.id}: idle$`));
    assert.match(lines[1], new RegExp(`^${pane.id}  idle  koragent  "kg one"  swarm=opencode/big-pickle task=${r.taskId} phase=done verify=passed\\(1 bounce\\)  worktree=`));
    assert.equal(lines[2], 'verify: passed after 1 bounce — merge gate clean after 1 bounce');
    assert.match(lines[3], new RegExp(`^--- report ${r.taskId} \\(${r.reportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, \\d+\\.\\d KB, written \\d+s ago\\) ---$`));
    assert.equal(lines[4], '## Status');

    // outcomes.jsonl carries the backend
    const rows = fs.readFileSync(path.join(home, 'swarm', 'outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((x) => x.taskId === r.taskId)!;
    assert.equal(row.backend, 'koragent');
    assert.equal(row.status, 'done');
  } finally { h.runtime.killPane(pane.id); }
});

test('a leader\'s kora_prompt reaches a koragent pane as a leader steer (not keystrokes)', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'Wait for me [fake:wait-steer]', title: 'kg steer', runtimeMode: 'full-access' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    assert.ok(await until(() => pane.swarm?.phase === 'running' && typeof pane.steerSink === 'function'));
    const res = await tools(svc, cwd)('kora_prompt').handler({ paneId: r.paneId!, text: 'also update the README', waitIdle: false });
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, new RegExp(`^delivered to ${pane.id}`));
    assert.ok(await until(() => pane.swarm?.phase === 'done'));
    assert.match(fs.readFileSync(r.reportPath, 'utf8'), /steer: also update the README \(leader, steer\)/);
    assert.equal(pane.read('screen').includes('also update the README'), false, 'nothing typed into the PTY');
  } finally { h.runtime.killPane(pane.id); }
});

test('route.failover: the model cools and the task moves on in the SAME pane (no kill, no respawn)', winSkip, async () => {
  const { svc, health } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'Do it [fake:failover]', title: 'kg failover', runtimeMode: 'full-access' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    assert.ok(await until(() => pane.swarm?.phase === 'done'), `phase ${pane.swarm?.phase}`);
    assert.equal(svc.follow(r.paneId!), r.paneId!, 'no alias: same pane');
    assert.equal(h.runtime.panes.get(r.paneId!), pane);
    assert.equal(pane.swarm!.model, 'openrouter/qwen/qwen3-coder:free');
    assert.equal(pane.swarm!.provider, 'openrouter');
    assert.deepEqual(pane.swarm!.attempts.map((a: any) => [a.paneId!, a.model, a.outcome]), [
      [pane.id, 'opencode/big-pickle', 'rate-limited'], [pane.id, 'openrouter/qwen/qwen3-coder:free', 'ok'],
    ]);
    assert.equal(health.isAvailable('opencode/big-pickle'), false, 'cooling');
    assert.ok(health.cooling()[0].until >= Date.now() + 14 * 60_000, 'the Zen floor, not the 30 s retry hint');
    const ev = notes.find((n) => n.method === 'swarm.worker' && n.params.event.kind === 'failover' && n.params.event.paneId! === pane.id)!.params.event;
    assert.deepEqual([ev.newPaneId, ev.fromModel, ev.toModel], [pane.id, 'opencode/big-pickle', 'openrouter/qwen/qwen3-coder:free']);
    assert.match(svc.note(r.paneId!)!, /moved from opencode\/big-pickle to openrouter\/qwen\/qwen3-coder:free .* same pane, same worktree/);
    // the second model's provider key was in the spawn env (the route's keys only)
    const spec: TaskSpec = JSON.parse(fs.readFileSync(pane.args[1], 'utf8'));
    assert.equal(spec.route.length, 2);
  } finally { h.runtime.killPane(pane.id); }
});

test('blocked on a permission: the pane is blocked (kora_wait returns), permission.reply unblocks it', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'Clean up [fake:blocked]', title: 'kg blocked', runtimeMode: 'approval-required' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    const out = (await tools(svc, cwd)('kora_wait').handler({ paneId: r.paneId!, timeoutMs: 15_000 })).text;
    assert.match(out.split('\n')[0], new RegExp(`^${pane.id}: blocked \\(permission: bash (— )?rm -rf build\\)$`));
    assert.equal(pane.state, 'blocked');
    (pane as any).koragent.send({ type: 'permission.reply', id: 'perm_1', allow: true });
    assert.ok(await until(() => pane.swarm?.phase === 'done'));
    assert.equal(pane.state, 'idle');
    const spec: TaskSpec = JSON.parse(fs.readFileSync(pane.args[1], 'utf8'));
    assert.equal(spec.permission, 'supervised');
  } finally { h.runtime.killPane(pane.id); }
});

test('report fallbacks: rendered from the task.report event (no files), or from the JSON file (no event)', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const a = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'x [fake:nofiles]', title: 'kg nofiles' });
  const b = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'y [fake:json-only]', title: 'kg json' });
  const pa = h.runtime.panes.get(a.paneId!)!, pb = h.runtime.panes.get(b.paneId!)!;
  try {
    assert.ok(await until(() => pa.swarm?.phase === 'done' && pb.swarm?.phase === 'done'), `${pa.swarm?.phase} ${pb.swarm?.phase}`);
    assert.match(fs.readFileSync(a.reportPath, 'utf8'), /^## Status\ndone — round 1/);
    assert.ok(fs.existsSync(a.reportPath.replace(/\.md$/, '.json')), 'Kora wrote the JSON too');
    assert.match(fs.readFileSync(b.reportPath, 'utf8'), /^## Status\ndone — round 1[^\n]*\n\(models: /, 'rendered by Kora from the JSON');
  } finally { h.runtime.killPane(pa.id); h.runtime.killPane(pb.id); }
});

test('no report at done: a failed attempt, never a nudge', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'z [fake:noreport]', title: 'kg noreport' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    assert.ok(await until(() => pane.swarm?.phase === 'failed'));
    assert.match(svc.note(r.paneId!)!, /ended without a report/);
  } finally { h.runtime.killPane(pane.id); }
});

test('readiness: swarm.workerBackend=koragent needs Koragent (not OpenCode); kora swarm status says so', winSkip, async () => {
  const cfgFile = path.join(home, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ swarm: { workerBackend: 'koragent', consent: { noticeVersion: 99, acceptedAt: 1 } } }));
  invalidateConfig();
  try {
    const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kg-h-')), 'h.json'));
    const mk = (found: string | null) => new SwarmSetup({ health, resolveOpencode: async () => ({ path: null, source: null }), resolveKoragent: () => ({ path: found, source: found ? 'env' : null }), koragentVersion: async () => '1.18.32', koragentPin: async () => null, catalog: () => MODELS });
    const missing = await mk(null).getStatus();
    assert.deepEqual(missing.blockers.map((b) => b.code).filter((c) => c.endsWith('-missing') && c !== 'consent-missing'), ['koragent-missing']);
    assert.match(missing.blockers.find((b) => b.code === 'koragent-missing')!.message, /Koragent is not installed .*KORAGENT_BIN.*~\/\.koragent\/bin\/koragent/);
    assert.deepEqual({ ...missing.workerBackend, minVersion: undefined }, { id: 'koragent', installed: false, path: null, source: null, minVersion: undefined, version: null, versionOk: false, pinned: null, pinOk: null });
    const found = await mk('/x/koragent').getStatus();
    assert.equal(found.blockers.some((b) => b.code === 'koragent-missing' || b.code === 'opencode-missing'), false);
    assert.deepEqual({ ...found.workerBackend, minVersion: undefined }, { id: 'koragent', installed: true, path: '/x/koragent', source: 'env', minVersion: undefined, version: '1.18.32', versionOk: true, pinned: null, pinOk: null });
  } finally { fs.rmSync(cfgFile, { force: true }); invalidateConfig(); }
  // the default backend's status is unchanged (no workerBackend field)
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kg-h-')), 'h.json'));
  const st = await new SwarmSetup({ health, resolveOpencode: async () => ({ path: null, source: null }), catalog: () => MODELS }).getStatus();
  assert.equal('workerBackend' in st, false);
  assert.ok(st.blockers.some((b) => b.code === 'opencode-missing'));
});

test('watchdog on a stalled koragent worker: an in-session kora steer + model.reject first (same pane), never a kill', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: 'Take your time [fake:wait-steer]', title: 'kg stall', runtimeMode: 'full-access' });
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    assert.ok(await until(() => pane.swarm?.phase === 'running' && typeof pane.steerSink === 'function'));
    const sent: any[] = [];
    const client = (pane as any).koragent; const orig = client.send.bind(client);
    client.send = (m: any) => { sent.push(m); return orig(m); };
    svc.tickWatchdog(Date.now() + 16 * 60_000); // past T2 (15 min) with no recent progress
    assert.ok(await until(() => pane.swarm?.phase === 'done'), `phase ${pane.swarm?.phase}`);
    const steer = sent.find((m) => m.type === 'steer');
    assert.equal(steer.source, 'kora'); assert.equal(steer.delivery, 'steer');
    assert.match(steer.text, /call task_report now/);
    assert.deepEqual(sent.filter((m) => m.type === 'model.reject').map((m) => m.model), ['opencode/big-pickle']);
    assert.match(fs.readFileSync(r.reportPath, 'utf8'), /steer: Kora: this task has run \d+ min[\s\S]*?\(kora, steer\)/);
    assert.equal(h.runtime.panes.get(r.paneId!), pane, 'same pane: no kill, no respawn');
    assert.equal(svc.follow(r.paneId!), r.paneId!);
  } finally { h.runtime.killPane(pane.id); }
});

test('main-checkout paths in the goal and the check point at the worktree (found live: a `cd <main> && …` check sent workers into the main checkout)', winSkip, async () => {
  const { svc } = service();
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'chat:kg', cwd, task: `In repo ${cwd}, add b.ts next to ${cwd}/a.ts`, title: 'kg paths', runtimeMode: 'full-access', check: `cd ${cwd} && test -f a.ts` } as any);
  const pane = h.runtime.panes.get(r.paneId!)!;
  try {
    const spec: TaskSpec = JSON.parse(fs.readFileSync(pane.args[1], 'utf8'));
    // Every form of both paths (as given, symlink-resolved) becomes the worktree's canonical path: a worktree file
    // named /var/… instead of /private/var/… was denied by Koragent as an external directory (e2e kg2).
    const wt = fs.realpathSync(pane.worktree!.path);
    assert.ok(spec.goal.startsWith(`In repo ${wt}, add b.ts next to ${wt}/a.ts\n`), spec.goal);
    assert.ok(String(spec.acceptance.check).endsWith(` -- 'cd ${wt} && test -f a.ts'`), spec.acceptance.check); // baseline-wrapped
    assert.equal(spec.worktree.mainRoot, fs.realpathSync(pane.worktree!.mainRoot), 'the spec still names the main checkout as mainRoot');
    const { inWorktreeText } = require('./swarm') as typeof import('./swarm');
    const real = fs.realpathSync(cwd);
    assert.equal(inWorktreeText(`${real}/x and ${cwd}/y and ${pane.worktree!.path}/z`, pane.worktree!, { canonical: true }), `${wt}/x and ${wt}/y and ${wt}/z`);
    assert.equal(inWorktreeText('/a/repo/f', { path: '/a/repo/.wt/w1', mainRoot: '/a/repo' }, { canonical: true }), '/a/repo/.wt/w1/f');
    assert.equal(inWorktreeText('/a/repo/.wt/w1/f', { path: '/a/repo/.wt/w1', mainRoot: '/a/repo' }, { canonical: true }), '/a/repo/.wt/w1/f', 'a nested worktree is not rewritten twice');
  } finally { h.runtime.killPane(pane.id); }
});

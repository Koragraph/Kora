// The swarm spawn path through the REAL Runtime with a FakeOpencode (a /bin/sh script printing a scripted screen):
// agent.spawn's `command` / `env` / `reuseWorktree` / `skipWorkerPermission`, swarm spawns always in their own
// worktree (never the user's checkout), a failover reusing it, Runtime.report preferring the report file, and
// PaneInfo.swarm serialized. No real opencode is installed or started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SwarmModelInfo } from '../protocol/types';
import { SwarmService } from './swarm';
import { SwarmHealth } from './swarm-health';

const home = process.env.KORA_HOME!;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
const fakeOpencode = path.join(bin, 'fake-opencode');
fs.writeFileSync(fakeOpencode, '#!/bin/sh\nprintf "opencode %s\\n" "$1 $2"\nprintf "report=%s\\n" "$KORA_REPORT"\nprintf "leak=[%s%s]\\n" "$GITHUB_TOKEN" "$ANTHROPIC_API_KEY"\nprintf "Ask anything\\n"\nsleep 30\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fake claude %s\\n" "$*"; sleep 30\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

function git(cwd: string, ...args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-real-'));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
// 20 s: a real pty + shell under the monorepo-wide parallel test run can take several seconds to print.
const until = async (f: () => boolean, ms = 20_000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return f(); };

const MODELS: SwarmModelInfo[] = [
  { id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: 2 },
  { id: 'opencode/grok-code', provider: 'zen', label: 'grok-code', rank: 1, maxConcurrent: 2 },
];

test('swarm spawn on the real Runtime: own worktree, fake opencode argv/env, report file wins, failover reuses the worktree', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false });
  try {
    const cwd = repo();
    const health = new SwarmHealth(path.join(home, 'h.json'));
    const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS.filter((m) => health.isAvailable(m.id)) };
    const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
      threadMode: () => 'swarm', opencodePath: () => fakeOpencode, apiKey: () => null,
      paneEnv: (meta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId }),
      preamble: ({ reportPath }) => `report to ${reportPath}`,
      contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 60_000,
      verifyGate: async () => [],
    } });
    // The daemon's own env holds the user's credentials; a third-party-model worker must not see them.
    process.env.GITHUB_TOKEN = 'ghp_fakefakefake'; process.env.ANTHROPIC_API_KEY = 'sk-ant-fakefake';
    const r = await svc.spawn({ orchestratorId: 'chat:t1', cwd, task: 'do it', title: 'first' });
    const pane = h.runtime.panes.get(r.paneId!)!;
    assert.ok(pane.worktree, 'the FIRST swarm worker gets its own worktree');
    assert.notEqual(fs.realpathSync(pane.worktree!.path), fs.realpathSync(cwd));
    assert.equal(pane.command, fakeOpencode, 'params.command overrides agentCommand');
    assert.equal(pane.role, 'worker');
    assert.equal(pane.orchestratorId, 'chat:t1');
    assert.equal(pane.args[0], '-m');
    assert.ok(pane.args.includes('--prompt'));
    assert.equal(r.reportPath, path.join(pane.worktree!.path, '.kora', 'swarm', `${r.taskId}.md`));
    // Line breaks removed: a long (Windows temp) path wraps at the pane's 80 columns.
    const flat = () => pane.read('screen').replace(/\r?\n/g, '');
    assert.ok(await until(() => flat().includes(`report=${r.reportPath}`)), `params.env reached the pane:\n${pane.read('screen')}`);
    assert.ok(pane.read('screen').includes('leak=[]'), `the worker inherited a credential: ${pane.read('screen')}`);
    delete process.env.GITHUB_TOKEN; delete process.env.ANTHROPIC_API_KEY;
    assert.equal(h.runtime.panes.get(r.paneId!)!.info().swarm!.taskId, r.taskId, 'PaneInfo.swarm serialized');
    assert.equal(pane.info().swarm!.reportPath, r.reportPath);
    // the report file wins over the (absent) transcript
    assert.equal(h.runtime.report(r.paneId!), '');
    fs.writeFileSync(r.reportPath, '## Done\nfacts');
    assert.equal(h.runtime.report(r.paneId!), '## Done\nfacts');
    // the report dir is a managed path: never the worker's dirty file
    const { worktreeStatus } = require('./worktree');
    assert.equal(worktreeStatus(pane.worktree!.path).dirty, 0);
    fs.rmSync(r.reportPath);
    // failover → the replacement runs in the SAME worktree (no new one)
    const before = fs.readdirSync(path.join(home, 'wt', path.basename(fs.realpathSync(cwd)))).length;
    await svc.failover(r.taskId, 'rate-limited');
    const next = svc.follow(r.paneId!);
    assert.notEqual(next, r.paneId!, `no replacement: ${svc.note(r.paneId!)} / ${JSON.stringify(svc.taskForPane(r.paneId!))}`);
    const p2 = h.runtime.panes.get(next)!;
    assert.equal(p2.worktree!.path, pane.worktree!.path);
    assert.equal(fs.readdirSync(path.join(home, 'wt', path.basename(fs.realpathSync(cwd)))).length, before, 'no new worktree');
    assert.equal(h.runtime.panes.has(r.paneId!), false, 'old pane stopped before the respawn');
    assert.equal(p2.swarm!.model, 'opencode/grok-code');
  } finally { await h.close(); }
});

test('agent.spawn skipWorkerPermission: no skip-permissions argv even under workerPermission=auto', async () => {
  process.env.KORA_WORKER_PERMISSION = 'auto';
  await new Promise((r) => setTimeout(r, 2100)); // loadConfig caches for 2 s
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH + '2', restore: false });
  try {
    const cwd = repo();
    const a = await h.runtime.agentSpawn({ agent: 'claude', cwd, orchestratorId: 'chat:x', worktree: false });
    // A chat lead's worker may launch as a GUI worker box (DriverPane, no argv): its permission is its runtimeMode.
    const skips = (p: any) => (p.runtimeMode !== undefined ? p.runtimeMode === 'full-access' : p.args.includes('--dangerously-skip-permissions'));
    const pa: any = h.runtime.panes.get(a.id)!;
    assert.ok(skips(pa), `${pa.command} ${JSON.stringify(pa.args)} runtimeMode=${pa.runtimeMode} workerPermission=${require('../config').loadConfig().workerPermission}`);
    const b = await h.runtime.agentSpawn({ agent: 'claude', cwd, orchestratorId: 'chat:x', worktree: false, skipWorkerPermission: true });
    assert.ok(!skips(h.runtime.panes.get(b.id)!));
  } finally { delete process.env.KORA_WORKER_PERMISSION; await h.close(); }
});

// Swarm QA 2026-10-02: every merged swarm worker of the day was still running (an idle OpenCode holds ~800 MB).
test('a merged, finished swarm worker is closed (retired); its worktree and branch stay', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH + '3', restore: false });
  try {
    const cwd = repo();
    const health = new SwarmHealth(path.join(home, 'h3.json'));
    const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS };
    const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
      threadMode: () => 'swarm', opencodePath: () => fakeOpencode, apiKey: () => null,
      paneEnv: (meta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId }),
      preamble: ({ reportPath }) => `report to ${reportPath}`,
      contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 60_000,
      verifyGate: async () => [],
    } });
    const r = await svc.spawn({ orchestratorId: 'chat:t9', cwd, task: 'do it', title: 'merge me' });
    const pane = h.runtime.panes.get(r.paneId!)!;
    const wt = pane.worktree!.path;
    fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2;\n');
    fs.mkdirSync(path.dirname(r.reportPath), { recursive: true }); fs.writeFileSync(r.reportPath, '## Done\nb.ts');
    const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(r.paneId!));
    (svc as any).setPhase(t, pane, 'done');
    // B2 (night 2026-10-04): Kora's merge runs git with hooks off, so the index stayed "Out of date" (amber) after a
    // successful merge until the next message. It now catches up at once.
    const ingests: string[] = [];
    const realGraph = h.runtime.graph;
    // Two doors catch a stale index up and share one "indexed at this HEAD" record: the merge's (graph.ingest) and a
    // pane update's (refreshGraphInfo → ingestWithProgress). Under a loaded run a pane update can land first; either
    // door counts, and the shared record keeps it to one index.
    (h.runtime as any).graph = { ...realGraph, status: async () => ({ indexed: true, stale: true, repoRoot: pane.worktree!.mainRoot, headSha: 'new', indexedSha: 'old' }), ingest: async (root: string) => { ingests.push(root); return { ok: true }; }, ingestWithProgress: async (root: string) => { ingests.push(root); return { ok: true, nodes: 0, edges: 0, ms: 0 }; } };
    const prevAuto = process.env.KORA_AUTO_INGEST; delete process.env.KORA_AUTO_INGEST;
    const m = await h.runtime.worktreeMerge({ paneId: r.paneId!, commitFirst: true });
    assert.equal(m.ok, true, m.message);
    assert.ok(await until(() => ingests.length > 0, 60_000), 'the merge starts the index catch-up');
    assert.equal(ingests[0], pane.worktree!.mainRoot);
    (h.runtime as any).graph = realGraph; if (prevAuto !== undefined) process.env.KORA_AUTO_INGEST = prevAuto;
    assert.equal(fs.readFileSync(path.join(cwd, 'b.ts'), 'utf8'), 'export const b = 2;\n', 'merged into the checkout');
    assert.equal(pane.retired, true);
    assert.ok(await until(() => pane.exited), 'the worker process was closed');
    assert.ok(fs.existsSync(wt), 'the worktree is kept');
  } finally { await h.close(); }
});

// Swarm QA 2026-10-02 #4: kora_merge aborted on a conflict, the lead merged the branch with raw git, and the Workers
// panel kept "Passed / NOT merged" (and the idle worker kept its ~800 MB). The status poll now sees the commits land.
test('a branch merged by hand (outside kora_merge) is recorded as merged and its finished worker is closed', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH + '4', restore: false });
  try {
    const cwd = repo();
    const health = new SwarmHealth(path.join(home, 'h4.json'));
    const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS };
    const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
      threadMode: () => 'swarm', opencodePath: () => fakeOpencode, apiKey: () => null,
      paneEnv: (meta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId }),
      preamble: ({ reportPath }) => `report to ${reportPath}`,
      contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 60_000,
      verifyGate: async () => [],
    } });
    const r = await svc.spawn({ orchestratorId: 'chat:t4', cwd, task: 'do it', title: 'merge me by hand' });
    const pane = h.runtime.panes.get(r.paneId!)!;
    const wt = pane.worktree!.path;
    fs.writeFileSync(path.join(wt, 'c.ts'), 'export const c = 3;\n'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'c');
    h.runtime.refreshWorktreeStatus();
    assert.ok(await until(() => (pane.worktree?.ahead ?? 0) > 0), 'the poll saw the worker commit');
    const t = [...(svc as any).registry().values()].find((x: any) => x.record.paneIds.includes(r.paneId!));
    (svc as any).setPhase(t, pane, 'done');
    assert.equal(pane.branchMerged, false);
    git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge by hand', pane.worktree!.branch);
    h.runtime.refreshWorktreeStatus();
    assert.ok(await until(() => pane.branchMerged), 'the hand merge was noticed');
    const ev = h.runtime.fleetGet('chat:t4').events.find((e: any) => e.kind === 'merged' && e.workerId === pane.id);
    assert.ok(ev && /^\S+: merged\b/.test(ev.text), `a "merged" fleet event the Workers panel reads (${ev?.text})`);
    assert.equal(pane.retired, true);
    assert.ok(await until(() => pane.exited), 'the finished worker was closed like after kora_merge');
  } finally { await h.close(); }
});

test('landedOutsideMerge: only a worker that had commits ahead, now none, clean, not already merged', () => {
  const { landedOutsideMerge } = require('./workspace');
  const p = (ahead: number, branchMerged = false) => ({ branchMerged, worktree: { ahead } });
  assert.equal(landedOutsideMerge(p(2), { dirty: 0, ahead: 0 }), true);
  assert.equal(landedOutsideMerge(p(0), { dirty: 0, ahead: 0 }), false, 'never committed');
  assert.equal(landedOutsideMerge(p(2), { dirty: 1, ahead: 0 }), false, 'reset with work left in the tree');
  assert.equal(landedOutsideMerge(p(2, true), { dirty: 0, ahead: 0 }), false, 'kora_merge already recorded it');
  assert.equal(landedOutsideMerge({ branchMerged: false, worktree: null }, { dirty: 0, ahead: 0 }), false);
});

// Found under the parallel run: the merge runs for seconds in a child, and a finished worker's pane that was reaped
// meanwhile made worktreeMerge skip the index catch-up (it read the pane only after the merge).
test('a worker pane reaped while its merge runs still gets the index catch-up', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH + '5', restore: false });
  const wtMod = require('./worktree');
  const realInChild = wtMod.worktreeInChild;
  try {
    const cwd = repo();
    const health = new SwarmHealth(path.join(home, 'h5.json'));
    const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS };
    const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
      threadMode: () => 'swarm', opencodePath: () => fakeOpencode, apiKey: () => null,
      paneEnv: (meta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId }),
      preamble: ({ reportPath }) => `report to ${reportPath}`,
      contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 60_000,
      verifyGate: async () => [],
    } });
    const r = await svc.spawn({ orchestratorId: 'chat:t5', cwd, task: 'do it', title: 'reaped mid-merge' });
    const pane = h.runtime.panes.get(r.paneId!)!;
    const mainRoot = pane.worktree!.mainRoot;
    fs.writeFileSync(path.join(pane.worktree!.path, 'd.ts'), 'export const d = 4;\n');
    const ingests: string[] = [];
    const realGraph = h.runtime.graph;
    (h.runtime as any).graph = { ...realGraph, status: async () => ({ indexed: true, stale: true, repoRoot: mainRoot, headSha: 'new', indexedSha: 'old' }), ingest: async (root: string) => { ingests.push(root); return { ok: true }; }, ingestWithProgress: async (root: string) => { ingests.push(root); return { ok: true, nodes: 0, edges: 0, ms: 0 }; } };
    const prevAuto = process.env.KORA_AUTO_INGEST; delete process.env.KORA_AUTO_INGEST;
    // The merge child is running when the pane goes away.
    wtMod.worktreeInChild = async (...args: unknown[]) => { h.runtime.panes.delete(r.paneId!); return realInChild(...args); };
    try {
      const m = await h.runtime.worktreeMerge({ paneId: r.paneId!, commitFirst: true });
      assert.equal(m.ok, true, m.message);
      assert.equal(h.runtime.panes.has(r.paneId!), false, 'the pane was gone after the merge');
      assert.ok(await until(() => ingests.length > 0, 5_000), 'the merge still starts the index catch-up');
      assert.equal(ingests[0], mainRoot);
    } finally { (h.runtime as any).graph = realGraph; if (prevAuto !== undefined) process.env.KORA_AUTO_INGEST = prevAuto; pane.kill('SIGKILL'); }
  } finally { wtMod.worktreeInChild = realInChild; await h.close(); }
});

// The interleaving the loaded full run hit, forced: a pane update catches the index up first, then the merge lands on the
// same HEAD. Exactly one index, never two.
test('a pane update and a merge on the same HEAD index the checkout once between them', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH + '6', restore: false });
  try {
    const cwd = repo();
    const health = new SwarmHealth(path.join(home, 'h6.json'));
    const setup: any = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS };
    const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
      threadMode: () => 'swarm', opencodePath: () => fakeOpencode, apiKey: () => null,
      paneEnv: (meta) => ({ KORA_REPORT: meta.reportPath, KORA_SWARM_TASK_ID: meta.taskId }),
      preamble: ({ reportPath }) => `report to ${reportPath}`,
      contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 60_000,
      verifyGate: async () => [],
    } });
    const r = await svc.spawn({ orchestratorId: 'chat:t6', cwd, task: 'do it', title: 'two doors' });
    const pane = h.runtime.panes.get(r.paneId!)!;
    const mainRoot = pane.worktree!.mainRoot;
    fs.writeFileSync(path.join(pane.worktree!.path, 'e.ts'), 'export const e = 5;\n');
    const ingests: string[] = [];
    const realGraph = h.runtime.graph;
    (h.runtime as any).graph = { ...realGraph, status: async () => ({ indexed: true, stale: true, repoRoot: mainRoot, headSha: 'new', indexedSha: 'old' }), ingest: async (root: string) => { ingests.push(`merge:${root}`); return { ok: true }; }, ingestWithProgress: async (root: string) => { ingests.push(`pane:${root}`); return { ok: true, nodes: 0, edges: 0, ms: 0 }; } };
    const prevAuto = process.env.KORA_AUTO_INGEST; delete process.env.KORA_AUTO_INGEST;
    try {
      await (h.runtime as any).refreshGraphInfo(pane, mainRoot);
      assert.ok(await until(() => ingests.length > 0, 5_000), 'the pane update caught the index up');
      const m = await h.runtime.worktreeMerge({ paneId: r.paneId!, commitFirst: true });
      assert.equal(m.ok, true, m.message);
      await new Promise((res) => setTimeout(res, 300));
      assert.deepEqual(ingests, [`pane:${mainRoot}`], 'one index for one HEAD');
    } finally { (h.runtime as any).graph = realGraph; if (prevAuto !== undefined) process.env.KORA_AUTO_INGEST = prevAuto; pane.kill('SIGKILL'); }
  } finally { await h.close(); }
});

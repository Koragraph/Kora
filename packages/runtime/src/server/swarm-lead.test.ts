// Swarm workers for an orchestrator hosted outside the runtime (a Koragent lead pane through `kora mcp --fleet`):
//   - the guard: isSwarmThread accepts a live orchestrator pane (promoted, or a Koragent pane that is not a worker)
//   - the socket RPCs `swarm.spawn` / `swarm.task` on a real daemon (guard enforced, unknown panes answered)
//   - the remote bridge: makeRemoteFleet's SwarmSpawner + fleetToolSpecs(agentMode swarm) against a fake runtime
//     socket — kora_spawn agent:"swarm" tasks:[…] and kora_wait with the report, exactly what a Koragent lead calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { koraHome, type SwarmModelInfo, type SwarmStatus } from '../protocol/types';
import { readControlToken } from './control-auth';
import { SwarmService, SWARM_THREAD_REQUIRED } from './swarm';
import { SwarmHealth } from './swarm-health';
import { makeRemoteFleet } from './fleet-ops';
import { fleetToolSpecs } from '../session/fleet-tools';
import { createServer, type ServerHandle } from './daemon';
import { KoraClient } from '../protocol/client';
import { ipcAddress } from '../util/ipc-path';

process.env.KORA_WORKTREES = path.join(process.env.KORA_HOME || os.tmpdir(), 'wt-lead');

class Pane extends EventEmitter {
  swarm: any = null; exited = false; state = 'idle'; blocker: string | null = null; promptPending = false; screen = '';
  constructor(public id: string, public agent: string, public role: 'orchestrator' | 'worker' | null, public orchestratorId: string | null = null, public workspaceId = 'w1', public worktree: any = null, public args: string[] = [], public env: Record<string, string> = {}) { super(); }
  info() { return { id: this.id, swarm: this.swarm } as any; }
  read() { return this.screen; }
  kill() { this.exited = true; }
}

const MODELS: SwarmModelInfo[] = [{ id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 0, maxConcurrent: null }];
function ready(): SwarmStatus {
  return JSON.parse(JSON.stringify({
    ready: true, blockers: [], opencode: { installed: true, path: '/x', source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: true },
    install: { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null },
    consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1 }, providers: [], models: { available: MODELS, cooling: [] },
    preferences: { providerOrder: ['zen'], defaultModel: null, maxWorkers: 4 }, keyStorage: 'file', checkedAt: 1,
  }));
}

function service() {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lead-home-'));
  let n = 10;
  const rt: any = new EventEmitter();
  rt.panes = new Map<string, Pane>();
  rt.spawns = [] as any[];
  rt.notify = () => {};
  rt.agentSpawn = async (p: any) => { rt.spawns.push(p); const id = `p${n++}`; rt.panes.set(id, new Pane(id, p.agent, 'worker', p.orchestratorId, p.workspaceId ?? 'w0', p.reuseWorktree ?? null, p.args, p.env)); return { id }; };
  rt.listPanes = () => [...rt.panes.values()].map((p: Pane) => p.info());
  rt.killPane = (id: string) => rt.panes.delete(id);
  rt.prompt = async () => ({ ok: true, state: 'working' });
  rt.graph = { callTool: async () => ({ text: '', data: null, ms: 0 }) };
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lead-h-')), 'health.json'));
  const setup: any = { getStatus: async () => ready(), pickableModels: () => MODELS };
  const svc = new SwarmService({ runtime: rt, setup, health, io: {
    threadMode: () => null, apiKey: () => null, opencodePath: () => '/fake/opencode',
    paneEnv: () => ({}), preamble: () => 'REPORT', permissionArgs: () => [], contextPacket: async () => ({ text: '', files: [] }),
    overlap: () => [], changedFiles: async () => [], verifyGate: async () => [],
    config: () => ({ autoVerify: false, maxBounces: 0, maxWorkers: 4 }), nudgeMs: 0, screenPollMs: 0, watchdogTickMs: 0,
  } as any });
  return { svc, rt };
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lead-repo-'));
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

test('isSwarmThread: a live orchestrator pane or a Koragent lead pane qualifies; workers, swarm panes, exited and unknown ids do not', () => {
  const { svc, rt } = service();
  rt.panes.set('p1', new Pane('p1', 'koragent', null));
  rt.panes.set('p2', new Pane('p2', 'claude', 'orchestrator'));
  rt.panes.set('p3', new Pane('p3', 'koragent', 'worker', 'p1'));
  rt.panes.set('p4', new Pane('p4', 'claude', null));
  const swarmPane = new Pane('p5', 'koragent', null); swarmPane.swarm = { taskId: 's1' }; rt.panes.set('p5', swarmPane);
  const dead = new Pane('p6', 'koragent', null); dead.exited = true; rt.panes.set('p6', dead);
  assert.equal(svc.isSwarmThread('p1'), true, 'a Koragent lead pane');
  assert.equal(svc.isSwarmThread('p2'), true, 'a promoted orchestrator pane');
  assert.equal(svc.isSwarmThread('p3'), false, 'a worker');
  assert.equal(svc.isSwarmThread('p4'), false, 'a plain claude pane');
  assert.equal(svc.isSwarmThread('p5'), false, 'a swarm worker pane');
  assert.equal(svc.isSwarmThread('p6'), false, 'exited');
  assert.equal(svc.isSwarmThread('p99'), false, 'unknown');
  assert.equal(svc.isSwarmThread('chat:p1'), false, 'a chat id is never a pane');
});

test('spawn from a Koragent lead pane: allowed, worker placed in the lead\'s workspace; a plain pane is refused', async () => {
  const { svc, rt } = service();
  rt.panes.set('p1', new Pane('p1', 'koragent', null, null, 'wsLead'));
  rt.panes.set('p2', new Pane('p2', 'claude', null));
  const cwd = repo();
  const r = await svc.spawn({ orchestratorId: 'p1', cwd, task: 'fix a', check: 'true' });
  assert.equal(rt.spawns[0].orchestratorId, 'p1');
  assert.equal(rt.spawns[0].workspaceId, 'wsLead');
  assert.equal(svc.taskForPane(r.paneId!)?.orchestratorId, 'p1');
  await assert.rejects(svc.spawn({ orchestratorId: 'p2', cwd, task: 't' }), (e: any) => e.message.startsWith(SWARM_THREAD_REQUIRED));
});

// ── the daemon's socket surface ─────────────────────────────────────────────────────────────────────────────

test('daemon: swarm.spawn enforces the guard; swarm.task answers an unknown pane', async () => {
  let handle: ServerHandle | undefined; let client: KoraClient | undefined;
  try {
    handle = await createServer({ socketPath: process.env.KORA_SOCKET_PATH!, restore: false, sweep: false });
    client = new KoraClient(process.env.KORA_SOCKET_PATH!); client.control = readControlToken(koraHome()) ?? undefined; await client.connect();
    await assert.rejects(client.call('swarm.spawn', { orchestratorId: 'p404', cwd: os.tmpdir(), task: 't' }), (e: any) => String(e.message).includes(SWARM_THREAD_REQUIRED));
    const t = await client.call('swarm.task', { paneId: 'p404' });
    assert.deepEqual(t, { task: null, note: null, lostInRestart: false, report: null });
  } finally { client?.close(); await handle?.close().catch(() => {}); }
});

// ── the remote bridge a Koragent lead mounts ────────────────────────────────────────────────────────────────

/** A fake runtime socket: answers the JSON-RPC methods the remote fleet calls; records every call. */
async function fakeRuntimeSocket(handlers: Record<string, (p: any) => unknown>) {
  const sock = path.join(fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'kl-')), 'k.sock');
  const calls: { method: string; params: any }[] = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', async (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        calls.push({ method: msg.method, params: msg.params });
        const h = handlers[msg.method];
        try {
          if (!h) throw new Error(`unexpected ${msg.method}`);
          c.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: await h(msg.params) }) + '\n');
        } catch (e: any) { c.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } }) + '\n'); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(ipcAddress(sock), r));
  return { sock, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('remote bridge: kora_spawn agent:"swarm" tasks:[…] goes through swarm.spawn; kora_wait returns the swarm report', async () => {
  const report = '## Status\ndone\n## Changes\nsrc/a.ts\n## Check\nexit 0\n## Findings\n-\n## Blockers\n-';
  let spawned = 0;
  const worker = (id: string, task: string) => ({ id, name: id, agent: 'koragent', state: 'idle', blocker: null, exited: false, exitCode: null, cwd: '/wt', worktree: { path: `/wt/${id}`, branch: `b-${id}`, mainRoot: '/r' }, createdAt: 1, lastOutputAt: Date.now(), orchestratorId: 'p1',
    swarm: { taskId: task, model: 'opencode/big-pickle', provider: 'zen', phase: 'done', attempt: 1, attempts: [], previousPaneIds: [], reportPath: `/wt/${id}/.kora/swarm/${task}.md`, report: null, supersededBy: null, verify: { state: 'passed', bounces: 0 } } });
  const fake = await fakeRuntimeSocket({
    'swarm.spawn': (p) => { spawned++; return { paneId: `p${10 + spawned}`, taskId: `s${spawned}`, provider: 'zen', model: 'opencode/big-pickle', modelLabel: 'big-pickle', reportPath: `/wt/p${10 + spawned}/.kora/swarm/s${spawned}.md`, overlaps: [], foreman: { check: p.check ?? null, maxAttempts: 2, review: false, checkRefused: null } }; },
    'pane.list': () => ({ panes: [worker('p11', 's1'), worker('p12', 's2')] }),
    'pane.get': (p) => ({ ...worker(p.paneId!, 's1'), exited: false }),
    'agent.wait': () => ({ state: 'idle', blocker: null, timedOut: false }),
    'swarm.task': (p) => ({ task: { taskId: p.paneId! === 'p11' ? 's1' : 's2', orchestratorId: 'p1', paneIds: [p.paneId!], reportPath: '/x.md', status: 'done' }, note: null, lostInRestart: false, report: { text: report, truncated: false, updatedAt: Date.now() } }),
    'fleet.drainNotes': () => ({ notes: [] }),
  });
  const remote = makeRemoteFleet(fake.sock);
  try {
    const specs = fleetToolSpecs({ fleet: remote.control, orchestratorId: 'p1', agent: 'koragent' as any, cwd: '/r', account: null, spawnWorker: remote.spawnWorker, agentMode: 'swarm', swarm: remote.swarm });
    const spawn = specs.find((s) => s.name === 'kora_spawn')!;
    assert.ok(spawn.params.tasks, 'swarm mode offers tasks:[…]');
    const r = await spawn.handler({ agent: 'swarm', tasks: [{ prompt: 'fix a', title: 'a', check: 'node --test a' }, { prompt: 'fix b', title: 'b', check: 'node --test b' }] });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /spawned swarm worker p11 \(task s1/);
    assert.match(r.text, /spawned swarm worker p12 \(task s2/);
    const sp = fake.calls.filter((c) => c.method === 'swarm.spawn');
    assert.deepEqual(sp.map((c) => [c.params.orchestratorId, c.params.check]), [['p1', 'node --test a'], ['p1', 'node --test b']]);
    assert.equal(remote.swarm.taskForPane('p11')?.taskId, 's1', 'spawn primes the cache');
    assert.deepEqual(remote.swarm.checksFor!('p1'), [{ taskId: 's2', check: 'node --test b' }, { taskId: 's1', check: 'node --test a' }], 'kora_verify over the bridge: checks recorded at spawn, newest first');
    assert.deepEqual(remote.swarm.checksFor!('p1', ['p11']), [{ taskId: 's1', check: 'node --test a' }], 'paneIds limits it');
    assert.deepEqual(remote.swarm.checksFor!('other'), [], 'another orchestrator\'s checks are not ours');
    const wait = await specs.find((s) => s.name === 'kora_wait')!.handler({ paneIds: ['p11', 'p12'], timeoutMs: 5000 });
    assert.equal(wait.isError, undefined, wait.text);
    assert.match(wait.text, /verify: passed/);
    assert.match(wait.text, /## Status\ndone/);
    assert.ok(fake.calls.some((c) => c.method === 'swarm.task'), 'the report comes over swarm.task');
  } finally { remote.close(); await fake.close(); }
});

test('remote bridge without --agent-mode swarm: agent:"swarm" is refused with the guard text', async () => {
  const remote = makeRemoteFleet('/nonexistent.sock');
  const specs = fleetToolSpecs({ fleet: remote.control, orchestratorId: 'chat:t', agent: 'codex' as any, cwd: '/r', account: null, spawnWorker: remote.spawnWorker, swarm: remote.swarm });
  const r = await specs.find((s) => s.name === 'kora_spawn')!.handler({ agent: 'swarm', prompt: 'x' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(SWARM_THREAD_REQUIRED));
  remote.close();
});

test('kora mcp --fleet --agent-mode swarm: parsed from argv, env fallback', () => {
  const { fleetBridgeOptions } = require('../cli/commands/mcp') as typeof import('../cli/commands/mcp');
  assert.equal(fleetBridgeOptions(['--fleet', '--orchestrator', 'p1', '--agent-mode', 'swarm'], {}).agentMode, 'swarm');
  assert.equal(fleetBridgeOptions(['--fleet'], { KORA_AGENT_MODE: 'swarm' }).agentMode, 'swarm');
  assert.equal(fleetBridgeOptions(['--fleet'], {}).agentMode, undefined);
});

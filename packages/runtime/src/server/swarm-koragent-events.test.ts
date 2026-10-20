// SwarmService's koragent event mapping with a fake runtime and a fake event client (no processes): budget.update
// feeds the watchdog instead of OpenCode's DB, route.failover never kills or spawns, a steer goes to the client, the
// opencode backend's spawn is untouched (argv/env/prompt hold), and a new task picks its backend from io.workerBackend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { SwarmModelInfo, SwarmWorkerMeta } from '../protocol/types';
import type { KoragentInbound } from '../protocol/koragent';
import { SwarmService } from './swarm';
import { SwarmHealth } from './swarm-health';
import { setEditionForTests } from '../edition';

// Koragent workers are Kora Pro: these tests exercise the Pro path.
setEditionForTests('pro');

process.env.KORA_WORKTREES = path.join(process.env.KORA_HOME || os.tmpdir(), 'wt');

const MODELS: SwarmModelInfo[] = [
  { id: 'openrouter/cheap/paid-model', provider: 'openrouter', label: 'paid', rank: 0, maxConcurrent: null },
  { id: 'openrouter/cheap/paid-model-2', provider: 'openrouter', label: 'paid2', rank: 0.5, maxConcurrent: null },
  { id: 'opencode/big-pickle', provider: 'zen', label: 'big-pickle', rank: 1, maxConcurrent: null },
];

class FakeClient extends EventEmitter {
  sent: KoragentInbound[] = []; connected = true; connects = 1; lastSeq = 0; started = false; closed = false;
  constructor(readonly socketPath: string) { super(); }
  start() { this.started = true; return this; }
  close() { this.closed = true; }
  send(m: KoragentInbound) { this.sent.push(m); if (m.type === 'steer') setImmediate(() => this.emit('event', { v: 1, seq: ++this.lastSeq, ts: Date.now(), type: 'steer.received', id: m.id, source: m.source, delivery: m.delivery, preview: m.text.slice(0, 20) })); }
  ev(e: Record<string, unknown>) { this.emit('event', { v: 1, seq: ++this.lastSeq, ts: Date.now(), ...e }); }
}

class FakePane extends EventEmitter {
  swarm: SwarmWorkerMeta | null = null; promptPending = false; exited = false; state = 'unknown'; blocker: string | null = null;
  eventDriven: boolean; eventSocketPath: string | null; steerSink: any = null; hints: string[] = [];
  constructor(public id: string, public orchestratorId: string, public worktree: any, public args: string[], public env: Record<string, string>, public agent: string, evented: boolean) {
    super(); this.eventDriven = evented; this.eventSocketPath = evented ? `/tmp/panes/${id}.sock` : null;
  }
  info() { return { id: this.id, swarm: this.swarm } as any; }
  read() { return ''; }
  hint(s: string, b: string | null = null) { this.hints.push(s); const prev = this.state; this.state = s; this.blocker = b; if (prev !== s) this.emit('state', s, b, prev); }
  kill() { if (this.exited) return; this.exited = true; setImmediate(() => this.emit('exit', 0)); }
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kge-'));
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}

function setup(backend: 'opencode' | 'koragent') {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kge-home-'));
  let n = 1;
  const rt: any = new EventEmitter();
  rt.panes = new Map(); rt.spawns = []; rt.prompts = []; rt.kills = []; rt.notes = [];
  rt.notify = (method: string, params: any) => rt.notes.push({ method, params });
  rt.agentSpawn = async (p: any) => { rt.spawns.push(p); const id = `p${n++}`; rt.panes.set(id, new FakePane(id, p.orchestratorId, p.reuseWorktree ?? null, p.args, p.env, p.agent, !!p.eventStream)); return { id }; };
  rt.killPane = (id: string) => { rt.kills.push(id); const p = rt.panes.get(id); rt.panes.delete(id); p?.kill(); };
  // Runtime.prompt's steer redirect, as workspace.ts does it
  rt.prompt = async (paneId: string, text: string, _submit = true, waitIdle = true, _t = 0, source = 'leader') => {
    rt.prompts.push({ paneId, text, source });
    const p = rt.panes.get(paneId);
    if (p?.steerSink) await p.steerSink(text, source, waitIdle ? 'queue' : 'steer');
    return { ok: true, state: 'working' };
  };
  rt.graph = { callTool: async () => ({ text: '', data: null, ms: 0 }) };
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-kge-h-')), 'h.json'));
  const clients: FakeClient[] = [];
  let activityCalls = 0;
  const svc = new SwarmService({ runtime: rt, setup: { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS.filter((m) => health.isAvailable(m.id)) } as any, health, io: {
    threadMode: () => 'swarm', workerBackend: () => backend, koragentPath: () => '/bin/koragent', opencodePath: () => '/bin/opencode',
    apiKey: () => 'k', random: () => 0.5, contextPacket: async () => ({ text: '', files: [] }), overlap: () => [], changedFiles: async () => [], verifyGate: async () => [],
    paneEnv: (meta: SwarmWorkerMeta) => ({ KORA_REPORT: meta.reportPath }), preamble: ({ reportPath }: { reportPath: string }) => `REPORT TO ${reportPath}`,
    permissionArgs: () => [], modelArgs: (m: string) => ['-m', m],
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, paidMaxTaskUsd: 0.05, watchdog: { nudgeAfterMs: 8 * 60_000, reassignAfterMs: 15 * 60_000 } }),
    nudgeMs: 30, screenPollMs: 5, watchdogTickMs: 0,
    activity: () => { activityCalls++; return new Map(); },
    koragentClient: (sock: string) => { const c = new FakeClient(sock); clients.push(c); return c as any; },
  } as any });
  return { svc, rt, health, clients, activity: () => activityCalls };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('koragent task: events drive the phase; budget.update feeds the watchdog (not the OpenCode DB); failover never kills/spawns; steers go to the stream', async () => {
  const { svc, rt, health, clients, activity } = setup('koragent');
  const r = await svc.spawn({ orchestratorId: 'chat:x', cwd: repo(), task: 'do it', runtimeMode: 'full-access' });
  const pane = rt.panes.get(r.paneId) as FakePane;
  assert.equal(rt.spawns[0].agent, 'koragent');
  assert.equal(rt.spawns[0].eventStream, true);
  assert.equal(rt.spawns[0].isolatedEnv, true);
  // A paid task's route stays paid (bench5x): the OpenRouter key only — no Zen key, no OPENCODE_* config.
  assert.deepEqual(Object.keys(rt.spawns[0].env).filter((k) => k.startsWith('OPENCODE_')), [], 'no OPENCODE_* config or Zen key on a paid route');
  assert.equal(clients.length, 1); assert.equal(clients[0].started, true);
  assert.equal(pane.promptPending, false);
  const c = clients[0];
  c.emit('connect');
  assert.equal(c.sent[0].type, 'catalog.update', 'cooldowns + pass rates on connect');
  c.ev({ type: 'session.state', state: 'starting' });
  c.ev({ type: 'session.state', state: 'ready' });
  assert.equal(pane.state, 'unknown', 'ready before the task starts is not idle');
  c.ev({ type: 'session.state', state: 'working' });
  assert.equal(pane.swarm!.phase, 'running');
  assert.equal(pane.state, 'working');
  // a Kora-originated message (watchdog budget stop) is a kora steer, never typed
  c.ev({ type: 'budget.update', tokens: { in: 1, out: 1, cacheRead: 0 }, usd: 0.2, steps: 3 });
  svc.tickWatchdog();
  await tick();
  assert.equal(activity(), 0, 'no OpenCode DB read for a koragent worker');
  const steer = c.sent.find((m) => m.type === 'steer') as Extract<KoragentInbound, { type: 'steer' }>;
  assert.ok(steer, `no steer sent: ${JSON.stringify(c.sent)}`);
  assert.equal(steer.source, 'kora'); assert.equal(steer.delivery, 'steer');
  assert.match(steer.text, /spend cap|report/i);
  // in-session failover: cool + record; no kill, no spawn
  c.ev({ type: 'route.failover', from: 'openrouter/cheap/paid-model', to: 'opencode/big-pickle', reason: 'rate limited', retryAfter: Date.now() + 3_600_000 });
  assert.equal(pane.swarm!.model, 'opencode/big-pickle');
  assert.equal(pane.swarm!.attempt, 2);
  assert.equal(health.isAvailable('openrouter/cheap/paid-model'), false);
  assert.ok(health.cooling()[0].until > Date.now() + 3_000_000, 'retryAfter as epoch ms, beyond the floor');
  assert.deepEqual(rt.kills, []);
  assert.equal(rt.spawns.length, 1);
  // late events from a superseded / removed pane are ignored
  c.ev({ type: 'permission.request', id: 'x', tool: 'bash', summary: 'ls' });
  assert.equal(pane.state, 'blocked');
  assert.equal(pane.blocker, 'permission: bash — ls');
  rt.killPane(pane.id);
  await tick();
  c.ev({ type: 'session.state', state: 'working' });
  assert.equal(pane.state, 'blocked', 'a removed pane does not move');
});

test('opencode backend: unchanged spawn (argv prompt, prompt-pending hold, no event stream, no client)', async () => {
  const { svc, rt, clients } = setup('opencode');
  const r = await svc.spawn({ orchestratorId: 'chat:x', cwd: repo(), task: 'do it' });
  const p = rt.spawns[0];
  assert.equal(p.agent, 'opencode');
  assert.equal(p.command, '/bin/opencode');
  assert.equal(p.eventStream, undefined);
  assert.deepEqual(p.args.slice(0, 2), ['-m', r.model]);
  assert.equal(p.args[2], '--prompt');
  assert.match(p.args[3], /^REPORT TO /);
  // The test folder is untrusted, so OpenCode runs without its project config (folder trust, trust/gate.ts).
  assert.deepEqual(p.env, { KORA_REPORT: r.reportPath, OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  assert.equal((rt.panes.get(r.paneId) as FakePane).promptPending, true);
  assert.equal(clients.length, 0);
  rt.killPane(r.paneId);
});

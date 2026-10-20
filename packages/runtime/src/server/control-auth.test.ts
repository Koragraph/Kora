import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { callerKey, controlAllowed, ensureControlToken, isAgentOrigin, PRIVILEGED_METHODS, takeCallerKeyFile, verifiedCaller, vetUncontrolledCall, vetWorkerArgs, writeCallerKeyFile } from './control-auth';
import { workerLaunchArgs } from '../session/fleet-tools';
import { ipcAddress } from '../util/ipc-path';

test('control-auth: privileged methods need the exact token; fleet-tool methods stay open', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ca-'));
  try {
    assert.equal(controlAllowed('chat.session.setPermissionMode', 'anything', home), false, 'no token file: fail closed');
    const t = ensureControlToken(home);
    assert.equal(ensureControlToken(home), t, 'stable');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'ui-token')).mode & 0o077, 0);
    for (const m of ['chat.session.setPermissionMode', 'chat.approval.respond', 'config.set', 'server.shutdown', 'pane.spawn', 'pane.write', 'graph.ingest']) {
      assert.ok(PRIVILEGED_METHODS.has(m), m);
      assert.equal(controlAllowed(m, undefined, home), false, m); assert.equal(controlAllowed(m, 'x'.repeat(t.length), home), false); assert.equal(controlAllowed(m, t, home), true);
    }
    for (const m of ['pane.list', 'pane.read', 'pane.kill', 'agent.spawn', 'agent.prompt', 'agent.wait', 'fleet.get', 'swarm.spawn', 'graph.tool', 'worktree.merge', 'chat.workers.ask', 'server.ping']) assert.equal(controlAllowed(m, undefined, home), true, m);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('control-auth: a Kora agent process is not the user; a plain terminal pane is', () => {
  assert.equal(isAgentOrigin({ KORA_AGENT: 'claude' }), true);
  assert.equal(isAgentOrigin({ KORA_AGENT: 'opencode' }), true);
  assert.equal(isAgentOrigin({ KORA_AGENT: 'shell' }), false);
  assert.equal(isAgentOrigin({}), false);
});

test('daemon: an agent that dials the socket cannot flip a thread to Full access; the CLI client can', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cad-')); const sock = path.join(home, 's.sock');
  const saved = { h: process.env.KORA_HOME, s: process.env.KORA_SOCKET_PATH, a: process.env.KORA_AGENT, i: process.env.KORA_AUTO_INGEST, pid: process.env.KORA_PANE_ID, ck: process.env.KORA_CALLER_KEY };
  process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; delete process.env.KORA_AGENT;
  const { createServer } = await import('./daemon');
  const { KoraClient } = await import('../protocol/client');
  const h = await createServer({ socketPath: sock, restore: false, sweep: false });
  try {
    // Raw socket, no capability (what an agent has).
    const raw = await new Promise<any>((resolve, reject) => {
      const s = net.createConnection(ipcAddress(sock)); let buf = '';
      s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)); } });
      s.on('error', reject);
      s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.session.setPermissionMode', params: { threadId: 't_x', mode: 'full-access' } }) + '\n');
    });
    assert.equal(raw.error?.code, -32001); assert.match(raw.error.message, /control token/);
    // The CLI client outside an agent attaches the token: the call gets past auth (and fails later on the unknown thread).
    const c = new KoraClient(sock); await c.connect();
    await c.call('chat.session.setPermissionMode' as any, { threadId: 't_nope', mode: 'full-access' } as any).catch((e: any) => assert.notEqual(e.code, -32001));
    assert.equal((await c.call('server.ping', {})).ok, true);
    c.close();
    // Inside an agent (KORA_AGENT set) the client does not attach it.
    // As a pane of THIS daemon would be (the ambient KORA_PANE_ID / key, when the suite runs inside a Kora pane, name another daemon's pane).
    process.env.KORA_AGENT = 'codex'; process.env.KORA_PANE_ID = 'p-test'; process.env.KORA_CALLER_KEY = callerKey('p-test', home)!;
    const a = new KoraClient(sock); await a.connect();
    await assert.rejects(a.call('chat.session.setPermissionMode' as any, { threadId: 't_nope', mode: 'full-access' } as any), (e: any) => e.code === -32001);
    assert.equal((await a.call('pane.list', {})).panes.length, 0, 'fleet-tool methods still work for an agent');
    a.close();
  } finally {
    for (const [k, v] of [['KORA_HOME', saved.h], ['KORA_SOCKET_PATH', saved.s], ['KORA_AGENT', saved.a], ['KORA_AUTO_INGEST', saved.i], ['KORA_PANE_ID', saved.pid], ['KORA_CALLER_KEY', saved.ck]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('deep audit 2026-10-13 A1-1: every launch flag set Kora\'s fleet tools produce passes the token-less vet', () => {
  for (const agent of ['claude', 'codex', 'antigravity', 'gemini', 'opencode'] as const) {
    for (const runtimeMode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const) {
      for (const explicit of [{}, { model: 'claude-sonnet-5-5', effort: 'high' }, { model: 'gpt-5.5-codex', effort: 'medium' }, { model: 'opencode/big-pickle' }]) {
        const { args } = workerLaunchArgs({ agent: 'claude' as any, runtimeMode } as any, agent, explicit, { catalog: { agents: {} } as any });
        assert.equal(vetWorkerArgs(args).error, null, `${agent} ${runtimeMode} ${JSON.stringify(args)}`);
      }
    }
  }
});

test('deep audit 2026-10-13 A1-1: without the token agent.spawn cannot start a binary, a shell or flags that run code', () => {
  const deps = { paneAgent: (id: string) => ({ p1: 'shell', p2: 'claude', p3: 'aider' } as Record<string, string>)[id], modeOf: (o?: string) => (o === 'chat:sup' ? 'approval-required' as const : 'full-access' as const) };
  const refused = (m: string, p: unknown) => assert.notEqual(vetUncontrolledCall(m, p, deps), null, `${m} ${JSON.stringify(p)}`);
  const allowed = (m: string, p: unknown) => assert.equal(vetUncontrolledCall(m, p, deps), null, `${m} ${JSON.stringify(p)}`);
  refused('agent.spawn', { agent: 'claude', command: '/bin/sh', args: ['-c', 'cat ~/.ssh/id_rsa'] });
  refused('agent.spawn', { agent: 'claude', env: { NODE_OPTIONS: '--require /tmp/x.js' } });
  refused('agent.spawn', { agent: 'shell', prompt: 'cat ~/.ssh/id_rsa' });
  refused('agent.spawn', { agent: '/bin/sh' });
  refused('agent.spawn', { agent: 'aider', prompt: '/run cat ~/.ssh/id_rsa' });
  refused('agent.spawn', { agent: 'claude', args: ['--settings', '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"id"}]}]}}'] });
  refused('agent.spawn', { agent: 'claude', args: ['--mcp-config', '/tmp/evil.json'] });
  refused('agent.spawn', { agent: 'codex', args: ['-c', 'mcp_servers.x.command="sh"'] });
  refused('agent.spawn', { agent: 'codex', args: ['-s', 'danger-full-access'] });
  refused('agent.spawn', { agent: 'claude', args: ['--model', '--settings=x'] });
  refused('agent.spawn', { agent: 'claude', orchestratorId: 'chat:sup', args: ['--dangerously-skip-permissions'] });
  allowed('agent.spawn', { agent: 'claude', orchestratorId: 'chat:full', args: ['--model', 'claude-haiku-5-5', '--dangerously-skip-permissions', '--disallowedTools=Agent,Task,Workflow'], prompt: 'fix it', cwd: '/tmp/r' });
  allowed('agent.spawn', { agent: 'opencode', orchestratorId: 'chat:sup', args: ['-m', 'opencode/big-pickle'] });
  for (const m of ['agent.prompt', 'agent.assign', 'pane.read', 'pane.snapshot']) { refused(m, { paneId: 'p1', text: 'cat ~/.ssh/id_rsa', prompt: 'x' }); refused(m, { paneId: 'p3' }); allowed(m, { paneId: 'p2', text: 'hi', prompt: 'hi' }); }
  allowed('pane.list', {}); allowed('agent.wait', { paneId: 'p1' });
});

test('daemon: a token-less caller cannot run a shell through agent.spawn, type into one, or read it back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cav-')); const sock = path.join(home, 's.sock');
  const saved = { h: process.env.KORA_HOME, s: process.env.KORA_SOCKET_PATH, a: process.env.KORA_AGENT, i: process.env.KORA_AUTO_INGEST };
  process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; delete process.env.KORA_AGENT;
  const { createServer } = await import('./daemon');
  const { KoraClient } = await import('../protocol/client');
  const h = await createServer({ socketPath: sock, restore: false, sweep: false });
  const raw = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const s = net.createConnection(ipcAddress(sock)); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)); } });
    s.on('error', reject);
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  });
  try {
    const canary = path.join(home, 'canary.txt'); fs.writeFileSync(canary, 'SECRET-CANARY');
    for (const params of [{ agent: 'claude', command: '/bin/cat', args: [canary] }, { agent: 'shell', prompt: `cat ${canary}` }, { agent: '/bin/cat', args: [canary] }]) {
      const r = await raw('agent.spawn', params);
      assert.equal(r.error?.code, -32001, JSON.stringify(params));
    }
    assert.equal(h.runtime.panes.size, 0, 'nothing was spawned');
    // The user's own shell pane (the CLI attaches the token): an agent may neither type into it nor read it.
    const c = new KoraClient(sock); await c.connect();
    const pane = await c.call('pane.spawn', { command: '/bin/cat', args: [canary], cwd: home } as any);
    for (const [m, p] of [['agent.prompt', { paneId: pane.id, text: 'echo hi' }], ['pane.read', { paneId: pane.id }], ['pane.snapshot', { paneId: pane.id }]] as const) {
      const r = await raw(m, p); assert.equal(r.error?.code, -32001, m);
    }
    assert.equal(typeof (await c.call('pane.read', { paneId: pane.id } as any)).text, 'string', 'the user still reads it');
    c.close();
  } finally {
    for (const [k, v] of [['KORA_HOME', saved.h], ['KORA_SOCKET_PATH', saved.s], ['KORA_AGENT', saved.a], ['KORA_AUTO_INGEST', saved.i]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('deep audit 2026-10-13 A3-5 (A1 D4): a token-less spawn into a chat fleet needs a pick the user approved', () => {
  const left: Record<string, number> = { 'chat:T|claude': 1 };
  const deps = { paneAgent: () => undefined, modeOf: () => 'full-access' as const, takeSpawnApproval: (o: string, a: string) => { const k = `${o}|${a}`; if (!left[k]) return false; left[k]--; return true; } };
  const spawn = { agent: 'claude', orchestratorId: 'chat:T', args: ['--model', 'claude-sonnet-5-5'], prompt: 'x', cwd: '/tmp/r' };
  assert.equal(vetUncontrolledCall('agent.spawn', spawn, deps), null, 'the approved pick');
  assert.match(String(vetUncontrolledCall('agent.spawn', spawn, deps)), /no approved claude pick/, 'used up: a second spawn is refused');
  assert.match(String(vetUncontrolledCall('agent.spawn', { ...spawn, agent: 'codex', args: [] }, deps)), /no approved codex pick/);
  // A pane orchestrator's fleet (not a chat thread) keeps working as before.
  assert.equal(vetUncontrolledCall('agent.spawn', { ...spawn, orchestratorId: 'p4' }, deps), null);
});

test('daemon A3-5: raw agent.spawn into a chat fleet is refused until chat.workers.ask approved it; a made-up thread mints nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cap-')); const sock = path.join(home, 's.sock');
  const saved = { h: process.env.KORA_HOME, s: process.env.KORA_SOCKET_PATH, a: process.env.KORA_AGENT, i: process.env.KORA_AUTO_INGEST };
  process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; delete process.env.KORA_AGENT;
  const { createServer } = await import('./daemon');
  const h = await createServer({ socketPath: sock, restore: false, sweep: false });
  const raw = (method: string, params: unknown, caller?: string) => new Promise<any>((resolve, reject) => {
    const s = net.createConnection(ipcAddress(sock)); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)); } });
    s.on('error', reject);
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, ...(caller ? { caller, callerKey: callerKey(caller, home) } : {}) }) + '\n');
  });
  try {
    const missing = path.join(home, 'no-such-dir');
    const spawn = (orch: string) => raw('agent.spawn', { agent: 'claude', orchestratorId: orch, cwd: missing, prompt: 'hi', args: ['--model', 'claude-haiku-5-5'] }, orch);
    // Made-up thread: no auto-approval, and the spawn stays refused.
    assert.ok((await raw('chat.workers.ask', { orchestratorId: 'chat:nope', picks: [{ title: 't', agent: 'claude' }] }, 'chat:nope')).error);
    assert.equal((await spawn('chat:nope')).error?.code, -32001);
    // A real thread set to "don't ask again": the lead's own proposal is approved, and exactly one spawn may use it.
    // Straight into the store: SessionManager.create also looks up the folder's graph, and an open SQLite handle at
    // --test-force-exit aborts the process (napi FATAL) now and then.
    const tid = h.sessions.store.create({ agent: 'claude', cwd: home }).id; h.sessions.store.update(tid, { autoApproveWorkers: true });
    const orch = `chat:${tid}`;
    assert.equal((await spawn(orch)).error?.code, -32001, 'before the ask');
    const ans = await raw('chat.workers.ask', { orchestratorId: orch, picks: [{ title: 't', agent: 'claude' }] }, orch);
    assert.equal(ans.result?.picks?.length, 1);
    const first = await spawn(orch);
    assert.notEqual(first.error?.code, -32001, `the approved spawn passes the gate (${JSON.stringify(first.error)})`);
    assert.equal((await spawn(orch)).error?.code, -32001, 'and uses the pick up');
    // Round 2 #5: a pane started before its key existed (no KORA_CALLER_KEY, or a stale one) is told to restart, not
    // handed an empty list or a bare refusal.
    const stale = (method: string, params: unknown, key?: string) => new Promise<any>((resolve, reject) => {
      const s = net.createConnection(ipcAddress(sock)); let buf = '';
      s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)); } });
      s.on('error', reject);
      s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, caller: 'p1', ...(key ? { callerKey: key } : {}) }) + '\n');
    });
    for (const [m, prm] of [['pane.list', {}], ['agent.list', {}], ['fleet.get', { orchestratorId: 'p1' }]] as const) {
      const r = await stale(m, prm);
      assert.equal(r.error?.code, -32001, m);
      assert.match(r.error.message, /no valid KORA_CALLER_KEY.*Restart this pane/, m);
    }
    assert.match((await stale('pane.list', {}, 'x'.repeat(43))).error?.message ?? '', /Restart this pane/, 'a stale key too');
    assert.ok(Array.isArray((await raw('pane.list', {}, 'p1')).result?.panes), 'a valid key still lists');
  } finally {
    for (const [k, v] of [['KORA_HOME', saved.h], ['KORA_SOCKET_PATH', saved.s], ['KORA_AGENT', saved.a], ['KORA_AUTO_INGEST', saved.i]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close(); fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── deep A1 D3 + A3-9: token-less calls are scoped to the caller's own fleet ────────────────────────────────────────
const panes: Record<string, { agent: string; role: string | null; orchestratorId: string | null }> = {
  p1: { agent: 'claude', role: 'orchestrator', orchestratorId: null }, p2: { agent: 'opencode', role: 'worker', orchestratorId: 'p1' },
  p5: { agent: 'claude', role: 'orchestrator', orchestratorId: null }, p6: { agent: 'codex', role: 'worker', orchestratorId: 'p5' },
  p7: { agent: 'claude', role: null, orchestratorId: null }, w1: { agent: 'codex', role: 'worker', orchestratorId: 'chat:T' },
};
const scoped = (caller?: string, picks = 99) => ({ paneAgent: (id: string) => panes[id]?.agent, paneFacts: (id: string) => panes[id], caller, modeOf: () => 'full-access' as const, takeSpawnApproval: () => picks-- > 0 });

test('A1 D3: a token-less caller reaches only itself and its own fleet', () => {
  const c = scoped('p1');
  for (const m of ['pane.kill', 'pane.read', 'pane.get', 'agent.prompt', 'agent.status', 'agent.wait', 'pane.snapshot']) {
    assert.equal(vetUncontrolledCall(m, { paneId: 'p2', text: 'hi' }, c), null, `${m} own worker`);
    assert.equal(vetUncontrolledCall(m, { paneId: 'p1', text: 'hi' }, c), null, `${m} itself`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p6', text: 'hi' }, c)), /not in your fleet/, `${m} another fleet's worker`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p7', text: 'hi' }, c)), /not in your fleet/, `${m} a pane nobody owns`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p2' }, scoped(undefined))), /come from a Kora agent/, `${m} without a caller`);
  }
  assert.equal(vetUncontrolledCall('pane.kill', { paneId: 'p-gone' }, c), null, 'a missing pane is the method\'s own error');
  // chat leads (and a Codex lead's bridge) are `chat:<id>`
  assert.equal(vetUncontrolledCall('pane.kill', { paneId: 'w1' }, scoped('chat:T')), null);
  assert.match(String(vetUncontrolledCall('pane.kill', { paneId: 'w1' }, scoped('chat:OTHER'))), /not in your fleet/);
  // fleet / worker / swarm addressed by orchestratorId
  for (const m of ['fleet.get', 'fleet.set', 'fleet.drainNotes', 'worker.asleep', 'worker.history', 'swarm.spawn', 'swarm.queued', 'swarm.finished']) {
    assert.equal(vetUncontrolledCall(m, { orchestratorId: 'chat:T' }, scoped('chat:T')), null, m);
    assert.match(String(vetUncontrolledCall(m, { orchestratorId: 'chat:V' }, scoped('chat:T'))), /not your fleet/, m);
  }
  // other threads' conversations
  for (const m of ['chat.thread.get', 'chat.events.backfill']) {
    assert.equal(vetUncontrolledCall(m, { threadId: 'T' }, scoped('chat:T')), null, m);
    assert.match(String(vetUncontrolledCall(m, { threadId: 'V' }, scoped('chat:T'))), /own thread/, m);
    assert.match(String(vetUncontrolledCall(m, { threadId: 'T' }, scoped('p1'))), /own thread/, `${m}: a pane is not a chat thread`);
  }
  assert.match(String(vetUncontrolledCall('chat.events.subscribe', { threadIds: ['T', 'V'] }, scoped('chat:T'))), /own thread/);
  assert.equal(vetUncontrolledCall('worktree.mergeVerify', { paneIds: ['p2'] }, c), null);
  assert.match(String(vetUncontrolledCall('worktree.mergeVerify', { paneIds: ['p2', 'p6'] }, c)), /not in your fleet/);
  assert.match(String(vetUncontrolledCall('worktree.merge', { paneId: 'p6' }, c)), /not in your fleet/);
  assert.equal(PRIVILEGED_METHODS.has('chat.thread.list'), true);
  assert.equal(PRIVILEGED_METHODS.has('agent.promote'), true, 'only the user makes an orchestrator');
});

test('S6 + 2026-10-15 #5: the hook-reporting calls (feed and swarm events included) come only from the pane itself', () => {
  for (const m of ['pane.reportAgentSession', 'pane.prelaunch', 'pane.reportState', 'pane.reportGraphUse', 'pane.feed', 'swarm.reportEvent']) {
    assert.equal(vetUncontrolledCall(m, { paneId: 'p2', transcriptPath: '/x' }, scoped('p2')), null, `${m} its own pane`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p2', items: [] }, scoped('p1'))), /only pane p2 itself/, `${m} not even its orchestrator`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p6', transcriptPath: '/x' }, scoped('p2'))), /only pane p6 itself/, `${m} another fleet's pane`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p7', cwd: '/' }, scoped('p2'))), /only pane p7 itself/, `${m} a pane nobody owns`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'p2' }, scoped(undefined))), /come from a Kora agent/, `${m} without a caller`);
  }
  assert.equal(vetUncontrolledCall('pane.reportAgentSession', { paneId: 'chat:T' }, scoped('chat:T')), null, 'a chat thread\'s SessionStart hook has no pane');
});

test('2026-10-15 #2: a caller is believed only with its key, and a key proves only its own id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ck-'));
  try {
    assert.equal(callerKey('p1', home), null, 'no token file: no keys');
    assert.equal(verifiedCaller('p1', 'x', home), undefined);
    ensureControlToken(home);
    const k = callerKey('p1', home)!;
    assert.equal(k, callerKey('p1', home), 'derived: stable');
    assert.equal(verifiedCaller('p1', k, home), 'p1');
    assert.equal(verifiedCaller('p5', k, home), undefined, "p1's key does not prove p5");
    assert.equal(verifiedCaller('p1', undefined, home), undefined, 'a bare caller is no caller');
    assert.equal(verifiedCaller('p1', k.slice(1), home), undefined);
    assert.notEqual(callerKey('chat:T', home), callerKey('chat:V', home));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('round 2 #1: a scrubbed-env bridge gets its key from a one-time 0600 file, never from argv', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ckf-'));
  try {
    assert.equal(writeCallerKeyFile('chat:T', home), null, 'no token file: no key file');
    ensureControlToken(home);
    const f = writeCallerKeyFile('chat:T', home)!;
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
    assert.ok(!f.includes(callerKey('chat:T', home)!), 'the path does not carry the key');
    assert.equal(takeCallerKeyFile(f), callerKey('chat:T', home));
    assert.equal(fs.existsSync(f), false, 'read once, then gone');
    assert.equal(takeCallerKeyFile(f), undefined, 'a second read gets nothing');
    const loose = path.join(home, 'run', 'loose'); fs.writeFileSync(loose, 'k', { mode: 0o644 });
    assert.equal(takeCallerKeyFile(loose), undefined, 'a group/world-readable file is not trusted');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('2026-10-15 #1: without the token a worktree is named by a pane of the caller\'s fleet, never by an arbitrary path', () => {
  const trees: Record<string, { paneId: string; orchestratorId: string | null }> = { '/k/worktrees/r/p2': { paneId: 'p2', orchestratorId: 'p1' }, '/k/worktrees/r/p6': { paneId: 'p6', orchestratorId: 'p5' } };
  const deps = (caller?: string) => ({ ...scoped(caller), worktreeOwner: (d: string) => trees[d], finishedOwner: (id: string) => (id === 'gone-a' ? 'p1' : id === 'gone-b' ? 'p5' : undefined) });
  for (const m of ['worktree.remove', 'worktree.merge']) {
    assert.match(String(vetUncontrolledCall(m, { path: '/Users/me/Projects/kora-dev', force: true, deleteBranch: true }, deps('p1'))), /not the worktree of a worker in your fleet/, `${m}: a main checkout`);
    assert.match(String(vetUncontrolledCall(m, { path: '/Users/me/Projects/kora-dev' }, deps(undefined))), /come from a Kora agent/, `${m}: no caller`);
    assert.equal(vetUncontrolledCall(m, { path: '/k/worktrees/r/p2' }, deps('p1')), null, `${m}: its worker's worktree`);
    assert.equal(vetUncontrolledCall(m, { path: '/k/worktrees/r/p2' }, deps('p2')), null, `${m}: the worker's own`);
    assert.match(String(vetUncontrolledCall(m, { path: '/k/worktrees/r/p6' }, deps('p1'))), /belongs to pane p6/, `${m}: another fleet's worktree`);
    assert.equal(vetUncontrolledCall(m, { paneId: 'gone-a' }, deps('p1')), null, `${m}: its finished swarm task`);
    assert.match(String(vetUncontrolledCall(m, { paneId: 'gone-b' }, deps('p1'))), /not in your fleet/, `${m}: another fleet's finished task`);
  }
  assert.match(String(vetUncontrolledCall('worktree.mergeVerify', { worktreePaths: ['/k/worktrees/r/p2', '/'] }, deps('p1'))), /not the worktree/);
  assert.equal(PRIVILEGED_METHODS.has('worktree.sweep'), true, 'the sweep deletes unowned worktrees: the user\'s call');
});

test('2026-10-15 #9: merge.verify and graph queries without the token stay in the caller\'s own repos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cwd-'));
  try {
    const mine = path.join(root, 'mine'); const other = path.join(root, 'other'); fs.mkdirSync(path.join(mine, 'src'), { recursive: true }); fs.mkdirSync(other);
    const deps = (caller?: string) => ({ ...scoped(caller), callerRoots: (c: string) => (c === 'p1' ? [mine] : []) });
    for (const m of ['merge.verify', 'graph.tool', 'graph.brief']) {
      assert.equal(vetUncontrolledCall(m, { cwd: path.join(mine, 'src'), name: 'explore', refs: ['main'] }, deps('p1')), null, `${m}: its repo`);
      assert.match(String(vetUncontrolledCall(m, { cwd: other, name: 'explore', refs: [] }, deps('p1'))), /not a repo you or your workers work in/, `${m}: another repo`);
      assert.match(String(vetUncontrolledCall(m, { cwd: mine }, deps(undefined))), /come from a Kora agent/, `${m}: no caller`);
    }
    assert.match(String(vetUncontrolledCall('merge.verify', { cwd: mine, refs: [other] }, deps('p1'))), /not a checkout/, 'a ref that is another checkout');
    assert.match(String(vetUncontrolledCall('graph.tool', { name: 'explore', paneId: 'p6', cwd: mine }, deps('p1'))), /not in your fleet/, 'counted against another fleet\'s pane');
    assert.equal(vetUncontrolledCall('graph.tool', { name: 'explore', paneId: 'p2' }, deps('p1')), null, 'no cwd: its worker pane\'s folder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A3-9: a token-less spawn needs an orchestrator that is the caller\'s own fleet', () => {
  const base = { agent: 'claude', args: ['--model', 'claude-sonnet-5-5'], prompt: 'x', cwd: '/tmp/r' };
  assert.match(String(vetUncontrolledCall('agent.spawn', base, scoped('p1'))), /unparented/);
  assert.match(String(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'p1' }, scoped(undefined))), /come from a Kora agent/);
  assert.match(String(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'p5' }, scoped('p1'))), /not your fleet/, 'into another orchestrator\'s fleet');
  assert.match(String(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'p7' }, scoped('p7'))), /not an orchestrator pane/, 'a pane the user never promoted');
  assert.equal(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'p1' }, scoped('p1')), null, 'a promoted pane orchestrator spawns its own workers');
  assert.equal(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'chat:T' }, scoped('chat:T', 1)), null, 'a chat lead with an approved pick');
  assert.match(String(vetUncontrolledCall('agent.spawn', { ...base, orchestratorId: 'chat:T' }, scoped('chat:T', 0))), /no approved claude pick/);
});

test('daemon A1 D3: over a real socket, a token-less agent cannot kill, read or prompt another fleet\'s pane or read its thread', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-scope-')); const sock = path.join(home, 's.sock');
  const saved = { h: process.env.KORA_HOME, s: process.env.KORA_SOCKET_PATH, a: process.env.KORA_AGENT, i: process.env.KORA_AUTO_INGEST };
  process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; delete process.env.KORA_AGENT;
  const { createServer } = await import('./daemon');
  const h = await createServer({ socketPath: sock, restore: false, sweep: false });
  const raw = (method: string, params: unknown, caller?: string) => new Promise<any>((resolve, reject) => {
    const s = net.createConnection(ipcAddress(sock)); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)); } });
    s.on('error', reject);
    s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, ...(caller ? { caller, callerKey: callerKey(caller, home) } : {}) }) + '\n');
  });
  try {
    const a = h.sessions.store.create({ agent: 'claude', cwd: home }).id, b = h.sessions.store.create({ agent: 'claude', cwd: home }).id;
    assert.equal((await raw('chat.thread.get', { threadId: b }, `chat:${a}`)).error?.code, -32001, 'another thread');
    assert.equal((await raw('chat.thread.get', { threadId: b })).error?.code, -32001, 'no caller');
    assert.equal((await raw('chat.thread.list', {}, `chat:${a}`)).error?.code, -32001, 'the thread list is control-token only');
    assert.equal((await raw('chat.thread.get', { threadId: a }, `chat:${a}`)).error, undefined, 'its own thread');
    assert.equal((await raw('chat.events.backfill', { threadId: b, sinceSeq: 0 }, `chat:${a}`)).error?.code, -32001);
  } finally {
    for (const [k, v] of [['KORA_HOME', saved.h], ['KORA_SOCKET_PATH', saved.s], ['KORA_AGENT', saved.a], ['KORA_AUTO_INGEST', saved.i]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('daemon 2026-10-15 #2/#3: a forged caller is nobody; pane.list and events.subscribe show only the caller\'s own fleet', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ev-')); const sock = path.join(home, 's.sock');
  const saved = { h: process.env.KORA_HOME, s: process.env.KORA_SOCKET_PATH, a: process.env.KORA_AGENT, i: process.env.KORA_AUTO_INGEST };
  process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; delete process.env.KORA_AGENT;
  const { createServer } = await import('./daemon');
  const h = await createServer({ socketPath: sock, restore: false, sweep: false });
  const open = () => new Promise<{ send: (o: unknown) => void; lines: any[]; close: () => void }>((resolve, reject) => {
    const s = net.createConnection(ipcAddress(sock)); let buf = ''; const lines: any[] = [];
    s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    s.on('error', reject); s.on('connect', () => resolve({ send: (o) => s.write(JSON.stringify(o) + '\n'), lines, close: () => s.destroy() }));
  });
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    // Two fleets: p-lead/p-work and p-victim (fake panes are enough: the scoping reads ids and orchestrators).
    const fake = (id: string, orchestratorId: string | null) => ({ id, agent: 'claude', role: orchestratorId ? 'worker' : 'orchestrator', orchestratorId, cwd: home, worktree: null, graph: {}, info: () => ({ id, orchestratorId }) });
    for (const [id, o] of [['p-lead', null], ['p-work', 'p-lead'], ['p-victim', null]] as const) h.runtime.panes.set(id, fake(id, o) as any);
    const lead = await open();
    lead.send({ jsonrpc: '2.0', id: 1, method: 'pane.list', params: {}, caller: 'p-lead', callerKey: callerKey('p-lead', home) });
    lead.send({ jsonrpc: '2.0', id: 2, method: 'pane.list', params: {}, caller: 'p-lead' });
    lead.send({ jsonrpc: '2.0', id: 3, method: 'pane.kill', params: { paneId: 'p-victim' }, caller: 'p-victim' });
    lead.send({ jsonrpc: '2.0', id: 4, method: 'events.subscribe', params: { paneOutput: true }, caller: 'p-lead', callerKey: callerKey('p-lead', home) });
    await until(() => lead.lines.filter((l) => l.id).length >= 4);
    const byId = (id: number) => lead.lines.find((l) => l.id === id);
    assert.deepEqual(byId(1).result.panes.map((x: any) => x.id).sort(), ['p-lead', 'p-work'], 'its own fleet');
    assert.match(byId(2).error?.message ?? '', /Restart this pane/, 'a caller without its key is told to restart, not shown an empty list');
    assert.equal(byId(3).error?.code, -32001, 'a forged caller cannot kill the pane it names');
    assert.ok(h.runtime.panes.has('p-victim'));
    assert.deepEqual(byId(4).result, { ok: true });
    const anon = await open();
    anon.send({ jsonrpc: '2.0', id: 9, method: 'events.subscribe', params: { paneOutput: true } });
    await until(() => anon.lines.some((l) => l.id === 9));
    assert.equal(anon.lines.find((l) => l.id === 9).error?.code, -32001, 'no caller: no event stream');
    for (const paneId of ['p-victim', 'p-work']) h.runtime.emit('notify', 'pane.feed', { paneId, item: { kind: 'text', text: `from ${paneId}` } });
    h.runtime.emit('notify', 'fleet.plan', { orchestratorId: 'p-victim', plan: 'secret plan' });
    h.runtime.emit('notify', 'workspace.updated', { workspaces: [], activeWorkspaceId: null });
    h.runtime.emit('notify', 'fleet.plan', { orchestratorId: 'p-lead', plan: 'own plan' });
    await until(() => lead.lines.some((l) => l.method === 'fleet.plan'));
    const notes = lead.lines.filter((l) => l.method);
    assert.deepEqual(notes.map((n) => `${n.method}:${n.params.paneId ?? n.params.orchestratorId ?? ''}`), ['pane.feed:p-work', 'fleet.plan:p-lead']);
    lead.close(); anon.close();
    for (const id of ['p-lead', 'p-work', 'p-victim']) h.runtime.panes.delete(id);
  } finally {
    for (const [k, v] of [['KORA_HOME', saved.h], ['KORA_SOCKET_PATH', saved.s], ['KORA_AGENT', saved.a], ['KORA_AUTO_INGEST', saved.i]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('2026-10-15 #6: a reported transcript counts only as a regular file in an agent\'s own transcript folder', async () => {
  const { agentTranscriptPath } = await import('./workspace');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tr-')));
  try {
    const proj = path.join(home, '.claude', 'projects', 'x'); fs.mkdirSync(proj, { recursive: true });
    const good = path.join(proj, 's.jsonl'); fs.writeFileSync(good, '{}\n');
    const outside = path.join(home, 'notes.jsonl'); fs.writeFileSync(outside, '{}\n');
    const link = path.join(proj, 'l.jsonl'); fs.symlinkSync(outside, link);
    const acct = path.join(home, 'acct'); fs.mkdirSync(path.join(acct, 'projects'), { recursive: true }); fs.writeFileSync(path.join(acct, 'projects', 'a.jsonl'), '');
    assert.equal(agentTranscriptPath(good, null, home), good);
    assert.equal(agentTranscriptPath(outside, null, home), null, 'outside every agent folder');
    assert.equal(agentTranscriptPath(link, null, home), null, 'a symlink');
    assert.equal(agentTranscriptPath(path.join(proj, 'missing.jsonl'), null, home), null);
    assert.equal(agentTranscriptPath('rel/s.jsonl', null, home), null);
    assert.equal(agentTranscriptPath(path.join(acct, 'projects', 'a.jsonl'), acct, home), path.join(acct, 'projects', 'a.jsonl'), "the pane's CLAUDE_CONFIG_DIR");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('2026-10-15 #8: the client sends the control token only to a socket in a private folder', async () => {
  const { privateSocketDir } = await import('../protocol/client');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sd-'));
  try {
    assert.equal(privateSocketDir(d), true);
    if (process.platform !== 'win32') {
      fs.chmodSync(d, 0o777); assert.equal(privateSocketDir(d), false, 'world-writable');
      fs.chmodSync(d, 0o700);
      const l = path.join(os.tmpdir(), `kora-sd-link-${process.pid}`); fs.symlinkSync(d, l);
      try { assert.equal(privateSocketDir(l), true, 'our own link to our own folder'); } finally { fs.unlinkSync(l); }
    }
    assert.equal(privateSocketDir(path.join(d, 'nope')), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

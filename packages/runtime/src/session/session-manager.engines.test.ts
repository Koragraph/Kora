// Phase 7 in the session manager: a known ACP agent id gets an AcpDriver, an API endpoint id an ApiDriver (one driver per
// agent id), anything else stays Claude; an edited engine rebuilds an idle driver but never one with a live thread; shutdown
// closes the ACP processes; blob tools on those engines can ask the user through the inline approval card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-engines-'));

import { SessionManager, type ManagerRuntime } from './session-manager';
import { ChatThreadStore } from './store';
import { AcpDriver } from './drivers/acp-driver';
import { ApiDriver } from './drivers/api-driver';
import { ClaudeDriver } from './drivers/claude-driver';
import { AntigravityDriver } from './drivers/antigravity-driver';
import { ApprovalGate, EventBus, blobAskVia } from './drivers/engine-common';
import { Engines } from '../server/engines';
import { MemorySecretStore } from '../blobs/apps/secrets';
import { ClaudeAccounts } from './claude-accounts';
import { agentOfInstance, permissionHelp, resolveBlobRuntimeMode } from '../blobs/permissions';

function build() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-eng-home-'));
  const engines = new Engines({ home, secrets: new MemorySecretStore(), accounts: new ClaudeAccounts({ home }), detect: { resolve: () => null } });
  const runtime: ManagerRuntime = { notify: () => {}, graph: { callTool: async () => ({ text: '', data: null, ms: 0 }) }, agentSpawn: async () => ({} as any), engines };
  const mgr = new SessionManager(runtime, new ChatThreadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-eng-store-'))), { queryFn: (() => { throw new Error('no model in tests'); }) as any });
  return { engines, home, mgr, driverFor: (a: string) => (mgr as any).driverFor(a) };
}

test('each agent id gets its own driver kind', () => {
  const { engines, driverFor } = build();
  engines.apiSave({ id: 'groq' });
  engines.acpSave({ agentId: 'acp-mine', label: 'Mine', command: 'mine' });
  assert.ok(driverFor('grok') instanceof AcpDriver);
  assert.ok(driverFor('acp-mine') instanceof AcpDriver);
  assert.ok(driverFor('api-groq') instanceof ApiDriver);
  assert.ok(driverFor('claude') instanceof ClaudeDriver);
  assert.ok(driverFor('totally-unknown') instanceof ClaudeDriver, 'an unknown id falls back to Claude, like before');
  assert.equal(driverFor('grok'), driverFor('grok'), 'one driver per id');
  assert.notEqual(driverFor('grok'), driverFor('acp-mine'));
  assert.equal((driverFor('api-groq') as ApiDriver).agent, 'api-groq');
  assert.equal((driverFor('grok') as AcpDriver).agent, 'grok');
  // Google's agent is the native Antigravity driver; Gemini CLI is no longer a built-in ACP engine (unless configured)
  assert.ok(driverFor('antigravity') instanceof AntigravityDriver);
  assert.ok(driverFor('gemini') instanceof ClaudeDriver, 'an unconfigured gemini is not detected any more');
});

test('a Gemini CLI the user configured before keeps its ACP driver; a fresh one cannot be added as a built-in', () => {
  const { engines, home, driverFor } = build();
  assert.throws(() => engines.acpSave({ agentId: 'gemini' }), /custom agent id/);
  // what an older Settings > Engines wrote for the then built-in row
  fs.writeFileSync(path.join(home, 'engines.json'), JSON.stringify({ acp: [{ agentId: 'gemini', executable: '/opt/x/gemini' }], endpoints: [], executables: {} }));
  const d = driverFor('gemini');
  assert.ok(d instanceof AcpDriver);
  assert.deepEqual((d as AcpDriver).engine.args, ['--acp']);
  assert.equal((d as AcpDriver).engine.executable, '/opt/x/gemini');
  engines.acpSave({ agentId: 'gemini', args: ['--acp', '-d'] }); // still editable
  assert.deepEqual(engines.acpEngine('gemini')!.args, ['--acp', '-d']);
});

test('an engine edited in Settings rebuilds an idle driver; a driver with a live thread is left alone', () => {
  const { engines, mgr, driverFor } = build();
  const first = driverFor('grok');
  engines.acpSave({ agentId: 'grok', args: ['agent', 'stdio', '--debug'] });
  const second = driverFor('grok');
  assert.notEqual(second, first, 'idle: rebuilt from the new arguments');
  assert.deepEqual((second as AcpDriver).engine.args, ['agent', 'stdio', '--debug']);
  (mgr as any).live.set('t1', { driver: second, agent: 'grok' });
  engines.setIdleMinutes(5);
  assert.equal(driverFor('grok'), second, 'a live thread keeps its driver');
  (mgr as any).live.clear();
  engines.apiSave({ id: 'groq' });
  const api = driverFor('api-groq');
  engines.apiSave({ id: 'groq', baseUrl: 'https://api.groq.com/openai/v2' });
  assert.notEqual(driverFor('api-groq'), api);
});

test('shutdown closes every driver that can shut down (ACP agent processes)', async () => {
  const { mgr, driverFor } = build();
  const d = driverFor('grok') as AcpDriver;
  let closed = 0;
  d.shutdown = async () => { closed++; };
  await mgr.shutdown();
  assert.equal(closed, 1);
});

test('blob tools on an ACP / API engine ask through the inline approval card (Allow once / Always / Deny), fail closed, and retire on abort', async () => {
  const bus = new EventBus(); const gate = new ApprovalGate(bus);
  const opened: any[] = [];
  bus.subscribe((e) => { if (e.type === 'approval.opened') opened.push(e); });
  const ask = blobAskVia(gate, 'T1', () => 'turn_1');
  const remembered: string[] = [];
  const p = ask({ title: 'Popo wants to: send', detail: 'd', args: { kind: 'app-action' }, always: { label: 'Send mail', remember: () => { remembered.push('x'); } } });
  assert.equal(opened[0].requestKind, 'mcp_elicitation_approval');
  assert.equal(opened[0].alwaysLabel, 'Send mail');
  assert.deepEqual(opened[0].options.map((o: any) => o.decision), ['accept', 'acceptAlways', 'decline']);
  gate.respond('T1', opened[0].requestId, 'acceptAlways');
  assert.equal(await p, true);
  assert.deepEqual(remembered, ['x']);

  const d = ask({ title: 't', detail: 'd', args: {} });
  gate.respond('T1', opened[1].requestId, 'decline');
  assert.equal(await d, false);

  const ctl = new AbortController();
  const c = ask({ title: 't', detail: 'd', args: {}, signal: ctl.signal });
  ctl.abort();
  assert.equal(await c, false, 'answered elsewhere: the card is retired as cancelled');
  assert.equal(gate.count('T1'), 0);

  const cancelled = ask({ title: 't', detail: 'd', args: {} });
  gate.cancelAll('T1');
  assert.equal(await cancelled, false, 'an interrupted turn denies');
});

test('permissions: every non-Claude engine runs the Auto posture the drivers enforce themselves, and the help says so', () => {
  assert.equal(agentOfInstance('gemini'), 'gemini');
  assert.equal(agentOfInstance('acp-hermes'), 'acp-hermes');
  assert.equal(agentOfInstance('api-groq'), 'api-groq');
  assert.equal(agentOfInstance('claude-work'), 'claude');
  assert.equal(agentOfInstance('codex:work'), 'codex');
  assert.equal(agentOfInstance(''), 'claude');
  assert.equal(resolveBlobRuntimeMode('claude-work', 'auto'), 'auto');
  assert.equal(resolveBlobRuntimeMode('api-groq', 'auto'), 'auto-accept-edits');
  assert.equal(resolveBlobRuntimeMode('gemini', 'ask'), 'approval-required');
  assert.equal(resolveBlobRuntimeMode('acp-x', 'full'), 'full-access');
  assert.match(permissionHelp('api-groq'), /Kora enforces this itself/);
  assert.match(permissionHelp('gemini'), /not a sandbox/);
});

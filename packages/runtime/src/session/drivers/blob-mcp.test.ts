// Codex and OpenCode blobs get the `kora_blobs` MCP server: identity + token on argv (Codex scrubs the MCP env), stdin
// closed for `codex exec`, the token revoked when the turn ends, no server at all for a non-blob thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexDriver } from './codex-driver';
import { OpenCodeDriver } from './opencode-driver';
import type { DriverDeps } from '../session-driver';

function fakeChildren() {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined>; cwd: string; stdio?: unknown }> = [];
  const children: any[] = [];
  const spawnFn: any = (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    children.push(child);
    return child;
  };
  return { calls, children, spawnFn };
}

function blobDeps(extra: Partial<DriverDeps> = {}) {
  const issued: any[] = []; const revoked: string[] = [];
  const deps = {
    graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined,
    socketPath: '/h/kora.sock', binPath: '/app/bin/kora.js',
    blobs: {
      byCwd: (cwd: string) => (cwd === '/Blobs/kora' ? { id: 'blob_kora', role: 'chief', permission: 'auto', workspace: cwd } : null),
      toolSpecs: () => [], skills: () => ({ dir: '', qualified: [] }),
      mcpIssue: (s: any) => { issued.push(s); return 'TOKEN123'; },
      mcpRevoke: (t: string) => { revoked.push(t); },
    },
    opencode: { binary: () => '/bin/opencode', pickModel: () => 'opencode/big-pickle', env: () => ({ OPENCODE_CONFIG_CONTENT: '{"provider":{"p":1}}' }), markCooling: () => {} },
    ...extra,
  } as unknown as DriverDeps;
  return { deps, issued, revoked };
}

test('Codex blob turn: kora_blobs MCP on argv with the blob id, token, thread and socket; closed stdin; token revoked on exit', async () => {
  const f = fakeChildren();
  const { deps, issued, revoked } = blobDeps();
  const d = new CodexDriver(deps, f.spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T1', agent: 'codex', cwd: '/Blobs/kora', account: null, runtimeMode: 'auto' } as any);
  await d.sendTurn({ threadId: 'T1', text: 'plan my week' } as any);
  const a = f.calls[0]!.args;
  const cmd = a.find((x) => x.startsWith('mcp_servers.kora_blobs.command='))!;
  const argsArg = a.find((x) => x.startsWith('mcp_servers.kora_blobs.args='))!;
  assert.ok(cmd && argsArg, a.join(' '));
  const mcpArgs = JSON.parse(argsArg.slice('mcp_servers.kora_blobs.args='.length)) as string[];
  assert.deepEqual(mcpArgs.slice(0, 3), ['/app/bin/kora.js', 'mcp', '--blobs']);
  const val = (flag: string) => mcpArgs[mcpArgs.indexOf(flag) + 1];
  assert.equal(val('--blob'), 'blob_kora'); assert.equal(val('--token'), 'TOKEN123'); assert.equal(val('--thread'), 'T1'); assert.equal(val('--socket'), '/h/kora.sock'); assert.equal(val('--agent'), 'codex');
  assert.ok(a.includes('mcp_servers.kora_blobs.tool_timeout_sec=600'));
  // the prompt stays last, after `--`
  assert.equal(a.at(-2), '--'); assert.equal(a.at(-1), 'plan my week');
  // codex exec would block on "Reading additional input from stdin": the default spawn closes stdin
  assert.match(String(require('node:fs').readFileSync(require.resolve('./codex-driver'), 'utf8')), /stdio: \['ignore', 'pipe', 'pipe'\]/);
  // the session issued the cards / file closures the MCP calls need
  assert.equal(issued.length, 1);
  assert.equal(issued[0].blobId, 'blob_kora'); assert.equal(issued[0].agent, 'codex');
  issued[0].emitCard({ cardKind: 'job', cardId: 'j1', version: 1 });
  assert.ok(events.some((e) => e.type === 'blob.card' && e.card.cardId === 'j1'));
  assert.equal(issued[0].fullAccess(), false);
  assert.equal(issued[0].userMessageSince(Date.now() - 5000), true, 'the user just wrote');
  issued[0].attachOutput('/Blobs/kora/outputs/a.md', 'the file');
  assert.ok(events.some((e) => e.type === 'tool.result' && e.changedFiles?.[0]?.path === '/Blobs/kora/outputs/a.md'));
  // the turn ends -> token revoked
  f.children[0].stdout.end(); f.children[0].emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.ok(revoked.includes('T1'));
});

test('Codex: a thread that is not a blob gets no kora_blobs server', async () => {
  const f = fakeChildren();
  const { deps, issued } = blobDeps();
  const d = new CodexDriver(deps, f.spawnFn);
  await d.startSession({ threadId: 'T2', agent: 'codex', cwd: '/some/repo', account: null, runtimeMode: 'auto' } as any);
  await d.sendTurn({ threadId: 'T2', text: 'hi' } as any);
  assert.ok(!f.calls[0]!.args.some((x) => x.includes('kora_blobs')));
  assert.equal(issued.length, 0);
});

test('OpenCode blob turn: kora_blobs lands in OPENCODE_CONFIG_CONTENT next to the provider config; token revoked on exit; other threads untouched', async () => {
  const f = fakeChildren();
  const { deps, issued, revoked } = blobDeps();
  const d = new OpenCodeDriver(deps, f.spawnFn);
  await d.startSession({ threadId: 'T9', agent: 'opencode', cwd: '/Blobs/kora', account: null, runtimeMode: 'auto' } as any);
  await d.sendTurn({ threadId: 'T9', text: 'delegate this' } as any);
  const cfg = JSON.parse(f.calls[0]!.env.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(cfg.provider, { p: 1 }, 'the provider config survives the merge');
  const entry = cfg.mcp.kora_blobs;
  assert.equal(entry.type, 'local'); assert.equal(entry.enabled, true);
  assert.deepEqual(entry.command.slice(1, 4), ['/app/bin/kora.js', 'mcp', '--blobs']);
  assert.equal(entry.command[entry.command.indexOf('--agent') + 1], 'opencode');
  assert.equal(entry.command[entry.command.indexOf('--token') + 1], 'TOKEN123');
  assert.equal(issued[0].agent, 'opencode');
  f.children[0].stdout.end(); f.children[0].emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.ok(revoked.includes('T9'));
  const f2 = fakeChildren();
  const o2 = blobDeps();
  const d2 = new OpenCodeDriver(o2.deps, f2.spawnFn);
  await d2.startSession({ threadId: 'T4', agent: 'opencode', cwd: '/some/repo', account: null, runtimeMode: 'auto' } as any);
  await d2.sendTurn({ threadId: 'T4', text: 'hi' } as any);
  assert.ok(!JSON.parse(f2.calls[0]!.env.OPENCODE_CONFIG_CONTENT!).mcp);
});

// ── a connected-app action asks the user before it sends: the question is parked on the thread and answered through the driver ──
for (const [label, make, agent] of [
  ['Codex', (deps: DriverDeps, spawn: any) => new CodexDriver(deps, spawn), 'codex'],
  ['OpenCode', (deps: DriverDeps, spawn: any) => new OpenCodeDriver(deps, spawn), 'opencode'],
] as const) {
  test(`${label}: the MCP session's askApproval opens an approval card on the thread; Allow resolves true, Deny false, the turn ending denies`, async () => {
    const f = fakeChildren();
    const { deps, issued } = blobDeps();
    const d = make(deps, f.spawnFn);
    const events: any[] = [];
    d.streamEvents((e) => events.push(e));
    await d.startSession({ threadId: 'A1', agent, cwd: '/Blobs/kora', account: null, runtimeMode: 'auto' } as any);
    await d.sendTurn({ threadId: 'A1', text: 'send it' } as any);
    const ask = issued[0].askApproval;
    assert.equal(typeof ask, 'function', 'the session carries an approval channel');
    const a1 = ask({ title: 'Popo wants to: Send email on gmail', detail: 'Send email on gmail\nto: sam@acme.com', args: { kind: 'app-action', appName: 'Gmail' } });
    const opened = events.find((e) => e.type === 'approval.opened');
    assert.ok(opened, 'an approval card was opened');
    assert.equal(opened.requestKind, 'mcp_elicitation_approval');
    assert.equal(opened.title, 'Popo wants to: Send email on gmail');
    assert.match(opened.detail, /to: sam@acme\.com/);
    assert.equal(opened.args.appName, 'Gmail');
    assert.deepEqual(opened.options.map((o: any) => o.decision), ['accept', 'decline']);
    await d.respondToApproval('A1', opened.requestId, 'accept');
    assert.equal(await a1, true);
    assert.ok(events.some((e) => e.type === 'approval.resolved' && e.requestId === opened.requestId && e.decision === 'accept'));
    // Deny
    const a2 = ask({ title: 't', detail: 'd', args: {} });
    const second = events.filter((e) => e.type === 'approval.opened')[1];
    assert.notEqual(second.requestId, opened.requestId, 'request ids are never reused');
    await d.respondToApproval('A1', second.requestId, 'decline');
    assert.equal(await a2, false);
    // an answer for another thread, or for nothing, changes nothing
    const a3 = ask({ title: 't', detail: 'd', args: {} });
    const third = events.filter((e) => e.type === 'approval.opened')[2];
    await d.respondToApproval('OTHER', third.requestId, 'accept');
    let settled = false; void a3.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'another thread cannot answer it');
    // the turn ends (process closes): a question nobody answered is a denial, and its card closes
    f.children[0].stdout.end(); f.children[0].emit('close', 0, null);
    assert.equal(await a3, false);
    assert.ok(events.some((e) => e.type === 'approval.resolved' && e.requestId === third.requestId && e.decision === 'cancel'));
  });

  test(`${label}: stopping the turn denies a waiting app action`, async () => {
    const f = fakeChildren();
    const { deps, issued } = blobDeps();
    const d = make(deps, f.spawnFn);
    await d.startSession({ threadId: 'A2', agent, cwd: '/Blobs/kora', account: null, runtimeMode: 'auto' } as any);
    await d.sendTurn({ threadId: 'A2', text: 'x' } as any);
    const pending = issued[0].askApproval({ title: 't', detail: 'd', args: {} });
    await d.interruptTurn('A2');
    assert.equal(await pending, false);
  });
}

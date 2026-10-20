// CodexDriver permission posture: the composer's mode reaches `codex exec` argv (never a blanket bypass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexDriver, codexPermissionArgs } from './codex-driver';
import type { DriverDeps } from '../session-driver';

test('codexPermissionArgs: only full-access / auto bypass; the asking postures map to a sandbox', () => {
  assert.deepEqual(codexPermissionArgs('full-access'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexPermissionArgs('auto'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexPermissionArgs('auto-accept-edits'), ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"']);
  for (const m of ['approval-required', undefined] as const) {
    assert.deepEqual(codexPermissionArgs(m), ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"']);
  }
});

test('a Supervised Codex thread runs read-only, and a mid-session flip reaches the next turn', async () => {
  const argvs: string[][] = [];
  const spawnFn: any = (_cmd: string, args: string[]) => {
    argvs.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => { child.stdout.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'approval-required' } as any);
  await d.sendTurn({ threadId: 'T', text: '' } as any);
  assert.ok(!argvs[0].includes('--dangerously-bypass-approvals-and-sandbox'), argvs[0].join(' '));
  assert.ok(argvs[0].includes('sandbox_mode="read-only"'));
  assert.ok(events.some((e) => e.type === 'runtime.warning' && /read-only sandbox/.test(e.message)));
  await new Promise((r) => setTimeout(r, 20));
  await d.setPermissionMode('T', 'full-access');
  await d.sendTurn({ threadId: 'T', text: '' } as any);
  assert.ok(argvs[1].includes('--dangerously-bypass-approvals-and-sandbox'), argvs[1].join(' '));
});

// ── failures + usage (recorded event shapes, codex-cli 0.155.1) ─────────────────────
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { mapCodexEvent } from './codex-driver';

const posixOnly = { skip: process.platform === 'win32' ? "POSIX PATH fixtures" : false };

const LIMIT_MSG = 'You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 16th, 2026 8:25 PM.';

/** A fake `codex exec` child that prints `lines` then exits with `code`. */
function scriptedSpawn(lines: string[], code = 1): any {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => {
      for (const l of lines) child.stdout.write(`${l}\n`);
      child.stdout.end();
      setImmediate(() => { child.emit('exit', code, null); child.emit('close', code, null); });
    });
    return child;
  };
}

function codexDeps(env: Record<string, string> = {}): DriverDeps {
  return { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => env, appendSystemPrompt: () => undefined } as unknown as DriverDeps;
}

test('usage limit: error + turn.failed settle ONCE, surface ONE error, and raise a rate-limit with the reset time', async () => {
  const seq = [
    '{"type":"thread.started","thread_id":"01a0f97d-95cc-7921-a64f-94f5acdca342"}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: LIMIT_MSG }),
    JSON.stringify({ type: 'turn.failed', error: { message: LIMIT_MSG } }),
  ];
  const d = new CodexDriver(codexDeps({ CODEX_HOME: '/nonexistent-codex-home' }), scriptedSpawn(seq, 1));
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 50));
  const settled = events.filter((e) => e.type === 'turn.settled');
  assert.equal(settled.length, 1, JSON.stringify(settled));
  assert.equal(settled[0].state, 'failed');
  assert.equal(settled[0].errorMessage, LIMIT_MSG);
  assert.equal(events.filter((e) => e.type === 'runtime.error').length, 1);
  const rl = events.filter((e) => e.type === 'usage.rate-limit');
  assert.equal(rl.length, 1);
  assert.equal(rl[0].resetsAt, new Date(2026, 9, 16, 20, 25).getTime());
  const lim = events.find((e) => e.type === 'usage.limits');
  assert.equal(lim.report.provider, 'codex');
  assert.equal(lim.report.limited, true);
});

test('an `error` with no turn.failed still settles once, with the error text (not "codex exited")', async () => {
  const d = new CodexDriver(codexDeps(), scriptedSpawn(['{"type":"turn.started"}', JSON.stringify({ type: 'error', message: 'stream disconnected' })], 1));
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 50));
  const settled = events.filter((e) => e.type === 'turn.settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].errorMessage, 'stream disconnected');
  assert.equal(events.filter((e) => e.type === 'runtime.error').length, 1);
  assert.equal(events.filter((e) => e.type === 'usage.rate-limit').length, 0);
});

test('turn.completed: usage is the turn\'s cost (input net of cache), never a context reading', () => {
  const out = mapCodexEvent({ type: 'turn.completed', usage: { input_tokens: 91176, cached_input_tokens: 77312, output_tokens: 408, reasoning_output_tokens: 77 } }, { turnId: 'turn_1' });
  assert.deepEqual(out, [{ type: 'turn.settled', turnId: 'turn_1', state: 'completed', usage: { usageStatus: 'complete', inputTokens: 13864, outputTokens: 408, cachedInputTokens: 77312, reasoningTokens: 77 } }]);
});

test('after a turn the driver reads context + rate limits from the thread\'s rollout under CODEX_HOME', async () => {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codex-home-'));
  const tid = '01a0ecc6-6032-7940-a893-c8c67f3016ca';
  const dir = nodePath.join(home, 'sessions', '2026', '09', '29');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, `rollout-2026-09-29T16-16-58-${tid}.jsonl`), [
    '{"type":"session_meta","payload":{"id":"x"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":91176,"cached_input_tokens":77312,"output_tokens":408,"total_tokens":91584},"last_token_usage":{"input_tokens":15781,"output_tokens":36,"total_tokens":15817},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1786356596},"secondary":null,"plan_type":"plus","rate_limit_reached_type":null}}}',
    '',
  ].join('\n'));
  const seq = [`{"type":"thread.started","thread_id":"${tid}"}`, '{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":5}}'];
  const d = new CodexDriver(codexDeps({ CODEX_HOME: home }), scriptedSpawn(seq, 0));
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 100));
  const usage = events.find((e) => e.type === 'thread.token-usage');
  assert.ok(usage, JSON.stringify(events.map((e) => e.type)));
  assert.equal(usage.usage.usedTokens, 15817);
  assert.equal(usage.usage.maxTokens, 258400);
  assert.equal(usage.turnId, 'turn_' + usage.turnId.split('_')[1]);
  const lim = events.find((e) => e.type === 'usage.limits');
  assert.equal(lim.report.plan, 'Plus');
  assert.equal(lim.report.windows[0].usedPercent, 12.5);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Codex retry notices ("Reconnecting... 2/5") are warnings, never a failed turn', () => {
  const seen = new Set<string>();
  const out = mapCodexEvent({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: invalid peer certificate: UnknownIssuer)' }, { turnId: 'turn_1', errorsSeen: seen });
  assert.deepEqual(out.map((e) => e.type), ['runtime.warning']);
  assert.equal(seen.size, 0, 'a later real error still settles the turn with its own text');
});

// ── recorded signed-out / limited streams (journey QA, 2026-10-02) ──
test('a Codex usage limit (error + turn.failed + exit 1) is reported once, in Codex\'s own words', async () => {
  const LIMIT = "You've hit your usage limit. Upgrade to Pro or try again at Oct 16th, 2026 9:00 AM.";
  const spawnFn: any = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'th1' })}\n${JSON.stringify({ type: 'turn.started' })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'error', message: LIMIT })}\n${JSON.stringify({ type: 'turn.failed', error: { message: LIMIT } })}\n`);
      child.stderr.write('Error: usage limit\n');
      child.stdout.end(); child.emit('exit', 1, null); child.emit('close', 1, null);
    });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 30));
  const errors = events.filter((e) => e.type === 'runtime.error');
  const settled = events.filter((e) => e.type === 'turn.settled');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].message, LIMIT);
  assert.deepEqual(settled.map((e) => [e.state, e.errorMessage]), [['failed', LIMIT]]);
});

test('an `error` with no turn result: the exit reports that message, not a bare exit code', async () => {
  const spawnFn: any = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Not logged in. Run codex login.' })}\n`);
      child.stdout.end(); child.emit('exit', 1, null); child.emit('close', 1, null);
    });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 30));
  const errors = events.filter((e) => e.type === 'runtime.error');
  assert.deepEqual(errors.map((e) => e.message), ['Not logged in. Run codex login.']);
});

test('Codex 0.155 reconnect notices (`error` x10, then turn.failed) end in ONE failure, not ten', async () => {
  // Shape recorded from a real signed-out `codex exec --json` (2026-10-02), messages shortened.
  const lines = [
    { type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' },
    ...[2, 3, 4, 5].map((n) => ({ type: 'error', message: `Reconnecting... ${n}/5 (unexpected status 401 Unauthorized)` })),
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Falling back from WebSockets to HTTPS transport.' } },
    ...[1, 2, 3, 4, 5].map((n) => ({ type: 'error', message: `Reconnecting... ${n}/5 (unexpected status 401 Unauthorized)` })),
    { type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } },
  ];
  const spawnFn: any = () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    setImmediate(() => {
      child.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      child.stdout.end(); child.emit('exit', 1, null); child.emit('close', 1, null);
    });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.filter((e) => e.type === 'runtime.error').length, 1);
  assert.equal(events.filter((e) => e.type === 'turn.settled').length, 1);
  assert.match(events.find((e) => e.type === 'runtime.error').message, /401 Unauthorized/);
});

// B4 (night 2026-10-04, live on stack 2): a signed-out Codex sat ~17 s on "Reconnecting… n/5" (ten rows, shown as
// "Received 9 updates") before failing. A 401 is not a dropped stream: the turn fails at the first one, Codex is stopped.
test('a signed-out Codex (401 behind "Reconnecting…") fails at once and is stopped; transient reconnects are noted once', async () => {
  const seen = new Set<string>(); const notes = new Set<string>();
  const first = mapCodexEvent({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }, { turnId: 'turn_1', errorsSeen: seen, turnNotes: notes });
  const again = mapCodexEvent({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' }, { turnId: 'turn_1', errorsSeen: seen, turnNotes: notes });
  assert.deepEqual([first.length, again.length], [1, 0], 'one warning per turn');
  const auth = mapCodexEvent({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)' }, { turnId: 'turn_1', errorsSeen: seen, turnNotes: notes });
  assert.deepEqual(auth.map((e) => e.type), ['runtime.error']);
  assert.match((auth[0] as any).message, /^unexpected status 401 Unauthorized: Missing bearer/);

  let child: any;
  const spawnFn: any = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); return true; };
    setImmediate(() => {
      child.stdout.write([{ type: 'thread.started', thread_id: 'th' }, { type: 'turn.started' }, { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
      // …and Codex would keep retrying for ~17 s: no exit of its own here.
    });
    return child;
  };
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  await d.startSession({ threadId: 'T401', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'full-access' } as any);
  await d.sendTurn({ threadId: 'T401', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(child.killed, true, 'Codex is stopped instead of retrying');
  const settled = events.filter((e) => e.type === 'turn.settled');
  assert.deepEqual(settled.map((e) => e.state), ['failed']);
  assert.match(settled[0].errorMessage, /401 Unauthorized/);
  assert.equal(events.filter((e) => e.type === 'runtime.error').length, 1);
});

// ── engine not found (found live 2026-10-09: `spawn codex ENOENT` — the daemon's PATH has no ~/.local/bin) ─────────────
function enoentDriver(over: { resolve?: (n: string) => Promise<string | null>; spawn?: any }) {
  const calls: Array<{ cmd: string; PATH?: string }> = [];
  const spawnFn: any = over.spawn ?? ((cmd: string, _a: string[], o: any) => {
    calls.push({ cmd, PATH: o.env.PATH });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => { child.stdout.end(); child.emit('close', 0, null); });
    return child;
  });
  const deps = { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined } as unknown as DriverDeps;
  const d = new CodexDriver(deps, spawnFn, over.resolve);
  const events: any[] = [];
  d.streamEvents((e) => events.push(e));
  return { d, events, calls };
}
const failedWith = (events: any[]) => events.find((e) => e.type === 'turn.settled' && e.state === 'failed')?.errorMessage as string | undefined;

test('codex not found anywhere: the turn fails in words (Settings › Engines), no spawn attempted, no raw ENOENT', async () => {
  const { d, events, calls } = enoentDriver({ resolve: async () => null });
  await d.startSession({ threadId: 'E1', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'auto' } as any);
  await d.sendTurn({ threadId: 'E1', text: 'hi' } as any);
  const msg = failedWith(events)!;
  assert.match(msg, /Codex isn't installed or Kora can't find it/);
  assert.match(msg, /Settings › Engines/);
  assert.doesNotMatch(msg, /ENOENT/);
  assert.equal(calls.length, 0);
  assert.ok(events.some((e) => e.type === 'session.state' && e.state === 'ready'), 'the thread is usable again');
});

test('codex found outside the daemon PATH: spawned by absolute path with a widened PATH', posixOnly, async () => {
  const { d, calls } = enoentDriver({ resolve: async () => '/Users/x/.local/bin/codex' });
  await d.startSession({ threadId: 'E2', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'auto' } as any);
  await d.sendTurn({ threadId: 'E2', text: 'hi' } as any);
  assert.equal(calls[0]!.cmd, '/Users/x/.local/bin/codex');
  assert.ok(calls[0]!.PATH!.split(':')[0] === '/Users/x/.local/bin' && calls[0]!.PATH!.includes('/opt/homebrew/bin'));
});

test('a spawn that still dies with ENOENT (binary vanished) is turned into the same sentence and settles the turn', async () => {
  const throwing: any = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const a = enoentDriver({ resolve: async () => '/x/codex', spawn: throwing });
  await a.d.startSession({ threadId: 'E3', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'auto' } as any);
  await a.d.sendTurn({ threadId: 'E3', text: 'hi' } as any);
  assert.match(failedWith(a.events)!, /Codex isn't installed/);
  const asyncErr: any = () => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => { child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })); child.emit('close', -2, null); });
    return child;
  };
  const b = enoentDriver({ resolve: async () => '/x/codex', spawn: asyncErr });
  await b.d.startSession({ threadId: 'E4', agent: 'codex', cwd: '/tmp', account: null, runtimeMode: 'auto' } as any);
  await b.d.sendTurn({ threadId: 'E4', text: 'hi' } as any);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.events.filter((e) => e.type === 'turn.settled').length, 1, 'settled exactly once');
  assert.match(failedWith(b.events)!, /Codex isn't installed/);
  assert.doesNotMatch(JSON.stringify(b.events.filter((e) => e.type === 'runtime.error')), /ENOENT/);
});

test('mapCodexEvent: an MCP call is named by its tool (kora_spawn), not "mcp_tool_call"', () => {
  const [e] = mapCodexEvent({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'kora_fleet', tool: 'kora_spawn', arguments: {} } }, { startedTools: new Set() }) as any[];
  assert.equal(e.type, 'tool.started');
  assert.equal(e.toolName, 'kora_spawn');
  assert.equal(e.title, 'kora_spawn');
});

test('mapCodexEvent: a command announces tool.started at item.started and only its result at completion (audit fleet #1)', async () => {
  const { mapCodexEvent } = await import('./codex-driver');
  const ctx = { turnId: 'T1', streamedItems: new Set<string>(), startedTools: new Set<string>() };
  const started = mapCodexEvent({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'cargo test', status: 'in_progress' } }, ctx);
  assert.deepEqual(started.map((e) => e.type), ['tool.started']);
  assert.equal((started[0] as any).itemId, 'c1');
  assert.deepEqual(mapCodexEvent({ type: 'item.started', item: { id: 'c1', type: 'command_execution' } }, ctx), [], 'a repeat start is not re-sent');
  const done = mapCodexEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cargo test', exit_code: 0, aggregated_output: 'ok' } }, ctx);
  assert.deepEqual(done.map((e) => e.type), ['tool.result']);
  // Without a start seen (or without the ctx set), completion still sends the pair.
  const pair = mapCodexEvent({ type: 'item.completed', item: { id: 'c2', type: 'file_change', changes: [] } }, ctx);
  assert.deepEqual(pair.map((e) => e.type), ['tool.started', 'tool.result']);
  assert.deepEqual(mapCodexEvent({ type: 'item.completed', item: { id: 'c3', type: 'command_execution' } }, { turnId: 'T1' }).map((e) => e.type), ['tool.started', 'tool.result']);
  // A non-tool item.started without a delta still maps to nothing.
  assert.deepEqual(mapCodexEvent({ type: 'item.started', item: { id: 'm1', type: 'agent_message' } }, ctx), []);
});

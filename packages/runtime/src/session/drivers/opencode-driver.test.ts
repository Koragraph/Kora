// OpenCodeDriver: the `opencode run --format json` parser against fixtures captured live (opencode 1.18.32, 2026-10-08),
// the permission policy, and the per-turn child with a fake spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { OpenCodeDriver, opencodePermissionEnv, OPENCODE_BASH_DENY } from './opencode-driver';
import { mapOpencodeEvent, newOpencodeTurnState, drainOpencodeLines, opencodeOutputText, opencodeTurnUsage, describeOpencodeError, opencodeToolKind } from './opencode-parse';
import type { ChatEvent } from '../events';
import type { DriverDeps } from '../session-driver';

// ── fixtures: real output, ids shortened ─────────────────────────────────────────────────────────
const TEXT_TURN = [
  '{"type":"step_start","timestamp":1791458930002,"sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","type":"step-start"}}',
  '{"type":"text","timestamp":1791458930192,"sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","part":{"id":"prt_2","messageID":"msg_1","sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","type":"text","text":"hi there","time":{"start":1791458930116,"end":1791458930183}}}',
  '{"type":"step_finish","timestamp":1791458930192,"sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","part":{"id":"prt_3","reason":"stop","messageID":"msg_1","sessionID":"ses_ee4ba33b3ffeuWcuXLhIzQX5D7","type":"step-finish","tokens":{"total":15233,"input":15156,"output":4,"reasoning":9,"cache":{"write":0,"read":64}},"cost":0}}',
].join('\n') + '\n';
const TOOL_THEN_429 = [
  '{"type":"step_start","timestamp":1791458832398,"sessionID":"ses_ee4bc4245ffe9m6b8cOd5WvGcR","part":{"id":"prt_a","type":"step-start"}}',
  '{"type":"tool_use","timestamp":1791458834181,"sessionID":"ses_ee4bc4245ffe9m6b8cOd5WvGcR","part":{"type":"tool","tool":"write","callID":"call_d2ce3d07712e4cfe8b9a0c7a","state":{"status":"completed","input":{"content":"hi","filePath":"/w/hello.txt"},"output":"Wrote file successfully.","metadata":{"filepath":"/w/hello.txt"},"title":"w/hello.txt","time":{"start":1791458834171,"end":1791458834180}},"id":"prt_b","sessionID":"ses_ee4bc4245ffe9m6b8cOd5WvGcR","messageID":"msg_b"}}',
  '{"type":"step_finish","timestamp":1791458834231,"sessionID":"ses_ee4bc4245ffe9m6b8cOd5WvGcR","part":{"id":"prt_c","reason":"tool-calls","type":"step-finish","tokens":{"total":16216,"input":16018,"output":116,"reasoning":82,"cache":{"write":0,"read":0}},"cost":0}}',
  '{"type":"error","timestamp":1791458911509,"sessionID":"ses_ee4bc4245ffe9m6b8cOd5WvGcR","error":{"name":"APIError","data":{"message":"Upstream request failed: Endpoint is unavailable.","statusCode":429,"isRetryable":true,"responseHeaders":{"cf-ray":"x"},"responseBody":"{\\"error\\":{\\"type\\":\\"server_error\\",\\"message\\":\\"Upstream request failed: Endpoint is unavailable.\\"}}","metadata":{"url":"https://opencode.ai/zen/v1/chat/completions"}}}}',
].join('\n') + '\n';

const run = (jsonl: string, turnId = 'T') => {
  const st = newOpencodeTurnState();
  const out = drainOpencodeLines(jsonl).events.flatMap((e) => mapOpencodeEvent(e, st, turnId));
  return { st, out };
};

test('parser: a text turn -> thread id, one assistant delta, token usage and a finished state', () => {
  const { st, out } = run(TEXT_TURN);
  assert.deepEqual(out.map((e) => e.type), ['thread.started', 'content.delta', 'thread.token-usage']);
  assert.equal((out[0] as any).providerThreadId, 'ses_ee4ba33b3ffeuWcuXLhIzQX5D7');
  assert.deepEqual({ ...(out[1] as any) }, { type: 'content.delta', itemId: 'prt_2', stream: 'assistant_text', delta: 'hi there', turnId: 'T' });
  assert.equal(st.finished, true);
  assert.deepEqual(opencodeTurnUsage(st), { usageStatus: 'complete', inputTokens: 15156, outputTokens: 4, cachedInputTokens: 64, reasoningTokens: 9 });
  assert.deepEqual(opencodeOutputText(TEXT_TURN), { text: 'hi there', error: null, rateLimited: false });
});

test('parser: a tool call becomes a started+result pair with the changed file; a 429 becomes a calm rate-limit + error', () => {
  const { st, out } = run(TOOL_THEN_429);
  const types = out.map((e) => e.type);
  assert.deepEqual(types, ['thread.started', 'tool.started', 'tool.result', 'thread.token-usage', 'usage.rate-limit', 'runtime.error']);
  const started = out[1] as any; const result = out[2] as any;
  assert.equal(started.toolKind, 'file_change');
  assert.equal(started.title, 'write /w/hello.txt');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.changedFiles, [{ path: '/w/hello.txt', additions: 0, deletions: 0 }]);
  assert.equal(st.rateLimited, true);
  assert.equal(st.finished, false, 'the last step was a tool call, not a stop');
  const err = out[5] as any;
  assert.match(err.message, /rate-limited or busy/);
  assert.doesNotMatch(err.message, /Upstream request failed/, 'no raw provider text');
  assert.equal(opencodeOutputText(TOOL_THEN_429).rateLimited, true);
  assert.deepEqual(describeOpencodeError({ data: { message: 'bad key', statusCode: 401 } }).rateLimited, false);
  assert.equal(opencodeToolKind('bash'), 'command_execution');
  assert.equal(opencodeToolKind('webfetch'), 'web_search');
  assert.equal(opencodeToolKind('read'), 'file_read');
});

test('parser: unknown / malformed events are ignored, never throw; the same error twice is shown once', () => {
  const { out } = run('{"type":"mystery","x":1}\nnot json\n{"type":"error","error":{"data":{"message":"x boom","statusCode":500}}}\n{"type":"error","error":{"data":{"message":"x boom","statusCode":500}}}\n');
  assert.equal(out.filter((e) => e.type === 'runtime.error').length, 1);
  assert.deepEqual(drainOpencodeLines('{"a":1}\n{"b":').rest, '{"b":');
});

test('permission env per posture: read-only / workspace + denies / everything', () => {
  const ro = JSON.parse(opencodePermissionEnv('approval-required').OPENCODE_PERMISSION);
  assert.equal(ro['*'], 'ask'); assert.equal(ro.read, 'allow'); assert.equal(ro.edit, undefined); assert.equal(ro.question, 'deny');
  const auto = JSON.parse(opencodePermissionEnv('auto-accept-edits', { blobHome: '/kh/blobs/b1' }).OPENCODE_PERMISSION);
  assert.equal(auto.edit, 'allow'); assert.equal(auto.bash['*'], 'allow'); assert.equal(auto.bash['curl *'], 'deny'); assert.equal(auto.bash['git push*'], 'deny');
  assert.deepEqual(auto.external_directory, { '/kh/blobs/b1/**': 'allow' });
  assert.equal(JSON.parse(opencodePermissionEnv('auto-accept-edits').OPENCODE_PERMISSION).external_directory, 'deny');
  const full = JSON.parse(opencodePermissionEnv('full-access').OPENCODE_PERMISSION);
  assert.equal(full['*'], 'allow'); assert.equal(full.question, 'deny'); assert.equal(full.bash['*'], 'allow');
  // A pattern kill is denied even in Full access (it stops other agents' processes).
  assert.equal(full.bash['pkill *'], 'deny'); assert.equal(full.bash['killall *'], 'deny'); assert.equal(auto.bash['pkill *'], 'deny');
  assert.ok(OPENCODE_BASH_DENY.includes('osascript *'));
});

test('a plan turn is read-only in every posture: no edit, no bash allow beyond the graph reads', () => {
  for (const mode of ['full-access', 'auto', 'auto-accept-edits', 'approval-required', undefined] as const) {
    const p = JSON.parse(opencodePermissionEnv(mode, { plan: true }).OPENCODE_PERMISSION);
    assert.equal(p['*'], 'deny', String(mode));
    assert.equal(p.edit, undefined, `${mode}: edit falls to the catch-all deny`);
    assert.equal(p.bash['*'], 'deny', String(mode));
    assert.equal(p.bash['kora graph explore *'], 'allow');
    assert.equal(p.bash['kora graph prune *'], undefined);
    assert.equal(p.read, 'allow'); assert.equal(p.question, 'deny');
    assert.ok(!Object.entries(p.bash).some(([k, v]) => v === 'allow' && !/^kora(-dev)? graph /.test(k)), `${mode}: only graph reads are allowed in bash`);
  }
});

// ── the driver with a fake child ─────────────────────────────────────────────────────────────────
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const children: any[] = [];
  const spawnFn = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, cwd: o.cwd, env: o.env });
    const c: any = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.killed = false;
    c.kill = (sig: string) => { c.killed = true; setImmediate(() => c.emit('close', null, sig)); return true; };
    children.push(c);
    return c;
  };
  return { spawnFn: spawnFn as never, calls, children };
}
function makeDriver(over: Partial<DriverDeps> = {}, opts?: import('./opencode-driver').OpencodeDriverOptions) {
  const f = fakeSpawn();
  const marks: string[] = [];
  const deps: DriverDeps = {
    graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => ({ id: 'p', agent: 'opencode', account: null }),
    spawnEnv: () => ({}), appendSystemPrompt: () => 'BLOB PROMPT',
    opencode: { binary: () => '/bin/opencode', pickModel: () => 'opencode/big-pickle', env: (m) => ({ OPENCODE_CONFIG_CONTENT: `{"m":"${m}"}` }), markCooling: (m, r) => marks.push(`${m}:${r}`) },
    ...over,
  };
  const d = new OpenCodeDriver(deps, f.spawnFn, opts);
  const events: ChatEvent[] = [];
  d.streamEvents((e) => events.push(e));
  return { d, f, events, marks };
}
const settle = (events: ChatEvent[]) => events.filter((e) => e.type === 'turn.settled') as Array<Extract<ChatEvent, { type: 'turn.settled' }>>;

test('driver: the picked effort rides as `--variant`, only with the model it was picked for', async () => {
  const { d, f } = makeDriver();
  await d.startSession({ threadId: 'T1', agent: 'opencode', cwd: '/blob/ws', account: null, runtimeMode: 'auto-accept-edits', model: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', effort: 'high' } as any });
  await d.sendTurn({ threadId: 'T1', text: 'hi' });
  const a = f.calls[0].args;
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 4), ['-m', 'opencode/muse-spark-1.3-contributor-free', '--variant', 'high']);
  const plain = makeDriver();
  await plain.d.startSession({ threadId: 'T2', agent: 'opencode', cwd: '/blob/ws', account: null, runtimeMode: 'auto-accept-edits' });
  await plain.d.sendTurn({ threadId: 'T2', text: 'hi' });
  assert.ok(!plain.f.calls[0].args.includes('--variant'), 'no pick, no variant');
});

test('driver: a turn spawns `opencode run --pure --format json … -- <prompt>`, streams, settles with usage, keeps the session id for -s', async () => {
  const { d, f, events } = makeDriver();
  await d.startSession({ threadId: 'T1', agent: 'opencode', cwd: '/blob/ws', account: null, runtimeMode: 'auto-accept-edits' });
  await d.sendTurn({ threadId: 'T1', text: 'hello', koraNotice: '<memory>x</memory>' });
  const c = f.calls[0];
  assert.equal(c.cmd, '/bin/opencode');
  assert.deepEqual(c.args.slice(0, 5), ['run', '--pure', '--format', 'json', '-m']);
  assert.equal(c.args[5], 'opencode/big-pickle');
  assert.equal(c.args.at(-2), '--');
  assert.match(c.args.at(-1)!, /^BLOB PROMPT\n\n---\n\n<memory>x<\/memory>\n\nhello$/, 'the persona prompt rides in front of the first turn only');
  assert.equal(c.cwd, '/blob/ws');
  assert.equal(c.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(c.env.OPENCODE_CONFIG_CONTENT, '{"m":"opencode/big-pickle"}');
  assert.equal(JSON.parse(c.env.OPENCODE_PERMISSION!).edit, 'allow');
  f.children[0].stdout.write(TEXT_TURN);
  f.children[0].emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  const s = settle(events);
  assert.equal(s.length, 1);
  assert.equal(s[0].state, 'completed');
  assert.equal(s[0].usage?.outputTokens, 4);
  assert.ok(events.some((e) => e.type === 'content.delta' && (e as any).delta === 'hi there'));
  assert.ok(events.some((e) => e.type === 'thread.started' && (e as any).providerThreadId === 'ses_ee4ba33b3ffeuWcuXLhIzQX5D7'));
  await d.sendTurn({ threadId: 'T1', text: 'again' });
  const c2 = f.calls[1];
  assert.deepEqual(c2.args.slice(c2.args.indexOf('-s'), c2.args.indexOf('-s') + 2), ['-s', 'ses_ee4ba33b3ffeuWcuXLhIzQX5D7']);
  assert.equal(c2.args.at(-1), 'again', 'no second persona prefix');
});

test('driver: a rate limit settles the turn failed with a clean message, cools the model, offers the notice event', async () => {
  const { d, f, events, marks } = makeDriver();
  await d.startSession({ threadId: 'T2', agent: 'opencode', cwd: '/w', account: null });
  await d.sendTurn({ threadId: 'T2', text: 'go' });
  f.children[0].stdout.write(TOOL_THEN_429);
  f.children[0].emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  const s = settle(events);
  assert.equal(s[0].state, 'failed');
  assert.match(s[0].errorMessage!, /rate-limited right now/);
  assert.equal(events.filter((e) => e.type === 'usage.rate-limit').length, 1, 'the notice goes out once, with its reset time');
  assert.ok(typeof (events.find((e) => e.type === 'usage.rate-limit') as any).resetsAt === 'number');
  assert.deepEqual(marks, ['opencode/big-pickle:rate-limited']);
});

test('driver: a plan turn in Full access runs the plan agent with the read-only env and no --auto; the next Build turn is back to normal', async () => {
  const { d, f } = makeDriver();
  await d.startSession({ threadId: 'TP', agent: 'opencode', cwd: '/w', account: null, runtimeMode: 'full-access' });
  await d.sendTurn({ threadId: 'TP', text: 'plan it', interactionMode: 'plan' });
  const plan = f.calls[0]!;
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--agent'), plan.args.indexOf('--agent') + 2), ['--agent', 'plan']);
  assert.ok(!plan.args.includes('--auto'));
  assert.equal(plan.env.PWD, '/w', "the run works in the thread's folder, not the daemon's PWD");
  const env = JSON.parse(plan.env.OPENCODE_PERMISSION!);
  assert.equal(env['*'], 'deny'); assert.equal(env.bash['*'], 'deny'); assert.equal(env.edit, undefined);
  f.children[0].stdout.end(); f.children[0].emit('close', 0, null);
  await new Promise((r) => setTimeout(r, 20));
  await d.sendTurn({ threadId: 'TP', text: 'now build it', interactionMode: 'default' });
  const build = f.calls[1]!;
  assert.ok(build.args.includes('--auto') && !build.args.includes('--agent'));
  assert.equal(JSON.parse(build.env.OPENCODE_PERMISSION!)['*'], 'allow');
});

test('driver: not installed / no free model / spawn failure fail the turn calmly; interrupt settles interrupted; full access adds --auto', async () => {
  const none = makeDriver({ opencode: { binary: () => null, pickModel: () => null, env: () => ({}), markCooling: () => {} } });
  await none.d.startSession({ threadId: 'T7', agent: 'opencode', cwd: '/w', account: null });
  await none.d.sendTurn({ threadId: 'T7', text: 'x' });
  assert.match(settle(none.events)[0].errorMessage!, /not installed/);
  const nomodel = makeDriver({ opencode: { binary: () => '/bin/oc', pickModel: () => null, env: () => ({}), markCooling: () => {} } });
  await nomodel.d.startSession({ threadId: 'T4', agent: 'opencode', cwd: '/w', account: null });
  await nomodel.d.sendTurn({ threadId: 'T4', text: 'x' });
  assert.match(settle(nomodel.events)[0].errorMessage!, /No free model/);
  const { d, f, events } = makeDriver();
  await d.startSession({ threadId: 'T5', agent: 'opencode', cwd: '/w', account: null, runtimeMode: 'full-access' });
  await d.sendTurn({ threadId: 'T5', text: 'x' });
  assert.ok(f.calls[0].args.includes('--auto'));
  await d.interruptTurn('T5');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settle(events)[0].state, 'interrupted');
  await d.stopSession('T5');
  assert.equal(d.hasSession('T5'), false);
  // a hostile resume value never reaches argv
  const h = makeDriver();
  await h.d.startSession({ threadId: 'T6', agent: 'opencode', cwd: '/w', account: null, resume: '--dangerous' });
  await h.d.sendTurn({ threadId: 'T6', text: 'x' });
  assert.ok(!h.f.calls[0].args.includes('-s'));
});

// ── a silent rate-limit retry (found live: 13 minutes of "working") ──────────────────────────────────────────────────
// Real lines from opencode's own log (ids shortened); the process never exits and prints nothing on stdout.
const LOG_MAIN = (iso: string, model: string, sid: string) => `timestamp=${iso} level=ERROR run=f46f008b message="stream error" providerID=opencode modelID=${model} session.id=${sid} small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n`;
const LOG_TITLE = (iso: string, model: string, sid: string) => `timestamp=${iso} level=ERROR run=f46f008b message="stream error" providerID=opencode modelID=${model} session.id=${sid} small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: Rate limit exceeded. Please try again later."\n`;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-log-')), 'opencode.log');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('driver: a silent rate-limit retry (log line, no stdout) is cut within the grace period: clean error, model cooled, card event with a reset time, child killed', async () => {
  const logPath = tmpLog(); fs.writeFileSync(logPath, LOG_MAIN('2026-10-08T21:00:00.000Z', 'big-pickle', 'ses_old'));
  const { d, f, events, marks } = makeDriver({}, { logPath, pollMs: 15, graceMs: 60 });
  await d.startSession({ threadId: 'RL1', agent: 'opencode', cwd: '/w', account: null, runtimeMode: 'auto-accept-edits' });
  await d.sendTurn({ threadId: 'RL1', text: 'go' });
  await wait(100);
  assert.equal(settle(events).length, 0, 'an OLD limit line from an earlier run does not count');
  fs.appendFileSync(logPath, LOG_TITLE(new Date().toISOString(), 'big-pickle', 'ses_new'));
  await wait(100);
  assert.equal(settle(events).length, 0, 'the title helper failing says nothing about the turn');
  fs.appendFileSync(logPath, LOG_MAIN(new Date().toISOString(), 'big-pickle', 'ses_new'));
  await wait(250);
  const s = settle(events);
  assert.equal(s.length, 1);
  assert.equal(s[0].state, 'failed');
  assert.match(s[0].errorMessage!, /big-pickle is rate-limited right now/);
  assert.doesNotMatch(s[0].errorMessage!, /Rate limit exceeded|AI_API/);
  const rl = events.filter((e) => e.type === 'usage.rate-limit') as any[];
  assert.equal(rl.length, 1);
  assert.ok(rl[0].resetsAt > Date.now());
  assert.deepEqual(marks, ['opencode/big-pickle:rate-limited']);
  assert.ok(f.children[0].killed, 'the retrying child is stopped');
  assert.equal(events.filter((e) => e.type === 'session.state' && (e as any).state === 'ready').length >= 1, true);
  // the next message works: a fresh child spawns
  await d.sendTurn({ threadId: 'RL1', text: 'again' });
  assert.equal(f.calls.length, 2);
  await d.stopSession('RL1');
});

test('driver: a rate limit that recovers (progress after the log line) is NOT cut', async () => {
  const logPath = tmpLog(); fs.writeFileSync(logPath, '');
  const { d, f, events } = makeDriver({}, { logPath, pollMs: 15, graceMs: 120 });
  await d.startSession({ threadId: 'RL2', agent: 'opencode', cwd: '/w', account: null });
  await d.sendTurn({ threadId: 'RL2', text: 'go' });
  fs.appendFileSync(logPath, LOG_MAIN(new Date().toISOString(), 'big-pickle', 'ses_x'));
  await wait(40);
  f.children[0].stdout.write(TEXT_TURN); // opencode got through on a retry
  await wait(250);
  assert.equal(settle(events).length, 0, 'still working, nothing cut');
  assert.ok(!f.children[0].killed);
  f.children[0].emit('close', 0, null);
  await wait(10);
  assert.equal(settle(events)[0].state, 'completed');
});

test('driver: stderr text and a stdout error event that never exits are cut the same way', async () => {
  const logPath = tmpLog();
  const a = makeDriver({}, { logPath, pollMs: 15, graceMs: 50 });
  await a.d.startSession({ threadId: 'RL3', agent: 'opencode', cwd: '/w', account: null });
  await a.d.sendTurn({ threadId: 'RL3', text: 'go' });
  a.f.children[0].stderr.write('ProviderError: 429 Too Many Requests\n');
  await wait(200);
  assert.equal(settle(a.events)[0].state, 'failed');
  const b = makeDriver({}, { logPath, pollMs: 15, graceMs: 50 });
  await b.d.startSession({ threadId: 'RL4', agent: 'opencode', cwd: '/w', account: null });
  await b.d.sendTurn({ threadId: 'RL4', text: 'go' });
  b.f.children[0].stdout.write(TOOL_THEN_429); // opencode printed the error but keeps retrying
  await wait(200);
  assert.equal(settle(b.events)[0].state, 'failed');
  assert.match(settle(b.events)[0].errorMessage!, /rate-limited right now/);
});

test('limits: the log scanner takes the main agent only, the right model and session, nothing older than the turn', async () => {
  const { scanOpencodeLog, rateLimitMessage } = await import('./opencode-limits');
  const text = LOG_MAIN('2026-10-08T22:59:52.845Z', 'space-bunny-free', 'ses_a') + LOG_TITLE('2026-10-08T22:59:58.544Z', 'space-bunny-free', 'ses_a') + LOG_MAIN('2026-10-08T23:10:00.000Z', 'big-pickle', 'ses_b');
  assert.equal(scanOpencodeLog(text).length, 2, 'the title helper line is skipped');
  assert.equal(scanOpencodeLog(text, { model: 'opencode/space-bunny-free' }).length, 1);
  assert.equal(scanOpencodeLog(text, { model: 'opencode/space-bunny-free:free' }).length, 1);
  assert.equal(scanOpencodeLog(text, { sessionId: 'ses_b' }).length, 1);
  assert.equal(scanOpencodeLog(text, { since: Date.parse('2026-10-08T23:00:00Z') }).length, 1);
  assert.equal(scanOpencodeLog('timestamp=2026-10-08T22:59:51.724Z level=INFO message=process\n').length, 0);
  assert.match(rateLimitMessage('opencode/big-pickle'), /^big-pickle is rate-limited/);
});

test('mapOpencodeEvent: a running tool_use announces tool.started; its completion sends only the result (audit fleet #1)', () => {
  const st = newOpencodeTurnState();
  const ev = (status: string) => ({ type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'k1', state: { status, input: { command: 'pnpm test' }, ...(status === 'completed' ? { output: 'ok' } : {}) } } });
  assert.deepEqual(mapOpencodeEvent(ev('running'), st, 'T').map((e) => e.type), ['tool.started']);
  assert.deepEqual(mapOpencodeEvent(ev('running'), st, 'T').map((e) => e.type), [], 'a second running update is not re-sent');
  assert.deepEqual(mapOpencodeEvent(ev('completed'), st, 'T').map((e) => e.type), ['tool.result']);
  assert.deepEqual(mapOpencodeEvent({ ...ev('completed'), part: { ...ev('completed').part, callID: 'k2' } }, st, 'T').map((e) => e.type), ['tool.started', 'tool.result']);
});

test('driver: an orchestrator thread gets the kora_fleet MCP server in the per-run config (identity on argv), helpers-off does not', async () => {
  const { withOpencodeFleetMcp } = await import('./opencode-driver');
  const base = { threadId: 'T9', agent: 'opencode' as const, cwd: '/ws', account: null, runtimeMode: 'auto-accept-edits' as const };
  const on = makeDriver({ socketPath: '/s.sock', binPath: '/k/kora.js' });
  await on.d.startSession({ ...base, isOrchestrator: true, agentMode: 'swarm' });
  await on.d.sendTurn({ threadId: 'T9', text: 'go' });
  const cfg = JSON.parse(on.f.calls[0].env.OPENCODE_CONFIG_CONTENT!);
  assert.equal(cfg.m, 'opencode/big-pickle', 'the engine config is kept');
  const cmd: string[] = cfg.mcp.kora_fleet.command;
  assert.equal(cfg.mcp.kora_fleet.type, 'local');
  assert.deepEqual(cmd.slice(1, 4), ['/k/kora.js', 'mcp', '--fleet']);
  assert.equal(cmd[cmd.indexOf('--agent') + 1], 'opencode');
  assert.equal(cmd[cmd.indexOf('--orchestrator') + 1], 'chat:T9');
  assert.equal(cmd[cmd.indexOf('--agent-mode') + 1], 'swarm');
  assert.equal(cmd[cmd.indexOf('--socket') + 1], '/s.sock');

  const off = makeDriver({ socketPath: '/s.sock', binPath: '/k/kora.js' });
  await off.d.startSession({ ...base, isOrchestrator: true, helpersOff: true });
  await off.d.sendTurn({ threadId: 'T9', text: 'go' });
  assert.equal(off.f.calls[0].env.OPENCODE_CONFIG_CONTENT, '{"m":"opencode/big-pickle"}');
  const plain = makeDriver({ socketPath: '/s.sock', binPath: '/k/kora.js' });
  await plain.d.startSession(base);
  await plain.d.sendTurn({ threadId: 'T9', text: 'go' });
  assert.equal(plain.f.calls[0].env.OPENCODE_CONFIG_CONTENT, '{"m":"opencode/big-pickle"}');
  assert.deepEqual(JSON.parse(withOpencodeFleetMcp('not json', { command: 'n', args: ['a'] })).mcp.kora_fleet.command, ['n', 'a']);
});

// AntigravityDriver against a scripted fake `agy` (fixtures/agy/*.ndjson, recorded live from agy 1.3.3): text streaming,
// tool steps, usage, resume, stop, errors and the posture flags. No real `agy` is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AntigravityDriver, agyPermissionArgs, agyPostureNotice, agyTurnArgs, mapAgyEvent, newAgyTurnState, agyTurnUsage, agyErrorMessage, agyModelWorkedForTests, drainAgyLines, AGY_FIRST_TURN_RULE,
} from './antigravity-driver';
import type { DriverDeps } from '../session-driver';
import { retryableErrorText } from '../../server/error-stall';

const FIX_DIR = [path.join(__dirname, 'fixtures', 'agy'), path.resolve(__dirname, '../../../src/session/drivers/fixtures/agy')].find((p) => fs.existsSync(p))!;
const fixture = (name: string): string[] => fs.readFileSync(path.join(FIX_DIR, `${name}.ndjson`), 'utf8').split('\n').filter((l) => l.trim());
const events = (name: string) => fixture(name).map((l) => JSON.parse(l));

interface FakeChild extends EventEmitter { stdout: PassThrough; stderr: PassThrough; killed: boolean; exitCode: number | null; signalCode: string | null; kill(sig?: string): boolean; signals: string[] }

/** A fake agy: prints `lines` (and `stderr`), then exits with `code`; `hang` keeps it running until killed. */
function fakeAgy(script: Array<{ lines: string[]; code?: number; stderr?: string; hang?: boolean }>) {
  const argvs: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const children: FakeChild[] = [];
  let n = 0;
  const spawnFn: any = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    argvs.push(args); envs.push(opts.env);
    const s = script[Math.min(n++, script.length - 1)]!;
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.exitCode = null; child.signalCode = null; child.signals = [];
    const exit = (code: number | null, sig: string | null) => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.exitCode = code; child.signalCode = sig;
      child.stdout.end(); child.stderr.end();
      setImmediate(() => { child.emit('exit', code, sig); child.emit('close', code, sig); });
    };
    child.kill = (sig = 'SIGTERM') => { child.killed = true; child.signals.push(sig); exit(null, sig); return true; };
    children.push(child);
    setImmediate(() => {
      if (s.stderr) child.stderr.write(s.stderr);
      for (const l of s.lines) child.stdout.write(`${l}\n`);
      if (!s.hang) exit(s.code ?? 0, null);
    });
    return child;
  };
  return { spawnFn, argvs, envs, children };
}

function deps(over: Partial<DriverDeps> = {}): DriverDeps {
  return { graphCall: async () => ({ text: '', data: null, ms: 0 }), spawnWorker: async () => { throw new Error('no'); }, spawnEnv: () => ({}), appendSystemPrompt: () => undefined, ...over } as unknown as DriverDeps;
}

async function settled(evs: any[], count = 1, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (evs.filter((e) => e.type === 'turn.settled').length < count) {
    if (Date.now() - t0 > ms) throw new Error(`no turn.settled in ${ms} ms: ${evs.map((e) => e.type).join(',')}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const start = (d: AntigravityDriver, over: Record<string, unknown> = {}) =>
  d.startSession({ threadId: 'T', agent: 'antigravity', cwd: '/tmp', account: null, runtimeMode: 'full-access', model: { model: 'gemini-3.8-flash-low' }, ...over } as any);

// ── pure ─────────────────────────────────────────────────────────────────────
test('posture flags: only postures that never wait, plan wins', () => {
  assert.deepEqual(agyPermissionArgs('full-access'), ['--dangerously-skip-permissions']);
  assert.deepEqual(agyPermissionArgs('auto'), ['--dangerously-skip-permissions']);
  assert.deepEqual(agyPermissionArgs('auto-accept-edits'), ['--mode=accept-edits']);
  assert.deepEqual(agyPermissionArgs('approval-required'), []);
  assert.deepEqual(agyPermissionArgs(undefined), []);
  assert.deepEqual(agyPermissionArgs('full-access', 'plan'), ['--mode=plan']);
  assert.equal(agyPostureNotice('full-access'), null);
  assert.match(agyPostureNotice('auto-accept-edits')!, /skips shell commands/);
  assert.match(agyPostureNotice('approval-required')!, /skips edits and commands/);
});

test('argv: the prompt and ids ride as --flag=value (a prompt starting with "-" is never a flag)', () => {
  const a = agyTurnArgs({ prompt: '--dangerously-skip-permissions', model: 'gemini-3.8-flash-low', effort: 'low', conversationId: 'abc-123', mode: 'approval-required' });
  assert.deepEqual(a, ['--print=--dangerously-skip-permissions', '--model=gemini-3.8-flash-low', '--effort=low', '--conversation=abc-123', '--output-format=stream-json', '--print-timeout=0']);
});

test('text fixture: deltas stream in order, usage comes from the steps', () => {
  const st = newAgyTurnState();
  const out = events('text').flatMap((e) => mapAgyEvent(e, st, 'turn1'));
  assert.equal(out[0]!.type, 'thread.started');
  assert.equal((out[0] as any).providerThreadId, 'dbed22fc-eb40-4753-b403-4bc61f44285b');
  const text = out.filter((e) => e.type === 'content.delta').map((e: any) => e.delta).join('');
  assert.equal(text.trim(), Array.from({ length: 40 }, (_, i) => i + 1).join(' '));
  assert.ok(out.every((e: any) => e.type === 'thread.started' || e.turnId === 'turn1'));
  assert.deepEqual(agyTurnUsage(st), { usageStatus: 'complete', inputTokens: 11812, outputTokens: 110 });
  assert.equal(st.lastContext, 11922);
  assert.deepEqual(st.result, { ok: true, denied: [] });
});

test('tools fixture: run_command / view_file / write_to_file become rows with kinds, titles, output and changed files', () => {
  const st = newAgyTurnState();
  const out = events('tools').flatMap((e) => mapAgyEvent(e, st));
  const started = out.filter((e) => e.type === 'tool.started') as any[];
  assert.deepEqual(started.map((e) => [e.toolKind, e.title]), [
    ['command_execution', '$ ls'], ['file_read', 'read /private/tmp/agy-probe/hello.txt'], ['file_change', 'edit /private/tmp/agy-probe/out.txt'],
  ]);
  const results = out.filter((e) => e.type === 'tool.result') as any[];
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.equal(results[0].output, 'hello.txt\r\n');
  assert.deepEqual(results[2].changedFiles, [{ path: '/private/tmp/agy-probe/out.txt', additions: 0, deletions: 0 }]);
  // one row per step: ACTIVE opens it, DONE closes it (no duplicate tool.started)
  assert.equal(new Set(started.map((e) => e.itemId)).size, 3);
  // four model requests in this turn; the result's usage (48415) is the same sum here, but on a resume it is cumulative
  assert.equal(agyTurnUsage(st)!.inputTokens, 11830 + 11975 + 12210 + 12400);
});

test('denied fixture: the auto-denied write is a declined row and the result lists it', () => {
  const st = newAgyTurnState();
  const out = events('denied').flatMap((e) => mapAgyEvent(e, st));
  const r = out.find((e) => e.type === 'tool.result') as any;
  assert.equal(r.status, 'declined');
  assert.match(r.output, /user denied permission/);
  assert.doesNotMatch(r.output, /Do not attempt/);
  assert.deepEqual(st.result, { ok: true, denied: ['WriteToFile'] });
});

test('resume fixture: the turn counts only its own steps, not the conversation-wide result usage', () => {
  const st = newAgyTurnState('ba905704-5d13-4129-b3a2-21a516156735');
  events('resume').forEach((e) => mapAgyEvent(e, st));
  assert.equal(agyTurnUsage(st)!.inputTokens, 12631 + 12821); // result says 73867 (every turn of the conversation)
  assert.deepEqual(st.result?.denied, ['RunCommand']);
});

test('drainAgyLines keeps a partial line and skips non-JSON text', () => {
  const { events: ev, rest } = drainAgyLines('warning: x\n{"event":"init","conversation_id":"c"}\n{"event":"res');
  assert.equal(ev.length, 1);
  assert.equal(rest, '{"event":"res');
});

test('error copy is calm and specific', () => {
  assert.match(agyErrorMessage('error: invalid model selection (--model "x")…', 'x'), /does not offer the model "x"/);
  assert.match(agyErrorMessage('Error: you are not signed in'), /not signed in\. Run `agy`/);
  assert.match(agyErrorMessage('RESOURCE_EXHAUSTED: quota exceeded'), /usage limit/);
  assert.match(agyErrorMessage('boom\nstack…'), /^Antigravity stopped: boom$/);
  assert.equal(retryableErrorText(agyErrorMessage('error: invalid model selection (--model "x")…', 'x')), null, 'an unknown model is not retried');
  // Offline, agy calls every model unknown: one that already answered here reads as a network problem, so it is retried.
  agyModelWorkedForTests('y');
  const offline = agyErrorMessage('error: invalid model selection (--model "y")…', 'y');
  assert.match(offline, /could not load its model list/);
  assert.equal(retryableErrorText(offline)?.kind, 'transient');
});

// ── the driver ───────────────────────────────────────────────────────────────
test('a turn streams text, settles with usage, reports context, and the next turn resumes the conversation', async () => {
  const fake = fakeAgy([{ lines: fixture('text') }, { lines: fixture('text') }]);
  const d = new AntigravityDriver(deps(), fake.spawnFn);
  const evs: any[] = [];
  d.streamEvents((e) => evs.push(e));
  await start(d);
  await d.sendTurn({ threadId: 'T', text: 'count' } as any);
  await settled(evs);
  const a0 = fake.argvs[0]!;
  assert.ok(a0[0]!.startsWith('--print='));
  assert.ok(a0[0]!.includes(AGY_FIRST_TURN_RULE), 'the no-subagents rule rides the first turn');
  assert.ok(a0.includes('--model=gemini-3.8-flash-low'));
  assert.ok(a0.includes('--dangerously-skip-permissions'));
  assert.ok(!a0.some((a) => a.startsWith('--conversation')));
  const s = evs.find((e) => e.type === 'turn.settled');
  assert.equal(s.state, 'completed');
  assert.deepEqual(s.usage, { usageStatus: 'complete', inputTokens: 11812, outputTokens: 110 });
  const ctx = evs.filter((e) => e.type === 'thread.token-usage').pop();
  assert.deepEqual(ctx.usage, { usedTokens: 11922, maxTokens: 1_048_576, source: 'estimate' });
  assert.ok(evs.some((e) => e.type === 'thread.started' && e.providerThreadId === 'dbed22fc-eb40-4753-b403-4bc61f44285b'));
  assert.ok(evs.some((e) => e.type === 'turn.started' && e.model === 'gemini-3.8-flash-low'));

  await d.sendTurn({ threadId: 'T', text: 'again' } as any);
  await settled(evs, 2);
  const a1 = fake.argvs[1]!;
  assert.ok(a1.includes('--conversation=dbed22fc-eb40-4753-b403-4bc61f44285b'));
  assert.ok(!a1[0]!.includes(AGY_FIRST_TURN_RULE));
  assert.equal(evs.filter((e) => e.type === 'runtime.error').length, 0);
});

test('a reopened thread resumes from the stored conversation id', async () => {
  const fake = fakeAgy([{ lines: fixture('resume') }]);
  const d = new AntigravityDriver(deps(), fake.spawnFn);
  const evs: any[] = [];
  d.streamEvents((e) => evs.push(e));
  const r = await start(d, { resume: 'ba905704-5d13-4129-b3a2-21a516156735', runtimeMode: 'auto-accept-edits' });
  assert.equal(r.resume, 'ba905704-5d13-4129-b3a2-21a516156735');
  await d.sendTurn({ threadId: 'T', text: 'which file?' } as any);
  await settled(evs);
  assert.ok(fake.argvs[0]!.includes('--conversation=ba905704-5d13-4129-b3a2-21a516156735'));
  assert.ok(fake.argvs[0]!.includes('--mode=accept-edits'));
  assert.ok(evs.some((e) => e.type === 'runtime.warning' && /skips shell commands/.test(e.message)), 'posture notice');
  assert.ok(evs.some((e) => e.type === 'runtime.warning' && /skipped RunCommand/.test(e.message)), 'denied tools are said');
  assert.equal(evs.find((e) => e.type === 'turn.settled').state, 'completed');
  // a flag that is not a plain id never reaches argv
  const d2 = new AntigravityDriver(deps(), fakeAgy([{ lines: [] }]).spawnFn);
  assert.equal((await d2.startSession({ threadId: 'U', agent: 'antigravity', cwd: '/tmp', account: null, resume: '--dangerously-skip-permissions' } as any)).resume, undefined);
});

test('Stop kills the child and settles the turn as interrupted (once)', async () => {
  const fake = fakeAgy([{ lines: fixture('text').slice(0, 3), hang: true }]);
  const d = new AntigravityDriver(deps(), fake.spawnFn);
  const evs: any[] = [];
  d.streamEvents((e) => evs.push(e));
  await start(d);
  await d.sendTurn({ threadId: 'T', text: 'count' } as any);
  while (!evs.some((e) => e.type === 'content.delta')) await new Promise((r) => setTimeout(r, 5));
  await d.interruptTurn('T');
  await settled(evs);
  assert.deepEqual(fake.children[0]!.signals, ['SIGTERM']);
  const s = evs.filter((e) => e.type === 'turn.settled');
  assert.equal(s.length, 1);
  assert.equal(s[0].state, 'interrupted');
  assert.equal(evs.filter((e) => e.type === 'runtime.error').length, 0);
  assert.equal(evs[evs.length - 1].type, 'session.state');
});

test('a new message while a turn runs ends the old turn as interrupted first', async () => {
  const fake = fakeAgy([{ lines: fixture('text').slice(0, 2), hang: true }, { lines: fixture('text') }]);
  const d = new AntigravityDriver(deps(), fake.spawnFn);
  const evs: any[] = [];
  d.streamEvents((e) => evs.push(e));
  await start(d);
  const t1 = await d.sendTurn({ threadId: 'T', text: 'one' } as any);
  await new Promise((r) => setTimeout(r, 20));
  const t2 = await d.sendTurn({ threadId: 'T', text: 'two' } as any);
  await settled(evs, 2);
  const s = evs.filter((e) => e.type === 'turn.settled');
  assert.deepEqual(s.map((e) => [e.turnId, e.state]), [[t1.turnId, 'interrupted'], [t2.turnId, 'completed']]);
});

test('errors: an unknown model, a signed-out CLI and a missing binary each fail the turn once, in words', async () => {
  { // agy's own ERROR result (exit 1)
    const d = new AntigravityDriver(deps(), fakeAgy([{ lines: fixture('bad-model'), code: 1, stderr: 'error: invalid model selection …\n' }]).spawnFn);
    const evs: any[] = []; d.streamEvents((e) => evs.push(e));
    await start(d, { model: { model: 'no-such-model-x' } });
    await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
    await settled(evs);
    const errs = evs.filter((e) => e.type === 'runtime.error');
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /does not offer the model "no-such-model-x"/);
    assert.equal(evs.find((e) => e.type === 'turn.settled').state, 'failed');
  }
  { // no stream at all, a reason on stderr
    const d = new AntigravityDriver(deps(), fakeAgy([{ lines: [], code: 2, stderr: 'warning: something\nerror: not signed in; run agy to log in\n' }]).spawnFn);
    const evs: any[] = []; d.streamEvents((e) => evs.push(e));
    await start(d);
    await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
    await settled(evs);
    assert.match(evs.find((e) => e.type === 'runtime.error').message, /not signed in\. Run `agy` in (Terminal|a terminal)/);
  }
  { // agy is not installed
    const fake = fakeAgy([{ lines: [] }]);
    const d = new AntigravityDriver(deps(), fake.spawnFn, {}, async () => null);
    const evs: any[] = []; d.streamEvents((e) => evs.push(e));
    await start(d);
    await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
    await settled(evs);
    assert.equal(fake.argvs.length, 0);
    assert.match(evs.find((e) => e.type === 'runtime.error').message, /Antigravity isn't installed/);
  }
});

test('a stuck agy (no init) is stopped and the turn fails instead of hanging', async () => {
  const fake = fakeAgy([{ lines: [], hang: true }]);
  const d = new AntigravityDriver(deps(), fake.spawnFn, { startTimeoutMs: 80 });
  const evs: any[] = []; d.streamEvents((e) => evs.push(e));
  await start(d);
  await d.sendTurn({ threadId: 'T', text: 'hi' } as any);
  await settled(evs);
  assert.match(evs.find((e) => e.type === 'runtime.error').message, /did not start within/);
  assert.ok(fake.children[0]!.killed);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(evs.filter((e) => e.type === 'turn.settled').length, 1, 'the kill does not settle it twice');
});

test('the session is prepared once (trust-gated rulebook + KORA_* env) and its env reaches agy; Supervised says what it skips', async () => {
  let prepared = 0;
  const fake = fakeAgy([{ lines: fixture('denied') }, { lines: fixture('text') }]);
  const d = new AntigravityDriver(deps({ prepareSession: async () => { prepared++; return { env: { KORA_INJECT_OWNER: 'driver', KORA_PANE_ID: 'chat:T' }, notes: ['untrusted folder: nothing written into the repo'] }; } }), fake.spawnFn);
  const evs: any[] = []; d.streamEvents((e) => evs.push(e));
  await start(d, { runtimeMode: 'approval-required' });
  await d.sendTurn({ threadId: 'T', text: 'make b.txt' } as any);
  await settled(evs);
  await d.sendTurn({ threadId: 'T', text: 'again' } as any);
  await settled(evs, 2);
  assert.equal(prepared, 1);
  assert.equal(fake.envs[0]!.KORA_INJECT_OWNER, 'driver');
  assert.ok(!fake.argvs[0]!.includes('--dangerously-skip-permissions'));
  assert.equal(evs.filter((e) => e.type === 'runtime.warning' && /Read only/.test(e.message)).length, 1, 'the posture notice is said once');
  assert.ok(evs.some((e) => e.type === 'tool.result' && e.status === 'declined'));
});

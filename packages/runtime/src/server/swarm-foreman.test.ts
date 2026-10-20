// The swarm foreman: done-check runner (real child processes), reviewer parsing, the leader-facing text, and the
// SwarmService loop — pass, same-pane retry with a digest, model switch, no-report, escalation, reviewer gate, the
// check refusal outside Full access/Auto, the outcomes.jsonl row — plus kora_wait holding until the verdict and
// following a foreman respawn. Fake runtime in the swarm.test.ts style; worktrees are real git in temp repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { SwarmForemanCheck, SwarmForemanState, SwarmModelInfo, SwarmStatus, SwarmWorkerMeta } from '../protocol/types';
import { SwarmService } from './swarm';
import { SwarmHealth } from './swarm-health';
import { checkEnv, diffSummary, fenceHint, formatForeman, looksModelRelated, parseReview, runCheck, tailOf, worktreeDiff } from './swarm-foreman';
import { fleetToolSpecs } from '../session/fleet-tools';

process.env.KORA_WORKTREES = path.join(process.env.KORA_HOME || os.tmpdir(), 'wt');

const M = (id: string, provider: SwarmModelInfo['provider'], rank: number): SwarmModelInfo => ({ id, provider, label: id.split('/').pop()!, rank, maxConcurrent: null });
const MODELS = [M('opencode/big-pickle', 'zen', 0), M('opencode/grok-code', 'zen', 1), M('opencode/third', 'zen', 2)];

function readyStatus(): SwarmStatus {
  return JSON.parse(JSON.stringify({
    ready: true, blockers: [],
    opencode: { installed: true, path: '/x', source: 'kora', version: '1.18.32', minVersion: '1.18.0', versionOk: true, onDaemonPath: true },
    install: { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null },
    consent: { requiredVersion: 1, acceptedVersion: 1, acceptedAt: 1 },
    providers: [], models: { available: MODELS, cooling: [] }, preferences: { providerOrder: ['zen', 'openrouter', 'cerebras'], defaultModel: null, maxWorkers: 4 },
    keyStorage: 'file', checkedAt: 1,
  }));
}

class FakePane extends EventEmitter {
  swarm: SwarmWorkerMeta | null = null; promptPending = false; exited = false; state = 'idle'; blocker: string | null = null;
  screen = 'worker screen'; role = 'worker';
  constructor(public id: string, public orchestratorId: string, public worktree: { path: string; branch: string; mainRoot: string } | null, public args: string[]) { super(); }
  info() { return { id: this.id, swarm: this.swarm } as any; }
  read() { return this.screen; }
  kill() { this.exit(); }
  exit() { if (this.exited) return; this.exited = true; setImmediate(() => this.emit('exit', 0)); }
  setState(s: string) { this.state = s; this.emit('state', s, null, 'x'); }
}

function fakeRuntime() {
  let n = 1;
  const rt: any = new EventEmitter();
  rt.panes = new Map<string, FakePane>();
  rt.spawns = [] as any[];
  rt.prompts = [] as { paneId: string; text: string }[];
  rt.notes = [] as { method: string; params: any }[];
  rt.notify = (method: string, params: any) => rt.notes.push({ method, params });
  rt.agentSpawn = async (p: any) => {
    rt.spawns.push(p);
    const id = `p${n++}`;
    rt.panes.set(id, new FakePane(id, p.orchestratorId, p.reuseWorktree ?? null, p.args));
    return { id };
  };
  rt.killPane = (id: string) => { const p = rt.panes.get(id); rt.panes.delete(id); p?.kill(); };
  rt.prompt = async (paneId: string, text: string) => { rt.prompts.push({ paneId, text }); return { ok: true, state: 'working' }; };
  rt.graph = { callTool: async () => ({ text: '', data: null, ms: 0 }) };
  return rt;
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-repo-'));
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n'); git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return dir;
}

type Cfg = { foremanRetries?: number; foremanReview?: boolean };
function service(over: { cfg?: Cfg; io?: Record<string, unknown> } = {}) {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-home-'));
  const rt = fakeRuntime();
  const health = new SwarmHealth(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-h-')), 'health.json'));
  const setup: any = { getStatus: async () => readyStatus(), pickableModels: () => MODELS.filter((m) => health.isAvailable(m.id)) };
  const checks: string[] = [];
  const svc = new SwarmService({ runtime: rt, setup, health, io: {
    threadMode: () => 'swarm', apiKey: () => null, opencodePath: () => '/fake/opencode',
    paneEnv: (meta: SwarmWorkerMeta) => ({ KORA_REPORT: meta.reportPath }),
    preamble: ({ reportPath }: { reportPath: string }) => `REPORT TO ${reportPath}`,
    permissionArgs: () => [], contextPacket: async () => ({ text: '', files: [] }), overlap: () => [], changedFiles: async () => [],
    verifyGate: async () => [],
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, foremanRetries: 2, ...(over.cfg ?? {}) }),
    runCheck: async (cmd: string): Promise<SwarmForemanCheck> => { checks.push(cmd); return { state: 'passed', exitCode: 0, durationMs: 5, tail: 'ok 3 tests' }; },
    diff: async () => ({ stat: ' a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)', patch: '-a\n+b', untracked: [] }),
    review: async () => ({ output: 'VERDICT: PASS', failed: false }),
    nudgeMs: 20, screenPollMs: 0,
    ...(over.io ?? {}),
  } as any });
  return { svc, rt, health, checks };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fmOf = (p: FakePane) => p.swarm!.foreman as SwarmForemanState;
async function finishWith(rt: any, paneId: string, reportPath: string, body = '## Done') {
  const p = rt.panes.get(paneId) as FakePane;
  p.setState('working');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${body} ${Date.now()}`);
  p.setState('idle');
  await tick();
  return p;
}
const events = (rt: any) => rt.notes.filter((n: any) => n.method === 'swarm.worker').map((n: any) => n.params.event);

// ── pure pieces ───────────────────────────────────────────────────────────────────────────────────────
test('tailOf / parseReview / diffSummary / looksModelRelated', () => {
  assert.equal(tailOf('\x1b[31mred\x1b[0m\n' + Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')).split('\n')[0], 'l10');
  assert.deepEqual(parseReview('thinking…\nVERDICT: FAIL\n- misses the null case'), { verdict: 'fail', reasons: '- misses the null case' });
  assert.equal(parseReview('**VERDICT: PASS**').verdict, 'pass');
  assert.equal(parseReview('Rate limited (429)').verdict, 'error', 'no verdict line never fails a worker');
  assert.equal(diffSummary({ stat: ' a | 1 +\n 1 file changed, 1 insertion(+)', untracked: ['b.ts'] }), '1 file changed, 1 insertion(+); 1 new file (b.ts)');
  assert.equal(diffSummary({ stat: '', untracked: [] }), 'no changes');
  assert.equal(looksModelRelated('check', 1), false, 'a first check failure stays on the same worker');
  assert.equal(looksModelRelated('check', 2), true);
  assert.equal(looksModelRelated('no-report', 1), true);
});

test('runCheck: pass, fail with the output tail, timeout kills the whole process group, bad cwd is an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-chk-'));
  const ok = await runCheck('echo hi; exit 0', dir);
  assert.deepEqual([ok.state, ok.exitCode, ok.tail], ['passed', 0, 'hi']);
  const bad = await runCheck('echo "1 failing"; echo boom >&2; exit 3', dir);
  assert.deepEqual([bad.state, bad.exitCode], ['failed', 3]);
  assert.match(bad.tail, /1 failing\nboom/);
  // Deterministic under a loaded parallel run (F5): no assumption that the shell printed anything inside a 400 ms
  // budget; the proof the whole GROUP died is the grandchild's pid, not a wall-clock bound.
  const t0 = Date.now();
  const pidFile = path.join(dir, 'grandchild.pid');
  const slow = await runCheck(`sh -c 'sleep 30' & echo $! > ${pidFile}; echo started; wait`, dir, 400);
  assert.equal(slow.state, 'timeout');
  assert.ok(Date.now() - t0 < 25_000, 'the budget, not the 30 s sleep, ended the check');
  assert.match(slow.tail, /\[kora\] check killed after 0\.4 s$/);
  for (let i = 0; i < 50 && fs.existsSync(pidFile); i++) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!pid) { await new Promise((r) => setTimeout(r, 20)); continue; }
    let alive = true;
    for (let j = 0; j < 100 && alive; j++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; } }
    assert.equal(alive, false, 'the backgrounded sleep (same process group) was killed too');
    break;
  }
  const err = await runCheck('true', path.join(dir, 'missing'));
  assert.equal(err.state, 'error');
});

test('worktreeDiff: committed + uncommitted changes vs the fork point, new files with their heads', async () => {
  const main = repo();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wt-')), 'w');
  spawnSync('git', ['worktree', 'add', '-q', '-b', 'kora/x', wt], { cwd: main });
  fs.writeFileSync(path.join(wt, 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 1;\n');
  const d = await worktreeDiff(wt, main);
  assert.match(d.stat, /1 file changed/);
  assert.deepEqual(d.untracked, ['b.ts']);
  assert.match(d.patch, /\+export const a = 2;/);
  assert.match(d.patch, /\+\+\+ b\.ts \(new file\)\nexport const b = 1;/);
});

test('formatForeman: PASS line + diff + check tail; escalation lists every attempt, the last failure and the worktree', () => {
  const base: SwarmForemanState = { state: 'passed', attempt: 2, maxAttempts: 3, check: 'pnpm test', review: false, verdicts: [], result: { kind: 'pass', attempts: 2, worktree: '/w', diffStat: '1 file changed', checkTail: 'ok 3', lastFailure: null } };
  assert.equal(formatForeman(base), 'foreman: PASS on attempt 2 of 3 (check `pnpm test` passed)\ndiff: 1 file changed');
  assert.equal(formatForeman({ ...base, result: null }), null, 'nothing while the foreman works');
  const esc = formatForeman({ ...base, state: 'escalated', verdicts: [
    { attempt: 1, paneId: 'p1', model: 'opencode/big-pickle', check: { state: 'failed', exitCode: 1, durationMs: 1, tail: 'x' }, gate: 'passed', review: null, failure: 'check', durationMs: 9, at: 1 },
    { attempt: 2, paneId: 'p2', model: 'opencode/grok-code', check: null, gate: null, review: null, failure: 'no-report', durationMs: 9, at: 2 },
  ], result: { kind: 'escalation', attempts: 2, worktree: '/w', diffStat: null, checkTail: null, lastFailure: 'check failed (exit 1):\nx' } })!;
  assert.match(esc, /^foreman: ESCALATED after 2 attempts/);
  assert.match(esc, /#1 big-pickle: check failed \(exit 1\), gate passed → check/);
  assert.match(esc, /#2 grok-code: no report was written → no-report/);
  assert.match(esc, /last failure:\ncheck failed \(exit 1\):\nx/);
  assert.match(esc, /worktree: \/w/);
});

// ── the loop ──────────────────────────────────────────────────────────────────────────────────────────
test('pass: gate clean + check passes → PASS result with diff stat and check tail; one outcomes.jsonl row with the attempt', async () => {
  const { svc, rt, checks } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'fix it', runtimeMode: 'full-access', check: 'pnpm test' });
  assert.deepEqual(r.foreman, { check: 'pnpm test', maxAttempts: 3, review: false, checkRefused: null });
  const p = rt.panes.get(r.paneId!) as FakePane;
  p.setState('working');
  fs.writeFileSync(r.reportPath, '## Done');
  p.setState('idle');
  assert.equal(fmOf(p).state, 'checking', 'on hold synchronously, before the gate even answers');
  await tick();
  // judged against the base commit: the command runs inside `kora swarm check --baseline … -- <command>`
  assert.equal(checks.length, 1); assert.match(checks[0], / swarm check --baseline '[^']+' -- 'pnpm test'$/);
  assert.equal(fmOf(p).state, 'passed');
  assert.deepEqual(fmOf(p).result, { kind: 'pass', attempts: 1, worktree: rt.spawns[0].reuseWorktree.path, diffStat: '1 file changed, 1 insertion(+), 1 deletion(-)', checkTail: 'ok 3 tests', lastFailure: null });
  assert.equal(p.swarm!.phase, 'done');
  assert.deepEqual(events(rt).map((e: any) => e.kind), ['report']);
  const rows = fs.readFileSync(path.join(process.env.KORA_HOME!, 'swarm', 'outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].foreman.attempts.map((a: any) => [a.attempt, a.model, a.check.state, a.gate, a.failure]), [[1, 'opencode/big-pickle', 'passed', 'passed', null]]);
  assert.equal(rows[0].foreman.result, 'pass');
});

test('retry: a failing check goes back to the SAME worker with a digest; a second failure on that model switches models in the same worktree', async () => {
  let n = 0;
  const { svc, rt } = service({ io: { runCheck: async () => (n++ < 2 ? { state: 'failed', exitCode: 1, durationMs: 3, tail: 'FAIL src/a.test.ts\nexpected 2 got 1' } : { state: 'passed', exitCode: 0, durationMs: 3, tail: 'ok' }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'fix it', runtimeMode: 'full-access', check: 'npm test' });
  const p1 = await finishWith(rt, r.paneId!, r.reportPath);
  assert.equal(fmOf(p1).state, 'retrying');
  assert.equal(fmOf(p1).attempt, 2);
  assert.equal(rt.prompts.length, 1);
  assert.equal(rt.prompts[0].paneId!, r.paneId!, 'first failure: same worker');
  assert.match(rt.prompts[0].text, /^KORA FOREMAN — attempt 2 of 3\. The previous attempt \(opencode\/big-pickle\) was not accepted: the done-check failed\./);
  assert.match(rt.prompts[0].text, /check failed \(exit 1\):\nFAIL src\/a\.test\.ts\nexpected 2 got 1/);
  assert.match(rt.prompts[0].text, /run `npm test` yourself until it passes/);
  assert.equal(fs.existsSync(r.reportPath), false, 'the old report is moved aside so a retry must write a fresh one');
  assert.deepEqual(events(rt), [], 'the leader hears nothing yet');
  // second failure on the same model → new model, same worktree, alias
  await finishWith(rt, r.paneId!, r.reportPath);
  const p2id = await svc.followSettled(r.paneId!);
  assert.notEqual(p2id, r.paneId!);
  const p2 = rt.panes.get(p2id) as FakePane;
  assert.equal(p2.swarm!.model, 'opencode/grok-code');
  assert.equal(rt.spawns[1].reuseWorktree.path, rt.spawns[0].reuseWorktree.path);
  assert.match(rt.spawns[1].args[rt.spawns[1].args.indexOf('--prompt') + 1], /KORA FOREMAN — attempt 3 of 3[\s\S]*run `git status` and `git diff` first/);
  assert.deepEqual(events(rt).map((e: any) => [e.kind, e.newPaneId]), [['failover', p2id]]);
  await finishWith(rt, p2id, r.reportPath);
  assert.equal(fmOf(p2).state, 'passed');
  assert.deepEqual(fmOf(p2).verdicts.map((v) => [v.attempt, v.paneId!, v.failure]), [[1, r.paneId!, 'check'], [2, r.paneId!, 'check'], [3, p2id, null]]);
  assert.equal(events(rt).at(-1).kind, 'report');
});

test('escalation: out of attempts → a short structured escalation, phase failed, the note says so', async () => {
  const { svc, rt } = service({ cfg: { foremanRetries: 1 }, io: { runCheck: async () => ({ state: 'failed', exitCode: 2, durationMs: 3, tail: 'still broken' }) } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't', runtimeMode: 'auto', check: 'make check' });
  await finishWith(rt, r.paneId!, r.reportPath);
  const p = await finishWith(rt, r.paneId!, r.reportPath);
  const fm = fmOf(p);
  assert.equal(fm.state, 'escalated');
  assert.equal(fm.result!.kind, 'escalation');
  assert.equal(fm.result!.attempts, 2);
  assert.match(fm.result!.lastFailure!, /check failed \(exit 2\):\nstill broken/);
  assert.equal(p.swarm!.phase, 'failed');
  assert.equal(rt.prompts.length, 1, 'one retry, then the leader');
  assert.deepEqual(events(rt).map((e: any) => e.kind), ['report']);
  assert.match(svc.note(r.paneId!)!, /was not accepted after 2 attempts/);
});

test('no report: nudge once, then a no-report verdict retries on a DIFFERENT model', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!) as FakePane;
  p.setState('working'); p.setState('idle');
  await tick(60);
  assert.equal(rt.prompts.length, 1, 'the one nudge');
  assert.equal(fmOf(p).state, 'working', 'still held: nothing reached the leader');
  p.setState('working'); p.setState('idle');
  await tick(80);
  const next = await svc.followSettled(r.paneId!);
  assert.notEqual(next, r.paneId!);
  assert.equal((rt.panes.get(next) as FakePane).swarm!.model, 'opencode/grok-code');
  assert.equal(fmOf(rt.panes.get(next)).verdicts[0].failure, 'no-report');
});

test('crash: a worker that exits on its own without a report is retried on another model', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p = rt.panes.get(r.paneId!) as FakePane;
  p.setState('working');
  p.exit(); // stays registered: it quit, nobody killed it
  await tick();
  const next = await svc.followSettled(r.paneId!);
  assert.notEqual(next, r.paneId!);
  assert.equal(fmOf(rt.panes.get(next)).verdicts[0].failure, 'crashed');
  assert.equal(rt.panes.get(next).swarm.attempts[0].outcome, 'crashed');
});

test('reviewer gate: FAIL feeds the retry; a rate-limited reviewer moves to the next model; no answer = error, never a failure', async () => {
  const answers = ['VERDICT: FAIL\n- the null case is not handled', 'Error: Rate limited (429)', 'VERDICT: PASS'];
  const models: string[] = [];
  const { svc, rt, health } = service({ cfg: { foremanReview: true }, io: { review: async (i: any) => { models.push(i.model); return { output: answers.shift() ?? 'garbage', failed: false }; } } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'handle null' });
  const p = await finishWith(rt, r.paneId!, r.reportPath);
  assert.equal(models[0], 'opencode/grok-code', 'never the worker\'s own model');
  assert.equal(fmOf(p).state, 'retrying');
  assert.match(rt.prompts[0].text, /the reviewer rejected the change[\s\S]*reviewer \(opencode\/grok-code\): FAIL\n- the null case is not handled/);
  await finishWith(rt, r.paneId!, r.reportPath);
  assert.equal(fmOf(p).state, 'passed');
  assert.deepEqual(models.slice(1), ['opencode/grok-code', 'opencode/third'], 'the rate-limited reviewer is skipped for the next model');
  assert.equal(health.isAvailable('opencode/grok-code'), false, 'and cooled');
  assert.equal(fmOf(p).verdicts.at(-1)!.review!.verdict, 'pass');
  // A reviewer that never gives a verdict does not block the pass.
  const g = service({ cfg: { foremanReview: true, foremanRetries: 0 }, io: { review: async () => ({ output: 'hmm', failed: true }) } });
  const r2 = await g.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const p2 = await finishWith(g.rt, r2.paneId!, r2.reportPath);
  assert.equal(fmOf(p2).state, 'passed');
  assert.equal(fmOf(p2).verdicts[0].review!.verdict, 'error');
});

test('the check runs unattended only in Full access / Auto; foremanRetries 0 with no check/review = foreman off', async () => {
  const { svc, rt, checks } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't', runtimeMode: 'approval-required', check: 'rm -rf /' });
  assert.equal(r.foreman!.check, null);
  assert.match(r.foreman!.checkRefused!, /needs the thread in Full access or Auto mode/);
  await finishWith(rt, r.paneId!, r.reportPath);
  assert.deepEqual(checks, []);
  assert.equal(fmOf(rt.panes.get(r.paneId!)).state, 'passed', 'retries still apply; the gate still counts');
  const off = service({ cfg: { foremanRetries: 0 } });
  const r2 = await off.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  assert.equal(r2.foreman, null);
  const p2 = await finishWith(off.rt, r2.paneId!, r2.reportPath);
  assert.equal(p2.swarm!.foreman, undefined);
  assert.equal(p2.swarm!.phase, 'done');
});

// ── kora_wait ─────────────────────────────────────────────────────────────────────────────────────────
test('kora_wait holds while the foreman works, follows its respawn, and answers with the PASS block', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 't' });
  const info = (p: FakePane) => ({ id: p.id, agent: 'opencode', account: null, name: 'w', state: p.exited ? 'exited' : p.state, blocker: null, exited: p.exited, exitCode: null, cwd: '/w', worktree: p.worktree, costUsd: null, contextPct: null, steeredAt: null, createdAt: 0, lastOutputAt: 0, quietMs: 0, stalled: false, swarm: p.swarm });
  const fleet: any = {
    list: async () => [...rt.panes.values()].map(info),
    wait: async (id: string) => {
      const p = rt.panes.get(id) as FakePane | undefined;
      if (!p || p.exited) return { state: 'idle', blocker: null, timedOut: false, exited: true };
      if (p.state !== 'idle') await new Promise((res) => p.once('state', res));
      return { state: p.state, blocker: null, timedOut: false, exited: p.exited };
    },
    read: async () => 'screen', follow: (id: string) => svc.followSettled(id),
  };
  const tool = fleetToolSpecs({ fleet, orchestratorId: 'chat:swarm', agent: 'claude', cwd: '/', account: null, agentMode: 'swarm', swarm: svc, spawnWorker: async () => { throw new Error('no'); } }).find((t) => t.name === 'kora_wait')!;
  const p1 = rt.panes.get(r.paneId!) as FakePane;
  p1.setState('working');
  let answered = false;
  const waiting = tool.handler({ paneId: r.paneId!, timeoutMs: 20_000 }).then((x) => { answered = true; return x; });
  // idle without a report: the nudge, then a no-report respawn on a new model — kora_wait must not answer meanwhile
  p1.setState('idle'); await tick(60);
  p1.setState('working'); p1.setState('idle'); await tick(120);
  assert.equal(answered, false, 'held through the nudge and the respawn');
  const p2id = svc.follow(r.paneId!);
  assert.notEqual(p2id, r.paneId!);
  await finishWith(rt, p2id, r.reportPath, '## Done\nfixed');
  const out = (await waiting).text;
  assert.match(out, new RegExp(`^${r.paneId!} → ${p2id}`));
  assert.match(out, /foreman: PASS on attempt 2 of 3\ndiff: 1 file changed/);
  assert.match(out, /--- report s1/);
});

// ── D19 (Koragent E2E): the worker's own verdict and an empty change are never a PASS ─────────────────────────
test('D19: a report whose status is failed / partial / blocked / budget is not a PASS — it is retried, then escalated', async () => {
  for (const status of ['failed', 'partial', 'blocked', 'budget']) {
    const { svc, rt } = service({ cfg: { foremanRetries: 0 } });
    const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'fix it', runtimeMode: 'full-access', check: 'pnpm test' });
    const p = await finishWith(rt, r.paneId!, r.reportPath, `## Status\n${status} (the tests could not run)\n\n## Changes\n- none`);
    await tick(60);
    assert.equal(fmOf(p).state, 'escalated', status);
    assert.equal(fmOf(p).verdicts[0].failure, 'report', status);
    assert.equal(p.swarm!.phase, 'failed', status);
    const out = formatForeman(fmOf(p))!;
    assert.doesNotMatch(out, /PASS/);
    assert.match(out, / → report/);
    assert.match(fmOf(p).result!.lastFailure!, new RegExp(`worker report: status ${status}`));
  }
});

test('D19: an edit task with no change is not a PASS (no-change, the next attempt on another model); a research task with none passes', async () => {
  const empty = { stat: '', patch: '', untracked: [] as string[] };
  const { svc, rt } = service({ io: { diff: async () => empty } });
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'fix the rounding bug in a.ts', runtimeMode: 'full-access', check: 'pnpm test' });
  const p = await finishWith(rt, r.paneId!, r.reportPath, '## Status\ndone');
  await tick(60);
  assert.equal(fmOf(p).verdicts[0].failure, 'no-change');
  assert.notEqual(fmOf(p).state, 'passed');
  assert.equal(p.swarm!.supersededBy != null || fmOf(p).state === 'retrying', true, 'retried, not accepted');

  const q = service({ io: { diff: async () => empty } });
  const r2 = await q.svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'list every caller of subtotal; do not change any code', runtimeMode: 'full-access', check: 'true' });
  const p2 = await finishWith(q.rt, r2.paneId!, r2.reportPath, '## Status\ndone');
  await tick(60);
  assert.equal(fmOf(p2).state, 'passed');
});

test('D19: a report that says done with a real change still passes', async () => {
  const { svc, rt } = service();
  const r = await svc.spawn({ orchestratorId: 'chat:swarm', cwd: repo(), task: 'fix it', runtimeMode: 'full-access', check: 'pnpm test' });
  const p = await finishWith(rt, r.paneId!, r.reportPath, '## Status\ndone\n\n## Changes\n- a.ts');
  await tick(60);
  assert.equal(fmOf(p).state, 'passed');
});

test('security: the reviewer never loads the worker worktree\'s project config (it could loosen the read-only permission)', async () => {
  const { runReviewer } = require('./swarm-foreman') as typeof import('./swarm-foreman');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-reviewer-env-'));
  const bin = path.join(dir, 'fake-agent');
  fs.writeFileSync(bin, '#!/bin/sh\necho "PC=$KORAGENT_DISABLE_PROJECT_CONFIG OC=$OPENCODE_DISABLE_PROJECT_CONFIG KP=$KORAGENT_PERMISSION OP=$OPENCODE_PERMISSION"\n', { mode: 0o755 });
  const kg = await runReviewer({ opencode: bin, model: 'm', cwd: dir, prompt: 'p', env: {}, backend: 'koragent', budgetMs: 10_000 });
  assert.match(kg.output, /PC=1 /); assert.match(kg.output, /KP=\{/);
  const oc = await runReviewer({ opencode: bin, model: 'm', cwd: dir, prompt: 'p', env: {}, backend: 'opencode', budgetMs: 10_000 });
  assert.match(oc.output, /OC=1 /); assert.match(oc.output, /OP=\{/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deep audit 2026-10-13 A1-5: a done-check runs under the credential read-deny (it can\'t read ~/.ssh)', { skip: process.platform !== 'darwin' || process.env.KORA_OS_SANDBOX === '0' }, async () => {
  const { osSandboxSupported } = await import('../session/os-sandbox');
  if (!osSandboxSupported()) return;
  const canary = path.join(os.homedir(), '.ssh', `kora-check-canary-${process.pid}`);
  fs.mkdirSync(path.dirname(canary), { recursive: true }); fs.writeFileSync(canary, 'CHECK-CANARY');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chk-'));
  try {
    const r = await runCheck(`cat ${canary}; echo rc=$?`, dir, 10_000, { keepOutput: true });
    assert.ok(!String(r.output ?? r.tail).includes('CHECK-CANARY'), 'the canary stays unread');
    assert.match(String(r.output ?? r.tail), /rc=1/);
    const ok = await runCheck('echo fine', dir, 10_000, { keepOutput: true });
    assert.equal(ok.state, 'passed'); assert.match(String(ok.output), /fine/);
  } finally { fs.rmSync(canary, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deep audit 2026-10-13 A3-3: a check that fails on a login says it ran fenced; ordinary failures do not', { skip: process.platform !== 'darwin' || process.env.KORA_OS_SANDBOX === '0' }, async () => {
  assert.match(fenceHint('npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/x'), /credential fence/);
  assert.match(fenceHint('git@github.com: Permission denied (publickey).'), /credential fence/);
  assert.equal(fenceHint('AssertionError: expected 1 to equal 2'), '');
  const { osSandboxSupported } = await import('../session/os-sandbox');
  if (!osSandboxSupported()) return;
  const rc = path.join(os.homedir(), '.npmrc');
  const had = fs.existsSync(rc);
  if (!had) fs.writeFileSync(rc, '//registry.example/:_authToken=x\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chk-'));
  try {
    const r = await runCheck(`cat ${rc}`, dir, 10_000);
    assert.equal(r.state, 'failed');
    assert.match(r.tail, /Operation not permitted/);
    assert.match(r.tail, /\[kora\] this check runs under Kora's credential fence/);
    const plain = await runCheck('echo nope; exit 3', dir, 10_000);
    assert.equal(plain.state, 'failed'); assert.doesNotMatch(plain.tail, /credential fence/);
  } finally { if (!had) fs.rmSync(rc, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a done-check finds the user\'s tools although the daemon started with launchd\'s bare PATH (found live 2026-10-14: `node --test` was "not found")', async () => {
  const before = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chk-'));
  try {
    assert.ok(String(checkEnv().PATH).split(path.delimiter).includes('/opt/homebrew/bin'), 'Homebrew is on the check PATH');
    const r = await runCheck('echo "$PATH"', dir, 10_000, { keepOutput: true });
    assert.equal(r.state, 'passed');
    assert.match(String(r.output), /\/opt\/homebrew\/bin/);
    assert.equal(checkEnv().CI, '1');
  } finally { if (before === undefined) delete process.env.PATH; else process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); }
});

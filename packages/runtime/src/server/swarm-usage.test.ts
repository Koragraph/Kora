// `kora swarm usage`: measured swarm economics from outcomes + worker token sessions + leader turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildReport, windows, formatReport, type OutcomeRow, type WorkerTokens, type LeaderTurn } from './swarm-usage';

const H = 60 * 60 * 1000;
const wt = (n: number) => path.join('/wt', `w${n}`);
const outcome = (n: number, o: Partial<OutcomeRow> = {}): OutcomeRow => ({
  v: 1, ts: 1000 + n, thread: 'chat:t1', taskId: `s${n}`, status: 'done', startedAt: 1000 + n, durationMs: 60_000,
  attempts: [{ model: 'opencode/big-pickle', provider: 'zen', outcome: 'ok', at: 1000 + n }],
  verify: { state: 'passed', bounces: 0 }, reportBytes: 500, worktree: wt(n), ...o,
});
const tokens = (n: number, input: number): WorkerTokens => ({ directory: wt(n), created: 1000 + n, input: 0, cacheRead: input, cacheWrite: 0, output: 2000, requests: 7 });
const turn = (at: number, workers: number): LeaderTurn => ({ thread: 'chat:t1', startedAt: at, workers, input: 10, cached: 300_000, output: 2000 });

test('turns group into 5-hour windows opened by the first turn', () => {
  const w = windows([turn(0, 2), turn(4 * H, 2), turn(5 * H + 1, 1), turn(6 * H, 3)]);
  assert.deepEqual(w.map((x) => x.length), [2, 2]);
});

test('the report joins worker sessions by worktree and measures retries, pass rates, free share and cost', () => {
  const outcomes = [
    outcome(1),
    outcome(2, { attempts: [{ model: 'opencode/big-pickle', provider: 'zen', outcome: 'rate-limited', at: 1 }, { model: 'openrouter/x/y', provider: 'openrouter', outcome: 'ok', at: 2 }] }),
    outcome(3, { status: 'failed', verify: null }),
  ];
  const workers = [tokens(1, 100_000), { ...tokens(2, 300_000), directory: path.join(wt(2), 'sub') }, tokens(9, 999)];
  const r = buildReport(outcomes, workers, [turn(0, 2), turn(H, 1), turn(2 * H, 0)], 0);
  assert.equal(r.tasks, 3);
  assert.equal(r.attempts, 4);
  assert.equal(Math.round(r.retryRate * 100), 33);
  assert.equal(Math.round(r.freeShare * 100), 75, 'zen attempts are free, a paid OpenRouter id is not');
  assert.equal(Math.round(r.passRate * 100), 67);
  assert.equal(Math.round(r.firstTryPass * 100), 33, 'the failed-over task passed but not on the first try');
  assert.equal(r.worker.matched, 2, 'matched by worktree (including a subfolder), not the unrelated session');
  assert.equal(r.leader.jobs, 2, 'a turn that spawned no worker is not a job');
  assert.equal(r.leader.workersPerJob.max, 2);
  assert.ok(r.worker.refCostTotal > 0 && r.worker.refCostTotal < 0.01);
  assert.match(formatReport(r, 7), /workers per job/);
});

test('an empty log says how to get numbers instead of printing zeros', () => {
  assert.match(formatReport(buildReport([], [], [], 0), 7), /No swarm tasks/);
});

test('Koragent tasks count their own TaskReport totals (no OpenCode DB join)', () => {
  const kg = outcome(5, { backend: 'koragent', usage: { steps: 14, costUsd: 0, refCostUsd: 0.15, tokens: { in: 18_000, out: 2_500, reasoning: 500, cacheRead: 170_000, cacheWrite: 0 } } });
  const noTokens = outcome(6, { backend: 'koragent', usage: { steps: 3 } });
  // An OpenCode session in the same worktree is NOT joined to a Koragent task.
  const r = buildReport([kg, noTokens], [tokens(5, 999_999)], [], 0);
  assert.equal(r.worker.matched, 1);
  assert.equal(r.worker.medianInput, 188_000);
  assert.equal(r.worker.medianOutput, 3_000);
  assert.equal(r.worker.medianRequests, 14);
});

test('an OpenCode session recorded under the realpath (/private/var/…) still joins a /var/… worktree', () => {
  if (process.platform !== 'darwin') return;
  const o = outcome(7, { worktree: '/var/nonexistent-kora-wt/w7' });
  const w: WorkerTokens = { directory: '/private/var/nonexistent-kora-wt/w7', created: 1007, input: 10, cacheRead: 0, cacheWrite: 0, output: 5, requests: 1 };
  assert.equal(buildReport([o], [w], [], 0).worker.matched, 1);
});

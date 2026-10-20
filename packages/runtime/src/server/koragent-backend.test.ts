// Koragent backend helpers: the binary search order, the TaskSpec Kora writes (route, packet, permission, report path,
// parent, verify, budget), the report's .md (the five sections kora_wait reads), the report-file fallback, and the
// event → state mappings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskReport } from '../protocol/koragent';
import {
  asTaskReport, buildTaskSpec, ensureReportFiles, failoverOutcome, graphPacketFrom, koragentCandidates, koragentPaneEnv, koragentPermission,
  paneSocketPath, paneStateFor, renderTaskReport, reportJsonPath, resolveKoragentBinary, taskSpecPath, writeTaskSpec,
} from './koragent-backend';

// Koragent (Kora Pro, Bun, a unix:<path> socket) is not ported to Windows yet (docs/windows/PORT.md).
const winSkip = { skip: process.platform === 'win32' };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kg-'));

const REPORT: TaskReport = {
  v: 1, taskId: 's4', sessionId: 'ses_1', status: 'done', summary: 'renamed the helper',
  changes: [{ path: 'src/a.ts', added: 3, removed: 1, note: 'rename' }],
  check: { command: 'pnpm test', exitCode: 0, outputTail: '12 passed', ranBy: 'harness' },
  findings: [{ text: 'b.ts still imports the old name', ref: 'src/b.ts:4' }], blockers: [],
  attempts: [{ model: 'opencode/big-pickle', outcome: 'ok' }],
  usage: { steps: 5, tokens: { in: 100, out: 10 }, costUsd: 0, refCostUsd: 0.02, bySource: { free: 0 } },
};

test('resolveKoragentBinary: KORAGENT_BIN, then $KORAGENT_HOME|~/.koragent/bin/koragent, then PATH', winSkip, () => {
  const env = { KORAGENT_BIN: '/opt/k/koragent', PATH: '/usr/bin:/a/bin:relative' } as NodeJS.ProcessEnv;
  assert.deepEqual(koragentCandidates({ env, home: '/h' }).map((c) => [c.path, c.source]), [
    ['/opt/k/koragent', 'env'], ['/h/.koragent/bin/koragent', 'koragent-home'], ['/usr/bin/koragent', 'path'], ['/a/bin/koragent', 'path'],
  ]);
  assert.equal(koragentCandidates({ env: { KORAGENT_HOME: '/kh' }, home: '/h' })[0].path, '/kh/bin/koragent');
  const has = new Set(['/h/.koragent/bin/koragent', '/a/bin/koragent']);
  assert.deepEqual(resolveKoragentBinary({ env, home: '/h', isExecutable: (p) => has.has(p) }), { path: '/h/.koragent/bin/koragent', source: 'koragent-home' });
  assert.deepEqual(resolveKoragentBinary({ env: { PATH: '/nowhere' }, home: '/h', isExecutable: () => false }), { path: null, source: null });
});

test('koragentPermission maps the thread posture', winSkip, () => {
  assert.equal(koragentPermission('full-access'), 'full');
  assert.equal(koragentPermission('auto'), 'full');
  assert.equal(koragentPermission('auto-accept-edits'), 'auto-edits');
  assert.equal(koragentPermission('approval-required'), 'supervised');
  assert.equal(koragentPermission(undefined), 'supervised');
});

test('graphPacketFrom: ■ lines become symbols, the rest notes; empty packet → undefined', winSkip, () => {
  const text = ['## Context (from Kora graph)', '■ FUNCTION validateSignup @ src/signup/form.ts:42 — validateSignup(input: SignupInput): Result',
    '  callers: SignupPage.render @ src/pages/signup.tsx:80', '■ METHOD SignupPage.render @ src/pages/signup.tsx:80',
    '(resolved from the code graph at spawn time; line numbers may be slightly off — open the file before editing)'].join('\n');
  const g = graphPacketFrom({ text, files: ['src/signup/form.ts', 'src/pages/signup.tsx'] })!;
  assert.deepEqual(g.symbols, [
    { kind: 'function', name: 'validateSignup', file: 'src/signup/form.ts', line: 42, signature: 'validateSignup(input: SignupInput): Result' },
    { kind: 'method', name: 'SignupPage.render', file: 'src/pages/signup.tsx', line: 80 },
  ]);
  assert.deepEqual(g.notes, ['  callers: SignupPage.render @ src/pages/signup.tsx:80']);
  assert.deepEqual(g.files, ['src/signup/form.ts', 'src/pages/signup.tsx']);
  assert.equal(g.text, text);
  assert.equal(g.v, 1); assert.equal(g.source, 'kora');
  assert.equal(graphPacketFrom({ text: '  ', files: [] }), undefined);
  assert.equal(graphPacketFrom(null), undefined);
});

test('buildTaskSpec: goal + continuation, structured context, ordered deduped route, report next to the .md, parent, verify', winSkip, () => {
  const md = '/wt/.kora/swarm/s4.md';
  const spec = buildTaskSpec({
    taskId: 's4', goal: 'Rename foo to bar', continuation: 'NOTE: previous worker was cut off',
    packet: { text: '■ FUNCTION foo @ src/a.ts:3', files: ['src/a.ts'] }, check: ' pnpm test ', checkTimeoutMs: 90_000,
    budget: { maxUsd: 0.05 }, route: ['opencode/big-pickle', 'openrouter/x:free', 'opencode/big-pickle'],
    worktree: { path: '/wt', mainRoot: '/repo', branch: 'kora/koragent-1' }, runtimeMode: 'auto-accept-edits',
    reportMdPath: md, orchestratorId: 'chat:t1', verify: { maxFixRounds: 2, escalateAfter: 1 },
  });
  assert.equal(spec.v, 1);
  assert.equal(spec.taskId, 's4');
  assert.equal(spec.goal, 'Rename foo to bar\n\n---\nNOTE: previous worker was cut off');
  assert.deepEqual(spec.route, [{ model: 'opencode/big-pickle' }, { model: 'openrouter/x:free' }]);
  assert.deepEqual(spec.acceptance, { check: 'pnpm test', checkTimeoutMs: 90_000 });
  assert.deepEqual(spec.budget, { maxUsd: 0.05 });
  assert.equal(spec.permission, 'auto-edits');
  assert.deepEqual(spec.report, { path: '/wt/.kora/swarm/s4.json' });
  assert.deepEqual(spec.parent, { kind: 'kora', orchestratorId: 'chat:t1' });
  assert.deepEqual(spec.verify, { maxFixRounds: 2, escalateAfter: 1 });
  assert.deepEqual(spec.worktree, { path: '/wt', mainRoot: '/repo', branch: 'kora/koragent-1' });
  assert.equal(spec.context!.symbols[0].name, 'foo');
  // a pane orchestrator is also the parent pane; no check / packet → no fields
  const s2 = buildTaskSpec({ taskId: 's5', goal: 'x', route: ['m'], worktree: { path: '/w', mainRoot: '/w', branch: '' }, reportMdPath: '/w/s5.md', orchestratorId: 'p3' });
  assert.deepEqual(s2.parent, { kind: 'kora', orchestratorId: 'p3', paneId: 'p3' });
  assert.deepEqual(s2.acceptance, {});
  assert.equal('context' in s2, false);
  assert.equal(s2.permission, 'supervised');
  assert.equal(JSON.stringify(s2).includes('undefined'), false);
  assert.equal(reportJsonPath(md), '/wt/.kora/swarm/s4.json');
  assert.equal(taskSpecPath(md), '/wt/.kora/swarm/s4.task.json');
  const dir = tmp();
  const f = writeTaskSpec(path.join(dir, 'x', 's4.task.json'), spec);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), spec);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('renderTaskReport keeps the five sections kora_wait reads, in order', winSkip, () => {
  const md = renderTaskReport(REPORT);
  const heads = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## Status', '## Changes', '## Check', '## Findings', '## Blockers']);
  assert.match(md, /## Status\ndone — renamed the helper\n/);
  assert.match(md, /- src\/a\.ts \(\+3 −1\) — rename/);
  assert.match(md, /`pnpm test` → exit 0 \(run by the harness\)\n```\n12 passed\n```/);
  assert.match(md, /- b\.ts still imports the old name \(src\/b\.ts:4\)/);
  assert.match(md, /## Blockers\nnone\n$/);
  const failed = renderTaskReport({ ...REPORT, status: 'budget', changes: [], check: null, findings: [], blockers: ['out of budget'] });
  assert.match(failed, /## Status\npartial \(budget reached\)/);
  assert.match(failed, /## Changes\nnone/);
  assert.match(failed, /## Check\nnot run/);
  assert.match(failed, /## Blockers\n- out of budget/);
});

test('asTaskReport rejects non-reports and normalizes shapes', winSkip, () => {
  assert.equal(asTaskReport(null), null);
  assert.equal(asTaskReport({ status: 'weird' }), null);
  const r = asTaskReport({ status: 'partial', summary: 3, changes: [{ path: 'a', added: '2' }, { nope: 1 }] })!;
  assert.equal(r.status, 'partial');
  assert.equal(r.summary, '3');
  assert.deepEqual(r.changes, [{ path: 'a', added: 2, removed: 0 }]);
  assert.deepEqual(r.usage, { steps: 0, tokens: {}, costUsd: 0, refCostUsd: 0, bySource: {} });
});

test('ensureReportFiles: from the event, from the JSON on disk (file fallback), never through a symlink, stale files rewritten', winSkip, () => {
  const dir = tmp();
  const md = path.join(dir, 's1.md');
  assert.equal(ensureReportFiles(md, null), false, 'nothing to render');
  assert.equal(ensureReportFiles(md, REPORT), true);
  assert.match(fs.readFileSync(md, 'utf8'), /^## Status\ndone/);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportJsonPath(md), 'utf8')), REPORT);
  // Koragent's own .md is kept
  fs.writeFileSync(md, '## Status\nkoragent wrote this\n');
  ensureReportFiles(md, REPORT);
  assert.equal(fs.readFileSync(md, 'utf8'), '## Status\nkoragent wrote this\n');
  // …unless it predates the report in hand
  ensureReportFiles(md, { ...REPORT, summary: 'round 2' }, { freshAfter: Date.now() + 60_000 });
  assert.match(fs.readFileSync(md, 'utf8'), /round 2/);
  // JSON only on disk → .md rendered from it
  const d2 = tmp(); const md2 = path.join(d2, 's2.md');
  fs.writeFileSync(reportJsonPath(md2), JSON.stringify({ ...REPORT, summary: 'from json' }));
  assert.equal(ensureReportFiles(md2, null), true);
  assert.match(fs.readFileSync(md2, 'utf8'), /from json/);
  // a symlinked report path is never written through
  const d3 = tmp(); const md3 = path.join(d3, 's3.md'); const target = path.join(d3, 'target.txt');
  fs.writeFileSync(target, 'secret'); fs.symlinkSync(target, md3);
  assert.equal(ensureReportFiles(md3, REPORT), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'secret');
});

test('event mappings: session.state → pane state, failover reason → attempt outcome', winSkip, () => {
  assert.equal(paneStateFor('starting'), null);
  assert.equal(paneStateFor('ready'), 'idle');
  assert.equal(paneStateFor('working'), 'working');
  assert.equal(paneStateFor('retrying'), 'working');
  assert.equal(paneStateFor('blocked'), 'blocked');
  assert.equal(paneStateFor('done'), 'idle');
  assert.equal(paneStateFor('failed'), 'idle');
  assert.equal(paneStateFor('exited'), 'idle');
  assert.equal(failoverOutcome('rate-limited (429)'), 'rate-limited');
  assert.equal(failoverOutcome('FreeUsageLimitError'), 'rate-limited');
  assert.equal(failoverOutcome('model not found'), 'model-gone');
  assert.equal(failoverOutcome('401 Unauthorized'), 'auth-failed');
  assert.equal(failoverOutcome('provider crashed'), 'crashed');
});

test('koragentPaneEnv: only the route providers\' keys, no OPENCODE_* config', winSkip, () => {
  const keys: Record<string, string | null> = { zen: 'zk', openrouter: 'ork', cerebras: 'ck' };
  const env = koragentPaneEnv({ taskId: 's1', reportMdPath: '/w/s1.md', providers: ['openrouter', 'openrouter', 'ollama'], apiKey: (p) => keys[p] ?? null });
  // The graph store reaches Koragent workers too (KORAGRAPH_*, machine-specific paths); everything else is exact.
  const { KORAGRAPH_HOME, KORAGRAPH_DB, ...rest } = env;
  assert.ok(KORAGRAPH_HOME && KORAGRAPH_DB?.endsWith('graph.db'), 'graph store env present');
  assert.deepEqual(rest, { KORA_REPORT: '/w/s1.md', KORA_SWARM_TASK_ID: 's1', OPENROUTER_API_KEY: 'ork' });
  const z = koragentPaneEnv({ taskId: 's1', reportMdPath: '/w/s1.md', providers: ['zen'], apiKey: () => null });
  assert.deepEqual(Object.keys(z).filter((k) => k.startsWith('OPENCODE_')), [], 'no key set → nothing');
  assert.equal(paneSocketPath('/h/.kora', 'p7'), '/h/.kora/panes/p7.sock');
});

test('paneSocketPath: ~/.kora/panes/<id>.sock, or a short per-home temp path when that would pass the unix-socket limit', winSkip, () => {
  assert.equal(paneSocketPath('/h/.kora', 'p3'), '/h/.kora/panes/p3.sock');
  const deep = '/private/tmp/' + 'x'.repeat(90) + '/home';
  const p = paneSocketPath(deep, 'p12');
  assert.ok(Buffer.byteLength(p) < 104, p);
  assert.match(p, /kora-[0-9a-f]{10}\/p12\.sock$/);
  assert.equal(paneSocketPath(deep, 'p12'), p, 'stable per home');
  assert.notEqual(paneSocketPath(deep + '2', 'p12'), p, 'distinct per home');
});

test('koragentPaneEnv: a local model on the route declares its server in KORAGENT_CONFIG_CONTENT (no key); remote-only routes set none', winSkip, () => {
  const base = { taskId: 's1', reportMdPath: '/w/.kora/swarm/s1.md', apiKey: () => null };
  assert.equal('KORAGENT_CONFIG_CONTENT' in koragentPaneEnv({ ...base, providers: ['zen'], route: ['opencode/big-pickle'] }), false);
  const env = koragentPaneEnv({ ...base, providers: ['ollama', 'zen'], route: ['ollama/qwen3:8b', 'ollama/llama3.1', 'opencode/big-pickle'], localBaseUrl: () => 'http://127.0.0.1:9999' });
  const cfg = JSON.parse(env.KORAGENT_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(cfg.provider), ['ollama']);
  assert.equal(cfg.provider.ollama.options.baseURL, 'http://127.0.0.1:9999/v1');
  assert.deepEqual(Object.keys(cfg.provider.ollama.models).sort(), ['llama3.1', 'qwen3:8b']);
  assert.equal(Object.keys(env).some((k) => /KEY/.test(k)), false);
});

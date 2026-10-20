'use strict';
// The koragent WorkerBackend against the REAL Koragent (no Claude leader, no tokens beyond free Zen workers): a swarm
// task through Kora's real Runtime (in-process daemon on an isolated KORA_HOME + socket), checking every contract point
// of koragent/docs/koragent/CONTRACT.md against the real peer:
//   hello/seq (+ a forced reconnect: replay from sinceSeq, no event twice), session.state → pane state/phase,
//   report files written before task.report before done, a leader steer mid-turn (id echoed), the gate bounce (a
//   `queue` steer to a done session starts a new turn → a fresh report → done), route.failover in the same pane
//   (route[0] is a bogus model), kora_wait's answer, outcomes.jsonl.
// Koragent C4 fixes, checked live too: K1 `models --json --free` (the catalog Kora parses), K2 `model.reject` of the
// CURRENT model → in-session route.failover to route[2] (no respawn), K5/K7 report status + no Kora-managed changes,
// and a direct headless `run --task-spec` whose worktree is named by its non-canonical /var form (K3) with a
// `cd <mainRoot> && …` bash command and acceptance check (K4: both must land in the worktree, not the main checkout).
// Usage: KORAGENT_BIN=<koragent or a source wrapper> node koragent-live.cjs [model] [model2]   (after `pnpm build`)
// Koragent's own home is isolated too (KORAGENT_HOME under the run dir) unless KORAGENT_HOME is set.
// Writes <SWARM_E2E_DIR or $TMPDIR/kora-kg-live>/result.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RT = path.resolve(__dirname, '../..');
const BASE = process.env.SWARM_E2E_DIR || path.join(os.tmpdir(), 'kora-kg-live');
fs.rmSync(BASE, { recursive: true, force: true });
const HOME = path.join(BASE, 'home');
fs.mkdirSync(HOME, { recursive: true });
Object.assign(process.env, {
  KORA_HOME: HOME, KORA_SOCKET_PATH: `/tmp/kora-kglive-${process.pid}.sock`, KORA_UI_PORT: '0', KORA_AUTO_INGEST: '0', KORA_AUTO_SETUP: '0',
  KORA_WORKTREES: path.join(HOME, 'wt'), KORAGRAPH_HOME: path.join(BASE, 'kg'), KORAGRAPH_DB: path.join(BASE, 'graph.db'),
  KORAGENT_HOME: process.env.KORAGENT_HOME || path.join(BASE, 'koragent-home'),
});
const BIN = process.env.KORAGENT_BIN;
if (!BIN) { console.error('set KORAGENT_BIN'); process.exit(2); }
const MODEL = process.argv[2] || 'opencode/big-pickle';
const MODEL2 = process.argv[3] || 'opencode/space-bunny-free';

const { createServer } = require(path.join(RT, 'dist/server/daemon.js'));
const { SwarmService } = require(path.join(RT, 'dist/server/swarm.js'));
const { SwarmHealth } = require(path.join(RT, 'dist/server/swarm-health.js'));
const { makeFleetOps } = require(path.join(RT, 'dist/server/fleet-ops.js'));
const { fleetControlFrom, fleetToolSpecs } = require(path.join(RT, 'dist/session/fleet-tools.js'));
const { parseModelsJson } = require(path.join(RT, 'dist/server/koragent-catalog.js'));
const { isManaged } = require(path.join(RT, 'dist/server/worktree.js'));

const until = async (f, ms) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200)); return f(); };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repo() {
  const dir = path.join(BASE, 'repo'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'e2e@kora'); git(dir, 'config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kglive', type: 'module' }, null, 2));
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

// K3 + K4: a headless `run --task-spec` NOT through Kora (Kora rewrites main-checkout paths itself, which would hide
// Koragent's own remap). The worktree is named by its /var form while Koragent's cwd is the realpath (/private/var on
// macOS); the goal and the check `cd` into the main checkout.
async function directRun(repoDir, check, out) {
  const wtReal = path.join(BASE, 'k4-wt');
  git(repoDir, 'worktree', 'add', '-q', '-b', 'k4', wtReal);
  // BASE is under os.tmpdir(): /var/folders/… on macOS, whose realpath (Koragent's cwd) is /private/var/folders/….
  const wt = wtReal;
  const main = fs.realpathSync.native(repoDir);
  const report = path.join(wt, '.kora', 'swarm', 'k4.json');
  const spec = {
    v: 1, taskId: 'k4', permission: 'full', budget: { maxSteps: 12 },
    goal: [
      'Do exactly these two steps, then call task_report with status "done":',
      `1. With the write tool, create the file ${wt}/k3-write.txt containing the single word k3.`,
      `2. With the bash tool, run exactly: cd ${main} && echo k4 > k4-bash.txt`,
    ].join('\n'),
    acceptance: { check: `cd ${main} && pwd > k4-check.txt && test -f k4-bash.txt`, checkTimeoutMs: 60_000 },
    route: [{ model: MODEL2 }, { model: MODEL }],
    worktree: { path: wt, mainRoot: main, branch: 'k4' },
    report: { path: report },
  };
  const file = path.join(BASE, 'k4.task.json');
  fs.writeFileSync(file, JSON.stringify(spec, null, 2));
  const t0 = Date.now();
  let code = 0;
  try { execFileSync(BIN, ['run', '--task-spec', file], { cwd: wt, encoding: 'utf8', timeout: 6 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { code = e.status ?? -1; }
  const rj = (() => { try { return JSON.parse(fs.readFileSync(report, 'utf8')); } catch { return null; } })();
  const inWt = (f) => fs.existsSync(path.join(wtReal, f));
  const inMain = (f) => fs.existsSync(path.join(repoDir, f));
  out.direct = { wt, canonicalWt: fs.realpathSync.native(wtReal), exit: code, ms: Date.now() - t0, status: rj?.status, check: rj?.check, changes: rj?.changes?.map((c) => c.path), blockers: rj?.blockers };
  check('K3 worktree named by its non-canonical path: write tool not denied (k3-write.txt in the worktree)', inWt('k3-write.txt'), { wt, canonical: out.direct.canonicalWt, nonCanonical: wt !== out.direct.canonicalWt, blockers: rj?.blockers });
  check('K4 acceptance check `cd <mainRoot> && …` ran in the worktree (k4-check.txt there, not in main)', inWt('k4-check.txt') && !inMain('k4-check.txt') && fs.realpathSync.native(fs.readFileSync(path.join(wtReal, 'k4-check.txt'), 'utf8').trim()) === fs.realpathSync.native(wtReal), { wt: inWt('k4-check.txt'), main: inMain('k4-check.txt'), pwd: inWt('k4-check.txt') ? fs.readFileSync(path.join(wtReal, 'k4-check.txt'), 'utf8').trim() : null });
  check('K4 bash `cd <mainRoot> && …` ran in the worktree (k4-bash.txt there, not in main)', inWt('k4-bash.txt') && !inMain('k4-bash.txt'), { wt: inWt('k4-bash.txt'), main: inMain('k4-bash.txt') });
  check('K4 direct run: check passed, report done', rj?.check?.exitCode === 0 && rj?.status === 'done', { status: rj?.status, exit: code, check: rj?.check && { command: rj.check.command, exitCode: rj.check.exitCode } });
}

(async () => {
  const out = { model: MODEL, bin: BIN, checks: {}, events: [], t0: Date.now() };
  const check = (k, ok, detail) => { out.checks[k] = { ok: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`${ok ? 'PASS' : 'FAIL'} ${k}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false, sweep: false });
  const notes = [];
  const orig = h.runtime.notify.bind(h.runtime);
  h.runtime.notify = (method, params) => { notes.push({ method, params }); return orig(method, params); };
  const MODELS = [
    { id: 'opencode/no-such-model-kglive', provider: 'zen', label: 'bogus', rank: 0, maxConcurrent: 4 },
    { id: MODEL, provider: MODEL.startsWith('openrouter/') ? 'openrouter' : 'zen', label: MODEL.split('/').pop(), rank: 1, maxConcurrent: 4 },
    { id: MODEL2, provider: MODEL2.startsWith('openrouter/') ? 'openrouter' : 'zen', label: MODEL2.split('/').pop(), rank: 2, maxConcurrent: 4 },
  ];
  const health = new SwarmHealth(path.join(HOME, 'h.json'));
  let gates = 0;
  const setup = { getStatus: async () => ({ ready: true, blockers: [], preferences: { maxWorkers: 4 } }), pickableModels: () => MODELS.filter((m) => health.isAvailable(m.id)) };
  const svc = new SwarmService({ runtime: h.runtime, setup, health, io: {
    threadMode: () => 'swarm', workerBackend: () => 'koragent', koragentPath: () => BIN, apiKey: (p) => process.env[{ zen: 'OPENCODE_API_KEY', openrouter: 'OPENROUTER_API_KEY', cerebras: 'CEREBRAS_API_KEY' }[p]] || null, // keyless Zen is gone: provider keys come from env random: () => 0.5,
    contextPacket: async () => ({ text: '', files: [] }), screenPollMs: 0, nudgeMs: 120_000, watchdogTickMs: 0,
    // The first gate bounces (a broken-caller finding) → Kora sends a `queue` steer to the (done) session.
    verifyGate: async ({ paneId }) => (++gates === 1 ? [{ a: paneId, b: 'main', status: 'semantic', reason: 'broken callers', blame: [{ file: 'src/math.js', line: 1, symbol: 'sub', removed: false, byWorker: paneId, compatible: false }] }] : []),
    // defaultModel = the bogus id: route[0] is a model Zen does not have → an in-session route.failover.
    config: () => ({ autoVerify: true, maxBounces: 2, maxWorkers: 4, defaultModel: MODELS[0].id }),
  } });
  h.runtime.swarm = svc;
  const cwd = repo();
  const ctl = fleetControlFrom(makeFleetOps(h.runtime));
  const specs = fleetToolSpecs({ fleet: ctl, orchestratorId: 'chat:kglive', agent: 'claude', cwd, account: null, agentMode: 'swarm', swarm: svc, spawnWorker: async () => { throw new Error('no'); } });
  const tool = (n) => specs.find((t) => t.name === n);
  let pane = null;
  try {
    // K1: the catalog Kora reads (`models --json --free`) answers JSON, not the --verbose fallback.
    let catalog = null;
    try { catalog = parseModelsJson(execFileSync(BIN, ['models', '--json', '--free'], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()); } catch (e) { catalog = null; out.catalogError = String(e?.message || e).slice(0, 300); }
    out.catalog = catalog && catalog.map((m) => m.id);
    check('K1 models --json --free: JSON rows, every :free route model listed free', !!catalog && [MODEL, MODEL2].filter((id) => id.endsWith(':free')).every((id) => catalog.some((m) => m.id === id && m.free)), out.catalog);
    const task = 'In src/math.js add and export `sub(a, b)` (a - b) and `mul(a, b)` (a * b), ESM, one line each. Verify with node -e. Keep it tiny.';
    const r = await svc.spawn({ orchestratorId: 'chat:kglive', cwd, task, title: 'kg live', runtimeMode: 'full-access' });
    pane = h.runtime.panes.get(r.paneId);
    out.taskId = r.taskId; out.paneId = r.paneId; out.reportPath = r.reportPath;
    const spec = JSON.parse(fs.readFileSync(pane.args[1], 'utf8'));
    check('launch: --task-spec + --event-stream unix:<KORA_HOME>/panes/<id>.sock', pane.args[0] === '--task-spec' && pane.args.at(-2) === '--event-stream' && pane.args.at(-1) === `unix:${pane.eventSocketPath}`, pane.args.slice(-1)[0]);
    check('spec route: bogus first, then the real models', spec.route[0]?.model === MODELS[0].id && spec.route.map((x) => x.model).sort().join(',') === MODELS.map((m) => m.id).sort().join(','), spec.route);
    // Kora orders the real entries itself: the failover target is route[1], the K2 reject target route[2].
    const R1 = spec.route[1]?.model; const R2 = spec.route[2]?.model;
    const client = pane.koragent;
    const seen = [];
    const paneStates = []; const phases = [];
    pane.on('state', () => { if (paneStates.at(-1) !== pane.state) paneStates.push(pane.state); });
    const phaseTimer = setInterval(() => { const ph = pane.swarm?.phase; if (ph && phases.at(-1) !== ph) phases.push(ph); }, 50);
    let dup = 0; let last = 0;
    client.on('event', (e) => {
      out.events.push({ t: Date.now() - out.t0, seq: e.seq, type: e.type, ...(e.type === 'session.state' ? { state: e.state } : {}), ...(e.type === 'route.failover' ? { from: e.from, to: e.to, reason: e.reason } : {}), ...(e.type.startsWith('steer.') ? { id: e.id, source: e.source, delivery: e.delivery } : {}) });
      if (e.type !== 'hello') { if (e.seq <= last) dup++; last = Math.max(last, e.seq); }
      seen.push(e);
      if (e.type === 'task.report') {
        const json = r.reportPath.replace(/\.md$/, '.json');
        out.reportFilesAtEvent = (out.reportFilesAtEvent || []).concat([{ json: fs.existsSync(json), md: fs.existsSync(r.reportPath) }]);
      }
    });
    check('hello first on connect', await until(() => seen.some((e) => e.type === 'hello'), 60_000), seen[0]?.type);
    const hello = seen.find((e) => e.type === 'hello');
    out.hello = hello && { version: hello.version, capabilities: hello.capabilities, replayFrom: hello.replayFrom, seq: hello.seq };
    check('hello seq 0 with version + capabilities', hello && hello.seq === 0 && hello.version && Array.isArray(hello.capabilities), out.hello);
    // Mid-turn, as soon as the worker is using tools: a forced reconnect, then a leader steer.
    await until(() => seen.some((e) => e.type === 'tool.start') || pane.swarm?.phase === 'done', 120_000);
    const before = client.lastSeq;
    client.sock?.destroy();
    check('reconnect with hello{sinceSeq} (mid-turn)', await until(() => client.connects >= 2, 20_000), { connects: client.connects, sinceSeq: before });
    const t0 = Date.now();
    const pr = await tool('kora_prompt').handler({ paneId: r.paneId, text: 'Also add a one-line JSDoc comment above sub.', waitIdle: false });
    await until(() => seen.some((e) => e.type === 'steer.received' && e.source === 'leader'), 6_000);
    const ack = seen.find((e) => e.type === 'steer.received' && e.source === 'leader');
    check('leader steer mid-turn: delivered, steer.received echoes Kora\'s id < 5 s', /^delivered/.test(pr.text) && !!ack && /^p\d+-\d+$/.test(ack.id), { text: pr.text.split('\n')[0], id: ack?.id, delivery: ack?.delivery, ms: Date.now() - t0 });
    // failover in the same pane (it happened before the first step)
    check('route.failover bogus → real (same pane)', seen.some((e) => e.type === 'route.failover' && e.from === MODELS[0].id && e.to === R1), seen.find((e) => e.type === 'route.failover'));
    check('pane.swarm.model moved to the real model', await until(() => pane.swarm?.model === R1, 10_000), pane.swarm?.model);
    // K2: Kora's watchdog escalation — reject the model the worker is on, mid-turn; Koragent switches at the next step.
    const rejectAt = seen.length;
    client.send({ type: 'model.reject', model: R1, reason: 'stalled: no progress toward a report (koragent-live K2)' });
    const k2 = () => seen.slice(rejectAt).find((e) => e.type === 'route.failover' && e.from === R1 && e.to === R2);
    check('K2 model.reject of the current model → in-session route.failover to route[2]', await until(k2, 5 * 60_000), k2() && { from: k2().from, to: k2().to, reason: k2().reason });
    const k2switch = () => seen.slice(rejectAt).find((e) => e.type === 'model.switch' && e.to === R2);
    check('K2 the next step runs on route[2] (model.switch), same pane, pane.swarm.model follows', await until(() => k2switch() && pane.swarm?.model === R2, 5 * 60_000) && h.runtime.panes.get(r.paneId) === pane, { switch: k2switch() && { from: k2switch().from, to: k2switch().to }, model: pane.swarm?.model });
    // Done → report → gate bounce (queue steer on a done session) → new turn → fresh report → done → verify passed.
    check('phase done after the bounce round', await until(() => pane.swarm?.phase === 'done', 10 * 60_000), { phase: pane.swarm?.phase, verify: pane.swarm?.verify });
    clearInterval(phaseTimer);
    if (phases.at(-1) !== pane.swarm?.phase) phases.push(pane.swarm?.phase);
    const delivered = seen.find((e) => e.type === 'steer.delivered' && e.id === ack?.id);
    check('leader steer: steer.delivered', !!delivered, delivered && { atStep: delivered.atStep });
    out.paneStates = paneStates; out.phases = phases;
    check('pane state went working → idle (from session.state, no screen scraping)', paneStates.includes('working') && paneStates.at(-1) === 'idle', paneStates.join(' → '));
    check('phase starting → running → done', phases.includes('running') && phases.at(-1) === 'done', phases.join(' → '));
    const states = seen.filter((e) => e.type === 'session.state').map((e) => e.state);
    out.states = states;
    check('two done states (round 1 + the bounce round)', states.filter((s) => s === 'done').length >= 2, states.join(' → '));
    const bounceSteer = seen.find((e) => e.type === 'steer.received' && e.source === 'kora' && e.delivery === 'queue');
    check('the bounce is a kora queue steer, acknowledged', !!bounceSteer, bounceSteer && { id: bounceSteer.id });
    const idx = (t, from = 0) => seen.findIndex((e, i) => i >= from && e.type === t);
    const rep1 = idx('task.report'); const done1 = seen.findIndex((e, i) => i > rep1 && e.type === 'session.state' && e.state === 'done');
    check('order: task.report before session.state done', rep1 >= 0 && done1 > rep1);
    check('report files exist when task.report arrives', (out.reportFilesAtEvent || []).every((x) => x.json && x.md), out.reportFilesAtEvent);
    check('verify passed after 1 bounce', pane.swarm?.verify?.state === 'passed' && pane.swarm?.verify?.bounces === 1, pane.swarm?.verify);
    check('no event twice', dup === 0, { dup });
    const md = fs.readFileSync(r.reportPath, 'utf8');
    check('report .md has the five sections', ['## Status', '## Changes', '## Check', '## Findings', '## Blockers'].every((s) => md.includes(s)), md.split('\n').filter((l) => l.startsWith('## ')));
    const wait = (await tool('kora_wait').handler({ paneId: r.paneId })).text;
    out.koraWait = wait.split('\n').slice(0, 6);
    check('kora_wait: idle + verify passed + report', /: idle$/.test(wait.split('\n')[0]) && /verify: passed/.test(wait) && /--- report /.test(wait), out.koraWait);
    check('same pane throughout', h.runtime.panes.get(r.paneId) === pane && svc.follow(r.paneId) === r.paneId);
    const wt = pane.worktree.path;
    out.diff = execFileSync('git', ['diff', '--stat'], { cwd: wt, encoding: 'utf8' }).trim();
    out.mathJs = fs.readFileSync(path.join(wt, 'src/math.js'), 'utf8');
    const rj = JSON.parse(fs.readFileSync(r.reportPath.replace(/\.md$/, '.json'), 'utf8'));
    out.reportJson = { status: rj.status, attempts: rj.attempts, usage: rj.usage, check: rj.check };
    out.reportJson.changes = rj.changes;
    check('attempts: bogus gone, rejected model recorded, route[2] ok', rj.attempts?.[0]?.outcome === 'gone' && rj.attempts?.some((a) => a.model === R1 && a.outcome !== 'ok') && rj.attempts?.some((a) => a.model === R2 && a.outcome === 'ok'), rj.attempts);
    check('K5 report status done (harness check passed or task_report done)', rj.status === 'done', { status: rj.status, summary: rj.summary });
    check('K7 report changes: no Kora-managed files, src/math.js listed', (rj.changes || []).every((c) => !isManaged(c.path)) && (rj.changes || []).some((c) => c.path === 'src/math.js'), (rj.changes || []).map((c) => c.path));
    const attempts = pane.swarm.attempts.map((a) => [a.model, a.outcome]);
    check('Kora attempts: model-gone then running/ok in the same pane', attempts[0][1] === 'model-gone', attempts);
    check('bogus model cooling in SwarmHealth', !health.isAvailable('opencode/no-such-model-kglive'));
    await directRun(cwd, check, out);
  } catch (e) {
    out.error = String(e?.stack || e); console.error(e);
  } finally {
    out.wallMs = Date.now() - out.t0;
    out.pass = !out.error && Object.values(out.checks).every((c) => c.ok);
    try { const rows = fs.readFileSync(path.join(HOME, 'swarm', 'outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); out.outcome = rows.at(-1); } catch { /* none */ }
    fs.writeFileSync(path.join(BASE, 'result.json'), JSON.stringify(out, null, 2));
    console.log(`\n${out.pass ? 'PASS' : 'FAIL'} in ${Math.round(out.wallMs / 1000)} s → ${path.join(BASE, 'result.json')}`);
    if (pane) h.runtime.killPane(pane.id);
    await h.close().catch(() => {});
    process.exit(out.pass ? 0 : 1);
  }
})();

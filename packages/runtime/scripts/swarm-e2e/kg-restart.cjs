'use strict';
// Live proof for the Koragent E2E restart defects (D17/D18), no Claude: an isolated daemon (own KORA_HOME, socket, UI
// port, KORAGENT_HOME) with swarm.workerBackend=koragent and the compiled Koragent installed by `kora swarm install`.
// A scripted leader — the fleet tools over the daemon socket, exactly what `kora mcp --fleet` serves — spawns two
// Koragent tasks for a Swarm-mode chat thread. Once task A has reported and task B is mid-task, the daemon is stopped
// and started again. Checks: A stays done (never relaunched), B resumes on its old pane id with a digest continuation,
// and a FRESH bridge (a restarted leader) gets kora_wait answers for both; then both merge and their tests pass.
// Usage: KORAGENT_DIST=<dist dir|binary> SWARM_E2E_DIR=<scratch> SWARM_E2E_SOCKET=/tmp/x.sock E2E_UI_PORT=8812 node kg-restart.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { RT, BIN, BASE, HOME, env, childEnv } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { makeRemoteFleet } = require(path.join(RT, 'dist/server/fleet-ops.js'));
const { fleetToolSpecs } = require(path.join(RT, 'dist/session/fleet-tools.js'));

const DIST = process.env.KORAGENT_DIST;
if (!DIST) { console.error('set KORAGENT_DIST'); process.exit(2); }
const KG_HOME = path.join(BASE, 'koragent-home');
const OUT = path.join(BASE, 'results', `restart-${Date.now().toString(36)}`);
fs.mkdirSync(OUT, { recursive: true });
const denv = () => ({ ...childEnv(), KORAGENT_HOME: KG_HOME, KORA_AUTO_INGEST: '0' });
const kora = (...a) => execFileSync(process.execPath, [BIN, ...a], { env: denv(), encoding: 'utf8', timeout: 180_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'log.txt'), l + '\n'); };

function prepare() {
  fs.mkdirSync(HOME, { recursive: true });
  const cfgPath = path.join(HOME, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.swarm = { ...(cfg.swarm || {}), workerBackend: 'koragent', consent: { noticeVersion: 1, acceptedAt: Date.now() } };
  cfg.trustedRoots = [path.join(BASE, 'repos'), path.join(HOME, 'worktrees')];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  if (!fs.existsSync(path.join(KG_HOME, 'bin', 'koragent'))) log('install:', kora('swarm', 'install', '--backend', 'koragent', '--from', DIST, '--yes').trim().split('\n').pop());
}

function start() {
  const out = fs.openSync(path.join(BASE, 'daemon.out'), 'a');
  const p = spawn(process.execPath, [BIN, 'server', 'run'], { env: denv(), detached: true, stdio: ['ignore', out, out] });
  p.unref();
  return p.pid;
}
async function connect(ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const c = new KoraClient(env.KORA_SOCKET_PATH);
    try { await c.connect(2000); return c; } catch { c.close?.(); if (Date.now() - t0 > ms) throw new Error('daemon did not come up'); await sleep(500); }
  }
}

function makeRepo() {
  const dir = path.join(BASE, 'repos', `rs-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w('package.json', JSON.stringify({ name: 'rs', type: 'module' }, null, 2));
  w('src/tax.js', 'export const RATES = { CA: 0.0725, OR: 0 }\n\nexport function taxFor(subtotalCents, region) {\n  const rate = RATES[region]\n  if (rate === undefined) throw new Error(`unknown region ${region}`)\n  // BUG: tax is computed on dollars, not cents\n  return Math.round((subtotalCents / 100) * rate)\n}\n');
  w('src/lines.js', 'export function subtotal(lines) {\n  // BUG: skips the first line\n  let sum = 0\n  for (let i = 1; i < lines.length; i++) sum += lines[i].qty * lines[i].unitCents\n  return sum\n}\n');
  const hdr = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\n';
  w('test/tax.test.js', hdr + 'import { taxFor } from "../src/tax.js"\ntest("CA tax on $100.00", () => assert.equal(taxFor(10000, "CA"), 725))\n');
  w('test/lines.test.js', hdr + 'import { subtotal } from "../src/lines.js"\ntest("sums every line", () => assert.equal(subtotal([{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 250 }]), 1250))\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}

function leader(orch, cwd) {
  const remote = makeRemoteFleet(env.KORA_SOCKET_PATH);
  const specs = fleetToolSpecs({ fleet: remote.control, orchestratorId: orch, agent: 'claude', cwd, account: null, runtimeMode: 'full-access', spawnWorker: remote.spawnWorker, agentMode: 'swarm', swarm: remote.swarm });
  const tool = async (n, a) => { const r = await specs.find((s) => s.name === n).handler(a); fs.appendFileSync(path.join(OUT, 'leader.txt'), `\n>>> ${n} ${JSON.stringify(a)}\n${r.text}\n`); return r; };
  return { tool, close: () => remote.close() };
}
const tasksJson = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')).tasks; } catch { return []; } };

(async () => {
  const res = { checks: {} };
  prepare();
  start();
  let c = await connect();
  const dir = makeRepo();
  res.repo = dir;
  const th = await c.call('chat.thread.create', { agent: 'claude', cwd: dir, agentMode: 'swarm', title: 'kg restart proof' });
  const orch = `chat:${th.threadId ?? th.id}`;
  await c.call('chat.session.setPermissionMode', { threadId: th.threadId ?? th.id, mode: 'full-access' }).catch(() => {});
  c.close();
  let L = leader(orch, dir);
  const sp = await L.tool('kora_spawn', { agent: 'swarm', tasks: [
    { title: 'A lines', prompt: `Fix the bug in ${dir}/src/lines.js: subtotal skips the first line. Remove the BUG comment. Do not touch tests.`, check: 'node --test test/lines.test.js' },
    { title: 'B tax', prompt: `First run exactly \`sleep 150\` in bash and wait for it to finish (a required warm-up; skip it only if a NOTE below says the daemon restarted). Then fix the bug in ${dir}/src/tax.js: tax is computed on dollars, not cents. Remove the BUG comment. Do not touch tests.`, check: 'node --test test/tax.test.js' },
  ] });
  if (sp.isError) throw new Error(sp.text);
  const ids = [...sp.text.matchAll(/spawned swarm worker (p\d+) \(task (s\d+)/g)].map((m) => ({ pane: m[1], task: m[2] }));
  const [A, B] = ids;
  log('spawned', JSON.stringify(ids));
  const wa = await L.tool('kora_wait', { paneId: A.pane, timeoutMs: 480_000 });
  log('A before restart:', wa.text.split('\n').slice(0, 3).join(' | '));
  const before = tasksJson();
  const st = (id) => before.find((t) => t.taskId === id)?.status;
  res.before = { A: st(A.task), B: st(B.task) };
  log('tasks.json before stop:', JSON.stringify(res.before));
  res.checks.bMidTaskAtStop = ['starting', 'running', 'rate-limited'].includes(st(B.task));
  L.close();

  log('stop:', kora('server', 'stop').trim());
  await sleep(1500);
  res.afterStop = tasksJson().map((t) => [t.taskId, t.status]);
  start();
  c = await connect();
  c.close();
  await sleep(8000);
  const after = tasksJson();
  res.afterRestart = after.map((t) => ({ id: t.taskId, status: t.status, panes: t.paneIds }));
  log('tasks.json after restart:', JSON.stringify(res.afterRestart));
  const srv = fs.readFileSync(path.join(HOME, 'server.log'), 'utf8').split('\n').filter((l) => /swarm: restart|restore:/.test(l)).slice(-6);
  res.serverLog = srv; log(srv.join('\n'));
  const aRow = after.find((t) => t.taskId === A.task); const bRow = after.find((t) => t.taskId === B.task);
  res.checks.aStaysDone = aRow?.status === 'done' && aRow.paneIds.length === 1;
  res.checks.bResumedSamePane = !!bRow && bRow.paneIds[bRow.paneIds.length - 1] === B.pane && bRow.status !== 'failed';
  const specFile = path.join(path.dirname(bRow?.reportPath ?? ''), `${B.task}.task.json`);
  try { res.checks.bDigest = /Kora's daemon restarted/.test(JSON.parse(fs.readFileSync(specFile, 'utf8')).goal); } catch { res.checks.bDigest = false; }

  L = leader(orch, dir); // a restarted leader: fresh bridge, empty cache
  const wk = await L.tool('kora_workers', {});
  res.checks.workersListB = new RegExp(`${B.pane} .*task=${B.task}`).test(wk.text);
  const wa2 = await L.tool('kora_wait', { paneId: A.pane, timeoutMs: 30_000 });
  res.checks.waitAAfterRestart = !wa2.isError && /no longer running \(done\)/.test(wa2.text) && /## Status/.test(wa2.text);
  const wb = await L.tool('kora_wait', { paneId: B.pane, timeoutMs: 600_000 });
  res.checks.waitBAfterRestart = !wb.isError && /foreman: PASS|## Status\n?done/.test(wb.text);
  log('B after restart:', wb.text.split('\n').slice(0, 4).join(' | '));
  // One call for both, as a leader does: A finished before the restart (no pane), B is live.
  const m = await L.tool('kora_merge', { paneIds: [A.pane, B.pane] });
  log('merge', m.text.replace(/\n/g, ' | '));
  res.checks.mergeBothInOneCall = !m.isError && new RegExp(`${A.pane}: merged`).test(m.text) && new RegExp(`${B.pane}: merged`).test(m.text);
  L.close();
  try { execFileSync(process.execPath, ['--test', 'test/lines.test.js', 'test/tax.test.js'], { cwd: dir, stdio: 'ignore' }); res.checks.testsGreen = true; } catch { res.checks.testsGreen = false; }
  res.pass = Object.values(res.checks).every(Boolean);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  try { kora('server', 'stop'); } catch {}
  process.exit(res.pass ? 0 : 1);
})().catch((e) => { console.error(e); try { kora('server', 'stop'); } catch {} process.exit(1); });

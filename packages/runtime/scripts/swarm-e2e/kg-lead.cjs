'use strict';
// Live proof for D4/D5 (Kora part), D20 and D31, no Claude: on the isolated daemon of kg-restart.cjs (koragent backend,
// compiled Koragent installed in KORAGENT_HOME), a Koragent LEAD pane — `kora agent spawn koragent -- --lead --prompt …`,
// whose KoraWorkerPool mounts `kora mcp --fleet --agent-mode swarm` — dispatches swarm workers for a 3-bug repo.
// Checks: the pane runs the installed binary (D20), its workers' TaskSpecs are not `supervised` (D5) and no worker ever
// parks on a permission, and the tasks reach done. Usage: same env as kg-restart.cjs (after it installed Koragent).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { RT, BIN, BASE, HOME, env, childEnv } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));

const KG_HOME = path.join(BASE, 'koragent-home');
const OUT = path.join(BASE, 'results', `lead-${Date.now().toString(36)}`);
fs.mkdirSync(OUT, { recursive: true });
const MAX_MS = Number(process.env.KG_LEAD_MAX_MS || 15 * 60_000);
const denv = () => ({ ...childEnv(), KORAGENT_HOME: KG_HOME, KORA_AUTO_INGEST: '0' });
const kora = (...a) => execFileSync(process.execPath, [BIN, ...a], { env: denv(), encoding: 'utf8', timeout: 180_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'log.txt'), l + '\n'); };

function makeRepo() {
  const dir = path.join(BASE, 'repos', `lead-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w('package.json', JSON.stringify({ name: 'invoicer', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w('src/tax.js', 'export const RATES = { CA: 0.0725, OR: 0 }\n\nexport function taxFor(subtotalCents, region) {\n  const rate = RATES[region]\n  if (rate === undefined) throw new Error(`unknown region ${region}`)\n  // BUG: tax is computed on dollars, not cents\n  return Math.round((subtotalCents / 100) * rate)\n}\n');
  w('src/discount.js', 'export const CODES = { HALF: { pct: 50, capCents: 2000 } }\n\nexport function discountFor(subtotalCents, code) {\n  const c = CODES[String(code || "").toUpperCase()]\n  if (!c) return 0\n  // BUG: the cap is ignored\n  return Math.floor((subtotalCents * c.pct) / 100)\n}\n');
  w('src/lines.js', 'export function subtotal(lines) {\n  // BUG: skips the first line\n  let sum = 0\n  for (let i = 1; i < lines.length; i++) sum += lines[i].qty * lines[i].unitCents\n  return sum\n}\n');
  const hdr = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\n';
  w('test/tax.test.js', hdr + 'import { taxFor } from "../src/tax.js"\ntest("CA tax on $100.00", () => assert.equal(taxFor(10000, "CA"), 725))\n');
  w('test/discount.test.js', hdr + 'import { discountFor } from "../src/discount.js"\ntest("HALF capped at $20", () => assert.equal(discountFor(10000, "HALF"), 2000))\n');
  w('test/lines.test.js', hdr + 'import { subtotal } from "../src/lines.js"\ntest("sums every line", () => assert.equal(subtotal([{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 250 }]), 1250))\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}

async function connect(ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const c = new KoraClient(env.KORA_SOCKET_PATH);
    try { await c.connect(2000); return c; } catch { if (Date.now() - t0 > ms) throw new Error('daemon did not come up'); await sleep(500); }
  }
}

(async () => {
  const res = { checks: {} };
  const out = fs.openSync(path.join(BASE, 'daemon.out'), 'a');
  spawn(process.execPath, [BIN, 'server', 'run'], { env: denv(), detached: true, stdio: ['ignore', out, out] }).unref();
  const c = await connect();
  const dir = makeRepo();
  res.repo = dir;
  const task = 'The tests (`node --test`) fail because of three independent bugs, one each in src/tax.js, src/discount.js and src/lines.js (the tests are correct; do not change them). Fix them in parallel with lead_dispatch: one worker per file, each with its own test file as the check (e.g. `node --test test/tax.test.js`). Then confirm `node --test` passes.';
  // D29: --help prints the usage; no pane, no AGENTS.md in the cwd.
  const n0 = (await c.call('pane.list', {})).panes.length;
  const help = execFileSync(process.execPath, [BIN, 'agent', 'spawn', 'koragent', '--help'], { cwd: dir, env: denv(), encoding: 'utf8' });
  res.checks.helpSpawnsNothing = /kora agent <subcommand>/.test(help) && (await c.call('pane.list', {})).panes.length === n0 && !fs.existsSync(path.join(dir, 'AGENTS.md'));
  const lead = JSON.parse(kora('agent', 'spawn', 'koragent', '--cwd', dir, '--no-worktree', '--name', 'lead', '--json', '--', '--lead', '--prompt', task));
  log('lead pane', lead.id, lead.command);
  res.checks.installedBinary = lead.command === path.join(KG_HOME, 'bin', 'koragent');
  const seen = new Map(); let blockedOnPermission = []; const t0 = Date.now();
  for (;;) {
    const { panes } = await c.call('pane.list', {});
    const workers = panes.filter((p) => p.orchestratorId === lead.id && p.swarm);
    for (const w of workers) {
      seen.set(w.id, { task: w.swarm.taskId, phase: w.swarm.phase, state: w.state, model: w.swarm.model, spec: path.join(path.dirname(w.swarm.reportPath), `${w.swarm.taskId}.task.json`) });
      if (w.state === 'blocked' && /permission/i.test(w.blocker || '')) blockedOnPermission.push(`${w.id}: ${w.blocker}`);
    }
    const leadPane = panes.find((p) => p.id === lead.id);
    const allDone = workers.length >= 3 && workers.every((w) => ['done', 'failed', 'exhausted'].includes(w.swarm.phase));
    if (allDone || !leadPane || leadPane.exited || Date.now() - t0 > MAX_MS) { res.leadExited = !leadPane || leadPane.exited; break; }
    await sleep(3000);
  }
  await sleep(20_000); // let the lead merge
  res.workers = [...seen.entries()].map(([id, w]) => { let perm = null; try { perm = JSON.parse(fs.readFileSync(w.spec, 'utf8')).permission; } catch {} return { id, ...w, permission: perm }; });
  res.blockedOnPermission = [...new Set(blockedOnPermission)];
  log('workers', JSON.stringify(res.workers.map((w) => [w.id, w.task, w.phase, w.permission])));
  res.checks.workersSpawned = res.workers.length >= 1;
  res.checks.noSupervisedWorker = res.workers.length > 0 && res.workers.every((w) => w.permission && w.permission !== 'supervised');
  res.checks.noPermissionBlock = res.blockedOnPermission.length === 0;
  res.checks.workersDone = res.workers.length >= 3 && res.workers.every((w) => w.phase === 'done');
  const chat = fs.readFileSync(path.join(HOME, 'server.log'), 'utf8').split('\n').filter((l) => /swarm: task s\d+ attempt 1/.test(l)).slice(-6);
  res.serverLog = chat;
  try { res.leadScreen = (await c.call('pane.read', { paneId: lead.id, source: 'screen', format: 'text' })).text.split('\n').filter((l) => l.trim()).slice(-25); } catch {}
  try { execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'ignore' }); res.testsGreenOnMain = true; } catch { res.testsGreenOnMain = false; }
  c.close();
  res.pass = Object.values(res.checks).every(Boolean);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  try { kora('server', 'stop'); } catch {}
  process.exit(res.pass ? 0 : 1);
})().catch((e) => { console.error(e); try { kora('server', 'stop'); } catch {} process.exit(1); });

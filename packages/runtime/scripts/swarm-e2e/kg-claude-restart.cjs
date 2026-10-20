'use strict';
// D17/D18 with a REAL Claude leader (the SDK chat lane, Swarm mode, Koragent workers) on the isolated daemon of
// kg-restart.cjs: turn 1 spawns two workers (B starts with a long `sleep`); once A is done and B is mid-task the daemon
// is restarted; turn 2 tells the leader the daemon restarted. Checks: A is not relaunched, B resumes on its pane id,
// the leader's kora_wait answers for both, both land and their tests pass. Spends one Claude run.
// Usage: same env as kg-restart.cjs; node kg-claude-restart.cjs [model]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { RT, BIN, BASE, HOME, env, childEnv } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));

const MODEL = process.argv[2] || 'claude-sonnet-5';
const KG_HOME = path.join(BASE, 'koragent-home');
const OUT = path.join(BASE, 'results', `claude-restart-${Date.now().toString(36)}`);
fs.mkdirSync(OUT, { recursive: true });
const denv = () => ({ ...childEnv(), KORAGENT_HOME: KG_HOME, KORA_AUTO_INGEST: '0' });
const kora = (...a) => execFileSync(process.execPath, [BIN, ...a], { env: denv(), encoding: 'utf8', timeout: 180_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'log.txt'), l + '\n'); };
const tasksJson = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')).tasks; } catch { return []; } };
function start() { const out = fs.openSync(path.join(BASE, 'daemon.out'), 'a'); spawn(process.execPath, [BIN, 'server', 'run'], { env: denv(), detached: true, stdio: ['ignore', out, out] }).unref(); }
async function connect(ms = 30_000) {
  const t0 = Date.now();
  for (;;) { const c = new KoraClient(env.KORA_SOCKET_PATH); try { await c.connect(2000); return c; } catch { if (Date.now() - t0 > ms) throw new Error('daemon did not come up'); await sleep(500); } }
}
function makeRepo() {
  const dir = path.join(BASE, 'repos', `cr-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w('package.json', JSON.stringify({ name: 'cr', type: 'module' }, null, 2));
  w('src/tax.js', 'export const RATES = { CA: 0.0725, OR: 0 }\n\nexport function taxFor(subtotalCents, region) {\n  const rate = RATES[region]\n  if (rate === undefined) throw new Error(`unknown region ${region}`)\n  // BUG: tax is computed on dollars, not cents\n  return Math.round((subtotalCents / 100) * rate)\n}\n');
  w('src/lines.js', 'export function subtotal(lines) {\n  // BUG: skips the first line\n  let sum = 0\n  for (let i = 1; i < lines.length; i++) sum += lines[i].qty * lines[i].unitCents\n  return sum\n}\n');
  const hdr = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\n';
  w('test/tax.test.js', hdr + 'import { taxFor } from "../src/tax.js"\ntest("CA tax on $100.00", () => assert.equal(taxFor(10000, "CA"), 725))\n');
  w('test/lines.test.js', hdr + 'import { subtotal } from "../src/lines.js"\ntest("sums every line", () => assert.equal(subtotal([{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 250 }]), 1250))\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}
async function turn(c, threadId, text, timeoutMs, onEvent) {
  const settled = new Promise((resolve) => {
    const on = (ev) => { if (!ev || ev.threadId !== threadId) return; fs.appendFileSync(path.join(OUT, 'thread.jsonl'), JSON.stringify(ev) + '\n'); onEvent?.(ev); if (ev.type === 'turn.settled') { c.off?.('chat.event', on); resolve(ev); } };
    c.on('chat.event', on);
    setTimeout(() => resolve(null), timeoutMs);
  });
  await c.call('chat.events.subscribe', { threadIds: [threadId] });
  await c.call('chat.turn.send', { threadId, text });
  return settled;
}

(async () => {
  const res = { checks: {}, tools: [] };
  start();
  let c = await connect();
  const dir = makeRepo(); res.repo = dir;
  const th = await c.call('chat.thread.create', { agent: 'claude', cwd: dir, agentMode: 'swarm', model: { model: MODEL }, title: 'kg claude restart' });
  const threadId = th.threadId ?? th.id; res.threadId = threadId;
  await c.call('chat.session.setPermissionMode', { threadId, mode: 'full-access' });
  const orch = `chat:${threadId}`;
  const task = [
    `Two independent bugs in ${dir}. Delegate: exactly two swarm workers in ONE kora_spawn call (tasks:[…]), then kora_wait each, merge both, and confirm \`node --test test/lines.test.js test/tax.test.js\` passes.`,
    `Worker A: fix src/lines.js (subtotal skips the first line; remove the BUG comment). Check: node --test test/lines.test.js`,
    `Worker B: its prompt must say, verbatim: "First run exactly \`sleep 150\` in bash and wait for it (a required warm-up; skip it only if a NOTE below says the daemon restarted). Then fix src/tax.js: tax is computed on dollars, not cents; remove the BUG comment." Check: node --test test/tax.test.js`,
  ].join('\n');
  const tools = (ev) => { const n = ev.toolName || ev.name || ev.item?.name; if (/tool/.test(ev.type) && n) res.tools.push(n); };
  // Turn 1 runs until A is done and B is mid-task; then the daemon goes down under it.
  const t1 = turn(c, threadId, `${swarmModeNotice('chat', 'swarm') ?? ''}\n\n${task}`, 20 * 60_000, tools);
  let A = null, B = null; const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60_000) {
    const mine = tasksJson().filter((t) => t.orchestratorId === orch);
    if (mine.length >= 2) {
      [A, B] = mine;
      const done = mine.find((t) => t.status === 'done'); const run = mine.find((t) => ['starting', 'running', 'rate-limited'].includes(t.status));
      if (done && run) { A = done; B = run; break; }
      if (mine.every((t) => t.status === 'done')) break;
    }
    await sleep(2000);
  }
  res.atStop = tasksJson().filter((t) => t.orchestratorId === orch).map((t) => [t.taskId, t.status, t.paneIds.join('>')]);
  log('at stop:', JSON.stringify(res.atStop));
  res.checks.oneDoneOneRunningAtStop = !!(A && B && A.status === 'done' && B.status !== 'done');
  c.close();
  log('stop:', kora('server', 'stop').trim());
  await Promise.race([t1, sleep(3000)]);
  const restartAt = Date.now();
  start();
  c = await connect();
  await sleep(6000);
  const after = tasksJson().filter((t) => t.orchestratorId === orch);
  res.afterRestart = after.map((t) => [t.taskId, t.status, t.paneIds.join('>')]);
  log('after restart:', JSON.stringify(res.afterRestart));
  const a2 = after.find((t) => t.taskId === A?.taskId); const b2 = after.find((t) => t.taskId === B?.taskId);
  res.checks.aNotRelaunched = !!a2 && a2.status === 'done' && a2.paneIds.length === 1;
  res.checks.bResumedSamePane = !!b2 && b2.paneIds[b2.paneIds.length - 1] === B.paneIds[B.paneIds.length - 1] && b2.status !== 'failed';
  const t2 = await turn(c, threadId, `The Kora daemon was restarted while your workers ran (your turn was cut off). Your worker pane ids are unchanged. kora_wait both of them now, merge what is not merged yet, and confirm \`node --test test/lines.test.js test/tax.test.js\` passes in ${dir}.`, 20 * 60_000, tools);
  res.turn2 = t2 ? { state: t2.state, stopReason: t2.stopReason ?? null } : 'timeout';
  const evs = fs.readFileSync(path.join(OUT, 'thread.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.at >= restartAt);
  const outs = evs.filter((e) => e.type === 'tool.result').map((e) => String(e.output ?? ''));
  res.checks.leaderSawFinishedTask = outs.some((o) => new RegExp(`${A.paneIds[0]}  finished before a daemon restart|worker ${A.paneIds[0]} \\(swarm task ${A.taskId}\\) is no longer running \\(done\\)`).test(o));
  res.checks.leaderGotWaitAfterRestart = outs.some((o) => /foreman: PASS|no longer running \(done\)/.test(o));
  res.checks.noRedispatch = tasksJson().filter((t) => t.orchestratorId === orch).length === 2;
  try { execFileSync(process.execPath, ['--test', 'test/lines.test.js', 'test/tax.test.js'], { cwd: dir, stdio: 'ignore' }); res.checks.testsGreen = true; } catch { res.checks.testsGreen = false; }
  res.gitLog = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  res.toolCounts = res.tools.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}); delete res.tools;
  c.close();
  res.pass = Object.values(res.checks).every(Boolean);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  try { kora('server', 'stop'); } catch {}
  process.exit(res.pass ? 0 : 1);
})().catch((e) => { console.error(e); try { kora('server', 'stop'); } catch {} process.exit(1); });

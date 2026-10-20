'use strict';
// Koragent E2E (QA): one Claude leader in Swarm mode on the isolated daemon (swarm.workerBackend=koragent) with a
// 3-bug fixture; expects 3 swarm worker tasks → reports → verify → merge → kora_wait, and `node --test` green.
// Each test file also asserts that the "BUG" marker comment is gone, which weak workers tend to forget (a natural
// check failure → in-agent fix round or a gate bounce). Usage: node kg-e2e3.cjs [model] [tag]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RT, BASE, HOME, env, childEnv } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));

const MODEL = process.argv[2] || 'claude-sonnet-5';
const TAG = process.argv[3] || `q${Date.now().toString(36)}`;
const OUT = path.join(BASE, 'results', TAG);
fs.mkdirSync(OUT, { recursive: true });
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS || 25 * 60_000);

function makeRepo() {
  const dir = path.join(BASE, 'repos', `${TAG}-invoicer`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w('package.json', JSON.stringify({ name: 'invoicer', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w('README.md', '# invoicer\nInvoice maths in integer cents. Tests: `node --test` (node:test, no deps).\n');
  w('src/tax.js', 'export const RATES = { CA: 0.0725, NY: 0.04, OR: 0 }\n\nexport function taxFor(subtotalCents, region) {\n  const rate = RATES[region]\n  if (rate === undefined) throw new Error(`unknown region ${region}`)\n  // BUG: tax is computed on dollars, not cents\n  return Math.round((subtotalCents / 100) * rate)\n}\n');
  w('src/discount.js', 'export const CODES = { SAVE10: { pct: 10, capCents: 5000 }, HALF: { pct: 50, capCents: 2000 } }\n\nexport function discountFor(subtotalCents, code) {\n  if (!code) return 0\n  const c = CODES[code.toUpperCase()]\n  if (!c) return 0\n  const raw = Math.floor((subtotalCents * c.pct) / 100)\n  // BUG: the cap is ignored\n  return raw\n}\n');
  w('src/lines.js', 'export function lineTotal(line) {\n  return line.qty * line.unitCents\n}\n\nexport function subtotal(lines) {\n  // BUG: skips the first line\n  let sum = 0\n  for (let i = 1; i < lines.length; i++) sum += lineTotal(lines[i])\n  return sum\n}\n');
  w('src/invoice.js', 'import { subtotal } from "./lines.js"\nimport { discountFor } from "./discount.js"\nimport { taxFor } from "./tax.js"\n\nexport function buildInvoice({ lines, region, code }) {\n  const sub = subtotal(lines)\n  const discount = discountFor(sub, code)\n  const tax = taxFor(sub - discount, region)\n  return { subtotal: sub, discount, tax, total: sub - discount + tax }\n}\n');
  const marker = (f) => `test("no BUG marker left in ${f}", () => assert.ok(!readFileSync(new URL("../${f}", import.meta.url), "utf8").includes("BUG")))\n`;
  const hdr = 'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { readFileSync } from "node:fs"\n';
  w('test/tax.test.js', hdr + 'import { taxFor } from "../src/tax.js"\ntest("CA tax on $100.00", () => assert.equal(taxFor(10000, "CA"), 725))\ntest("OR", () => assert.equal(taxFor(10000, "OR"), 0))\n' + marker('src/tax.js'));
  w('test/discount.test.js', hdr + 'import { discountFor } from "../src/discount.js"\ntest("SAVE10", () => assert.equal(discountFor(10000, "save10"), 1000))\ntest("HALF capped at $20", () => assert.equal(discountFor(10000, "HALF"), 2000))\n' + marker('src/discount.js'));
  w('test/lines.test.js', hdr + 'import { subtotal } from "../src/lines.js"\ntest("sums every line", () => assert.equal(subtotal([{ qty: 2, unitCents: 500 }, { qty: 1, unitCents: 250 }]), 1250))\n' + marker('src/lines.js'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}

(async () => {
  const dir = makeRepo();
  try { execFileSync(process.execPath, [path.join(RT, 'bin/kora.js'), 'ingest', dir], { env: childEnv(), stdio: 'ignore', timeout: 120_000 }); } catch {}
  const client = new KoraClient(env.KORA_SOCKET_PATH);
  await client.connect(5000);
  const rec = { dir, tools: [], t0: Date.now() };
  const log = fs.createWriteStream(path.join(OUT, 'thread.jsonl'));
  const th = await client.call('chat.thread.create', { agent: 'claude', cwd: dir, agentMode: 'swarm', model: { model: MODEL }, title: `kgqa ${TAG}` });
  rec.threadId = th.threadId ?? th.id;
  fs.writeFileSync(path.join(OUT, 'thread-id'), rec.threadId);
  await client.call('chat.session.setPermissionMode', { threadId: rec.threadId, mode: 'full-access' }).catch((e) => { rec.permErr = e.message; });
  await client.call('chat.events.subscribe', { threadIds: [rec.threadId] });
  const done = new Promise((resolve) => {
    const onEv = (ev) => {
      if (!ev || ev.threadId !== rec.threadId) return;
      log.write(JSON.stringify(ev) + '\n');
      const n = ev.toolName || ev.name || ev.item?.name; if (/tool/.test(ev.type) && n) rec.tools.push(n);
      if (ev.type === 'turn.settled') { rec.settled = { state: ev.state, stopReason: ev.stopReason ?? null, errorMessage: ev.errorMessage ?? null, ms: Date.now() - rec.t0 }; resolve(); }
    };
    client.on('chat.event', onEv);
    setTimeout(resolve, TURN_TIMEOUT_MS);
  });
  const task = [
    `The test suite in ${dir} (\`node --test\`) fails because of three independent bugs: src/tax.js, src/discount.js and src/lines.js (one each; the tests in test/ are correct and must not change).`,
    'Delegate: one swarm worker per bug (three workers, in parallel), each with its own test file as the check. Then land all three fixes on the main checkout and confirm `node --test` passes there.',
  ].join('\n');
  await client.call('chat.turn.send', { threadId: rec.threadId, text: `${swarmModeNotice('chat', 'swarm') ?? ''}\n\n${task}` });
  await done;
  log.end();
  const sh = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) }; } };
  const t = sh(process.execPath, ['--test']);
  rec.testsPass = t.ok; rec.testTail = t.out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' ');
  rec.log = sh('git', ['log', '--oneline']).out.trim().split('\n');
  rec.dirty = sh('git', ['status', '--porcelain']).out.trim();
  let reg = null; try { reg = JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')); } catch {}
  rec.swarm = (reg?.tasks || []).filter((x) => x.orchestratorId === `chat:${rec.threadId}`).map((x) => ({ id: x.taskId, status: x.status, panes: x.paneIds, model: x.resume?.model ?? null, backend: x.resume?.backend ?? null }));
  rec.toolCounts = rec.tools.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}); delete rec.tools;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(rec, null, 2));
  console.log(JSON.stringify(rec, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

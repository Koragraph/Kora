'use strict';
// Swarm vs solo on medium multi-part tasks, desktop chat lane, isolated daemon (swarm-e2e/env.cjs overrides apply).
// Each (task × arm) gets its own fresh scratch repo; ground truth = `node --test` + the expected files, never the
// leader's word. Claude usage = the LEAD's own transcript (swarm workers are OpenCode on free models).
//   node scripts/bench-swarm-solo.cjs [--model claude-sonnet-5-5] [--arms solo,swarm] [--tasks 0,1] [--tag t]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RT, BASE, HOME, env, childEnv } = require('./swarm-e2e/env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));
const os = require('node:os');

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MODEL = get('--model', 'claude-sonnet-5-5');
const ARMS = get('--arms', 'solo,swarm').split(',');
const TAG = get('--tag', `s${Date.now().toString(36)}`);
const OUT = path.join(BASE, 'bench-swarm', TAG); fs.mkdirSync(OUT, { recursive: true });
const TURN_TIMEOUT_MS = 40 * 60_000;
const P = { in: 3, out: 15, cw: 3.75, cr: 0.3 };

// Four independent modules each: parallelism should pay here if anywhere.
const TASKS = [
  [
    ['src/strings.js', 'slugify(s) (lowercase, runs of non-alphanumerics → single "-", no leading/trailing "-"), titleCase(s), truncate(s, n) (≤ n chars, ends with "…" when cut, the "…" counts)'],
    ['src/numbers.js', 'clamp(n, lo, hi), roundTo(n, digits) (roundTo(1.005, 2) === 1.01), median(arr) (sorted copy, no mutation; NaN for [])'],
    ['src/arrays.js', 'chunk(arr, size), uniqBy(arr, keyFn) (stable, first wins), partition(arr, pred) → [yes, no], zip(a, b) (shortest length)'],
    ['src/dates.js', 'isoDay(date) ("YYYY-MM-DD" in UTC), addDays(date, n) (new Date, no mutation), daysBetween(a, b) (whole UTC days, may be negative)'],
  ],
  [
    ['src/lru.js', 'class LRU(capacity) with get(k), set(k, v), has(k), size; evicts least-recently-used; get refreshes recency'],
    ['src/csv.js', 'parseCsv(text) → string[][] handling quoted fields, escaped quotes ("") and commas/newlines inside quotes; toCsv(rows) quoting only when needed'],
    ['src/semver.js', 'parse(v) → {major, minor, patch, pre}, compare(a, b) → -1/0/1 with prerelease < release, satisfies(v, range) for "^x.y.z" and "~x.y.z"'],
    ['src/emitter.js', 'class Emitter with on(evt, fn) returning an unsubscribe fn, once(evt, fn), off(evt, fn), emit(evt, ...args) (listeners added during emit do not run in that emit)'],
  ],
];
function makeRepo(name) {
  const dir = path.join(BASE, 'repos', 'swarm', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', scripts: { test: 'node --test' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src/index.js'), `export const VERSION = '0.1.0';\n`);
  fs.writeFileSync(path.join(dir, 'test/index.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { VERSION } from '../src/index.js';\ntest('version', () => assert.ok(VERSION));\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nSmall ESM utility library. Tests: \`node --test\` (node:test, no deps).\n`);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=b@kora', '-c', 'user.name=bench', 'commit', '-qm', 'init');
  return dir;
}
const taskText = (t, dir) => [
  `In this repo (${dir}) implement four independent additions:`,
  ...t.map(([f, spec], i) => `${i + 1}. ${f}: ${spec}. Add tests in test/${path.basename(f, '.js')}.test.js.`),
  `Export everything from the named files (ESM). Done means \`node --test\` passes in ${dir} with the new tests, and the work is committed on the main checkout's branch.`,
].join('\n');

function transcriptUsage(sid) {
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0, toolCalls: 0, tools: {} };
  if (!sid) return out;
  const root = path.join(os.homedir(), '.claude', 'projects'); let f = null;
  for (const d of fs.readdirSync(root)) { const p = path.join(root, d, `${sid}.jsonl`); if (fs.existsSync(p)) f = p; }
  if (!f) return out;
  const seen = new Set();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const m = o.message;
    if (!seen.has(m.id)) { seen.add(m.id); const u = m.usage || {}; out.input += u.input_tokens || 0; out.cacheRead += u.cache_read_input_tokens || 0; out.cacheWrite += u.cache_creation_input_tokens || 0; out.apiCalls++; }
    for (const b of m.content || []) if (b.type === 'tool_use') { out.toolCalls++; out.tools[b.name] = (out.tools[b.name] || 0) + 1; }
  }
  return out;
}

async function runArm(client, ti, arm) {
  const dir = makeRepo(`${TAG}-t${ti}-${arm}`);
  try { execFileSync(process.execPath, [path.join(RT, 'bin/kora.js'), 'ingest', dir], { env: childEnv(), stdio: 'ignore', timeout: 120_000 }); } catch { /* fine */ }
  const rec = { task: ti, arm, dir, threadId: null, sid: null, output: 0, t0: Date.now() };
  const th = await client.call('chat.thread.create', { agent: 'claude', cwd: dir, ...(arm === 'swarm' ? { agentMode: 'swarm' } : {}), model: { model: MODEL }, title: `bench ${TAG} ${ti} ${arm}` });
  rec.threadId = th.threadId ?? th.id;
  await client.call('chat.session.setPermissionMode', { threadId: rec.threadId, mode: 'full-access' }).catch(() => {});
  await client.call('chat.events.subscribe', { threadIds: [rec.threadId] });
  const log = fs.createWriteStream(path.join(OUT, `t${ti}.${arm}.events.jsonl`));
  const done = new Promise((resolve) => {
    const onEv = (ev) => {
      if (!ev || ev.threadId !== rec.threadId) return;
      if (ev.type !== 'content.delta') log.write(JSON.stringify(ev) + '\n');
      if (ev.type === 'thread.started' && ev.providerThreadId && !rec.sid) rec.sid = ev.providerThreadId;
      if (ev.type === 'worker-picker.requested') (rec.pickers = (rec.pickers || 0) + 1, client.call('chat.userInput.respond', { threadId: rec.threadId, requestId: ev.requestId, answers: { picks: ev.picks, autoApprove: true } })).catch(() => {});
      if (ev.type === 'turn.settled') { rec.output += ev.usage?.outputTokens ?? 0; rec.settled = ev.state; client.off('chat.event', onEv); resolve(); }
    };
    client.on('chat.event', onEv);
    setTimeout(() => { client.off('chat.event', onEv); resolve(); }, TURN_TIMEOUT_MS);
  });
  const text = (arm === 'swarm' ? `${swarmModeNotice('chat', 'swarm') ?? ''}\n\n` : '') + taskText(TASKS[ti], dir);
  await client.call('chat.turn.send', { threadId: rec.threadId, text });
  await done; log.end();
  rec.ms = Date.now() - rec.t0;
  const sh = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) }; } };
  const t = sh(process.execPath, ['--test']);
  rec.testsPass = t.ok; rec.testTail = t.out.split('\n').filter((l) => /^(#|ℹ) (tests|pass|fail)/.test(l)).join(' ');
  rec.filesPresent = TASKS[ti].map(([f]) => fs.existsSync(path.join(dir, f)) && fs.existsSync(path.join(dir, 'test', path.basename(f, '.js') + '.test.js')));
  rec.dirty = sh('git', ['status', '--porcelain']).out.trim().split('\n').filter(Boolean).length;
  rec.committed = sh('git', ['log', '--oneline']).out.trim().split('\n').length - 1;
  let reg = null; try { reg = JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')); } catch { /* none */ }
  const mine = (reg?.tasks || []).filter((x) => x.orchestratorId === `chat:${rec.threadId}`);
  rec.swarm = { tasks: mine.length, statuses: mine.map((x) => x.status), models: mine.map((x) => x.model || x.currentModel || null), attempts: mine.map((x) => (x.paneIds || []).length) };
  const u = transcriptUsage(rec.sid);
  Object.assign(rec, u, { costUsd: +((u.input * P.in + rec.output * P.out + u.cacheWrite * P.cw + u.cacheRead * P.cr) / 1e6).toFixed(4) });
  try { await client.call('chat.session.stop', { threadId: rec.threadId }); } catch { /* fine */ }
  return rec;
}

(async () => {
  const client = new KoraClient(env.KORA_SOCKET_PATH); await client.connect(5000); client.setMaxListeners(100);
  const tis = get('--tasks', '0,1').split(',').map(Number);
  const rows = [];
  for (const ti of tis) {
    // the two arms of one task run concurrently (same wall-clock conditions; separate repos)
    const rs = await Promise.all(ARMS.map((a) => runArm(client, ti, a).catch((e) => ({ task: ti, arm: a, error: String(e?.message || e) }))));
    for (const r of rs) { rows.push(r); console.log(JSON.stringify({ task: r.task, arm: r.arm, settled: r.settled, pass: r.testsPass && (r.filesPresent || []).every(Boolean), tail: r.testTail, cost: r.costUsd, calls: r.apiCalls, tools: r.toolCalls, s: Math.round((r.ms || 0) / 1000), swarm: r.swarm, committed: r.committed, dirty: r.dirty, error: r.error })); }
    fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
  }
  console.log('out', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

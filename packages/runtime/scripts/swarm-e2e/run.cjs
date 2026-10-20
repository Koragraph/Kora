'use strict';
// Swarm e2e load harness. N concurrent Claude leaders (the real SDK chat lane in the isolated daemon), each in Swarm
// mode on its own scratch repo, each expected to delegate to OpenCode workers on Zen (no key), get reports back via
// kora_wait, land the work, and leave `node --test` green. Usage: node run.cjs <N> [model] [tag]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RT, BASE, HOME, env, childEnv } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));

const N = Number(process.argv[2] || 1);
const MODEL = process.argv[3] || 'claude-sonnet-5';
const TAG = process.argv[4] || `r${Date.now().toString(36)}`;
const OUT = path.join(BASE, 'results', TAG);
fs.mkdirSync(OUT, { recursive: true });
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS || 30 * 60_000);

// Two independent pieces per repo, so a sensible leader fans out (two workers) and then integrates.
const TASKS = [
  { a: ['src/strings.js', 'slugify(s): lowercase, trim, runs of non-alphanumerics become a single "-", no leading/trailing "-"'], b: ['src/numbers.js', 'clamp(n, lo, hi) and roundTo(n, digits) (roundTo(1.005, 2) === 1.01 — handle float error)'] },
  { a: ['src/strings.js', 'titleCase(s): capitalise each word, keep the rest lowercase; words split on spaces'], b: ['src/arrays.js', 'chunk(arr, size) and uniqBy(arr, keyFn) (stable, first wins)'] },
  { a: ['src/strings.js', 'truncate(s, n): at most n chars, ending with "…" when cut (the "…" counts toward n)'], b: ['src/objects.js', 'pick(obj, keys) and omit(obj, keys) returning new objects'] },
  { a: ['src/dates.js', 'isoDay(date): "YYYY-MM-DD" in UTC; addDays(date, n) returning a new Date'], b: ['src/numbers.js', 'sum(arr), mean(arr) (NaN for []), median(arr) (sorted copy, no mutation)'] },
  { a: ['src/strings.js', 'camelCase(s) and kebabCase(s) from space/underscore/dash separated words'], b: ['src/arrays.js', 'zip(a, b) (shortest length) and partition(arr, pred) → [yes, no]'] },
];
function makeRepo(i) {
  const dir = path.join(BASE, 'repos', `${TAG}-repo${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `e2e-${i}`, type: 'module', scripts: { test: 'node --test' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src/index.js'), `export const VERSION = '0.0.${i}';\n`);
  fs.writeFileSync(path.join(dir, 'test/index.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { VERSION } from '../src/index.js';\ntest('version', () => assert.match(VERSION, /^0\\.0\\./));\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), `# e2e repo ${i}\nSmall ESM utility library. Tests: \`node --test\` (node:test, no deps).\n`);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}
function taskText(i, dir) {
  const t = TASKS[i % TASKS.length];
  return [
    `In this repo (${dir}) implement two independent additions:`,
    `1. ${t.a[0]}: ${t.a[1]}. Add tests in test/${path.basename(t.a[0], '.js')}.test.js.`,
    `2. ${t.b[0]}: ${t.b[1]}. Add tests in test/${path.basename(t.b[0], '.js')}.test.js.`,
    `Export everything from the named files (ESM). Done means \`node --test\` passes in ${dir} with the new tests, and the work is committed on the main checkout's branch.`,
  ].join('\n');
}

async function runOne(client, i) {
  const dir = makeRepo(i);
  try { execFileSync(process.execPath, [path.join(RT, 'bin/kora.js'), 'ingest', dir], { env: childEnv(), stdio: 'ignore', timeout: 120_000 }); } catch { /* X1 degrades to empty */ }
  const rec = { i, dir, threadId: null, events: [], tools: [], settled: null, error: null, t0: Date.now() };
  const log = fs.createWriteStream(path.join(OUT, `thread${i}.jsonl`));
  try {
    const th = await client.call('chat.thread.create', { agent: 'claude', cwd: dir, agentMode: 'swarm', model: { model: MODEL }, title: `e2e ${TAG} ${i}` });
    rec.threadId = th.threadId ?? th.id;
    await client.call('chat.session.setPermissionMode', { threadId: rec.threadId, mode: 'full-access' }).catch((e) => { rec.permErr = e.message; });
    await client.call('chat.events.subscribe', { threadIds: [rec.threadId] });
    const done = new Promise((resolve) => {
      const onEv = (ev) => {
        if (!ev || ev.threadId !== rec.threadId) return;
        log.write(JSON.stringify(ev) + '\n');
        rec.events.push(ev.type);
        if (/tool/.test(ev.type) && (ev.toolName || ev.name || ev.item?.name)) rec.tools.push(ev.toolName || ev.name || ev.item?.name);
        if (ev.type === 'turn.settled') { rec.settled = { state: ev.state, stopReason: ev.stopReason ?? null, errorMessage: ev.errorMessage ?? null, ms: Date.now() - rec.t0 }; client.off('chat.event', onEv); resolve(); }
      };
      client.on('chat.event', onEv);
      setTimeout(() => { client.off('chat.event', onEv); resolve(); }, TURN_TIMEOUT_MS);
    });
    const text = `${swarmModeNotice('chat', 'swarm') ?? ''}\n\n${taskText(i, dir)}`;
    await client.call('chat.turn.send', { threadId: rec.threadId, text });
    await done;
  } catch (e) { rec.error = e.message; }
  log.end();
  // Outcome checks — ground truth from the repo, not from what the leader said.
  const sh = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) }; } };
  const t = sh(process.execPath, ['--test']);
  rec.testsPass = t.ok; rec.testTail = t.out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' ');
  rec.commits = sh('git', ['log', '--oneline']).out.trim().split('\n').length;
  const t2 = TASKS[i % TASKS.length];
  rec.filesPresent = [t2.a[0], t2.b[0]].map((f) => fs.existsSync(path.join(dir, f)));
  rec.dirty = sh('git', ['status', '--porcelain']).out.trim().split('\n').filter(Boolean).length;
  const reg = swarmTasks();
  const mine = (reg?.tasks || []).filter((x) => x.orchestratorId === `chat:${rec.threadId}`);
  rec.swarm = { tasks: mine.length, reports: mine.filter((x) => { try { return fs.statSync(x.reportPath).size > 0; } catch { return false; } }).length, statuses: mine.map((x) => x.status) };
  rec.branches = sh('git', ['branch', '--list', 'kora/*']).out.trim().split('\n').filter(Boolean).length;
  rec.mergeCommits = sh('git', ['log', '--merges', '--oneline']).out.trim().split('\n').filter(Boolean).length;
  delete rec.events;
  return rec;
}

function swarmTasks() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')); } catch { return null; }
}

(async () => {
  const client = new KoraClient(env.KORA_SOCKET_PATH);
  await client.connect(5000);
  client.setMaxListeners(200);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(client, i)));
  const tasks = swarmTasks();
  const summary = {
    tag: TAG, n: N, model: MODEL, wallMs: Date.now() - t0,
    passed: results.filter((r) => r.testsPass && r.filesPresent.every(Boolean)).length,
    results: results.map((r) => ({ i: r.i, settled: r.settled, error: r.error, permErr: r.permErr, testsPass: r.testsPass, testTail: r.testTail, filesPresent: r.filesPresent, commits: r.commits, mergeCommits: r.mergeCommits, branches: r.branches, swarm: r.swarm, dirty: r.dirty, toolCounts: r.tools.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}) })),
    swarmTaskRegistry: tasks,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ tag: TAG, n: N, passed: summary.passed, wallMs: summary.wallMs, out: OUT }, null, 0));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

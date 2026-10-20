'use strict';
// Desktop-chat-lane A/B: the lane users actually use (ClaudeDriver over the Agent SDK inside a real, ISOLATED daemon,
// KORA_INJECT_OWNER=driver, prepareChatSession's rulebook + hooks, per-prompt injection) vs the same Agent SDK with the
// same `buildSessionOptions` and NO Kora (no prep, no injection, no fleet tools) — i.e. plain Claude Code via the SDK.
//
//   SWARM_E2E_DIR=… SWARM_E2E_SOCKET=… E2E_UI_PORT=… node scripts/bench-chat-lane.cjs --repos <dir with kora/ off/> \
//        [--only id,id] [--model claude-sonnet-5-5] [--arms kora,off] [--tag t] [--warm]
//
// <repos>/kora/<Repo> must be indexed in the isolated daemon's graph; <repos>/off/<Repo> is an identical clone the graph
// never sees. Usage per task comes from Claude Code's own transcript (~/.claude/projects/**/<session>.jsonl: one row per
// API call, deduped by message id → exact input / cache-read / cache-write split) plus the turn's `result` output
// count (the transcript's per-row output is the first streamed delta's running count). Cost = list price.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RT, BASE, env } = require('./swarm-e2e/env.cjs');
const lanes = require('./claude-lanes.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { KORAGRAPH_SUITE, judge } = require(path.join(RT, 'dist/bench/tasks.js'));
const { copyDiff } = require(path.join(RT, 'dist/bench/runner.js'));

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REPOS = path.resolve(get('--repos', path.join(BASE, 'repos')));
const MODEL = get('--model', 'claude-sonnet-5-5');
const ARMS = get('--arms', 'kora,off').split(',');
const TAG = get('--tag', `c${Date.now().toString(36)}`);
const OUT = path.join(BASE, 'bench-chat', TAG); fs.mkdirSync(OUT, { recursive: true });
const TURN_TIMEOUT_MS = 15 * 60_000;

const all = [...KORAGRAPH_SUITE.tasks, ...KORAGRAPH_SUITE.mixed];
const only = get('--only'); const tasks = only ? only.split(',').map((id) => all.find((t) => t.id === id)).filter(Boolean) : KORAGRAPH_SUITE.tasks.filter((t) => (t.regime || 'indexed') === 'indexed');

function repoDir(arm) { const d = path.join(REPOS, arm); const kids = fs.readdirSync(d).filter((x) => !x.startsWith('.')); return path.join(d, kids[0]); }
function reset(dir) {
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dir });
  spawnSync('git', ['clean', '-fdq', '-e', '.claude', '-e', 'CLAUDE.md', '-e', 'AGENTS.md'], { cwd: dir });
  spawnSync('git', ['update-index', '--refresh', '-q'], { cwd: dir });
}
const runKora = (client, task, dir) => lanes.runKora(client, task, dir, { out: OUT, model: MODEL, timeoutMs: TURN_TIMEOUT_MS, title: `bench ${TAG} ${task.id}` });
const runOff = (task, dir) => lanes.runOff(task, dir, { model: MODEL, timeoutMs: TURN_TIMEOUT_MS });

function finish(task, arm, dir, rec) {
  const { tr, costUsd: cost } = lanes.usageOf(rec, MODEL);
  const diff = copyDiff(dir);
  const v = judge(task, tr.answer, diff);
  fs.writeFileSync(path.join(OUT, `${task.id}.${arm}.answer.md`), tr.answer);
  if (diff.text) fs.writeFileSync(path.join(OUT, `${task.id}.${arm}.diff`), diff.text);
  return {
    task: task.id, kind: task.kind, arm, settled: rec.settled, ms: rec.ms, sid: rec.sid,
    input: tr.input, cacheRead: tr.cacheRead, cacheWrite: tr.cacheWrite, output: rec.output, apiCalls: tr.apiCalls, toolCalls: tr.toolCalls, tools: tr.tools,
    firstCW: tr.firstCW, firstCR: tr.firstCR, models: tr.models, costUsd: +cost.toFixed(4), sdkCost: rec.sdkCost ?? null,
    success: v.success && rec.settled === 'completed', verdict: v.detail, inject: rec.inject ?? null, warnings: rec.warnings ?? [],
  };
}

(async () => {
  const client = new KoraClient(env.KORA_SOCKET_PATH); await client.connect(5000); client.setMaxListeners(100);
  const rows = []; const save = () => fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
  if (argv.includes('--warm')) {
    // one throwaway turn per arm so both start with the shared prefix (system prompt + tools + CLAUDE.md) cached
    const w = { id: 'warm', kind: 'understand', prompt: 'Reply with the single word OK.' };
    for (const arm of ARMS) { const d = repoDir(arm); reset(d); const r = arm === 'kora' ? await runKora(client, w, d) : await runOff(w, d); const f = finish(w, arm, d, r); console.log(`warm ${arm}: $${f.costUsd} cw=${f.cacheWrite} cr=${f.cacheRead}`); }
  }
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const order = i % 2 === 0 ? ARMS : [...ARMS].reverse(); // alternate who goes first (cache-warmth fairness)
    for (const arm of order) {
      const dir = repoDir(arm); reset(dir);
      let rec; try { rec = arm === 'kora' ? await runKora(client, task, dir) : await runOff(task, dir); } catch (e) { rec = { settled: 'error', error: String(e?.message || e), ms: 0, output: 0 }; }
      const row = finish(task, arm, dir, rec); if (rec.error) row.error = rec.error;
      rows.push(row); save();
      console.log(`${task.id.padEnd(18)} ${arm.padEnd(4)} ${row.success ? 'OK ' : 'BAD'} $${row.costUsd.toFixed(3)} calls=${row.apiCalls} tools=${row.toolCalls} in=${row.input} cr=${row.cacheRead} cw=${row.cacheWrite} out=${row.output} ${Math.round(row.ms / 1000)}s ${arm === 'kora' ? 'inj=' + JSON.stringify((row.inject || []).map((x) => x.decision + ':' + (x.reason || x.decls))) : ''} ${row.verdict.join(';')}`);
      reset(dir);
    }
  }
  console.log('out', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

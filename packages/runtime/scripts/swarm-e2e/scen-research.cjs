'use strict';
// Mode switching + web research in Swarm, the way the composer's Chat | Team toggle drives it.
//   1. A thread starts in Chat and flips chat → swarm → orchestrator → chat → swarm; each flip must land in meta.json.
//   2. One broad research prompt in Swarm: the leader keeps its web tools (fine for one quick lookup) but must
//      delegate broad research to workers, which search the web themselves. Pass = delegated > 0.
// Usage: node scen-research.cjs [model] [tag]   (spends real plan usage: one leader turn + a few Zen workers)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RT, BASE, HOME, env } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));

const MODEL = process.argv[2] || 'claude-sonnet-5';
const TAG = process.argv[3] || `research-${Date.now().toString(36)}`;
const OUT = path.join(BASE, 'results', TAG);
fs.mkdirSync(OUT, { recursive: true });
const TURN_TIMEOUT_MS = Number(process.env.E2E_TURN_TIMEOUT_MS || 15 * 60_000);

function makeRepo() {
  const dir = path.join(BASE, 'repos', TAG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# market notes\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=e2e@kora', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return dir;
}
const metaMode = (threadId) => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'chat', threadId, 'meta.json'), 'utf8')).agentMode ?? 'chat'; } catch { return null; }
};

(async () => {
  const client = new KoraClient(env.KORA_SOCKET_PATH);
  await client.connect(5000);
  const dir = makeRepo();
  const th = await client.call('chat.thread.create', { agent: 'claude', cwd: dir, model: { model: MODEL }, title: `e2e ${TAG}` });
  const threadId = th.threadId ?? th.id;
  await client.call('chat.session.setPermissionMode', { threadId, mode: 'full-access' });

  const flips = [];
  for (const mode of ['swarm', 'orchestrator', 'chat', 'swarm']) {
    let error = null;
    try { await client.call('chat.thread.setAgentMode', { threadId, agentMode: mode }); } catch (e) { error = e.message; }
    flips.push({ to: mode, stored: metaMode(threadId), error });
  }

  await client.call('chat.events.subscribe', { threadIds: [threadId] });
  const tools = [];
  const log = fs.createWriteStream(path.join(OUT, 'thread.jsonl'));
  let settled = null;
  const done = new Promise((resolve) => {
    const onEv = (ev) => {
      if (!ev || ev.threadId !== threadId) return;
      log.write(JSON.stringify(ev) + '\n');
      if (ev.type === 'tool.started' && ev.toolName) tools.push(ev.toolName);
      if (ev.type === 'turn.settled') { settled = { state: ev.state, stopReason: ev.stopReason ?? null }; client.off('chat.event', onEv); resolve(); }
    };
    client.on('chat.event', onEv);
    setTimeout(() => { client.off('chat.event', onEv); resolve(); }, TURN_TIMEOUT_MS);
  });
  const t0 = Date.now();
  await client.call('chat.turn.send', {
    threadId,
    text: 'Research the current market for memory layers for AI coding agents (products like Mem0, Zep, Letta and similar). ' +
      'For each product: one line on what it does and one on its pricing model. Keep the final answer short.',
  });
  await done;
  log.end();

  // The daemon's own record of the turn (the socket stream carries MCP tool calls as worker.attached / tool.result).
  const stored = (() => { try { return fs.readFileSync(path.join(HOME, 'chat', threadId, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  for (const ev of stored) if (ev.type === 'tool.started' && ev.toolName && !tools.includes(ev.toolName)) tools.push(ev.toolName);
  const workersAttached = stored.filter((ev) => ev.type === 'worker.attached').length;
  const count = (re) => tools.filter((t) => re.test(t)).length;
  const reg = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')); } catch { return null; } })();
  const mine = (reg?.tasks || []).filter((x) => x.orchestratorId === `chat:${threadId}`);
  const summary = {
    tag: TAG, threadId, flips,
    flipsOk: flips.every((f) => f.stored === f.to && !f.error),
    turn: { settled, ms: Date.now() - t0 },
    leaderTools: tools.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}),
    delegated: Math.max(count(/kora_spawn/), workersAttached),
    leaderWebCalls: count(/^(WebSearch|WebFetch)$/),
    swarmTasks: mine.map((x) => ({ taskId: x.taskId, status: x.status })),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

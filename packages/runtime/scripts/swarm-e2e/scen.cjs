'use strict';
// Swarm edge-case scenarios against the isolated daemon (socket lane). Usage: node scen.cjs <midturn|leave|restart-a|restart-b>
//   midturn   : a chat turn is running; flip to swarm mid-turn → the turn is NOT killed; the next turn can spawn swarm workers
//   leave     : swarm thread with a live worker; flip to chat → its swarm workers are stopped (D-a default), worktrees kept
//   restart-a : swarm thread spawns a worker, then prints the thread id (the caller restarts the daemon)
//   restart-b : after a restart: the task is restored as failed, kora_wait says "lost in restart", the worktree is kept
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RT, BASE, HOME, env } = require('./env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));
const OUT = path.join(BASE, 'results', 'scen'); fs.mkdirSync(OUT, { recursive: true });
const STATE = path.join(OUT, 'restart.json');
const say = (...a) => console.log('[scen]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function repo(name) {
  const dir = path.join(BASE, 'repos', `scen-${name}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }));
  fs.writeFileSync(path.join(dir, 'src/index.js'), 'export const x = 1;\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e@k', '-c', 'user.name=e', 'commit', '-qm', 'init');
  return dir;
}
async function turn(c, threadId, text, timeoutMs = 15 * 60_000) {
  const events = [];
  const done = new Promise((resolve) => {
    const on = (ev) => { if (ev?.threadId !== threadId) return; events.push(ev); if (ev.type === 'turn.settled') { c.off('chat.event', on); resolve(ev); } };
    c.on('chat.event', on); setTimeout(() => { c.off('chat.event', on); resolve(null); }, timeoutMs);
  });
  await c.call('chat.turn.send', { threadId, text });
  return { done, events };
}
const panesOf = async (c, threadId) => (await c.call('pane.list', {})).panes.filter((p) => p.orchestratorId === `chat:${threadId}`);
const tools = (events) => events.filter((e) => e.type === 'tool.result').map((e) => String(e.output || '').slice(0, 160).replace(/\n/g, ' | '));

(async () => {
  const c = new KoraClient(env.KORA_SOCKET_PATH); await c.connect(5000); c.setMaxListeners(100);
  const mode = process.argv[2];
  const newThread = async (cwd, agentMode) => {
    const th = await c.call('chat.thread.create', { agent: 'claude', cwd, agentMode, model: { model: 'claude-sonnet-5' }, title: `scen ${mode}` });
    const id = th.threadId ?? th.id;
    await c.call('chat.session.setPermissionMode', { threadId: id, mode: 'full-access' });
    await c.call('chat.events.subscribe', { threadIds: [id] });
    return id;
  };
  const result = { mode, pass: false, checks: {} };
  if (mode === 'midturn') {
    const dir = repo('midturn');
    const id = await newThread(dir, 'chat');
    const t1 = await turn(c, id, 'Run `sleep 25 && echo slept` with Bash, then reply with the single word DONE.');
    await sleep(8000);
    const flip = await c.call('chat.thread.setAgentMode', { threadId: id, agentMode: 'swarm' });
    result.checks.flipReturnedMode = flip.thread.agentMode;
    const s1 = await t1.done;
    result.checks.firstTurnCompleted = s1?.state; // must be 'completed', not interrupted
    const t2 = await turn(c, id, `${swarmModeNotice('chat', 'swarm')}\n\nCreate src/hello.js exporting hello() returning "hi". Delegate it to one swarm worker, wait for its report, merge it, and reply DONE.`);
    const s2 = await t2.done;
    result.checks.secondTurn = s2?.state;
    result.checks.spawnedSwarm = t2.events.some((e) => e.type === 'worker.attached' && e.workerAgent === 'opencode');
    result.checks.helloOnMain = fs.existsSync(path.join(dir, 'src/hello.js'));
    result.pass = result.checks.firstTurnCompleted === 'completed' && result.checks.spawnedSwarm;
    result.tools = tools(t2.events);
    result.t2 = t2.events.map((e) => ({ type: e.type, s: JSON.stringify(e).slice(0, 220) })).filter((e) => e.type !== 'content.delta').slice(0, 30);
    result.t2text = t2.events.filter((e) => e.type === 'content.delta').map((e) => e.delta).join('').slice(0, 800);
  } else if (mode === 'leave') {
    const dir = repo('leave');
    const id = await newThread(dir, 'swarm');
    const t = await turn(c, id, `${swarmModeNotice('chat', 'swarm')}\n\nSpawn ONE swarm worker (agent:"swarm") to write src/big.js with a function table of 30 unit converters and tests. Do NOT wait for it; reply "spawned <paneId>" right after spawning.`);
    await t.done;
    const before = await panesOf(c, id);
    result.checks.liveWorkersBefore = before.filter((p) => p.state !== 'exited').length;
    const wts = before.map((p) => p.worktree?.path).filter(Boolean);
    await c.call('chat.thread.setAgentMode', { threadId: id, agentMode: 'chat' });
    await sleep(4000);
    const after = await panesOf(c, id);
    result.checks.liveWorkersAfter = after.filter((p) => p.state !== 'exited').length;
    result.checks.worktreesKept = wts.every((w) => fs.existsSync(w));
    result.pass = result.checks.liveWorkersBefore > 0 && result.checks.liveWorkersAfter === 0 && result.checks.worktreesKept;
  } else if (mode === 'restart-a') {
    const dir = repo('restart');
    const id = await newThread(dir, 'swarm');
    const t = await turn(c, id, `${swarmModeNotice('chat', 'swarm')}\n\nSpawn ONE swarm worker (agent:"swarm") to write src/table.js exporting 20 small math helpers with tests. Do NOT wait for it; reply "spawned <paneId>" right after spawning.`);
    await t.done;
    const ps = await panesOf(c, id);
    fs.writeFileSync(STATE, JSON.stringify({ id, dir, panes: ps.map((p) => ({ id: p.id, worktree: p.worktree?.path })) }));
    result.checks.spawned = ps.length; result.pass = ps.length > 0;
  } else if (mode === 'restart-b') {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8'));
    const mine = reg.tasks.filter((x) => x.orchestratorId === `chat:${st.id}`);
    result.checks.restoredStatuses = mine.map((x) => x.status);
    result.checks.worktreesKept = st.panes.every((p) => !p.worktree || fs.existsSync(p.worktree));
    await c.call('chat.events.subscribe', { threadIds: [st.id] });
    const t = await turn(c, st.id, `Call kora_wait on ${st.panes[0]?.id} and tell me exactly what it returned (quote it).`);
    await t.done;
    const out = tools(t.events).join(' ');
    result.checks.waitSaysLost = /restart|lost/i.test(out);
    result.tools = tools(t.events);
    result.pass = result.checks.restoredStatuses.every((s) => s !== 'running') && result.checks.worktreesKept;
  }
  fs.writeFileSync(path.join(OUT, `${mode}.json`), JSON.stringify(result, null, 2));
  say(JSON.stringify(result));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

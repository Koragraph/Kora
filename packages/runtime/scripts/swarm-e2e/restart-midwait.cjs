'use strict';
// Usage: node restart-midwait.cjs a ; ./daemon.sh stop && ./daemon.sh start ; node restart-midwait.cjs b
// Daemon restart while a Swarm lead sits in kora_wait. a: spawn 2 workers + wait (exit while the turn runs).
// b (after the caller restarts the daemon): "continue" → which fleet tool does the lead call first; does it respawn?
const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const E2E = __dirname;
const { RT, BASE, HOME, env } = require(E2E + '/env.cjs');
const { KoraClient } = require(path.join(RT, 'dist/protocol/client.js'));
const { swarmModeNotice } = require(path.join(RT, 'dist/server/swarm-skill.js'));
const STATE = path.join(BASE, 'midwait.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const c = new KoraClient(env.KORA_SOCKET_PATH); await c.connect(5000); c.setMaxListeners(100);
  const mode = process.argv[2];
  if (mode === 'a') {
    const dir = path.join(BASE, 'repos', `midwait-${Date.now().toString(36)}`);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mw', type: 'module', scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(dir, 'src/index.js'), "export const VERSION = '1';\n");
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main'); g('add', '.'); g('-c', 'user.email=e@k', '-c', 'user.name=e', 'commit', '-qm', 'init');
    const th = await c.call('chat.thread.create', { agent: 'claude', cwd: dir, agentMode: 'swarm', model: { model: 'claude-sonnet-5' }, title: 'midwait' });
    const id = th.threadId ?? th.id;
    await c.call('chat.session.setPermissionMode', { threadId: id, mode: 'full-access' });
    await c.call('chat.events.subscribe', { threadIds: [id] });
    await c.call('chat.turn.send', { threadId: id, text: `${swarmModeNotice('chat', 'swarm')}\n\nIn ${dir}: (1) src/strings.js exporting slugify(s) with test/strings.test.js; (2) src/numbers.js exporting clamp(n, lo, hi) with test/numbers.test.js. Delegate each to its own swarm worker in one go, wait for both reports with kora_wait, merge them, run node --test, reply DONE.` });
    for (let i = 0; i < 120; i++) {
      const ps = (await c.call('pane.list', {})).panes.filter((p) => p.orchestratorId === `chat:${id}`);
      if (ps.length >= 2) { fs.writeFileSync(STATE, JSON.stringify({ id, dir, panes: ps.map((p) => p.id) })); console.log('spawned', ps.map((p) => p.id).join(',')); await sleep(15000); process.exit(0); }
      await sleep(2000);
    }
    console.log('no spawn'); process.exit(1);
  }
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'swarm', 'tasks.json'), 'utf8')).tasks.filter((x) => x.orchestratorId === `chat:${st.id}`);
  console.log('tasks after restart', JSON.stringify(reg.map((x) => ({ id: x.taskId, status: x.status }))));
  await c.call('chat.events.subscribe', { threadIds: [st.id] });
  const seen = [];
  const done = new Promise((resolve) => {
    c.on('chat.event', (ev) => {
      if (ev?.threadId !== st.id) return;
      const n = ev.toolName || ev.name || ev.item?.name || ev.item?.toolName;
      if (n && /^(tool|item)\./.test(ev.type)) seen.push(`${ev.type}:${n}`);
      if (ev.type === 'turn.settled') resolve(ev.state);
    });
    setTimeout(() => resolve('timeout'), 20 * 60_000);
  });
  await c.call('chat.turn.send', { threadId: st.id, text: 'continue' });
  const state = await done;
  const tools = [...new Set(seen)];
  let tests = null; try { execFileSync(process.execPath, ['--test'], { cwd: st.dir, stdio: 'ignore', timeout: 60000 }); tests = 'pass'; } catch { tests = 'fail'; }
  const spawns = seen.filter((s) => /kora_spawn/.test(s)).length;
  console.log(JSON.stringify({ state, firstTools: seen.slice(0, 6), spawnsAfterRestart: spawns, tests, files: ['src/strings.js', 'src/numbers.js'].map((f) => fs.existsSync(path.join(st.dir, f))) }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

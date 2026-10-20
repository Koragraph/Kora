#!/usr/bin/env node
// Daemon soak: an ISOLATED daemon (scratch KORA_HOME, its own socket, its own UI port, its own graph store) driven
// through a synthetic, model-free workload for SOAK_SECONDS (default 180), sampling the daemon's RSS every 10 s.
// Workload per tick: chat threads created/renamed/subscribed/deleted, shell panes spawned and killed (or left to exit
// and be reaped), subscriber connections opened and dropped, status/worktree queries. Prints a JSON summary; exit 1
// when RSS grew more than SOAK_MAX_GROWTH_MB (default 60) from the first post-warm-up sample to the last, or the
// daemon logged an event-loop stall.
//   node scripts/soak.js   (run it through the shared heavy.sh lock; needs a built dist/)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { KoraClient } = require('../dist/protocol/client');

const SECONDS = Number(process.env.SOAK_SECONDS || 180);
const MAX_GROWTH_MB = Number(process.env.SOAK_MAX_GROWTH_MB || 60);
const base = fs.mkdtempSync(path.join('/tmp', 'kora-soak-'));
const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
const sock = path.join(base, 'k.sock');
const env = {
  ...process.env, KORA_HOME: home, KORA_SOCKET_PATH: sock, KORA_UI_PORT: process.env.KORA_UI_PORT || '8819',
  KORAGRAPH_HOME: path.join(base, 'kg'), KORAGRAPH_DB: path.join(base, 'kg', 'graph.db'), KORA_AUTO_INGEST: '0', KORA_AUTO_SETUP: '0',
  KORA_WORKTREES: path.join(home, 'worktrees'), KORA_LEGACY_HOME: path.join(base, 'no-legacy'), KORA_STATUS_GC: '1',
};
const repo = path.join(base, 'repo'); fs.mkdirSync(repo);
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '--allow-empty', '-m', 'init');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid) => { try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024; } catch { return null; } };

(async () => {
  const daemon = spawn(process.execPath, ['--expose-gc', path.join(__dirname, '..', 'bin', 'kora.js'), 'server', 'run'], { env, stdio: 'ignore' });
  const c = new KoraClient(sock);
  for (let i = 0; i < 200; i++) { try { await c.connect(1000); break; } catch { await sleep(100); } }
  const samples = []; const counts = { threads: 0, panes: 0, conns: 0, calls: 0, errors: 0 };
  const t0 = Date.now();
  const sample = async () => { const st = await c.call('server.status', {}).catch(() => null); samples.push({ s: Math.round((Date.now() - t0) / 1000), rssMb: rssMb(daemon.pid), heapMb: st?.memory?.heapUsedMb ?? null }); };
  const sampler = setInterval(() => { void sample(); }, 10_000);
  const call = async (m, p) => { counts.calls++; try { return await c.call(m, p); } catch (e) { counts.errors++; return null; } };
  let tick = 0;
  try {
    while (Date.now() - t0 < SECONDS * 1000) {
      tick++;
      const th = await call('chat.thread.create', { agent: 'claude', cwd: repo, title: `soak ${tick}` });
      if (th) {
        counts.threads++;
        await call('chat.thread.rename', { threadId: th.id, title: `soak ${tick} renamed` });
        await call('chat.events.subscribe', { threadIds: [th.id] });
        await call('chat.events.unsubscribe', { threadIds: [th.id] });
        await call('chat.thread.delete', { threadId: th.id });
      }
      if (tick % 4 === 0) {
        const p = await call('pane.spawn', { command: '/bin/sh', args: ['-c', `printf 'soak %s\\n' ${tick}; sleep 0.4`], cwd: repo, enforce: false, cols: 80, rows: 24 });
        if (p) { counts.panes++; if (tick % 8 === 0) await call('pane.kill', { paneId: p.id }); }
      }
      if (tick % 5 === 0) {
        const s = new KoraClient(sock); try { await s.connect(1000); await s.call('events.subscribe', { paneOutput: true }); counts.conns++; } catch { counts.errors++; } s.close();
      }
      await call('server.status', {}); await call('worktree.list', { cwd: repo });
      await sleep(40);
    }
  } finally {
    clearInterval(sampler);
    await sample();
    const panesLeft = (await call('pane.list', {}))?.panes?.length ?? null;
    await call('server.shutdown', {}); c.close();
    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(8000)]);
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
    const logText = (() => { try { return fs.readFileSync(path.join(home, 'server.log'), 'utf8'); } catch { return ''; } })();
    const stalls = logText.split('\n').filter((l) => l.includes('event loop blocked'));
    const warm = samples.find((x) => x.s >= 30) ?? samples[0]; const last = samples[samples.length - 1];
    const growth = warm && last && warm.rssMb != null && last.rssMb != null ? last.rssMb - warm.rssMb : null;
    const summary = { seconds: SECONDS, counts, panesLeftAtEnd: panesLeft, rss: samples, rssGrowthAfterWarmupMb: growth == null ? null : Math.round(growth * 10) / 10, maxRssMb: Math.max(...samples.map((x) => x.rssMb || 0)), heapGrowthAfterWarmupMb: warm && last && warm.heapMb != null && last.heapMb != null ? Math.round((last.heapMb - warm.heapMb) * 10) / 10 : null, stalls: stalls.slice(0, 5), chatDirsLeft: fs.existsSync(path.join(home, 'chat')) ? fs.readdirSync(path.join(home, 'chat')).filter((n) => n.startsWith('t_')).length : 0 };
    console.log(JSON.stringify(summary, null, 2));
    if (!process.env.SOAK_KEEP) fs.rmSync(base, { recursive: true, force: true });
    process.exit(growth != null && growth > MAX_GROWTH_MB || stalls.length ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });

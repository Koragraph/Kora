// Entry point of the keep-warm proxy child process (forked by manager.ts). It owns nothing but the listening socket:
// the daemon tells it the mode and which sessions to forget over IPC and gets cost rows back. If the daemon goes away
// the child exits (a proxy nobody supervises must not linger).
//   env: KORA_CACHE_WARM_PORT (try this port first - a restart keeps the URL live sessions already hold),
//        KORA_CACHE_WARM_MODE, KORA_CACHE_WARM_DIST (distribution file), KORA_CACHE_WARM_UPSTREAM (tests: http://host:port)
import { makeDistLoader } from './dist-file';
import { createWarmProxy } from './proxy';
import type { WarmMode } from './warm-engine';

let mode: WarmMode = ((m) => (m === 'on' || m === 'shadow' ? m : 'off'))(process.env.KORA_CACHE_WARM_MODE);
const send = (m: unknown) => { try { process.send?.(m); } catch { /* the daemon is gone */ } };

let upstream;
if (process.env.KORA_CACHE_WARM_UPSTREAM) {
  const u = new URL(process.env.KORA_CACHE_WARM_UPSTREAM);
  upstream = { protocol: u.protocol as 'http:' | 'https:', host: u.hostname, ...(u.port ? { port: Number(u.port) } : {}) };
}
const proxy = createWarmProxy({
  ...(upstream ? { upstream } : {}),
  mode: () => mode,
  dist: makeDistLoader(process.env.KORA_CACHE_WARM_DIST ?? ''),
  emit: (row) => send({ t: 'row', row }),
});

process.on('message', (m: any) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'mode' && (m.mode === 'off' || m.mode === 'shadow' || m.mode === 'on')) { mode = m.mode; if (mode === 'off') proxy.engine.dropAll(); }
  else if (m.t === 'forget' && typeof m.session === 'string') proxy.engine.forget(m.session);
  else if (m.t === 'ping') send({ t: 'pong' });
  else if (m.t === 'shutdown') void proxy.close().finally(() => process.exit(0));
});
process.on('disconnect', () => { void proxy.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
process.on('uncaughtException', () => { /* a bookkeeping bug must not take streaming down; the daemon restarts us if we do die */ });
process.on('unhandledRejection', () => {});

const sweep = setInterval(() => proxy.engine.sweep(), 10 * 60_000); sweep.unref();
const want = Number(process.env.KORA_CACHE_WARM_PORT) || 0;
proxy.listen(want).catch(() => proxy.listen(0)).then((port) => send({ t: 'ready', port }), () => process.exit(1));

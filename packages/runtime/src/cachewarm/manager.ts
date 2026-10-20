// Daemon-side owner of the keep-warm proxy child. All the daemon does is: fork the child once (when a session first asks
// and the mode is not off), keep a heartbeat, hand each session a base URL, forget sessions when they stop, and write the
// child's cost rows to cost.jsonl. Nothing in a chat's streaming path touches this file: the CLI talks to the child
// directly, so a stalled daemon event loop cannot stall a stream.
//
// Fail open: if the child is not healthy (not started, heartbeat lost, restart budget spent) `baseUrl` returns null and the
// session starts exactly as it would without this feature. A child that dies under a RUNNING session is restarted on the
// SAME port straight away (the session's CLI keeps retrying its API call), which is the one place a bug here could be felt.
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { type CostLine, logCost } from '../util/cost-log';
import { cacheWarmMode } from '../util/savings-settings';
import { distFilePath } from './dist-file';
import { ownGatewayReason } from './gateway';
import type { WarmMode } from './warm-engine';

const HEARTBEAT_MS = 5_000;
const HEALTHY_WITHIN_MS = 20_000;
const START_TIMEOUT_MS = 2_500;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

export interface ManagerOptions {
  home?: string;
  /** tests: a different child module / upstream / mode source */
  childModule?: string;
  upstream?: string;
  mode?: () => WarmMode;
  sink?: (row: CostLine) => void;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export class CacheWarmManager {
  private child: ChildProcess | null = null;
  private port = 0;
  private ready: Promise<boolean> | null = null;
  private lastPong = 0;
  private sentMode: WarmMode | null = null;
  private hb: NodeJS.Timeout | null = null;
  private restarts: number[] = [];
  private closing = false;
  private readonly home: string;
  private readonly modeOf: () => WarmMode;
  private readonly sink: (row: CostLine) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly say: (msg: string) => void;

  constructor(private opts: ManagerOptions = {}) {
    this.home = opts.home ?? koraHome();
    this.modeOf = opts.mode ?? (() => cacheWarmMode(this.home));
    this.sink = opts.sink ?? ((row) => logCost(row, this.home));
    this.env = opts.env ?? process.env;
    this.say = opts.log ?? (() => {});
  }

  /** Healthy right now: a live child, a bound port, and a heartbeat within the last 20 s. */
  healthy(): boolean { return !!this.child && this.child.connected && this.port > 0 && Date.now() - this.lastPong < HEALTHY_WITHIN_MS; }

  /**
   * The base URL a session should run with, or null (mode off, a proxy in the user's environment, child not healthy).
   * Waits at most ~2.5 s for a first start; never throws.
   */
  async baseUrl(threadId: string): Promise<string | null> {
    try {
      const mode = this.modeOf();
      if (mode === 'off' || this.closing) { this.pushMode(mode); return null; }
      if (ownGatewayReason(this.env)) return null;
      if (!this.child) await this.start();
      if (!this.healthy()) return null;
      this.pushMode(mode);
      return `http://127.0.0.1:${this.port}/s/${encodeURIComponent(threadId)}`;
    } catch { return null; }
  }

  /** Kora stopped or deleted this thread: the proxy drops everything it holds for it. */
  forget(threadId: string): void { try { this.child?.send({ t: 'forget', session: threadId }); } catch { /* child gone */ } }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.hb) { clearInterval(this.hb); this.hb = null; }
    const c = this.child; this.child = null;
    if (!c) return;
    try { c.send({ t: 'shutdown' }); } catch { /* gone */ }
    await new Promise<void>((resolve) => { const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 1500); t.unref(); c.once('exit', () => { clearTimeout(t); resolve(); }); });
  }

  private pushMode(mode: WarmMode): void {
    if (!this.child || this.sentMode === mode) return;
    try { this.child.send({ t: 'mode', mode }); this.sentMode = mode; } catch { /* child gone */ }
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
      let c: ChildProcess;
      try {
        c = fork(this.opts.childModule ?? path.join(__dirname, 'proxy-main.js'), [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          execArgv: [],
          // a minimal env: no tokens, no PATH-borne surprises. TLS trust is the one thing the child shares.
          env: {
            KORA_CACHE_WARM_MODE: this.modeOf(),
            KORA_CACHE_WARM_DIST: distFilePath(this.home),
            ...(this.port ? { KORA_CACHE_WARM_PORT: String(this.port) } : {}),
            ...(this.opts.upstream ? { KORA_CACHE_WARM_UPSTREAM: this.opts.upstream } : {}),
            ...(this.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: this.env.NODE_EXTRA_CA_CERTS } : {}),
            ...(this.env.SSL_CERT_FILE ? { SSL_CERT_FILE: this.env.SSL_CERT_FILE } : {}),
          },
        });
      } catch (e: any) { this.say(`cache-warm: could not start the proxy (${e?.message ?? e})`); this.ready = null; finish(false); return; }
      this.child = c; this.sentMode = null;
      const t = setTimeout(() => finish(false), START_TIMEOUT_MS); t.unref();
      c.on('message', (m: any) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'ready' && typeof m.port === 'number') { this.port = m.port; this.lastPong = Date.now(); clearTimeout(t); this.startHeartbeat(); finish(true); }
        else if (m.t === 'pong') this.lastPong = Date.now();
        else if (m.t === 'row' && m.row && typeof m.row.k === 'string') { try { this.sink(m.row as CostLine); } catch { /* telemetry */ } }
      });
      c.on('error', () => { /* surfaces as exit */ });
      c.on('exit', () => {
        clearTimeout(t);
        if (this.child === c) this.child = null;
        this.ready = null; this.sentMode = null;
        finish(false);
        if (this.closing) return;
        const now = Date.now();
        this.restarts = this.restarts.filter((x) => now - x < RESTART_WINDOW_MS);
        if (this.restarts.length >= MAX_RESTARTS) { this.say('cache-warm: proxy keeps dying; leaving it off until the daemon restarts'); this.closing = true; return; }
        this.restarts.push(now);
        // same port: sessions already running hold this URL
        setTimeout(() => { if (!this.closing && !this.child) void this.start(); }, 150).unref();
      });
    });
    return this.ready;
  }

  private startHeartbeat(): void {
    if (this.hb) return;
    this.hb = setInterval(() => {
      try { this.child?.send({ t: 'ping' }); } catch { /* exit handler restarts */ }
      this.pushMode(this.modeOf());
    }, HEARTBEAT_MS);
    this.hb.unref();
  }
}

let singleton: CacheWarmManager | null = null;
/** The daemon's one manager (created on first use; nothing runs until a session asks while the mode is not off). */
export function cacheWarm(): CacheWarmManager { return (singleton ??= new CacheWarmManager({ log: (m) => { try { require('../server/log').log(m); } catch { /* no logger in tests */ } } })); }
export function resetCacheWarmForTests(m: CacheWarmManager | null = null): void { singleton = m; }
export async function shutdownCacheWarm(): Promise<void> { const m = singleton; singleton = null; await m?.shutdown(); }

// One ACP agent process per thread, kept alive across turns (the initialize handshake is paid once), closed after an
// idle period, on a spawn-contract change (model / cwd / approval posture / command), on a crash, or at shutdown.
// The pool owns processes and handshakes only; sessions (session/new, session/load) are the driver's business.
import type { Readable, Writable } from 'node:stream';
import { AcpConnection } from './acp-client';
import { killChild } from '../../util/kill-child';

export const ACP_IDLE_MS_DEFAULT = 10 * 60_000;

export interface AcpChild {
  stdin: Writable; stdout: Readable; stderr?: Readable | null; pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit' | 'error' | 'close', fn: (...a: any[]) => void): unknown;
}
export interface AcpSpawnSpec { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; /** The engine's agent id: picks its OS fence (os-sandbox.ts acpFence). */ engineId?: string }
export type AcpSpawnFn = (spec: AcpSpawnSpec) => AcpChild;

export interface AcpHandshake { caps: any; authMethods: any[]; agentInfo?: any }

export interface AcpEntry extends AcpHandshake {
  readonly key: string;
  readonly contract: string;
  readonly conn: AcpConnection;
  readonly child: AcpChild;
  readonly spawnedAt: number;
  /** The ACP session this process currently holds (null until session/new or session/load succeeds). */
  sessionId: string | null;
  /** The blob prompt was already delivered into `sessionId`. */
  playbookSent: boolean;
  models?: { current: string | null; available: { id: string; name: string }[] };
  busy: boolean;
  lastUsed: number;
  closed: boolean;
  closeReason: string | null;
  stderrTail: string;
  idleTimer: NodeJS.Timeout | null;
  /** Free-form per-process state the driver keeps (terminals, live MCP token flag...). */
  ext: Record<string, any>;
}

export interface AcpPoolOptions {
  spawn: AcpSpawnFn;
  idleMs?: number;
  /** Called once per process when it goes away for any reason (idle, contract, crash, shutdown, replace). */
  onClosed?(entry: AcpEntry, reason: string): void;
}

export type AcpInit = (conn: AcpConnection) => Promise<AcpHandshake>;

export class AcpPool {
  private entries = new Map<string, AcpEntry>();
  private starting = new Map<string, Promise<AcpEntry>>();
  private idleMs: number;
  /** Counters the tests (and `kora doctor`) read. */
  stats = { spawned: 0, reused: 0, closed: 0 };

  constructor(private o: AcpPoolOptions) { this.idleMs = o.idleMs ?? ACP_IDLE_MS_DEFAULT; }

  setIdleMs(ms: number): void { this.idleMs = ms; }
  get(key: string): AcpEntry | undefined { const e = this.entries.get(key); return e && !e.closed ? e : undefined; }
  size(): number { return this.entries.size; }

  /** The live process for `key` if its contract matches (cheap, no spawn); a mismatching one is closed. */
  async acquire(key: string, contract: string, spec: AcpSpawnSpec, init: AcpInit): Promise<{ entry: AcpEntry; reused: boolean }> {
    const inflight = this.starting.get(key);
    if (inflight) { const entry = await inflight; if (entry.contract === contract && !entry.closed) return { entry, reused: false }; }
    const cur = this.get(key);
    if (cur) {
      if (cur.contract === contract) { this.stats.reused++; return { entry: cur, reused: true }; }
      this.close(key, 'spawn contract changed');
    }
    return { entry: await this.start(key, contract, spec, init), reused: false };
  }

  /** Close the current process of `key` (if any) and start a fresh one. The "one replacement process" step. */
  async replace(key: string, contract: string, spec: AcpSpawnSpec, init: AcpInit, reason: string): Promise<AcpEntry> {
    this.close(key, reason);
    return this.start(key, contract, spec, init);
  }

  private start(key: string, contract: string, spec: AcpSpawnSpec, init: AcpInit): Promise<AcpEntry> {
    const p = (async () => {
      const child = this.o.spawn(spec); // may throw ENOENT synchronously; the caller words it
      this.stats.spawned++;
      const conn = new AcpConnection(child.stdin, child.stdout);
      const entry: AcpEntry = {
        key, contract, conn, child, spawnedAt: Date.now(), caps: {}, authMethods: [], sessionId: null, playbookSent: false,
        busy: false, lastUsed: Date.now(), closed: false, closeReason: null, stderrTail: '', idleTimer: null, ext: {},
      };
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on('data', (c: string) => { entry.stderrTail = (entry.stderrTail + c).slice(-2000); });
      conn.onClose((reason) => this.finish(entry, reason));
      child.on('exit', (code: number | null, sig: string | null) => conn.close(`process exited (${sig ?? `code ${code}`})`));
      child.on('error', (e: any) => conn.close(`process error: ${e?.message ?? e}`));
      try { Object.assign(entry, await init(conn)); }
      catch (e: any) {
        // The agent's own words (an "unsupported client" banner usually lands on stderr) travel with the failure.
        const tail = entry.stderrTail.trim().replace(/\s+/g, ' ').slice(-300);
        this.close(key, 'handshake failed', entry);
        if (tail && e instanceof Error && !e.message.includes(tail.slice(0, 40))) e.message = `${e.message} (${tail})`;
        throw e;
      }
      if (entry.closed) throw new Error(`the agent stopped during startup${entry.stderrTail.trim() ? `: ${entry.stderrTail.trim().slice(-300)}` : ''}`);
      this.entries.set(key, entry);
      return entry;
    })();
    this.starting.set(key, p);
    const done = () => { if (this.starting.get(key) === p) this.starting.delete(key); };
    p.then(done, done);
    return p;
  }

  /** A turn begins / ends: a busy process is never idle-closed; the idle clock starts when the turn ends. */
  begin(entry: AcpEntry): void { entry.busy = true; if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; } }
  end(entry: AcpEntry): void {
    entry.busy = false; entry.lastUsed = Date.now();
    if (entry.closed) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { if (!entry.busy) this.close(entry.key, 'idle', entry); }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  close(key: string, reason: string, which?: AcpEntry): void {
    const e = which ?? this.entries.get(key);
    if (!e) return;
    this.finish(e, reason);
    try { e.conn.close(reason); } catch { /* gone */ }
    try { killChild(e.child); } catch { /* gone */ }
    const t = setTimeout(() => { try { e.child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
    t.unref?.();
  }

  closeAll(reason = 'shutdown'): void { for (const e of [...this.entries.values()]) this.close(e.key, reason, e); }

  private finish(e: AcpEntry, reason: string): void {
    if (e.closed) return;
    e.closed = true; e.closeReason = reason;
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null; }
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    this.stats.closed++;
    try { this.o.onClosed?.(e, reason); } catch { /* observer */ }
  }
}

// Kora's client for one Koragent pane's event stream (protocol/koragent.ts). Koragent LISTENS on the unix socket; this
// connects, retrying until it is up (the TUI binds it a moment after the pane starts), sends `hello{sinceSeq}` on every
// connect, and reconnects on any drop — the same code path serves a daemon restart (a fresh client with sinceSeq 0
// gets the ring-buffer replay) and a transient disconnect (sinceSeq = the last event seen, so nothing twice).
//
// Never throws into the daemon: a malformed line is logged and skipped, a write to a closed socket is queued for the
// next connect. All I/O is async (the daemon's event loop carries the UI websocket).
import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { KoragentEvent, KoragentInbound } from '../protocol/koragent';
import { ipcAddress } from '../util/ipc-path';

export interface KoragentClientOptions {
  /** First retry delay; doubles to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Replay from here (the last seq this consumer already handled). Default 0 = everything the ring buffer has. */
  sinceSeq?: number;
  log?: (msg: string) => void;
}

const MAX_LINE = 4 << 20; // a TaskReport can be large; a single line past this is dropped, not buffered forever

/**
 * Events: 'event' (KoragentEvent, deduplicated by seq), 'connect', 'disconnect'. `lastSeq` is the newest seq seen.
 */
export class KoragentEventClient extends EventEmitter {
  lastSeq: number;
  connected = false;
  /** Times a connection was established (1 = first connect). */
  connects = 0;
  private sock: net.Socket | null = null;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private delay: number;
  private readonly queue: string[] = [];
  private buf = '';

  constructor(readonly socketPath: string, private readonly opts: KoragentClientOptions = {}) {
    super();
    this.lastSeq = Math.max(0, opts.sinceSeq ?? 0);
    this.delay = opts.retryMs ?? 100;
  }

  start(): this { if (!this.closed && !this.sock && !this.timer) this.connect(); return this; }

  /** Stop for good (the pane exited / was killed). Pending messages are dropped. */
  close(): void {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const s = this.sock; this.sock = null;
    if (s) { s.removeAllListeners(); s.on('error', () => {}); s.destroy(); }
    if (this.connected) { this.connected = false; this.emit('disconnect'); }
    this.queue.length = 0;
  }

  get isClosed(): boolean { return this.closed; }

  /** Send one message; queued (in order) while disconnected, flushed right after the next hello. */
  send(msg: KoragentInbound): void {
    if (this.closed) return;
    const line = JSON.stringify(msg) + '\n';
    if (this.connected && this.sock) this.sock.write(line);
    else this.queue.push(line);
  }

  private log(m: string): void { try { this.opts.log?.(m); } catch { /* ignore */ } }

  private connect(): void {
    this.timer = null;
    if (this.closed) return;
    const s = net.createConnection(ipcAddress(this.socketPath));
    this.sock = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      if (this.closed || this.sock !== s) return;
      this.connected = true; this.connects++;
      this.delay = this.opts.retryMs ?? 100;
      this.buf = '';
      s.write(JSON.stringify({ type: 'hello', sinceSeq: this.lastSeq } satisfies KoragentInbound) + '\n');
      for (const l of this.queue.splice(0)) s.write(l);
      this.emit('connect');
    });
    s.on('data', (chunk: string) => this.onData(chunk));
    s.on('error', () => { /* ENOENT / ECONNREFUSED while Koragent starts; 'close' follows and retries */ });
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null;
      const was = this.connected;
      this.connected = false;
      if (was) this.emit('disconnect');
      if (this.closed) return;
      const d = this.delay;
      this.delay = Math.min(this.opts.maxRetryMs ?? 2000, this.delay * 2);
      this.timer = setTimeout(() => this.connect(), d);
      this.timer.unref?.();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) { this.log(`koragent ${this.socketPath}: dropped an oversized line (${this.buf.length} bytes)`); this.buf = ''; }
  }

  private onLine(line: string): void {
    let e: any;
    try { e = JSON.parse(line); } catch { this.log(`koragent ${this.socketPath}: not JSON: ${line.slice(0, 120)}`); return; }
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') return;
    // hello is per-connection (its seq may be 0); every other event is ordered by seq and replayed at most once.
    if (e.type !== 'hello') {
      const seq = Number(e.seq);
      if (Number.isFinite(seq) && seq > 0) {
        if (seq <= this.lastSeq) return; // already handled (overlapping replay)
        this.lastSeq = seq;
      }
    }
    try { this.emit('event', e as KoragentEvent); } catch (err: any) { this.log(`koragent ${this.socketPath}: event handler failed: ${err?.message ?? err}`); }
  }
}

// Minimal JSON-RPC client over the unix socket. Used by the CLI and hook scripts.
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { defaultSocketPath, koraHome, Methods, MethodName, RpcResponse, Notifications } from './types';
import { isAgentOrigin, readControlToken } from '../server/control-auth';
import { ipcAddress } from '../util/ipc-path';

export class KoraClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** Who this client speaks for when it has no control token (a Codex lead's fleet bridge names its orchestrator; else the env's pane id). */
  public caller: string | undefined;
  /** The proof of `caller` (server/control-auth.ts callerKey): the env's KORA_CALLER_KEY unless set (a Codex lead's
   *  bridge gets its key on argv, since Codex scrubs the MCP env). The daemon ignores a caller that comes without it. */
  public callerKey: string | undefined;
  /** An explicit control token. Only a process that can already read the token file can set one (a test that owns its
   *  throwaway daemon reads its own isolated home's); it never comes from the environment, so the agent marker still
   *  keeps an agent process from attaching the real one. */
  public control: string | undefined;
  constructor(public socketPath: string = defaultSocketPath()) { super(); }

  private callerId(): string | undefined {
    const c = this.caller ?? process.env.KORA_PANE_ID ?? process.env.KORA_ORCHESTRATOR_ID;
    return c && c.length <= 160 ? c : undefined;
  }

  /**
   * The control capability for privileged methods (server/control-auth.ts): the UI token next to the socket, else the
   * home's. Never attached by an agent process (its env says KORA_AGENT), so an agent that dials the socket is refused.
   */
  private controlToken(): string | undefined {
    if (this.control) return this.control;
    if (isAgentOrigin()) return undefined;
    // 2026-10-15 audit #8: the token goes only to a socket in a folder no one else can put one in (a KORA_SOCKET_PATH in
    // a shared folder could be another local user's listener, collecting it).
    if (!privateSocketDir(path.dirname(this.socketPath))) return undefined;
    return (readControlToken(path.dirname(this.socketPath)) ?? readControlToken(koraHome())) ?? undefined;
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(ipcAddress(this.socketPath));
      const t = setTimeout(() => { s.destroy(); reject(new Error(`timeout connecting to ${this.socketPath}`)); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); this.sock = s; resolve(); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
      s.setEncoding('utf8');
      s.on('data', (d: string) => this.onData(d));
      s.on('close', () => { this.emit('close'); for (const p of this.pending.values()) p.reject(new Error('socket closed')); this.pending.clear(); });
    });
  }
  private onData(d: string) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
        const r = msg as RpcResponse;
        if (r.error) p.reject(Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data }));
        else p.resolve(r.result);
      } else if (msg.method) {
        this.emit('notification', msg.method, msg.params);
        this.emit(msg.method, msg.params);
      }
    }
  }
  call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    if (!this.sock) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const auth = this.controlToken();
      const caller = auth ? undefined : this.callerId();
      const callerKey = caller ? (this.callerKey ?? process.env.KORA_CALLER_KEY) : undefined;
      this.sock!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params, ...(auth ? { auth } : {}), ...(caller ? { caller } : {}), ...(callerKey ? { callerKey } : {}) }) + '\n');
    });
  }
  on<N extends keyof Notifications>(event: N, listener: (params: Notifications[N]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener); }
  // destroy, not end: a half-close waits for the server's FIN, and a server that is busy (or wedged) would keep a
  // one-shot hook process alive past its deadline with its output already written. Nothing here needs the tail.
  close() { this.sock?.destroy(); this.sock = null; }
}

/** Is this folder ours and closed to everyone else (0700-ish: no group/other write)? Always true on Windows (named pipes). */
export function privateSocketDir(dir: string): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  try {
    const uid = process.getuid();
    const link = fs.lstatSync(dir);
    if (link.uid !== uid && !link.isDirectory()) return false; // someone else's symlink
    const st = fs.statSync(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o022) === 0;
  } catch { return false; }
}

// One-shot helper for scripts: connect, call, close.
export async function callOnce<M extends MethodName>(method: M, params: Methods[M]['params'], socketPath?: string, timeoutMs = 60_000): Promise<Methods[M]['result']> {
  const c = new KoraClient(socketPath);
  await c.connect();
  try {
    return await new Promise<Methods[M]['result']>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method}: no reply from the server within ${timeoutMs} ms`)), timeoutMs);
      c.call(method, params).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  } finally { c.close(); }
}

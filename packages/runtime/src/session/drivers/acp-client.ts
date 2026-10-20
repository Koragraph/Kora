// A minimal Agent Client Protocol (ACP) client: newline-delimited JSON-RPC 2.0 over a child's stdio.
// Spec: https://agentclientprotocol.com/protocol/overview . This file is transport only - no Kora types - so it is
// tested with in-memory streams (acp-driver.test.ts) and a fixture agent process (fixtures/fake-acp-agent.cjs).
import type { Readable, Writable } from 'node:stream';

export const ACP_PROTOCOL_VERSION = 1;

export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AcpRpcError'; }
}

export interface AcpHandlers {
  /** An agent -> client request (fs/*, terminal/*, session/request_permission). Throw AcpRpcError to answer with an error. */
  onRequest(method: string, params: any): Promise<unknown>;
  /** An agent -> client notification (session/update). */
  onNotification(method: string, params: any): void;
}

interface Pending { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout | null; method: string }

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buf = '';
  private closed = false;
  private closeListeners = new Set<(reason: string) => void>();
  private handlers: AcpHandlers = { onRequest: async (m) => { throw new AcpRpcError(-32601, `method not found: ${m}`); }, onNotification: () => {} };

  constructor(private out: Writable, input: Readable) {
    input.setEncoding('utf8');
    input.on('data', (c: string) => this.onData(c));
    input.on('end', () => this.close('agent closed its output'));
    input.on('error', (e) => this.close(`agent output error: ${e.message}`));
    out.on('error', () => { /* EPIPE after the child died: close() already reports it */ });
  }

  setHandlers(h: AcpHandlers): void { this.handlers = h; }
  get isClosed(): boolean { return this.closed; }
  onClose(fn: (reason: string) => void): () => void { this.closeListeners.add(fn); return () => this.closeListeners.delete(fn); }

  request<T = any>(method: string, params: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the agent process is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, timer: null, method };
      if (o.timeoutMs) p.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${Math.round(o.timeoutMs! / 1000)}s`)); }, o.timeoutMs);
      p.timer?.unref?.();
      this.pending.set(id, p);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: unknown): void { if (!this.closed) this.write({ jsonrpc: '2.0', method, params }); }

  /** Fail every in-flight request and tell the listeners. Idempotent. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(`the agent stopped (${reason}) during ${p.method}`)); }
    this.pending.clear();
    for (const l of [...this.closeListeners]) { try { l(reason); } catch { /* listener */ } }
    try { this.out.end(); } catch { /* gone */ }
  }

  private write(msg: object): void { try { this.out.write(JSON.stringify(msg) + '\n'); } catch (e: any) { this.close(`write failed: ${e?.message ?? e}`); } }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; } // agents may print banners / logs on stdout; not JSON-RPC, ignore
    if (!m || typeof m !== 'object') return;
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      if (hasId) void this.answer(m.id, m.method, m.params);
      else { try { this.handlers.onNotification(m.method, m.params); } catch { /* a bad handler must not kill the pump */ } }
      return;
    }
    if (hasId) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new AcpRpcError(Number(m.error.code ?? -32000), String(m.error.message ?? 'agent error'), m.error.data));
      else p.resolve(m.result);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e: any) {
      const code = e instanceof AcpRpcError ? e.code : -32603;
      this.write({ jsonrpc: '2.0', id, error: { code, message: String(e?.message ?? e), ...(e instanceof AcpRpcError && e.data !== undefined ? { data: e.data } : {}) } });
    }
  }
}

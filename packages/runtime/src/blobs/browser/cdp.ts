// Minimal Chrome DevTools Protocol client over the browser-level websocket (flat sessions).
// No Playwright/Puppeteer, no `ws` dependency: Node 24's global WebSocket is enough. Every send has a timeout, a
// closed socket rejects everything in flight, and a throwing event handler can never take the client down.
type Params = Record<string, unknown>;
type Handler = (params: any, sessionId?: string) => void;

export class CdpError extends Error {
  constructor(public method: string, message: string, public code?: number) { super(`${method}: ${message}`); }
}

export class Cdp {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; method: string; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, Set<Handler>>();
  closed = false;

  constructor(private wsUrl: string, private defaultTimeoutMs = 30_000) {}

  connect(timeoutMs = 10_000): Promise<this> {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.wsUrl));
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { reject(new Error('cdp connect timeout')); try { ws.close(); } catch { /* gone */ } }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(this); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('cdp websocket error')); };
      ws.onclose = () => {
        this.closed = true;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CdpError(p.method, 'connection closed')); }
        this.pending.clear();
        this.fire('close', {});
      };
      ws.onmessage = (m) => this.onMessage(m.data);
    });
  }

  private onMessage(data: unknown): void {
    let msg: any;
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, String(msg.error.message ?? 'error'), msg.error.code)); else p.resolve(msg.result);
    } else if (typeof msg.method === 'string') this.fire(msg.method, msg.params, msg.sessionId);
  }

  send<T = any>(method: string, params: Params = {}, sessionId?: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closed || !this.ws) return Promise.reject(new CdpError(method, 'connection closed'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(method, `timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(new CdpError(method, (e as Error).message)); }
    });
  }

  /** Subscribe to a CDP event (or the synthetic 'close'). Returns the unsubscribe function. */
  on(method: string, fn: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  private fire(method: string, params: unknown, sessionId?: string): void {
    for (const fn of this.handlers.get(method) ?? []) { try { fn(params, sessionId); } catch { /* a handler bug must not kill the socket */ } }
  }

  close(): void { try { this.ws?.close(); } catch { /* already closed */ } }
}

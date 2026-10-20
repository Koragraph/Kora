// The loopback proxy between a Claude Code session and api.anthropic.com. Runs in its OWN process (proxy-main.ts): the
// daemon's event loop has had multi-second stalls and a streaming response must never wait on it.
//
// A session reaches it as  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/s/<threadId>  - the path prefix says which Kora
// thread a request belongs to, so no header (or any credential) is ever inspected for identity. The prefix is stripped
// and everything else is forwarded as it came:
//  - request bytes are piped to the upstream as they arrive (a copy is kept to analyse, never delaying the forward);
//  - response bytes are piped straight back, chunk by chunk (SSE is not buffered); a tap on the side reads `usage`;
//  - a client that goes away aborts the upstream request; an upstream that dies mid-stream destroys the client socket
//    (a clean-looking truncation would be worse than an error);
//  - the only header touched on /v1/messages is accept-encoding (identity, so the tap can read usage); Host is rewritten.
// Headers and bodies are never logged. A held request (for warming) is the only place a credential lives, in memory,
// and only while the engine may still send a warm.

import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { type ReturnDist, DEFAULT_RETURN_DIST } from './policy';
import { type EngineDeps, type HeldRequest, type Ticket, type Usage, type WarmMode, type WarmRow, type WarmSendResult, WarmEngine } from './warm-engine';

export interface Upstream { protocol: 'https:' | 'http:'; host: string; port?: number }
export const ANTHROPIC_UPSTREAM: Upstream = { protocol: 'https:', host: 'api.anthropic.com' };

export interface ProxyOptions {
  upstream?: Upstream;
  mode: () => WarmMode;
  dist?: () => ReturnDist;
  emit: (row: WarmRow) => void;
  /** tests inject a clock / timers; production uses the real ones */
  clock?: Pick<EngineDeps, 'now' | 'setTimer' | 'clearTimer'>;
  /** warm request timeout */
  warmTimeoutMs?: number;
}
export interface WarmProxy {
  server: http.Server;
  engine: WarmEngine;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']);
const MAX_ANALYSE_BYTES = 32 * 1024 * 1024;
const SESSION_PREFIX = /^\/s\/([^/?]+)(\/[^]*)?$/;

/** "/s/<id>/v1/messages?x=1" -> { session: id, path: "/v1/messages?x=1" }; anything else is not a session path. */
export function splitSessionPath(url: string): { session: string | null; path: string } {
  const m = SESSION_PREFIX.exec(url);
  if (!m) return { session: null, path: url };
  let id: string;
  try { id = decodeURIComponent(m[1]); } catch { return { session: null, path: url }; }
  return { session: id, path: m[2] ?? '/' };
}

/** Pull `usage` out of an SSE stream or a JSON body as it passes by. Never throws, never buffers more than a line. */
export class UsageTap {
  private dec = new StringDecoder('utf8');
  private carry = '';
  private json = '';
  readonly usage: Partial<Usage> = {};
  private seen = false;
  constructor(private sse: boolean) {}
  push(chunk: Buffer): void {
    try {
      const text = this.dec.write(chunk);
      if (!this.sse) { if (this.json.length < 1_000_000) this.json += text; return; }
      this.carry += text;
      let i: number;
      while ((i = this.carry.indexOf('\n')) >= 0) { this.line(this.carry.slice(0, i)); this.carry = this.carry.slice(i + 1); }
      if (this.carry.length > 4_000_000) this.carry = '';
    } catch { /* a tap must never break the stream */ }
  }
  private line(l: string): void {
    if (!l.startsWith('data:') || !l.includes('"usage"')) return;
    try {
      const j = JSON.parse(l.slice(5));
      this.merge(j?.type === 'message_start' ? j.message?.usage : j?.usage);
    } catch { /* partial or foreign line */ }
  }
  private merge(u: any): void {
    if (!u || typeof u !== 'object') return;
    this.seen = true;
    const set = (k: keyof Usage, v: unknown) => { if (typeof v === 'number' && Number.isFinite(v)) this.usage[k] = v; };
    set('in', u.input_tokens); set('cr', u.cache_read_input_tokens); set('cc', u.cache_creation_input_tokens); set('out', u.output_tokens);
  }
  end(): Usage | null {
    try {
      if (this.sse) { if (this.carry) this.line(this.carry); }
      else { const j = JSON.parse(this.json); this.merge(j?.usage); }
    } catch { /* not JSON (an error page) */ }
    if (!this.seen) return null;
    return { in: this.usage.in ?? 0, cr: this.usage.cr ?? 0, cc: this.usage.cc ?? 0, out: this.usage.out ?? 0 };
  }
}

export function createWarmProxy(opts: ProxyOptions): WarmProxy {
  const upstream = opts.upstream ?? ANTHROPIC_UPSTREAM;
  const mod = upstream.protocol === 'http:' ? http : https;
  const agent = new (upstream.protocol === 'http:' ? http.Agent : https.Agent)({ keepAlive: true, maxSockets: 64 });
  const clock = opts.clock ?? { now: () => Date.now(), setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer: (h) => clearTimeout(h as NodeJS.Timeout) };

  const send = (held: HeldRequest, body: string): Promise<WarmSendResult> => new Promise((resolve) => {
    let done = false;
    const finish = (r: WarmSendResult) => { if (!done) { done = true; resolve(r); } };
    const h: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(held.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === 'host' || k === 'content-length' || k === 'accept-encoding' || k === 'transfer-encoding') continue;
      h[k] = v;
    }
    h['host'] = upstream.port ? `${upstream.host}:${upstream.port}` : upstream.host;
    h['accept-encoding'] = 'identity';
    h['content-length'] = String(Buffer.byteLength(body));
    const up = mod.request({ host: upstream.host, port: upstream.port, path: held.path, method: 'POST', headers: h, agent }, (res) => {
      const tap = new UsageTap(false);
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n < 2_000_000) tap.push(c); });
      res.on('end', () => {
        const ra = Number(res.headers['retry-after']);
        finish({ status: res.statusCode ?? 0, usage: res.statusCode === 200 ? tap.end() : null, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) });
      });
      res.on('error', () => finish({ status: 0, usage: null }));
    });
    up.setTimeout(opts.warmTimeoutMs ?? 90_000, () => { up.destroy(); finish({ status: 0, usage: null }); });
    up.on('error', () => finish({ status: 0, usage: null }));
    up.end(body);
  });

  const engine = new WarmEngine({ ...clock, send, emit: opts.emit, mode: opts.mode, dist: opts.dist ?? (() => DEFAULT_RETURN_DIST) });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/__kora_health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    const { session, path } = splitSessionPath(url);
    const isMessages = req.method === 'POST' && session !== null && /^\/v1\/messages(\?|$)/.test(path);

    // forwarded headers: the client's, verbatim and in order, minus hop-by-hop; Host rewritten; identity encoding on the tapped route
    const out: string[] = [];
    let sawHost = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]; const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'host') { sawHost = true; out.push('Host', upstream.port ? `${upstream.host}:${upstream.port}` : upstream.host); continue; }
      if (isMessages && lk === 'accept-encoding') continue;
      out.push(k, req.rawHeaders[i + 1]);
    }
    if (!sawHost) out.push('Host', upstream.host);
    if (isMessages) out.push('Accept-Encoding', 'identity');

    const chunks: Buffer[] = []; let bytes = 0; let tooBig = false;
    const upReq = mod.request({ host: upstream.host, port: upstream.port, path, method: req.method, headers: out as any, agent });
    let ticket: Ticket | null = null;
    let upRes: http.IncomingMessage | null = null;

    // the client went away before its request finished uploading
    req.on('close', () => { if (!req.complete) upReq.destroy(); });
    // the client went away mid-response: stop paying for tokens nobody reads
    res.on('close', () => { if (!res.writableEnded) { upReq.destroy(); upRes?.destroy(); } });

    upReq.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"api_error","message":"Kora cache-warm proxy: upstream unreachable"}}');
    });

    upReq.on('response', (ur) => {
      upRes = ur;
      const hdr: string[] = [];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) if (!HOP_BY_HOP.has(ur.rawHeaders[i].toLowerCase())) hdr.push(ur.rawHeaders[i], ur.rawHeaders[i + 1]);
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage ?? '', hdr as any);
      res.flushHeaders();
      const status = ur.statusCode ?? 0;
      let tap: UsageTap | null = null;
      if (isMessages) {
        setImmediate(() => { try { engine.onResponseStart(ticket, status); } catch { /* bookkeeping only */ } });
        const enc = String(ur.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (enc === 'identity') tap = new UsageTap(String(ur.headers['content-type'] ?? '').includes('text/event-stream'));
      }
      ur.on('data', (c: Buffer) => { tap?.push(c); });
      ur.on('end', () => { if (isMessages) { const u = tap?.end() ?? null; setImmediate(() => { try { engine.onResponseEnd(ticket, status, u); } catch { /* bookkeeping only */ } }); } });
      ur.on('error', () => res.destroy());
      ur.pipe(res);
    });

    if (isMessages) {
      req.on('data', (c: Buffer) => { bytes += c.length; if (bytes > MAX_ANALYSE_BYTES) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });
      req.on('end', () => {
        if (tooBig) return;
        // off the forwarding path: the request is already on its way upstream
        setImmediate(() => {
          try {
            const raw = Buffer.concat(chunks);
            if (opts.mode() === 'off') return;
            const body = JSON.parse(raw.toString('utf8'));
            if (typeof body?.max_tokens === 'number' && body.max_tokens <= 1 && !Array.isArray(body.tools)) { ticket = null; return; }
            ticket = engine.onRequest(session!, body, raw, path, req.headers as any);
          } catch { ticket = null; /* not JSON / not ours to track: the forward already happened */ }
        });
      });
    }
    req.pipe(upReq);
  });
  server.on('connection', (s) => s.setNoDelay(true));
  server.on('clientError', (_e, s) => { try { s.destroy(); } catch { /* gone */ } });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return {
    server, engine,
    listen: (port = 0, host = '127.0.0.1') => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
    }),
    close: () => new Promise<void>((resolve) => { engine.dropAll(); agent.destroy(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

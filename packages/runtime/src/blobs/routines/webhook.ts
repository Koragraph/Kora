// The webhook receiver: its own loopback-only HTTP server (never the UI port), exposing ONLY
//   GET  /health
//   POST /hooks/<id>
// Everything else is 404. Auth is a per-trigger secret: `Authorization: Bearer <secret>` (preferred) or `?token=<secret>`
// (capability-URL fallback for senders that cannot set headers; URLs end up in logs, so Bearer is the better choice).
// Secrets are stored as sha256 and compared in constant time. Bodies are size-capped, each trigger is rate-limited, and the
// payload is handed on as untrusted text (the prompt builder fences it). Nothing here ever logs a body, a header or a query.
import crypto from 'node:crypto';
import http from 'node:http';
import type { WebhookFire } from './engine';

export const DEFAULT_WEBHOOK_PORT = 8800;
export const MAX_WEBHOOK_BODY = 64 * 1024;
const ID_RE = /^wh_[a-f0-9]{16}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The receiver's port for this install: KORA_WEBHOOK_PORT, else the UI port + 3 (8797 -> 8800; Kora Dev's 8790 -> 8793). */
export function webhookPort(env: Record<string, string | undefined> = process.env): number {
  const explicit = Number(env.KORA_WEBHOOK_PORT);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit;
  const ui = Number(env.KORA_UI_PORT ?? env.KORA_PORT);
  if (Number.isInteger(ui) && ui > 0 && ui + 3 < 65536) return ui + 3;
  return DEFAULT_WEBHOOK_PORT;
}

export const webhookUrl = (port: number, id: string) => `http://127.0.0.1:${port}/hooks/${id}`;
export const hashSecret = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');
export function newWebhookId(): string { return `wh_${crypto.randomBytes(8).toString('hex')}`; }
export function newWebhookSecret(): string { return `whsec_${crypto.randomBytes(32).toString('base64url')}`; }

/** Constant-time check of a presented secret against a stored sha256. Always does the same work. */
export function secretMatches(presented: string | null, storedHash: string | null): boolean {
  const a = Buffer.from(hashSecret(presented ?? ''), 'hex');
  const b = Buffer.from(storedHash && /^[a-f0-9]{64}$/.test(storedHash) ? storedHash : '0'.repeat(64), 'hex');
  const equal = crypto.timingSafeEqual(a, b);
  return equal && presented !== null && storedHash !== null;
}

export interface WebhookReceiverOptions {
  port: number;
  /** Must be a loopback address. Default 127.0.0.1. */
  host?: string;
  lookup(id: string): { secretHash: string } | null;
  onEvent(id: string, body: string): Promise<WebhookFire>;
  maxBodyBytes?: number;
  /** Accepted events per trigger per minute. Default 30. */
  ratePerMinute?: number;
  /** Failed authentications per trigger per minute before it answers 429. Default 10. */
  failedPerMinute?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

class Window {
  private hits: number[] = [];
  constructor(private limit: number, private ms = 60_000) {}
  /** Count a hit; false when over the limit. */
  take(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.ms);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now); return true;
  }
  retryAfter(now: number): number { return this.hits.length ? Math.max(1, Math.ceil((this.ms - (now - this.hits[0]!)) / 1000)) : 1; }
  full(now: number): boolean { this.hits = this.hits.filter((t) => now - t < this.ms); return this.hits.length >= this.limit; }
}

export class WebhookReceiver {
  private server: http.Server | null = null;
  private rates = new Map<string, Window>();
  private fails = new Map<string, Window>();
  private now: () => number;
  private maxBody: number;
  private host: string;

  constructor(private o: WebhookReceiverOptions) {
    this.now = o.now ?? Date.now;
    this.maxBody = o.maxBodyBytes ?? MAX_WEBHOOK_BODY;
    this.host = o.host ?? '127.0.0.1';
    if (!LOOPBACK.has(this.host)) throw new Error(`the webhook receiver only binds to loopback, not ${this.host}`);
  }

  address(): { host: string; port: number } | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : null;
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.server) return Promise.resolve(this.address()!);
    const server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal error' }); else res.destroy(); }); });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 40;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (e) => { this.server = null; reject(e); });
      server.listen({ port: this.o.port, host: this.host, exclusive: true }, () => resolve(this.address()!));
    });
  }

  stop(): Promise<void> {
    const s = this.server; this.server = null;
    return new Promise((resolve) => { if (!s) return resolve(); s.close(() => resolve()); s.closeAllConnections?.(); });
  }

  private win(map: Map<string, Window>, id: string, limit: number): Window {
    let w = map.get(id);
    if (!w) { if (map.size > 2000) map.clear(); w = new Window(limit); map.set(id, w); }
    return w;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const now = this.now();
    // DNS-rebinding and browser guards: a real sender is a server, so it has a loopback Host and no Origin.
    const hostName = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(hostName)) return send(res, 403, { error: 'forbidden' });
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'forbidden' });
    const remote = req.socket.remoteAddress ?? '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return send(res, 403, { error: 'forbidden' });

    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad request' }); }
    const path = url.pathname;

    if (path === '/health') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      return send(res, 200, { ok: true });
    }
    const m = /^\/hooks\/([^/]+)$/.exec(path);
    if (!m) return send(res, 404, { error: 'not found' });
    const id = m[1]!;
    if (!ID_RE.test(id)) return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });

    // 1. authenticate before reading any body. An unknown id and a wrong secret look identical.
    const rec = this.o.lookup(id);
    const failed = this.win(this.fails, id, this.o.failedPerMinute ?? 10);
    if (failed.full(now)) return send(res, 429, { error: 'too many failed attempts' }, { 'Retry-After': String(failed.retryAfter(now)) });
    const header = String(req.headers.authorization ?? '');
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
    const presented = bearer ?? (header ? null : url.searchParams.get('token'));
    if (!secretMatches(presented, rec?.secretHash ?? null)) {
      failed.take(now);
      return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    // 2. rate limit per trigger
    const rate = this.win(this.rates, id, this.o.ratePerMinute ?? 30);
    if (!rate.take(now)) return send(res, 429, { error: 'rate limited' }, { 'Retry-After': String(rate.retryAfter(now)) });

    // 3. body, capped
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBody) return send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
    const body = await readBody(req, this.maxBody);
    if (body === null) return send(res, 413, { error: 'payload too large' }, { Connection: 'close' });

    let out: WebhookFire;
    try { out = await this.o.onEvent(id, body); } catch { return send(res, 503, { error: 'unavailable' }); }
    switch (out.status) {
      case 'accepted': return send(res, 202, { ok: true, runId: out.runId, queued: out.queued });
      case 'paused': return send(res, 409, { error: 'routine is paused' });
      case 'queue-full': return send(res, 429, { error: 'too many events waiting' }, { 'Retry-After': '30' });
      case 'unknown': return send(res, 401, { error: 'unauthorized' });
      default: return send(res, 503, { error: 'unavailable' });
    }
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) { done = true; resolve(null); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

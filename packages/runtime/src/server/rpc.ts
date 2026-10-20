// JSON-RPC 2.0 framing helpers (newline-delimited). Pure, testable.
import type { RpcRequest, RpcResponse, RpcNotification } from '../protocol/types';

export const ERR_PARSE = -32700, ERR_INVALID_REQUEST = -32600, ERR_METHOD_NOT_FOUND = -32601, ERR_INVALID_PARAMS = -32602, ERR_INTERNAL = -32603;

export class RpcError extends Error { constructor(public code: number, message: string, public data?: unknown) { super(message); } }

/** The longest request line a connection may send (2026-10-15 audit #7: 64 MB per connection was a local DoS). */
export const MAX_LINE = 8 * 1024 * 1024;

/**
 * Incremental line splitter. Feed chunks; get complete lines back. Only the new chunk is scanned for a newline (the
 * old one re-scanned the whole buffer per chunk: one huge line streamed in small chunks cost quadratic CPU on the event
 * loop the UI websocket shares), and a line longer than `maxLine` is refused as soon as it is.
 */
export class LineBuffer {
  private buf = '';
  constructor(private maxLine = MAX_LINE) {}
  push(chunk: string | Buffer): string[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: string[] = [];
    let start = 0; let i: number;
    while ((i = text.indexOf('\n', start)) !== -1) {
      const line = this.buf + text.slice(start, i); this.buf = ''; start = i + 1;
      if (line.length > this.maxLine) throw new RpcError(ERR_INVALID_REQUEST, 'line too long');
      if (line.trim()) out.push(line);
    }
    this.buf += text.slice(start);
    if (this.buf.length > this.maxLine) { this.buf = ''; throw new RpcError(ERR_INVALID_REQUEST, 'line too long'); }
    return out;
  }
}

export type Parsed = { kind: 'request'; req: RpcRequest } | { kind: 'notification'; note: RpcNotification } | { kind: 'error'; resp: RpcResponse };

/** The envelope's identity fields, kept only when well-formed (server/control-auth.ts verifies them). */
function envelope(msg: any): { auth?: string; caller?: string; callerKey?: string } {
  return {
    ...(typeof msg.auth === 'string' ? { auth: msg.auth } : {}),
    ...(typeof msg.caller === 'string' && msg.caller.length <= 160 ? { caller: msg.caller } : {}),
    ...(typeof msg.callerKey === 'string' && msg.callerKey.length <= 128 ? { callerKey: msg.callerKey } : {}),
  };
}

export function parseMessage(line: string): Parsed {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { kind: 'error', resp: errorResponse(null, ERR_PARSE, 'parse error') }; }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return { kind: 'error', resp: errorResponse(msg?.id ?? null, ERR_INVALID_REQUEST, 'invalid request') };
  if (msg.id === undefined || msg.id === null) return { kind: 'notification', note: { jsonrpc: '2.0', method: msg.method, params: msg.params, ...envelope(msg) } };
  return { kind: 'request', req: { jsonrpc: '2.0', id: msg.id, method: msg.method, params: msg.params, ...envelope(msg) } };
}

export function resultResponse(id: number | string, result: unknown): RpcResponse { return { jsonrpc: '2.0', id, result }; }
export function errorResponse(id: number | string | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}
export function encode(msg: RpcResponse | RpcNotification): string { return JSON.stringify(msg) + '\n'; }
export function notification(method: string, params: unknown): string { return encode({ jsonrpc: '2.0', method, params }); }

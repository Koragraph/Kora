// `kora mcp --blobs --blob <id> --token <t> --socket <path>`: a stdio MCP server that exposes ONE blob's tools - its
// self tools (recall, remember, forget, edit_soul, set_model, attach_output) and, when the blob is the Chief, Kora's team
// tools (list_team, plan_job, delegate_to ...) - by calling the daemon over its unix socket. It is how Codex and OpenCode
// blobs get the same tools as the in-process Claude path (docs/bots/ARCH.md ruling 8).
//
// The tools do NOT live here: the daemon decides, per bearer token, which tools this blob may see and runs every call
// (BlobToolHub in blobs/tools-team.ts). This process only translates MCP <-> two daemon RPCs:
//   blobs.mcp.hello { blobId, token }                    -> { ok, chief, tools: [{ name, description, params }] } | { ok:false, error }
//   blobs.mcp.call  { blobId, token, name, args }        -> { text, isError? }
// Identity travels on argv (env fallback in brackets) because Codex starts MCP servers with a scrubbed environment -
// the same reason `kora mcp --fleet` takes it on argv. The token is per session; the daemon revokes it when the thread ends.
import type { IO } from '../main';
import type { ParamShape } from '../../session/fleet-tools';
import { toJsonSchema } from '../../session/fleet-tools';
import { version } from '../../../package.json';
import { thisComputer } from '../../util/platform-copy';

export const summary = 'Serve a blob\'s tools (self + team) over MCP on stdio';
export const usage = `Usage: kora mcp --blobs --blob <id> --token <token> [--socket <path>] [--thread <id>] [--agent <slug>]

Speaks MCP (JSON-RPC 2.0, one message per line) on stdio. Serves the tools the daemon grants this blob:
recall, remember, forget, edit_soul, set_model, attach_output - and, for Kora (the Chief), the team tools.
Identity on argv (env fallback in brackets): --blob <id> [KORA_BLOB_ID]  --token <t> [KORA_BLOB_TOKEN]
  --socket <path> [KORA_SOCKET_PATH]  --thread <id> [KORA_BLOB_THREAD]  --agent <slug> [KORA_BLOB_AGENT]`;

export interface BlobsBridgeOptions { blobId?: string; token?: string; socketPath?: string; threadId?: string; agent?: string }

/** `--key value` flags with env fallback (Codex scrubs the environment, so argv wins). */
export function blobBridgeOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): BlobsBridgeOptions {
  const flag = (name: string, envKey: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return (v && !v.startsWith('--') ? v : undefined) ?? env[envKey] ?? undefined; };
  const o = { blobId: flag('blob', 'KORA_BLOB_ID'), token: flag('token', 'KORA_BLOB_TOKEN'), socketPath: flag('socket', 'KORA_SOCKET_PATH'), threadId: flag('thread', 'KORA_BLOB_THREAD'), agent: flag('agent', 'KORA_BLOB_AGENT') };
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as BlobsBridgeOptions;
}

/** One request to the daemon. Rejects on transport errors; an RPC error rejects with its message. */
export type DaemonCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

/** A DaemonCall over the daemon's unix socket (one lazily dialled connection, re-dialled after a drop). */
export function socketCaller(socketPath: string): { call: DaemonCall; close(): void } {
  const { KoraClient } = require('../../protocol/client') as typeof import('../../protocol/client');
  let client: InstanceType<typeof KoraClient> | null = null;
  const conn = async () => {
    if (client) return client;
    const c = new KoraClient(socketPath);
    await c.connect(3000);
    c.on('close', () => { if (client === c) client = null; });
    client = c;
    return c;
  };
  const call: DaemonCall = async (method, params, timeoutMs = 60_000) => {
    const c = await conn();
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method}: no reply from Kora within ${timeoutMs} ms`)), timeoutMs);
      (c as any).call(method, params).then((v: unknown) => { clearTimeout(t); resolve(v); }, (e: Error) => { clearTimeout(t); reject(e); });
    });
  };
  return { call, close: () => { client?.close(); client = null; } };
}

interface HelloTool { name: string; description: string; params: ParamShape }

const RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603 };
const result = (id: unknown, r: unknown) => ({ jsonrpc: '2.0', id, result: r });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (id: unknown, text: string, isError = false) => result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export function createBlobsMcp(opts: { call: DaemonCall; blobId?: string; token?: string; threadId?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; onClose?: () => void }) {
  const { call } = opts;
  const identity = () => ({ blobId: opts.blobId ?? '', token: opts.token ?? '' });
  let tools: HelloTool[] = [];
  let helloError: string | null = null;
  let chief = false;

  async function hello(): Promise<void> {
    if (!opts.blobId || !opts.token) { helloError = 'this server was started without --blob/--token, so it has no tools'; tools = []; return; }
    try {
      const r = await call('blobs.mcp.hello', { ...identity(), ...(opts.threadId ? { threadId: opts.threadId } : {}) }, 10_000);
      if (r && r.ok === true && Array.isArray(r.tools)) { tools = r.tools as HelloTool[]; chief = r.chief === true; helloError = null; }
      else { tools = []; helloError = String(r?.error ?? 'the daemon refused this blob session'); }
    } catch (e: any) { helloError = `Kora's daemon is not reachable: ${e?.message ?? e}`; if (!tools.length) tools = []; }
  }

  async function handle(m: any): Promise<any> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id !== undefined ? rpcError(m.id, RPC.INVALID_REQUEST, 'Invalid Request') : null;
    if (m.id === undefined) return null; // notifications (initialized, cancelled): no reply
    switch (m.method) {
      case 'initialize':
        return result(m.id, {
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kora-blobs', version },
          instructions: `Tools for this blob from Kora. Call them by name; they run in the Kora daemon on ${thisComputer()}.`,
        });
      case 'ping': return result(m.id, {});
      case 'tools/list': {
        await hello();
        return result(m.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.params) })) });
      }
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string') return rpcError(m.id, RPC.INVALID_REQUEST, 'tools/call needs a tool name');
        if (!tools.length && !helloError) await hello();
        if (!tools.some((t) => t.name === name)) {
          await hello(); // the roster may have changed (a blob became Chief-only or lost a tool)
          if (!tools.some((t) => t.name === name)) return toolText(m.id, helloError ? `${helloError}` : `No tool "${name}" is available to this blob${chief ? '' : ' (team tools belong to Kora, the Chief)'}.`, true);
        }
        try {
          const r = await call('blobs.mcp.call', { ...identity(), name, args: m.params?.arguments ?? {}, ...(opts.threadId ? { threadId: opts.threadId } : {}) }, 630_000); // an outbound app action waits up to 9 min for the user's OK
          const img = r?.image && typeof r.image.data === 'string' && typeof r.image.mimeType === 'string' ? r.image : null;
          if (img) return result(m.id, { content: [{ type: 'text', text: String(r?.text ?? '') }, { type: 'image', data: img.data, mimeType: img.mimeType }], ...(r?.isError === true ? { isError: true } : {}) }); // browser_screenshot
          return toolText(m.id, String(r?.text ?? ''), r?.isError === true);
        } catch (e: any) { return toolText(m.id, `Kora's daemon did not answer: ${e?.message ?? e}`, true); }
      }
      case 'resources/list': return result(m.id, { resources: [] });
      case 'resources/templates/list': return result(m.id, { resourceTemplates: [] });
      case 'prompts/list': return result(m.id, { prompts: [] });
      default: return rpcError(m.id, RPC.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  }

  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const inflight = new Set<Promise<void>>();
  let closed = false;
  let buffer = '';
  const write = (message: unknown) => { if (!closed && message != null) output.write(`${JSON.stringify(message)}\n`); };

  async function dispatch(line: string): Promise<void> {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { write(rpcError(null, RPC.PARSE_ERROR, 'Parse error: not valid JSON')); return; }
    if (Array.isArray(parsed)) {
      if (!parsed.length) { write(rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: empty batch')); return; }
      const out: any[] = [];
      for (const m of parsed) { try { const r = await handle(m); if (r != null) out.push(r); } catch (e: any) { out.push(rpcError(m?.id ?? null, RPC.INTERNAL_ERROR, e?.message || 'Internal error')); } }
      if (out.length) write(out);
      return;
    }
    try { write(await handle(parsed)); } catch (e: any) { write(rpcError(parsed?.id ?? null, RPC.INTERNAL_ERROR, e?.message || 'Internal error')); }
  }
  function onData(chunk: string) {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
      if (line) { const job: Promise<void> = dispatch(line).finally(() => inflight.delete(job)); inflight.add(job); }
      idx = buffer.indexOf('\n');
    }
  }
  function start() {
    (input as any).setEncoding?.('utf8');
    input.on('data', onData);
    input.on('end', () => { Promise.allSettled([...inflight]).then(() => { closed = true; opts.onClose?.(); }); });
    (input as any).resume?.();
  }
  return { start, dispatch, write };
}

export async function run(argv: string[], io: IO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') { io.out(usage + '\n'); return 0; }
  process.on('uncaughtException', (err) => { console.error('[kora-mcp-blobs] uncaught:', (err as any)?.stack || err); });
  process.on('unhandledRejection', (err) => { console.error('[kora-mcp-blobs] unhandled rejection:', (err as any)?.stack || err); });
  const o = blobBridgeOptions(argv);
  if (!o.blobId || !o.token) console.error('[kora-mcp-blobs] --blobs needs --blob <id> and --token <token> (or KORA_BLOB_ID / KORA_BLOB_TOKEN); serving no tools');
  const { defaultSocketPath } = require('../../protocol/types') as typeof import('../../protocol/types');
  const sock = socketCaller(o.socketPath || defaultSocketPath());
  const server = createBlobsMcp({ call: sock.call, ...(o.blobId ? { blobId: o.blobId } : {}), ...(o.token ? { token: o.token } : {}), ...(o.threadId ? { threadId: o.threadId } : {}), onClose: () => { sock.close(); process.exit(0); } });
  server.start();
  console.error(`[kora-mcp-blobs] listening on stdio (blob ${o.blobId || '?'})`);
  return new Promise<number>(() => { /* the session owns the process lifetime */ });
}


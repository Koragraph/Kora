// `kora mcp --team --token <t> [--socket <path>]`: a stdio MCP server for OUTSIDE clients (Claude Desktop, Cursor,
// Claude Code, Codex) to orchestrate the user's Blobs team. It is only a translator - MCP <-> two daemon RPCs:
//   blobs.outside.hello { token, clientInfo? } -> { ok, client, tools } | { ok:false, error }
//   blobs.outside.call  { token, tool, args, clientInfo? } -> { text, isError? }
// The daemon (blobs/outside/service.ts) owns auth, the tool list, rate limits and the audit log; nothing is decided here.
// The token comes from argv or KORA_TEAM_TOKEN (env is the better home: argv shows up in `ps`).
import type { IO } from '../main';
import { toJsonSchema, type ParamShape } from '../../session/fleet-tools';
import { socketCaller, type DaemonCall } from './mcp-blobs';
import { version } from '../../../package.json';

export const summary = 'Let an outside MCP client (Claude Desktop, Cursor, ...) orchestrate your Blobs team';
export const usage = `Usage: kora mcp --team --token <token> [--socket <path>]

Speaks MCP (JSON-RPC 2.0, one message per line) on stdio. Tools: list_blobs, get_blob, list_threads, read_thread, search,
send_message, ask_kora, wait_for, set_model, interrupt, list_outputs (+ list_groups, send_to_group when groups exist).
Approvals, deletes, settings, secrets, memory, app grants and computer/browser control are NOT available here.
Create the token in Kora: Settings, Outside access. Env fallback: KORA_TEAM_TOKEN, KORA_SOCKET_PATH.`;

export interface TeamBridgeOptions { token?: string; socketPath?: string }

export function teamBridgeOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): TeamBridgeOptions {
  const flag = (name: string, envKey: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return (v && !v.startsWith('--') ? v : undefined) ?? env[envKey] ?? undefined; };
  const o = { token: flag('token', 'KORA_TEAM_TOKEN'), socketPath: flag('socket', 'KORA_SOCKET_PATH') };
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as TeamBridgeOptions;
}

interface HelloTool { name: string; description: string; params: ParamShape; maxSeconds?: number }

const RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603, DENIED: -32001 };
const result = (id: unknown, r: unknown) => ({ jsonrpc: '2.0', id, result: r });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (id: unknown, text: string, isError = false) => result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

export function createTeamMcp(opts: { call: DaemonCall; token?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; onClose?: () => void }) {
  const { call } = opts;
  let clientInfo: { name?: string; version?: string } | undefined;
  let tools: HelloTool[] = [];

  async function hello(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!opts.token) return { ok: false, error: 'No token. Create one in Kora, Settings, Outside access, and pass it as --token or KORA_TEAM_TOKEN.' };
    try {
      const r = await call('blobs.outside.hello', { token: opts.token, ...(clientInfo ? { clientInfo } : {}) }, 10_000);
      if (r && r.ok === true && Array.isArray(r.tools)) { tools = r.tools as HelloTool[]; return { ok: true }; }
      tools = [];
      return { ok: false, error: String(r?.error ?? 'Kora refused this token.') };
    } catch (e: any) {
      tools = [];
      const m = String(e?.message ?? e);
      return { ok: false, error: /method not found|no such method|unknown method/i.test(m) ? 'This version of Kora does not have outside access yet. Update Kora.' : `Kora's daemon is not reachable (is Kora running?): ${m}` };
    }
  }

  async function handle(m: any): Promise<any> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id !== undefined ? rpcError(m.id, RPC.INVALID_REQUEST, 'Invalid Request') : null;
    if (m.id === undefined) return null;
    switch (m.method) {
      case 'initialize': {
        const ci = m.params?.clientInfo;
        if (ci && typeof ci.name === 'string') clientInfo = { name: ci.name.slice(0, 60), ...(typeof ci.version === 'string' ? { version: ci.version.slice(0, 20) } : {}) };
        return result(m.id, {
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kora-team', version },
          instructions: 'Control the user\'s Kora Blobs team: send work with send_message or ask_kora, then wait_for the reply. Approvals can only be answered in the Kora app; a thread that needs one reports "needs you in Kora".',
        });
      }
      case 'ping': return result(m.id, {});
      case 'tools/list': {
        const h = await hello();
        if (!h.ok) return rpcError(m.id, RPC.DENIED, h.error);
        return result(m.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.params) })) });
      }
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string') return rpcError(m.id, RPC.INVALID_REQUEST, 'tools/call needs a tool name');
        const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
        if (!opts.token) return toolText(m.id, 'No token. Create one in Kora, Settings, Outside access.', true);
        const hold = Number(args.timeout_s);
        const timeoutMs = name === 'wait_for' ? ((Number.isFinite(hold) && hold > 0 ? Math.min(hold, 300) : 45) + 30) * 1000 : 60_000;
        try {
          const r = await call('blobs.outside.call', { token: opts.token, tool: name, args, ...(clientInfo ? { clientInfo } : {}) }, timeoutMs);
          return toolText(m.id, String(r?.text ?? ''), r?.isError === true);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          return toolText(m.id, /method not found|no such method|unknown method/i.test(msg) ? 'This version of Kora does not have outside access yet. Update Kora.' : `Kora's daemon did not answer: ${msg}`, true);
        }
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
  // Kora is coming soon (edition.ts): outside access refuses up front (the daemon refuses its socket methods too).
  const { isKoraSurfaceOn, KORA_COMING_SOON_MESSAGE } = require('../../edition') as typeof import('../../edition');
  if (!isKoraSurfaceOn()) { io.err(`kora mcp --team: ${KORA_COMING_SOON_MESSAGE} Outside access arrives with Kora.\n`); return 2; }
  process.on('uncaughtException', (err) => { console.error('[kora-mcp-team] uncaught:', (err as any)?.stack || err); });
  process.on('unhandledRejection', (err) => { console.error('[kora-mcp-team] unhandled rejection:', (err as any)?.stack || err); });
  const o = teamBridgeOptions(argv);
  if (!o.token) console.error('[kora-mcp-team] --team needs --token <token> (or KORA_TEAM_TOKEN); create one in Kora, Settings, Outside access');
  const { defaultSocketPath } = require('../../protocol/types') as typeof import('../../protocol/types');
  const sock = socketCaller(o.socketPath || defaultSocketPath());
  const server = createTeamMcp({ call: sock.call, ...(o.token ? { token: o.token } : {}), onClose: () => { sock.close(); process.exit(0); } });
  server.start();
  console.error('[kora-mcp-team] listening on stdio');
  return new Promise<number>(() => { /* the client owns the process lifetime */ });
}

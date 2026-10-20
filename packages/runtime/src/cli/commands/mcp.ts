// `kora mcp` — stdio MCP server over the embedded graph. koragraph's protocol handles every
// message; this wrapper renames the server, drops koragraph's memory tools (`remember`, `recall`) from
// tools/list, rejects them in tools/call, scopes every call to the launch cwd's repo, and reports use to the
// pane's server.
import type { IO } from '../main';
import { kg, quietStdout, repoIdentity, socketReachable } from '../../graph/embedded';
import { version } from '../../../package.json';

export const summary = 'Serve the graph over MCP on stdio';
export const usage = `Usage: kora mcp [--fleet | --blobs | --team]

Speaks MCP (JSON-RPC 2.0, one message per line) on stdio. Seven tools: explore, search_code,
neighbours, changes_with, blast_radius, file_symbols, overview. Scope: the repository containing the cwd.

--blobs  serve ONE blob's tools (self + Kora's team tools) instead; see 'kora mcp --blobs --help' (cli/commands/mcp-blobs.ts).
--team   let an outside MCP client (Claude Desktop, Cursor, ...) orchestrate your Blobs; see 'kora mcp --team --help'.
--fleet  also serve the ORCHESTRATOR fleet tools (kora_spawn / workers / prompt / wait / read / kill /
         merge_verify / merge / plan) against the runtime's pane socket, for an orchestrator whose CLI takes
         MCP servers but has no in-process hook (a Codex chat thread). Identity on argv (env fallback in
         brackets): --orchestrator <id> [KORA_ORCHESTRATOR_ID]  --socket <path> [KORA_SOCKET_PATH]
         --agent <slug>  --runtime-mode <mode>  --model <id>  --effort <lvl>  --account <name>
         --agent-mode swarm [KORA_AGENT_MODE]: offer agent:"swarm" (free-model swarm workers via the daemon).
         --caller-key-file <path> [KORA_CALLER_KEY]: a one-time 0600 file holding the proof of --orchestrator the daemon
         hands out (control-auth.ts); read and deleted at start. The key itself never rides argv (ps shows argv).`;

/** koragraph's memory tools: not part of this product. */
const MEMORY_TOOLS = new Set(['remember', 'recall']);

export function serverInstructions(): string {
  const base: string = kg('src/mcp/tool-contracts.js').SERVER_INSTRUCTIONS;
  // Drop the memory paragraphs (recall/remember, fact resolution): kora exposes the code graph only.
  const cut = base
    .replace(/remember is recall's write side[\s\S]*?goes stale silently\.\s*/, '')
    .replace(/explore\/neighbours\/blast_radius\/file_symbols may attach a fact[\s\S]*?rather than guessing\.\s*/, '')
    .replace(/Koragraph indexes/, 'kora (embedded koragraph) indexes');
  return cut.trim();
}

/** The fleet tools for `--fleet`, bound to the runtime over the fleet socket. Null when not an orchestrator. */
/** `--key value` flags with env fallback. Codex starts MCP servers with a SCRUBBED environment (a bridge launched
 *  with only env came up with the graph tools and no fleet), so the identity travels on argv. */
export function fleetBridgeOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): { orchestratorId?: string; socketPath?: string; agent?: string; runtimeMode?: string; model?: string; effort?: string; account?: string; agentMode?: string; koraHome?: string; callerKey?: string; callerKeyFile?: string } {
  const flag = (name: string, envKey: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return (v && !v.startsWith('--') ? v : undefined) ?? env[envKey] ?? undefined; };
  const o = {
    orchestratorId: flag('orchestrator', 'KORA_ORCHESTRATOR_ID'), socketPath: flag('socket', 'KORA_SOCKET_PATH'), agent: flag('agent', 'KORA_ORCHESTRATOR_AGENT'),
    runtimeMode: flag('runtime-mode', 'KORA_RUNTIME_MODE'), model: flag('model', 'KORA_ORCHESTRATOR_MODEL'), effort: flag('effort', 'KORA_ORCHESTRATOR_EFFORT'), account: flag('account', 'KORA_ACCOUNT'),
    agentMode: flag('agent-mode', 'KORA_AGENT_MODE'), koraHome: flag('kora-home', 'KORA_HOME'), callerKey: env.KORA_CALLER_KEY || undefined,
    callerKeyFile: flag('caller-key-file', 'KORA_CALLER_KEY_FILE'),
  };
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as any;
}

function fleetBridge(cwd: string, argv: string[]): { specs: import('../../session/fleet-tools').FleetToolSpec[]; close(): void } | null {
  const o = fleetBridgeOptions(argv);
  if (!o.orchestratorId) { console.error('[kora-mcp] --fleet needs --orchestrator <id> (or KORA_ORCHESTRATOR_ID); serving graph tools only'); return null; }
  const { makeRemoteFleet } = require('../../server/fleet-ops') as typeof import('../../server/fleet-ops');
  const { fleetToolSpecs } = require('../../session/fleet-tools') as typeof import('../../session/fleet-tools');
  const { defaultSocketPath } = require('../../protocol/types') as typeof import('../../protocol/types');
  // The proof of the orchestrator id (server/control-auth.ts callerKey), for the client this bridge dials with.
  const fileKey = o.callerKeyFile ? (require('../../server/control-auth') as typeof import('../../server/control-auth')).takeCallerKeyFile(o.callerKeyFile) : undefined;
  if (fileKey ?? o.callerKey) process.env.KORA_CALLER_KEY = fileKey ?? o.callerKey;
  const remote = makeRemoteFleet(o.socketPath || defaultSocketPath(), o.orchestratorId);
  const specs = fleetToolSpecs({
    fleet: remote.control,
    orchestratorId: o.orchestratorId,
    agent: (o.agent || 'codex') as any,
    cwd,
    account: o.account || null,
    ...(o.model ? { model: { model: o.model, effort: o.effort ?? null } } : {}),
    ...(o.runtimeMode ? { runtimeMode: o.runtimeMode as any } : {}),
    spawnWorker: (p) => remote.spawnWorker(p),
    // `--agent-mode swarm` (a Koragent lead pane, or a Swarm-mode thread's bridge): kora_spawn offers agent:"swarm",
    // spawned through the daemon's `swarm.spawn`, which re-checks the orchestrator (Swarm thread or orchestrator pane).
    ...(o.agentMode ? { agentMode: o.agentMode as any } : {}),
    swarm: remote.swarm,
    // kora_ask_workers: the picker shows in the app; the answer comes back over the socket.
    ...(o.orchestratorId.startsWith('chat:') ? { askWorkers: (picks: import('../../session/worker-picker').WorkerPick[]) => remote.askWorkers(o.orchestratorId!, picks) } : {}),
    // The daemon's KORA_HOME (worker catalog + roster); Codex scrubs the env, so it rides argv like the rest.
    ...(o.koraHome ? { koraHome: o.koraHome } : {}),
  });
  return { specs, close: () => remote.close() };
}

export function createKoraMcp(opts: { cwd?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; onClose?: () => void; fleet?: boolean; argv?: string[] } = {}) {
  quietStdout();
  const cwd = opts.cwd || process.cwd();
  const protocol = kg('src/mcp/protocol.js');
  const contracts = kg('src/mcp/tool-contracts.js');
  let freshness: unknown = null;
  try { freshness = kg('src/services/live-freshness.js'); } catch { /* no-op */ }
  const { repoId } = repoIdentity(cwd);
  const deps = { cwd, repoId, freshness };
  let graphSvc: import('../../graph/index').GraphService | null = null;
  const graphService = () => graphSvc || (graphSvc = (require('../../graph/index') as typeof import('../../graph/index')).createGraphService());
  const paneId = process.env.KORA_PANE_ID || null;
  const bridge = opts.fleet ? fleetBridge(cwd, opts.argv ?? []) : null;
  const fleetByName = new Map((bridge?.specs ?? []).map((t) => [t.name, t] as const));

  function report(tool: string, ms: number) {
    if (!paneId || !socketReachable()) return;
    try {
      const { KoraClient } = require('../../protocol/client');
      const c = new KoraClient();
      c.connect(500).then(() => c.call('pane.reportGraphUse', { paneId, tool, ms, channel: 'mcp' }).catch(() => {}).finally(() => c.close()), () => {});
    } catch { /* best effort */ }
  }

  async function handle(message: any): Promise<any> {
    if (message && typeof message === 'object' && message.jsonrpc === '2.0' && message.id !== undefined) {
      if (message.method === 'initialize') {
        const r = await protocol.handleMessage(message, deps);
        if (r && r.result) {
          const { trimmedInstructions } = require('../../graph/tool-trim');
          r.result.serverInfo = { name: 'kora', version };
          r.result.instructions = trimmedInstructions() || serverInstructions();
        }
        return r;
      }
      if (message.method === 'tools/list') {
        const { trimTool } = require('../../graph/tool-trim');
        const { toJsonSchema } = require('../../session/fleet-tools') as typeof import('../../session/fleet-tools');
        const fleetTools = [...fleetByName.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.params) }));
        return protocol.jsonRpcResult(message.id, { tools: [...fleetTools, ...contracts.listTools().filter((t: any) => !MEMORY_TOOLS.has(t.name)).map(trimTool)] });
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        const fleetTool = typeof name === 'string' ? fleetByName.get(name) : undefined;
        if (fleetTool) {
          const r = await fleetTool.handler(message.params?.arguments || {});
          return protocol.jsonRpcResult(message.id, { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
        }
        if (MEMORY_TOOLS.has(name)) {
          return protocol.jsonRpcResult(message.id, {
            content: [{ type: 'text', text: `${name} is not exposed by kora: it serves the code graph only.` }],
            structuredContent: { error: 'not_exposed', code: 'not_exposed' }, isError: true,
          });
        }
        const t0 = Date.now();
        // Inside a pane with a live server, the call goes THROUGH the server: one process holds the store, one
        // freshness cache, one index queue — N agents no longer mean N writers. Falls back to in-process.
        if (paneId && socketReachable()) {
          try {
            const { callOnce } = require('../../protocol/client');
            const r = await callOnce('graph.tool', { name, args: message.params?.arguments || {}, cwd, paneId, channel: 'mcp' });
            return protocol.jsonRpcResult(message.id, protocol.toolSuccess({ data: r.data, text: r.text }));
          } catch (e: any) {
            if (e && typeof e.code === 'number' && e.code !== -32603 && e.message) return protocol.jsonRpcResult(message.id, protocol.toolError(e.message, e.data?.code || 'error', {}));
            /* server unreachable or internal → in-process below */
          }
        }
        // In-process: through kora's own GraphService, never koragraph's raw protocol. The raw protocol scopes a
        // call to the PROJECT — every repository ever indexed on this machine (61 branches here) — so each explore
        // scanned the whole store: measured 6 s per call and hits from other repos in the ranked list. The service
        // scopes to the repository containing cwd (a worktree maps to its main checkout), applies the same freshness,
        // slimming and worktree overlay as every other lane, and answers in ~0.3 s warm.
        try {
          const g = graphService();
          const r = await g.callTool(name, message.params?.arguments || {}, { cwd, fresh: true });
          if (typeof name === 'string') report(name, Date.now() - t0);
          return protocol.jsonRpcResult(message.id, { content: [{ type: 'text', text: r.text }], ...(r.data !== undefined && r.data !== null ? { structuredContent: r.data } : {}) });
        } catch (e: any) {
          if (e && e.code === 'unknown_tool') return protocol.handleMessage(message, deps); // not a graph tool: let koragraph answer
          return protocol.jsonRpcResult(message.id, { content: [{ type: 'text', text: e?.message || 'graph tool failed' }], structuredContent: { error: e?.message || 'graph tool failed', code: e?.code || 'tool_error' }, isError: true });
        }
      }
    }
    return protocol.handleMessage(message, deps);
  }

  // Same framing as koragraph's stdio.js (one JSON-RPC message per line, batches answered as one
  // array, nothing may throw past this boundary) with our dispatcher in place of protocol.handleMessage.
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const { jsonRpcError, RPC } = protocol;
  const inflight = new Set<Promise<void>>();
  let closed = false;
  let buffer = '';
  function write(message: unknown) { if (closed || message == null) return; output.write(`${JSON.stringify(message)}\n`); }
  async function dispatch(line: string) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { write(jsonRpcError(null, RPC.PARSE_ERROR, 'Parse error: not valid JSON')); return; }
    if (Array.isArray(parsed)) {
      if (!parsed.length) { write(jsonRpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: empty batch')); return; }
      const out: any[] = [];
      for (const m of parsed) { try { const r = await handle(m); if (r != null) out.push(r); } catch (e: any) { out.push(jsonRpcError(m?.id ?? null, RPC.INTERNAL_ERROR, e?.message || 'Internal error')); } }
      if (out.length) write(out);
      return;
    }
    try { write(await handle(parsed)); } catch (e: any) { write(jsonRpcError(parsed?.id ?? null, RPC.INTERNAL_ERROR, e?.message || 'Internal error')); }
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
    input.on('end', () => { Promise.allSettled([...inflight]).then(() => { closed = true; bridge?.close(); opts.onClose?.(); }); });
    (input as any).resume?.();
  }
  return { start, dispatch, write };
}

export async function run(argv: string[], io: IO): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') { io.out(usage + '\n'); return 0; }
  if (argv.includes('--blobs')) return (require('./mcp-blobs') as typeof import('./mcp-blobs')).run(argv, io);
  if (argv.includes('--team')) return (require('./mcp-team') as typeof import('./mcp-team')).run(argv, io);
  process.on('uncaughtException', (err) => { console.error('[kora-mcp] uncaught:', (err as any)?.stack || err); });
  process.on('unhandledRejection', (err) => { console.error('[kora-mcp] unhandled rejection:', (err as any)?.stack || err); });
  const fleet = argv.includes('--fleet');
  const server = createKoraMcp({ onClose: () => process.exit(0), fleet, argv });
  server.start();
  console.error(`[kora-mcp] listening on stdio${fleet ? ` (fleet tools for ${fleetBridgeOptions(argv).orchestratorId || '?'})` : ''}`);
  return new Promise<number>(() => { /* the session owns the process lifetime */ });
}

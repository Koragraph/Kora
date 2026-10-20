// "Test" on a server: start (or reach) it as an MCP client would, initialize, list its tools, close. The answer is
// what the user needs to fix a broken entry: the tools it offers, or the error and the last lines it printed.
import type { ResolvedServer } from './wire';

export interface HealthResult {
  ok: boolean;
  ms: number;
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  error?: string;
  /** The server's last stderr lines (stdio), for a failed start. */
  stderr?: string;
}

const TIMEOUT_MS = 30_000; // the first `npx -y` of a package downloads it

export async function testServer(r: ResolvedServer, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<HealthResult> {
  const started = Date.now();
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'kora-extensions-check', version: '1.0.0' });
  let transport: any;
  const tail: string[] = [];
  if (r.transport === 'stdio') {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({
      command: r.command, args: r.args ?? [], stderr: 'pipe',
      env: { ...process.env, ...(r.env ?? {}) } as Record<string, string>,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    transport.stderr?.on('data', (d: Buffer) => { tail.push(...String(d).split('\n').filter(Boolean)); tail.splice(0, Math.max(0, tail.length - 12)); });
  } else {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport = new StreamableHTTPClientTransport(new URL(r.url!), { requestInit: { headers: r.headers ?? {} } });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000)} s`)), opts.timeoutMs ?? TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const listed: { tools?: { name: string }[] } = await Promise.race([client.listTools(), timeout]);
    const info = client.getServerVersion?.() ?? {};
    return {
      ok: true, ms: Date.now() - started, tools: (listed.tools ?? []).map((t) => t.name),
      ...(info.name ? { serverName: String(info.name) } : {}), ...(info.version ? { serverVersion: String(info.version) } : {}),
    };
  } catch (e: any) {
    const raw = String(e?.message ?? e);
    const error = /ENOENT/.test(raw) && r.transport === 'stdio'
      ? `"${r.command}" was not found. Install it, or use its full path.`
      : /\b401\b|unauthori[sz]ed/i.test(raw) ? `The server refused the credentials (${raw.slice(0, 160)}).`
      : raw.slice(0, 300);
    return { ok: false, ms: Date.now() - started, tools: [], error, ...(tail.length ? { stderr: tail.join('\n') } : {}) };
  } finally {
    clearTimeout(timer);
    try { await client.close(); } catch { /* already gone */ }
  }
}

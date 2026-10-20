// One resolved server list → each agent's own MCP configuration. A secret never goes on a command line (argv is
// visible to every user on the machine): the Claude SDK and ACP get values in-process or over stdin, OpenCode in its
// config env var, Codex reads remote-server secrets from env vars it is told about, and a Codex stdio server with
// secrets starts through `kora ext exec <name>`, which reads them itself.
import { isSecretRef, type McpServer, type Value } from './model';

export interface ResolvedServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Keys (env vars or headers) whose values came from the keychain. */
  secretKeys: string[];
}

export interface Skipped { name: string; reason: string }

/** Fill secret refs from `lookup`; a server with a missing secret is skipped (it would only fail to authenticate). */
export function resolveServer(s: McpServer, lookup: (id: string) => string | null): ResolvedServer | Skipped {
  const secretKeys: string[] = [];
  const fill = (rec: Record<string, Value> | undefined): Record<string, string> | Skipped | undefined => {
    if (!rec) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (isSecretRef(v)) {
        const got = lookup(v.secret);
        if (got === null) return { name: s.name, reason: `the saved value for ${k} is missing from the keychain` };
        out[k] = got;
        secretKeys.push(k);
      } else out[k] = v;
    }
    return out;
  };
  const env = fill(s.env);
  if (env && 'reason' in env) return env as Skipped;
  const headers = fill(s.headers);
  if (headers && 'reason' in headers) return headers as Skipped;
  return {
    name: s.name, transport: s.transport, secretKeys,
    ...(s.command ? { command: s.command } : {}), ...(s.args?.length ? { args: s.args } : {}),
    ...(env && Object.keys(env).length ? { env: env as Record<string, string> } : {}),
    ...(s.url ? { url: s.url } : {}), ...(headers && Object.keys(headers).length ? { headers: headers as Record<string, string> } : {}),
  };
}

export const isSkipped = (r: ResolvedServer | Skipped): r is Skipped => 'reason' in r;

// ---- Claude Code ------------------------------------------------------------------------------------------------------

/** The Agent SDK's `mcpServers` option (and the `mcpServers` object of a `--mcp-config` file). */
export function claudeServers(rs: ResolvedServer[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rs) {
    out[r.name] = r.transport === 'http'
      ? { type: 'http', url: r.url, ...(r.headers ? { headers: r.headers } : {}) }
      : { type: 'stdio', command: r.command, args: r.args ?? [], ...(r.env ? { env: r.env } : {}) };
  }
  return out;
}

// ---- Codex ------------------------------------------------------------------------------------------------------------

const tomlStr = (s: string) => JSON.stringify(s);
const tomlTable = (r: Record<string, string>) => `{${Object.entries(r).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')}}`;
/** Env var a remote server's secret header travels in (Codex reads it via env_http_headers). */
export const codexHeaderEnv = (server: string, header: string) =>
  `KORA_EXT_${server}_${header}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

export interface CodexWiring { args: string[]; env: Record<string, string> }

/**
 * `-c mcp_servers.<name>.…` overrides. `exec`: how to start `kora ext exec <name>` (node + kora.js), used for stdio
 * servers that carry secrets so the values stay off argv.
 */
export function codexWiring(rs: ResolvedServer[], exec: { command: string; args: string[] } | null): CodexWiring {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const c = (key: string, value: string) => args.push('-c', `mcp_servers.${key}=${value}`);
  for (const r of rs) {
    const n = /^[A-Za-z0-9_-]+$/.test(r.name) ? r.name : tomlStr(r.name);
    if (r.transport === 'http') {
      c(`${n}.url`, tomlStr(r.url!));
      const plain: Record<string, string> = {};
      const viaEnv: Record<string, string> = {};
      for (const [h, v] of Object.entries(r.headers ?? {})) {
        if (r.secretKeys.includes(h)) { const e = codexHeaderEnv(r.name, h); env[e] = v; viaEnv[h] = e; } else plain[h] = v;
      }
      if (Object.keys(plain).length) c(`${n}.http_headers`, tomlTable(plain));
      if (Object.keys(viaEnv).length) c(`${n}.env_http_headers`, tomlTable(viaEnv));
      continue;
    }
    const secret = r.secretKeys.length > 0;
    if (secret && exec) {
      c(`${n}.command`, tomlStr(exec.command));
      c(`${n}.args`, JSON.stringify([...exec.args, 'ext', 'exec', r.name]));
      continue;
    }
    if (secret) continue; // no bridge: better absent than leaking the value on argv
    c(`${n}.command`, tomlStr(r.command!));
    c(`${n}.args`, JSON.stringify(r.args ?? []));
    if (r.env) c(`${n}.env`, tomlTable(r.env));
  }
  return { args, env };
}

// ---- OpenCode ---------------------------------------------------------------------------------------------------------

export function opencodeEntries(rs: ResolvedServer[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rs) {
    out[r.name] = r.transport === 'http'
      ? { type: 'remote', url: r.url, enabled: true, ...(r.headers ? { headers: r.headers } : {}) }
      : { type: 'local', command: [r.command!, ...(r.args ?? [])], enabled: true, ...(r.env ? { environment: r.env } : {}) };
  }
  return out;
}

/** Merge the entries into an OPENCODE_CONFIG_CONTENT string; Kora's own entries already there win on a name clash. */
export function withOpencodeServers(content: string | undefined, rs: ResolvedServer[]): string | undefined {
  if (rs.length === 0) return content;
  let cfg: Record<string, any> = {};
  try { const p = content ? JSON.parse(content) : {}; if (p && typeof p === 'object') cfg = p; } catch { cfg = {}; }
  const existing = cfg.mcp && typeof cfg.mcp === 'object' ? cfg.mcp : {};
  cfg.mcp = { ...opencodeEntries(rs), ...existing };
  return JSON.stringify(cfg);
}

// ---- Antigravity and other ACP agents ---------------------------------------------------------------------------------

/** `mcpServers` of ACP `session/new` / `session/load`. */
export function acpServers(rs: ResolvedServer[]): unknown[] {
  const pairs = (r: Record<string, string> | undefined) => Object.entries(r ?? {}).map(([name, value]) => ({ name, value }));
  return rs.map((r) => r.transport === 'http'
    ? { type: 'http', name: r.name, url: r.url, headers: pairs(r.headers) }
    : { name: r.name, command: r.command, args: r.args ?? [], env: pairs(r.env) });
}

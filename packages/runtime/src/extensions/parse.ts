// Turns what a user pastes into server definitions. Accepted, because it is what MCP servers' READMEs show:
//  - JSON in any agent's shape: { "mcpServers": {…} } (Claude Code, Cursor, Antigravity, Gemini), { "servers": {…} }
//    (VS Code), { "mcp": {…} } (OpenCode), or one server object;
//  - a Codex TOML section: [mcp_servers.<name>] command = … ;
//  - a URL (a remote server);
//  - a command line (`npx -y @scope/server --flag`), also wrapped in `claude mcp add …`, `codex mcp add …` or
//    `agy mcp add …`.
import type { McpServer, Value } from './model';

export interface ParsedServer extends Partial<McpServer> { name: string }
export interface ParseResult {
  servers: ParsedServer[];
  /** env/header keys per server whose literal values look like credentials (move them to the keychain). */
  secretKeys: Record<string, string[]>;
  warnings: string[];
}

const SECRETISH = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|bearer|^pat$|_pat$)/i;

/** POSIX-ish word splitting: single and double quotes, backslash escapes. */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    cur += c;
  }
  if (quote) throw new Error('Unclosed quote in the command.');
  if (cur || had) out.push(cur);
  return out;
}

/** A readable default name: the package (`@modelcontextprotocol/server-github` → `github`) or the URL host. */
export function suggestName(s: { command?: string; args?: string[]; url?: string }): string {
  const clean = (n: string) => n.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'server';
  if (s.url) {
    try {
      const host = new URL(s.url).hostname.replace(/^(www|api|mcp)\./, '');
      return clean(host.split('.')[0] ?? host);
    } catch { return 'remote'; }
  }
  const words = [s.command ?? '', ...(s.args ?? [])].filter((w) => w && !w.startsWith('-'));
  const runners = new Set(['npx', 'pnpm', 'dlx', 'bunx', 'uvx', 'uv', 'run', 'pipx', 'docker', 'node', 'python', 'python3', 'deno', 'exec', 'yarn']);
  const pkg = words.find((w) => !runners.has(w.split('/').pop() ?? w) && !w.startsWith('/') && !w.includes('='));
  if (!pkg) return clean((s.command ?? 'server').split('/').pop() ?? 'server');
  const noVersion = pkg.replace(/(.)@[^@/]+$/, '$1');
  const bare = noVersion.split('/').pop() ?? noVersion;
  const core = bare.replace(/^(mcp-server-|server-|mcp-)/, '').replace(/(-mcp-server|-mcp|-server)$/, '');
  // `@sentry/mcp-server` says nothing in its own name: the scope does.
  const scope = /^@([^/]+)\//.exec(noVersion)?.[1];
  return clean(scope && /^(server|mcp|mcp-server)?$/.test(core) ? scope.replace(/^(modelcontextprotocol)$/, 'mcp') : core);
}

function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function strMap(v: unknown): Record<string, Value> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, Value> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x);
  return Object.keys(out).length ? out : undefined;
}

/** One server object in any agent's spelling. */
export function fromConfigEntry(name: string, e: Record<string, unknown>): ParsedServer | null {
  const url = str(e.url) ?? str(e.serverUrl) ?? str(e.httpUrl);
  const type = str(e.type) ?? str(e.transport);
  if (url || type === 'remote' || type === 'http' || type === 'sse' || type === 'streamable-http') {
    if (!url) return null;
    const headers = strMap(e.headers) ?? strMap(e.http_headers) ?? strMap(e.requestInit && (e.requestInit as { headers?: unknown }).headers);
    return { name, transport: 'http', url, ...(headers ? { headers } : {}), ...(e.enabled === false || e.disabled === true ? { enabled: false } : {}) };
  }
  let command = str(e.command);
  let args = Array.isArray(e.args) ? e.args.map(String) : undefined;
  if (Array.isArray(e.command)) { const [c, ...rest] = e.command.map(String); command = c; args = rest; } // OpenCode: command is argv
  if (!command) return null;
  const env = strMap(e.env) ?? strMap(e.environment);
  return { name, transport: 'stdio', command, ...(args?.length ? { args } : {}), ...(env ? { env } : {}), ...(e.enabled === false || e.disabled === true ? { enabled: false } : {}) };
}

function fromJson(j: unknown, fallbackName?: string): ParsedServer[] {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return [];
  const o = j as Record<string, unknown>;
  const table = (o.mcpServers ?? o.servers ?? o.mcp ?? o.mcp_servers ?? (o.context_servers as unknown)) as Record<string, unknown> | undefined;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    return Object.entries(table).flatMap(([n, e]) => {
      const s = e && typeof e === 'object' ? fromConfigEntry(n, e as Record<string, unknown>) : null;
      return s ? [s] : [];
    });
  }
  if ('command' in o || 'url' in o || 'serverUrl' in o) {
    const probe = fromConfigEntry('x', o);
    if (!probe) return [];
    const name = str(o.name) ?? fallbackName ?? suggestName(probe);
    return [{ ...probe, name }];
  }
  return [];
}

function fromToml(text: string): ParsedServer[] {
  const toml = require('smol-toml') as typeof import('smol-toml');
  const doc = toml.parse(text) as Record<string, unknown>;
  const table = (doc.mcp_servers ?? doc.mcpServers) as Record<string, unknown> | undefined;
  if (!table || typeof table !== 'object') return [];
  return Object.entries(table).flatMap(([n, e]) => {
    const s = e && typeof e === 'object' ? fromConfigEntry(n, e as Record<string, unknown>) : null;
    return s ? [s] : [];
  });
}

/** `claude mcp add [-t http] [-e K=V] [-H "K: V"] [-s scope] name -- cmd args` and the codex / agy equivalents. */
function fromAddCommand(words: string[]): ParsedServer | null {
  const i = words.findIndex((w, k) => w === 'add' && words[k - 1] === 'mcp');
  if (i < 0) return null;
  const rest = words.slice(i + 1);
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let transport: 'stdio' | 'http' | undefined;
  let url: string | undefined;
  const positional: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]!;
    if (w === '--') { positional.push(...rest.slice(k + 1)); break; }
    const take = () => rest[++k] ?? '';
    if (w === '-e' || w === '--env') { const [a, ...b] = take().split('='); if (a) env[a] = b.join('='); continue; }
    if (w === '-H' || w === '--header') { const h = take(); const at = h.indexOf(':'); if (at > 0) headers[h.slice(0, at).trim()] = h.slice(at + 1).trim(); continue; }
    if (w === '-t' || w === '--transport' || w === '--type') { const t = take(); transport = t === 'stdio' ? 'stdio' : 'http'; continue; }
    if (w === '--url') { url = take(); transport = 'http'; continue; }
    if (w === '-s' || w === '--scope' || w === '-c' || w === '--config' || w === '--bearer-token-env-var' || w === '--enable') { take(); continue; }
    if (w.startsWith('-') && positional.length === 0) continue;
    positional.push(w);
  }
  const [name, target, ...args] = positional;
  if (!name) return null;
  if (url || transport === 'http' || (target && /^https?:\/\//.test(target))) {
    return { name, transport: 'http', url: url ?? target ?? '', ...(Object.keys(headers).length ? { headers } : {}) };
  }
  if (!target) return null;
  return { name, transport: 'stdio', command: target, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

/** Parse pasted text. `name` overrides the derived name when exactly one server comes out. */
export function parseServerInput(input: string, name?: string): ParseResult {
  const text = input.trim();
  const warnings: string[] = [];
  let servers: ParsedServer[] = [];
  if (!text) return { servers, secretKeys: {}, warnings: ['Paste a config snippet, a command or a URL.'] };

  if (text.startsWith('{')) {
    let j: unknown;
    try { j = JSON.parse(text); } catch {
      // README snippets are often a fragment: `"github": { … }` without the outer braces is caught below.
      try { j = JSON.parse(stripJsonComments(text)); } catch (e: any) { throw new Error(`That JSON does not parse: ${e?.message ?? e}`); }
    }
    servers = fromJson(j, name);
  } else if (/^"[^"]+"\s*:\s*\{/.test(text)) {
    try { servers = fromJson(JSON.parse(`{"mcpServers":{${text.replace(/,\s*$/, '')}}}`)); } catch (e: any) { throw new Error(`That JSON fragment does not parse: ${e?.message ?? e}`); }
  } else if (/^\[mcp_servers\./m.test(text)) {
    try { servers = fromToml(text); } catch (e: any) { throw new Error(`That TOML does not parse: ${e?.message ?? e}`); }
  } else if (/^https?:\/\/\S+$/.test(text)) {
    servers = [{ name: name ?? suggestName({ url: text }), transport: 'http', url: text }];
  } else {
    const words = splitWords(text.replace(/\\\n/g, ' '));
    const viaAdd = fromAddCommand(words);
    if (viaAdd) servers = [viaAdd];
    else {
      // Leading KEY=value words are environment for the command (`GITHUB_TOKEN=… npx …`).
      const env: Record<string, string> = {};
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) { const [k, ...v] = words.shift()!.split('='); env[k!] = v.join('='); }
      const [command, ...args] = words;
      if (command) servers = [{ name: name ?? suggestName({ command, args }), transport: 'stdio', command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) }];
    }
  }

  if (servers.length === 0) warnings.push('No MCP server found in that text. Paste a config snippet ({"mcpServers": …}), a command (npx …) or a URL.');
  if (name && servers.length === 1) servers[0] = { ...servers[0]!, name };
  const secretKeys: Record<string, string[]> = {};
  for (const s of servers) {
    const keys = [
      ...Object.entries(s.env ?? {}).filter(([k, v]) => typeof v === 'string' && v && SECRETISH.test(k)).map(([k]) => `env:${k}`),
      ...Object.entries(s.headers ?? {}).filter(([k, v]) => typeof v === 'string' && v && SECRETISH.test(k)).map(([k]) => `header:${k}`),
    ];
    if (keys.length) secretKeys[s.name] = keys;
    for (const v of Object.values(s.env ?? {})) {
      if (typeof v === 'string' && /^(\$\{?[A-Z_]+\}?|<[^>]+>|YOUR_|your-|xxx)/.test(v)) warnings.push(`${s.name}: replace the placeholder value "${v}" before using it.`);
    }
  }
  return { servers, secretKeys, warnings };
}

/** Drop // and /* … *\/ comments outside strings (opencode.jsonc, README snippets). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

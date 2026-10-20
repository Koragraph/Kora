// Extensions: MCP servers and skills the user adds once in Kora and every supported agent gets, in that agent's own
// format (wire.ts), in chat threads and, per server, in worker panes. Stored in <KORA_HOME>/extensions.json; a repo may
// add servers in .kora/extensions.json (read only in a trusted folder). Secret values never sit in either file: an env
// var or header value of `{ "secret": "<id>" }` resolves from the OS keychain (secrets.ts).
import path from 'node:path';

/**
 * The home folder whose agent configs Kora reads and writes (discovery, skill links, Antigravity's MCP file).
 * KORA_AGENTS_HOME points it elsewhere: QA stacks and tests must never touch the real ~/.claude, ~/.codex or ~/.gemini.
 */
export function agentsHome(): string {
  return process.env.KORA_AGENTS_HOME || require('node:os').homedir();
}

export const EXTENSION_AGENTS = ['claude', 'codex', 'opencode', 'antigravity'] as const;
export type ExtensionAgent = (typeof EXTENSION_AGENTS)[number];

export const AGENT_LABELS: Record<ExtensionAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
};

export interface SecretRef { secret: string }
export type Value = string | SecretRef;

export interface McpServer {
  /** Unique; letters, digits, `_` and `-`. It is the tool prefix the agents show (`mcp__<name>__…` in Claude Code). */
  name: string;
  transport: 'stdio' | 'http';
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, Value>;
  /** http (streamable HTTP; most agents also accept the older SSE endpoints at the same URL) */
  url?: string;
  headers?: Record<string, Value>;
  enabled: boolean;
  /** Agents that get it. */
  agents: ExtensionAgent[];
  /** Also start it for worker panes (off by default: a worker should get only what its task needs). */
  workers: boolean;
  /** Only sessions whose folder is inside one of these. Absent: everywhere. */
  folders?: string[];
  /** Where it came from: `manual`, `catalog:<id>`, `import:<agent>`, `project`. */
  source?: string;
}

export interface Skill {
  /** The folder name agents load it by. */
  name: string;
  description: string;
  /** Kora's copy: <KORA_HOME>/extensions/skills/<name>. */
  dir: string;
  agents: ExtensionAgent[];
  enabled: boolean;
  source?: string;
}

export interface ExtensionsFile {
  version: 1;
  mcpServers: McpServer[];
  skills: Skill[];
  /**
   * Project servers (a repo's .kora/extensions.json) the user allowed, by fingerprint of folder + exact definition:
   * a changed definition needs a new approval, so a commit or an agent cannot swap in a different command.
   */
  approvedProjectServers: string[];
}

export const emptyExtensions = (): ExtensionsFile => ({ version: 1, mcpServers: [], skills: [], approvedProjectServers: [] });

/** Names Kora uses for its own servers in the same agent configs. */
export const RESERVED_NAMES = new Set(['kora', 'kora_fleet', 'kora_blobs', 'kora_team']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export const isSecretRef = (v: unknown): v is SecretRef =>
  !!v && typeof v === 'object' && typeof (v as SecretRef).secret === 'string';

export function isExtensionAgent(v: unknown): v is ExtensionAgent {
  return typeof v === 'string' && (EXTENSION_AGENTS as readonly string[]).includes(v);
}

/** Every problem with a server definition, as sentences a user can act on. Empty = valid. */
export function serverProblems(s: Partial<McpServer>): string[] {
  const out: string[] = [];
  if (!s.name || !NAME.test(s.name)) out.push('Name: 1–48 letters, digits, "_" or "-", starting with a letter or digit.');
  else if (RESERVED_NAMES.has(s.name.toLowerCase())) out.push(`"${s.name}" is reserved for Kora's own tools; pick another name.`);
  if (s.transport === 'stdio') {
    if (!s.command?.trim()) out.push('A local server needs a command to run.');
    if (s.args && !s.args.every((a) => typeof a === 'string')) out.push('Arguments must be text.');
    for (const k of Object.keys(s.env ?? {})) if (!ENV_KEY.test(k)) out.push(`"${k}" is not a valid environment variable name.`);
  } else if (s.transport === 'http') {
    let u: URL | null = null;
    try { u = new URL(s.url ?? ''); } catch { /* reported below */ }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) out.push('A remote server needs an http(s) URL.');
    else if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      out.push('Use https for a remote server (plain http only for localhost).');
    }
    for (const k of Object.keys(s.headers ?? {})) if (!HEADER_KEY.test(k)) out.push(`"${k}" is not a valid header name.`);
  } else {
    out.push('Transport must be "stdio" (a local command) or "http" (a URL).');
  }
  if (!Array.isArray(s.agents) || s.agents.length === 0 || !s.agents.every(isExtensionAgent)) {
    out.push(`Pick at least one agent (${EXTENSION_AGENTS.join(', ')}).`);
  }
  return out;
}

/** A server with defaults filled in and unknown keys dropped (what the store keeps). */
export function normalizeServer(s: Partial<McpServer> & { name: string }): McpServer {
  const clean = (r: Record<string, Value> | undefined) =>
    r && Object.keys(r).length ? Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === 'string' || isSecretRef(v))) : undefined;
  const base: McpServer = {
    name: s.name.trim(),
    transport: s.transport === 'http' ? 'http' : 'stdio',
    enabled: s.enabled !== false,
    agents: Array.isArray(s.agents) && s.agents.length ? [...new Set(s.agents.filter(isExtensionAgent))] : [...EXTENSION_AGENTS],
    workers: s.workers === true,
  };
  if (base.transport === 'stdio') {
    base.command = (s.command ?? '').trim();
    if (s.args?.length) base.args = [...s.args];
    const env = clean(s.env);
    if (env) base.env = env;
  } else {
    base.url = (s.url ?? '').trim();
    const headers = clean(s.headers);
    if (headers) base.headers = headers;
  }
  if (s.folders?.length) base.folders = [...new Set(s.folders)];
  if (s.source) base.source = s.source;
  return base;
}

/** True when the server applies to a session in `cwd` (folder scoping). */
export function appliesTo(s: McpServer, cwd: string): boolean {
  if (!s.folders?.length) return true;
  return s.folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
}

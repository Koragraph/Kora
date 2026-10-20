// What each agent already has configured, so the user can import it once instead of retyping it. Read-only: Kora
// never edits these files here. Kora's own entries (kora, kora_fleet, …) are left out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentsHome, RESERVED_NAMES, type ExtensionAgent } from './model';
import { fromConfigEntry, stripJsonComments, type ParsedServer } from './parse';

export interface Discovered {
  agent: ExtensionAgent;
  /** The file it was read from. */
  file: string;
  server: ParsedServer;
  /** For a project-scoped entry (Claude Code's per-folder servers): the folder. */
  folder?: string;
}

const readJson = (file: string): any => {
  try { return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))); } catch { return null; }
};
const entries = (table: unknown): [string, Record<string, unknown>][] =>
  table && typeof table === 'object' && !Array.isArray(table)
    ? Object.entries(table as Record<string, unknown>).filter(([n, e]) => !RESERVED_NAMES.has(n.toLowerCase()) && !!e && typeof e === 'object') as [string, Record<string, unknown>][]
    : [];

export interface DiscoverPaths { home?: string; codexHome?: string; xdgConfig?: string }

export function agentConfigFiles(p: DiscoverPaths = {}): Record<ExtensionAgent, string[]> {
  const home = p.home ?? agentsHome();
  const codexHome = p.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
  const xdg = p.xdgConfig ?? process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return {
    claude: [path.join(home, '.claude.json')],
    codex: [path.join(codexHome, 'config.toml')],
    opencode: [path.join(xdg, 'opencode', 'opencode.json'), path.join(xdg, 'opencode', 'opencode.jsonc')],
    // `agy mcp` keeps ~/.gemini/config/mcp_config.json (the Antigravity app links its own path to it).
    antigravity: [path.join(home, '.gemini', 'config', 'mcp_config.json')],
  };
}

export function discoverServers(p: DiscoverPaths = {}): Discovered[] {
  const files = agentConfigFiles(p);
  const out: Discovered[] = [];
  const push = (agent: ExtensionAgent, file: string, list: [string, Record<string, unknown>][], folder?: string) => {
    for (const [name, e] of list) {
      const server = fromConfigEntry(name, e);
      if (server) out.push({ agent, file, server, ...(folder ? { folder } : {}) });
    }
  };

  for (const file of files.claude) {
    const j = readJson(file);
    if (!j) continue;
    push('claude', file, entries(j.mcpServers));
    for (const [folder, proj] of Object.entries((j.projects ?? {}) as Record<string, any>)) push('claude', file, entries(proj?.mcpServers), folder);
  }
  for (const file of files.codex) {
    let doc: any = null;
    try { doc = require('smol-toml').parse(fs.readFileSync(file, 'utf8')); } catch { doc = null; }
    if (doc) push('codex', file, entries(doc.mcp_servers));
  }
  for (const file of files.opencode) {
    const j = readJson(file);
    if (j) push('opencode', file, entries(j.mcp));
  }
  for (const file of files.antigravity) {
    const j = readJson(file);
    if (j) push('antigravity', file, entries(j.mcpServers));
  }
  return out;
}

/** The same server configured in several agents counts once (same command+args or same URL); agents are merged. */
export function groupDiscovered(found: Discovered[]): { server: ParsedServer; agents: ExtensionAgent[]; folders: string[] }[] {
  const key = (s: ParsedServer) => s.transport === 'http' ? `http ${s.url}` : `stdio ${s.command} ${(s.args ?? []).join(' ')}`;
  const groups = new Map<string, { server: ParsedServer; agents: ExtensionAgent[]; folders: string[] }>();
  for (const d of found) {
    const k = key(d.server);
    const g = groups.get(k) ?? { server: d.server, agents: [], folders: [] };
    if (!g.agents.includes(d.agent)) g.agents.push(d.agent);
    if (d.folder && !g.folders.includes(d.folder)) g.folders.push(d.folder);
    groups.set(k, g);
  }
  return [...groups.values()];
}

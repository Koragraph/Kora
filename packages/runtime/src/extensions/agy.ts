// Antigravity has no per-run MCP flag: `agy` reads only its own ~/.gemini/config/mcp_config.json. So the servers the
// user enables for Antigravity are kept in that file, and Kora remembers the names it wrote (<KORA_HOME>/extensions/
// agy-managed.json) so it only ever updates or removes its own entries. A same-named entry the user made themselves is
// left alone. Folder scoping cannot be expressed there: an enabled server applies to every Antigravity session.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { writeFileAtomic } from '../util/atomic-write';
import { agentsHome } from './model';
import { stripJsonComments } from './parse';
import { cachedSecret, extensionsDir, loadExtensions } from './store';
import { isSkipped, resolveServer, type ResolvedServer } from './wire';

export const agyConfigFile = (home = agentsHome()) => path.join(home, '.gemini', 'config', 'mcp_config.json');
const managedFile = (kh: string) => path.join(extensionsDir(kh), 'agy-managed.json');

function readJson(file: string): any {
  try { const raw = fs.readFileSync(file, 'utf8'); return raw.trim() ? JSON.parse(stripJsonComments(raw)) : {}; } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON; fix it before Kora can add servers there`);
  }
}

function entryFor(r: ResolvedServer, exec: { command: string; args: string[] } | null): Record<string, unknown> | null {
  if (r.transport === 'http') return { serverUrl: r.url, ...(r.headers ? { headers: r.headers } : {}) };
  if (r.secretKeys.length) return exec ? { command: exec.command, args: [...exec.args, 'ext', 'exec', r.name] } : null;
  return { command: r.command, args: r.args ?? [], ...(r.env ? { env: r.env } : {}) };
}

export interface AgySyncResult { file: string; written: string[]; removed: string[]; conflicts: string[]; skipped: string[] }

/** Bring Antigravity's file in line with the enabled servers. Safe to call any time; a no-op without Antigravity. */
export function syncAntigravity(opts: { home?: string; koraHomeDir?: string; exec?: { command: string; args: string[] } | null } = {}): AgySyncResult {
  const home = opts.home ?? agentsHome();
  const kh = opts.koraHomeDir ?? koraHome();
  const file = agyConfigFile(home);
  const result: AgySyncResult = { file, written: [], removed: [], conflicts: [], skipped: [] };
  const installed = fs.existsSync(path.join(home, '.gemini'));
  let managed: string[] = [];
  try { managed = JSON.parse(fs.readFileSync(managedFile(kh), 'utf8')); } catch { managed = []; }
  if (!installed && managed.length === 0) return result;

  const wanted = new Map<string, Record<string, unknown>>();
  for (const s of loadExtensions(kh).mcpServers) {
    if (!s.enabled || !s.agents.includes('antigravity')) continue;
    const r = resolveServer(s, cachedSecret);
    if (isSkipped(r)) { result.skipped.push(s.name); continue; }
    const e = entryFor(r, opts.exec === undefined ? null : opts.exec);
    if (e) wanted.set(s.name, e); else result.skipped.push(s.name);
  }

  const cfg = readJson(file);
  const servers: Record<string, unknown> = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  let changed = false;
  for (const name of managed) {
    if (!wanted.has(name) && name in servers) { delete servers[name]; result.removed.push(name); changed = true; }
  }
  const nowManaged: string[] = [];
  for (const [name, entry] of wanted) {
    if (name in servers && !managed.includes(name)) { result.conflicts.push(name); continue; }
    if (JSON.stringify(servers[name]) !== JSON.stringify(entry)) { servers[name] = entry; result.written.push(name); changed = true; }
    nowManaged.push(name);
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify({ ...cfg, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(managedFile(kh)), { recursive: true });
  writeFileAtomic(managedFile(kh), `${JSON.stringify(nowManaged)}\n`, { mode: 0o600 });
  return result;
}

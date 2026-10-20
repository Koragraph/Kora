// The one place drivers, worker panes, the CLI and the settings page go through for extensions.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { catalogEntry, CATALOG } from './catalog';
import { discoverServers, groupDiscovered } from './discover';
import { testServer, type HealthResult } from './health';
import { appliesTo, isSecretRef, type ExtensionAgent, type McpServer, type Value } from './model';
import { parseServerInput, type ParseResult } from './parse';
import {
  approveProjectServer, cachedSecret, forgetSecrets, loadExtensions, loadProjectServers, PROJECT_FILE, projectFingerprint, projectSecretId,
  projectSecretLabels, removeServer, saveProjectSecret, saveSecret, setServerEnabled, upsertServer, warmSecrets,
} from './store';
import { isSkipped, resolveServer, type ResolvedServer, type Skipped } from './wire';

export * from './model';
export { CATALOG } from './catalog';
export { acpServers, claudeServers, codexWiring, withOpencodeServers, type ResolvedServer } from './wire';
export { installSkills, removeSkill, setSkillEnabled, skillLinks, agentSkillDirs } from './skills';

export interface SessionContext {
  cwd: string;
  /** `worker`: a worker pane (only servers marked for workers). */
  lane: 'chat' | 'worker';
  /** The folder is trusted: its .kora/extensions.json may add servers. */
  trusted: boolean;
}

/** The nearest .kora/extensions.json at or above cwd, stopping at the repository root. */
function projectRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, PROJECT_FILE))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Enabled servers for this agent and session, user entries before (and over) same-named project entries. */
export function configuredServers(agent: ExtensionAgent, ctx: SessionContext, home = koraHome()): McpServer[] {
  const x = loadExtensions(home);
  const user = x.mcpServers;
  const root = ctx.trusted ? projectRoot(ctx.cwd) : null;
  const approved = new Set(x.approvedProjectServers);
  const rawProject = root ? loadProjectServers(root, { raw: true }) : [];
  const mapped = root ? loadProjectServers(root) : [];
  const project = mapped.filter((p, i) => approved.has(projectFingerprint(root!, rawProject[i]!)) && !user.some((u) => u.name.toLowerCase() === p.name.toLowerCase()));
  return [...user, ...project].filter((s) =>
    s.enabled && s.agents.includes(agent) && (ctx.lane === 'chat' || s.workers) && appliesTo(s, ctx.cwd));
}

/** Resolved (secrets filled) servers for a launch. Never throws: a broken extension must not stop an agent starting. */
export function serversFor(agent: ExtensionAgent, ctx: SessionContext): { servers: ResolvedServer[]; skipped: Skipped[] } {
  const servers: ResolvedServer[] = [];
  const skipped: Skipped[] = [];
  try {
    for (const s of configuredServers(agent, ctx)) {
      const r = resolveServer(s, cachedSecret);
      if (isSkipped(r)) skipped.push(r); else servers.push(r);
    }
  } catch { /* unreadable store: no extensions this launch */ }
  return { servers, skipped };
}

/** Read every referenced secret into memory (daemon start, after edits). */
export async function warmExtensionSecrets(home = koraHome()): Promise<void> {
  try { await warmSecrets(loadExtensions(home).mcpServers); } catch { /* keychain unavailable: servers with secrets are skipped */ }
}

/** `kora ext exec <name>`: how a Codex stdio server with secrets starts (values read here, never on argv). */
export function execBridge(): { command: string; args: string[] } | null {
  try {
    const { KORA_BIN, NODE_BIN } = require('../graph/embedded') as typeof import('../graph/embedded');
    return fs.existsSync(KORA_BIN) ? { command: NODE_BIN, args: [KORA_BIN] } : null;
  } catch { return null; }
}

// ---- edits (CLI and settings page) ------------------------------------------------------------------------------------

export interface SaveInput {
  server: Partial<McpServer> & { name: string };
  /** Values to store in the keychain: `env:KEY` / `header:Name` → value. Replaces the literal in the server. */
  secrets?: Record<string, string>;
}

/** Save a server, moving the given values into the keychain first. Returns the stored definition. */
export async function saveServer(input: SaveInput, home = koraHome()): Promise<McpServer> {
  const s = { ...input.server, env: { ...(input.server.env ?? {}) }, headers: { ...(input.server.headers ?? {}) } };
  for (const [slot, value] of Object.entries(input.secrets ?? {})) {
    const [kind, ...rest] = slot.split(':');
    const key = rest.join(':');
    if (!key || !value) continue;
    const ref = await saveSecret(s.name, `${kind}:${key}`, value);
    if (kind === 'env') s.env[key] = ref; else if (kind === 'header') s.headers[key] = ref;
  }
  const previous = loadExtensions(home).mcpServers.find((e) => e.name.toLowerCase() === s.name.toLowerCase());
  const saved = upsertServer(s, home);
  afterChange(home);
  // Secrets the new definition no longer references are deleted from the keychain.
  if (previous) {
    const still = new Set([...Object.values(saved.env ?? {}), ...Object.values(saved.headers ?? {})].filter(isSecretRef).map((v) => v.secret));
    const gone = { ...previous, env: filterRefs(previous.env, still), headers: filterRefs(previous.headers, still) };
    await forgetSecrets(gone);
  }
  return saved;
}

function filterRefs(rec: Record<string, Value> | undefined, keep: Set<string>): Record<string, Value> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => isSecretRef(v) && !keep.has(v.secret)));
}

export async function deleteServer(name: string, home = koraHome()): Promise<boolean> {
  const s = loadExtensions(home).mcpServers.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!s) return false;
  await forgetSecrets(s);
  const removed = removeServer(name, home);
  afterChange(home);
  return removed;
}

export function enableServer(name: string, enabled: boolean, home = koraHome()): McpServer {
  const s = setServerEnabled(name, enabled, home);
  afterChange(home);
  return s;
}

export { loadExtensions };

/** Agents that cannot take servers per launch get them in their own config file (Antigravity today). */
export function afterChange(home = koraHome()): void {
  try {
    const { syncAntigravity } = require('./agy') as typeof import('./agy');
    const r = syncAntigravity({ koraHomeDir: home, exec: execBridge() });
    if (r.conflicts.length) require('../server/log').log(`extensions: Antigravity already has its own ${r.conflicts.join(', ')}; Kora left them alone`);
  } catch (e: any) { try { require('../server/log').log(`extensions: Antigravity config not updated: ${e?.message ?? e}`); } catch { /* advisory */ } }
}

export function parseInput(text: string, name?: string): ParseResult { return parseServerInput(text, name); }

/** A catalog entry with the user's answers → a SaveInput. */
export function fromCatalog(id: string, answers: Record<string, string>, extra: Partial<McpServer> = {}): SaveInput {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`No catalog entry "${id}".`);
  const server: Partial<McpServer> & { name: string } = { ...entry.server, ...extra, name: extra.name ?? entry.server.name, source: `catalog:${id}` };
  const args = [...(entry.server.args ?? [])];
  const env: Record<string, Value> = {};
  const headers: Record<string, Value> = {};
  const secrets: Record<string, string> = {};
  for (const p of entry.params) {
    const v = (answers[p.key] ?? '').trim();
    if (!v) { if (p.required) throw new Error(`${entry.title} needs: ${p.label}.`); continue; }
    const value = p.template ? p.template.replace('{value}', v) : v;
    if (p.kind === 'arg') args.push(...(p.key.startsWith('--') ? [`${p.key}=${value}`] : [value.replace(/^~(?=\/)/, require('node:os').homedir())]));
    else if (p.kind === 'env') { if (p.secret) secrets[`env:${p.key}`] = value; else env[p.key] = value; }
    else { if (p.secret) secrets[`header:${p.key}`] = value; else headers[p.key] = value; }
  }
  if (args.length) server.args = args;
  if (Object.keys(env).length) server.env = env;
  if (Object.keys(headers).length) server.headers = headers;
  return { server, secrets };
}

export function catalog() { return CATALOG; }

/** Servers already configured in the agents' own files, minus the ones Kora already has. */
export function discover(home = koraHome()) {
  const have = new Set(loadExtensions(home).mcpServers.map((s) => s.name.toLowerCase()));
  return groupDiscovered(discoverServers()).map((g) => ({ ...g, alreadyAdded: have.has(g.server.name.toLowerCase()) }));
}

/** Test a stored server (by name) or a draft definition. */
export async function test(target: string | (Partial<McpServer> & { name: string }), opts: { cwd?: string; secrets?: Record<string, string> } = {}): Promise<HealthResult> {
  const s = typeof target === 'string' ? loadExtensions().mcpServers.find((e) => e.name.toLowerCase() === target.toLowerCase()) : target;
  if (!s) return { ok: false, ms: 0, tools: [], error: `No extension named "${String(target)}".` };
  if (typeof target === 'string') await warmSecrets([s as McpServer]);
  const draft = { ...(s as McpServer), env: { ...(s.env ?? {}) }, headers: { ...(s.headers ?? {}) } };
  for (const [slot, value] of Object.entries(opts.secrets ?? {})) {
    const [kind, ...rest] = slot.split(':');
    if (kind === 'env') draft.env[rest.join(':')] = value; else if (kind === 'header') draft.headers[rest.join(':')] = value;
  }
  const r = resolveServer(draft, cachedSecret);
  if (isSkipped(r)) return { ok: false, ms: 0, tools: [], error: r.reason };
  return testServer(r, opts.cwd ? { cwd: opts.cwd } : {});
}

/**
 * The servers one chat-driver session gets (chat thread or worker pane). Blob sessions have their own tools and get
 * none. Logs what was skipped and why, once per launch.
 */
export function sessionServers(agent: ExtensionAgent, input: { cwd: string; isWorker?: boolean; threadId?: string }, trusted: boolean): ResolvedServer[] {
  try {
    const { isBlobsCwd } = require('../blobs/home') as typeof import('../blobs/home');
    if (isBlobsCwd(input.cwd)) return [];
  } catch { /* no blobs module: plain session */ }
  const { servers, skipped } = serversFor(agent, { cwd: input.cwd, lane: input.isWorker ? 'worker' : 'chat', trusted });
  if (skipped.length) {
    try { require('../server/log').log(`extensions ${input.threadId ?? ''}: skipped ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`); } catch { /* logging is advisory */ }
  }
  return servers;
}

function trustedDefault(cwd: string, check?: (cwd: string) => boolean): boolean {
  try { return check ? check(cwd) : (require('../trust/store') as typeof import('../trust/store')).isFolderTrusted(cwd); } catch { return false; }
}

/** `-c mcp_servers.*` args and env for one `codex exec` turn (chat thread or worker). */
export function codexSessionWiring(input: { cwd: string; isWorker?: boolean; threadId?: string }, check?: (cwd: string) => boolean): { args: string[]; env: Record<string, string> } {
  try {
    const { codexWiring: wire } = require('./wire') as typeof import('./wire');
    return wire(sessionServers('codex', input, trustedDefault(input.cwd, check)), execBridge());
  } catch { return { args: [], env: {} }; }
}

/** OPENCODE_CONFIG_CONTENT with the session's extension servers merged in. */
export function opencodeSessionConfig(content: string | undefined, input: { cwd: string; isWorker?: boolean; threadId?: string }, check?: (cwd: string) => boolean): string | undefined {
  try {
    const { withOpencodeServers: merge } = require('./wire') as typeof import('./wire');
    return merge(content, sessionServers('opencode', input, trustedDefault(input.cwd, check)));
  } catch { return content; }
}

/** A repo's shared servers with their approval state (Settings › Extensions › "This project wants…"). */
export function projectServers(cwd: string, home = koraHome()): { root: string | null; servers: { server: McpServer; approved: boolean; secretLabels: string[]; missingSecrets: string[] }[] } {
  const root = projectRoot(cwd);
  if (!root) return { root: null, servers: [] };
  const approved = new Set(loadExtensions(home).approvedProjectServers);
  return {
    root,
    servers: loadProjectServers(root, { raw: true }).map((server) => {
      const secretLabels = projectSecretLabels(server);
      return { server, approved: approved.has(projectFingerprint(root, server)), secretLabels, missingSecrets: secretLabels.filter((l) => cachedSecret(projectSecretId(l)) === null) };
    }),
  };
}

export { saveProjectSecret };

export function setProjectServerApproved(cwd: string, name: string, approved: boolean, home = koraHome()): void {
  const root = projectRoot(cwd);
  const s = root ? loadProjectServers(root, { raw: true }).find((p) => p.name === name) : undefined;
  if (!root || !s) throw new Error(`No project server "${name}" for ${cwd}.`);
  approveProjectServer(root, s, approved, home);
}

/**
 * A Claude CLI pane: one `--mcp-config` file (0600, per pane) holding Kora's own servers from `baseFile` plus the
 * pane's extension servers. Returns the file to pass, or null when there is nothing to add.
 */
export function claudePaneMcpFile(input: { cwd: string; paneId: string }, baseFile: string | null): string | null {
  try {
    const { claudeServers: shape } = require('./wire') as typeof import('./wire');
    const servers = sessionServers('claude', { cwd: input.cwd, isWorker: true, threadId: input.paneId }, trustedDefault(input.cwd));
    if (!servers.length) return null;
    let base: { mcpServers?: Record<string, unknown> } = {};
    if (baseFile) { try { base = JSON.parse(fs.readFileSync(baseFile, 'utf8')); } catch { base = {}; } }
    const merged = { ...base, mcpServers: { ...shape(servers), ...(base.mcpServers ?? {}) } };
    const dir = path.join(koraHome(), 'mcp', 'panes');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${input.paneId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    return file;
  } catch { return null; }
}

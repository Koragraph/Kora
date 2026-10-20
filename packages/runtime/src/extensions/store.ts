// The extensions file (<KORA_HOME>/extensions.json, 0600) and a repo's shared one (<root>/.kora/extensions.json).
// Reads never throw: a missing or broken file is an empty one (a broken user file is kept aside as .broken-<time> so
// the next save cannot silently drop what the user wrote).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { writeFileAtomic } from '../util/atomic-write';
import { emptyExtensions, isSecretRef, normalizeServer, serverProblems, type ExtensionsFile, type McpServer, type Skill, type Value } from './model';
import { defaultSecretStore, type SecretStore } from '../blobs/apps/secrets';

export const extensionsFile = (home = koraHome()) => path.join(home, 'extensions.json');
export const extensionsDir = (home = koraHome()) => path.join(home, 'extensions');
export const PROJECT_FILE = path.join('.kora', 'extensions.json');

function parseFile(raw: string): ExtensionsFile {
  const j = JSON.parse(raw);
  const out = emptyExtensions();
  for (const s of Array.isArray(j?.mcpServers) ? j.mcpServers : []) {
    if (s && typeof s.name === 'string') out.mcpServers.push(normalizeServer(s));
  }
  for (const k of Array.isArray(j?.skills) ? j.skills : []) {
    if (k && typeof k.name === 'string' && typeof k.dir === 'string') {
      out.skills.push({
        name: k.name, description: typeof k.description === 'string' ? k.description : '', dir: k.dir,
        agents: Array.isArray(k.agents) ? k.agents : [], enabled: k.enabled !== false, ...(k.source ? { source: String(k.source) } : {}),
      });
    }
  }
  if (Array.isArray(j?.approvedProjectServers)) out.approvedProjectServers = j.approvedProjectServers.filter((x: unknown) => typeof x === 'string');
  return out;
}

/** The approval key of one project server: its folder and its exact definition. */
export function projectFingerprint(root: string, s: McpServer): string {
  const { source: _s, ...def } = s;
  return crypto.createHash('sha256').update(`${path.resolve(root)}\0${JSON.stringify(def)}`).digest('hex').slice(0, 32);
}

export function approveProjectServer(root: string, s: McpServer, approved: boolean, home = koraHome()): void {
  const x = loadExtensions(home);
  const fp = projectFingerprint(root, s);
  x.approvedProjectServers = approved ? [...new Set([...x.approvedProjectServers, fp])] : x.approvedProjectServers.filter((f) => f !== fp);
  saveExtensions(x, home);
}

export function loadExtensions(home = koraHome()): ExtensionsFile {
  const file = extensionsFile(home);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyExtensions(); }
  if (!raw.trim()) return emptyExtensions();
  try { return parseFile(raw); } catch {
    try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* keep going with an empty set */ }
    return emptyExtensions();
  }
}

export function saveExtensions(x: ExtensionsFile, home = koraHome()): void {
  fs.mkdirSync(home, { recursive: true });
  writeFileAtomic(extensionsFile(home), `${JSON.stringify(x, null, 2)}\n`, { mode: 0o600 });
}

/** Keychain id of a project secret label (`{ "secret": "team-db-url" }` in a repo's file): one per label per user. */
export function projectSecretId(label: string): string {
  return `ext-${crypto.createHash('sha256').update(`project\0${label}`).digest('hex').slice(0, 24)}`;
}

/** The labels a project server's secret refs use, as written in the repo's file. */
export function projectSecretLabels(s: McpServer): string[] {
  return [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})].filter(isSecretRef).map((v) => v.secret);
}

/**
 * A repo's shared servers. The file holds no secret values: a `{ "secret": "<label>" }` ref is a name this user fills in
 * once (Settings › Extensions, `kora ext secret set <label>`) and resolves from their own keychain. `raw` keeps the
 * labels as written (for the approval fingerprint and the settings page); the default form maps them to keychain ids.
 */
export function loadProjectServers(root: string, opts: { raw?: boolean } = {}): McpServer[] {
  try {
    const raw = fs.readFileSync(path.join(root, PROJECT_FILE), 'utf8');
    const servers = parseFile(raw).mcpServers.map((s) => ({ ...s, source: 'project' }));
    if (opts.raw) return servers;
    const map = (rec: Record<string, Value> | undefined) =>
      rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, isSecretRef(v) ? { secret: projectSecretId(v.secret) } : v])) : undefined;
    return servers.map((s) => ({ ...s, ...(s.env ? { env: map(s.env)! } : {}), ...(s.headers ? { headers: map(s.headers)! } : {}) }));
  } catch { return []; }
}

export async function saveProjectSecret(label: string, value: string): Promise<void> {
  const id = projectSecretId(label);
  await secretStore().set(id, value);
  cache.set(id, value);
}

/** Add or replace a server by name (case-insensitive). Throws with the user-facing problems when invalid. */
export function upsertServer(server: Partial<McpServer> & { name: string }, home = koraHome()): McpServer {
  const s = normalizeServer(server);
  const problems = serverProblems(s);
  if (problems.length) throw new Error(problems.join(' '));
  const x = loadExtensions(home);
  const i = x.mcpServers.findIndex((e) => e.name.toLowerCase() === s.name.toLowerCase());
  if (i >= 0) x.mcpServers[i] = s; else x.mcpServers.push(s);
  saveExtensions(x, home);
  return s;
}

export function removeServer(name: string, home = koraHome()): boolean {
  const x = loadExtensions(home);
  const before = x.mcpServers.length;
  x.mcpServers = x.mcpServers.filter((e) => e.name.toLowerCase() !== name.toLowerCase());
  if (x.mcpServers.length === before) return false;
  saveExtensions(x, home);
  return true;
}

export function setServerEnabled(name: string, enabled: boolean, home = koraHome()): McpServer {
  const x = loadExtensions(home);
  const s = x.mcpServers.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`No extension named "${name}".`);
  s.enabled = enabled;
  saveExtensions(x, home);
  return s;
}

export function upsertSkill(skill: Skill, home = koraHome()): void {
  const x = loadExtensions(home);
  x.skills = [...x.skills.filter((k) => k.name !== skill.name), skill];
  saveExtensions(x, home);
}

export function removeSkillEntry(name: string, home = koraHome()): Skill | null {
  const x = loadExtensions(home);
  const found = x.skills.find((k) => k.name === name) ?? null;
  if (!found) return null;
  x.skills = x.skills.filter((k) => k.name !== name);
  saveExtensions(x, home);
  return found;
}

// ---- secrets ---------------------------------------------------------------------------------------------------------

/** Keychain account name for one server's value (the keychain allows [a-z0-9-], 40 chars). */
export function secretId(server: string, key: string): string {
  return `ext-${crypto.createHash('sha256').update(`${server.toLowerCase()}\0${key}`).digest('hex').slice(0, 24)}`;
}

let store: SecretStore | null = null;
export function secretStore(): SecretStore {
  if (!store) store = defaultSecretStore(path.join(extensionsDir(), 'secrets'));
  return store;
}
let injected = false;
export function setSecretStoreForTests(s: SecretStore | null): void { store = s; injected = s !== null; cache.clear(); }

/** Secret values the daemon has read, so the per-launch wiring can stay synchronous. Refreshed by warmSecrets(). */
const cache = new Map<string, string>();

export async function saveSecret(server: string, key: string, value: string): Promise<{ secret: string }> {
  const id = secretId(server, key);
  await secretStore().set(id, value);
  cache.set(id, value);
  return { secret: id };
}

/** Read every secret the given servers reference into the cache. Missing ones stay missing (the server is skipped). */
export async function warmSecrets(servers: McpServer[]): Promise<void> {
  const ids = new Set<string>();
  for (const s of servers) for (const v of [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})]) if (isSecretRef(v)) ids.add(v.secret);
  await Promise.all([...ids].map(async (id) => {
    try { const v = await secretStore().get(id); if (v) cache.set(id, v); else cache.delete(id); } catch { /* unreadable: treated as missing */ }
  }));
}

/**
 * A secret for a launch: from memory, else read once synchronously (a value saved by `kora ext` in another process).
 * Only on a cache miss, so a launch pays at most one short keychain call per new value.
 */
export function cachedSecret(id: string): string | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  if (!/^ext-[0-9a-f]{24}$/.test(id)) return null;
  let value: string | null = null;
  try { value = fs.readFileSync(path.join(extensionsDir(), 'secrets', id), 'utf8').trim() || null; } catch { value = null; }
  if (value === null && !injected && process.platform === 'darwin' && process.env.KORA_APPS_VAULT !== 'file') {
    try {
      const { keychainService } = require('../blobs/apps/secrets') as typeof import('../blobs/apps/secrets');
      const r = require('node:child_process').spawnSync('/usr/bin/security', ['find-generic-password', '-s', keychainService(), '-a', id, '-w'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) value = String(r.stdout).trim() || null;
    } catch { value = null; }
  }
  if (value !== null) cache.set(id, value);
  return value;
}

export async function forgetSecrets(s: McpServer): Promise<void> {
  for (const v of [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})]) {
    if (isSecretRef(v)) { cache.delete(v.secret); await secretStore().delete(v.secret).catch(() => undefined); }
  }
}

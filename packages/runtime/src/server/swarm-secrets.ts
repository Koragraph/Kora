// Swarm provider keys: a 0600 file ~/.kora/secrets/swarm.json (dir 0700, atomic write). Never the Keychain in v1
// (PLAN D-g; also `security add-generic-password -w <key>` puts the key in argv, readable by `ps`, and is a
// synchronous spawn on the daemon's event loop). Keys leave the daemon only as the pane env of that provider's
// worker; everything else sees keyHint().
//
// Effective key per provider, first hit wins (swarmKeySource names which):
//   1. 'kora'          ~/.kora/secrets/swarm.json  {"keys": {"openrouter": "…"}}   (the only source Kora writes)
//   2. 'env'           OPENCODE_API_KEY (Zen) · OPENROUTER_API_KEY · CEREBRAS_API_KEY  (read-only; env names from models.dev)
//   3. 'opencode-auth' opencode's own ~/.local/share/opencode/auth.json {"<id>": {"type":"api","key":"…"}} (read-only)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { koraHome } from '../protocol/types';
import type { SwarmKeySource, SwarmProviderId } from '../protocol/types';

/** The env var opencode reads per provider (models.dev `env`, checked 2026-09-24: opencode → OPENCODE_API_KEY). */
const ENV_VAR: Record<SwarmProviderId, string> = { zen: 'OPENCODE_API_KEY', openrouter: 'OPENROUTER_API_KEY', cerebras: 'CEREBRAS_API_KEY' };
/** opencode's provider id for each swarm provider (its auth.json keys). */
const OPENCODE_PROVIDER: Record<SwarmProviderId, string> = { zen: 'opencode', openrouter: 'openrouter', cerebras: 'cerebras' };
const PROVIDERS: readonly SwarmProviderId[] = ['zen', 'openrouter', 'cerebras'];

const secretsDir = () => path.join(koraHome(), 'secrets');
const secretsFile = () => path.join(secretsDir(), 'swarm.json');
function opencodeAuthFile(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'opencode', 'auth.json');
}

function assertProvider(p: SwarmProviderId): void {
  if (!PROVIDERS.includes(p)) throw new Error(`unknown swarm provider: ${String(p)}`);
}

/** Read Kora's key file; repairs a too-open file or dir mode on the way (someone copied it in with 0644 / made the dir 0755). */
function readKoraKeys(): Partial<Record<SwarmProviderId, string>> {
  const file = secretsFile();
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try { if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  try { const d = secretsDir(); if ((fs.statSync(d).mode & 0o077) !== 0) fs.chmodSync(d, 0o700); } catch { /* best effort */ }
  try {
    const j = JSON.parse(raw);
    const keys = j && typeof j === 'object' && j.keys && typeof j.keys === 'object' ? j.keys : {};
    const out: Partial<Record<SwarmProviderId, string>> = {};
    for (const p of PROVIDERS) if (typeof keys[p] === 'string' && keys[p]) out[p] = keys[p];
    return out;
  } catch { return {}; }
}

/** Atomic write: temp file created 0600 in the same dir (0700), fsync, rename over the target. */
function writeKoraKeys(keys: Partial<Record<SwarmProviderId, string>>): void {
  const dir = secretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const tmp = path.join(dir, `.swarm.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ version: 1, keys }, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, secretsFile()); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

function envKey(p: SwarmProviderId): string | null {
  const v = process.env[ENV_VAR[p]];
  return v && v.trim() ? v.trim() : null;
}

function opencodeAuthKey(p: SwarmProviderId): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(opencodeAuthFile(), 'utf8'));
    const e = j?.[OPENCODE_PROVIDER[p]];
    return e && e.type === 'api' && typeof e.key === 'string' && e.key ? e.key : null;
  } catch { return null; }
}

function effective(p: SwarmProviderId): { key: string; source: SwarmKeySource } | null {
  assertProvider(p);
  const kora = readKoraKeys()[p];
  if (kora) return { key: kora, source: 'kora' };
  const env = envKey(p);
  if (env) return { key: env, source: 'env' };
  const auth = opencodeAuthKey(p);
  if (auth) return { key: auth, source: 'opencode-auth' };
  return null;
}

/** The effective key for `provider` (Kora's file, else env, else opencode's auth.json); null when none. */
export function getSwarmKey(provider: SwarmProviderId): string | null {
  return effective(provider)?.key ?? null;
}

/** Store a key in Kora's file (the only writable source). Rejects blanks, whitespace inside and absurd lengths. */
export function setSwarmKey(provider: SwarmProviderId, apiKey: string): void {
  assertProvider(provider);
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('the API key is empty');
  if (/\s/.test(key)) throw new Error('the API key contains whitespace — paste only the key');
  if (key.length > 512) throw new Error('the API key is too long');
  const keys = readKoraKeys();
  keys[provider] = key;
  writeKoraKeys(keys);
}

/** Remove Kora's stored key. An env or opencode auth.json key (read-only sources) stays effective. */
export function clearSwarmKey(provider: SwarmProviderId): void {
  assertProvider(provider);
  const keys = readKoraKeys();
  if (!(provider in keys)) return;
  delete keys[provider];
  writeKoraKeys(keys);
}

/** Where the effective key comes from: Kora's file, the environment, or opencode's own auth.json. */
export function swarmKeySource(provider: SwarmProviderId): SwarmKeySource | null {
  return effective(provider)?.source ?? null;
}

/** A masked hint of a key (`sk-or-…a1b2`) — the only form a key ever takes on the wire. */
export function keyHint(apiKey: string): string {
  const k = String(apiKey ?? '').trim();
  if (k.length < 12) return '…';
  const prefix = /^([a-z]{1,4}-(?:[a-z]{1,4}-)?)/i.exec(k)?.[1] ?? '';
  // Never reveal more than the vendor prefix plus the last 4, and never more than a third of the key.
  const tail = k.slice(-4);
  return prefix.length + tail.length <= Math.floor(k.length / 3) + 4 ? `${prefix}…${tail}` : `…${tail}`;
}

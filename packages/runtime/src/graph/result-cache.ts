// Per-repo graph result cache (RESEARCH.md item 8). Inside a session, an identical graph query (tool, normalised
// args, repo root) against an unchanged index returns a one-line pointer to the earlier result instead of the
// result again: the result already sits in context and is re-billed on every turn; pasting it twice doubles that.
// Keyed by the repo's last ingest timestamp (the graph generation) and the session, so a re-index or another
// session never sees a stale pointer. Errors are never cached. File: ~/.kora/cache/graph-<sha(repoRoot)>.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from './embedded';

export interface CacheEntry { key: string; ts: number; generation: string; head3: string[]; calls: number; turn: number | null; session: string }
export interface CacheFile { entries: CacheEntry[] }

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function cacheDir(): string { return path.join(koraHome(), 'cache'); }
export function cachePath(repoRoot: string): string { return path.join(cacheDir(), `graph-${sha(repoRoot)}.json`); }

/** Stable JSON: sorted keys, undefined/null dropped, strings trimmed + whitespace-collapsed. */
export function normalizeArgs(args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as any).sort()) { const x = norm((v as any)[k]); if (x !== undefined && x !== null) o[k] = x; } return o; }
    if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
    return v;
  };
  return JSON.stringify(norm(args || {}));
}
export function cacheKey(tool: string, args: Record<string, unknown>, repoRoot: string, session: string): string {
  return sha(`${tool}\n${normalizeArgs(args)}\n${repoRoot}\n${session}`);
}

/** The session this process is running in, or null outside any pane/session (then the cache is bypassed). */
export function currentSession(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.KORA_SESSION_ID || env.KORA_PANE_ID || null;
}

export function loadCache(repoRoot: string): CacheFile {
  try { const v = JSON.parse(fs.readFileSync(cachePath(repoRoot), 'utf8')); if (v && Array.isArray(v.entries)) return v; } catch { /* empty */ }
  return { entries: [] };
}
export function saveCache(repoRoot: string, c: CacheFile): void {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cachePath(repoRoot), JSON.stringify(c)); } catch { /* best effort */ }
}

export interface CacheLookup { repoRoot: string; generation: string; tool: string; args: Record<string, unknown>; session: string; now?: number }
/** A hit for the same key in the same generation, or null. Bumps `calls` on a hit. */
export function lookup(q: CacheLookup): CacheEntry | null {
  const now = q.now ?? Date.now();
  const c = loadCache(q.repoRoot);
  const key = cacheKey(q.tool, q.args, q.repoRoot, q.session);
  const hit = c.entries.find((e) => e.key === key && e.generation === q.generation && now - e.ts < CACHE_TTL_MS);
  if (!hit) return null;
  hit.calls++;
  saveCache(q.repoRoot, c);
  return hit;
}
/** Record a successful result. Entries from other generations or older than the TTL are dropped on write. */
export function remember(q: CacheLookup & { text: string; turn?: number | null }): CacheEntry {
  const now = q.now ?? Date.now();
  const c = loadCache(q.repoRoot);
  c.entries = c.entries.filter((e) => e.generation === q.generation && now - e.ts < CACHE_TTL_MS);
  const key = cacheKey(q.tool, q.args, q.repoRoot, q.session);
  const head3 = q.text.split('\n').filter((l) => l.trim()).slice(0, 3);
  const entry: CacheEntry = { key, ts: now, generation: q.generation, head3, calls: 1, turn: q.turn ?? null, session: q.session };
  c.entries = c.entries.filter((e) => e.key !== key); c.entries.push(entry);
  if (c.entries.length > 500) c.entries = c.entries.slice(-500);
  saveCache(q.repoRoot, c);
  return entry;
}

export function pointerText(e: CacheEntry): string {
  const where = e.turn != null ? `see turn ${e.turn}` : 'see the earlier result above';
  return [`(same as an earlier call this session — result unchanged; ${where})`, ...e.head3].join('\n');
}

/** Best-effort "turn N" for pointers: the prompt hook's per-session counter when the session id is known. */
export function currentTurn(env: NodeJS.ProcessEnv = process.env): number | null {
  const sid = env.KORA_SESSION_ID; if (!sid) return null;
  try {
    const f = path.join(require('../util/safe-path').privateTmpDir() as string, `kora-nudge-${`${sid}-main`.replace(/[^a-zA-Z0-9._-]/g, '_')}-turn`);
    const n = parseInt(fs.readFileSync(f, 'utf8'), 10); return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

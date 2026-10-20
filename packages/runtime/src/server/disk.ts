// Low-disk guard. A worker worktree is a full checkout (plus whatever its build drops into it) and an ingest grows
// ~/.koragraph/graph.db; on a nearly full disk either one fails half-way and leaves litter that makes the next one fail
// sooner. Below the threshold Kora refuses to START that work, with a message that says why and what to do; work that
// is already running is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MIN_FREE_GB = 2;
/** The threshold in bytes: KORA_MIN_FREE_GB (a number, 0 turns the guard off), else 2 GB. */
export function minFreeBytes(): number {
  const raw = process.env.KORA_MIN_FREE_GB;
  const gb = raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : DEFAULT_MIN_FREE_GB;
  return Math.round(gb * 1024 ** 3);
}

// statfs is a single syscall, but spawn bursts ask for the same volume many times a second: 5 s is plenty fresh.
const memo = new Map<string, { at: number; free: number | null }>();
/** Bytes available to this user on the volume holding `p` (its nearest existing ancestor); null when unknown. */
export function freeBytes(p: string): number | null {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const hit = memo.get(dir);
  if (hit && Date.now() - hit.at < 5000) return hit.free;
  let free: number | null = null;
  try { const s = fs.statfsSync(dir); free = Number(s.bavail) * Number(s.bsize); } catch { free = null; }
  if (memo.size > 256) memo.clear();
  memo.set(dir, { at: Date.now(), free });
  return free;
}
/** Test seam: forget the cached readings. */
export function resetDiskMemo(): void { memo.clear(); }

export class LowDiskError extends Error {
  readonly code = 'low-disk';
  constructor(readonly what: string, readonly dir: string, readonly free: number, readonly min: number) {
    super(`Kora did not start ${what}: only ${fmtBytes(free)} free on the disk holding ${tildify(dir)} (it keeps at least ${fmtBytes(min)} free). `
      + 'Free some space (old worktrees: `kora worktree sweep`), or lower the limit with KORA_MIN_FREE_GB.');
    this.name = 'LowDiskError';
  }
}

/** Throws LowDiskError when the volume holding `dir` is below the threshold. Unknown free space never blocks. */
/** `minBytes` overrides the configured floor — for work that needs far less than a checkout (a Chat worker's scratch folder). */
export function assertDiskRoom(what: string, dir: string, minBytes?: number): void {
  const min = minBytes ?? minFreeBytes();
  if (min <= 0) return;
  const free = freeBytes(dir);
  if (free != null && free < min) throw new LowDiskError(what, dir, free, min);
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
function tildify(p: string): string { const h = os.homedir(); return p === h || p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p; }

/** Where the graph store lives (the volume an ingest grows). */
export function graphStoreDir(): string {
  if (process.env.KORAGRAPH_DB) return path.dirname(process.env.KORAGRAPH_DB);
  return process.env.KORAGRAPH_HOME || path.join(os.homedir(), '.koragraph');
}

/**
 * The graph service with ingests refused below the threshold: `ingest` throws LowDiskError, `ingestWithProgress`
 * returns `{ ok: false, error }` (its callers already degrade to "not indexed" on a failed index). Queries pass through.
 */
export function withDiskGuard<G extends { ingest: (...a: any[]) => Promise<any>; ingestWithProgress?: (...a: any[]) => Promise<any> }>(g: G): G {
  const out: G = { ...g };
  out.ingest = (async (...a: any[]) => { assertDiskRoom('indexing', graphStoreDir()); return g.ingest(...a); }) as G['ingest'];
  if (g.ingestWithProgress) {
    const inner = g.ingestWithProgress.bind(g);
    out.ingestWithProgress = (async (...a: any[]) => {
      try { assertDiskRoom('indexing', graphStoreDir()); } catch (e: any) { return { ok: false, error: e.message, ms: 0 }; }
      return inner(...a);
    }) as NonNullable<G['ingestWithProgress']>;
  }
  return out;
}

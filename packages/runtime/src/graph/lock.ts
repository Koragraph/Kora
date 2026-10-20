// Cross-process ingest lock. Several agents, several git hooks and the server's auto-index can all decide to
// re-index the same repo at once; SQLite's busy_timeout (2s) is not long enough to serialise a full ingest,
// so the losers would fail with SQLITE_BUSY — and since every ingest path swallows errors, fail silently.
// One lock file per repository root under ~/.kora/locks; stale if the recorded pid is gone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { koraHome } from './embedded';

function lockPath(root: string): string {
  const dir = path.join(koraHome(), 'locks'); fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)}-${path.basename(root)}.lock`);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } }

export interface Lock { release(): void; path: string }
/** Try once. Returns null when another live process holds it. */
export function tryLock(root: string): Lock | null {
  const file = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, root, at: Date.now() })); fs.closeSync(fd);
      return { path: file, release: () => { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === process.pid) fs.rmSync(file); } catch { /* gone */ } } };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let cur: any = null; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* corrupt → stale */ }
      // An empty/unparsable file is a holder between open('wx') and its write: stale only once it has sat a while.
      let young = false; try { young = Date.now() - fs.statSync(file).mtimeMs < 5000; } catch { /* gone */ }
      const stale = cur ? (!alive(Number(cur.pid)) || Date.now() - Number(cur.at || 0) > 2 * 60 * 60 * 1000) : !young;
      if (!stale) return null;
      try { fs.rmSync(file); } catch { /* raced */ }
    }
  }
  return null;
}
/** Wait up to `maxMs` for the lock (poll). */
export async function waitLock(root: string, maxMs = 10 * 60 * 1000): Promise<Lock | null> {
  const t0 = Date.now();
  for (;;) {
    const l = tryLock(root); if (l) return l;
    if (Date.now() - t0 > maxMs) return null;
    await new Promise((r) => setTimeout(r, 750));
  }
}
export function lockHolder(root: string): { pid: number; at: number } | null {
  try { const cur = JSON.parse(fs.readFileSync(lockPath(root), 'utf8')); return alive(Number(cur.pid)) ? { pid: cur.pid, at: cur.at } : null; } catch { return null; }
}

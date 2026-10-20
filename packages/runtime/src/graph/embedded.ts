// Access to the vendored koragraph tree (kora/koragraph/src). Everything in kora that touches
// the graph or the memory layer goes through `kg()` so the path is resolved in exactly one place —
// and so the stdout→stderr redirect koragraph itself relies on is applied before any of its modules
// load (several services console.log unconditionally; stdout is JSON-RPC for `mcp` and the hook
// output channel for `hook`).
import { windowsSystemRoots, pathDepth } from '../util/os-roots';
import { koraHome as protocolKoraHome } from '../protocol/types';
import { ipcExists, isWindows } from '../util/ipc-path';
import { gitPath } from '../util/win-exec';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { withStoreMaintenance, type MaintenanceDeps } from './store-maintenance';

// dist/graph/embedded.js → ../../koragraph ; src/graph/embedded.ts → same relative shape.
export const KG_ROOT = path.resolve(__dirname, '..', '..', 'koragraph');
export const KORA_ROOT = path.resolve(__dirname, '..', '..');
export const KORA_BIN = process.env.KORA_BIN && fs.existsSync(process.env.KORA_BIN)
  ? process.env.KORA_BIN
  : path.join(KORA_ROOT, 'bin', 'kora.js');
export const NODE_BIN = process.execPath;

let redirected = false;
let filtered = false;
/** Quiet koragraph's per-pass stderr narration (summarised, not hidden) unless KORA_TRACE / --verbose. */
export function quietStderr(): void {
  if (filtered || process.env.KORA_TRACE || process.env.KORA_VERBOSE) return;
  filtered = true;
  try {
    const f = require(path.join(KG_ROOT, 'src', 'cli', 'stderr-filter.js'));
    // Swallow the per-line retriever/ingest detail entirely on the read path; a `kora graph` call is
    // a query, and a query that prints 40 lines of indexing statistics before its answer is unusable.
    f.install({ verbose: false, silenceMs: 0, summarised: [...f.INGEST_SUMMARISED].map((r: any) => ({ ...r, line: () => '' })), detail: [...f.INGEST_DETAIL, ...f.RETRIEVER_DETAIL, /^fatal: ambiguous argument 'HEAD'/, /^Use '--' to separate/, /^'git <command>/] });
  } catch { /* filter is a courtesy */ }
}
export function quietStdout(): void {
  if (redirected) return;
  redirected = true;
  quietStderr();
  console.log = (...a: any[]) => console.error(...a);
  console.info = (...a: any[]) => console.error(...a);
  console.debug = (...a: any[]) => console.error(...a);
  console.dir = ((...a: any[]) => console.error(...a)) as any;
}

/** require() a module from the embedded koragraph tree, e.g. kg('src/mcp/protocol.js'). */
export function kg<T = any>(rel: string): T {
  quietStdout();
  return require(path.join(KG_ROOT, rel)) as T;
}

export function graphDbPath(): string { return kg('src/practice/paths.js').graphDbPath(); }
export function practiceDbPath(): string { return kg('src/practice/paths.js').practiceDbPath(); }

export function koraHome(): string {
  return protocolKoraHome();
}

/**
 * Why `root` must never be indexed without an explicit `--force`, or null when it is a sensible project folder: the
 * filesystem root, the home dir or any ancestor of it (`/Users`), a path under two segments deep (`/tmp`, `/opt`), or a
 * macOS system / app-data tree (`/System`, `/Library`, `~/Library`, …).
 * Every ingest path refuses these — measured: `kora ingest / --no-wait` started walking the whole disk, and a chat
 * opened in ~ used to start a whole-home ingest. Same rule as the daemon's isSafeToAutoIndex and the chip's isSafeToIndex.
 */
export type UnsafeRootReason = 'filesystem root' | 'home folder' | 'parent of the home folder' | 'too shallow' | 'system folder' | 'temp or volume root';
/**
 * macOS system and app-data trees: never a project, often huge (found 2026-10-04: a project at /System/Library got the
 * chip's "Index anyway"). Kept in step with packages/ui-server graph.ts SYSTEM_ROOTS.
 */
export const SYSTEM_ROOTS: readonly string[] = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev', '/cores', '/Applications', '/opt/homebrew', '/var/db', '/private/var/db', '/var/root', '/private/var/root'];
export const HOME_SYSTEM_DIRS: readonly string[] = process.platform === 'win32' ? ['AppData', '$Recycle.Bin'] : ['Library', '.Trash'];
export { windowsSystemRoots, pathDepth } from '../util/os-roots';
export function underSystemRoot(root: string, home: string = os.homedir()): boolean {
  const win = process.platform === 'win32';
  const f = (s: string) => (win ? s.toLowerCase() : s);   // NTFS is case-insensitive
  const r = f(path.resolve(root));
  const roots = [...(win ? windowsSystemRoots() : SYSTEM_ROOTS), ...HOME_SYSTEM_DIRS.map((d) => path.join(path.resolve(home), d))].map(f);
  // Windows' temp folder lives under AppData; a project below it is as fine as one under macOS's /var/folders/…/T.
  const tmp = f(path.resolve(os.tmpdir()));
  if (win && r.startsWith(tmp + path.sep)) return false;
  return roots.some((s) => r === s || r.startsWith(s + path.sep));
}
/**
 * The temp and mount roots themselves (a project BELOW them is fine): `/private/tmp` is two segments deep, so the depth
 * rule let `kora ingest /private/tmp` (macOS's real /tmp) walk every scratch folder, and the leftover row then claimed
 * every non-git folder under it (pl3 S2-2). Compared on the path as given and its realpath.
 * Kept in step with packages/ui-server graph.ts tempOrVolumeRoot.
 */
export function tempOrVolumeRoot(root: string): boolean {
  // oxlint-disable-next-line kora/no-posix-only-paths -- macOS temp/volume roots; os.tmpdir() below covers Windows
  const exact = new Set(['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var', '/private/var', '/private', '/var/folders', '/private/var/folders', '/Volumes']);
  for (const t of [os.tmpdir()]) { exact.add(path.resolve(t)); try { exact.add(fs.realpathSync(t)); } catch { /* gone */ } }
  const forms = [path.resolve(root)]; try { forms.push(fs.realpathSync(root)); } catch { /* not there yet */ }
  return forms.some((r) => {
    if (exact.has(r)) return true;
    const seg = r.split(path.sep).filter(Boolean);
    if (seg[0] === 'Volumes' && seg.length === 2) return true; // a whole external disk
    const f = seg.indexOf('folders');
    // /var/folders/<xx>/<hash>[/T|/C|/X]: a per-user temp root, not a project
    return f >= 0 && (seg[0] === 'var' || (seg[0] === 'private' && seg[1] === 'var')) && seg.length - f - 1 <= 3;
  });
}
export function unsafeIndexRoot(root: string, home: string = os.homedir()): UnsafeRootReason | null {
  const r = path.resolve(root);
  if (r === path.parse(r).root) return 'filesystem root';
  const h = path.resolve(home);
  const same = (a: string, b: string) => { if (a === b) return true; try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };
  if (same(r, h)) return 'home folder';
  if ((h + path.sep).startsWith(r + path.sep)) return 'parent of the home folder';
  if (pathDepth(r) < 2) return 'too shallow';
  if (underSystemRoot(r, h)) return 'system folder';
  if (tempOrVolumeRoot(r)) return 'temp or volume root';
  return null;
}
export class UnsafeIndexRootError extends Error {
  code = 'unsafe_root';
  constructor(public root: string, public reason: UnsafeRootReason) {
    const what = { 'filesystem root': 'it is the filesystem root', 'home folder': 'it is your home folder', 'parent of the home folder': 'it is a parent of your home folder', 'too shallow': 'it is too shallow to be a project (a whole mount)', 'system folder': 'it is a macOS system or app-data folder, not a project', 'temp or volume root': 'it is a temp folder or a whole volume, not a project' }[reason];
    super(`Refusing to index ${root}: ${what}. Indexing it would walk everything under it (slow, gigabytes of graph). Index a project folder instead, or pass --force if you really mean it.`);
  }
}

/** SQLite's "this file is not a usable database" family: a garbage/truncated header or corrupt pages. */
export function isStoreCorruptError(e: unknown): boolean {
  const code = String((e as any)?.code || '');
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT') || /file is not a database|database disk image is malformed|malformed database schema/i.test(String((e as any)?.message || e));
}
/** Cheap open-time check of the graph store (no full integrity scan): null when usable or absent, else the error. */
export function storeDamage(dbFile: string = graphDbPath()): string | null {
  if (!fs.existsSync(dbFile)) return null;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try { db.pragma('busy_timeout = 2000'); db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); db.prepare("SELECT 1 FROM repositories LIMIT 1").get(); }
    finally { db.close(); }
    return null;
  } catch (e) { return isStoreCorruptError(e) ? String((e as any)?.message || e) : null; }
}
/**
 * Move a damaged store (and its -wal/-shm) aside to `graph.db.damaged-<stamp>` so the next ingest starts a fresh one.
 * The store is derived data — every repo re-indexes from its checkout — and a store SQLite cannot open answers
 * nothing anyway; before this, every Index click failed into ingest.log and the chip kept offering it.
 */
export async function quarantineStore(dbFile: string = graphDbPath(), deps?: Partial<MaintenanceDeps> & { rename?: (a: string, b: string) => void }): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${dbFile}.damaged-${stamp}`;
  const rename = deps?.rename ?? fs.renameSync;
  // Windows cannot rename a file that is open: every holder (the ui-server's readers, the daemon, this process's
  // koragraph pool, opened at require time) is asked to close first (store-maintenance.ts). Dropping our koragraph
  // modules makes the next kg() call open the fresh store. On macOS this is one rename, as before.
  await withStoreMaintenance('quarantine', () => rename(dbFile, dest), { onRefused: releaseKoragraphModules }, dbFile, deps);
  for (const ext of ['-wal', '-shm']) { try { rename(dbFile + ext, dest + ext); } catch { /* absent */ } }
  return dest;
}

export function releaseKoragraphModules(): void {
  const sep = '[\\\\/]';
  const pool = new RegExp(`koragraph${sep}src${sep}db${sep}pool\\.js$`);
  const engine = new RegExp(`koragraph${sep}src${sep}`);
  for (const id of Object.keys(require.cache)) {
    if (pool.test(id)) { try { (require.cache[id]?.exports as any)?.db?.close(); } catch { /* already closed */ } }
  }
  for (const id of Object.keys(require.cache)) if (engine.test(id)) delete require.cache[id];
}

export interface RepoIdentity { repoRoot: string | null; repoId: string | null; repoName: string | null }
export function repoIdentity(cwd: string): RepoIdentity {
  try { return kg('src/practice/repo-identity.js').repoIdentity(cwd); }
  catch { return { repoRoot: null, repoId: null, repoName: null }; }
}

/** git toplevel for cwd via `git rev-parse`, falling back to a .git walk. Null outside a repo. */
// Memoized: every sync git spawn blocks the daemon's event loop, and under swarm load one call took 100–500 ms while
// the same few repos were asked the same question from several paths (CPU profile, 10-leader e2e: 5–17 s stalls).
const topLevelMemo = new Map<string, { at: number; v: string | null }>();
/** Record a known toplevel (a worktree the caller just created) so the first lookup needs no git. */
export function primeGitTopLevel(cwd: string, top: string): void { topLevelMemo.set(cwd, { at: Date.now(), v: top }); }
export function gitTopLevel(cwd: string): string | null {
  const hit = topLevelMemo.get(cwd);
  if (hit && Date.now() - hit.at < (hit.v ? 60_000 : 5_000)) return hit.v;
  const v = gitTopLevelUncached(cwd);
  if (topLevelMemo.size > 2000) topLevelMemo.clear();
  topLevelMemo.set(cwd, { at: Date.now(), v });
  return v;
}
let cltChecked: boolean | null = null;
/** Reset CLT check for tests */
export function setCltForTests(val: boolean | null): void { cltChecked = val; }
/** Whether Apple developer tools are installed on macOS, guarding against the /usr/bin/git stub dialog. */
export function macDeveloperToolsInstalled(): boolean {
  if (process.platform !== 'darwin') return true;
  if (cltChecked !== null) return cltChecked;
  try {
    const r = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    cltChecked = r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch {
    cltChecked = false;
  }
  return cltChecked;
}

function gitTopLevelUncached(cwd: string): string | null {
  let root: string | null = null;
  try { root = kg('src/practice/repo-identity.js').findRepoRoot(cwd); } catch { /* no kg */ }
  if (!root) return null;
  if (process.platform === 'darwin' && !macDeveloperToolsInstalled()) return gitPath(root);
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0 && r.stdout.trim()) return gitPath(r.stdout.trim());
  } catch { /* no git */ }
  return gitPath(root);
}

// Unix socket paths are capped by the kernel (sun_path: 104 bytes on macOS/BSD, 108 on Linux) and SILENTLY truncated:
// a server that binds a longer path creates the socket at the truncated name, and every client connecting with the
// same long string is truncated identically — so connects work while a stat of the full path says ENOENT. Measured:
// a deep KORA_HOME made every hook fall back to in-process (no ledger, no counted graph calls). Check both.
export const SUN_PATH_MAX = process.platform === 'linux' ? 107 : 104; // measured on macOS: 104 chars kept, no NUL needed
export function socketReachable(socketPath?: string): boolean {
  const p = socketPath || process.env.KORA_SOCKET_PATH || path.join(koraHome(), 'kora.sock');
  if (isWindows) return ipcExists(p);
  for (const cand of p.length > SUN_PATH_MAX ? [p, p.slice(0, SUN_PATH_MAX)] : [p]) { try { if (fs.statSync(cand).isSocket()) return true; } catch { /* next */ } }
  return false;
}

/** Promise with a deadline; resolves `fallback` on timeout instead of rejecting. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

// Per-folder trust: the one switch between "Kora runs this repository's own agent configuration" and "it does not".
//
// A repository can carry code that an agent runs on start-up or on its first tool call: Claude Code project hooks and
// MCP servers (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`), Codex project config, OpenCode /
// Koragent plugins and tools (`.opencode/`, `.koragent/`). Until the user trusts a folder, every lane Kora drives runs
// with that configuration switched off (see trust/gate.ts for what each lane does). Trusting is explicit — the
// "Trust this folder?" prompt in the app, `kora setup --trust`, or the one-time migration of folders the user was
// already using before this version.
//
// Store: `<KORA_HOME>/trust.json` (0600, KORA_HOME 0700), keyed by the realpath of the repository root. A trusted
// folder covers everything under it; a git worktree (Kora's own under <KORA_HOME>/worktrees included) resolves to its
// main checkout, but only when the main checkout's git dir points back at the worktree — a planted `.git` file cannot
// borrow another repository's trust. The home folder, `/` and their ancestors can never be trusted (it would trust
// every clone on the machine). The assistant lane's folders are Kora's own and always count as trusted.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { thisComputer } from '../util/platform-copy';

export type TrustSource = 'user' | 'migration' | 'cli';
export interface TrustEntry { path: string; trustedAt: number; source: TrustSource }
interface TrustFile { version: 1; folders: TrustEntry[] }

export interface TrustStatus {
  /** The folder asked about (as given). */
  cwd: string;
  /** What trust is keyed by for it: the repository root (main checkout for a worktree), else the folder itself. */
  root: string;
  trusted: boolean;
  /** The stored folder that covers it (the root itself or an ancestor), or null. */
  trustedBy: string | null;
  source: TrustSource | 'kora' | null;
  /** False for a folder that can never be trusted (home, `/`, a missing folder); `reason` says why. */
  canTrust: boolean;
  reason: string | null;
}

export function trustFilePath(): string { return path.join(koraHome(), 'trust.json'); }
/** Written once the upgrade migration has run (kept apart from trust.json so a damaged store never re-migrates). */
export function trustMigrationMarker(): string { return path.join(koraHome(), 'trust-migrated-v1'); }

function real(p: string): string {
  try { return fs.realpathSync.native(p); } catch { /* missing */ }
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function readText(p: string): string | null { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/**
 * The main checkout of a linked worktree whose `.git` FILE is at `dir/.git`, or null. Verified both ways: the
 * worktree's gitdir (`<main>/.git/worktrees/<name>`) must name THIS worktree in its `gitdir` back-pointer.
 */
function mainCheckoutOfWorktree(dir: string): string | null {
  const txt = readText(path.join(dir, '.git'));
  const m = txt ? /^gitdir:\s*(.+?)\s*$/m.exec(txt) : null;
  if (!m) return null;
  const gitdir = real(path.resolve(dir, m[1]));
  const back = readText(path.join(gitdir, 'gitdir'));
  if (!back || real(path.dirname(path.resolve(gitdir, back.trim()))) !== real(dir)) return null;
  const common = readText(path.join(gitdir, 'commondir'));
  const commonDir = real(common ? path.resolve(gitdir, common.trim()) : gitdir);
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
}

/**
 * The folder trust is keyed by for `p`: the enclosing repository's root (a linked worktree → its main checkout),
 * else the folder itself. Always a realpath.
 */
export function resolveTrustRoot(p: string): string {
  const start = real(p);
  let dir = start;
  for (let i = 0; i < 64; i++) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(path.join(dir, '.git')); } catch { st = null; }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) return mainCheckoutOfWorktree(dir) ?? dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

/** `/`, the home folder or any folder above it: trusting one would trust every clone on the machine. */
function isBroad(p: string): boolean {
  const r = real(p);
  return r === path.parse(r).root || isUnder(real(os.homedir()), r);
}

/** Why `root` can never be trusted, or null. */
export function untrustableReason(root: string): string | null {
  const home = real(os.homedir());
  const r = real(root);
  if (r === path.parse(r).root) return 'the filesystem root cannot be trusted';
  if (isUnder(home, r)) return `your home folder (or a folder above it) cannot be trusted — it would trust every project on ${thisComputer()}`;
  if (isUnder(r, real(koraHome())) && !isUnder(r, real(path.join(koraHome(), 'worktrees')))) return "Kora's own data folder is not a project";
  try { if (!fs.statSync(r).isDirectory()) return 'not a folder'; } catch { return 'the folder does not exist'; }
  return null;
}

function isAssistantFolder(p: string): boolean {
  try { return (require('../blobs/home') as typeof import('../blobs/home')).isBlobsCwd(p); } catch { return false; }
}

// ── the file ───────────────────────────────────────────────────────────────────────
let cache: { file: string; mtimeMs: number; size: number; data: TrustFile } | null = null;

function readStore(): TrustFile {
  const file = trustFilePath();
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { cache = null; return { version: 1, folders: [] }; }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
  let data: TrustFile = { version: 1, folders: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.folders) ? parsed.folders : [];
    data = {
      version: 1,
      folders: list.filter((e: any) => e && typeof e.path === 'string' && path.isAbsolute(e.path))
        .map((e: any) => ({ path: e.path, trustedAt: Number(e.trustedAt) || 0, source: (['user', 'migration', 'cli'].includes(e.source) ? e.source : 'user') as TrustSource })),
    };
  } catch { /* unreadable → nothing trusted (fail closed); the next write replaces it */ }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

function writeStore(data: TrustFile): void {
  const file = trustFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // 'wx': never follow or reuse something already sitting at the temp name.
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  cache = null;
}

const events = new EventEmitter();
events.setMaxListeners(0); // one per SessionManager; tests build many
/** Called with the folder whose trust changed (granted or revoked). Returns the unsubscribe function. */
export function onTrustChange(fn: (root: string, trusted: boolean) => void): () => void {
  events.on('change', fn);
  return () => { events.off('change', fn); };
}

// ── queries ─────────────────────────────────────────────────────────────────────────
export function listTrustedFolders(): TrustEntry[] { return readStore().folders.slice(); }

export function trustStatus(cwd: string): TrustStatus {
  const root = resolveTrustRoot(cwd);
  if (isAssistantFolder(cwd)) return { cwd, root, trusted: true, trustedBy: root, source: 'kora', canTrust: true, reason: null };
  const reason = untrustableReason(root);
  const here = real(cwd);
  // A stored entry for home, `/` or an ancestor of home (an old or hand-edited file) never counts.
  const hit = readStore().folders.find((e) => !isBroad(e.path) && (isUnder(root, e.path) || isUnder(here, e.path))) ?? null;
  const trusted = !!hit && !reason;
  return { cwd, root, trusted, trustedBy: trusted ? hit!.path : null, source: trusted ? hit!.source : null, canTrust: !reason, reason };
}

/** True when Kora may run this folder's own agent configuration (hooks, project MCP servers, plugins, tools). */
export function isFolderTrusted(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  try { return trustStatus(cwd).trusted; } catch { return false; }
}

// ── changes ─────────────────────────────────────────────────────────────────────────
export function trustFolder(cwd: string, source: TrustSource = 'user'): TrustStatus {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('trust needs an absolute folder path');
  const root = resolveTrustRoot(cwd);
  const reason = untrustableReason(root);
  if (reason) throw new Error(`Cannot trust ${root}: ${reason}`);
  const data = readStore();
  if (!data.folders.some((e) => e.path === root)) {
    data.folders.push({ path: root, trustedAt: Date.now(), source });
    writeStore(data);
    events.emit('change', root, true);
  }
  return trustStatus(cwd);
}

/**
 * Revoke trust for the folder's root and anything stored under it. A folder still covered by a trusted ANCESTOR stays
 * trusted — the returned status names that ancestor (`trustedBy`) so the caller can say so.
 */
export function revokeFolderTrust(cwd: string): TrustStatus {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('revoke needs an absolute folder path');
  const root = resolveTrustRoot(cwd);
  const here = real(cwd);
  const data = readStore();
  const kept = data.folders.filter((e) => !(isUnder(e.path, root) || e.path === here));
  if (kept.length !== data.folders.length) {
    writeStore({ version: 1, folders: kept });
    events.emit('change', root, false);
  }
  return trustStatus(cwd);
}

// ── upgrade migration ───────────────────────────────────────────────────────────────
function readJson(p: string): unknown { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** Every folder the daemon already knew before this version: chat threads, app projects, pane workspaces. */
export function knownFolders(home = koraHome()): string[] {
  const out = new Set<string>();
  const add = (p: unknown) => { if (typeof p === 'string' && path.isAbsolute(p)) out.add(p); };
  // Chat threads: index.json heads, and each thread's meta.json (the index is only a mirror).
  const chat = path.join(home, 'chat');
  const index = readJson(path.join(chat, 'index.json'));
  if (Array.isArray(index)) for (const h of index) add((h as any)?.cwd);
  try {
    const dirs = fs.readdirSync(chat, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, 20_000);
    for (const d of dirs) add((readJson(path.join(chat, d.name, 'meta.json')) as any)?.cwd);
  } catch { /* no chat store */ }
  // The app's project list (ui-server ChatEngine: <KORA_HOME>/kora-daemon/projects.json).
  const projects = readJson(path.join(home, 'kora-daemon', 'projects.json'));
  if (Array.isArray(projects)) for (const p of projects) add((p as any)?.workspaceRoot);
  // Pane workspaces (state.json and the per-socket state-<key>.json files).
  try {
    for (const f of fs.readdirSync(home)) {
      if (!/^state(-[\w.-]+)?\.json$/.test(f)) continue;
      const s = readJson(path.join(home, f)) as any;
      for (const w of Array.isArray(s?.workspaces) ? s.workspaces : []) {
        if (w?.ephemeral) continue;
        add(w?.cwd);
        for (const p of Array.isArray(w?.panes) ? w.panes : []) { add(p?.cwd); add(p?.worktree?.mainRoot); }
      }
    }
  } catch { /* no state */ }
  return [...out];
}

/**
 * Once per KORA_HOME, on the first daemon start of a version with folder trust: trust every folder the user was
 * already using (so nobody is broken by the upgrade), except the ones that can never be trusted (home, `/`, missing).
 * Brand-new folders after this need an explicit trust. Idempotent: the marker file stops a second run, even if
 * trust.json is later deleted or damaged.
 */
export function migrateTrustOnce(): { migrated: boolean; trusted: string[] } {
  const marker = trustMigrationMarker();
  if (fs.existsSync(marker)) return { migrated: false, trusted: [] };
  const data = readStore();
  const have = new Set(data.folders.map((e) => e.path));
  const trusted: string[] = [];
  for (const folder of knownFolders()) {
    if (isAssistantFolder(folder)) continue;
    let root: string;
    try { root = resolveTrustRoot(folder); } catch { continue; }
    if (have.has(root) || untrustableReason(root)) continue;
    have.add(root);
    data.folders.push({ path: root, trustedAt: Date.now(), source: 'migration' });
    trusted.push(root);
  }
  if (trusted.length) writeStore(data);
  fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, `${new Date().toISOString()} ${trusted.length} folder(s)\n`, { mode: 0o600 });
  for (const r of trusted) events.emit('change', r, true);
  return { migrated: true, trusted };
}

/** Test seam: forget the parsed-file cache (tests rewrite trust.json behind the store's back). */
export function _resetTrustCacheForTests(): void { cache = null; }

/** The slice the UI server drives (ui-server `handlers/trust.ts`, through `UiHost.trust`). */
export interface TrustHostApi {
  status(cwd: string): TrustStatus;
  trust(cwd: string): TrustStatus;
  revoke(cwd: string): TrustStatus;
  list(): TrustEntry[];
}
export const trustHostApi: TrustHostApi = {
  status: (cwd) => trustStatus(cwd),
  trust: (cwd) => trustFolder(cwd, 'user'),
  revoke: (cwd) => revokeFolderTrust(cwd),
  list: () => listTrustedFolders(),
};

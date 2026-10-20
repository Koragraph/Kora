// One git worktree per agent. An agent that edits a shared checkout races every other agent and leaves the
// user with no clean way to accept or drop its work; a worktree on its own branch gives isolation for free
// and turns "merge this agent's work" into one git command. Layout:
//   ~/.kora/worktrees/<repo basename>/<slug>   on branch  kora/<slug>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { koraHome, macDeveloperToolsInstalled } from '../graph/embedded';
import { GIT_MAX_BUFFER, GIT_NO_FSMONITOR, GIT_TIMEOUT_MS, gitEnv, isSafeGitRef } from '../util/safe-path';
import { gitPath } from '../util/win-exec';

const ADJ = ['brisk', 'calm', 'bold', 'quiet', 'swift', 'keen', 'warm', 'wry', 'deft', 'lucid', 'nimble', 'steady', 'vivid', 'candid', 'plucky', 'sly'];
const NOUN = ['otter', 'heron', 'fox', 'lynx', 'finch', 'wren', 'ibex', 'newt', 'crane', 'stoat', 'raven', 'marten', 'plover', 'egret', 'tern', 'vole'];
export function slug(agent: string): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)], n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${agent}-${a}-${n}`;
}
/** Kora's own git ops never run the repo's hooks: a hooks dir can be committed content (husky's core.hooksPath) and a
 *  worker on a third-party model can edit it. Its post-checkout / pre-commit / post-merge would then run as the user,
 *  in the main checkout, outside every permission the worker had. */
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', ...GIT_NO_FSMONITOR] as const;
/** Synchronous git with a wall-clock cap (`worktree add` / `merge` on a big repo get longer): a timed-out call is a
 *  failed call (`ok: false`), never a frozen daemon. */
function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): { ok: boolean; out: string; err: string } {
  if (process.platform === 'darwin' && !macDeveloperToolsInstalled()) {
    return { ok: false, out: '', err: 'Apple command line developer tools are not installed' };
  }
  const r = spawnSync('git', [...NO_HOOKS, ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: GIT_MAX_BUFFER, env: gitEnv() });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: timedOut ? `git ${args[0]} timed out after ${Math.round(timeout / 1000)} s` : (r.stderr || '').trim() };
}
/** Tree-sized work (worktree add/remove, add -A, merge, checkout): the same budget as `worktreeInChild`. */
const GIT_LONG_TIMEOUT_MS = 120_000;
/** How long a merge waits for another merge into the same checkout (withMergeLock). */
export const MERGE_LOCK_WAIT_MS = 110_000;
/** The merge child's budget: the lock wait PLUS the merge itself (add, commit, merge, checkout restore). The wait used to
 *  eat the one 120 s budget, so a merge that waited ~100 s was killed partway through (audit 2026-10-15 fleet #4). */
export const MERGE_CHILD_TIMEOUT_MS = MERGE_LOCK_WAIT_MS + 180_000;
// Memoized: every sync git spawn blocks the daemon's event loop, and under swarm load one call took 100–500 ms while
// the same few repos were asked the same question from several paths (CPU profile, 10-leader e2e: 5–17 s stalls).
const rootMemo = new Map<string, { at: number; v: string | null }>();
export function mainRoot(cwd: string): string | null {
  const hit = rootMemo.get(cwd);
  if (hit && Date.now() - hit.at < (hit.v ? 60_000 : 5_000)) return hit.v;
  const r = git(cwd, ['rev-parse', '--git-common-dir']);
  const v = r.ok ? path.dirname(path.resolve(cwd, r.out)) : null;
  if (rootMemo.size > 2000) rootMemo.clear();
  rootMemo.set(cwd, { at: Date.now(), v });
  return v;
}
function gitAsync(cwd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  if (process.platform === 'darwin' && !macDeveloperToolsInstalled()) return Promise.resolve({ ok: false, out: '' });
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve) => {
    execFile('git', [...NO_HOOKS, ...args], { cwd, encoding: 'utf8', timeout, maxBuffer: 16 << 20, env: gitEnv() }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
}
/** mainRoot without blocking: the same memo, filled by an async git call on a miss (the 5 s worktree status poll). */
export async function mainRootAsync(cwd: string): Promise<string | null> {
  const hit = rootMemo.get(cwd);
  if (hit && Date.now() - hit.at < (hit.v ? 60_000 : 5_000)) return hit.v;
  const r = await gitAsync(cwd, ['rev-parse', '--git-common-dir']);
  const v = r.ok ? path.dirname(path.resolve(cwd, r.out)) : null;
  if (rootMemo.size > 2000) rootMemo.clear();
  rootMemo.set(cwd, { at: Date.now(), v });
  return v;
}
export function hasCommits(root: string): boolean { return git(root, ['rev-parse', '--verify', 'HEAD']).ok; }
const linkedMemo = new Map<string, { at: number; v: boolean }>();
/** A worktree this process just created: its answers are known, so the first lookups need no git. */
export function primeWorktreeFacts(worktreePath: string, root: string): void {
  const at = Date.now();
  rootMemo.set(worktreePath, { at, v: root });
  linkedMemo.set(worktreePath, { at, v: true });
}
export function isLinkedWorktree(cwd: string): boolean {
  const hit = linkedMemo.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const v = isLinkedWorktreeUncached(cwd);
  if (linkedMemo.size > 2000) linkedMemo.clear();
  linkedMemo.set(cwd, { at: Date.now(), v });
  return v;
}
function isLinkedWorktreeUncached(cwd: string): boolean {
  const top = git(cwd, ['rev-parse', '--show-toplevel']); if (!top.ok) return false;
  try { return fs.statSync(path.join(top.out, '.git')).isFile(); } catch { return false; }
}
export interface WorktreeInfo { path: string; branch: string; mainRoot: string; repo: string; head: string | null }
export function worktreesDir(): string { return process.env.KORA_WORKTREES || path.join(koraHome(), 'worktrees'); }

/** A worktree Kora made for an agent (under worktreesDir(), or on a `kora/` branch), as opposed to a user's own linked
 *  checkout such as `kora-dev` beside `kora`. */
export function isAgentWorktree(cwd: string): boolean {
  if (!isLinkedWorktree(cwd)) return false;
  const top = git(cwd, ['rev-parse', '--show-toplevel']).out;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  if (top && (real(top) + path.sep).startsWith(real(worktreesDir()) + path.sep)) return true;
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.startsWith('kora/');
}
/**
 * The checkout a new worker branches from and merges back into: the user's own linked worktree they work in (a lead in
 * `kora-dev`), else the main checkout. Using the main checkout for both sent a `kora-dev` lead's workers off `main`'s
 * HEAD and merged them into `main` (test/fleet 2026-10-14).
 */
export function originCheckout(cwd: string): string | null {
  const root = mainRoot(cwd); if (!root) return null;
  if (!isLinkedWorktree(cwd) || isAgentWorktree(cwd)) return root;
  return gitPath(git(cwd, ['rev-parse', '--show-toplevel']).out) || root;
}
const ORIGIN_FILE = 'kora-origin';
/** Where a worker worktree merges: the origin recorded at creation (same repository, still there), else the main checkout. */
export function mergeTarget(dir: string): string | null {
  const root = mainRoot(dir); if (!root) return null;
  try {
    const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
    const origin = gd.ok ? fs.readFileSync(path.join(gd.out, ORIGIN_FILE), 'utf8').trim() : '';
    const common = (d: string) => { const c = git(d, ['rev-parse', '--git-common-dir']); return c.ok ? fs.realpathSync(path.resolve(d, c.out)) : null; };
    if (origin && fs.existsSync(origin) && common(origin) === common(dir)) return origin;
  } catch { /* no origin recorded */ }
  return root;
}

export function createWorktree(fromCwd: string, agent: string): WorktreeInfo {
  const main = mainRoot(fromCwd); if (!main) throw new Error(`${fromCwd} is not inside a git repository`);
  const root = originCheckout(fromCwd) || main;
  if (!hasCommits(root)) throw new Error(`${root} has no commits yet — a worktree needs a HEAD to branch from`);
  const repo = path.basename(main);
  // A slug is free when neither its folder nor its branch exists: the branch outlives a removed worktree (an unmerged
  // worker kept), and the other Kora flavor's worktrees live under ITS home but branch in the same repo.
  const taken = (cand: string) => fs.existsSync(path.join(worktreesDir(), repo, cand)) || git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/kora/${cand}`]).ok;
  let s = slug(agent);
  for (let i = 0; i < 12 && taken(s); i++) s = slug(agent);
  if (taken(s)) s = `${s}-${Date.now().toString(36)}`;
  const dir = path.join(worktreesDir(), repo, s);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const branch = `kora/${s}`;
  const r = git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD'], GIT_LONG_TIMEOUT_MS);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err || r.out}`);
  if (root !== main) { const gd = git(dir, ['rev-parse', '--absolute-git-dir']); if (gd.ok) fs.writeFileSync(path.join(gd.out, ORIGIN_FILE), root + '\n'); }
  linkDependencies(root, dir);
  initSubmodules(root, dir);
  return { path: dir, branch, mainRoot: root, repo, head: git(dir, ['rev-parse', '--short', 'HEAD']).out || null };
}
/**
 * `git worktree add` leaves a submodule's folder empty, so a worker in such a repo could not build (deep A2-11). Check out
 * each submodule the MAIN checkout already has initialized, cloning from that local copy (no network, no credentials): the
 * shared config keeps the real URL, only this call's `-c` points at the local path. A submodule the user never initialized
 * is skipped, and any failure leaves the empty folder as before. Returns the paths it filled.
 */
export function initSubmodules(root: string, dir: string): string[] {
  if (!fs.existsSync(path.join(dir, '.gitmodules'))) return [];
  const cfg = git(dir, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  if (!cfg.ok) return [];
  const done: string[] = [];
  for (const line of cfg.out.split('\n').filter(Boolean)) {
    const m = /^submodule\.(.+)\.path (.+)$/.exec(line); if (!m) continue;
    const [, name, sub] = m as unknown as [string, string, string];
    const src = path.join(root, sub);
    if (!fs.existsSync(path.join(src, '.git'))) continue;
    const r = git(dir, ['-c', 'protocol.file.allow=always', '-c', `submodule.${name}.url=${src}`, 'submodule', 'update', '--init', '--', sub], GIT_LONG_TIMEOUT_MS);
    if (r.ok) done.push(sub);
  }
  return done;
}
const DEP_DIRS = ['node_modules', '.venv', 'venv'];
/**
 * A fresh worktree has no installed dependencies (they are untracked), so a worker could not run the repo's tests or
 * build: node resolves node_modules by walking up from the file, and the worktree lives under ~/.kora, not the repo.
 * Symlink every installed dependency dir of the main checkout (next to each tracked package.json / pyproject, plus
 * the root) into the worktree. Untracked, and GENERATED_RE keeps them out of the worker's commit.
 */
const MANIFEST_ARGS = ['ls-files', '--', 'package.json', '*/package.json', 'pyproject.toml', '*/pyproject.toml'];
export function linkDependencies(root: string, dir: string): string[] {
  return linkManifestDeps(root, dir, git(root, MANIFEST_ARGS).out);
}
/** linkDependencies off the event loop (the daemon's swarm baseline worktree: a sync `git ls-files` there stalled it). */
export async function linkDependenciesAsync(root: string, dir: string): Promise<string[]> {
  return linkManifestDeps(root, dir, (await gitAsync(root, MANIFEST_ARGS)).out);
}
function linkManifestDeps(root: string, dir: string, lsFiles: string): string[] {
  const linked: string[] = [];
  const manifests = lsFiles.split('\n').filter(Boolean);
  const bases = new Set(['', ...manifests.map((m) => path.dirname(m)).filter((d) => d !== '.' && d.split('/').length <= 4)]);
  for (const base of bases) {
    for (const dep of DEP_DIRS) {
      const src = path.join(root, base, dep); const dst = path.join(dir, base, dep);
      try {
        if (!fs.statSync(src).isDirectory() || fs.existsSync(dst) || !fs.existsSync(path.dirname(dst))) continue;
        fs.symlinkSync(src, dst, 'dir'); linked.push(path.join(base, dep));
      } catch { /* absent or not linkable */ }
    }
  }
  return linked;
}
export function listWorktrees(root: string): WorktreeInfo[] {
  const r = git(root, ['worktree', 'list', '--porcelain']); if (!r.ok) return [];
  const out: WorktreeInfo[] = []; let cur: any = {};
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: gitPath(line.slice(9)) };
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
    else if (line === '' && cur.path) { if (cur.branch && cur.branch.startsWith('kora/')) out.push({ path: cur.path, branch: cur.branch, mainRoot: root, repo: path.basename(root), head: cur.head || null }); cur = {}; }
  }
  if (cur.path && cur.branch && cur.branch.startsWith('kora/')) out.push({ path: cur.path, branch: cur.branch, mainRoot: root, repo: path.basename(root), head: cur.head || null });
  return out;
}
// Files kora itself writes into a checkout (rulebook, hooks, MCP config). They are the runtime's, not the
// agent's work: never counted as the agent's dirty files, never committed by kora's own merge.
// `.kora/swarm/` holds swarm workers' reports ($KORA_REPORT = <worktree>/.kora/swarm/<taskId>.md): a directory entry
// (trailing slash) covers every file under it. Reports are for the leader, never part of a merge.
export const MANAGED_PATHS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.claude/settings.json', '.mcp.json', '.cursor/rules/kora.mdc', '.cursor/mcp.json', '.gemini/settings.json', 'opencode.json', '.kora/swarm/'];
// `git status --porcelain` reports a wholly-untracked directory as ONE entry (`?? .gemini/`), so a managed file
// inside it must count through its directory too — otherwise every fresh checkout kora set up reads as dirty
// and `kora_merge` refuses with "main checkout has 1 uncommitted change"; real orchestrator runs then wasted a
// turn stashing our own onboarding files to get the merge through.
export function isManaged(p: string): boolean {
  const clean = p.replace(/^"|"$/g, '');
  if (MANAGED_PATHS.includes(clean)) return true;
  if (MANAGED_PATHS.some((m) => m.endsWith('/') && clean.startsWith(m))) return true; // a file inside a managed directory
  return clean.endsWith('/') && MANAGED_PATHS.some((m) => m.startsWith(clean));
}
/**
 * Whether one `git status --porcelain` line in `dir` is real work: not kora's managed files, and — when untracked — not
 * generated output nor a nested git repository. The same exclusions the commit-first step and the main-checkout check
 * apply; worktreeStatus counting them as dirty made a worker whose only leftovers were `__pycache__/` unmergeable
 * (audit 2026-10-15 fleet #3).
 */
export function isWorkLine(dir: string, line: string): boolean {
  const p = line.slice(3).trim().replace(/^"|"$/g, '');
  if (isManaged(p)) return false;
  if (!line.startsWith('??')) return true;
  if (isGeneratedPath(p)) return false;
  return !(p.endsWith('/') && isNestedRepoDir(dir, p));
}
/** An untracked directory that is a git repository, or holds one a level down (`vendor/` with `vendor/inner/.git`). */
function isNestedRepoDir(dir: string, rel: string): boolean {
  const abs = path.join(dir, rel);
  if (fs.existsSync(path.join(abs, '.git'))) return true;
  try {
    const subs = fs.readdirSync(abs);
    // A directory that is nothing but nested repos is not work; one with any other entry is (a new source folder).
    return subs.length > 0 && subs.every((sub) => fs.existsSync(path.join(abs, sub, '.git')));
  } catch { return false; }
}
export function worktreeStatus(dir: string): { dirty: number; ahead: number; branch: string | null } {
  const dirty = git(dir, ['status', '--porcelain']).out.split('\n').filter(Boolean).filter((l) => isWorkLine(dir, l)).length;
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
  const root = mergeTarget(dir); let ahead = 0;
  if (root && branch) { const mb = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out; const c = git(dir, ['rev-list', '--count', `${mb}..${branch}`]); ahead = c.ok ? Number(c.out) || 0 : 0; }
  return { dirty, ahead, branch };
}
/** Non-blocking twin of worktreeStatus for the runtime's periodic poll: three git calls per worktree every few
 *  seconds must never sit on the daemon's event loop (with several worktrees on a large repo they added up to
 *  multi-second stalls that dropped every websocket client). */
export async function worktreeStatusAsync(dir: string): Promise<{ dirty: number; ahead: number; branch: string | null }> {
  if (process.platform === 'darwin' && !macDeveloperToolsInstalled()) return { dirty: 0, ahead: 0, branch: null };
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  const run = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile('git', [...NO_HOOKS, ...args], { cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 16 << 20, env: gitEnv() }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
  const [status, br] = await Promise.all([run(dir, ['status', '--porcelain']), run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])]);
  const dirty = status.out.split('\n').filter(Boolean).filter((l) => isWorkLine(dir, l)).length;
  const branch = br.out || null;
  const root = await mainRootAsync(dir); let ahead = 0;
  if (root && branch) { const mb = (await run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out; const c = await run(dir, ['rev-list', '--count', `${mb}..${branch}`]); ahead = c.ok ? Number(c.out) || 0 : 0; }
  return { dirty, ahead, branch };
}
// Generated / cached / dependency output that is never an agent's work. Matched against untracked paths from
// `git status --porcelain`; a directory entry (`__pycache__/`) covers everything under it.
export const GENERATED_RE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|node_modules|\.venv|venv|\.env|dist|build|out|coverage|\.nyc_output|\.cache|\.parcel-cache|\.next|\.nuxt|\.turbo|target|\.gradle|\.idea|\.vscode|\.kora|\.gemini|\.cursor|\.claude\/worktrees)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|[^/]*\.(pyc|pyo|log|tmp|swp|orig|rej|class|o|so|dylib|dll|exe|tsbuildinfo))$/;
export function isGeneratedPath(p: string): boolean { return GENERATED_RE.test(p.replace(/^"|"$/g, '')); }
/** Untracked (`??`) paths in `dir` that look generated — the ones `git add -A` must not turn into the agent's commit. */
export function untrackedGenerated(dir: string): string[] {
  const out = git(dir, ['status', '--porcelain', '--untracked-files=normal']).out.split('\n').filter(Boolean);
  return out.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter((p) => isGeneratedPath(p) && !isManaged(p));
}
/** Untracked directories that are git repositories of their own (contain .git) — never an agent's work. */
export function untrackedNestedRepos(dir: string): string[] {
  const out = git(dir, ['status', '--porcelain', '--untracked-files=normal']).out.split('\n').filter(Boolean);
  const dirs = out.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter((p) => p.endsWith('/'));
  const nested: string[] = [];
  for (const d of dirs) {
    if (fs.existsSync(path.join(dir, d, '.git'))) { nested.push(d.replace(/\/$/, '')); continue; }
    // one level down: `vendor/` untracked as a whole with `vendor/inner/.git` inside
    try { for (const sub of fs.readdirSync(path.join(dir, d))) { if (fs.existsSync(path.join(dir, d, sub, '.git'))) nested.push(path.posix.join(d.replace(/\/$/, ''), sub)); } } catch { /* fine */ }
  }
  return nested;
}
export interface MergeResult { ok: boolean; merged: string | null; into: string | null; conflicts: string[]; message: string; commitsMerged: number }
/**
 * One Kora merge into a main checkout at a time, across processes (both daemons, the CLI): a lock file in the repo's
 * git common dir. Two workers merged at the same moment (two threads on one repo, a lead merging in parallel) ran
 * `git merge` in the same checkout at once: the losers failed on git's index.lock, reported "merge aborted: 0
 * conflict(s)" and their `git merge --abort` could undo the winner's merge in progress (deep audit 2026-10-13 A2-4).
 * Synchronous wait: mergeWorktree runs in a child (worktreeInChild), never on the daemon's event loop.
 */
export function withMergeLock<T>(root: string, fn: () => T, maxWaitMs = MERGE_LOCK_WAIT_MS): T | null {
  let lockFile: string;
  try {
    const common = git(root, ['rev-parse', '--git-common-dir']);
    lockFile = path.join(path.resolve(root, common.ok && common.out ? common.out : '.git'), 'kora-merge.lock');
  } catch { lockFile = path.join(root, '.git', 'kora-merge.lock'); }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  for (;;) {
    // Written whole to a private file, then hard-linked into place: link is atomic and fails when the lock exists, so no
    // one ever reads a half-written lock. (open 'wx' + write left an empty file for a moment; a second merge read it as
    // stale, deleted it and ran alongside the first.)
    const mine = `${lockFile}.${process.pid}.${Date.now()}`;
    const body = JSON.stringify({ pid: process.pid, at: Date.now() });
    try {
      fs.writeFileSync(mine, body);
      let linked = true;
      try { fs.linkSync(mine, lockFile); } catch (le: any) { if (le?.code === 'EEXIST') throw le; linked = false; } finally { try { fs.rmSync(mine); } catch { /* gone */ } }
      // no hard links on this filesystem (exFAT, some network shares: EPERM / ENOTSUP): create it in place, the old way
      if (!linked) { const fd = fs.openSync(lockFile, 'wx'); try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); } }
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') return fn(); // no writable git dir: run unlocked, as before
      let raw = ''; try { raw = fs.readFileSync(lockFile, 'utf8'); } catch { continue; } // released meanwhile
      let holder: { pid?: number; at?: number } | null = null; try { holder = JSON.parse(raw); } catch { holder = null; }
      let alive = false; try { if (holder?.pid) { process.kill(Number(holder.pid), 0); alive = true; } } catch (k: any) { alive = k?.code === 'EPERM'; }
      // an unreadable lock seconds old is one being written (the in-place way above): not stale yet
      if (!holder) try { alive = Date.now() - fs.statSync(lockFile).mtimeMs < 5000; holder = alive ? { at: Date.now() } : null; } catch { /* gone */ }
      if (!holder || !alive || Date.now() - Number(holder.at || 0) > 10 * 60_000) {
        // only the lock we judged: another process may have replaced a stale one since
        try { if (fs.readFileSync(lockFile, 'utf8') === raw) fs.rmSync(lockFile); } catch { /* raced */ }
        continue;
      }
      if (Date.now() - t0 > maxWaitMs) return null;
      Atomics.wait(nap, 0, 0, 100);
    }
  }
  try { return fn(); }
  finally { try { const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (cur.pid === process.pid) fs.rmSync(lockFile); } catch { /* gone */ } }
}
/** Merge the worktree's branch into the main checkout's current branch. Refuses on a dirty main tree; aborts on conflict. */
export function mergeWorktree(dir: string, opts: { into?: string; commitFirst?: boolean } = {}): MergeResult {
  const root = mergeTarget(dir); if (!root) return { ok: false, merged: null, into: null, conflicts: [], message: 'not a worktree', commitsMerged: 0 };
  const r = withMergeLock(root, () => mergeWorktreeLocked(dir, root, opts));
  return r ?? { ok: false, merged: null, into: opts.into ?? null, conflicts: [], message: 'another merge into this checkout is still running; try again in a moment', commitsMerged: 0 };
}
function mergeWorktreeLocked(dir: string, root: string, opts: { into?: string; commitFirst?: boolean }): MergeResult {
  // `into` another branch checks it out in the user's main checkout; put their checkout back afterwards (deep A2-10).
  const origBranch = opts.into ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out : '';
  const origSha = opts.into ? git(root, ['rev-parse', 'HEAD']).out : '';
  try { return mergeWorktreeInner(dir, root, opts); }
  finally {
    if (opts.into && origSha) {
      const now = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      const want = origBranch && origBranch !== 'HEAD' ? origBranch : origSha;
      if (now !== want) git(root, ['checkout', '-q', want, '--'], GIT_LONG_TIMEOUT_MS);
    }
  }
}
function mergeWorktreeInner(dir: string, root: string, opts: { into?: string; commitFirst?: boolean }): MergeResult {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  // Resolve the target branch up front so every message (including refusals) names it, never "null".
  const into = opts.into || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
  // `into` can come from the wire or a model's tool call: a value starting with `-` would be read as a git option.
  if (opts.into !== undefined && !isSafeGitRef(opts.into)) return { ok: false, merged: branch, into: null, conflicts: [], message: 'invalid target branch', commitsMerged: 0 };
  if (!isSafeGitRef(branch)) return { ok: false, merged: null, into, conflicts: [], message: 'worktree is not on a branch', commitsMerged: 0 };
  const st = worktreeStatus(dir);
  if (st.dirty && opts.commitFirst) {
    // Excluded from the agent's commit, as pathspec exclusions on the add itself:
    //   - generated output a test/build run leaves behind (__pycache__, .pytest_cache, node_modules, dist/, a virtualenv,
    //     .DS_Store…) — `add -A` swept it in when the repo had no .gitignore entry, two workers then produced conflicting
    //     .pyc binaries at merge, and one run committed a whole node_modules;
    //   - a nested git repository (a cloned dependency, a scratch checkout) — `add -A` stages it as an embedded
    //     gitlink no clone can resolve, and the commit here failed outright with an empty git error.
    // Only UNTRACKED paths are excluded — a file the repo tracks on purpose still commits.
    const excluded = [...untrackedGenerated(dir), ...untrackedNestedRepos(dir)];
    git(dir, ['add', '-A', '--', '.', ...excluded.map((p) => `:(exclude)${p}`)], GIT_LONG_TIMEOUT_MS);
    for (const m of MANAGED_PATHS) git(dir, ['reset', '-q', '--', m]); // kora's own files stay out of the agent's commit
    // Nothing left to stage (every dirty path was excluded): not a failure, go on to merge what is committed.
    const staged = !git(dir, ['diff', '--cached', '--quiet']).ok;
    const c = staged ? git(dir, ['commit', '-q', '-m', `kora: work from ${branch}`], GIT_LONG_TIMEOUT_MS) : { ok: true, out: '', err: '' };
    if (!c.ok) return { ok: false, merged: branch, into, conflicts: [], message: `could not commit in worktree: ${c.err}`, commitsMerged: 0 };
  } else if (st.dirty) {
    return { ok: false, merged: branch, into, conflicts: [], message: `${st.dirty} uncommitted change(s) in the worktree — pass commitFirst (or --no-commit to skip) before merging`, commitsMerged: 0 };
  }
  // kora's own managed files (CLAUDE.md, AGENTS.md, hooks) are written into the main checkout by `kora setup`.
  // They are the runtime's, not the user's edits, so they must not count as a dirty tree that blocks the merge.
  // "Dirty" means the developer's own uncommitted edits — not kora's managed files, not generated output, not an
  // untracked nested repository (the same three exclusions the agent's commit uses); a merge must not be refused for a
  // node_modules or a vendor checkout sitting in the main tree.
  const nestedMain = new Set(untrackedNestedRepos(root));
  const mainDirty = git(root, ['status', '--porcelain']).out.split('\n').filter(Boolean)
    .filter((l) => { const p = l.slice(3).trim().replace(/^"|"$/g, ''); return !isManaged(p) && !(l.startsWith('??') && (isGeneratedPath(p) || nestedMain.has(p.replace(/\/$/, '')) || [...nestedMain].some((n) => n.startsWith(p.replace(/\/$/, '') + '/')))); }).length;
  // A merge left half-done in the main checkout (a killed merge child, or the user's own): never merge on top of it.
  if (fs.existsSync(path.resolve(root, git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).out || '.git/MERGE_HEAD')))
    return { ok: false, merged: branch, into, conflicts: [], message: 'a merge is already in progress in the main checkout (MERGE_HEAD) — finish it or run `git merge --abort` there first', commitsMerged: 0 };
  if (mainDirty) return { ok: false, merged: branch, into, conflicts: [], message: `main checkout has ${mainDirty} uncommitted change(s); commit or stash first`, commitsMerged: 0 };
  if (opts.into) { const co = git(root, ['checkout', '-q', opts.into, '--'], GIT_LONG_TIMEOUT_MS); if (!co.ok) return { ok: false, merged: branch, into, conflicts: [], message: co.err, commitsMerged: 0 }; }
  const count = Number(git(root, ['rev-list', '--count', `${into}..${branch}`]).out) || 0;
  if (!count) return { ok: true, merged: branch, into, conflicts: [], message: 'nothing to merge', commitsMerged: 0 };
  const before = git(root, ['rev-parse', 'HEAD']).out;
  const m = git(root, ['merge', '--no-edit', branch], GIT_LONG_TIMEOUT_MS);
  if (m.ok) {
    const dropped = dropManagedFilesAddedBy(root, before);
    return { ok: true, merged: branch, into, conflicts: [], message: (m.out.split('\n')[0] || 'merged') + (dropped.length ? ` (kept kora's own ${dropped.join(', ')} out of ${into})` : ''), commitsMerged: count };
  }
  const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  // Two workers that each ADDED lines at the same spot (an `export … from` line, a new function at the end of a file)
  // conflict although nothing either wrote is lost by keeping both. Swarm QA 2026-10-02: kora_merge aborted on exactly
  // that and the lead finished the merge by hand with raw git. Only pure additions are united (no line of the base is
  // touched in any conflict hunk); anything else aborts as before.
  if (conflicts.length && conflicts.every((f) => unionPureAdditions(root, f))) {
    const c = git(root, ['commit', '--no-edit', '-q']);
    if (c.ok) {
      const dropped = dropManagedFilesAddedBy(root, before);
      return { ok: true, merged: branch, into, conflicts: [], commitsMerged: count,
        message: `merged; both sides only added lines at the same spot in ${conflicts.join(', ')} — kept both (ours first). Run the tests before relying on it.${dropped.length ? ` (kept kora's own ${dropped.join(', ')} out of ${into})` : ''}` };
    }
  }
  if (!conflicts.length && !fs.existsSync(path.resolve(root, git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).out || '.git/MERGE_HEAD'))) {
    // git refused before merging anything (a lock held by the user's own git, an untracked file in the way): say why
    return { ok: false, merged: branch, into, conflicts: [], message: `git merge failed: ${(m.err || m.out).split('\n')[0] || 'unknown error'}`, commitsMerged: 0 };
  }
  git(root, ['merge', '--abort']);
  return { ok: false, merged: branch, into, conflicts, message: `merge aborted: ${conflicts.length} conflict(s)`, commitsMerged: 0 };
}
/**
 * Resolve one conflicted file of an in-progress merge by keeping both sides, ONLY when every conflict hunk is a pure
 * addition on both sides (diff3 base section empty). Writes and stages the file; false leaves it untouched.
 */
export function unionPureAdditions(root: string, file: string): boolean {
  if (process.platform === 'darwin' && !macDeveloperToolsInstalled()) return false;
  const stage = (n: number) => spawnSync('git', [...NO_HOOKS, 'show', `:${n}:${file}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 << 20, timeout: GIT_TIMEOUT_MS, env: gitEnv() });
  const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
  if (base.status !== 0 || ours.status !== 0 || theirs.status !== 0) return false; // add/add of a whole file, a delete, …
  if ([base, ours, theirs].some((r) => r.stdout.includes(0))) return false; // binary
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kora-union-'));
  try {
    const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => path.join(tmp, n));
    fs.writeFileSync(b, base.stdout); fs.writeFileSync(o, ours.stdout); fs.writeFileSync(t, theirs.stdout);
    const d3 = spawnSync('git', ['merge-file', '-p', '--diff3', o, b, t], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: GIT_TIMEOUT_MS, env: gitEnv() });
    if (d3.status === null || d3.status < 0) return false;
    if (!isPureAdditionConflict(d3.stdout)) return false;
    const u = spawnSync('git', ['merge-file', '-p', '--union', o, b, t], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: GIT_TIMEOUT_MS, env: gitEnv() });
    if (u.status !== 0) return false;
    fs.writeFileSync(path.join(root, file), u.stdout);
    return git(root, ['add', '--', file]).ok;
  } catch { return false; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/** diff3 output: at least one conflict hunk, and every hunk's base section (between ||||||| and =======) is empty. */
export function isPureAdditionConflict(diff3: string): boolean {
  const lines = diff3.split('\n');
  let hunks = 0; let inBase = false;
  for (const l of lines) {
    if (l.startsWith('<<<<<<< ')) { hunks++; continue; }
    if (l.startsWith('||||||| ')) { inBase = true; continue; }
    if (l === '=======' ) { inBase = false; continue; }
    if (inBase) return false;
  }
  return hunks > 0;
}
/**
 * A worker that runs `git add -A` sweeps the enforcer's untracked onboarding files (CLAUDE.md, AGENTS.md, .gemini/…)
 * into its commit, and a merge then lands them on the target branch — every orchestrator in the live runs spent a
 * turn stripping them by hand. After a successful merge, any MANAGED file the merge ADDED that is entirely kora's
 * own (the kora block and nothing else, or one of kora's JSON configs) is taken back out of the index with a
 * follow-up commit. The file stays on disk (the enforcer wants it there); a user-authored instruction file — one with
 * content outside the kora block — is never touched.
 */
function dropManagedFilesAddedBy(root: string, before: string): string[] {
  if (!before) return [];
  const added = git(root, ['diff', '--name-only', '--diff-filter=A', `${before}..HEAD`, '--', ...MANAGED_PATHS]).out.split('\n').map((l) => l.trim()).filter(Boolean);
  const own = added.filter((f) => {
    try {
      if (MANAGED_PATHS.some((m) => m.endsWith('/') && f.startsWith(m))) return true; // a swarm report: never a deliverable
      if (!/\.md$/i.test(f)) return true; // kora's JSON/config files: never a worker's deliverable
      const txt = fs.readFileSync(path.join(root, f), 'utf8');
      if (!txt.includes('<!-- kora:begin -->')) return false;
      const rest = txt.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!-- kora:begin -->[\s\S]*?<!-- kora:end -->\n?/g, '').trim();
      return rest === '';
    } catch { return false; }
  });
  if (!own.length) return [];
  const rm = git(root, ['rm', '-q', '--cached', '--', ...own]);
  if (!rm.ok) return [];
  const c = git(root, ['commit', '-q', '-m', `kora: keep managed onboarding files out of the branch (${own.join(', ')})`]);
  return c.ok ? own : [];
}
export function removeWorktree(dir: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): { ok: boolean; message: string } {
  const root = mainRoot(dir); if (!root) return { ok: false, message: 'not a worktree' };
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  let r = git(root, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir], GIT_LONG_TIMEOUT_MS);
  // git refuses to remove a worktree whose submodules are checked out (initSubmodules) unless forced. When nothing in it is
  // uncommitted, the refusal is only about that, so force it; a dirty worktree still needs the caller's own `force`.
  if (!r.ok && !opts.force && /submodule/i.test(`${r.err} ${r.out}`) && !worktreeStatus(dir).dirty) r = git(root, ['worktree', 'remove', '--force', dir], GIT_LONG_TIMEOUT_MS);
  if (!r.ok) return { ok: false, message: r.err || r.out };
  if (opts.deleteBranch && branch) git(root, ['branch', '-D', branch]);
  return { ok: true, message: `removed ${dir}${opts.deleteBranch ? ` and branch ${branch}` : ''}` };
}

export interface OrphanedWorktree { path: string; name: string; /** parked at (ms), from the folder's mtime */ parkedAt: number; ageDays: number }
/** The worktrees parked because their main checkout is gone. Never deleted by a sweep: the work in them may be the only copy. */
export function listOrphaned(dir: string = worktreesDir(), now = Date.now()): OrphanedWorktree[] {
  const base = path.join(dir, '.orphaned');
  let names: string[] = []; try { names = fs.readdirSync(base); } catch { return []; }
  const out: OrphanedWorktree[] = [];
  for (const name of names) {
    const p = path.join(base, name);
    try { const st = fs.statSync(p); if (!st.isDirectory()) continue; out.push({ path: p, name, parkedAt: st.mtimeMs, ageDays: Math.floor((now - st.mtimeMs) / 86_400_000) }); } catch { /* gone */ }
  }
  return out.sort((a, b) => a.parkedAt - b.parkedAt);
}
/** Delete parked worktrees (explicit call from the user: `names` limits it; `olderThanDays` skips younger ones). Returns what it removed. */
export function purgeOrphaned(opts: { names?: string[]; olderThanDays?: number; dir?: string; now?: number } = {}): string[] {
  const removed: string[] = [];
  for (const o of listOrphaned(opts.dir, opts.now)) {
    if (opts.names && !opts.names.includes(o.name)) continue;
    if (opts.olderThanDays !== undefined && o.ageDays < opts.olderThanDays) continue;
    if (path.basename(path.dirname(o.path)) !== '.orphaned') continue; // belt and braces: only ever inside .orphaned
    try { fs.rmSync(o.path, { recursive: true, force: true }); removed.push(o.path); } catch { /* keep */ }
  }
  return removed;
}
export interface SweepResult {
  scanned: number;
  /** clean (no non-managed dirty files, no commits ahead of main), no live pane → removed with its branch */
  removed: string[];
  /** dirty or ahead, no live pane → left alone, reported so a human (or the merge tool) can decide */
  orphans: { path: string; branch: string | null; dirty: number; ahead: number }[];
  /** the main checkout is gone (its .git/worktrees entry no longer exists) → moved under <worktrees>/.orphaned, never deleted */
  parked: string[];
  /** everything now under <worktrees>/.orphaned (parked earlier or just now), so a caller can show it and offer a delete (deep A2-13) */
  parkedHeld?: OrphanedWorktree[];
  /** owned by a live pane → untouched */
  busy: string[];
  errors: { path: string; message: string }[];
  /** apparent size of the removed worktrees */
  reclaimedBytes: number;
  /** leftover agent branches (kora/*, worktree-agent-*) with no worktree, already merged into their repo's HEAD → deleted */
  branchesDeleted: string[];
  /** leftover agent branches with commits HEAD does not have → kept (the branch IS the ref that keeps the work) */
  branchesKept: { root: string; branch: string; ahead: number }[];
}
/**
 * Orphan sweep. A daemon killed mid-fleet, a worker that exited, a fleet whose repo was deleted — each leaves a
 * worktree under $KORA_HOME/worktrees that nothing removes. Measured before this existed: 56 stranded worktrees on
 * one machine, 11 of them pointing at main checkouts that no longer exist. Policy, in order of what can be lost:
 *   - live pane → busy, untouched
 *   - main checkout gone → PARKED (renamed under .orphaned/), because deleting is irreversible and the work may matter
 *   - clean (nothing beyond kora's own managed files, nothing ahead of main) → removed with its branch: nothing to lose
 *   - dirty or ahead → kept, reported as an orphan (the merge tool or a human decides)
 * Idempotent: a second run finds nothing. `git worktree prune` runs on every live main root at the end.
 */
/** How long a timed-out child's process group gets after SIGTERM (git cleans up its own index.lock on it) before SIGKILL. */
export const CHILD_KILL_GRACE_MS = 3_000;

/**
 * What a killed merge can leave in the checkout it merged into, each with the command that clears it. Checked after a
 * timeout so the error names the state the user's checkout is in instead of a bare "timed out".
 */
export function leftoverGitState(root: string): { file: string; fix: string }[] {
  const out: { file: string; fix: string }[] = [];
  const at = (name: string) => { const g = git(root, ['rev-parse', '--git-path', name]); return path.resolve(root, g.ok && g.out ? g.out : path.join('.git', name)); };
  try {
    const lock = at('index.lock');
    if (fs.existsSync(lock)) out.push({ file: lock, fix: `rm ${JSON.stringify(lock)} (no git is running there any more)` });
    const mh = at('MERGE_HEAD');
    if (fs.existsSync(mh)) out.push({ file: mh, fix: `git -C ${JSON.stringify(root)} merge --abort` });
  } catch { /* checkout gone */ }
  return out;
}

/**
 * Run one of this module's (synchronous, git-heavy) functions in a child process and resolve its JSON result.
 * Every function here is a chain of synchronous git calls; on the daemon's event loop they blocked it for 10–30 s under
 * swarm load (CPU profile, 10-leader e2e: sweep, worktree creation, merge) and dropped every UI websocket.
 */
export function worktreeInChild<T>(fn: 'sweepWorktrees' | 'mergeWorktree' | 'prepareAgentWorktree' | 'createWorktree', args: unknown[], timeoutMs = fn === 'mergeWorktree' ? MERGE_CHILD_TIMEOUT_MS : 120_000): Promise<T> {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  const code = `const w=require(${JSON.stringify(__filename)});Promise.resolve(w[${JSON.stringify(fn)}](...JSON.parse(process.env.KORA_WT_ARGS))).then((r)=>process.stdout.write(JSON.stringify(r===undefined?null:r)),(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(3)})`;
  // Its own process group (POSIX), killed whole on timeout: killing only the node child left the git under it running
  // (a merge going on in the user's checkout with nobody holding the merge lock any more).
  const group = process.platform !== 'win32';
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const opts = { env: { ...gitEnv(), KORA_WT_ARGS: JSON.stringify(args) }, detached: group, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' as const };
    const child = execFile(process.execPath, ['-e', code], opts, (err, out, errOut) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        let msg = `worktree ${fn} timed out after ${Math.round(timeoutMs / 1000)} s`;
        if (fn === 'mergeWorktree' && typeof args[0] === 'string') {
          let root: string | null = null; try { root = mergeTarget(args[0]); } catch { root = null; }
          const left = root ? leftoverGitState(root) : [];
          if (left.length) msg += ` — the merge was stopped part-way and left ${left.map((l) => `${path.basename(l.file)} (${l.file}); fix: ${l.fix}`).join('; ')}`;
        }
        return reject(new Error(msg));
      }
      if (err) return reject(new Error(String(errOut || '').trim() || err.message));
      try { resolve(JSON.parse(String(out))); } catch (e) { reject(e); }
    });
    let killTimer: NodeJS.Timeout | null = null;
    const signal = (sig: NodeJS.Signals) => { try { if (group && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first: git removes its own index.lock on it; SIGKILL whatever is still there after the grace.
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), CHILD_KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
  });
}

/** sweepWorktrees off the event loop (see worktreeInChild). */
export function sweepWorktreesInChild(opts: { live?: Iterable<string>; dryRun?: boolean; dir?: string; repos?: Iterable<string>; minAgeMs?: number } = {}): Promise<SweepResult> {
  return worktreeInChild<SweepResult>('sweepWorktrees', [{ live: Array.from(opts.live || []), dryRun: !!opts.dryRun, ...(opts.dir ? { dir: opts.dir } : {}), ...(opts.repos ? { repos: Array.from(opts.repos) } : {}), ...(opts.minAgeMs ? { minAgeMs: opts.minAgeMs } : {}) }]);
}

/**
 * A fresh agent worktree for `cwd0` plus the cwd inside it that mirrors `cwd0` (a subdirectory stays a subdirectory),
 * with Kora's report dir kept out of `git status`. null when `cwd0` is not a git repo with commits. Meant to run in a
 * child (worktreeInChild) — it is a handful of synchronous git calls.
 */
export function prepareAgentWorktree(cwd0: string, agent: string): { worktree: { path: string; branch: string; mainRoot: string }; cwd: string } | null {
  const root = mainRoot(cwd0);
  if (!root || !hasCommits(root)) return null;
  const w = createWorktree(cwd0, agent);
  let rel = '';
  try {
    const top = git(cwd0, ['rev-parse', '--show-toplevel']);
    if (top.ok) rel = path.relative(fs.realpathSync(top.out), fs.realpathSync(cwd0));
  } catch { rel = ''; }
  const cwd = rel && !rel.startsWith('..') && fs.existsSync(path.join(w.path, rel)) ? path.join(w.path, rel) : w.path;
  // info/exclude lives in the common dir (shared with the main checkout), so only Kora's own `.kora/`.
  try {
    const common = git(w.path, ['rev-parse', '--git-common-dir']);
    if (common.ok) {
      const ex = path.join(path.resolve(w.path, common.out), 'info', 'exclude');
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!/^\/?\.kora\/?$/m.test(cur)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.kora/\n`); }
    }
  } catch { /* cosmetic */ }
  return { worktree: { path: w.path, branch: w.branch, mainRoot: w.mainRoot }, cwd };
}

/** `minAgeMs`: a worktree created (or reported into) more recently counts as busy — a spawn creates its worktree before
 *  its pane is live, and a finished worker's report waits for its leader; a periodic sweep must take neither away. */
export function sweepWorktrees(opts: { live?: Iterable<string>; dryRun?: boolean; dir?: string; repos?: Iterable<string>; minAgeMs?: number } = {}): SweepResult {
  const base = opts.dir || worktreesDir();
  const live = new Set(Array.from(opts.live || []).map((p) => { try { return fs.realpathSync(p); } catch { return p; } }));
  const res: SweepResult = { scanned: 0, removed: [], orphans: [], parked: [], busy: [], errors: [], reclaimedBytes: 0, branchesDeleted: [], branchesKept: [] };
  const roots = new Set<string>();
  // Repos the caller knows about (chat threads, panes) — their leftover branches are swept even with no worktree left.
  // Keyed by real path: the same repo reached as /var/… and /private/var/… must be swept once.
  const realRoot = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  for (const r of opts.repos || []) { try { const m = mainRoot(r); if (m) roots.add(realRoot(m)); } catch { /* not a repo */ } }
  let repos: string[] = []; try { repos = fs.readdirSync(base).filter((n) => !n.startsWith('.')); } catch { repos = []; }
  for (const repo of repos) {
    const rdir = path.join(base, repo);
    let names: string[] = []; try { if (!fs.statSync(rdir).isDirectory()) continue; names = fs.readdirSync(rdir); } catch { continue; }
    for (const name of names) {
      const dir = path.join(rdir, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      res.scanned++;
      let real = dir; try { real = fs.realpathSync(dir); } catch { /* keep */ }
      if (live.has(real) || live.has(dir)) { res.busy.push(dir); continue; }
      if (opts.minAgeMs && Date.now() - lastTouched(dir) < opts.minAgeMs) { res.busy.push(dir); continue; }
      // the `.git` file of a linked worktree names its entry in the main checkout's .git/worktrees/
      let gitdir: string | null = null;
      try { const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8')); gitdir = m ? m[1].trim() : null; } catch { gitdir = null; }
      const parentAlive = !!gitdir && fs.existsSync(gitdir) && fs.existsSync(path.join(gitdir, 'commondir'));
      if (!parentAlive) {
        const park = path.join(base, '.orphaned', `${repo}-${name}-${Date.now().toString(36)}`);
        if (!opts.dryRun) { try { fs.mkdirSync(path.dirname(park), { recursive: true }); fs.renameSync(dir, park); } catch (e: any) { res.errors.push({ path: dir, message: String(e?.message || e) }); continue; } }
        res.parked.push(dir); continue;
      }
      const root = mainRoot(dir);
      if (root) roots.add(realRoot(root));
      let st: { dirty: number; ahead: number; branch: string | null };
      try { st = worktreeStatus(dir); } catch (e: any) { res.errors.push({ path: dir, message: String(e?.message || e) }); continue; }
      if (st.dirty === 0 && st.ahead === 0) {
        const size = dirBytes(dir);
        if (!opts.dryRun) { const r = removeWorktree(dir, { force: true, deleteBranch: true }); if (!r.ok) { res.errors.push({ path: dir, message: r.message }); continue; } }
        res.removed.push(dir); res.reclaimedBytes += size;
      } else res.orphans.push({ path: dir, branch: st.branch, dirty: st.dirty, ahead: st.ahead });
    }
    // an empty per-repo directory is litter
    try { if (!opts.dryRun && fs.readdirSync(rdir).length === 0) fs.rmdirSync(rdir); } catch { /* fine */ }
  }
  if (!opts.dryRun) for (const root of roots) git(root, ['worktree', 'prune']);
  for (const root of roots) sweepAgentBranches(root, res, !!opts.dryRun);
  res.parkedHeld = listOrphaned(base);
  return res;
}

/** When a worktree was created, or a swarm report in it last written (a report-only worker leaves a CLEAN tree whose
 *  report its leader has yet to read — `.kora/` is excluded from git status). */
function lastTouched(dir: string): number {
  let t = 0;
  try { const st = fs.statSync(dir); t = st.birthtimeMs || st.ctimeMs; } catch { return Date.now(); }
  const reports = path.join(dir, '.kora', 'swarm');
  try { for (const n of fs.readdirSync(reports)) { try { t = Math.max(t, fs.statSync(path.join(reports, n)).mtimeMs); } catch { /* gone */ } } } catch { /* none */ }
  return t;
}

/** Branch prefixes of agent worktrees: Kora's own, and Claude Code's `isolation: worktree` subagents. */
export const AGENT_BRANCH_RE = /^(kora\/|worktree-agent-)/;
/**
 * Leftover agent branches in `root`: an agent branch no worktree has checked out any more. One that HEAD already
 * contains (nothing to lose) is deleted; one with commits HEAD lacks is kept and reported — never deleted, the branch
 * is the only ref holding that work.
 */
function sweepAgentBranches(root: string, res: SweepResult, dryRun: boolean): void {
  const refs = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/kora/', 'refs/heads/worktree-agent-*']);
  if (!refs.ok || !refs.out) return;
  const inUse = new Set<string>();
  const wl = git(root, ['worktree', 'list', '--porcelain']);
  for (const line of wl.out.split('\n')) if (line.startsWith('branch ')) inUse.add(line.slice(7).replace(/^refs\/heads\//, ''));
  const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (!head || head === 'HEAD') return; // detached main checkout: "merged" has no meaning here, keep everything
  for (const branch of refs.out.split('\n').map((b) => b.trim()).filter((b) => AGENT_BRANCH_RE.test(b))) {
    if (inUse.has(branch) || branch === head) continue;
    const c = git(root, ['rev-list', '--count', `${head}..${branch}`]);
    const ahead = c.ok ? Number(c.out) || 0 : -1;
    if (ahead !== 0) { res.branchesKept.push({ root, branch, ahead }); continue; }
    if (!dryRun) { const d = git(root, ['branch', '-D', branch]); if (!d.ok) { res.errors.push({ path: `${root}#${branch}`, message: d.err || d.out }); continue; } }
    res.branchesDeleted.push(`${path.basename(root)}:${branch}`);
  }
}

/** Apparent size of a worktree on disk (bounded walk; symlinks not followed). */
function dirBytes(p: string, budget = { left: 200_000 }): number {
  let st: fs.Stats; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0; let names: string[] = []; try { names = fs.readdirSync(p); } catch { return 0; }
  for (const n of names) { if (--budget.left < 0) break; total += dirBytes(path.join(p, n), budget); }
  return total;
}

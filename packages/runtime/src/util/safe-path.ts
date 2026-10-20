// Filesystem guards for paths Kora computes from input it does not control: ids from the wire, files inside a
// repository someone else wrote, refs typed by a user or proposed by a model.
//
// A repository can commit SYMLINKS. Kora writes its managed files (CLAUDE.md / AGENTS.md blocks,
// .claude/settings.local.json hooks, .mcp.json, git hooks) into every repo under the trusted roots, often without the
// user opening it — so a cloned repo whose CLAUDE.md is a link to ~/.zshrc must never turn that write into an edit of
// ~/.zshrc. `unsafeRepoWrite` answers "would writing this file land somewhere other than inside the repo?".
import { koraHome } from '../protocol/types';
import fs from 'node:fs';
import path from 'node:path';
import { pathDepth } from './os-roots';

function lstatOrNull(p: string): fs.Stats | null { try { return fs.lstatSync(p); } catch { return null; } }
function realOrNull(p: string): string | null { try { return fs.realpathSync(p); } catch { return null; } }
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Why writing (or deleting) `file` is unsafe, or null when it is fine.
 *  - Without `root`: `file` must not be a symlink at all (the write would follow it wherever it points).
 *  - With `root` (the repository the file belongs to): `file` must be lexically inside it, and what the write would
 *    really touch — the symlink's target when `file` is a link (a repo's `CLAUDE.md -> AGENTS.md` is fine), else the
 *    nearest existing ancestor directory — must resolve inside `root`'s real path. A dangling link is refused (writing
 *    it would create its target wherever it points).
 * A `root` that does not exist yields null for the containment half (nothing on disk to escape through).
 */
export function unsafeRepoWrite(file: string, root?: string | null): string | null {
  const abs = path.resolve(file);
  const isLink = !!lstatOrNull(abs)?.isSymbolicLink();
  if (isLink && !root) return `${abs} is a symbolic link — not written through`;
  if (!root) return null;
  const realRoot = realOrNull(path.resolve(root));
  if (!realRoot) return isLink ? `${abs} is a symbolic link — not written through` : null;
  if (!inside(abs, path.resolve(root))) return `${abs} is outside ${root}`;
  if (isLink) {
    const target = realOrNull(abs);
    if (!target) return `${abs} is a dangling symbolic link — not written through`;
    return inside(target, realRoot) ? null : `${abs} links outside ${root} — not written through`;
  }
  let dir = path.dirname(abs);
  // Walk up to the first ancestor that exists; its real path must stay inside the real root.
  for (;;) {
    const real = realOrNull(dir);
    if (real) return inside(real, realRoot) ? null : `${abs} resolves outside ${root} (through a symbolic link)`;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Prefix for git runs Kora starts in someone else's repository: a `.git/config` naming an fsmonitor command (a
 *  worker can write that file — worktrees share it) must not get that command run by a background status/diff. */
export const GIT_NO_FSMONITOR = ['-c', 'core.fsmonitor=false'] as const;

/** Wall-clock cap for one git call Kora makes itself. A hung git (a credential or LFS prompt, an fsmonitor, a huge
 *  repo, a stale lock) must cost a bounded wait, never freeze the daemon: a synchronous call with no timeout blocks
 *  the event loop forever and drops every UI websocket. Callers that legitimately take longer pass their own. */
export const GIT_TIMEOUT_MS = Number(process.env.KORA_GIT_TIMEOUT_MS) > 0 ? Number(process.env.KORA_GIT_TIMEOUT_MS) : 30_000;
/** Output cap for one git call (a diff of a big tree); a larger output fails the call instead of growing unbounded. */
export const GIT_MAX_BUFFER = 64 << 20;

/**
 * Environment for git runs Kora starts itself: never wait for a credential prompt (the daemon is detached, so a
 * terminal / Git Credential Manager prompt could only hang until the timeout), and no optional locks (a background
 * `status` must not take `index.lock` from under the user's own git).
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * A git ref / branch name / revision that can safely be handed to git as a positional argument: non-empty, no
 * leading `-` (git would parse it as an OPTION: `--upload-pack=…`, `-f`, `--orphan`), no whitespace or control
 * characters, and bounded. Revision syntax (`HEAD~2`, `a..b`, `main^{commit}`, `@{u}`, SHAs) stays allowed.
 */
export function isSafeGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 512 && !ref.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(ref);
}

/**
 * A single path segment safe to join under a store root: non-empty, not `.`/`..`, no separators or NUL, bounded.
 * Used for ids that name a directory Kora may later `rm -rf`.
 */
export function isSafePathSegment(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && s !== '.' && s !== '..' && !/[/\\\x00]/.test(s);
}

/**
 * A directory that must never be removed recursively by a computed path: the filesystem root, the home dir or any
 * ancestor of it, or anything shallower than /a/b. `home` is resolved through symlinks too.
 */
export function isDangerousRmTarget(dir: string, home: string): boolean {
  const r = path.resolve(dir);
  const candidates = new Set([r, realOrNull(r) ?? r]);
  const homes = new Set([path.resolve(home), realOrNull(home) ?? path.resolve(home)]);
  const f = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p); // NTFS is case-insensitive
  for (const c of candidates) {
    if (pathDepth(c) < 2) return true; // the root (`/`, `C:\`) and one level below it
    for (const h of homes) if (f(c) === f(h) || f(h + path.sep).startsWith(f(c + path.sep))) return true;
  }
  return false;
}

let privateTmp: string | null = null;
/**
 * A per-user, owner-only directory for the hooks' small per-session marker files (turn counters, read logs, injected
 * prompt hashes). They used to sit directly in os.tmpdir() under predictable names: on a shared /tmp (Linux) another
 * local user could pre-create `kora-nudge-<session>-turn` as a symlink and have the hook overwrite a file of the
 * victim's. Resolved once per process; falls back to <KORA_HOME>/tmp when the tmp dir cannot be made private.
 */
export function privateTmpDir(): string {
  if (privateTmp) return privateTmp;
  const os = require('node:os') as typeof import('node:os');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const want = path.join(os.tmpdir(), `kora-${uid ?? 'u'}`);
  const ok = (dir: string): boolean => {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* checked below */ }
    const st = lstatOrNull(dir);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
    if (uid !== null && st.uid !== uid) return false;
    if ((st.mode & 0o077) !== 0) { try { fs.chmodSync(dir, 0o700); } catch { return false; } }
    return true;
  };
  if (ok(want)) return (privateTmp = want);
  const fallback = path.join(koraHome(), 'tmp');
  ok(fallback);
  return (privateTmp = fallback);
}
/** Tests: forget the resolved dir (TMPDIR changed). */
export function resetPrivateTmpDirForTests(): void { privateTmp = null; }

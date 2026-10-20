// Filesystem roots that no rule, index or scope may cover, per OS. Shared by the graph's unsafe-root checks
// (graph/embedded.ts) and the blob approval rules (blobs/approval-rules.ts). Also the small path helpers whose
// POSIX form used to be inlined as `/` string tests (isUnderDir, pathTail, expandTilde).
import os from 'node:os';
import path from 'node:path';

/** Windows system trees (from the environment, so a non-C: install is covered too). */
export function windowsSystemRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const sys = env.SystemRoot || env.windir || 'C:\\Windows';
  const drive = path.win32.parse(sys).root;
  return [sys, env.ProgramFiles || drive + 'Program Files', env['ProgramFiles(x86)'] || drive + 'Program Files (x86)', env.ProgramData || drive + 'ProgramData', drive + '$Recycle.Bin', drive + 'System Volume Information'];
}

/** Path segments below the filesystem / drive root: `/a/b` and `C:\a\b` are both 2. */
export function pathDepth(p: string): number { const r = path.resolve(p); return path.relative(path.parse(r).root, r).split(path.sep).filter(Boolean).length; }

/**
 * Is `target` the folder `root` or inside it? POSIX: a plain `/`-prefix test (what the callers always did). Windows:
 * either separator, case-folded (NTFS), so `C:/a/B/x` is under `c:\a\b`.
 */
export function isUnderDir(target: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return target === root || target.startsWith(root.replace(/\/+$/, '') + '/');
  if (!path.win32.isAbsolute(target) || !path.win32.isAbsolute(root)) return false;
  const t = path.win32.resolve(target).toLowerCase(), r = path.win32.resolve(root).toLowerCase();
  return t === r || t.startsWith(r.endsWith('\\') ? r : r + '\\');
}

/** The last `n` segments of a file path, joined with `/` for display (`src/foo.ts`). Windows splits on either separator. */
export function pathTail(p: string, n: number, platform: NodeJS.Platform = process.platform): string {
  return p.split(platform === 'win32' ? /[\\/]/ : '/').slice(-n).join('/');
}

/** `~` or `~/x` (also `~\x` on Windows) with the home folder put in; anything else unchanged. */
export function expandTilde(p: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  return p.replace(platform === 'win32' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, () => home);
}

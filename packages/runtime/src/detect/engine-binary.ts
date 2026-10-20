// Where an engine's CLI lives, for every driver (Claude, Codex, OpenCode) and the health checks.
//
// The daemon is started by the app / a login item with a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare
// `spawn('codex')` died with `spawn codex ENOENT` although the user runs `codex` in Terminal every day (found live in
// Blobs 2026-10-09; the same call serves plain Chat/Code Codex threads). One resolver instead of one per call site:
//   the daemon's PATH -> the places installers put binaries (~/.local/bin, Homebrew, npm/bun/pnpm/cargo/volta homes, every
//   nvm node version) -> what the user's login shell says (`$SHELL -ilc 'command -v <name>'`, async, cached).
// OpenCode keeps its richer resolver (server/swarm-install.ts: config path, ~/.kora/tools) and is asked first there.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envPath, exeCandidates, withEnvPath } from '../util/win-exec';

export type EngineName = 'claude' | 'codex' | 'opencode' | 'antigravity';

export const ENGINE_LABEL: Record<EngineName, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode (free models)', antigravity: 'Antigravity' };

/** PATH plus every place a CLI installer puts binaries that a GUI-launched daemon's PATH lacks. */
export function engineSearchDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dirs = (envPath(env) ?? '').split(path.delimiter).filter(Boolean);
  const add = (d: string) => { if (d && !dirs.includes(d)) dirs.push(d); };
  for (const d of [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'),
    path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm'), path.join(home, '.cargo', 'bin'),
    path.join(home, '.opencode', 'bin'),
  ]) add(d);
  if (process.platform === 'win32') {   // npm / pnpm / scoop / volta / Claude's native installer on Windows
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    for (const d of [path.join(appData, 'npm'), path.join(local, 'pnpm'), path.join(home, 'scoop', 'shims'),
      path.join(local, 'Volta', 'bin'), path.join(local, 'Programs', 'opencode'), path.join(local, 'Microsoft', 'WinGet', 'Links')]) add(d);
  }
  // nvm: every installed node version's global bin (newest first), and a configured NVM_BIN.
  if (env.NVM_BIN) add(env.NVM_BIN);
  try {
    const root = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
    const versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) add(path.join(root, v, 'bin'));
  } catch { /* no nvm */ }
  try { // fnm
    const alias = path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
    if (fs.existsSync(alias)) add(alias);
  } catch { /* none */ }
  return dirs;
}

function isExecutableFile(p: string): boolean {
  // Windows has no exec bit (X_OK is F_OK there): a file whose extension is in PATHEXT is executable.
  if (process.platform === 'win32') { try { return fs.statSync(p).isFile() && exeCandidates(p).length === 1; } catch { return false; } }
  try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

export interface EngineResolveDeps { env?: NodeJS.ProcessEnv; home?: string; isExecutable?: (p: string) => boolean; loginShell?: (name: string) => Promise<string | null> }

const hits = new Map<string, { at: number; path: string | null }>();
const loginHits = new Map<string, string>();
const TTL_HIT_MS = 60_000;
const TTL_MISS_MS = 5_000;

/** Explicit absolute paths the user set in Settings > Engines (name -> path). They win over the PATH search. */
const overrides = new Map<string, string>();
export function setEngineBinaryOverride(name: string, p: string | null): void {
  if (p && path.isAbsolute(p)) overrides.set(name, p); else overrides.delete(name);
  hits.delete(name);
}
export function engineBinaryOverride(name: string): string | null {
  const p = overrides.get(name);
  return p && isExecutableFile(p) ? p : null;
}

/** Synchronous and cheap (a few stats). Cached; a miss is re-checked after 5 s so an install is noticed quickly. */
export function resolveEngineBinary(name: string, deps: EngineResolveDeps = {}): string | null {
  const cacheable = !deps.env && !deps.home && !deps.isExecutable;
  if (cacheable) { const o = engineBinaryOverride(name); if (o) return o; }
  if (cacheable) {
    const c = hits.get(name);
    if (c && Date.now() - c.at < (c.path ? TTL_HIT_MS : TTL_MISS_MS)) return c.path;
  }
  const isExec = deps.isExecutable ?? isExecutableFile;
  let found: string | null = null;
  for (const dir of engineSearchDirs(deps.env, deps.home)) {
    for (const file of exeCandidates(path.join(dir, name))) if (isExec(file)) { found = file; break; }
    if (found) break;
  }
  if (!found) { const l = loginHits.get(name); if (l && isExec(l)) found = l; }
  if (cacheable) hits.set(name, { at: Date.now(), path: found });
  return found;
}

/** Ask the user's login shell (PATH set in .zshrc / .zprofile, version managers). 5 s cap; never throws. */
function probeLoginShell(name: string): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);   // no login shell; PATH comes from the registry
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return new Promise((resolve) => {
    try {
      const cp = execFile(shell, ['-ilc', `command -v ${name}`], { timeout: 5000, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
        if (err && !stdout) return resolve(null);
        const hit = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && path.basename(l) === name).pop();
        resolve(hit ?? null);
      });
      cp.stdin?.end();
    } catch { resolve(null); }
  });
}

/** resolveEngineBinary, then (once, cached) the login-shell probe. For the spawn path of a turn. */
export async function resolveEngineBinaryAsync(name: string, deps: EngineResolveDeps = {}): Promise<string | null> {
  const sync = resolveEngineBinary(name, deps);
  if (sync) return sync;
  const hit = await (deps.loginShell ?? probeLoginShell)(name);
  const isExec = deps.isExecutable ?? isExecutableFile;
  if (hit && isExec(hit)) {
    if (!deps.loginShell) { loginHits.set(name, hit); hits.delete(name); }
    return hit;
  }
  return null;
}

/** The env a spawned engine gets: PATH widened so the CLI (and the `node` / `git` it shells out to) is found. */
export function engineSpawnEnv(env: NodeJS.ProcessEnv, bin?: string | null): NodeJS.ProcessEnv {
  const dirs = engineSearchDirs(env);
  // The resolved binary's own folder goes first (moved there when it is already on the list), so a shim that starts a
  // sibling (npm's codex.cmd -> node, the runtime it bundles) finds the same install.
  if (bin && path.isAbsolute(bin)) { const d = path.dirname(bin); const i = dirs.indexOf(d); if (i > 0) dirs.splice(i, 1); if (i !== 0) dirs.unshift(d); }
  return withEnvPath(env, dirs.join(path.delimiter));
}

/** A person-readable sentence for a failed spawn (ENOENT / EACCES), or null when it is some other error. */
export function engineSpawnProblem(engine: EngineName, err: unknown): string | null {
  const e = err as { code?: string; message?: string; path?: string; syscall?: string } | null;
  const text = String(e?.message ?? err ?? '');
  const code = e?.code ?? (/\bENOENT\b/.test(text) ? 'ENOENT' : /\bEACCES\b/.test(text) ? 'EACCES' : '');
  if (code !== 'ENOENT' && code !== 'EACCES') return null;
  // spawn ENOENT can also mean the working folder is gone; the manager checks that before it starts a session.
  const who = ENGINE_LABEL[engine];
  return code === 'EACCES'
    ? `${who} is installed but Kora isn't allowed to run it. Check the file's permissions, or reinstall it in Settings › Engines.`
    : `${who} isn't installed or Kora can't find it. Open Settings › Engines to install it or point Kora at it.`;
}

/** Test seam. */
export function resetEngineBinaryCacheForTests(): void { hits.clear(); loginHits.clear(); overrides.clear(); }

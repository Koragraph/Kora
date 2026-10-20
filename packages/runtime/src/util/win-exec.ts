// Starting programs on Windows. Three things differ from macOS/Linux and each one broke a plain `spawn(name, args)`:
//   1. A bare name is looked up with PATHEXT, but Node only tries .com/.exe, so `codex` (npm installs `codex.cmd`) is
//      ENOENT.
//   2. A .cmd/.bat cannot be spawned directly (Node refuses with EINVAL since the 2024 batch-file fix); it needs
//      cmd.exe, and cmd.exe re-parses the command line (& | < > ^ % are live).
//   3. There is no /bin/sh: a POSIX shell is Git for Windows' bash.exe when installed (Claude Code requires it too).
// `winCommand` turns a (command, args) pair into one spawn can run: npm's .cmd shims are unwrapped to `node <script>`
// (no cmd.exe, no quoting hazards); any other batch file goes through `cmd.exe /d /s /c` with every argument escaped.
// On macOS/Linux every function here returns its input unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const win = process.platform === 'win32';

export function pathExts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
}

/**
 * PATH of an env object. `process.env` is case-insensitive on Windows, but a copy (`{ ...process.env }`) is a plain
 * object holding `Path`, so `copy.PATH` is undefined there.
 */
export function envPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PATH !== undefined || !win) return env.PATH;
  const k = Object.keys(env).find((n) => n.toUpperCase() === 'PATH');
  return k ? env[k] : undefined;
}

/** `env` with PATH set to `value`, any other spelling (`Path`) removed so two PATHs never reach the child. */
export function withEnvPath<E extends Record<string, string | undefined>>(env: E, value: string): E {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!(win && k !== 'PATH' && k.toUpperCase() === 'PATH')) out[k] = v;
  out.PATH = value;
  return out as E;
}

/** A bare env for a short node child: PATH, plus what Windows programs need to start (SystemRoot, temp, profile). */
export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: envPath(process.env) ?? '' };
  if (win) for (const k of ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'ComSpec']) if (process.env[k]) out[k] = process.env[k];
  return { ...out, ...extra };
}

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** `file` itself and `file` + every PATHEXT extension (Windows); just `file` elsewhere. */
export function exeCandidates(file: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [file];
  const ext = path.win32.extname(file).toLowerCase();
  const exts = pathExts(env);
  if (ext && exts.includes(ext)) return [file];
  return [...exts.map((e) => file + e), file];
}

/** First match of `name` on PATH (with PATHEXT on Windows), or null. */
export function whichSync(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(name)) { for (const c of exeCandidates(name, env)) if (isFile(c)) return c; return null; }
  const pathVar = envPath(env) ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const c of exeCandidates(path.join(dir, name), env)) if (isFile(c)) return c;
  }
  return null;
}

/**
 * The JS entry an npm-generated .cmd shim runs (`"%_prog%" "%dp0%\node_modules\pkg\bin\x.js" %*`), or null when the
 * batch file is something else.
 */
export function npmShimTarget(cmdFile: string): string | null {
  let text: string;
  try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return null; }
  // npm / pnpm shims start node; VS Code's code.cmd runs Code.exe with ELECTRON_RUN_AS_NODE (not ours to unwrap).
  if (!/\bnode(\.exe)?\b|%_prog%/i.test(text) || /ELECTRON_RUN_AS_NODE/i.test(text)) return null;
  const m = /"%(?:~?dp0%?|_prog%)[\\/]?([^"%]+\.(?:c|m)?js)"\s+%\*/i.exec(text) ?? /"%~?dp0%?\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  const target = path.resolve(path.dirname(cmdFile), m[1]!.replace(/\\/g, path.sep));
  return isFile(target) ? target : null;
}

/**
 * Kora's own launcher shim (`<shims>\claude.cmd`, enforce/shims.ts renderWinAgentCmd): the node + entry + agent it
 * runs, so a spawn of it skips cmd.exe (which cuts a multi-line argument such as the rulebook prompt at the newline).
 */
export function koraShimTarget(cmdFile: string): { node: string; args: string[] } | null {
  let text: string;
  try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return null; }
  const m = /^"([^"]+)" "([^"]+)" --shims-dir "%~dp0\." ([\w-]+) %\*\r?$/m.exec(text);
  if (!m) return null;
  const unbat = (s: string) => s.replace(/%%/g, '%');
  return { node: unbat(m[1]!), args: [unbat(m[2]!), '--shims-dir', path.dirname(cmdFile), m[3]!] };
}

// cmd.exe metacharacters, escaped with ^ (what cross-spawn does). Arguments are first quoted MSVC-style, then every
// metachar — the quotes included — is caret-escaped, so cmd.exe passes the argument through untouched.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function quoteArg(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${a}"`;
}
/** `double`: the target is a batch file, which expands its arguments once more (cross-spawn does the same). */
export function cmdEscapeArg(arg: string, double = false): string {
  const once = quoteArg(arg).replace(CMD_META, '^$1');
  return double ? once.replace(CMD_META, '^$1') : once;
}

export interface SpawnTarget { command: string; args: string[]; windowsVerbatimArguments?: boolean }

/** A (command, args) pair spawn() can run on this platform. See the header. */
export function winCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, nodeBin = process.execPath): SpawnTarget {
  if (!win) return { command, args: [...args] };
  const resolved = whichSync(command, env) ?? command;
  const ext = path.win32.extname(resolved).toLowerCase();
  // A `#!` script (`fake-claude.sh`, a user's wrapper) is not runnable by Windows itself: Git bash runs it.
  if (!pathExts(env).includes(ext) && isShebangScript(resolved)) {
    const bash = gitBash(env);
    if (bash) return { command: bash, args: [resolved, ...args] };
  }
  if (ext !== '.cmd' && ext !== '.bat') return { command: resolved, args: [...args] };
  const ks = koraShimTarget(resolved);
  if (ks) return { command: ks.node, args: [...ks.args, ...args] };
  const js = npmShimTarget(resolved);
  if (js) return { command: nodeBin, args: [js, ...args] };
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const line = [cmdEscapeArg(resolved), ...args.map((a) => cmdEscapeArg(a))].join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

function isShebangScript(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    try { const b = Buffer.alloc(2); return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === '#!'; } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** Git for Windows' bash.exe, or null. */
export function gitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!win) return null;
  const cands = [
    env.KORA_GIT_BASH,
    env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of cands) if (c && isFile(c)) return c;
  const git = whichSync('git', env);   // <Git>\cmd\git.exe → <Git>\bin\bash.exe
  if (git) { const b = path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'); if (isFile(b)) return b; }
  return null;
}

/** The user's interactive shell for a terminal pane. */
export function userShell(env: NodeJS.ProcessEnv = process.env): string {
  if (!win) return env.SHELL || '/bin/sh';
  return gitBash(env) ?? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
}

/** `sh -c <script>` on this platform: /bin/sh, Git bash, or cmd.exe as the last resort. */
export function shellCommand(script: string, env: NodeJS.ProcessEnv = process.env): SpawnTarget {
  if (!win) return { command: '/bin/sh', args: ['-c', script] };
  const bash = gitBash(env);
  if (bash) return { command: bash, args: ['-c', script] };
  return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${script}"`], windowsVerbatimArguments: true };
}

/** A path git printed (`rev-parse --show-toplevel`, `worktree list`): `C:/a/b` on Windows becomes `C:\a\b`, so it
 *  compares equal to the paths Node builds. Unchanged elsewhere, and '' stays ''. */
export function gitPath(p: string): string;
export function gitPath(p: string | null): string | null;
export function gitPath(p: string | null): string | null {
  return win && p ? path.win32.resolve(p) : p;
}

/** Windows: end a process and every process it started (`taskkill /T /F`); there are no process groups to signal. */
export function killTreeWindows(pid: number): void {
  if (!win || !pid) return;
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
  } catch { /* gone */ }
}

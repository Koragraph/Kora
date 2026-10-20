// @effect-diagnostics nodeBuiltinImport:off -- spawn-target resolution reads PATH and the first bytes of files.
// Starting a CLI on Windows (codex, agy, an editor): the ui-server's copy of the runtime's util/win-exec.ts, kept in
// step with it (the ui-server is bundled on its own and cannot import the runtime). On Windows a bare name is looked up
// with PATHEXT, an npm `.cmd` shim runs as `node <script>`, any other batch file through `cmd.exe /d /s /c` with every
// argument caret-escaped, and a `#!` script under Git bash. Everywhere else every function returns its input unchanged.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const win = process.platform === "win32";

export interface SpawnTarget {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function pathExts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

/** PATH of an env object: a copy of `process.env` holds `Path` on Windows, so `copy.PATH` is undefined there. */
export function envPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PATH !== undefined || !win) return env.PATH;
  const k = Object.keys(env).find((n) => n.toUpperCase() === "PATH");
  return k ? env[k] : undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `file` itself and `file` + every PATHEXT extension (Windows); just `file` elsewhere. */
export function exeCandidates(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [file];
  const ext = path.win32.extname(file).toLowerCase();
  const exts = pathExts(env);
  if (ext && exts.includes(ext)) return [file];
  return [...exts.map((e) => file + e), file];
}

/** First runnable `name` on PATH (with PATHEXT on Windows), or null. */
export function whichSync(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (path.isAbsolute(name)) {
    for (const c of exeCandidates(name, env)) if (isFile(c)) return c;
    return null;
  }
  for (const dir of (envPath(env) ?? "").split(path.delimiter).filter(Boolean)) {
    for (const c of exeCandidates(path.join(dir, name), env)) if (isFile(c)) return c;
  }
  return null;
}

/** The JS entry an npm-generated .cmd shim runs, or null when the batch file is something else. */
export function npmShimTarget(cmdFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cmdFile, "utf8");
  } catch {
    return null;
  }
  // npm / pnpm shims start node; VS Code's code.cmd runs Code.exe with ELECTRON_RUN_AS_NODE (not ours to unwrap).
  if (!/\bnode(\.exe)?\b|%_prog%/i.test(text) || /ELECTRON_RUN_AS_NODE/i.test(text)) return null;
  const m =
    /"%(?:~?dp0%?|_prog%)[\\/]?([^"%]+\.(?:c|m)?js)"\s+%\*/i.exec(text) ??
    /"%~?dp0%?\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!m) return null;
  const target = path.resolve(path.dirname(cmdFile), m[1]!.replace(/\\/g, path.sep));
  return isFile(target) ? target : null;
}

/** Kora's own launcher shim (`<shims>\claude.cmd`): its node + entry + agent, so a spawn skips cmd.exe. */
export function koraShimTarget(cmdFile: string): { node: string; args: string[] } | null {
  let text: string;
  try {
    text = fs.readFileSync(cmdFile, "utf8");
  } catch {
    return null;
  }
  const m = /^"([^"]+)" "([^"]+)" --shims-dir "%~dp0\." ([\w-]+) %\*\r?$/m.exec(text);
  if (!m) return null;
  const unbat = (s: string) => s.replace(/%%/g, "%");
  return {
    node: unbat(m[1]!),
    args: [unbat(m[2]!), "--shims-dir", path.dirname(cmdFile), m[3]!],
  };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** MSVC-quote, then caret-escape every cmd.exe metacharacter; `double` for a batch-file target (it expands again). */
export function cmdEscapeArg(arg: string, double = false): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const once = quoted.replace(CMD_META, "^$1");
  return double ? once.replace(CMD_META, "^$1") : once;
}

function isShebangScript(p: string): boolean {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const b = Buffer.alloc(2);
      return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString("latin1") === "#!";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Git for Windows' bash.exe, or null. */
export function gitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!win) return null;
  const cands = [
    env.KORA_GIT_BASH,
    env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "Git",
      "bin",
      "bash.exe",
    ),
  ];
  for (const c of cands) if (c && isFile(c)) return c;
  const git = whichSync("git", env);
  if (git) {
    const b = path.join(path.dirname(path.dirname(git)), "bin", "bash.exe");
    if (isFile(b)) return b;
  }
  return null;
}

/** A (command, args) pair spawn() / execFile() can run on this platform. */
export function winCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
  nodeBin = process.execPath,
): SpawnTarget {
  if (!win) return { command, args: [...args] };
  const resolved = whichSync(command, env) ?? command;
  const ext = path.win32.extname(resolved).toLowerCase();
  if (!pathExts(env).includes(ext) && isShebangScript(resolved)) {
    const bash = gitBash(env);
    if (bash) return { command: bash, args: [resolved, ...args] };
  }
  if (ext !== ".cmd" && ext !== ".bat") return { command: resolved, args: [...args] };
  const ks = koraShimTarget(resolved);
  if (ks) return { command: ks.node, args: [...ks.args, ...args] };
  const js = npmShimTarget(resolved);
  if (js) return { command: nodeBin, args: [js, ...args] };
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  const line = [cmdEscapeArg(resolved), ...args.map((a) => cmdEscapeArg(a))].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** Windows: end a process and every process it started (`taskkill /T /F`); there are no process groups to signal. */
export function killTreeWindows(pid: number): void {
  if (!win || !pid) return;
  try {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    }).unref();
  } catch {
    /* gone */
  }
}

interface Killable {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(sig?: NodeJS.Signals): boolean;
}

/**
 * `child.kill(sig)`, or on Windows the end of that exact pid's tree while it still runs: a signal there ends only the
 * one process, and a CLI behind `cmd.exe /c` outlived it. The runtime's util/kill-child.ts, kept in step.
 */
export function killChild(
  child: Killable,
  sig: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
  killTree: (pid: number) => void = killTreeWindows,
): void {
  if (platform === "win32" && child.pid) {
    if (child.exitCode == null && child.signalCode == null) killTree(child.pid);
    return;
  }
  child.kill(sig);
}

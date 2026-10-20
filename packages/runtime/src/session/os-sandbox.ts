// OS-level read-deny for the lanes that have no tool hooks (audit 2026-10-13 S2-1).
//
// Claude's SDK lane and Claude panes have PreToolUse hooks (sensitive-guard.ts). Antigravity, Codex, OpenCode and
// Gemini do not, and Full access / Auto turn on each one's "skip all permissions" flag. So the CLI itself is started
// under a macOS Seatbelt profile (`sandbox-exec -p`) that allows everything EXCEPT reading or writing the credential
// paths the guard names: ~/.ssh, ~/.aws, cloud/CLI logins, browser profiles, shell history, Kora's own `ui-token`.
// What the engine itself needs to log in (its own auth file) is carved out per engine. This is a read fence, not a
// full sandbox: file METADATA stays visible (so `ls` and `realpath` behave), the network and every other path are open.
//
// It is a no-op where unsupported: not macOS, no /usr/bin/sandbox-exec, a probe that fails (e.g. we already run inside
// a profile that forbids applying another), the override KORA_ALLOW_SENSITIVE_PATHS=1, or KORA_OS_SANDBOX=0.
// Codex applies its own Seatbelt profile on top for its Auto/Read-only postures; nested profiles stack (checked).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SENSITIVE_HOME_PATHS, sensitiveOverride } from './sensitive-guard';
import { koraHome } from '../protocol/types';
import { envPath, shellCommand, winCommand, withEnvPath, type SpawnTarget } from '../util/win-exec';

/** Engines started under the fence. Claude is guarded by hooks instead (its CLI needs ~/.claude.json itself). `check`: a
 *  shell command Kora runs for a swarm task (the foreman's done-check, its baseline), with no login of its own. */
export type SandboxedEngine = 'codex' | 'antigravity' | 'gemini' | 'opencode' | 'koragent' | 'check' | 'acp' | 'claude';

/** Home-relative paths the engine's OWN process must be able to read to run (its login). */
const OWN_FILES: Record<SandboxedEngine, readonly string[]> = {
  codex: ['.codex/auth.json', '.codex/config.toml'],
  antigravity: ['.gemini/antigravity-cli/antigravity-oauth-token', '.gemini/oauth_creds.json'],
  gemini: ['.gemini/oauth_creds.json', '.gemini/antigravity-cli/antigravity-oauth-token'],
  opencode: ['.local/share/opencode/auth.json', '.config/opencode/auth.json'],
  koragent: [],
  check: [],
  acp: [],
  claude: [],
};

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let probed: boolean | null = null;

/** Does a Seatbelt profile apply here? Probed once (a trivial profile around /usr/bin/true). */
export function osSandboxSupported(): boolean {
  if (probed !== null) return probed;
  if (process.platform !== 'darwin' || process.env.KORA_OS_SANDBOX === '0' || !fs.existsSync(SANDBOX_EXEC)) return (probed = false);
  try {
    const r = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
    probed = r.status === 0;
  } catch { probed = false; }
  return probed;
}

const q = (p: string): string => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function realOrSelf(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

/**
 * Sensitive paths the OS fence must NOT deny. ~/Library/Keychains: a fenced process that uses the keychain the normal way
 * (git's osxkeychain helper, a CLI's saved login) cannot open the default keychain, and macOS then raises "A keychain
 * cannot be found" with a one-click "Reset To Defaults" that wipes the user's passwords (seen 2026-10-14). The keychain
 * files are encrypted and every item is guarded by macOS's own access prompt, so the fence adds nothing there; the text
 * guard (sensitive-guard.ts) still refuses an agent's Read of the folder and `security find-*-password` / `dump-keychain`.
 */
const NOT_FENCED: ReadonlySet<string> = new Set(['Library/Keychains']);

/** Seatbelt filters for every Kora home's control token (`ui-token` in `~/.kora`, `~/.kora-dev`, … and `$KORA_HOME`). */
function tokenRules(homes: readonly string[], koraHome: string | null): string[] {
  const rules = homes.map((h) => `(regex #"^${reEsc(h)}/\\.kora[^/]*/ui-token$")`);
  if (koraHome) for (const k of new Set([koraHome, realOrSelf(koraHome)])) rules.push(`(literal ${q(path.join(k, 'ui-token'))})`);
  return rules;
}

/**
 * Claude's fence (2026-10-15 audit #4): ONLY the control token. Claude's hooks (sensitive-guard.ts) guard every other
 * credential, and they read text, so a glob, a shell variable or a script that drops the agent marker before running
 * `kora` got the token past them. The kernel now refuses the file to the Claude process and everything it runs, whatever
 * the spelling. Nothing else changes for Claude: its own login (~/.claude.json, keychain), `open` for /login, and every
 * other path stay as they were.
 */
export function claudeTokenProfile(home: string = os.homedir(), koraHome: string | null = process.env.KORA_HOME || null): string {
  return `(version 1)\n(allow default)\n(deny file-read-data file-write* ${tokenRules([...new Set([home, realOrSelf(home)])], koraHome).join(' ')})\n`;
}

/** The Seatbelt source for one engine. Pure (home and Kora home are arguments) so tests can read it. */
export function sandboxProfile(engine: SandboxedEngine, home: string = os.homedir(), koraHome: string | null = process.env.KORA_HOME || null, extraOwn: readonly string[] = []): string {
  if (engine === 'claude') return claudeTokenProfile(home, koraHome);
  const homes = [...new Set([home, realOrSelf(home)])];
  const own = new Set([...OWN_FILES[engine], ...extraOwn]);
  const rules: string[] = [];
  for (const h of homes) {
    for (const rel of SENSITIVE_HOME_PATHS) {
      if (own.has(rel) || NOT_FENCED.has(rel)) continue;
      rules.push(`(subpath ${q(path.join(h, rel))})`);
    }
  }
  // Every Kora home variant (~/.kora, ~/.kora-dev): the control token. Not trust.json / accounts: the sandboxed engine's own
  // hooks and per-account homes live there. kora.sock stays connectable (the fleet tools dial it); what it may DO is gated
  // by the control token (server/control-auth.ts).
  rules.push(...tokenRules(homes, koraHome));
  // Private signing / API key files anywhere (sensitive-guard PRIVATE_KEY_FILE): an Apple `AuthKey_<id>.p8`, a `.p12` cert.
  rules.push('(regex #"\\.([pP]8|[pP]12|[pP][fF][xX]|[jJ][kK][sS]|[kK][eE][yY][sS][tT][oO][rR][eE])$")');
  // Antigravity / Gemini fall back to an OAuth sign-in in the default browser when a token refresh fails; nothing an
  // agent runs may open one (audit S2-1, aud1): `open` itself is refused, the PATH shim below catches the by-name case.
  // Unattended swarm workers (OpenCode, Koragent) and done-checks never act on the user's desktop either: their
  // `open *` permission deny matches the command text only, so `/usr/bin/open <url>` popped a browser tab (A3-4).
  // Kora's own control files are WRITE-denied (deep A1 D2): a fenced agent that rewrote config.json / settings.json /
  // engines.json / chat/<id>/meta.json / mcp / shims / app would escalate for good. Reads stay allowed. The daemon (outside
  // the fence) writes them; nothing the engine's own hooks run does.
  // S6 re-audit 2026-10-14: the same applies to every other file or folder the daemon, a Kora terminal or the next engine start
  // EXECUTES or TRUSTS without the fence: trust.json (a planted folder gets its own hooks/MCP run in the unfenced Claude lane),
  // claude-accounts.json (a configDir whose settings.json holds hooks), savings.json, prune-forks.json (the daemon unlinks the
  // files it names), blob-defaults.json, shell/ (rc files sourced by Kora's terminals), tools/ (the OpenCode binary), agy-guard/, workers/ (a sleeping worker's launch flags are reused on wake), swarm/tasks.json (unfinished tasks resume from it) and
  // opencode/plugins/ (the plugin the next worker loads; OpenCode itself needs the rest of opencode/ writable).
  const ctl = '(config\\.json|settings\\.json|engines\\.json|trust\\.json|claude-accounts\\.json|savings\\.json|prune-forks\\.json|blob-defaults\\.json|swarm/tasks\\.json|(mcp|shims|app|shell|tools|agy-guard|workers|opencode/plugins)(/.*)?|chat/[^/]+/meta\\.json)';
  const wRules: string[] = homes.map((h) => `(regex #"^${reEsc(h)}/\\.kora[^/]*/${ctl}$")`);
  if (koraHome) for (const k of new Set([koraHome, realOrSelf(koraHome)])) wRules.push(`(regex #"^${reEsc(k)}/${ctl}$")`);
  const noBrowser = engine === 'codex' ? '' : '\n(deny process-exec (literal "/usr/bin/open"))';
  return `(version 1)\n(allow default)\n(deny file-read-data file-write* ${rules.join(' ')})\n(deny file-write* ${wRules.join(' ')})${noBrowser}\n`;
}

/** `command args` as the engine should run: wrapped in the fence when supported, unchanged otherwise. */
export function wrapReadDeny(engine: SandboxedEngine, command: string, args: readonly string[], extraOwn: readonly string[] = []): SpawnTarget {
  // Windows: no Seatbelt; resolve .cmd shims / PATHEXT, and `/bin/sh -c` becomes Git bash (util/win-exec.ts).
  if (process.platform === 'win32') return command === '/bin/sh' && args[0] === '-c' && args.length === 2 ? shellCommand(args[1]!) : winCommand(command, args);
  if (sensitiveOverride() || !osSandboxSupported()) return { command, args: [...args] };
  return { command: SANDBOX_EXEC, args: ['-p', sandboxProfile(engine, os.homedir(), process.env.KORA_HOME || null, extraOwn), command, ...args] };
}

/**
 * The fence for a user-configured ACP engine (deep A1 D6). Gemini's own login is carved out as in its CLI lane; a custom
 * engine whose binary is a Claude or Codex adapter keeps that CLI's login (it cannot run without it); every other
 * credential stays denied. Pure, so tests can read it.
 */
export function acpFence(agentId: string, command: string): { engine: SandboxedEngine; extraOwn: string[] } {
  if (agentId === 'gemini') return { engine: 'gemini', extraOwn: [] };
  const bin = path.basename(command).toLowerCase();
  const extraOwn: string[] = [];
  if (/claude/.test(bin)) extraOwn.push('.claude.json', '.claude/.credentials.json');
  if (/codex/.test(bin)) extraOwn.push('.codex/auth.json', '.codex/config.toml');
  return { engine: 'acp', extraOwn };
}

/** The sandboxed engine behind a pane's agent id, or null (shells and unknown agents run as before). Claude gets the token-only fence. */
export function sandboxedEngineFor(agent: string | undefined): SandboxedEngine | null {
  return agent === 'codex' || agent === 'antigravity' || agent === 'gemini' || agent === 'opencode' || agent === 'koragent' || agent === 'claude' ? agent : null;
}

/**
 * The SDK chat lane's `spawnClaudeCodeProcess` (2026-10-15 audit #4): the Claude CLI started under claudeTokenProfile.
 * Undefined where no fence applies (not macOS, KORA_OS_SANDBOX=0, the sensitive-path override), so the SDK spawns as
 * before. stdio and the abort signal are what the SDK's own local spawn uses; a ChildProcess satisfies its interface.
 */
export function fencedClaudeSpawn(): ((o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) => import('node:child_process').ChildProcess) | undefined {
  if (process.platform === 'win32' || sensitiveOverride() || !osSandboxSupported()) return undefined;
  return (o) => {
    const w = wrapReadDeny('claude', o.command, o.args);
    return spawn(w.command, w.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], ...(o.signal ? { signal: o.signal } : {}), windowsHide: true });
  };
}

/** Test seam. */
export function resetOsSandboxProbeForTests(v: boolean | null = null): void { probed = v; }

/**
 * Env for an Antigravity/Gemini process: a PATH whose first entry holds `open` / `xdg-open` stand-ins that refuse, and
 * BROWSER=true, so an OAuth fallback cannot open sign-in tabs. The rest of PATH is the user's (agents need their tools).
 */
export function withBrowserGuard<E extends Record<string, string | undefined>>(env: E): E {
  try {
    const dir = path.join(koraHome(), 'agy-guard');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of ['open', 'xdg-open', 'sensible-browser']) {
      const f = path.join(dir, name);
      const body = '#!/bin/sh\necho "kora: an agent tried to open a browser ($*); blocked. Sign in from Kora Settings." >&2\nexit 1\n';
      let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
      if (cur !== body) fs.writeFileSync(f, body, { mode: 0o755 });
    }
    const parts = (envPath(env) ?? '').split(path.delimiter).filter((x) => x && x !== dir);
    return { ...withEnvPath(env, [dir, ...parts].join(path.delimiter)), BROWSER: '/usr/bin/true' };
  } catch { return env; }
}

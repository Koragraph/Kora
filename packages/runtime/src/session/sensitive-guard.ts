// Sensitive-path guard: a PreToolUse hook that survives "Full access" (SDK bypassPermissions).
//
// Full access means the agent may edit and run anything in the project, not that it may read the keys to the rest of
// the Mac: ~/.ssh, ~/.aws, ~/.gnupg, keychains, browser profiles, other tools' credentials and Kora's own
// `ui-token` (which grants control of the daemon). A prompt-injected page or README is the realistic attacker, so
// those reads/writes are DENIED in Full access and ASK in every other mode. This is a guard, not a sandbox: a shell
// line can obscure a path (variables, base64, a script that builds it), so it catches the direct, obvious reads that an
// injected instruction produces. Override for a power user who really wants it: KORA_ALLOW_SENSITIVE_PATHS=1 in the
// daemon's environment.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Folders/files under $HOME the agent must not touch unprompted (relative to home, no leading slash). */
export const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.docker/config.json', '.config/gcloud', '.config/gh', '.config/op',
  '.npmrc', '.pypirc', '.git-credentials', '.claude/.credentials.json', '.codex/auth.json', '.azure',
  'Library/Keychains', 'Library/Cookies', 'Library/Safari',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc', 'Library/Application Support/com.operasoftware.Opera',
  // Other agents' logins and the user's history (audit 2026-10-13 S3-1). Each engine's OWN file is re-allowed for that
  // engine's process in session/os-sandbox.ts; the agent tools of every lane stay denied.
  '.claude.json', '.gemini/antigravity-cli/antigravity-oauth-token', '.gemini/oauth_creds.json',
  '.local/share/opencode/auth.json', '.config/opencode/auth.json', '.codex/config.toml', '.config/git/credentials',
  '.zsh_history', '.zhistory', '.bash_history', '.python_history', '.node_repl_history', '.local/share/fish/fish_history',
  'Library/Messages', 'Library/Application Support/Slack', 'Library/Application Support/discord',
  // Windows: Credential Manager's and DPAPI's stores (the Keychain's counterparts; Kora's own secrets live there too).
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
  'AppData/Local/Microsoft/Vault',
] as const;

/**
 * Windows only (relative to %USERPROFILE%), on top of SENSITIVE_HOME_PATHS: browser profiles under %LOCALAPPDATA% /
 * %APPDATA%, PowerShell's history (PSReadLine, which Windows Terminal's shells write), gh's hosts.yml, Git Credential
 * Manager's file stores, npm's global npmrc, the Azure / gcloud / Microsoft sign-in caches and the chat apps. Kept apart
 * so the macOS Seatbelt profile (os-sandbox.ts) and every macOS answer stay exactly as they were.
 */
export const WINDOWS_SENSITIVE_HOME_PATHS = [
  'AppData/Local/Google/Chrome', 'AppData/Local/Chromium', 'AppData/Local/Microsoft/Edge', 'AppData/Local/BraveSoftware',
  'AppData/Roaming/Mozilla/Firefox', 'AppData/Roaming/Opera Software', 'AppData/Local/Vivaldi',
  'AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine',
  'AppData/Roaming/GitHub CLI', '.gcm', 'AppData/Roaming/npm/etc/npmrc',
  'AppData/Roaming/gcloud', 'AppData/Local/.IdentityService',
  'AppData/Roaming/Slack', 'AppData/Roaming/discord',
] as const;

/** The home-relative sensitive paths on `platform`. */
export function sensitiveHomePaths(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? [...SENSITIVE_HOME_PATHS, ...WINDOWS_SENSITIVE_HOME_PATHS] : SENSITIVE_HOME_PATHS;
}

/**
 * Private signing / API key files, wherever they sit (2026-10-14: an Apple notary key `AuthKey_<id>.p8` lay in the folder
 * an agent worked in). Not `.pem` / `.key`: projects hold dev TLS certs and test fixtures under those names.
 */
export const PRIVATE_KEY_FILE = /\.(?:p8|p12|pfx|jks|keystore)$/i;

/** File names that are secrets wherever they sit under a Kora home (`~/.kora/ui-token`, `~/.kora-dev/secrets.json`). Not
 *  `kora.sock`: agents dial it (the fleet tools), and what a call may do is gated by the control token (control-auth.ts). */
const KORA_SECRET_FILE = /^(ui-token|secrets?(\..+)?|.*\.key|.*\.pem|token|credentials(\..+)?|trust\.json)$/i;

// The canonical spelling: macOS home volumes are case-insensitive (APFS default), so `~/.SSH/id_rsa` opens the real
// `~/.ssh/id_rsa`. The JS realpath keeps the caller's case; the native one returns the on-disk name (audit 2026-10-13
// deep A1-3), and every comparison below is case-folded on a case-insensitive platform as a second line.
function real(p: string): string { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (s: string): string => (FOLD_CASE ? s.toLowerCase() : s);
/** Regex flags for the shell-text matchers: case-insensitive where the file system is. */
const RX = FOLD_CASE ? 'i' : '';
function resolveLoose(p: string): string {
  let cur = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(real(cur), ...tail);
}
/** `/`-separated, for the regex matchers below (Windows paths use `\`). */
const slash = (p: string): string => (path.sep === '\\' ? p.replace(/\\/g, '/') : p);
const under = (t0: string, root0: string): boolean => { const t = fold(t0); const root = fold(root0); return t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep); };

export function sensitiveOverride(): boolean { return process.env.KORA_ALLOW_SENSITIVE_PATHS === '1'; }

/** Why this absolute path is off limits, or null. */
export function sensitivePathReason(p: string, home: string = os.homedir()): string | null {
  const t = resolveLoose(p);
  const h = real(home);
  for (const rel of sensitiveHomePaths()) {
    if (under(t, path.join(h, rel)) || under(path.resolve(p), path.join(home, rel))) return `~/${rel}`;
  }
  if (PRIVATE_KEY_FILE.test(path.basename(t)) || PRIVATE_KEY_FILE.test(path.basename(p))) return 'a private signing/API key file';
  // Any Kora home (~/.kora, ~/.kora-dev, a KORA_HOME elsewhere): its token and secret files.
  const kh = process.env.KORA_HOME ? real(process.env.KORA_HOME) : null;
  const base = path.basename(t);
  const inKoraHome = (kh && under(t, kh)) || new RegExp(`^${slash(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.kora[^/]*/`, RX).test(slash(t));
  if (inKoraHome && KORA_SECRET_FILE.test(base)) return 'a Kora token/secret file';
  if (inKoraHome && new RegExp('/(secrets|accounts)/', RX).test(slash(t))) return 'Kora account secrets';
  return null;
}

/**
 * Kora's own control files (deep A1 D2). An agent that rewrites `<KORA_HOME>/config.json` (`workerPermission`),
 * `settings.json` (`defaultRuntimeMode`), `engines.json` (executables, ACP commands run at the next session),
 * `mcp/`, `shims/`, `app/` or a thread's `chat/<id>/meta.json` (`runtimeMode`) escalates for good. These are
 * WRITE-protected only: reading them is harmless. Kora itself writes them from the daemon, outside every fence.
 */
export const KORA_CONTROL_FILES = ['config.json', 'settings.json', 'engines.json', 'trust.json', 'claude-accounts.json', 'savings.json', 'prune-forks.json', 'blob-defaults.json', 'swarm/tasks.json', 'extensions.json'] as const;
// workers/: a sleeping worker's launch argv (permission flags) is reused on wake; swarm/tasks.json: unfinished tasks resume from it.
// extensions/: installed skills (instructions every agent loads) and the Antigravity sync state.
export const KORA_CONTROL_DIRS = ['mcp', 'shims', 'app', 'shell', 'tools', 'agy-guard', 'workers', 'extensions'] as const;
/** Sub-folders of an otherwise writable Kora folder that are code (S6 2026-10-14): OpenCode loads `opencode/plugins/*.js` in every worker. */
export const KORA_CONTROL_SUBDIRS = ['opencode/plugins'] as const;

/** Why writing this absolute path would change Kora's own control state, or null. */
export function controlFileWriteReason(p: string, home: string = os.homedir()): string | null {
  const t = resolveLoose(p);
  const h = real(home);
  const kh = process.env.KORA_HOME ? real(process.env.KORA_HOME) : null;
  let rel: string | null = null;
  if (kh && under(t, kh)) rel = slash(t.slice(kh.length + 1));
  else { const m = new RegExp(`^${slash(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.kora[^/]*/(.*)$`, RX).exec(slash(t)); if (m) rel = m[1]!; }
  if (rel == null || rel === '') return null;
  const lr = fold(rel);
  if ((KORA_CONTROL_FILES as readonly string[]).includes(lr)) return `Kora's control file ${rel}`;
  const first = lr.split('/')[0]!;
  if ((KORA_CONTROL_DIRS as readonly string[]).includes(first)) return `Kora's ${first}/ folder`;
  for (const sub of KORA_CONTROL_SUBDIRS) if (lr === sub || lr.startsWith(`${sub}/`)) return `Kora's ${sub}/ folder`;
  if (/^chat\/[^/]+\/meta\.json$/.test(lr)) return "a Kora thread's meta.json";
  return null;
}

/** A write verb in a shell line: a redirect, tee/sed -i/cp/mv/rm..., or an interpreter (python, node, ruby, perl) that can write. */
const SHELL_WRITE_VERBS = /(?:>|\b(?:tee|sed\s+-\w*i|perl\s+-\w*i|cp|mv|rm|ln|install|dd|truncate|touch|chmod|rsync|python3?|node|ruby|perl|sponge|ed|ex|vim?|nano)\b|\bopen\b(?!\())/;
const SHELL_WRITE_VERBS_NO_INTERPRETER = /(?:>|\b(?:tee|sed\s+-\w*i|perl\s+-\w*i|cp|mv|rm|ln|install|dd|truncate|touch|chmod|rsync|sponge|ed|ex|vim?|nano)\b|\bopen\b(?!\())/;
/** Inline code (`python3 -c`, `node -e`, `ruby -e`, `perl -e`) that shows no way to write, delete or run anything else. */
const INLINE_CODE = /\b(?:python3?|node|ruby|perl)\s+(?:-[A-Za-z]+\s+)*-[cepE]\b/g;
const INTERPRETER = /\b(?:python3?|node|ruby|perl)\b/g;
const INLINE_WRITE_HINT = /\b(?:write\w*|append\w*|dump\w*|rename\w*|unlink\w*|remove\w*|rmdir\w*|rmSync|rm|shutil|replace|system|popen|subprocess|child_process|exec\w*|spawn\w*|fork|eval|compile|getattr|setattr|__import__|importlib|globals|locals|vars|base64|copy\w*|cpSync|move|truncate\w*|chmod|chown|utimes|symlink|link|mkdir\w*|makedirs|touch|sed|mode|openSync|createWriteStream|sync|reopen|fdopen|os\.open)\b/;
/** Could this line write? Over-matching only costs a question. A read-only one-liner (`python3 -c "print(open(f).read())"`) passes. */
function shellMayWrite(s: string): boolean {
  if (!SHELL_WRITE_VERBS.test(s)) return false;
  if (SHELL_WRITE_VERBS_NO_INTERPRETER.test(s) || (s.match(INTERPRETER)?.length ?? 0) !== (s.match(INLINE_CODE)?.length ?? 0)) return true;
  // Every interpreter in the line runs inline code: look for anything in it that writes. A read-mode open() is fine.
  const code = s.replace(/\bopen\s*\(([^()]*?)(?:,\s*['"]r[bt]?['"])?(?:,\s*encoding\s*=\s*['"][\w-]+['"])?\s*\)/g, 'open()');
  return INLINE_WRITE_HINT.test(code) || /\bopen\s*\([^()]*,/.test(code);
}

/** A shell line that names a Kora control file AND writes (redirect, tee, sed -i, cp, mv, rm, ln, an interpreter...). Over-matching only costs a question. */
export function controlFileShellReason(cmd: string, home: string = os.homedir()): string | null {
  const s = normalizeShell(cmd, home);
  const names = `(?:config\\.json|settings\\.json|engines\\.json|trust\\.json|claude-accounts\\.json|savings\\.json|prune-forks\\.json|blob-defaults\\.json|swarm/tasks\\.json|(?:mcp|shims|app|shell|tools|agy-guard|workers)(?![\\w.-])|opencode/plugins(?![\\w.-])|chat/[^/\\s]+/meta\\.json)`;
  const khs = process.env.KORA_HOME ? [...new Set([process.env.KORA_HOME, real(process.env.KORA_HOME)])].map(esc) : [];
  const named = new RegExp(`(?:\\.kora[\\w-]*|\\$\\{?KORA_HOME\\}?${khs.map((k) => `|${k}`).join('')})/${names}`, RX).test(s);
  if (!named) return null;
  if (shellMayWrite(s)) return "a shell command that writes Kora's own control files";
  return null;
}

/**
 * The same write check for a shell line that never spells the Kora home: `cd ~/.kora-dev && echo '{}' > config.json`, or
 * `echo x > link/config.json` where `link` is a symlink to it. Words are resolved against the cwd (tracking `cd`) and the
 * target need not exist yet (a redirect creates it). Needs a write verb in the line, like controlFileShellReason. S6 2026-10-14.
 */
export function controlFileShellPathReason(cmd: string, cwd: string, home: string = os.homedir()): string | null {
  if (!shellMayWrite(cmd)) return null;
  const hit = findSensitiveShellPath(cmd, cwd, home, (abs) => controlFileWriteReason(abs, home), false);
  return hit ? "a shell command that writes Kora's own control files" : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Names that are credentials wherever they appear in a shell line, whatever prefix comes before them: after `cd ~` a
 * relative `.ssh/id_rsa` reads the key, and `$D/.aws`, `/Users/$USER/.gnupg` or `../../.ssh` hide the home prefix.
 * Over-matching only costs a question (Default) or a refusal the agent relays (Full access).
 */
const ANYWHERE_NAMES = ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.netrc', '.git-credentials', '.pypirc', 'Keychains'] as const;
const ANYWHERE_PATHS = [
  '\\.config/(?:gh|gcloud|op)', '\\.claude[\\w-]*/\\.credentials', '\\.codex/auth\\.json', '\\.kora[\\w-]*/(?:ui-token|secrets?|accounts)',
  '\\.gemini/(?:antigravity-cli/antigravity-oauth-token|oauth_creds\\.json)', 'opencode/auth\\.json', '\\.claude\\.json', '\\.codex/config\\.toml', '\\.config/git/credentials',
  '\\.(?:zsh|bash|python|node_repl)_?history', '\\.zhistory', 'fish/fish_history', '\\.kora[\\w-]*/trust\\.json',
  '\\$\\{?KORA_HOME\\}?/(?:ui-token|secrets?|accounts|trust\\.json)', 'Library/(?:Messages|Application Support/(?:Slack|discord))',
  'Library/(?:Cookies|Safari|Application Support/(?:Google/Chrome|Chromium|Firefox|BraveSoftware|Microsoft Edge|Arc|com\\.operasoftware\\.Opera))',
  // Private signing / API key files by extension (PRIVATE_KEY_FILE), e.g. `cat AuthKey_ABC123.p8`.
  '[\\w.@*?-]*\\.(?:p8|p12|pfx|jks|keystore)',
];
/** Windows only, matched case-insensitively after `\` reads as `/` (winShell). */
const WIN_ANYWHERE_NAMES = ['.gcm'] as const;
const WIN_ANYWHERE_PATHS = [
  // PowerShell history: the file, its folder, and `(Get-PSReadLineOption).HistorySavePath`, which never spells either.
  'PSReadLine', 'ConsoleHost_history\\.txt', 'HistorySavePath',
  '(?:Google/Chrome|Chromium|Microsoft/Edge|BraveSoftware/Brave-Browser|Vivaldi)/User Data', 'Mozilla/Firefox/Profiles', 'Opera Software',
  'GitHub CLI/hosts\\.yml', 'Microsoft/(?:Credentials|Protect|Vault)', '\\.IdentityService',
];
const anywhereNames = (): readonly string[] => (process.platform === 'win32' ? [...ANYWHERE_NAMES, ...WIN_ANYWHERE_NAMES] : ANYWHERE_NAMES);
const anywherePaths = (): readonly string[] => (process.platform === 'win32' ? [...ANYWHERE_PATHS, ...WIN_ANYWHERE_PATHS] : ANYWHERE_PATHS);

/**
 * Windows: the home and AppData variables of cmd (`%APPDATA%`), PowerShell (`$env:LOCALAPPDATA`, `${env:USERPROFILE}`)
 * and Git bash (`$USERPROFILE`) spelled as `~/…`, so `type %APPDATA%\Mozilla\Firefox\…` meets the same `~/` matchers.
 */
function winEnvHome(s: string): string {
  if (process.platform !== 'win32') return s;
  return s.replace(/%HOMEDRIVE%%HOMEPATH%/gi, '~')
    .replace(/(?:%(LOCALAPPDATA|APPDATA|USERPROFILE)%|\$\{?(?:env:)?(LOCALAPPDATA|APPDATA|USERPROFILE|HOME)\}?(?!\w))/gi, (_m, a?: string, b?: string) => {
      const v = (a ?? b ?? '').toUpperCase();
      return v === 'LOCALAPPDATA' ? '~/AppData/Local' : v === 'APPDATA' ? '~/AppData/Roaming' : '~';
    });
}

/** Undo the shell's own quoting and spell every home prefix as `~`, so `"$HOME/.s"sh` and `${HOME}/.ssh` read `~/.ssh`. */
/**
 * Windows: agents' shells are Git bash (or cmd/PowerShell), and paths come as `C:\a\b`, `C:/a/b` or `/c/a/b`. Read
 * every `\` as a separator (over-matching only costs a question) and `/c/` as `C:/`, so one spelling is matched.
 */
function winShell(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  return cmd.replace(/\\/g, '/').replace(/(^|[\s=@'"(<>])\/([a-zA-Z])(?=\/)/g, (_m, pre: string, d: string) => `${pre}${d.toUpperCase()}:`);
}
function normalizeShell(cmd: string, home: string): string {
  let s = winEnvHome(winShell(cmd).replace(/\\(.)/g, '$1').replace(/['"]/g, ''));
  for (const h of [...new Set([real(home), home, slash(real(home)), slash(home)])].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(`${esc(h)}(?=/|$|[\\s;|&)])`, `g${RX}`), '~');
  return s.replace(/\$\{HOME\}|\$HOME\b/g, '~');
}

/** A glob component as a regex; a pattern that does not start with a literal dot cannot match a dotfile (bash default). */
function globPart(part: string, flags = ''): { re: RegExp; dotOk: boolean } {
  let r = '';
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else if (c === '[') {
      const end = part.indexOf(']', i + 2);
      if (end < 0) { r += '\\['; continue; }
      let body = part.slice(i + 1, end); if (body.startsWith('!')) body = '^' + body.slice(1);
      r += `[${body.replace(/\\/g, '\\\\')}]`; i = end;
    } else r += esc(c);
  }
  return { re: new RegExp(`^${r}$`, flags), dotOk: part.startsWith('.') };
}
// Windows: NTFS names are case-insensitive, so `~/appdata/local/*` reaches `AppData/Local`. macOS keeps exact matching.
const partMatches = (pattern: string, name: string): boolean => {
  const win = process.platform === 'win32';
  if (!/[*?[]/.test(pattern)) return win ? pattern.toLowerCase() === name.toLowerCase() : pattern === name;
  const g = globPart(pattern, win ? 'i' : '');
  return (g.dotOk || !name.startsWith('.')) && g.re.test(name);
};

/** Can this glob path (relative to home) expand to a sensitive home path, or to a folder that holds one? */
function globHitsHomePath(rel: string): boolean {
  // Either separator on Windows; on macOS/Linux a backslash in a glob is an escape, not a separator.
  const parts = rel.split(process.platform === 'win32' ? /[\\/]/ : '/').filter((x) => x && x !== '.');
  if (!parts.length) return false;
  return sensitiveHomePaths().some((sp) => {
    const sparts = sp.split('/');
    const n = Math.min(parts.length, sparts.length);
    for (let i = 0; i < n; i++) if (!partMatches(parts[i]!, sparts[i]!)) return false;
    return true;
  });
}

/** Why this shell line touches credentials or keys, or null. Pure. */
export function sensitiveShellReason(cmd: string, home: string = os.homedir()): string | null {
  const direct = sensitiveShellText(cmd, home);
  if (direct) return direct;
  // `d=~/.kora; cat $d/ui-token`, `export K=$HOME/.ssh; cat "$K"/id_rsa`: the line's own simple assignments, substituted
  // (2026-10-15 audit #4). A variable set elsewhere stays unknown; its `$x/ui-token` is caught by the name below.
  const expanded = substituteLineVars(cmd);
  if (expanded !== cmd) { const why = sensitiveShellText(expanded, home); if (why) return why; }
  if (unresolvedKoraSecret(expanded)) return 'a shell command that names a Kora token/secret file';
  return null;
}

/** NAME=value assignments in the line (also after `export` / `local` / `declare`), unquoted, in order. */
function lineAssignments(cmd: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /(?:^|[\s;&|(`])(?:(?:export|local|declare|typeset|readonly)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)`]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) vars.set(m[1]!, m[2]!.replace(/^(["'])(.*)\1$/, '$2'));
  return vars;
}

/** The line with `$NAME` / `${NAME}` replaced by what the line itself assigned (two passes: `a=~/.k; b=$a/x`). Exported for tests. */
export function substituteLineVars(cmd: string): string {
  const vars = lineAssignments(cmd);
  if (!vars.size) return cmd;
  let out = cmd;
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m0, a?: string, b?: string) => {
      const v = vars.get((a ?? b)!);
      return v === undefined ? m0 : v;
    });
    for (const [k, v] of vars) vars.set(k, v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m0, a?: string, b?: string) => vars.get((a ?? b)!) ?? m0));
  }
  return out;
}

/** The control token / secrets by FILE name behind a variable or substitution the guard cannot resolve (`$d/ui-token`,
 *  `$(x)/ui-tok?n`, `$h/secrets/swarm.json`). Never the socket (`ls $KORA_HOME/kora.sock` is fine) or a variable's name. */
function unresolvedKoraSecret(cmd: string): boolean {
  const s = cmd.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
  for (const w of s.split(/[\s;|&<>=@,]+/)) {
    if (!/[$)`]/.test(w) || !w.includes('/')) continue;
    const base = w.slice(w.lastIndexOf('/') + 1);
    if (!base || base.includes('$')) continue;
    if (partMatches(base, 'ui-token')) return true;
    const parts = w.split('/');
    if (parts.length >= 2 && partMatches(parts[parts.length - 2]!, 'secrets') && partMatches(base, 'swarm.json')) return true;
  }
  return false;
}

/** Does this line drop or rewrite Kora's agent marker once its quoting is undone? */
function markerDropReason(cmd: string): boolean {
  // Quotes and empty `` go (`KO""RA_AGENT`, `KO``RA_AGENT`); any other backtick starts a command, like `;`.
  const s = cmd.replace(/\\(.)/g, '$1').replace(/['"]/g, '').replace(/``/g, '').replace(/`/g, ';').replace(/\s+\+\s+/g, '');
  if (!/KORA_AGENT/.test(s)) return false;
  // An assignment counts in command position only (line start, after ; & | (, after export/env/declare… or other
  // assignments): `KO""RA_AGENT= kora x` is a drop, `grep 'KORA_AGENT=' src` is a search.
  if (/(?:^|[;&|(])\s*(?:(?:export|env|declare|local|typeset|readonly)\b[^;&|(]*?\s)?(?:[A-Za-z_]\w*=\S*\s+)*KORA_AGENT=(?!\$)/.test(s)) return true;
  if (/(?:^|[\s;&|(])(?:unset\s+(?:[^\s;&|()]+\s+)*KORA_AGENT\b|env\s+(?:[^\s;&|()]+\s+)*-(?:u\s*|-unset[=\s])KORA_AGENT\b)/.test(s)) return true;
  // An interpreter's env write: `process.env.KORA_AGENT = ''`, `os.environ[KORA_AGENT]=`, `$env:KORA_AGENT=`, `ENV[KORA_AGENT]=`.
  return /\b(?:delete|del|unset|pop|unsetenv|removeItem|Remove-Item|SetEnvironmentVariable|putenv|setenv)\b|\b(?:env|environ|ENV|Env)\s*(?:\.|\[|:)\s*KORA_AGENT\s*\]?\s*=(?!=)/.test(s);
}

/** Can this glob word (`~/…`, absolute, or `$HOME/…` spelled `~`) match a Kora home's token/secret file? */
function globHitsKoraSecret(w: string): boolean {
  const parts = w.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (!/[*?[]/.test(base) && !parts.some((x) => /[*?[]/.test(x))) return false;
  const secretBase = ['ui-token', 'secrets.json', 'secret', 'trust.json', 'credentials.json'].some((n) => partMatches(base, n));
  if (!secretBase) return false;
  // The folder part names a Kora home (or is a pattern that can); a glob into a custom KORA_HOME is caught by expanding it
  // for real (findSensitiveShellPath).
  const dir = parts[parts.length - 2] ?? '';
  return partMatches(dir, '.kora') || partMatches(dir, '.kora-dev');
}

/** sensitiveShellReason's text matchers on one spelling of the line. */
function sensitiveShellText(cmd: string, home: string): string | null {
  const s = normalizeShell(cmd, home);
  const B = `(?=$|[/\\s;|&)<>,:])`;
  const rels = sensitiveHomePaths().map(esc).join('|');
  if (new RegExp(`~/(?:${rels})${B}`, RX).test(s)) return 'a shell command that touches credentials or keys';
  if (new RegExp(`(?:^|[^\\w.-])(?:${anywhereNames().map(esc).join('|')})${B}`, RX).test(s)) return 'a shell command that names a credentials folder';
  if (new RegExp(`(?:${anywherePaths().join('|')})(?![\\w-])`, RX).test(s)) return 'a shell command that names a credentials file';
  if (/\bsecurity\s+(?:find-\w+-password|dump-keychain|export|find-identity|unlock-keychain)\b/.test(s)) return 'a shell command that reads the keychain';
  if (/\b(?:cmdkey(?:\.exe)?\s+\/(?:list|add|generic|delete|pass)|vaultcmd(?:\.exe)?\s+\/list\w*|get-storedcredential|credread\w*|keymgr\.dll|passwordvault)\b/i.test(s)) return 'a shell command that reads Windows Credential Manager';
  // The kora CLI attaches the control token (control-auth.ts) unless KORA_AGENT says it runs inside an agent. Clearing
  // or spoofing that marker would hand an agent the token through a child process the guard never sees reading it.
  if (/(?:^|[\s;&|(`])(?:unset\s+(?:[^\s;&|()`]+\s+)*KORA_AGENT\b|env\s+(?:[^\s;&|()`]+\s+)*-(?:u\s*|-unset[=\s])KORA_AGENT\b|env\s+(?:[^\s;&|()`]+\s+)*-i\b)/.test(cmd)) return 'a shell command that drops Kora\'s agent marker (it would hand the agent Kora\'s control token)';
  // The same after the shell's own quoting is undone (`unset KO""RA_AGENT`), and any interpreter line that names the marker
  // next to a delete / unset / assignment (`node -e 'delete process.env.KORA_AGENT; …'`, `os.environ.pop("KORA_AGENT")`).
  // 2026-10-15 audit #4. Not the only line: Claude runs under a fence that refuses the token file (os-sandbox.ts).
  if (markerDropReason(cmd)) return 'a shell command that drops Kora\'s agent marker (it would hand the agent Kora\'s control token)';
  // `cd` (no argument), `cd ~`, `pushd ~/`: after it a bare relative path is a home path.
  const cdHome = /(?:^|[;&|(\s])(?:cd|pushd)(?:\s+--)?(?:\s+~\/?)?\s*(?=$|[;&|)])/.test(s);
  if (cdHome && new RegExp(`(?:^|[\\s=@:<>])(?:\\./)?(?:${rels})${B}`, RX).test(s)) return 'a shell command that reads credentials relative to home';
  for (const w of s.split(/[\s;|&()<>=@,`]+/)) {
    if (!/[*?[]/.test(w)) continue;
    if (w.startsWith('~/') && globHitsHomePath(w.slice(2))) return 'a glob that can expand into a credentials folder';
    // A Kora home's token / secrets by a pattern (`~/.kora/ui-tok?n`, `~/.ko*/secret*`): 2026-10-15 audit #4.
    if (globHitsKoraSecret(w)) return 'a glob that can expand into a Kora token/secret file';
    if (cdHome && !w.startsWith('/') && !w.startsWith('~') && globHitsHomePath(w.replace(/^(?:\.\/)+/, ''))) return 'a glob that can expand into a credentials folder';
    // Anywhere else: a component that can match a credentials folder's name (`../../.ss?/x`, `$D/.a*s`).
    // A sed/awk pattern (`s/=.*//`) is not a path: the word must start like one (audit S3-6).
    if (!/^[/~.$]/.test(w)) continue;
    if (w.split('/').some((part, idx) => idx > 0 && /[*?[]/.test(part) && /[\w.-]/.test(part.replace(/\[[^\]]*\]/g, '')) && anywhereNames().some((n) => partMatches(part, n)))) return 'a glob that can expand into a credentials folder';
  }
  return null;
}

/** How many argument words one shell line may cost a realpath (the rest are skipped: over-long lines are rare and still text-matched). */
const MAX_PATH_WORDS = 64;

/**
 * Argument words of a shell line that name an existing path whose REAL location is sensitive: `cat link.txt`, where
 * the repo (or a cloned README's instructions) committed `link.txt -> ~/.ssh/id_rsa`, never names `.ssh` in the text.
 * Every plain word (bare relative names included) is resolved against the cwd, tracking `cd <dir>`, and realpath'd when
 * it exists. Sync fs, at most MAX_PATH_WORDS words. Words with `$`, globs or substitutions are left to the text matcher.
 */
export function sensitiveShellPathReason(cmd: string, cwd: string, home: string = os.homedir()): string | null {
  const hit = findSensitiveShellPath(cmd, cwd, home);
  if (!hit) return null;
  return hit.target === hit.abs ? `a shell command that reads ${hit.why}` : `a shell command that reads ${hit.word}, a link to ${tilde(hit.target, home)}`;
}

/** `~/…` for a path under home, the path itself otherwise. */
function tilde(p: string, home: string): string {
  const h = real(home);
  return p === h ? '~' : p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

function findSensitiveShellPath(cmd: string, cwd: string, home: string, test: (abs: string) => string | null = (abs) => sensitivePathReason(abs, home), requireExists = true): { word: string; abs: string; target: string; why: string } | null {
  let base = cwd; let checked = 0;
  for (const segment of winShell(cmd).split(/&&|\|\||[;&|\n()]/)) {
    const words = segment.replace(/\\(.)/g, '$1').replace(/['"]/g, '').split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // VAR=value prefix
    const head = words[i];
    if (head === 'cd' || head === 'pushd') {
      const arg = words.slice(i + 1).find((w) => !w.startsWith('-'));
      const next = !arg || arg === '~' ? home : arg.startsWith('~/') ? path.join(home, arg.slice(2)) : path.resolve(base, arg);
      if (!/[$`*?[]/.test(arg ?? '')) base = next;
    }
    for (const word of words.slice(i)) {
      // `>out`, `2>>log`, `<in`, `--file=path`: the path part.
      let w = word.replace(/^\d*(?:>>?|<)&?/, '');
      if (/^-/.test(w)) { const eq = w.indexOf('='); if (eq < 0) continue; w = w.slice(eq + 1); }
      // curl `-d @file`, `-F name=@file;type=x`, `--data-binary @file`: the file is after the `@` (audit S2-3).
      if (w.includes('@')) w = w.slice(w.lastIndexOf('@') + 1).replace(/;.*$/, '');
      else if (/^[\w.-]+=[^=]/.test(w) && !/^[./~]/.test(w)) w = w.slice(w.indexOf('=') + 1);
      if (w && w.length <= 1024 && /[*?[]/.test(w) && !/[$`{}]|:\/\//.test(w) && (!w.startsWith('~') || /^~\//.test(w))) {
        // A glob is resolved the way the shell will (2026-10-15 audit #4: `cat ~/.kora/ui-tok?n` named no secret in text).
        for (const abs of expandGlob(w, base, home)) {
          if (++checked > MAX_PATH_WORDS) return null;
          const why = test(abs);
          if (why) return { word, abs, target: real(abs), why };
        }
        continue;
      }
      if (!w || w.length > 1024 || /[$`*?[\]{}]|:\/\//.test(w) || (w.startsWith('~') && !/^~(\/|$)/.test(w))) continue;
      const abs = w === '~' ? home : w.startsWith('~/') ? path.join(home, w.slice(2)) : path.resolve(base, w);
      if (++checked > MAX_PATH_WORDS) return null;
      if (requireExists && !fs.existsSync(abs)) continue;
      const why = test(abs);
      if (why) return { word, abs, target: real(abs), why };
    }
  }
  return null;
}

/** How many paths one glob may expand to here (the shell would expand more; these are checked, the rest are not). */
const MAX_GLOB_HITS = 64;

/**
 * The existing paths a glob word expands to (`*`, `?`, `[...]` per component; dotfiles only for a pattern that starts with
 * a dot, as bash does), resolved against `cwd` or home. Bounded: at most MAX_GLOB_HITS paths and 2000 directory entries.
 */
export function expandGlob(word: string, cwd: string, home: string = os.homedir()): string[] {
  const abs = word.startsWith('~/') ? path.join(home, word.slice(2)) : path.resolve(cwd, word);
  const parts = abs.split(path.sep).filter(Boolean);
  let paths = [path.parse(abs).root || path.sep];
  let budget = 2000;
  for (const part of parts) {
    const next: string[] = [];
    for (const dir of paths) {
      if (!/[*?[]/.test(part)) { const p = path.join(dir, part); if (fs.existsSync(p)) next.push(p); continue; }
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (--budget < 0) break;
        if (partMatches(part, n)) next.push(path.join(dir, n));
        if (next.length >= MAX_GLOB_HITS) break;
      }
    }
    paths = next.slice(0, MAX_GLOB_HITS);
    if (!paths.length || budget < 0) break;
  }
  return paths;
}

/**
 * Where a sensitive call really lands when a symlink hides it (`files/link.txt` -> `~/.ssh/id_rsa`), as `~/…`; null
 * when the call names its target directly. The approval card shows it so the user sees what "Allow" would read.
 */
export function sensitiveLinkTarget(toolName: string, input: Record<string, unknown>, cwd: string, home: string = os.homedir()): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name === 'Bash' || name === 'BashOutput') {
    const hit = findSensitiveShellPath(String(input.command ?? ''), cwd, home);
    return hit && hit.target !== hit.abs ? tilde(hit.target, home) : null;
  }
  for (const key of ['file_path', 'path', 'notebook_path'] as const) {
    const raw = input[key];
    if (raw == null || raw === '') continue;
    const s = String(raw).startsWith('~') ? String(raw).replace(/^~/, home) : String(raw);
    const abs = path.resolve(cwd, s);
    if (!sensitivePathReason(abs, home)) continue;
    const target = resolveLoose(abs);
    return target === abs ? null : tilde(target, home);
  }
  return null;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface SensitiveVerdict { sensitive: boolean; reason: string }

/** Is this tool call aimed at a sensitive location? Pure; `cwd` resolves relative paths. */
export function sensitiveVerdict(toolName: string, input: Record<string, unknown>, cwd: string, home: string = os.homedir()): SensitiveVerdict {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS'].includes(name)) {
    for (const key of ['file_path', 'path', 'notebook_path'] as const) {
      const raw = input[key];
      if (raw == null || raw === '') continue;
      const s = String(raw).startsWith('~') ? String(raw).replace(/^~/, home) : String(raw);
      const abs = path.isAbsolute(s) ? s : path.join(cwd, s);
      const why = sensitivePathReason(abs, home);
      if (why) return { sensitive: true, reason: `${name} of ${why}` };
      if (WRITE_TOOLS.has(name)) { const cw = controlFileWriteReason(abs, home); if (cw) return { sensitive: true, reason: `${name} of ${cw}` }; }
    }
    // Glob's own pattern can reach into home (`~/.ss?/*`, or `**/id_*` from a folder above it).
    const pattern = name === 'Glob' && typeof input.pattern === 'string' ? input.pattern : '';
    if (pattern) {
      const base = typeof input.path === 'string' && input.path ? String(input.path).replace(/^~(?=\/|$)/, home) : cwd;
      const abs = pattern.startsWith('~') ? pattern.replace(/^~(?=\/|$)/, home) : path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
      const norm = normalizeShell(abs, home);
      if (norm.startsWith('~/') && globHitsHomePath(norm.slice(2))) return { sensitive: true, reason: `${name} of a pattern that can match credentials` };
      if (norm === '~' || /^~\/\*\*(\/|$)/.test(norm)) return { sensitive: true, reason: `${name} of a pattern that can match credentials` };
    }
    return { sensitive: false, reason: '' };
  }
  if (name === 'Bash' || name === 'BashOutput') {
    const cmd = String(input.command ?? '');
    const why = cmd ? sensitiveShellReason(cmd, home) ?? sensitiveShellPathReason(cmd, cwd, home) ?? controlFileShellReason(cmd, home) ?? controlFileShellPathReason(cmd, cwd, home) : null;
    if (why) return { sensitive: true, reason: why };
  }
  return { sensitive: false, reason: '' };
}

// ---- pattern kills ------------------------------------------------------------------------------------------------
// `pkill -f never` SIGTERMed five other workers' panes (BACKLOG 2026-10-15): a pattern kill matches every process
// whose argv contains the pattern, and other agents' prompts ride in argv. Stopping a process by the exact PID the
// agent started is fine; stopping one by name is not. A safety rule in every mode, Full access included.

export const PATTERN_KILL_REASON = "Kora blocked a pattern kill: it can stop other agents' processes. Stop the process by the exact PID you started (e.g. `kill 12345`, or `kill $!` right after starting it).";

/** OpenCode `bash` permission patterns for the same rule (opencode matches the command text; later keys win). */
export const OPENCODE_PATTERN_KILL_DENY = ['pkill', 'pkill *', 'killall', 'killall *', '*; pkill*', '*&& pkill*', '*| pkill*', '*; killall*', '*&& killall*', '*| killall*', '*$(pgrep*', '*`pgrep*', '*pgrep *| xargs*', '*| xargs kill*', '*| xargs -* kill*'] as const;

/**
 * Is this shell line a pattern kill: `pkill`/`killall` in command position (also behind sudo, env, bash -c, eval, xargs,
 * $(...)), `kill $(pgrep ...)`, `pgrep ... | xargs kill`, a pgrep/ps|grep lookup feeding a kill in a loop? Words that only
 * mention the name (`echo pkill`, `rg pkill src/`, `man killall`) pass, and so does `kill 123`, `kill %1`, `kill $!`,
 * `kill "$PID"`.
 */
export function patternKillReason(cmd: string): string | null {
  type Word = { t: string; subs: string[] };
  const reserved = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'coproc']);
  const wrappers = new Set(['sudo', 'doas', 'command', 'exec', 'env', 'nohup', 'nice', 'timeout', 'setsid', 'stdbuf', 'builtin', 'caffeinate']);
  const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
  const filters = new Set(['grep', 'egrep', 'fgrep', 'rg', 'awk', 'sed', 'cut', 'sort', 'head', 'tail', 'xargs', 'tr', 'uniq']);

  // A heredoc body is data (`cat <<EOF` ... `EOF`): drop it, keep the command line that introduced it.
  const stripHeredocs = (text: string): string => {
    let out = text;
    for (let guard = 0; guard < 8; guard++) {
      const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/.exec(out);
      if (!m) break;
      const bodyStart = m.index + m[0].length;
      const end = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, 'm').exec(out.slice(bodyStart));
      out = out.slice(0, m.index) + m[0].replace('<<', '<') + (end ? out.slice(bodyStart + end.index + end[0].length) : '');
    }
    return out;
  };
  const parse = (raw: string): Word[][][] => {
    const src = stripHeredocs(raw);
    const pipelines: Word[][][] = [];
    let segs: Word[][] = [];
    let seg: Word[] = [];
    let cur: Word | null = null;
    const flushWord = () => { if (cur) { seg.push(cur); cur = null; } };
    const endSeg = () => { flushWord(); if (seg.length) segs.push(seg); seg = []; };
    const endPipeline = () => { endSeg(); if (segs.length) pipelines.push(segs); segs = []; };
    const word = (): Word => (cur ??= { t: '', subs: [] });
    // The text inside `$(` ... `)` starting after the open paren; returns [inner, index after the close paren].
    const paren = (from: number): [string, number] => {
      let depth = 1; let j = from;
      while (j < src.length && depth > 0) {
        const c = src[j]!;
        if (c === '\\') { j += 2; continue; }
        if (c === "'") { const e = src.indexOf("'", j + 1); j = e < 0 ? src.length : e + 1; continue; }
        if (c === '"') { j++; while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; j++; continue; }
        if (c === '(') depth++; else if (c === ')') depth--;
        j++;
      }
      return [src.slice(from, Math.max(from, j - 1)), j];
    };
    const tick = (from: number): [string, number] => {
      let j = from;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      return [src.slice(from, j), j + 1];
    };
    let i = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } word().t += src[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") { const e = src.indexOf("'", i + 1); const end = e < 0 ? src.length : e; word().t += src.slice(i + 1, end); i = end + 1; continue; }
      if (c === '"') {
        const w = word(); i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { w.t += src[i + 1] ?? ''; i += 2; }
          else if (src[i] === '$' && src[i + 1] === '(') { const [inner, next] = paren(i + 2); w.subs.push(inner); w.t += '$()'; i = next; }
          else if (src[i] === '`') { const [inner, next] = tick(i + 1); w.subs.push(inner); w.t += '$()'; i = next; }
          else w.t += src[i++];
        }
        i++; continue;
      }
      if (c === '$' && src[i + 1] === '(') { const [inner, next] = paren(i + 2); const w = word(); w.subs.push(inner); w.t += '$()'; i = next; continue; }
      if ((c === '<' || c === '>') && src[i + 1] === '(') { const [inner, next] = paren(i + 2); const w = word(); w.subs.push(inner); w.t += '$()'; i = next; continue; }
      if (c === '`') { const [inner, next] = tick(i + 1); const w = word(); w.subs.push(inner); w.t += '$()'; i = next; continue; }
      if (c === '#' && !cur) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { flushWord(); i++; continue; }
      if (c === '|') { if (src[i + 1] === '|') { endPipeline(); i += 2; } else { endSeg(); i += src[i + 1] === '&' ? 2 : 1; } continue; }
      if (c === '&') { if (src[i + 1] === '>' || (i > 0 && (src[i - 1] === '>' || src[i - 1] === '<'))) { word().t += c; i++; continue; } endPipeline(); i += src[i + 1] === '&' ? 2 : 1; continue; }
      if (c === ';' || c === '\n' || c === '(' || c === ')') { endPipeline(); i++; continue; }
      word().t += c; i++;
    }
    endPipeline();
    return pipelines;
  };

  const base = (w: string) => w.slice(w.lastIndexOf('/') + 1);
  let killSeen = false;
  let lookupSeen = false; // a pgrep/pidof/ps|grep lookup whose output feeds something (a substitution, or a pipe)

  const isLookup = (segs: Word[][]) => {
    const names = segs.map((sg) => cmdWord(sg).name);
    return names.some((n) => n === 'pgrep' || n === 'pidof') || (names.includes('ps') && names.some((n) => filters.has(n)));
  };

  // Index of the command word in a simple command, skipping assignments, reserved words and wrappers (with their flags).
  function cmdWord(words: Word[]): { name: string; at: number } {
    let k = 0;
    for (;;) {
      const w = words[k];
      if (!w) return { name: '', at: k };
      if (/^[A-Za-z_]\w*=/.test(w.t) || reserved.has(w.t)) { k++; continue; }
      const name = base(w.t);
      if (!wrappers.has(name)) return { name, at: k };
      k++;
      while (words[k] && (words[k]!.t.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[k]!.t))) { if (/^-[ugCphnTt]$/.test(words[k]!.t) || (name === 'nice' && words[k]!.t === '-n')) k++; k++; }
      if ((name === 'timeout') && words[k] && /^[\d.]+[smhd]?$/.test(words[k]!.t)) k++;
    }
  }

  // A simple command; true = a pattern kill (or a shell run inside one).
  const simple = (words: Word[], depth: number): boolean => {
    const { name, at } = cmdWord(words);
    if (name === 'pkill' || name === 'killall') return true;
    if (shells.has(name)) {
      for (let k = at + 1; k < words.length; k++) {
        if (/^-[a-z]*c[a-z]*$/.test(words[k]!.t) && words[k + 1]) return run(words[k + 1]!.t, depth + 1);
      }
    }
    if (name === 'eval') return run(words.slice(at + 1).map((w) => w.t).join(' '), depth + 1);
    if (name === 'xargs') {
      let k = at + 1;
      while (words[k]?.t.startsWith('-')) k += /^-[nIPLdsEa]$/.test(words[k]!.t) ? 2 : 1;
      return k < words.length && simple(words.slice(k), depth);
    }
    if (name === 'kill') {
      killSeen = true;
      return words.slice(at + 1).some((w) => w.subs.some((inner) => parse(inner).some(isLookup)));
    }
    return false;
  };

  function run(src: string, depth: number): boolean {
    if (depth > 4) return false;
    for (const segs of parse(src)) {
      for (const sg of segs) {
        for (const w of sg) {
          for (const inner of w.subs) {
            if (run(inner, depth + 1)) return true;
            if (parse(inner).some(isLookup)) lookupSeen = true;
          }
        }
        if (simple(sg, depth)) return true;
      }
      if (segs.length > 1 && isLookup(segs)) {
        lookupSeen = true;
        // `pgrep x | xargs kill`: the kill sits in a later segment of the lookup's own pipeline.
        if (segs.some((sg, n) => n > 0 && (cmdWord(sg).name === 'kill' || (cmdWord(sg).name === 'xargs' && sg.some((w) => base(w.t) === 'kill'))))) return true;
      }
    }
    return false;
  }

  try {
    if (run(cmd, 0)) return PATTERN_KILL_REASON;
    return lookupSeen && killSeen ? PATTERN_KILL_REASON : null;
  } catch { return null; }
}

/** The pattern-kill reason for a Bash tool call, else null. Not overridable: this rule protects other agents. */
export function patternKillVerdict(toolName: string, input: Record<string, unknown>): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name !== 'Bash' && name !== 'BashOutput') return null;
  const cmd = String(input.command ?? '');
  return cmd ? patternKillReason(cmd) : null;
}

/** A curl/wget line that sends a local file out (`-d @f`, `--data-binary @f`, `-F x=@f`, `-T f`, `--upload-file`, `--post-file`). */
export function shellUploadsFile(cmd: string): boolean {
  if (!/\b(?:curl|wget|http|https|xh)\b/.test(cmd)) return false;
  return /(?:^|\s)(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?)(?:\s+|=)\S*@/.test(cmd) || /(?:^|\s)(?:-F|--form(?:-string)?)(?:\s+|=)\S*=@/.test(cmd)
    || /(?:^|\s)(?:-T|--upload-file|--post-file|--body-file)(?:\s|=)/.test(cmd);
}

/**
 * The PreToolUse hook map. Full access (`bypassPermissions`) cannot be asked, so the call is denied with a reason the
 * agent can relay; every other mode asks the user, who can approve a one-off.
 */
export function sensitivePreToolUseHooks(cwd: string, mode: () => string | undefined): Record<string, unknown> {
  const hook = async (input: any) => {
    // Pattern kills are denied in every mode and cannot be overridden (they stop other agents' processes).
    const kill = patternKillVerdict(String(input?.tool_name ?? ''), (input?.tool_input ?? {}) as Record<string, unknown>);
    if (kill) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: kill } };
    if (sensitiveOverride()) return {};
    let v: SensitiveVerdict;
    try { v = sensitiveVerdict(String(input?.tool_name ?? ''), (input?.tool_input ?? {}) as Record<string, unknown>, cwd); }
    catch { return {}; }
    if (!v.sensitive) {
      // Sending a local file out is asked about everywhere but Full access (a sensitive file is denied above in all modes).
      const name = String(input?.tool_name ?? '').replace(/^mcp__[^_]+__/, '');
      if (name === 'Bash' && mode() !== 'full-access' && shellUploadsFile(String(input?.tool_input?.command ?? ''))) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'This command uploads a local file to a server.' } };
      }
      return {};
    }
    if (mode() === 'full-access') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kora blocked this (${v.reason}): keys and credentials stay off limits even in Full access. Ask the user to switch the thread to Default and approve it, or do it themselves.` } };
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `${v.reason} — keys and credentials always ask.` } };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}

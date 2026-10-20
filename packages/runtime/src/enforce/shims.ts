// PATH shims for grep/rg/ag/find. Inside a kora pane (KORA_ENV=1) a code search first prints
// the graph's own hits on STDERR, prefixed `[kora graph]`, then runs the real tool with the
// original arguments. Outside kora (or with KORA_SHIMS=0) the shim is a transparent pass-through.
// Output cap (RESEARCH.md item 7): inside a pane, grep/rg/ag stdout is capped at config.grepCap lines
// (baked at render time; KORA_GREP_CAP overrides at runtime; 0 = off) with a "refine the pattern"
// tail — every line a search returns is re-billed on every later turn. The exit code is preserved.
//
// Agent launcher shims (claude, codex): an agent the user starts BY HAND in a plain shell pane gets the
// same launch flags prepare() adds when kora spawns it (strict MCP, the rulebook system prompt, codex's
// MCP overrides) — otherwise a hand-launched claude loads every user-level MCP server and carries no
// rulebook, and the hooks are the only channel left. Decisions are baked at render time (like grepCap);
// ensureShims() re-runs at every pane spawn, so a config change is picked up at the next spawn.
//
// Windows: no sh. The agent launchers are `claude.cmd` / `codex.cmd` (cmd, PowerShell) plus an extensionless copy for
// Git bash panes; both run win-shim.js under Kora's own node, which does the sh shim's job. `kora.cmd` (+ `kora`) is
// the CLI launcher. The search shims (grep/rg/ag/find) are not written there yet (docs/windows/PORT.md).
import fs from 'node:fs';
import path from 'node:path';
import { NODE_BIN, KORA_BIN, koraHome } from '../graph/embedded';
import { envPath } from '../util/win-exec';
import { CAP_NOTE, RULEBOOK_FILE, SHIMS_MARKER } from './win-shim';
import type { AdapterResult } from './index';
export { CAP_NOTE, RULEBOOK_FILE } from './win-shim';

export const SHIM_TOOLS = ['grep', 'rg', 'ag', 'find'] as const;   // search shims (graph hits on stderr + cap)
export const SHIM_AGENTS = ['claude', 'codex'] as const;           // launcher shims (prepare()'s flags by hand)
export const SHIM_ALL = [...SHIM_TOOLS, ...SHIM_AGENTS] as const;
export const WIN_CMD_SEARCH_TOOLS = ['rg', 'ag'] as const;           // Windows: the search tools that also get a .cmd
export const SHIM_VERSION = 7;

function configuredGrepCap(): number {
  try { const n = Number(require('../config').loadConfig().grepCap); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; } catch { return 0; }
}
function configuredStrictMcp(): boolean {
  try { return require('../config').loadConfig().strictMcp !== false; } catch { return true; }
}
function shQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

export function shimsDir(): string { return path.join(koraHome(), 'shims'); }

function patternLoop(tool: string): string {
  if (tool === 'find') {
    return [
      '  nostdin=1',
      '  for a in "$@"; do',
      '    if [ "$want" = 1 ]; then pat=$a; break; fi',
      '    case "$a" in -name|-iname|-path|-ipath|-regex|-iregex) want=1;; esac',
      '  done',
    ].join('\n');
  }
  return [
    '  for a in "$@"; do',
    '    if [ "$want" = 1 ]; then pat=$a; want=0; continue; fi',
    '    case "$a" in',
    '      -e|--regexp|--) [ -z "$pat" ] && want=1;;',
    '      -) nostdin=0; break;;',
    '      -r|-R|--recursive|-*r*) nostdin=1;;',
    '      -*) ;;',
    '      [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) ;;',
    '      *) if [ -z "$pat" ]; then pat=$a; else nostdin=1; break; fi;;',
    '    esac',
    '  done',
  ].join('\n');
}

export interface AgentShimOpts {
  strictMcp?: boolean;      // config.strictMcp (claude): --strict-mcp-config + an empty --mcp-config unless one is given
  mcpEnabled?: boolean;     // mcpEnabledFor(agent): claude → --mcp-config <claude.json>; codex → -c mcp_servers.kora.*
  mcpJson?: string;         // claude: path passed to --mcp-config when MCP is enabled
  noneJson?: string;        // claude: the empty {"mcpServers":{}} file for strict mode
  codexOverrides?: string[]; // codex: the -c overrides (from adapters/codex.ts codexOverrides())
}
// The real binary lookup shared by every shim: first `tool` on PATH that is not this shims dir.
function findReal(tool: string): string {
  return [
    `tool=${tool}`,
    'self_dir=$(cd "$(dirname "$0")" && pwd)',
    'real=',
    'old_ifs=$IFS; IFS=:',
    'for d in $PATH; do',
    '  case "$d" in /*) ;; *) continue;; esac', // only absolute dirs: a `.` / relative entry would run a REPO file named like the tool
    '  case "$d" in "$self_dir"|"$self_dir/") continue;; esac',
    '  if [ -f "$d/$tool" ] && [ -x "$d/$tool" ]; then real="$d/$tool"; break; fi',
    'done',
    'IFS=$old_ifs',
    '[ -n "$real" ] || { echo "kora shim: $tool not found on PATH" >&2; exit 127; }',
  ].join('\n');
}

/**
 * Launcher shim for claude / codex. Only acts inside a pane (KORA_ENV=1, KORA_SHIMS!=0) and only for a plain
 * launch — no argument, or a first argument starting with `-`; a subcommand (`claude mcp list`, `codex login`)
 * passes through untouched. Every flag is appended only when "$@" does not already carry it, so the pane the
 * server spawns (whose argv prepare() already completed) goes through unchanged.
 */
export function renderAgentShim(agent: string, opts: AgentShimOpts = {}): string {
  const strict = opts.strictMcp ?? configuredStrictMcp();
  let mcpEnabled = opts.mcpEnabled; if (mcpEnabled == null) { try { mcpEnabled = require('./mcpconfig').mcpEnabledFor(agent); } catch { mcpEnabled = agent !== 'claude'; } }
  const mcpJson = opts.mcpJson ?? (() => { try { return require('./mcpconfig').claudeMcpJsonPath(); } catch { return path.join(koraHome(), 'mcp', 'claude.json'); } })();
  const noneJson = opts.noneJson ?? path.join(koraHome(), 'mcp', 'none.json');
  const body: string[] = [];
  if (agent === 'claude') {
    body.push(
      '  has_mcp=0; has_strict=0; has_sys=0',
      '  for a in "$@"; do',
      '    case "$a" in',
      '      --mcp-config|--mcp-config=*) has_mcp=1;;',
      '      --strict-mcp-config) has_strict=1;;',
      '      --append-system-prompt|--append-system-prompt=*|--system-prompt|--system-prompt=*) has_sys=1;;',
      '    esac',
      '  done',
      '  user_mcp=$has_mcp',
    );
    // Same order as prepare(): the real MCP config first (opt-in), then strict + the empty config. A user who passed
    // their own --mcp-config or --strict-mcp-config by hand has made the MCP decision: neither of the pair is added.
    if (mcpEnabled) body.push(`  if [ "$has_mcp" = 0 ] && [ -f ${shQuote(mcpJson)} ]; then set -- "$@" --mcp-config ${shQuote(mcpJson)}; has_mcp=1; fi`);
    if (strict) body.push(
      '  if [ "$has_strict" = 0 ] && [ "$user_mcp" = 0 ]; then',
      '    set -- "$@" --strict-mcp-config',
      `    if [ "$has_mcp" = 0 ] && [ -f ${shQuote(noneJson)} ]; then set -- "$@" --mcp-config ${shQuote(noneJson)}; fi`,
      '  fi',
    );
    body.push(`  if [ "$has_sys" = 0 ] && [ -s "$self_dir/${RULEBOOK_FILE}" ]; then set -- "$@" --append-system-prompt "$(cat "$self_dir/${RULEBOOK_FILE}")"; fi`);
  } else if (agent === 'codex') {
    const ov = opts.codexOverrides ?? (() => { try { return require('./adapters/codex').codexOverrides(); } catch { return []; } })();
    if (mcpEnabled && ov.length) body.push(
      '  has_nh=0',
      '  for a in "$@"; do case "$a" in *mcp_servers.kora*) has_nh=1;; esac; done',
      `  if [ "$has_nh" = 0 ]; then set -- "$@" ${ov.map(shQuote).join(' ')}; fi`,
    );
  }
  const notes = [
    ...(agent === 'claude' ? [`strict MCP ${strict ? 'on' : 'off'}; kora MCP ${mcpEnabled ? 'on' : 'off'}`] : [`kora MCP ${mcpEnabled ? 'on' : 'off'}`]),
  ];
  return `#!/bin/sh
# kora shim v${SHIM_VERSION} (managed — regenerated by \`kora setup\`). Inside a kora pane a hand-launched
# ${agent} gets the launch flags kora adds when it spawns the agent itself (${notes.join('; ')}).
# A subcommand (first argument not starting with -) and anything outside a pane pass through untouched.
${findReal(agent)}
kora_node_default=${shQuote(NODE_BIN)}
if [ "\${KORA_ENV:-}" = "1" ] && [ "\${KORA_SHIMS:-1}" != "0" ]; then
  case "\${1:-}" in ''|-*) ;; *) exec "$real" "$@";; esac
  # the agent is about to start HERE: set this repo up and warm its graph, like a spawned pane (server does it, ~ms)
  # </dev/null: prelaunch reads no stdin (it takes cwd from the process), and inheriting the caller's stdin — a
  # never-closing stream-json pipe in a headless \`claude -p\` spawn — would make it wait out its 3 s read timeout on
  # every launch (and, before the readStdin fix, hang forever). Feed EOF so it returns in ~ms.
  if [ -n "\${KORA_BIN:-}" ] && [ "\${KORA_PRELAUNCH:-1}" != "0" ]; then "\${KORA_NODE:-$kora_node_default}" "$KORA_BIN" hook prelaunch --agent ${agent} </dev/null >/dev/null 2>&1 || true; fi
${body.join('\n')}
fi
exec "$real" "$@"
`;
}

// ── Windows ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The node entry every Windows agent shim runs (this build's compiled win-shim.js, next to this file). */
export const WIN_SHIM_JS = path.join(__dirname, 'win-shim.js');
/** A path inside a batch file's double quotes: only `%` is still live there (spaces, & and ^ are not). */
export function batQuote(p: string): string { return `"${p.replace(/%/g, '%%')}"`; }
/** `C:\a b\c` as Git bash reads it, single-quoted: `'C:/a b/c'`. */
function gitBashQuote(p: string): string { return shQuote(p.replace(/\\/g, '/')); }

/** `<agent>.cmd`: cmd.exe and PowerShell find it through PATHEXT. `%~dp0.` (not `%~dp0`): a trailing `\"` would escape the quote. */
export function renderWinAgentCmd(agent: string, nodeBin: string = NODE_BIN, entry: string = WIN_SHIM_JS): string {
  return [
    '@echo off',
    `rem kora shim v${SHIM_VERSION} (managed, regenerated by kora setup). Inside a kora pane a hand-launched ${agent} gets the`,
    `rem launch flags kora adds when it spawns ${agent} itself; elsewhere, or for a subcommand, the real ${agent} runs untouched.`,
    `${batQuote(nodeBin)} ${batQuote(entry)} --shims-dir "%~dp0." ${agent} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}
/** `rg.cmd` / `ag.cmd`: the search shim for cmd.exe and PowerShell, run by win-shim.js with the grep cap baked in. */
export function renderWinSearchCmd(tool: string, opts: { grepCap?: number } = {}, nodeBin: string = NODE_BIN, entry: string = WIN_SHIM_JS): string {
  const cap = opts.grepCap ?? configuredGrepCap();
  return [
    '@echo off',
    `rem kora shim v${SHIM_VERSION} (managed, regenerated by kora setup). Inside a kora pane a code search first shows the`,
    `rem graph's hits on stderr, then the real ${tool} runs (stdout capped at ${cap} lines; KORA_GREP_CAP overrides, 0 = off).`,
    `${batQuote(nodeBin)} ${batQuote(entry)} --shims-dir "%~dp0." --cap ${cap} ${tool} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}
/** The same shim for a Git bash pane (bash does not try .cmd): hands over to the same node entry. */
export function renderWinAgentSh(agent: string, nodeBin: string = NODE_BIN, entry: string = WIN_SHIM_JS): string {
  return `#!/bin/sh
# kora shim v${SHIM_VERSION} (managed, regenerated by \`kora setup\`). Git bash on Windows: runs ${agent}.cmd's node entry.
self_dir=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
exec ${gitBashQuote(nodeBin)} ${gitBashQuote(entry)} --shims-dir "$self_dir" ${agent} "$@"
`;
}
/** `kora.cmd` in the shims dir: the pane's KORA_NODE / KORA_BIN win over the baked install paths, as in the sh launcher. */
export function renderWinLauncherCmd(nodeBin: string = NODE_BIN, koraBin: string = KORA_BIN): string {
  return [
    '@echo off',
    'rem managed by kora (launcher). Inside a kora pane this puts kora on PATH.',
    'setlocal',
    `set "_kn=${nodeBin.replace(/%/g, '%%')}"`,
    `set "_kb=${koraBin.replace(/%/g, '%%')}"`,
    'if defined KORA_NODE set "_kn=%KORA_NODE%"',
    'if defined KORA_BIN set "_kb=%KORA_BIN%"',
    '"%_kn%" "%_kb%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** Every file ensureShims writes into the shims dir on this platform (the rulebook and the marker aside). */
export function managedShimFiles(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['kora', ...SHIM_ALL];
  // Search tools: a Git bash copy of each, and a .cmd only for rg/ag. A find.cmd would shadow Windows' own find.exe in
  // cmd.exe and PowerShell (the shims dir is first on PATH), and Windows has no grep for a grep.cmd to front.
  return ['kora', 'kora.cmd', ...SHIM_AGENTS.flatMap((a) => [a, `${a}.cmd`]), ...WIN_CMD_SEARCH_TOOLS.map((t) => `${t}.cmd`), ...SHIM_TOOLS];
}
function renderManaged(file: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return file === 'kora' ? renderLauncher() : renderShim(file);
  if (file === 'kora.cmd') return renderWinLauncherCmd();
  if (file === 'kora') return renderLauncher('win32');
  if (file.endsWith('.cmd')) {
    const tool = file.slice(0, -4);
    return (WIN_CMD_SEARCH_TOOLS as readonly string[]).includes(tool) ? renderWinSearchCmd(tool) : renderWinAgentCmd(tool);
  }
  if ((SHIM_TOOLS as readonly string[]).includes(file)) return renderShim(file, { platform: 'win32' });
  return renderWinAgentSh(file);
}

/**
 * The sh search shim. `platform: 'win32'` is the Git bash copy (Windows): the same script, plus what MSYS needs. The
 * real tool is looked up and run by bash itself (never through node: MSYS would rewrite `/`-leading patterns on the way
 * to a native program and the tool would glob its own command line), other kora shims dirs are skipped, KORA_REPO_ROOT
 * is compared in bash's /c/… form, and the pattern reaches the graph query untouched (MSYS_NO_PATHCONV).
 */
export function renderShim(tool: string, opts: { grepCap?: number; platform?: NodeJS.Platform } = {}): string {
  if ((SHIM_AGENTS as readonly string[]).includes(tool)) return renderAgentShim(tool);
  const cap = tool === 'find' ? 0 : (opts.grepCap ?? configuredGrepCap());
  const win = opts.platform === 'win32';
  return `#!/bin/sh
# kora shim v${SHIM_VERSION} (managed — regenerated by \`kora setup\`). Surfaces code-graph hits for a
# search on stderr, then runs the real ${tool}. Transparent outside a kora pane.${cap > 0 ? `\n# Inside a pane stdout is capped at ${cap} lines (KORA_GREP_CAP overrides; 0 = off); exit code preserved.` : ''}${win ? '\n# Git bash on Windows (cmd.exe and PowerShell never run this extensionless file).' : ''}
tool=${tool}
cap=\${KORA_GREP_CAP:-${cap}}
self_dir=$(cd "$(dirname "$0")" && pwd)
real=
old_ifs=$IFS; IFS=:
for d in $PATH; do
  case "$d" in /*) ;; *) continue;; esac
  case "$d" in "$self_dir"|"$self_dir/") continue;; esac
${win ? `  [ -f "$d/${SHIMS_MARKER}" ] && continue
` : ''}  if [ -f "$d/$tool" ] && [ -x "$d/$tool" ]; then real="$d/$tool"; break; fi
done
IFS=$old_ifs
[ -n "$real" ] || { echo "kora shim: $tool not found on PATH" >&2; exit 127; }
kora_node_default=${win ? gitBashQuote(NODE_BIN) : shQuote(NODE_BIN)}
if [ "\${KORA_ENV:-}" = "1" ] && [ "\${KORA_SHIMS:-1}" != "0" ] && [ -n "\${KORA_BIN:-}" ] \\
   && [ -z "\${KORA_SHIM_ACTIVE:-}" ]; then
  # Only skip when the tool will actually read a pipe: stdin is a pipe AND no path/recursive arg says otherwise.
  nostdin=0; [ -p /dev/stdin ] || nostdin=1
  inside=1
  if [ -n "\${KORA_REPO_ROOT:-}" ]; then
${win ? '    root=$(cygpath -u "$KORA_REPO_ROOT" 2>/dev/null || printf %s "$KORA_REPO_ROOT")\n    case "$PWD/" in "${root%/}"/*) inside=1;; *) inside=0;; esac' : '    case "$PWD/" in "\${KORA_REPO_ROOT%/}"/*) inside=1;; *) inside=0;; esac'}
  fi
  pat=; want=0
${patternLoop(tool)}
  if [ "$inside" = 1 ] && [ "$nostdin" = 1 ] && [ -n "$pat" ] && [ \${#pat} -ge 2 ]; then
    ${win ? 'MSYS_NO_PATHCONV=1 ' : ''}KORA_SHIM_ACTIVE=1 KORA_GRAPH_TIMEOUT_MS=3000 "\${KORA_NODE:-$kora_node_default}" "$KORA_BIN" graph search_code --limit 5 -- "$pat" 2>/dev/null \\
      | sed 's/^/[kora graph] /' >&2 || true
  fi
fi
${tool !== 'find' ? `if [ "\${KORA_ENV:-}" = "1" ] && [ "\${KORA_SHIMS:-1}" != "0" ] && [ "$cap" -gt 0 ] 2>/dev/null; then
  tmp=$(mktemp "\${TMPDIR:-/tmp}/kora-${tool}.XXXXXX" 2>/dev/null) || exec "$real" "$@"
  "$real" "$@" > "$tmp"; rc=$?
  n=$(wc -l < "$tmp" | tr -d ' ')
  if [ "$n" -gt "$cap" ]; then head -n "$cap" "$tmp"; echo "${CAP_NOTE('$cap')}"; else cat "$tmp"; fi
  rm -f "$tmp"
  exit $rc
fi
` : ''}exec "$real" "$@"
`;
}

// `kora` itself, so the CLI the rulebook tells the agent to run exists on PATH inside every pane even when the
// package was never `npm link`ed. Resolves the bin through KORA_BIN (set per pane) with the install path baked
// in as the fallback, and the exact node binary kora runs under (better-sqlite3 ABI must match).
export function renderLauncher(platform: NodeJS.Platform = process.platform): string {
  const q = platform === 'win32' ? gitBashQuote : shQuote; // Windows: the Git bash copy of kora.cmd
  return `#!/bin/sh
# managed by kora (launcher). Inside a kora pane this puts \`kora\` on PATH.
kora_node_default=${q(NODE_BIN)}; kora_bin_default=${q(KORA_BIN)}
exec "\${KORA_NODE:-$kora_node_default}" "\${KORA_BIN:-$kora_bin_default}" "$@"
`;
}

function writeManaged(file: string, body: string, mode: number): AdapterResult {
  let existing: string | null = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
  if (existing !== body) fs.writeFileSync(file, body, { mode });
  try { fs.chmodSync(file, mode); } catch { /* fine */ }
  return { agent: 'shims', action: existing === body ? 'managed' : (existing == null ? 'installed' : 'refreshed'), file };
}

export function ensureShims(platform: NodeJS.Platform = process.platform): AdapterResult[] {
  const dir = shimsDir();
  fs.mkdirSync(dir, { recursive: true });
  const out: AdapterResult[] = [];
  // Marks this folder as shims, so no shim (this home's or another flavor's) ever takes a file here for the real binary.
  try { if (!fs.existsSync(path.join(dir, SHIMS_MARKER))) fs.writeFileSync(path.join(dir, SHIMS_MARKER), 'kora shims\n'); } catch { /* fine */ }
  const files = managedShimFiles(platform);
  out.push(writeManaged(path.join(dir, files[0]!), renderManaged(files[0]!, platform), 0o755)); // the kora launcher first
  // What the claude launcher shim needs on disk: the rulebook text (config.concise / KORA_MCP can change it, so it
  // is rewritten here, at every spawn), the empty strict-mode MCP config, and claude.json when MCP is opted in.
  try {
    const rb = path.join(dir, RULEBOOK_FILE); const text = require('../graph/howto').rulebookShort() + '\n';
    let cur: string | null = null; try { cur = fs.readFileSync(rb, 'utf8'); } catch { cur = null; }
    if (cur !== text) fs.writeFileSync(rb, text);
    const none = path.join(koraHome(), 'mcp', 'none.json'); fs.mkdirSync(path.dirname(none), { recursive: true });
    if (!fs.existsSync(none)) fs.writeFileSync(none, '{"mcpServers":{}}\n');
    const { mcpEnabledFor, writeClaudeMcpJson } = require('./mcpconfig'); if (mcpEnabledFor('claude')) writeClaudeMcpJson();
  } catch { /* the shim checks the files exist before using them */ }
  for (const f of files.slice(1)) out.push(writeManaged(path.join(dir, f), renderManaged(f, platform), 0o755));
  return out;
}

// A login shell's rc files rebuild PATH (macOS path_helper, `export PATH=~/.local/bin:$PATH` in .zshrc), which
// pushed the shims behind the real `claude` — a hand-typed `claude` then bypassed kora entirely (measured).
// So the shell is started with rc files that source the USER'S rc files and then put the shims first again:
// zsh via a forwarding ZDOTDIR, bash via --rcfile, sh/dash via ENV. Each file is one line of ours around theirs.
export function shellRcDir(): string { return path.join(koraHome(), 'shell'); }
const PREPEND_POSIX = 'if [ -n "${KORA_SHIMS_DIR:-}" ]; then PATH="$KORA_SHIMS_DIR:$(printf %s ":$PATH:" | sed "s|:$KORA_SHIMS_DIR:|:|g; s|^:||; s|:$||")"; export PATH; fi';
// Git bash (Windows): PATH holds /c/… entries while KORA_SHIMS_DIR is C:\…, so it is converted first.
const PREPEND_GIT_BASH = 'if [ -n "${KORA_SHIMS_DIR:-}" ]; then _ks=$(cygpath -u "$KORA_SHIMS_DIR" 2>/dev/null || printf %s "$KORA_SHIMS_DIR"); PATH="$_ks:$(printf %s ":$PATH:" | sed "s|:$_ks:|:|g; s|^:||; s|:$||")"; export PATH; unset _ks; fi';
export function renderShellRcs(platform: NodeJS.Platform = process.platform): Record<string, string> {
  // Windows panes start Git bash; its /etc/profile puts /usr/bin (Git's grep, find) ahead of the shims.
  if (platform === 'win32') return { 'bash/rc': `# managed by kora — a login Git bash's profile, then the kora shims back in front of PATH\n[ -f /etc/profile ] && . /etc/profile\nfor f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -f "$f" ]; then . "$f"; _nh_prof=1; break; fi; done\n[ -z "\${_nh_prof:-}" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"; unset _nh_prof\n${PREPEND_GIT_BASH}\n` };
  const zsrc = (f: string) => `[ -f "\${KORA_USER_ZDOTDIR:-$HOME}/${f}" ] && . "\${KORA_USER_ZDOTDIR:-$HOME}/${f}"`;
  return {
    'zsh/.zshenv': `# managed by kora — forwards to your own .zshenv\n${zsrc('.zshenv')}\n`,
    'zsh/.zprofile': `# managed by kora — forwards to your own .zprofile\n${zsrc('.zprofile')}\n`,
    'zsh/.zshrc': `# managed by kora — your .zshrc, then the kora shims back in front of PATH\n${zsrc('.zshrc')}\nif [ -n "\${KORA_SHIMS_DIR:-}" ]; then path=("$KORA_SHIMS_DIR" \${path:#$KORA_SHIMS_DIR}); export PATH; fi\nif [ -n "\${KORA_USER_ZDOTDIR:-}" ]; then export ZDOTDIR="$KORA_USER_ZDOTDIR"; else unset ZDOTDIR; fi\n`,
    'zsh/.zlogin': `# managed by kora — forwards to your own .zlogin\n${zsrc('.zlogin')}\n`,
    'bash/rc': `# managed by kora — a login bash's profile, then the kora shims back in front of PATH\n[ -f /etc/profile ] && . /etc/profile\nfor f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do if [ -f "$f" ]; then . "$f"; _nh_prof=1; break; fi; done\n[ -z "\${_nh_prof:-}" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"; unset _nh_prof\n${PREPEND_POSIX}\n`,
    'sh/rc': `# managed by kora — a login sh's profiles, then the kora shims back in front of PATH (via ENV; sh -l would not read ENV)\n[ -f /etc/profile ] && . /etc/profile\n[ -f "$HOME/.profile" ] && . "$HOME/.profile"\n${PREPEND_POSIX}\n`,
  };
}
export function ensureShellRcs(platform: NodeJS.Platform = process.platform): AdapterResult[] {
  const out: AdapterResult[] = [];
  for (const [rel, body] of Object.entries(renderShellRcs(platform))) {
    const file = path.join(shellRcDir(), rel);
    let existing: string | null = null; try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
    if (existing === body) { out.push({ agent: 'shims', action: 'managed', file }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    out.push({ agent: 'shims', action: existing == null ? 'installed' : 'refreshed', file });
  }
  return out;
}
/** How to start the user's shell so the shims stay first: args + env for zsh / bash / sh, or null (start it plainly). */
export function shellLaunch(shell: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { args: string[]; env: Record<string, string> } | null {
  const dir = shellRcDir();
  if (platform === 'win32') {
    // Git bash (bash.exe). It reads a forward-slash path; cmd.exe and PowerShell have no rc to steer.
    return /^bash(\.exe)?$/i.test(path.win32.basename(shell)) ? { args: ['--rcfile', path.join(dir, 'bash', 'rc').replace(/\\/g, '/')], env: {} } : null;
  }
  const base = path.basename(shell);
  if (base === 'zsh') return { args: ['-l'], env: { ZDOTDIR: path.join(dir, 'zsh'), KORA_USER_ZDOTDIR: env.ZDOTDIR || '' } };
  if (base === 'bash') return { args: ['--rcfile', path.join(dir, 'bash', 'rc')], env: {} };
  if (base === 'sh' || base === 'dash' || base === 'ash') return { args: [], env: { ENV: path.join(dir, 'sh', 'rc') } }; // interactive non-login: that is when ENV is read
  return null;
}

export function removeShims(platform: NodeJS.Platform = process.platform): AdapterResult[] {
  const dir = shimsDir();
  const out: AdapterResult[] = [];
  for (const tool of [...managedShimFiles(platform), RULEBOOK_FILE, SHIMS_MARKER]) {
    const file = path.join(dir, tool);
    if (fs.existsSync(file)) { fs.rmSync(file); out.push({ agent: 'shims', action: 'removed', file }); }
    else out.push({ agent: 'shims', action: 'absent', file });
  }
  return out;
}

export function shimsStatus(platform: NodeJS.Platform = process.platform): AdapterResult[] {
  const dir = shimsDir();
  return managedShimFiles(platform).filter((f) => f !== 'kora').map((tool) => {
    const file = path.join(dir, tool);
    let existing: string | null = null;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
    if (existing == null) return { agent: 'shims', action: 'absent' as const, file };
    return existing === renderManaged(tool, platform) ? { agent: 'shims', action: 'managed' as const, file } : { agent: 'shims', action: 'skipped' as const, file, detail: 'outdated — re-run kora setup' };
  });
}

/** One PATH entry as Windows compares it (case-insensitive, no trailing separator); unchanged elsewhere. */
function pathEntryKey(p: string): string { return process.platform === 'win32' ? p.replace(/[\\/]+$/, '').toLowerCase() : p; }

/** PATH with the shims dir prepended (once). Windows: `Path` read case-insensitively, entries compared the same way. */
export function pathWithShims(existing: string | undefined): string {
  const dir = shimsDir(); const k = pathEntryKey(dir);
  const parts = (existing || envPath(process.env) || '').split(path.delimiter).filter((p) => p && pathEntryKey(p) !== k);
  return [dir, ...parts].join(path.delimiter);
}

export function shimsOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const k = pathEntryKey(shimsDir());
  return (envPath(env) || '').split(path.delimiter).some((p) => pathEntryKey(p) === k);
}

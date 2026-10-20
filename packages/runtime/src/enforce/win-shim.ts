// The Windows launcher shim: what `claude.cmd` / `codex.cmd` in the shims dir run (enforce/shims.ts writes them; the
// extensionless copies for Git bash panes run it too). The sh launcher shim's job, in node, so a pane needs no Git
// bash: inside a kora pane (KORA_ENV=1, KORA_SHIMS!=0) a hand-launched agent gets the flags prepare() adds when kora
// spawns it, then the REAL binary runs; anywhere else, or for a subcommand, the real binary runs with the arguments
// untouched.
//
//   node win-shim.js --shims-dir <dir> <agent> [args…]
//
// The real binary is the first `<agent>` on PATH (PATHEXT) outside the shims dir and outside any other kora shims dir
// (a folder holding SHIMS_MARKER, e.g. Kora Dev's), so a shim can never run itself or another shim.
//
// `rg.cmd` / `ag.cmd` (cmd.exe, PowerShell) run here too and do the sh search shim's job (shims.ts renderShim): inside
// a pane a code search first prints the graph's own hits on stderr (`[kora graph] …`), then the real tool runs, its
// stdout capped at `--cap` lines (config.grepCap, baked in by ensureShims; KORA_GREP_CAP overrides, 0 = off) with the
// exit code kept. There is no grep.cmd / find.cmd: Windows has no grep, and its own find.exe must stay what cmd.exe and
// PowerShell run. Git bash panes get sh search shims instead (shims.ts), which run the real tool from bash itself.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { envPath, exeCandidates, winCommand } from '../util/win-exec';

/** Written into every shims dir: findRealBinary skips a folder that has it. */
export const SHIMS_MARKER = '.kora-shims';
export const SEARCH_TOOLS = ['grep', 'rg', 'ag', 'find'] as const;
export const CAP_NOTE = (cap: string) => `[kora] output capped at ${cap} lines — refine the pattern or add a path`;
export const RULEBOOK_FILE = 'rulebook-short.txt'; // written next to the shims; the claude shim appends it as --append-system-prompt

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirKey(p: string, platform: NodeJS.Platform): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** The real `tool`: first PATH hit that is not in `selfDir` or another kora shims dir. Relative PATH entries never count. */
export function findRealBinary(tool: string, env: NodeJS.ProcessEnv, selfDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const self = dirKey(selfDir, platform);
  for (const d of (envPath(env) ?? '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue; // a `.` entry would run a REPO file named like the agent
    if (dirKey(d, platform) === self || isFile(path.join(d, SHIMS_MARKER))) continue;
    for (const c of exeCandidates(path.join(d, tool), env, platform)) if (isFile(c)) return c;
  }
  return null;
}

export interface LaunchFlagOpts {
  strictMcp: boolean;       // config.strictMcp (claude)
  mcpEnabled: boolean;      // mcpEnabledFor(agent)
  mcpJson: string;          // claude: --mcp-config when MCP is enabled
  noneJson: string;         // claude: the empty strict-mode config
  rulebook: string | null;  // claude: --append-system-prompt text (null = none)
  codexOverrides: string[]; // codex: -c mcp_servers.kora.* overrides
  exists: (p: string) => boolean;
}

/** A plain launch (no argument, or a first argument starting with `-`); a subcommand passes through. */
export function isPlainLaunch(args: readonly string[]): boolean { return !args.length || args[0]!.startsWith('-'); }

/**
 * The launch flags the sh shim adds (shims.ts renderAgentShim), same order and same "the user already decided" rules:
 * the real MCP config first (opt-in), then strict + the empty config, then the rulebook.
 */
export function launchArgs(agent: string, args: readonly string[], o: LaunchFlagOpts): string[] {
  if (!isPlainLaunch(args)) return [...args];
  const out = [...args];
  if (agent === 'claude') {
    const userMcp = args.some((a) => a === '--mcp-config' || a.startsWith('--mcp-config='));
    const hasStrict = args.includes('--strict-mcp-config');
    const hasSys = args.some((a) => /^--(?:append-)?system-prompt(?:=|$)/.test(a));
    let hasMcp = userMcp;
    if (o.mcpEnabled && !hasMcp && o.exists(o.mcpJson)) { out.push('--mcp-config', o.mcpJson); hasMcp = true; }
    if (o.strictMcp && !hasStrict && !userMcp) {
      out.push('--strict-mcp-config');
      if (!hasMcp && o.exists(o.noneJson)) out.push('--mcp-config', o.noneJson);
    }
    if (!hasSys && o.rulebook) out.push('--append-system-prompt', o.rulebook);
  } else if (agent === 'codex') {
    if (o.mcpEnabled && o.codexOverrides.length && !args.some((a) => a.includes('mcp_servers.kora'))) out.push(...o.codexOverrides);
  }
  return out;
}

/** The live decisions (config, MCP opt-in, the rulebook file next to the shims), read at launch. */
function liveOpts(agent: string, selfDir: string): LaunchFlagOpts {
  const { koraHome } = require('../protocol/types') as typeof import('../protocol/types');
  let strictMcp = true; try { strictMcp = require('../config').loadConfig().strictMcp !== false; } catch { /* default on */ }
  let mcpEnabled = agent !== 'claude'; try { mcpEnabled = require('./mcpconfig').mcpEnabledFor(agent); } catch { /* default */ }
  let mcpJson = path.join(koraHome(), 'mcp', 'claude.json'); try { mcpJson = require('./mcpconfig').claudeMcpJsonPath(); } catch { /* default */ }
  let codexOverrides: string[] = []; if (agent === 'codex') { try { codexOverrides = require('./adapters/codex').codexOverrides(); } catch { /* none */ } }
  let rulebook: string | null = null;
  // `$(cat file)` in the sh shim: trailing newlines dropped; an empty file adds nothing.
  try { const t = fs.readFileSync(path.join(selfDir, RULEBOOK_FILE), 'utf8'); if (t.length) rulebook = t.replace(/\n+$/, ''); } catch { /* none */ }
  return { strictMcp, mcpEnabled, mcpJson, noneJson: path.join(koraHome(), 'mcp', 'none.json'), rulebook, codexOverrides, exists: isFile };
}

// ── search shims ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The search pattern of a grep/rg/ag/find command line and whether the tool reads files (not a pipe). The same rules
 * as the sh shim's patternLoop: find's pattern follows -name/-iname/-path/-ipath/-regex/-iregex; for grep/rg/ag the
 * first operand (or the argument after -e/--regexp/--), a second operand or -r means files, `-` means stdin.
 */
export function searchPattern(tool: string, args: readonly string[]): { pat: string; readsFiles: boolean | null } {
  let pat = ''; let want = false;
  if (tool === 'find') {
    for (const a of args) {
      if (want) { pat = a; break; }
      if (/^-(?:i?name|i?path|i?regex)$/.test(a)) want = true;
    }
    return { pat, readsFiles: true };
  }
  let readsFiles: boolean | null = null; // null: decided by whether stdin is a pipe
  for (const a of args) {
    if (want) { pat = a; want = false; continue; }
    if (a === '-e' || a === '--regexp' || a === '--') { if (!pat) want = true; continue; }
    if (a === '-') { readsFiles = false; break; }
    if (a === '-r' || a === '-R' || a === '--recursive' || /^-.*r/.test(a)) { readsFiles = true; continue; }
    if (a.startsWith('-')) continue;
    if (/^\d{1,3}$/.test(a)) continue;
    if (!pat) pat = a; else { readsFiles = true; break; }
  }
  return { pat, readsFiles };
}

function stdinIsPipe(): boolean { try { return fs.fstatSync(0).isFIFO(); } catch { return false; } }
function inside(cwd: string, root: string | undefined): boolean {
  if (!root) return true;
  const k = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const c = k(cwd) + path.sep, r = k(root).replace(/[\\/]+$/, '') + path.sep;
  return c.startsWith(r);
}
/** stdout of a capped run: the first `cap` lines and the note when there were more (`wc -l` counts newlines). */
export function capOutput(out: Buffer, cap: number): Buffer {
  let cut = -1;
  for (let i = 0, n = 0; i < out.length; i++) if (out[i] === 10 && ++n === cap) { cut = i + 1; break; }
  if (cut < 0 || out.indexOf(10, cut) < 0) return out;
  return Buffer.concat([out.subarray(0, cut), Buffer.from(`${CAP_NOTE(String(cap))}\n`)]);
}

function searchMain(tool: string, real: string, args: string[], env: NodeJS.ProcessEnv, bakedCap: number): number {
  const inPane = env.KORA_ENV === '1' && env.KORA_SHIMS !== '0';
  if (inPane && env.KORA_BIN && !env.KORA_SHIM_ACTIVE && inside(process.cwd(), env.KORA_REPO_ROOT || undefined)) {
    const { pat, readsFiles } = searchPattern(tool, args);
    if ((readsFiles ?? !stdinIsPipe()) && pat.length >= 2) {
      const r = spawnSync(env.KORA_NODE || process.execPath, [env.KORA_BIN, 'graph', 'search_code', '--limit', '5', '--', pat], {
        env: { ...env, KORA_SHIM_ACTIVE: '1', KORA_GRAPH_TIMEOUT_MS: '3000' }, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true, timeout: 6000,
      });
      const hits = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      if (hits.length) process.stderr.write(hits.map((l) => `[kora graph] ${l}\n`).join(''));
    }
  }
  const t = winCommand(real, args, env);
  const cap = tool === 'find' ? 0 : Math.max(0, Math.floor(Number(env.KORA_GREP_CAP ?? bakedCap)) || 0);
  process.on('SIGINT', () => { /* the tool decides */ });
  if (!inPane || cap <= 0) {
    const r = spawnSync(t.command, t.args, { stdio: 'inherit', env, windowsVerbatimArguments: t.windowsVerbatimArguments });
    if (r.error) { process.stderr.write(`kora shim: could not start ${real}: ${r.error.message}\n`); return 127; }
    return r.status ?? 1;
  }
  const r = spawnSync(t.command, t.args, { stdio: ['inherit', 'pipe', 'inherit'], env, windowsVerbatimArguments: t.windowsVerbatimArguments, maxBuffer: 1 << 30 });
  if (r.error && !r.stdout) { process.stderr.write(`kora shim: could not start ${real}: ${r.error.message}\n`); return 127; }
  const out = capOutput(r.stdout ?? Buffer.alloc(0), cap);
  try { fs.writeSync(1, out); } catch { /* reader went away */ }
  return r.status ?? 1;
}

export function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const a = [...argv];
  let selfDir = '', cap = 0;
  for (;;) {
    if (a[0] === '--shims-dir') { selfDir = a[1] ?? ''; a.splice(0, 2); }
    else if (a[0] === '--cap') { cap = Number(a[1]) || 0; a.splice(0, 2); }
    else break;
  }
  const agent = a.shift();
  if (!agent || !selfDir) { process.stderr.write('usage: win-shim --shims-dir <dir> [--cap <n>] <tool> [args…]\n'); return 2; }
  const real = findRealBinary(agent, env, selfDir);
  if (!real) { process.stderr.write(`kora shim: ${agent} not found on PATH\n`); return 127; }
  if ((SEARCH_TOOLS as readonly string[]).includes(agent)) return searchMain(agent, real, a, env, cap);
  let args = a;
  if (env.KORA_ENV === '1' && env.KORA_SHIMS !== '0' && isPlainLaunch(a)) {
    // The agent is about to start HERE: set this repo up and warm its graph, like a spawned pane. No stdin (prelaunch
    // reads none; an inherited never-closing pipe would make it wait out its read timeout).
    if (env.KORA_BIN && env.KORA_PRELAUNCH !== '0') {
      spawnSync(env.KORA_NODE || process.execPath, [env.KORA_BIN, 'hook', 'prelaunch', '--agent', agent], { stdio: 'ignore', env, windowsHide: true, timeout: 15_000 });
    }
    args = launchArgs(agent, a, liveOpts(agent, selfDir));
  }
  const t = winCommand(real, args, env);
  // Ctrl+C reaches the agent through the console; this process only waits for it and passes its exit code on.
  process.on('SIGINT', () => { /* the agent decides */ });
  const r = spawnSync(t.command, t.args, { stdio: 'inherit', env, windowsVerbatimArguments: t.windowsVerbatimArguments });
  if (r.error) { process.stderr.write(`kora shim: could not start ${real}: ${r.error.message}\n`); return 127; }
  return r.status ?? 1;
}

if (require.main === module) process.exit(main());

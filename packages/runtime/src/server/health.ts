// Health checks — `kora doctor` and Settings → Diagnostics. One plain row per thing a new user can trip over (daemon,
// Claude Code, its login, OpenCode, the graph index for this repo, disk, the UI port, Swarm providers, local model
// servers), each with a one-line fix. The same function runs in the CLI and inside the daemon (`/api/doctor`), so it
// must never stall the event loop: every probe is an async child process, an async fetch or an async fs call, and
// every check has its own deadline. One broken check never breaks the report.
import { engineSearchDirs } from '../detect/engine-binary';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { PaneGraphInfo, SwarmStatus } from '../protocol/types';
import { scrubChildEnv } from '../util/child-env';
import { readCostLog, summarizeCostLog, type CostLine, type CostSummary } from '../util/cost-log';
import { winCommand } from '../util/win-exec';
import { inTerminal, claudeInstallFix, gitInstallFix } from '../util/platform-copy';

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type HealthCheckId =
  | 'daemon' | 'claude-cli' | 'claude-auth' | 'codex' | 'antigravity' | 'git' | 'opencode' | 'graph' | 'disk' | 'ports' | 'swarm' | 'local-models' | 'prompt-cache' | 'cli-path';

export interface HealthCheck {
  id: HealthCheckId;
  label: string;
  status: HealthStatus;
  /** What was found, in plain words. Never a key, a token or an account email. */
  detail: string;
  /** What to do about it; null when nothing is needed. */
  fix: string | null;
  /** Structured facts for UIs that act on them (local-models: `{ servers: LocalModelServer[] }`). */
  data?: Record<string, unknown>;
}

export interface HealthReport {
  koraVersion: string;
  platform: string;
  node: string;
  cwd: string | null;
  generatedAt: number;
  checks: HealthCheck[];
}

export interface RunResult { code: number | null; stdout: string; stderr: string; error: string | null }

/** What the daemon reports about itself (in-daemon) or answers to `server.ping` (CLI). */
export interface DaemonInfo { running: boolean; version: string | null; pid: number | null; uptimeMs: number | null; error?: string | null }

/** A local OpenAI-compatible model server (Ollama / LM Studio) and what it serves. */
export interface LocalModelServer { kind: 'ollama' | 'lmstudio'; baseUrl: string; reachable: boolean; models: string[] }

export interface HealthDeps {
  /** This process's Kora version. */
  version: string;
  /** True inside the daemon (the daemon/port rows then describe this process). */
  inDaemon: boolean;
  daemon: () => Promise<DaemonInfo>;
  /** The chat UI port (config uiPort; 0 = off). */
  uiPort: number;
  graphStatus?: (cwd: string) => Promise<PaneGraphInfo | null>;
  /** Swarm status after re-testing the enabled providers; null = Swarm not available here. */
  swarmStatus?: () => Promise<SwarmStatus | null>;
  /** Seams (tests). */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  findBinary?: (name: string) => Promise<string | null>;
  /** The Claude Code binary the Agent SDK ships inside Kora (what chat turns actually run); null when absent. */
  bundledClaude?: () => string | null;
  /** macOS: is a developer directory (Xcode or the Command Line Tools) selected? Without one `/usr/bin/git` is a stub. */
  developerToolsInstalled?: () => Promise<boolean>;
  freeDiskBytes?: (dir: string) => Promise<number | null>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  /** Per-check deadline (default 12 s; provider probes take up to 8 s). */
  timeoutMs?: number;
  /** The per-call cost log (util/cost-log.ts) of the last week; absent = read <KORA_HOME>/cost.jsonl. */
  costLines?: () => CostLine[];
}

export const HEALTH_CHECK_IDS: readonly HealthCheckId[] = [
  'daemon', 'claude-cli', 'claude-auth', 'codex', 'antigravity', 'git', 'opencode', 'graph', 'disk', 'ports', 'swarm', 'local-models', 'prompt-cache', 'cli-path',
];

const LABEL: Record<HealthCheckId, string> = {
  daemon: 'Kora daemon',
  'claude-cli': 'Claude Code',
  'claude-auth': 'Claude login',
  codex: 'Codex',
  antigravity: 'Antigravity',
  git: 'git',
  opencode: 'OpenCode (Swarm workers)',
  graph: 'Code graph for this project',
  disk: 'Free disk space',
  ports: 'Ports',
  swarm: 'Swarm providers',
  'local-models': 'Local models (Ollama / LM Studio)',
  'prompt-cache': 'Prompt cache (token savings)',
  'cli-path': 'Kora on PATH',
};

const GB = 1024 ** 3;
export const DISK_FAIL_BYTES = 2 * GB;
export const DISK_WARN_BYTES = 5 * GB;
export const LOCAL_MODEL_SERVERS: readonly { kind: LocalModelServer['kind']; baseUrl: string }[] = [
  { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' },
];
const CLAUDE_INSTALL_FIX = claudeInstallFix();

const CLAUDE_LOGIN_IN_APP_FIX = 'In Kora, click Log in to Claude: it opens your browser to sign in with Kora\'s own copy of Claude Code (no install needed).';

const CODEX_INSTALL_FIX = `To lead threads with Codex, run \`npm install -g @openai/codex\` ${inTerminal()}, then \`codex login\`.`;

// ---- default seams ------------------------------------------------------------------------------------------------

/** The `claude` binary bundled with the Agent SDK (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), or null. */
export function findBundledClaude(): string | null {
  try {
    const sdk = require.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch { return null; }
}

async function macDeveloperToolsInstalled(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const r = await runChild('/usr/bin/xcode-select', ['-p'], 5000);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export function runChild(bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      const childEnv = scrubChildEnv(env ?? process.env);
      const w = winCommand(bin, args, childEnv); // claude.cmd / codex.cmd on Windows
      execFile(w.command, w.args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, env: childEnv, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err ? String((err as any).killed ? 'timed out' : err.message) : null });
      });
    } catch (e: any) { resolve({ code: null, stdout: '', stderr: '', error: String(e?.message ?? e) }); }
  });
}

/** PATH plus the places installers put binaries that a GUI-launched daemon's PATH often lacks (one list for every engine: detect/engine-binary.ts). */
export function searchDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  return engineSearchDirs(env, home);
}

export async function findOnSearchPath(name: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<string | null> {
  for (const dir of searchDirs(env, home)) {
    const file = path.join(dir, name);
    try { await fs.promises.access(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}

async function statfsFree(dir: string): Promise<number | null> {
  try { const s = await fs.promises.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const check = (id: HealthCheckId, status: HealthStatus, detail: string, fix: string | null = null): HealthCheck => ({ id, label: LABEL[id], status, detail, fix });

function deadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The command that shows which program holds a local port: `lsof` on macOS/Linux, `netstat` + `findstr` on Windows. */
export function portOwnerCommand(port: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`;
}

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

function formatUptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just started';
  if (m < 60) return `up ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `up ${h} h` : `up ${Math.floor(h / 24)} days`;
}

/** Tilde-shorten a path for display. */
function tilde(p: string, home: string): string { return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p; }

/** Same release, ignoring a leading v and any -build/+sha suffix. */
function sameVersion(a: string | null, b: string | null): boolean {
  const core = (v: string | null) => (v ?? '').replace(/^v/, '').split(/[-+]/)[0];
  return !!a && !!b && core(a) === core(b);
}

// ---- the checks ---------------------------------------------------------------------------------------------------

async function checkDaemon(d: HealthDeps): Promise<HealthCheck> {
  const info = await d.daemon();
  if (!info.running) {
    return check('daemon', 'fail', info.error ? `Not running (${info.error})` : 'Not running', 'Open the Kora app, or run `kora server start` in a terminal.');
  }
  const up = info.uptimeMs != null ? `, ${formatUptime(info.uptimeMs)}` : '';
  const who = `v${info.version ?? '?'}${info.pid ? `, pid ${info.pid}` : ''}${up}`;
  if (!d.inDaemon && info.version && !sameVersion(info.version, d.version)) {
    return check('daemon', 'warn', `Running ${who}, but this CLI is v${d.version}`, 'Restart the daemon so both match: `kora server stop && kora server start` (or quit and reopen Kora).');
  }
  return check('daemon', 'ok', `Running ${who}`);
}

/** `bin` is the user's `claude` CLI; `authFrom` says which binary answered the login question (the CLI, or the copy
 * bundled with Kora that chat turns run when there is no CLI). */
interface ClaudeFacts { bin: string | null; version: string | null; authFrom: 'cli' | 'bundled' | null; auth: { loggedIn: boolean | null; method: string | null; plan: string | null; error: string | null } }

async function claudeFacts(d: HealthDeps, run: NonNullable<HealthDeps['run']>, find: NonNullable<HealthDeps['findBinary']>): Promise<ClaudeFacts> {
  const bin = await find('claude');
  const env = d.env ?? process.env;
  // No CLI: the copy bundled with Kora still knows whether this Mac is logged in (both read the same login).
  const authBin = bin ?? (d.bundledClaude ?? findBundledClaude)();
  if (!authBin) {
    const apiKey = !!env.ANTHROPIC_API_KEY;
    return { bin: null, version: null, authFrom: null, auth: { loggedIn: apiKey ? true : null, method: apiKey ? 'api-key' : null, plan: null, error: null } };
  }
  const [v, a] = await Promise.all([bin ? run(bin, ['--version'], 8000) : Promise.resolve(null), run(authBin, ['auth', 'status', '--json'], 10_000)]);
  const version = v ? /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null : null;
  let auth: ClaudeFacts['auth'] = { loggedIn: null, method: null, plan: null, error: null };
  try {
    // Only these three fields are read; the email / org the command also prints are never kept.
    const j = JSON.parse(a.stdout.slice(a.stdout.indexOf('{')));
    auth = {
      loggedIn: typeof j.loggedIn === 'boolean' ? j.loggedIn : null,
      method: typeof j.authMethod === 'string' ? j.authMethod : null,
      plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
      error: null,
    };
  } catch {
    auth.error = a.error ?? (a.stderr.trim().split('\n')[0] || 'no answer');
  }
  if (auth.loggedIn !== true && env.ANTHROPIC_API_KEY) auth = { loggedIn: true, method: 'api-key', plan: null, error: null };
  return { bin, version, authFrom: bin ? 'cli' : 'bundled', auth };
}

function checkClaudeCli(f: ClaudeFacts, home: string): HealthCheck {
  if (!f.bin) {
    // Logged in without the CLI (an API key, or a login made before it was removed): chat runs on Kora's bundled
    // copy, but Claude workers in panes need the command.
    if (f.auth.loggedIn) {
      return check('claude-cli', 'warn', 'The `claude` command was not found. Chat works (Kora ships its own copy), but Claude workers in panes need it.', CLAUDE_INSTALL_FIX);
    }
    // Not logged in, but Kora's bundled copy can run the login itself (Log in to Claude): installing the CLI is only
    // needed for Claude workers in panes, so it is a warning, and the login row carries the one thing to do.
    if (f.authFrom === 'bundled') {
      return check('claude-cli', 'warn', 'The `claude` command was not found. Kora ships its own copy, so chat works once you log in; Claude workers in panes need the command.', CLAUDE_INSTALL_FIX);
    }
    return check('claude-cli', 'fail',
      'Claude Code is not installed (no `claude` command found). Kora\'s chats and agents run on it.', CLAUDE_INSTALL_FIX);
  }
  return check('claude-cli', 'ok', `${f.version ? `v${f.version}` : 'version unknown'} at ${tilde(f.bin, home)}`);
}

function checkClaudeAuth(f: ClaudeFacts): HealthCheck {
  const { loggedIn, method, plan, error } = f.auth;
  if (loggedIn === true) {
    const how = method === 'api-key' ? 'with an API key (ANTHROPIC_API_KEY)' : method ? `via ${method}` : '';
    return check('claude-auth', 'ok', `Signed in${how ? ` ${how}` : ''}${plan ? `, ${plan} plan` : ''}`);
  }
  // Not logged in and no CLI to log in with: installing Claude Code is the first step, so the install row says it all.
  // (no fix line: the Claude Code row above already carries the install-then-log-in fix)
  // `data.login` tells the app it can run the login itself (POST /api/claude/login → `<bin> auth login`, which opens
  // the browser): the CLI when installed, else the copy bundled with Kora — no install needed just to sign in.
  if (loggedIn === false && f.authFrom === 'bundled') {
    return { ...check('claude-auth', 'fail', 'Claude Code is not logged in, so every chat turn will fail.', CLAUDE_LOGIN_IN_APP_FIX), data: { login: 'bundled' } };
  }
  if (loggedIn === false && !f.bin) return check('claude-auth', 'skip', 'Not logged in. Install Claude Code first, then log in.');
  if (loggedIn === false) {
    return { ...check('claude-auth', 'fail', 'Claude Code is not logged in, so every chat turn will fail.', `In Kora, click Log in to Claude (it opens your browser to sign in), or ${inTerminal()} run \`claude auth login\`, then come back to Kora.`), data: { login: 'cli' } };
  }
  if (!f.bin) return check('claude-auth', 'skip', 'Needs Claude Code first.');
  return check('claude-auth', 'warn', `Could not tell whether Claude Code is logged in (${error ?? 'unknown'}).`, 'Update Claude Code (`claude update`), then run `claude auth status`.');
}

/** Each agent is optional on its own (see `agentSummary`): a missing CLI is not a problem, a logged-out one is a warning (its turns would fail). */
async function checkCodex(d: HealthDeps, run: NonNullable<HealthDeps['run']>, find: NonNullable<HealthDeps['findBinary']>): Promise<HealthCheck> {
  const bin = await find('codex');
  const home = d.home ?? os.homedir();
  if (!bin) return check('codex', 'skip', 'Not installed. Fine if another agent works: Codex can lead threads too.', CODEX_INSTALL_FIX);
  const [v, s] = await Promise.all([run(bin, ['--version'], 8000), run(bin, ['login', 'status'], 10_000)]);
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
  const where = `${version ? `v${version}` : 'version unknown'} at ${tilde(bin, home)}`;
  const said = `${s.stdout}\n${s.stderr}`.trim().split('\n').find((l) => l.trim())?.trim() ?? '';
  if (s.code === 0 && /logged in/i.test(said) && !/not logged in/i.test(said)) {
    return check('codex', 'ok', `${where}; ${said.charAt(0).toLowerCase()}${said.slice(1)}`);
  }
  if (/not logged in/i.test(said) || s.code === 1) {
    return check('codex', 'warn', `${where}, not logged in. Codex turns will fail until you log in.`, `${inTerminal(true)}, run \`codex login\`, then come back to Kora.`);
  }
  return check('codex', 'warn', `${where}; could not tell whether it is logged in (${s.error ?? (said || 'no answer')}).`, `${inTerminal(true)}, run \`codex login status\`.`);
}

/** Antigravity (`agy`): present or not. `agy` has no model-free sign-in query (no auth/whoami/status; `agy models` takes ~6 s), so sign-in is not checked here; Settings › Engines probes its model list. */
async function checkAntigravity(d: HealthDeps, run: NonNullable<HealthDeps['run']>, find: NonNullable<HealthDeps['findBinary']>): Promise<HealthCheck> {
  const bin = await find('agy');
  if (!bin) return check('antigravity', 'skip', 'Not installed. Fine if another agent works: Antigravity can lead threads too.', 'Install Antigravity (the `agy` command), then press Re-check in Settings → Engines.');
  const v = await run(bin, ['--version'], 8000);
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
  return check('antigravity', 'ok', `${version ? `v${version}` : 'version unknown'} at ${tilde(bin, d.home ?? os.homedir())}; sign-in is not checked`);
}

/** git: Swarm worktrees, the merge gate and the code graph (it indexes git repos) need it; plain chat does not. */
async function checkGit(d: HealthDeps, run: NonNullable<HealthDeps['run']>, find: NonNullable<HealthDeps['findBinary']>): Promise<HealthCheck> {
  const bin = await find('git');
  const fix = gitInstallFix();
  if (!bin) return check('git', 'warn', 'git was not found. Chat works; the code graph, Swarm workers and worktrees need git.', fix);
  // On a Mac without the developer tools /usr/bin/git is only a stub that asks to install them: don't run it.
  if (bin === '/usr/bin/git' && !(await (d.developerToolsInstalled ?? macDeveloperToolsInstalled)())) {
    return check('git', 'warn', 'Apple\'s command line developer tools are not installed, so git does not work yet. Chat works; the code graph, Swarm workers and worktrees need git.', fix);
  }
  const v = await run(bin, ['--version'], 8000);
  const version = /(\d+\.\d+(?:\.\d+)?)/.exec(v.stdout)?.[1] ?? null;
  if (v.code !== 0) return check('git', 'warn', `git at ${bin} did not run (${v.error ?? v.stderr.trim().split('\n')[0] ?? 'no answer'}).`, fix);
  return check('git', 'ok', `${version ? `v${version}` : 'version unknown'} at ${tilde(bin, d.home ?? os.homedir())}`);
}

async function checkOpencode(d: HealthDeps, swarm: SwarmStatus | null): Promise<HealthCheck> {
  let oc = swarm?.opencode ?? null;
  if (!oc) {
    const { resolveOpencodeBinary, opencodeVersion, OPENCODE_MIN_VERSION, compareOpencodeVersions } = await import('./swarm-install');
    const found = resolveOpencodeBinary();
    const version = found.path ? await opencodeVersion(found.path).catch(() => null) : null;
    oc = { installed: !!found.path, path: found.path, source: found.source, version, minVersion: OPENCODE_MIN_VERSION, versionOk: !!version && compareOpencodeVersions(version, OPENCODE_MIN_VERSION) >= 0, onDaemonPath: true };
  }
  const fix = 'Settings → Swarm → Install OpenCode, or run `kora swarm install`.';
  if (!oc.installed) return check('opencode', 'warn', 'Not installed. Only Swarm needs it; chat works without it.', fix);
  if (!oc.versionOk) return check('opencode', 'warn', oc.version ? `v${oc.version} is older than ${oc.minVersion}` : `Found at ${tilde(oc.path ?? '', d.home ?? os.homedir())} but it did not report a version`, fix);
  return check('opencode', 'ok', `v${oc.version} at ${tilde(oc.path ?? '', d.home ?? os.homedir())}`);
}

async function checkGraph(d: HealthDeps, cwd: string | null): Promise<HealthCheck> {
  if (!cwd) return check('graph', 'skip', 'No project selected.', 'Open a project to check its index.');
  if (!d.graphStatus) return check('graph', 'skip', 'The graph service is not available here.');
  const st = await d.graphStatus(cwd);
  const home = d.home ?? os.homedir();
  if (!st) return check('graph', 'warn', `Could not read the index for ${tilde(cwd, home)}.`, `Run \`kora graph status\` in ${tilde(cwd, home)}.`);
  if (!st.repoRoot) {
    return check('graph', 'warn', `${tilde(cwd, home)} is not a git repository. Chat works, but Kora only indexes git repos and Swarm workers need one for their worktrees.`, `Run \`git init && git add -A && git commit -m init\` in ${tilde(cwd, home)}.`);
  }
  const root = tilde(st.repoRoot, home);
  if (st.indexing) {
    const pct = Number.isFinite(st.indexing.pct) ? `${Math.round(st.indexing.pct)}%` : 'in progress';
    return check('graph', 'ok', `Indexing ${root}: ${pct}${st.indexing.filesTotal ? ` of ${st.indexing.filesTotal} files` : ''}. Chat works meanwhile.`);
  }
  if (!st.indexed) return check('graph', 'warn', `${root} is not indexed yet. Chat works; answers just cost more tokens until it is.`, `Click "Index this repo" beside the project name at the top of the chat, or run \`kora ingest ${st.repoRoot}\`.`);
  if (st.staleForCheckout) return check('graph', 'warn', `The index for ${root} was built from another copy (${st.indexedFrom ? tilde(st.indexedFrom, home) : 'unknown'}).`, `Run \`kora ingest ${st.repoRoot}\`.`);
  const size = `${st.nodes.toLocaleString('en-US')} symbols`;
  if (st.stale) return check('graph', 'ok', `${root}: ${size}; behind HEAD, re-indexing in the background.`);
  return check('graph', 'ok', `${root}: ${size}, up to date.`);
}

async function checkDisk(d: HealthDeps): Promise<HealthCheck> {
  const home = d.home ?? os.homedir();
  const dir = (d.env ?? process.env).KORA_HOME || home;
  const free = await (d.freeDiskBytes ?? statfsFree)(fs.existsSync(dir) ? dir : home);
  if (free == null) return check('disk', 'skip', 'Could not read free space.');
  const fix = 'Free some space. Old agent worktrees are a common culprit: `kora worktree list`, then `kora worktree remove <id>`.';
  if (free < DISK_FAIL_BYTES) return check('disk', 'fail', `${formatBytes(free)} free. Worktrees, indexes and installs will start failing.`, fix);
  if (free < DISK_WARN_BYTES) return check('disk', 'warn', `${formatBytes(free)} free. Each Swarm worker gets its own worktree.`, fix);
  return check('disk', 'ok', `${formatBytes(free)} free`);
}

async function checkPorts(d: HealthDeps, daemon: DaemonInfo | null): Promise<HealthCheck> {
  const port = d.uiPort;
  if (!port) return check('ports', 'warn', 'The chat UI server is off (uiPort = 0).', 'Run `kora config set uiPort 8797`, then restart the daemon.');
  if (d.inDaemon) return check('ports', 'ok', `Chat UI server on 127.0.0.1:${port}`);
  const f = d.fetch ?? globalThis.fetch;
  try {
    const res = await f(`http://127.0.0.1:${port}/.well-known/kora/host`, { signal: AbortSignal.timeout(2000) });
    const body: any = await res.json().catch(() => null);
    if (res.ok && body && typeof body.hostId === 'string') return check('ports', 'ok', `Kora answers on 127.0.0.1:${port}`);
    return check('ports', 'fail', `Another program is using port ${port}, so the Kora app cannot connect.`, `Quit that program (\`${portOwnerCommand(port)}\` shows it), or move Kora: \`kora config set uiPort <free port>\` and restart.`);
  } catch {
    if (daemon?.running) return check('ports', 'warn', `The daemon runs, but nothing answers on 127.0.0.1:${port}.`, 'Restart the daemon: `kora server stop && kora server start`.');
    return check('ports', 'ok', `Port ${port} is free for the daemon.`);
  }
}

/** Providers are read as plain rows so ones this build does not know yet (local, paid) still show up. */
function checkSwarm(swarm: SwarmStatus | null): HealthCheck {
  if (!swarm) return check('swarm', 'skip', 'Swarm is not available in this Kora.');
  const consent = swarm.consent.acceptedVersion != null && swarm.consent.acceptedVersion >= swarm.consent.requiredVersion;
  if (!consent) return check('swarm', 'skip', 'Swarm is not set up yet (optional).', 'Flip the composer to Swarm, or open Settings → Swarm.');
  // A provider that needs a key, has none and was never tested is just not set up (OpenRouter is on by default, keyless):
  // optional, never a warning. It counts again once it has a key or a test result.
  const rows = (swarm.providers as readonly { provider: string; enabled: boolean; hasKey?: boolean; lastTest: { ok: boolean; outcome: string; message: string | null; freeModels: readonly string[] } | null }[])
    .filter((p) => p.enabled && (p.lastTest !== null || p.hasKey !== false || p.provider === 'zen'));
  if (!rows.length) return check('swarm', 'fail', 'Every provider is turned off.', 'Settings → Swarm: turn on OpenCode Zen (free, no key).');
  const parts = rows.map((p) => {
    const t = p.lastTest;
    if (!t) return `${p.provider}: not tested`;
    return t.ok ? `${p.provider}: reachable, ${t.freeModels.length} models` : `${p.provider}: ${t.outcome}${t.message ? ` (${t.message})` : ''}`;
  });
  const okCount = rows.filter((p) => p.lastTest?.ok).length;
  // Nothing tested yet (a fresh process, `kora doctor --quick`): not a failure, just unknown.
  if (rows.every((p) => !p.lastTest)) return check('swarm', 'skip', `${parts.join('; ')}.`, 'Settings → Swarm → Test connection, or run `kora doctor` without --quick.');
  if (okCount === 0) {
    const offline = rows.every((p) => p.lastTest?.outcome === 'unreachable');
    return check('swarm', 'fail', parts.join('; '), offline ? 'You look offline, or a firewall blocks the providers. Swarm workers need the internet (local models excepted).' : 'Settings → Swarm: re-test the providers, or add an OpenRouter key.');
  }
  if (!swarm.models.available.length) return check('swarm', 'warn', `${parts.join('; ')}. Every model is cooling down after rate limits.`, 'Wait a few minutes, or add another provider in Settings → Swarm.');
  return check('swarm', okCount === rows.length ? 'ok' : 'warn', parts.join('; '), okCount === rows.length ? null : 'Settings → Swarm: fix or turn off the failing provider.');
}

export async function probeLocalModelServers(f: typeof fetch = globalThis.fetch, timeoutMs = 1500): Promise<LocalModelServer[]> {
  return Promise.all(LOCAL_MODEL_SERVERS.map(async ({ kind, baseUrl }) => {
    try {
      const res = await f(`${baseUrl}${kind === 'ollama' ? '/api/tags' : '/v1/models'}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { kind, baseUrl, reachable: true, models: [] };
      const j: any = await res.json().catch(() => null);
      const list: any[] = kind === 'ollama' ? (Array.isArray(j?.models) ? j.models : []) : (Array.isArray(j?.data) ? j.data : []);
      const models = list.map((m) => String(kind === 'ollama' ? (m?.name ?? m?.model ?? '') : (m?.id ?? ''))).filter(Boolean).slice(0, 50);
      return { kind, baseUrl, reachable: true, models };
    } catch { return { kind, baseUrl, reachable: false, models: [] }; }
  }));
}

async function checkLocalModels(d: HealthDeps): Promise<HealthCheck> {
  const servers = await probeLocalModelServers(d.fetch ?? globalThis.fetch);
  const data = { servers };
  const up = servers.filter((s) => s.reachable);
  const name = (k: LocalModelServer['kind']) => (k === 'ollama' ? 'Ollama' : 'LM Studio');
  if (!up.length) return { ...check('local-models', 'skip', 'Neither Ollama (:11434) nor LM Studio (:1234) is running. Optional: they keep Swarm workers on your machine.'), data };
  const parts = up.map((s) => `${name(s.kind)}: ${s.models.length} model${s.models.length === 1 ? '' : 's'}${s.models.length ? ` (${s.models.slice(0, 3).join(', ')}${s.models.length > 3 ? ', …' : ''})` : ''}`);
  const empty = up.filter((s) => !s.models.length);
  return {
    ...check('local-models', empty.length ? 'warn' : 'ok', parts.join('; '),
      empty.length ? `${empty.map((s) => name(s.kind)).join(' and ')} runs with no model loaded: ${empty[0].kind === 'ollama' ? '`ollama pull qwen3-coder`' : 'download a model in LM Studio'}.` : null),
    data,
  };
}

const CAUSE_WORDS: Record<string, string> = { idle: 'idle over an hour', 'model-switch': 'model switch', compaction: 'compaction', unknown: 'unknown' };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
/** Plain words for a cost summary: cache-hit share, misses and why, and what bounded Reads saved. Exported for tests. */
export function describeCostSummary(s: CostSummary): { status: HealthStatus; detail: string; fix: string | null } {
  if (!s.calls || s.cacheHit === null) return { status: 'skip', detail: 'No Claude calls recorded yet. Send a message in a Claude thread and this fills in.', fix: null };
  const causes = Object.entries(s.missCauses).map(([k, n]) => `${n} ${CAUSE_WORDS[k] ?? k}`).join(', ');
  const parts = [`${pct(s.cacheHit)} of prompt tokens came from the cache over ${s.calls} call${s.calls === 1 ? '' : 's'} in ${s.threads} thread${s.threads === 1 ? '' : 's'} (last 7 days).`];
  if (s.misses) parts.push(`${s.misses} cache miss${s.misses === 1 ? '' : 'es'} (${causes}) re-wrote ${kTok(s.missWritten)} tokens.`);
  if (s.reads.bounded || s.reads.shadow) {
    const rate = s.reads.expandRate;
    parts.push(s.reads.bounded
      ? `Bounded reads: ${s.reads.bounded}, about ${kTok(s.reads.avoidedTokens)} tokens kept out of context${rate !== null ? `; ${pct(rate)} needed the rest within 3 turns` : ''}.`
      : `Bounded reads in shadow mode: ${s.reads.shadow} would have been windowed.`);
  }
  if (s.pruned.resumes) parts.push(`Cold resumes: ${s.pruned.resumes} continued with old tool outputs trimmed, about ${kTok(s.pruned.tokens)} tokens not re-written.`);
  if (s.bash.done) parts.push(`Big command output: ${s.bash.done} trimmed, about ${kTok(s.bash.doneTokens)} tokens kept out of context.`);
  else if (s.bash.shadow) parts.push(`Big command output in shadow mode: ${s.bash.shadow} result${s.bash.shadow === 1 ? '' : 's'} over 8k characters; a trim would have saved about ${kTok(s.bash.shadowTokens)} tokens.`);
  const low = s.cacheHit < 0.7 && s.calls >= 20;
  return { status: low ? 'warn' : 'ok', detail: parts.join(' '), fix: low ? 'Misses are the expensive part: stay on one model per thread, and start a new thread after a long break instead of resuming an old one.' : null };
}
async function checkPromptCache(d: HealthDeps): Promise<HealthCheck> {
  await new Promise<void>((r) => setImmediate(r)); // let pending socket work run before the (bounded) file read
  const since = (d.now ?? Date.now)() - 7 * 24 * 3600 * 1000;
  const lines = d.costLines ? d.costLines() : readCostLog({ sinceMs: since, maxBytes: 2 * 1024 * 1024 });
  const s = summarizeCostLog(lines);
  const r = describeCostSummary(s);
  return { ...check('prompt-cache', r.status, r.detail, r.fix), data: { cacheHit: s.cacheHit, calls: s.calls, misses: s.misses, missCauses: s.missCauses, reads: s.reads } };
}

export function checkCliPath(d: HealthDeps): HealthCheck {
  const home = d.home ?? os.homedir();
  const bin = path.join(home, '.local', 'bin');
  const win = process.platform === 'win32';
  const cli = ['kora', 'kora-dev'].find((n) => fs.existsSync(path.join(bin, win ? `${n}.cmd` : n))) || 'kora';
  const same = (dir: string) => (win ? path.resolve(dir).toLowerCase() === bin.toLowerCase() : path.resolve(dir) === bin);
  const envPath = d.env?.PATH ?? process.env.PATH ?? '';
  const onPath = envPath.split(path.delimiter).some((dir) => dir && same(dir));
  const fix = win
    ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${bin}', 'User')   (in PowerShell, then open a new terminal)`
    : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`;
  if (onPath) {
    return check('cli-path', 'ok', `${bin} is on PATH.`);
  }
  // The daemon is started by the app, so its own PATH never has ~/.local/bin; what matters is a new terminal's. If a shell startup
  // file already adds the folder, a new terminal finds `kora` and there is nothing to fix.
  if (!win) {
    for (const rc of ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']) {
      try {
        if (/\.local\/bin/.test(fs.readFileSync(path.join(home, rc), 'utf8'))) return check('cli-path', 'ok', `${bin} is added to PATH in ~/${rc}.`);
      } catch { /* no such file */ }
    }
  }
  return check(
    'cli-path',
    'warn',
    `${bin} holds \`${cli}\` but is not on this shell's PATH, so a new terminal will not find it`,
    fix,
  );
}

// ---- the report ---------------------------------------------------------------------------------------------------

/** Run the checks (all of them, or `only`). Checks run concurrently; each has its own deadline. */
export async function runHealthChecks(opts: { cwd?: string | null; only?: readonly HealthCheckId[] }, d: HealthDeps): Promise<HealthReport> {
  const want = new Set<HealthCheckId>(opts.only?.length ? opts.only : HEALTH_CHECK_IDS);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : null;
  const run = d.run ?? ((bin, args, ms) => runChild(bin, args, ms, d.env));
  const home = d.home ?? os.homedir();
  const find = d.findBinary ?? ((name) => findOnSearchPath(name, d.env ?? process.env, home));
  const limit = d.timeoutMs ?? 12_000;
  const guard = (id: HealthCheckId, p: () => Promise<HealthCheck>): Promise<HealthCheck> =>
    deadline(Promise.resolve().then(p), limit, () => check(id, 'warn', `Timed out after ${Math.round(limit / 1000)} s.`, 'Run the check again; if it keeps timing out, export diagnostics and report it.'))
      .catch((e: any) => check(id, 'warn', `The check itself failed: ${String(e?.message ?? e).split('\n')[0]}`));

  // Shared facts, fetched once and only when a check needs them.
  const daemonP = want.has('daemon') || want.has('ports') ? d.daemon().catch((e: any): DaemonInfo => ({ running: false, version: null, pid: null, uptimeMs: null, error: String(e?.message ?? e) })) : null;
  const claudeP = want.has('claude-cli') || want.has('claude-auth') ? claudeFacts(d, run, find) : null;
  const swarmP = want.has('swarm') || want.has('opencode') ? (d.swarmStatus ? d.swarmStatus().catch(() => null) : Promise.resolve(null)) : null;

  const jobs: Promise<HealthCheck>[] = [];
  for (const id of HEALTH_CHECK_IDS) {
    if (!want.has(id)) continue;
    switch (id) {
      case 'daemon': jobs.push(guard(id, () => checkDaemon({ ...d, daemon: () => daemonP! }))); break;
      case 'claude-cli': jobs.push(guard(id, async () => checkClaudeCli(await claudeP!, home))); break;
      case 'claude-auth': jobs.push(guard(id, async () => checkClaudeAuth(await claudeP!))); break;
      case 'codex': jobs.push(guard(id, () => checkCodex(d, run, find))); break;
      case 'antigravity': jobs.push(guard(id, () => checkAntigravity(d, run, find))); break;
      case 'git': jobs.push(guard(id, () => checkGit(d, run, find))); break;
      case 'opencode': jobs.push(guard(id, async () => checkOpencode(d, await swarmP!))); break;
      case 'graph': jobs.push(guard(id, () => checkGraph(d, cwd))); break;
      case 'disk': jobs.push(guard(id, () => checkDisk(d))); break;
      case 'ports': jobs.push(guard(id, async () => checkPorts(d, await daemonP!))); break;
      case 'swarm': jobs.push(guard(id, async () => checkSwarm(await swarmP!))); break;
      case 'local-models': jobs.push(guard(id, () => checkLocalModels(d))); break;
      case 'prompt-cache': jobs.push(guard(id, () => checkPromptCache(d))); break;
      case 'cli-path': jobs.push(guard(id, async () => checkCliPath(d))); break;
    }
  }
  return {
    koraVersion: d.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    node: process.version,
    cwd,
    generatedAt: (d.now ?? Date.now)(),
    checks: await Promise.all(jobs),
  };
}

const AGENT_ROWS: ReadonlySet<HealthCheckId> = new Set<HealthCheckId>(['claude-cli', 'claude-auth', 'codex', 'opencode', 'antigravity']);

/**
 * Each agent row is optional on its own, but at least one agent must work (Claude signed in, or Codex, OpenCode,
 * Antigravity ok). `usable` is null when the report has no agent rows (a subset run); `bad`/`warn` count the whole
 * report: agent rows count nothing while one works, and as ONE problem when none does.
 */
export function agentSummary(checks: readonly HealthCheck[]): { usable: boolean | null; bad: number; warn: number } {
  const agents = checks.filter((c) => AGENT_ROWS.has(c.id));
  const rest = checks.filter((c) => !AGENT_ROWS.has(c.id));
  const usable = agents.length ? agents.some((c) => c.status === 'ok' && c.id !== 'claude-cli') : null;
  return {
    usable,
    bad: rest.filter((c) => c.status === 'fail').length + (usable === false ? 1 : 0),
    warn: rest.filter((c) => c.status === 'warn').length,
  };
}

/** `kora doctor` text: one row per check, a fix line under anything not ok. */
export function formatHealthReport(r: HealthReport): string {
  const glyph: Record<HealthStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };
  const w = Math.max(...r.checks.map((c) => c.label.length));
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`${glyph[c.status]} ${c.label.padEnd(w)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`  ${' '.repeat(w)}  fix: ${c.fix}`);
  }
  if (agentSummary(r.checks).usable === false) lines.push(`✗ ${'Coding agent'.padEnd(w)}  None of Claude Code, Codex, OpenCode or Antigravity works yet. Fix any one of them.`);
  return lines.join('\n') + '\n';
}

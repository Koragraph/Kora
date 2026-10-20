// `kora uninstall` — remove what Kora added to this Mac outside its own folders, and with --purge its data too.
//
// Kora writes, outside ~/.kora and ~/.koragraph:
//   - per repo it worked in: the managed CLAUDE.md / AGENTS.md blocks, .claude/settings.local.json hooks, .mcp.json
//     key (enforcement adapters, `kora enforce uninstall`) and the koragraph re-index block in .git/hooks/*
//   - ~/.claude/skills/{koraswarm,korachat,kora-orchestrator}/SKILL.md (the lead's playbooks)
//   - the [mcp_servers.kora] section and the trust lines Kora added in ~/.codex/config.toml (only when Codex was set up)
//   - the `kora` CLI shim in ~/.local/bin (kora-runtime.sh)
// Each removal only touches kora-managed entries; anything the user wrote around them stays. --purge also deletes
// <KORA_HOME> (chats, settings, worktrees, OpenCode, logs), the graph store and the app's Electron data, after pruning
// the git worktree records Kora's worktrees left in each repo. The app bundle itself is the user's to trash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IO } from '../main';
import { parseArgs } from '../args';
import { isDangerousRmTarget } from '../../util/safe-path';
import { thisComputer, removeAppHint, appStateDir } from '../../util/platform-copy';

export const summary = `Remove what Kora added to ${thisComputer()} (repo hooks, skills, CLI shim); --purge also deletes its data`;
export const usage = `Usage: kora uninstall [--dry-run] [--purge [--yes]]

Stops the kora daemon, then removes what Kora wrote outside its own folders:
  - in every repo Kora opened or indexed: its CLAUDE.md / AGENTS.md blocks, .claude/settings.local.json hooks,
    .mcp.json entry and git re-index hooks (only Kora's own entries; yours stay)
  - ~/.claude/skills/{koraswarm,korachat,kora-orchestrator}, the [mcp_servers.kora] section of ~/.codex/config.toml
  - the \`kora\` command in ~/.local/bin

  --dry-run   list what would be removed, change nothing
  --purge     also delete your Kora data: chats, settings, worktrees, the downloaded OpenCode and logs (~/.kora),
              the code graph (~/.koragraph) and the app's window state (${appStateDir()}).
              Needs --yes. Branches Kora's workers created stay in your repos.

${removeAppHint()}`;

export interface UninstallPaths {
  home: string;
  koraHome: string;
  graphHome: string;
  /** Electron user data of the app this runtime belongs to, or null when unknown. */
  userData: string | null;
  binDir: string;
  cliName: string;
  codexConfig: string;
}

export function uninstallPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): UninstallPaths {
  const koraHome = env.KORA_HOME || path.join(home, '.kora');
  const base = path.basename(koraHome);
  // kora-runtime.sh / ShellContext.ts: stable app → "kora", the dev flavor (~/.kora-dev) → "kora-dev-app".
  const userDataName = base === '.kora' ? 'kora' : base === '.kora-dev' ? 'kora-dev-app' : null;
  return {
    home,
    koraHome,
    graphHome: env.KORAGRAPH_HOME || (base === '.kora' ? path.join(home, '.koragraph') : path.join(koraHome, 'koragraph')),
    // Electron's userData: ~/Library/Application Support/<name> on macOS, %APPDATA%\<name> on Windows.
    userData: userDataName ? (process.platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), userDataName) : path.join(home, 'Library', 'Application Support', userDataName)) : null,
    binDir: env.KORA_BIN_DIR || path.join(home, '.local', 'bin'),
    cliName: env.KORA_CLI_NAME || (base === '.kora-dev' ? 'kora-dev' : 'kora'),
    codexConfig: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  };
}

const SKILLS = ['koraswarm', 'korachat', 'kora-orchestrator'] as const;

/** A skill folder is ours when its SKILL.md declares our name and nothing else lives in the folder. */
export function isKoraSkillDir(dir: string, name: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length !== 1 || entries[0] !== 'SKILL.md') return false;
    const head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 200);
    return new RegExp(`^---\\s*\\nname:\\s*${name}\\s*\\n`).test(head);
  } catch { return false; }
}

/**
 * The CLI shim kora-runtime.sh wrote (a kora-managed script, or a symlink into a kora runtime). With `koraHome` set
 * to anything but the stable ~/.kora, the shim must also point into THAT home's runtime: `kora uninstall` run for Kora
 * Dev, a QA stack or any custom KORA_HOME removed the stable app's `~/.local/bin/kora` (found 2026-10-04).
 */
export function isKoraShim(file: string, koraHome?: string, home = os.homedir()): boolean {
  try {
    const st = fs.lstatSync(file);
    const own = !koraHome || isStableHome(koraHome, home) ? null : path.join(koraHome, 'app') + path.sep;
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      return own ? target.startsWith(own) : /\/\.kora[^/]*\/app\/|\/kora\/packages\/runtime\//.test(target);
    }
    if (!st.isFile()) return false;
    const head = fs.readFileSync(file, 'utf8').slice(0, 1200);
    // A Windows kora.cmd may spell its paths with either separator.
    const norm = (t: string) => (process.platform === 'win32' ? t.replace(/\//g, '\\').toLowerCase() : t);
    return head.includes('kora-managed-shim') && (!own || norm(head).includes(norm(own)));
  } catch { return false; }
}

const isStableHome = (koraHome: string, home: string) => path.resolve(koraHome) === path.join(home, '.kora');

/**
 * The Claude skills and the Codex MCP entry live in the user's own ~/.claude and ~/.codex, shared by every Kora on this
 * Mac (Kora.app and Kora Dev.app write the same ones). Remove them only when the last Kora goes: the stable or dev home
 * being uninstalled and no other one left. A custom KORA_HOME (QA stack, tests, a second install) never removes them.
 */
export function ownsSharedEntries(p: Pick<UninstallPaths, 'home' | 'koraHome'>): boolean {
  const stable = path.join(p.home, '.kora');
  const dev = path.join(p.home, '.kora-dev');
  const self = path.resolve(p.koraHome);
  if (self !== stable && self !== dev) return false;
  const other = self === stable ? dev : stable;
  return !fs.existsSync(other);
}

/** Repos Kora worked in: its Code projects and every repo in its graph store. Existing directories only, never ~. */
export function knownRepos(p: UninstallPaths, graphRepos: () => string[] = () => graphStoreRepos(p)): string[] {
  const out = new Set<string>();
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(p.koraHome, 'kora-daemon', 'projects.json'), 'utf8'));
    for (const proj of Array.isArray(projects) ? projects : []) {
      if (proj?.surface === 'blobs') continue; // a blob's folder is an assistant workspace, not a repo
      if (typeof proj?.workspaceRoot === 'string') out.add(proj.workspaceRoot);
    }
  } catch { /* no projects */ }
  // Every folder a chat thread ran in: the first send writes the rulebook + hooks there even when the folder was never
  // opened as a project or indexed (a socket/CLI thread), so neither list above knows it.
  try {
    const chat = path.join(p.koraHome, 'chat');
    for (const id of fs.readdirSync(chat)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(chat, id, 'meta.json'), 'utf8'));
        if (typeof m?.cwd === 'string' && m.cwd && !isBlobsCwdSafe(m.cwd)) out.add(m.cwd);
      } catch { /* damaged or foreign entry */ }
    }
  } catch { /* no chat store */ }
  for (const r of graphRepos()) out.add(r);
  // The ledger of repos Kora wrote into: survives "Remove project" and thread deletion, which drop the records above.
  try { for (const r of (require('../../enforce/repo-footprint') as typeof import('../../enforce/repo-footprint')).touchedRepos(p.koraHome)) out.add(r); } catch { /* no ledger */ }
  return [...out]
    .map((r) => path.resolve(r))
    .filter((r) => !unsafeRoot(r, p.home) && !r.startsWith(p.koraHome + path.sep) && isDir(r))
    .sort();
}

function isBlobsCwdSafe(cwd: string): boolean { try { return (require('../../blobs/home') as typeof import('../../blobs/home')).isBlobsCwd(cwd); } catch { return false; } }

function graphStoreRepos(p: UninstallPaths): string[] {
  const db = path.join(p.graphHome, 'graph.db');
  if (!fs.existsSync(db)) return [];
  try {
    const Database = require('better-sqlite3');
    const h = new Database(db, { readonly: true, fileMustExist: true });
    try { return (h.prepare('SELECT full_path FROM repositories').all() as { full_path: unknown }[]).map((r) => r.full_path).filter((x): x is string => typeof x === 'string'); }
    finally { h.close(); }
  } catch { return []; }
}

/** The filesystem root, the home dir or an ancestor of it, or anything shallower than /a/b: never a repo to edit. */
function unsafeRoot(dir: string, home: string): boolean {
  return dir === home || (home + path.sep).startsWith(dir + path.sep) || dir.split(path.sep).filter(Boolean).length < 2;
}
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
const tilde = (p: string, home: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

async function stopDaemon(io: IO): Promise<void> {
  const daemon = require('../../server/daemon') as typeof import('../../server/daemon');
  const { defaultSocketPath } = require('../../protocol/types') as typeof import('../../protocol/types');
  if (!(await daemon.isSocketAlive(defaultSocketPath(), 500))) return;
  try {
    const { callOnce } = require('../../protocol/client') as typeof import('../../protocol/client');
    await callOnce('server.shutdown', {}, undefined, 5000);
  } catch { /* it may close the socket before answering */ }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await daemon.isSocketAlive(defaultSocketPath(), 300))) await new Promise((r) => setTimeout(r, 150));
  io.out((await daemon.isSocketAlive(defaultSocketPath(), 300)) ? '! the kora daemon is still running; quit Kora.app and run this again\n' : '✓ stopped the kora daemon\n');
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.help) { io.out(`${usage}\n`); return 0; }
  const dry = flags['dry-run'] === true;
  const purge = flags.purge === true;
  if (purge && !dry && flags.yes !== true) {
    io.err('kora uninstall --purge deletes your Kora chats, settings, worktrees and code graph. Re-run with --yes to confirm, or --dry-run to see the list.\n');
    return 2;
  }
  const p = uninstallPaths();
  const repos = knownRepos(p);
  const say = (s: string) => io.out(`${dry ? '[dry run] ' : ''}${s}\n`);

  if (!dry) await stopDaemon(io);

  // 1. repos: enforcement entries + git re-index hooks (both remove only kora-managed blocks)
  if (repos.length) say(`${dry ? 'would clean' : 'cleaning'} ${repos.length} repo(s):`);
  const { createEnforcer } = require('../../enforce/index') as typeof import('../../enforce/index');
  const { kg } = require('../../graph/embedded') as typeof import('../../graph/embedded');
  const enforcer = dry ? null : createEnforcer();
  for (const root of repos) {
    if (dry) { say(`  ${tilde(root, p.home)}`); continue; }
    let changed = 0;
    try { changed += (await enforcer!.uninstall({ agent: 'all', cwd: root })).results.filter((r) => r.action === 'removed').length; } catch { /* next */ }
    if (fs.existsSync(path.join(root, '.git'))) {
      try { changed += (kg('src/services/git-hooks.js').uninstallHooks(root).results as { action: string }[]).filter((r) => r.action === 'removed' || r.action === 'unhooked').length; } catch { /* no hooks dir */ }
    }
    try { (require('../../enforce/repo-footprint') as typeof import('../../enforce/repo-footprint')).forgetTouchedRepo(root); } catch { /* ledger is best effort */ }
    io.out(`  ${changed ? '✓' : '·'} ${tilde(root, p.home)}${changed ? ` (${changed} entr${changed === 1 ? 'y' : 'ies'} removed)` : ''}\n`);
  }

  // 2. home: skills, Codex MCP entry (shared by every Kora on this Mac), the CLI shim (this install's own)
  const shared = ownsSharedEntries(p);
  if (!shared) say(`kept the Claude skills and the Codex MCP entry (shared with the other Kora on ${thisComputer()})`);
  for (const name of shared ? SKILLS : []) {
    const dir = path.join(p.home, '.claude', 'skills', name);
    if (!isKoraSkillDir(dir, name)) continue;
    if (!dry) fs.rmSync(dir, { recursive: true, force: true });
    say(`${dry ? 'would remove' : '✓ removed'} ${tilde(dir, p.home)}`);
  }
  if (shared) try {
    const text = fs.readFileSync(p.codexConfig, 'utf8');
    if (/^\[mcp_servers\.kora\]/m.test(text)) {
      if (!dry) (require('../../enforce/mcpconfig') as typeof import('../../enforce/mcpconfig')).removeCodexMcp(p.codexConfig);
      say(`${dry ? 'would remove' : '✓ removed'} [mcp_servers.kora] from ${tilde(p.codexConfig, p.home)}`);
    }
  } catch { /* no codex config */ }
  // The Codex trust lines Kora added for its worktrees / trusted folders (only the ledger's, never the user's own).
  if (shared) try {
    const mc = require('../../enforce/mcpconfig') as typeof import('../../enforce/mcpconfig');
    const ledger = mc.readCodexTrustLedger(p.koraHome);
    if (ledger.length > 0) {
      const gone = dry ? ledger.filter((r) => fs.readFileSync(p.codexConfig, 'utf8').includes(`[projects.${JSON.stringify(r)}]`)) : mc.removeCodexTrustAdded(p.codexConfig, ledger);
      if (gone.length > 0) say(`${dry ? 'would remove' : '✓ removed'} ${gone.length} Codex trust line${gone.length === 1 ? '' : 's'} Kora added from ${tilde(p.codexConfig, p.home)}`);
    }
  } catch { /* no codex config */ }
  const shim = path.join(p.binDir, process.platform === 'win32' ? `${p.cliName}.cmd` : p.cliName);   // kora-runtime.cjs writes kora.cmd
  if (isKoraShim(shim, p.koraHome, p.home)) {
    if (!dry) fs.rmSync(shim, { force: true });
    say(`${dry ? 'would remove' : '✓ removed'} ${tilde(shim, p.home)}`);
  }

  // 3. --purge: Kora's own data. Prune the worktree records first, or every repo keeps listing dead worktrees.
  if (purge) {
    if (!dry) for (const root of repos) spawnSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore', timeout: 10_000 });
    for (const dir of [p.koraHome, p.graphHome, p.userData]) {
      if (!dir || !fs.existsSync(dir)) continue;
      // KORA_HOME / KORAGRAPH_HOME come from the environment: a mis-set one (KORA_HOME=$HOME, =/Users, =/) must never
      // turn --purge into rm -rf of the home folder.
      if (isDangerousRmTarget(dir, p.home)) { io.err(`kora uninstall: refusing to delete ${dir} — it is the home folder, an ancestor of it, or too shallow. Delete Kora's data by hand.\n`); continue; }
      if (!dry) fs.rmSync(dir, { recursive: true, force: true });
      say(`${dry ? 'would delete' : '✓ deleted'} ${tilde(dir, p.home)}`);
    }
  } else {
    say(`kept your data: ${tilde(p.koraHome, p.home)} (chats, settings, worktrees) and ${tilde(p.graphHome, p.home)} (code graph). \`kora uninstall --purge --yes\` deletes them.`);
  }
  io.out('\nLast step: quit Kora, then drag Kora.app from Applications to the Trash.\n');
  return 0;
}

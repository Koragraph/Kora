// kora CLI entry. Command modules live in src/cli/commands/<name>.ts and export:
//   { summary: string; usage: string; run(argv: string[], io: IO): Promise<number> }
// Loaders, not imports: `kora --help` must not load node-pty, tree-sitter or sqlite.
import { version } from '../../package.json';
import { installWindowsRenameRetry } from '../util/win-fs-retry';
import { thisComputer } from '../util/platform-copy';

installWindowsRenameRetry();   // Windows: a rename onto a briefly-open file is retried (util/win-fs-retry.ts)

export interface IO { out: (s: string) => void; err: (s: string) => void }
export interface Command { summary: string; usage: string; run(argv: string[], io: IO): Promise<number> }

// name → [owner, summary]. Owner is informational (which workstream builds it).
export const COMMANDS: Record<string, { summary: string; load: () => Command; hidden?: boolean }> = {
  agent:     { summary: 'Spawn an agent in its own worktree; list, prompt, wait, read; promote to orchestrator', load: () => require('./commands/agent') },
  fleet:     { summary: 'Orchestrator fleet: record the plan/budget, read the roster, verify a merge', load: () => require('./commands/fleet') },
  swarm:     { summary: 'Swarm mode (free-model OpenCode workers): status | setup | install | key set|clear | test | models', load: () => require('./commands/swarm') },
  ext:       { summary: 'Extensions: add MCP servers and skills once, every agent gets them (list | add | import | catalog | test | skill)', load: () => require('./commands/ext') },
  orchestrator: { summary: 'Install the portable orchestrator playbook/skill for every agent (or print it)', load: () => require('./commands/orchestrator') },
  worktree:  { summary: 'List agent worktrees; merge one into your checkout; remove', load: () => require('./commands/worktree') },
  merge:     { summary: 'Graph-verified merge: check | plan | do — catches cross-diff semantic conflicts git merges clean', load: () => require('./commands/merge') },
  pr:        { summary: 'Graph-verified PR check: check | verify — run the semantic gate on GitHub PRs (via gh)', load: () => require('./commands/pr') },
  graph:     { summary: 'Query the code graph: explore | neighbours | blast_radius | search_code | changes_with | file_symbols | overview | brief | status | report | ingest', load: () => require('./commands/graph') },
  savings:   { summary: 'Real token usage per pane or transcript (measured only)', load: () => require('./commands/savings') },
  bench:     { summary: 'A/B a task: plain Claude Code vs inside kora, cost from Claude itself', load: () => require('./commands/bench') },
  config:    { summary: 'get [key] | set <key> <value> | path — restartMode, autoCompact, autoAnswer, budgets, …', load: () => require('./commands/config') },
  setup:     { summary: 'Index this repo, install enforcement for every agent you have, git re-index hooks, shims', load: () => require('./commands/setup') },
  takeover:  { summary: 'Remove the previous runtime\'s hooks/blocks/skill from repos and ~, install kora\'s (--dry-run)', load: () => require('./commands/takeover'), hidden: true },
  doctor:    { summary: 'Check the whole chain and name a fix for anything wrong', load: () => require('./commands/doctor') },
  server:    { summary: 'start | stop | status | run', load: () => require('./commands/server') },
  mcp:       { summary: 'Serve the graph over MCP on stdio (opt-in for Claude: KORA_MCP=1)', load: () => require('./commands/mcp') },
  update:    { summary: 'How to update Kora (an app install updates itself)', load: () => require('./commands/update'), hidden: true },
  version:   { summary: 'Version and commit', load: () => require('./commands/version') },
  uninstall: { summary: `Remove what Kora added to ${thisComputer()} (repo hooks, skills, CLI shim); --purge also deletes its data`, load: () => require('./commands/uninstall') },
  // advanced / internal — work, not listed
  pane:      { summary: 'Raw pane control', load: () => require('./commands/pane'), hidden: true },
  'cross-worktree': { summary: 'Internal: merge gate worker for the runtime', load: () => require('./commands/cross-worktree'), hidden: true },
  enforce:   { summary: 'Enforcement adapters install|uninstall|status (setup does this)', load: () => require('./commands/enforce'), hidden: true },
  ingest:    { summary: 'Alias of graph ingest', load: () => require('./commands/ingest'), hidden: true },
  'blob-tools': { summary: 'Document tools for blobs (xlsx | docx | pptx | pdf, JSON in/out)', load: () => require('./commands/blob-tools'), hidden: true },
  hook:      { summary: 'Invoked by agent hooks inside a pane', load: () => require('./commands/hook'), hidden: true },
  'trim-run': { summary: 'Run a test/build command unchanged and print its output trimmed (the Bash trim wrapper)', load: () => require('./commands/trim-run'), hidden: true },
};

/** The runtime home as the user types it: `~/.kora`, or `~/.kora-dev` for the Dev flavor (KORA_HOME). */
export function displayHome(): string {
  try {
    const os = require('node:os') as typeof import('node:os');
    if (process.platform === 'win32') {   // `C:\Users\me\.kora` reads as `~/.kora`, like the help text
      const h = os.homedir(), home = process.env.KORA_HOME || `${h}\\.kora`;
      return home.toLowerCase().startsWith(h.toLowerCase() + '\\') ? `~${home.slice(h.length).replace(/\\/g, '/')}` : home;
    }
    const home = (process.env.KORA_HOME || `${os.homedir()}/.kora`);
    return home.startsWith(os.homedir() + '/') ? `~${home.slice(os.homedir().length)}` : home;
  } catch { return '~/.kora'; }
}
/** Help text names `~/.kora/…` paths; a flavored home (Kora Dev) must read its own. `~/.koragraph` and `~/.kora-dev` stay. */
export function flavorText(text: string): string {
  const h = displayHome();
  return h === '~/.kora' ? text : text.replace(/~\/\.kora(?![\w-])/g, h);
}
const ADVANCED = ['pane', 'enforce', 'ingest', 'hook', 'takeover', 'update'];

export function helpText(): string {
  return flavorText(`kora ${version} — the runtime behind the Kora app: chat sessions, orchestrator workers, and the code
graph that keeps your agents' context small.

Usage: kora <command>

${Object.entries(COMMANDS).filter(([, c]) => !c.hidden).map(([n, c]) => `  ${n.padEnd(14)}${c.summary}`).join('\n')}

  kora <command> --help
  advanced: ${ADVANCED.join(' · ')}

Store: ~/.koragraph/graph.db (shared with a standalone koragraph). Runtime: ~/.kora/
`);
}
export const HELP = helpText();

/** node:sqlite (the graph store reader) prints "ExperimentalWarning: SQLite ..." on every CLI call that touches it: pure noise for a user. Other warnings stay. */
let warningsFiltered = false;
function quietSqliteWarning(): void {
  if (warningsFiltered) return; warningsFiltered = true;
  const prior = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w: Error) => {
    if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(String(w.message))) return;
    for (const l of prior) { try { (l as (w: Error) => void)(w); } catch { /* ignore */ } }
  });
}

/**
 * Commands that change what Kora trusts, how it is configured or what is installed, or that delete its data, are for the
 * person at a terminal. They write files in-process (no socket call to gate), so an agent that runs one - a prompt-injected
 * README says `kora setup --trust .` - would trust a folder (its own hooks then run unfenced), rewrite config.json or wipe the
 * data. An agent process is marked by KORA_AGENT (control-auth.ts isAgentOrigin; the credential guard refuses to unset it).
 * Returns the refusal text, or null. S6 2026-10-14.
 */
let agentGateOffForTests = false;
/** Tests of what a person-only command does call it in-process as the person, even when the test run itself was started
 *  from inside a Kora agent pane (KORA_AGENT set). An in-process switch, not an env var: nothing an agent can set from a
 *  shell, and a script that can call this could call the command module directly anyway. */
export function setAgentGateForTests(off: boolean): void { agentGateOffForTests = off; }

export function agentOnlyRefusal(name: string, rest: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const { isAgentOrigin } = require('../server/control-auth') as typeof import('../server/control-auth');
  if (agentGateOffForTests && env === process.env) return null;
  if (!isAgentOrigin(env)) return null;
  const flag = (f: string) => rest.some((a) => a === f || a.startsWith(`${f}=`));
  const sub = rest.find((a) => !a.startsWith('-'));
  const blocked =
    (name === 'config' && sub === 'set') ||
    (name === 'setup' && flag('--trust')) ||
    ((name === 'uninstall' || name === 'takeover') && !flag('--dry-run')) ||
    name === 'update' ||
    (name === 'swarm' && ['key', 'setup', 'install', 'backend'].includes(sub ?? '')) ||
    // A new MCP server or skill is code every agent then runs: an agent must not be able to add one for itself.
    (name === 'ext' && (['add', 'remove', 'enable', 'disable', 'skill', 'secret'].includes(sub ?? '') || (sub === 'import' && flag('--yes')) || (sub === 'project' && (flag('--allow') || flag('--revoke')))));
  return blocked ? `kora ${name}${sub && name !== 'setup' ? ` ${sub}` : ''}${name === 'setup' ? ' --trust' : ''} changes what Kora trusts or installs, or deletes its data, so only the person at a terminal can run it. Ask the user to run it.\n` : null;
}

export async function run(argv: string[], io: IO = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }): Promise<number> {
  const [name, ...rest] = argv;
  quietSqliteWarning();
  if (!name) { io.out(helpText()); return 0; }
  if (name === 'help' || name === '--help' || name === '-h') { io.out(helpText()); return 0; }
  if (name === '--version' || name === '-v') { const { versionString } = require('./commands/version') as typeof import('./commands/version'); io.out(`${versionString()}\n`); return 0; }
  const entry = COMMANDS[name];
  if (!entry) { io.err(`kora: unknown command "${name}"\n\n${helpText()}`); return 2; }
  // stdout is the JSON-RPC channel for `kora mcp`; embedded koragraph services console.log freely.
  if (name === 'mcp' || name === 'hook' || name === 'blob-tools') {
    console.log = (...a) => console.error(...a); console.info = console.log; console.debug = console.log; console.dir = console.log as any;
  }
  // A hook is advisory: it runs inside the agent's own process on every prompt/tool and its output is injected
  // context, nothing more. It must FAIL OPEN and SILENT — a require that lands mid-rebuild, a missing native
  // binding, any throw here must never surface a stack or a non-zero exit to the agent (Claude Code prints hook
  // stderr as a scary "UserPromptSubmit hook error"). So for `hook`, swallow every failure back to exit 0; the
  // stack is available under KORA_TRACE for us, invisible to the agent otherwise.
  if (name === 'hook') {
    try {
      const cmd = entry.load();
      if (rest[0] === '--help' || rest[0] === '-h') { io.out(flavorText(cmd.usage) + '\n'); return 0; }
      return await cmd.run(rest, io);
    } catch (e: any) { if (process.env.KORA_TRACE) io.err(`kora hook: ${e?.stack || e?.message || e}\n`); return 0; }
  }
  if (rest[0] !== '--help' && rest[0] !== '-h') { const why = agentOnlyRefusal(name, rest); if (why) { io.err(why); return 2; } }
  const cmd = entry.load();
  if (rest[0] === '--help' || rest[0] === '-h') { io.out(flavorText(cmd.usage) + '\n'); return 0; }
  try { return await cmd.run(rest, io); }
  catch (e: any) { io.err(`kora ${name}: ${e?.message || e}\n`); if (process.env.KORA_TRACE) io.err(`${e?.stack}\n`); return 1; }
}

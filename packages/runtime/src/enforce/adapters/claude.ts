// Claude Code: CLAUDE.md managed block + project .claude/settings.json hooks + --mcp-config +
// --append-system-prompt. The hooks are the strong channel (a cold Grep for a code identifier is denied once), the block
// and the system prompt are the always-in-context reminder, MCP is belt and braces.
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterResult, PrepareInput } from '../index';
import { upsertBlock, removeBlock, blockStatus } from '../agentsmd';
import { unsafeRepoWrite } from '../../util/safe-path';
import { writeFileAtomic } from '../../util/atomic-write';
import { koraHome } from '../../graph/embedded';
import { writeClaudeMcpJson, claudeMcpJsonPath, upsertJsonKey, removeJsonKey, jsonKeyStatus, mcpServerSpec, SERVER_NAME, mcpEnabledFor } from '../mcpconfig';
import { rulebookShort, rulebookShortNoGraph } from '../../graph/howto';
import { sideModelEnv } from '../../util/side-model';
import { leanPaneEnv } from '../../util/lean-pane';
import { claudeCompactEnv } from '../../util/claude-compaction';
import { capSize } from '../../util/bounded';
import { blockBody, hasFlag, type Adapter, type AdapterCtx, type PrepareDelta } from './types';

export const HOOK_EVENTS: Array<[event: string, hookEvent: string, timeout: number]> = [
  ['SessionStart', 'session-start', 15],
  ['UserPromptSubmit', 'prompt', 10],
  ['PreToolUse', 'pre-tool', 10],
  ['PostToolUse', 'post-tool', 5],
  ['PostToolUseFailure', 'post-tool', 5],
  ['Stop', 'stop', 15],
  ['SessionEnd', 'session-end', 15],
];

const KORAGRAPH_HOOK_RE = /\.claude[\\/]hooks[\\/](context|nudge|preflight|record|session-end)\.mjs/;

export function hookCommand(event: string, ctx: { binPath: string; nodeBin: string }, platform: NodeJS.Platform = process.platform): string {
  // The shell-string form (macOS/Linux; Windows writes koraHookSpec's exec form instead). On Windows this string would
  // run under Git bash (`C:/a/b`, double-quoted) but not under PowerShell, Claude Code's fallback without Git bash.
  const p = (s: string) => (platform === 'win32' ? s.replace(/\\/g, '/') : s);
  return `"${p(ctx.nodeBin)}" "\${KORA_BIN:-${p(ctx.binPath)}}" hook ${event}`;
}

export interface HookCtx { binPath: string; nodeBin: string; platform?: NodeJS.Platform }

/**
 * One Kora hook entry. macOS/Linux: the shell string (`${KORA_BIN:-…}` lets a pane point it at another checkout).
 * Windows: the exec form, `command` + `args`: Claude Code spawns node directly with no shell, so neither Git bash nor
 * PowerShell parses it and a path with spaces needs no quoting. The pane's KORA_BIN redirect happens in bin/kora.js.
 */
export function koraHookSpec(event: string, ctx: HookCtx, timeout: number): Record<string, unknown> {
  const platform = ctx.platform ?? process.platform;
  if (platform === 'win32') return { type: 'command', command: ctx.nodeBin, args: [ctx.binPath, 'hook', event], timeout };
  return { type: 'command', command: hookCommand(event, ctx, platform), timeout };
}

/** A hook object that runs `kora hook …`, in either form (a shell string, or `command` + `args`). */
export function isKoraHookEntry(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const { command, args } = h as { command?: unknown; args?: unknown };
  if (!Array.isArray(args)) return isKoraHook(command);
  if (typeof command !== 'string') return false;
  const words = [command, ...args.map(String)];
  const i = words.indexOf('hook');
  return i > 0 && /(?:^|[\\/])kora(?:\.js|\.cmd)?$/i.test(words[i - 1]!);
}

/** A hook entry as one line of text (`command` plus any exec-form `args`), for notes, doctor output and tests. */
export function hookText(h: unknown): string {
  if (!h || typeof h !== 'object') return '';
  const { command, args } = h as { command?: unknown; args?: unknown };
  return [command, ...(Array.isArray(args) ? args : [])].filter((x) => x != null).map(String).join(' ');
}

/** A Kora hook in the form this platform writes: an older form counts as missing, so the next install rewrites it. */
function isCurrentKoraHook(h: unknown, platform: NodeJS.Platform): boolean {
  return isKoraHookEntry(h) && (platform === 'win32') === Array.isArray((h as { args?: unknown }).args);
}
// Matches both the baked form (`"${KORA_BIN:-/abs/bin/kora.js}" hook <event>`) and a bare `kora hook <event>`.
export const KORA_HOOK_RE = /kora(\.js\}?["']?)?\s+hook\s/;
export function isKoraHook(cmd: unknown): boolean { return typeof cmd === 'string' && KORA_HOOK_RE.test(cmd); }
export function isKoragraphHook(cmd: unknown): boolean { return typeof cmd === 'string' && KORAGRAPH_HOOK_RE.test(cmd); }

// Hooks carry absolute paths to this machine's node and checkout, so they belong in the LOCAL settings file
// (Claude Code merges it; it is per-machine by convention), not in settings.json that a team commits.
function settingsPath(root: string): string { return path.join(root, '.claude', 'settings.local.json'); }
function sharedSettingsPath(root: string): string { return path.join(root, '.claude', 'settings.json'); }
// Earlier kora builds wrote hooks into settings.json; move them out so they are not committed.
function migrateSharedHooks(root: string): boolean {
  const file = sharedSettingsPath(root); if (!fs.existsSync(file) || unsafeRepoWrite(file, root)) return false;
  try { const { settings, changed } = stripHooks(readSettings(file)); if (changed) { writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`); return true; } } catch { /* leave it */ }
  return false;
}
// The per-machine hooks file must not be committed — but the ignore rule goes into git's PER-CLONE exclude file
// (`.git/info/exclude`, shared by every worktree of the checkout), never into the repository's tracked
// `.gitignore`: appending there modified a tracked file, the checkout read as dirty, and every fleet merge was
// refused ("main checkout has 1 uncommitted change") for a change kora itself had made.
// Memoized: every sync git spawn blocks the daemon's event loop, and under swarm load one call took 100–500 ms while
// the same few repos were asked the same question from several paths (CPU profile, 10-leader e2e: 5–17 s stalls).
const excludeMemo = new Map<string, string | null>();
function excludePathOf(root: string): string | null {
  if (excludeMemo.has(root)) return excludeMemo.get(root)!;
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', timeout: 2000 });
  const v = r.status === 0 && r.stdout.trim() ? path.resolve(root, r.stdout.trim()) : null;
  if (v) { capSize(excludeMemo, 2000); excludeMemo.set(root, v); }
  return v;
}
function ensureGitignored(root: string): void {
  try {
    const gi = path.join(root, '.gitignore');
    if (fs.existsSync(gi) && /^\.claude\/settings\.local\.json\s*$/m.test(fs.readFileSync(gi, 'utf8'))) return; // already ignored by the repo
    const exclude = excludePathOf(root); // memoized sync git (see excludePathOf)
    if (!exclude) return;
    let cur = ''; try { cur = fs.readFileSync(exclude, 'utf8'); } catch { cur = ''; }
    if (/^\.claude\/settings\.local\.json\s*$/m.test(cur)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}# kora: per-machine hooks (absolute paths)\n.claude/settings.local.json\n`);
  } catch { /* fine */ }
}
/** `{}` or `{ "hooks": {} }` after the kora entries are stripped. */
function isEmptySettings(settings: any): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const keys = Object.keys(settings);
  if (keys.length === 0) return true;
  return keys.length === 1 && keys[0] === 'hooks' && (!settings.hooks || (typeof settings.hooks === 'object' && Object.keys(settings.hooks).length === 0));
}
function readSettings(file: string): any {
  try { const raw = fs.readFileSync(file, 'utf8').trim(); return raw ? JSON.parse(raw) : {}; } catch (e: any) {
    if (e && e.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON (${e.message})`);
  }
}

/** Pure merge: returns the new settings object and whether it changed. Exported for tests. */
export function mergeHooks(settings: any, ctx: HookCtx & { replaceKoragraphHooks?: boolean }): { settings: any; changed: boolean; removedKoragraph: number } {
  const before = JSON.stringify(settings);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  let removedKoragraph = 0;
  for (const [event, hookEvent, timeout] of HOOK_EVENTS) {
    const entry = { hooks: [koraHookSpec(hookEvent, ctx, timeout)] };
    let list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Drop every kora-managed entry, then add exactly one back (refresh in place, never duplicate).
    list = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.some((h: any) => isKoraHookEntry(h))));
    if (ctx.replaceKoragraphHooks) {
      const n = list.length;
      list = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.some((h: any) => isKoragraphHook(h?.command))));
      removedKoragraph += n - list.length;
    }
    list.push(entry);
    settings.hooks[event] = list;
  }
  return { settings, changed: JSON.stringify(settings) !== before, removedKoragraph };
}

/**
 * The credential guard for a Claude pane whose repo carries no Kora hooks (an untrusted folder, a folder without a
 * graph, no repo at all): Kora's PreToolUse hook as flag settings, so `kora hook pre-tool` still denies ~/.ssh & co.
 * Before (deep audit 2026-10-13 A1-4) such a pane, in Full access, read credentials with no guard at all. A user's
 * own --settings is left alone (Claude takes one), and the note says so.
 */
export function withGuardSettings(args: string[], ctx: HookCtx): { args: string[]; note: string } {
  if (hasFlag(args, '--settings')) return { args, note: 'own --settings given: Kora\'s credential guard hook not added' };
  // PreToolUse alone reports the pane "working" on every tool call (kora hook pre-tool → pane.reportState) with no
  // Stop to say "idle": the tracker then holds the pane busy HINT_QUIET_OVERRIDE_MS (30 s) past every turn's end and
  // kora_wait lags with it (deep audit A3-1). Stop / SessionEnd ride along: they only report idle and sweep markers.
  const one = (event: string, timeout: number) => [{ hooks: [koraHookSpec(event, ctx, timeout)] }];
  const settings = { hooks: { PreToolUse: one('pre-tool', 10), Stop: one('stop', 15), SessionEnd: one('session-end', 15) } };
  return { args: [...args, '--settings', JSON.stringify(settings)], note: '--settings PreToolUse credential guard + Stop state hook (no Kora hooks in this folder)' };
}

/**
 * Claude Code's interactive prompt suggestions make a hidden extra model call after every turn and leave greyed text in
 * the input box. A pane is driven by an agent, never read by a human typing, so the suggestion is pure cost (and noise
 * on kora_read). Pinned off as flag settings; merged into Kora's own `--settings` JSON when one is already there, left
 * alone when the caller passed their own settings file (Claude takes one `--settings`). `env` (Kora's compaction point)
 * rides there too: a user `env` block in ~/.claude/settings.json overrides the process env, flag settings come after it.
 */
export function withPaneSettings(args: string[], env: Record<string, string> = {}): { args: string[]; note: string | null } {
  const i = args.indexOf('--settings');
  const withEnv = Object.keys(env).length ? { env } : {};
  if (i < 0) return { args: [...args, '--settings', JSON.stringify({ promptSuggestionEnabled: false, ...withEnv })], note: 'promptSuggestionEnabled:false (no hidden suggestion call per turn)' };
  const raw = args[i + 1];
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (j.promptSuggestionEnabled === undefined) j.promptSuggestionEnabled = false;
        if (Object.keys(env).length) j.env = { ...env, ...(j.env && typeof j.env === 'object' ? j.env : {}) };
        const next = args.slice(); next[i + 1] = JSON.stringify(j);
        return { args: next, note: 'promptSuggestionEnabled:false (no hidden suggestion call per turn)' };
      }
    } catch { /* not JSON: leave it */ }
  }
  return { args, note: null };
}

export function stripHooks(settings: any): { settings: any; changed: boolean } {
  const before = JSON.stringify(settings);
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const event of Object.keys(settings.hooks)) {
      const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const kept = list.filter((e: any) => !(e && Array.isArray(e.hooks) && e.hooks.some((h: any) => isKoraHookEntry(h))));
      if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }
  return { settings, changed: JSON.stringify(settings) !== before };
}

export function hooksInstalled(root: string, platform: NodeJS.Platform = process.platform): { all: boolean; missing: string[]; koragraphPresent: boolean } {
  let settings: any = {};
  try { settings = readSettings(settingsPath(root)); } catch { /* unreadable == missing */ }
  const hooks = settings.hooks || {};
  const missing: string[] = [];
  let koragraphPresent = false;
  for (const [event] of HOOK_EVENTS) {
    const list: any[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (!list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => isCurrentKoraHook(h, platform)))) missing.push(event);
  }
  for (const event of Object.keys(hooks)) {
    const list: any[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => isKoragraphHook(h?.command)))) koragraphPresent = true;
  }
  return { all: missing.length === 0, missing, koragraphPresent };
}

// koragraph's own hook scripts (a repo that ships them, like KoragraphMCP itself) live in the SHARED settings.json.
// With --replace-koragraph-hooks they must go from there too, or they double-fire beside kora's: measured in the
// bench, koragraph's context hook injected 500 chars about MCP tools that strict MCP had not even connected.
function stripKoragraphShared(root: string): number {
  const file = sharedSettingsPath(root); if (!fs.existsSync(file) || unsafeRepoWrite(file, root)) return 0;
  try {
    const settings = readSettings(file); const hooks = settings.hooks; if (!hooks || typeof hooks !== 'object') return 0;
    let removed = 0;
    for (const event of Object.keys(hooks)) {
      const list: any[] = Array.isArray(hooks[event]) ? hooks[event] : [];
      const kept = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.some((h: any) => isKoragraphHook(h?.command))));
      removed += list.length - kept.length;
      if (kept.length) hooks[event] = kept; else delete hooks[event];
    }
    if (!Object.keys(hooks).length) delete settings.hooks;
    if (removed) writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
    return removed;
  } catch { return 0; }
}
function installHooks(ctx: AdapterCtx): AdapterResult {
  const file = settingsPath(ctx.root);
  // A repo can commit .claude (or settings.local.json) as a symlink into ~/.claude or anywhere: never write through it.
  const unsafe = unsafeRepoWrite(file, ctx.root);
  if (unsafe) return { agent: 'claude', action: 'skipped', file, detail: unsafe };
  migrateSharedHooks(ctx.root); ensureGitignored(ctx.root);
  const removedShared = ctx.replaceKoragraphHooks ? stripKoragraphShared(ctx.root) : 0;
  let settings: any;
  try { settings = readSettings(file); } catch (e: any) { return { agent: 'claude', action: 'skipped', file, detail: e.message }; }
  const existed = fs.existsSync(file);
  const { settings: next, changed, removedKoragraph } = mergeHooks(settings, ctx);
  if (!changed) return { agent: 'claude', action: removedShared ? 'refreshed' : 'managed', file, detail: removedShared ? `7 hook events present; removed ${removedShared} koragraph hook entr${removedShared === 1 ? 'y' : 'ies'} from settings.json` : '7 hook events present' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  const removedAll = removedKoragraph + removedShared;
  const detail = `hooks: ${HOOK_EVENTS.map(([e]) => e).join(', ')}${removedAll ? `; removed ${removedAll} koragraph hook entr${removedAll === 1 ? 'y' : 'ies'}` : ''}`;
  return { agent: 'claude', action: existed ? 'refreshed' : 'installed', file, detail };
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  bin: 'claude',
  needsBrief: false, // the SessionStart hook delivers the brief
  install(ctx) {
    const out: AdapterResult[] = [];
    out.push(upsertBlock(path.join(ctx.root, 'CLAUDE.md'), blockBody(ctx, false), { root: ctx.root, create: ctx.create, agent: 'claude' }));
    out.push(installHooks(ctx));
    if (mcpEnabledFor('claude')) out.push(writeClaudeMcpJson());
    else out.push({ agent: 'claude', action: 'skipped', file: claudeMcpJsonPath(), detail: 'MCP off for claude by default (hooks+rulebook+CLI drove 100% of graph use); KORA_MCP=1 to enable' });
    // Project .mcp.json is opt-in (KORA_PROJECT_MCP=1): --mcp-config is injected at every spawn already, and a
    // project-level .mcp.json makes Claude Code block on an approval dialog the first time it opens the folder.
    if (process.env.KORA_PROJECT_MCP === '1') {
      out.push(upsertJsonKey(path.join(ctx.root, '.mcp.json'), ['mcpServers', SERVER_NAME], { type: 'stdio', ...mcpServerSpec() }, 'claude', ctx.root));
    }
    return out;
  },
  uninstall(ctx) {
    const out: AdapterResult[] = [];
    out.push(removeBlock(path.join(ctx.root, 'CLAUDE.md'), 'claude', ctx.root));
    const file = settingsPath(ctx.root);
    try {
      const unsafe = unsafeRepoWrite(file, ctx.root);
      if (unsafe) out.push({ agent: 'claude', action: 'skipped', file, detail: unsafe });
      else if (fs.existsSync(file)) {
        const { settings, changed } = stripHooks(readSettings(file));
        if (changed && isEmptySettings(settings)) {
          // Nothing but our hooks was in it (Kora created it): leave no `{}` file or empty .claude/ behind.
          fs.rmSync(file);
          try { fs.rmdirSync(path.dirname(file)); } catch { /* .claude/ holds other files: keep it */ }
          out.push({ agent: 'claude', action: 'removed', file, detail: 'file removed (held only kora hooks)' });
        } else if (changed) { writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`); out.push({ agent: 'claude', action: 'removed', file, detail: 'kora hook entries removed' }); }
        else out.push({ agent: 'claude', action: 'absent', file });
      } else out.push({ agent: 'claude', action: 'absent', file });
    } catch (e: any) { out.push({ agent: 'claude', action: 'skipped', file, detail: e.message }); }
    out.push(removeJsonKey(path.join(ctx.root, '.mcp.json'), ['mcpServers', SERVER_NAME], 'claude', ctx.root));
    out.push(removeJsonKey(claudeMcpJsonPath(), ['mcpServers', SERVER_NAME], 'claude'));
    return out;
  },
  status(ctx) {
    const h = hooksInstalled(ctx.root);
    const file = settingsPath(ctx.root);
    return [
      blockStatus(path.join(ctx.root, 'CLAUDE.md'), 'claude'),
      h.all ? { agent: 'claude', action: 'managed', file, detail: h.koragraphPresent ? 'kora hooks present; koragraph hooks ALSO present (double-fire) — kora enforce install --replace-koragraph-hooks' : '7 hook events' }
        : { agent: 'claude', action: 'absent', file, detail: `missing: ${h.missing.join(', ')}` },
      ...(mcpEnabledFor('claude') ? [jsonKeyStatus(claudeMcpJsonPath(), ['mcpServers', SERVER_NAME], 'claude')] : []),
      ...(fs.existsSync(path.join(ctx.root, '.mcp.json')) ? [jsonKeyStatus(path.join(ctx.root, '.mcp.json'), ['mcpServers', SERVER_NAME], 'claude')] : []),
    ];
  },
  prepare(input: PrepareInput, ctx: AdapterCtx): PrepareDelta {
    const notes: string[] = [];
    const args = input.args.slice();
    // The CLAUDE.md block already carries the full rulebook into context; a second, short copy as a system prompt was
    // ~250 tokens re-read on every call and the main overhead on small tasks (paired bench 2026-10-15: T1/T2 +26..34%).
    // The system prompt stays where the block cannot land (untrusted folder, a skipped write). KORA_RULEBOOK_SYSPROMPT=1: both.
    let blockInPlace = false;
    if (ctx.readOnly) {
      notes.push('untrusted folder: no CLAUDE.md block or .claude/settings.local.json written (the rulebook rides as a system prompt; trust the folder to install them)');
      const g = withGuardSettings(args, ctx); args.splice(0, args.length, ...g.args); notes.push(g.note);
    } else {
      const r = upsertBlock(path.join(ctx.root, 'CLAUDE.md'), blockBody(ctx, false), { root: ctx.root, create: ctx.create, agent: 'claude' });
      if (r.action !== 'managed') notes.push(`CLAUDE.md block ${r.action}`);
      blockInPlace = r.action === 'managed' || r.action === 'installed' || r.action === 'refreshed';
      if (!hooksInstalled(ctx.root).all) {
        const h = installHooks(ctx); notes.push(`.claude/settings.local.json hooks ${h.action}`);
        // Not written (a symlinked .claude, an unreadable file): the guard still rides as flag settings.
        if (h.action === 'skipped') { const g = withGuardSettings(args, ctx); args.splice(0, args.length, ...g.args); notes.push(g.note); }
      }
      else notes.push('.claude/settings.local.json hooks present');
    }
    { const mi = args.indexOf('--model'); const p = withPaneSettings(args, claudeCompactEnv(mi >= 0 ? args[mi + 1] : undefined)); args.splice(0, args.length, ...p.args); if (p.note) notes.push(p.note); }
    if (mcpEnabledFor('claude')) {
      const mcp = writeClaudeMcpJson();
      if (!hasFlag(args, '--mcp-config')) { args.push('--mcp-config', claudeMcpJsonPath()); notes.push(`--mcp-config ${mcp.file}`); }
    } else notes.push('MCP off (KORA_MCP=1 to enable): hooks + rulebook + system prompt + CLI');
    // Strict MCP by default. Measured live: with kora's own MCP off, Claude still loaded the USER-level
    // `koragraph` server (unscoped: it answered from a different repository in the same store and the agent read a
    // file outside the worktree) plus every other user MCP, all billed on every turn. Inside a coding pane, the graph
    // is kora's job; other servers come back with KORA_STRICT_MCP=0.
    if (process.env.KORA_STRICT_MCP !== '0' && !hasFlag(args, '--strict-mcp-config')) {
      args.push('--strict-mcp-config');
      if (!hasFlag(args, '--mcp-config')) { const empty = path.join(koraHome(), 'mcp', 'none.json'); fs.mkdirSync(path.dirname(empty), { recursive: true }); if (!fs.existsSync(empty)) fs.writeFileSync(empty, '{"mcpServers":{}}\n'); args.push('--mcp-config', empty); }
      notes.push('--strict-mcp-config (user-level MCP servers, incl. a standalone koragraph, stay out of this pane; KORA_STRICT_MCP=0 to keep them)');
    }
    // The user's extension servers marked for workers, merged into the one --mcp-config file this pane reads.
    {
      const mi = args.indexOf('--mcp-config');
      const file = (require('../../extensions') as typeof import('../../extensions')).claudePaneMcpFile({ cwd: input.cwd, paneId: input.paneId }, mi >= 0 ? args[mi + 1] ?? null : null);
      if (file) { if (mi >= 0) args[mi + 1] = file; else args.push('--mcp-config', file); notes.push('extensions: worker MCP servers added'); }
    }
    if (blockInPlace && process.env.KORA_RULEBOOK_SYSPROMPT !== '1') notes.push('rulebook rides in the CLAUDE.md block only (KORA_RULEBOOK_SYSPROMPT=1 adds the system-prompt copy)');
    else if (!hasFlag(args, '--append-system-prompt') && !hasFlag(args, '--system-prompt')) { args.push('--append-system-prompt', ctx.indexed === false ? rulebookShortNoGraph({ compact: ctx.readOnly === true }) : rulebookShort({ compact: ctx.readOnly === true })); notes.push('--append-system-prompt rulebook'); }
    // Claude Code's background calls (titles, summaries) on Haiku 5.5 instead of 4.5: a tenth of the price (util/side-model.ts).
    const side = sideModelEnv({ ...process.env, ...(input.env ?? {}) });
    if (side.ANTHROPIC_DEFAULT_HAIKU_MODEL) notes.push(`side calls on ${side.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    // A worker pane leaves out what it never uses (the full skill listing, prompt suggestions, the Artifact tool); the user's
    // auto memory stays (it carries their safety rules).
    const lean = leanPaneEnv({ ...process.env, ...(input.env ?? {}) });
    if (Object.keys(lean).length) notes.push(`lean pane: ${Object.keys(lean).join(', ')} (KORA_LEAN_PANES=0 keeps them)`);
    return { args, env: { ...side, ...lean }, notes };
  },
};

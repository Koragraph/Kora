// Takeover from the previous runtime. Claude Code fires EVERY hook it finds and loads every CLAUDE.md up the tree, so
// a repo (or the home dir) the previous product set up keeps running its hooks, its SessionStart brief and its
// "memory layer" rulebook inside kora sessions. This module finds exactly what that product wrote — by its block
// markers, its hook command, its install paths, its skill name — removes only that, and leaves every byte the
// developer wrote alone. Kora's own equivalents are installed by the caller (enforcer / `kora takeover`).
//
// Plan first, apply second: planRepo/planHome return steps with an `apply` closure, so `--dry-run` prints the exact
// same list the real run executes. Everything is idempotent: a second run plans nothing.
import fs from 'node:fs';
import { writeFileAtomic } from '../util/atomic-write';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capSize } from '../util/bounded';
import { isKoragraphHook } from './adapters/claude';
import { gitPath } from '../util/win-exec';

const OLD = 'nh' + 'ands'; // the previous product name, spelled once (as in server/migrate.ts)

export const LEGACY_BEGIN = `<!-- ${OLD}:begin -->`;
export const LEGACY_END = `<!-- ${OLD}:end -->`;
const LEGACY_BLOCK_RE = new RegExp(`\\n{0,2}${LEGACY_BEGIN}[\\s\\S]*?${LEGACY_END}\\n?`, 'g');
// `"node" "${OLD_BIN:-/…/bin/<old>.js}" hook session-start` and a bare `<old> hook <event>`.
const LEGACY_HOOK_RE = new RegExp(`${OLD}(\\.js\\}?["']?)?\\s+hook\\s`);
// A path inside the previous product's checkout or install (…/<old>/…, ~/.<old>/…, …/<old>desktop/…).
const LEGACY_PATH_RE = new RegExp(`[\\\\/]\\.?${OLD}(-?desktop)?[\\\\/]|${OLD}\\.js\\b`);
const LEGACY_MDC = path.join('.cursor', 'rules', `${OLD}.mdc`);
const LEGACY_SKILL = `${OLD}-orchestrator`;

export type StepKind = 'block' | 'file' | 'hooks' | 'mcp' | 'git-hook' | 'skill' | 'codex' | 'install';
export interface TakeoverStep { scope: 'repo' | 'home'; kind: StepKind; file: string; detail: string; apply: () => void }
export interface TakeoverPlan { root: string; steps: TakeoverStep[]; agents: string[] /* kora adapters to install afterwards */ }

export function legacyHome(): string { return process.env.KORA_LEGACY_HOME || path.join(os.homedir(), `.${OLD}`); }
export function isLegacyHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && (LEGACY_HOOK_RE.test(cmd) || (isKoragraphHook(cmd) && LEGACY_PATH_RE.test(cmd)));
}
function isLegacyValue(v: unknown): boolean { try { return LEGACY_PATH_RE.test(JSON.stringify(v)); } catch { return false; } }
function read(file: string): string | null { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function readJson(file: string): any | null {
  const raw = read(file); if (raw == null) return null;
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return null; } // unparseable: not ours to touch
}
const writeJson = (file: string, obj: any) => writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
const onlyFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\s*/, '').trim() === '';

/** Text with every legacy managed block removed (null when there is none). */
export function stripLegacyBlocks(text: string): string | null {
  if (!text.includes(LEGACY_BEGIN)) return null;
  const out = text.replace(LEGACY_BLOCK_RE, '\n');
  return out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, out.trim() ? '\n' : '');
}

/** Settings object with every legacy hook entry removed, and how many went. Pure; exported for tests. */
export function stripLegacyHooks(settings: any): { settings: any; removed: number } {
  let removed = 0;
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return { settings, removed };
  for (const event of Object.keys(hooks)) {
    const list: any[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = list.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.some((h: any) => isLegacyHookCommand(h?.command))));
    removed += list.length - kept.length;
    if (kept.length) hooks[event] = kept; else if (list.length) delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return { settings, removed };
}

function blockSteps(root: string, scope: TakeoverStep['scope'], rel: string, steps: TakeoverStep[]): boolean {
  const file = path.join(root, rel);
  const text = read(file); if (text == null) return false;
  const next = stripLegacyBlocks(text); if (next == null) return false;
  if (onlyFrontmatter(next)) steps.push({ scope, kind: 'file', file, detail: 'held only the legacy managed block — removed', apply: () => fs.rmSync(file, { force: true }) });
  else steps.push({ scope, kind: 'block', file, detail: 'legacy managed block removed (your content kept)', apply: () => writeFileAtomic(file, next) });
  return true;
}

function settingsSteps(root: string, scope: TakeoverStep['scope'], rel: string, steps: TakeoverStep[]): boolean {
  const file = path.join(root, rel);
  const obj = readJson(file); if (!obj) return false;
  const { settings, removed } = stripLegacyHooks(JSON.parse(JSON.stringify(obj)));
  if (!removed) return false;
  const empty = rel.endsWith('settings.local.json') && Object.keys(settings).length === 0;
  steps.push({ scope, kind: 'hooks', file, detail: `${removed} legacy hook entr${removed === 1 ? 'y' : 'ies'} removed${empty ? ' (file held nothing else — removed)' : ''}`,
    apply: () => { if (empty) fs.rmSync(file, { force: true }); else writeJson(file, settings); } });
  return true;
}

function mcpSteps(root: string, scope: TakeoverStep['scope'], rel: string, keys: string[], steps: TakeoverStep[]): boolean {
  const file = path.join(root, rel);
  const obj = readJson(file); if (!obj) return false;
  const parent = keys.reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  if (!parent || typeof parent !== 'object' || !(OLD in parent) || !isLegacyValue(parent[OLD])) return false;
  steps.push({ scope, kind: 'mcp', file, detail: `${[...keys, OLD].join('.')} (legacy MCP server) removed`, apply: () => {
    const cur = readJson(file); const p = keys.reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), cur);
    if (p && typeof p === 'object') { delete p[OLD]; writeJson(file, cur); }
  } });
  return true;
}

// Memoized: every sync git spawn blocks the daemon's event loop, and under swarm load one call took 100–500 ms while
// the same few repos were asked the same question from several paths (CPU profile, 10-leader e2e: 5–17 s stalls).
const hooksDirMemo = new Map<string, { at: number; v: string | null }>();
/** A linked worktree shares its main checkout's hooks dir: record it for a worktree the caller just created. */
export function primeHooksDir(worktreePath: string, mainRoot: string): void {
  const main = gitHooksDir(mainRoot);
  if (main) hooksDirMemo.set(worktreePath, { at: Date.now(), v: main });
}
function gitHooksDir(root: string): string | null {
  const hit = hooksDirMemo.get(root);
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const v = gitHooksDirUncached(root);
  capSize(hooksDirMemo, 2000); hooksDirMemo.set(root, { at: Date.now(), v });
  return v;
}
function gitHooksDirUncached(root: string): string | null {
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    const out = r.stdout.trim(); return path.isAbsolute(out) ? out : path.join(root, out);
  } catch { return null; }
}
const GIT_BLOCK_START = '# >>> koragraph auto-reindex >>>';
const GIT_BLOCK_END = '# <<< koragraph auto-reindex <<<';
// The re-index git hooks the previous product installed carry the same koragraph marker as kora's, pointed at its own
// checkout. Replacing the block in place with kora's (same marker) is the takeover; a developer's hook around it stays.
function gitHookSteps(root: string, scope: TakeoverStep['scope'], steps: TakeoverStep[]): boolean {
  const dir = gitHooksDir(root); if (!dir || !fs.existsSync(dir)) return false;
  let found = false;
  for (const hook of ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite']) {
    const file = path.join(dir, hook); const body = read(file); if (!body) continue;
    const s = body.indexOf(GIT_BLOCK_START); const e = s < 0 ? -1 : body.indexOf(GIT_BLOCK_END, s);
    // Judge the CLI the block runs (its 2nd quoted word), never the repo path: a checkout may itself live under a
    // directory named after the old product, and kora's own block there must not look legacy.
    const cli = /\(\s*'[^']*'\s+'([^']*)'/.exec(body.slice(s, e))?.[1] || '';
    if (s < 0 || e < 0 || !LEGACY_PATH_RE.test(cli)) continue;
    const project = /--project '([^']*)'/.exec(body.slice(s, e))?.[1] || 'default';
    found = true;
    steps.push({ scope, kind: 'git-hook', file, detail: 'legacy re-index block → kora\'s (same marker, refreshed in place)', apply: () => {
      const { KORA_BIN, NODE_BIN, kg } = require('../graph/embedded');
      kg('src/services/git-hooks.js').installHook(dir, hook, { nodeBin: NODE_BIN, cliEntry: KORA_BIN, repoPath: root, project });
    } });
  }
  return found;
}

/** Everything the previous product wrote into one checkout (or the home dir, treated as a checkout). */
export function planRepo(rootIn: string, scope: TakeoverStep['scope'] = 'repo'): TakeoverPlan {
  const root = path.resolve(rootIn);
  const steps: TakeoverStep[] = []; const agents = new Set<string>();
  const hit = (b: boolean, agent: string) => { if (b) agents.add(agent); };
  hit(blockSteps(root, scope, 'CLAUDE.md', steps), 'claude');
  hit(settingsSteps(root, scope, path.join('.claude', 'settings.local.json'), steps), 'claude');
  hit(settingsSteps(root, scope, path.join('.claude', 'settings.json'), steps), 'claude');
  hit(mcpSteps(root, scope, '.mcp.json', ['mcpServers'], steps), 'claude');
  hit(blockSteps(root, scope, 'AGENTS.md', steps), 'unknown');
  hit(blockSteps(root, scope, 'GEMINI.md', steps), 'gemini');
  hit(mcpSteps(root, scope, path.join('.gemini', 'settings.json'), ['mcpServers'], steps), 'gemini');
  hit(mcpSteps(root, scope, 'opencode.json', ['mcp'], steps), 'opencode');
  hit(blockSteps(root, scope, LEGACY_MDC, steps), 'cursor');
  hit(mcpSteps(root, scope, path.join('.cursor', 'mcp.json'), ['mcpServers'], steps), 'cursor');
  gitHookSteps(root, scope, steps);
  return { root, steps, agents: [...agents] };
}

// ---- home: the global pieces ----
function codexConfigPath(): string { return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'); }
/**
 * Remove whole TOML sections by header, text-only (comments and layout elsewhere survive). A section runs from its
 * header line to the line before the next header. Exported for tests.
 */
export function removeTomlSections(text: string, drop: (header: string) => boolean): { text: string; removed: string[] } {
  const lines = text.split('\n'); const out: string[] = []; const removed: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const m = /^\s*\[(?!\[)(.+)\]\s*(#.*)?$/.exec(line); // a [table] header ([[array]] headers are never ours)
    if (m) { skipping = drop(m[1].trim()); if (skipping) { removed.push(m[1].trim()); continue; } }
    if (!skipping) out.push(line);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}
function codexSteps(steps: TakeoverStep[]): boolean {
  const file = codexConfigPath(); const text = read(file); if (!text) return false;
  let parsed: any; try { parsed = require('smol-toml').parse(text); } catch { return false; } // unparseable: leave it
  const server = parsed?.mcp_servers?.[OLD];
  const legacyWt = path.join(legacyHome(), 'worktrees') + path.sep;
  const trust = Object.keys(parsed?.projects || {}).filter((p) => p.startsWith(legacyWt));
  const dropServer = !!server && isLegacyValue(server);
  if (!dropServer && !trust.length) return false;
  const serverRe = new RegExp(`^mcp_servers\\.${OLD}(\\..+)?$`);
  const drop = (h: string) => (dropServer && serverRe.test(h)) || (h.startsWith('projects.') && trust.includes(unquoteKey(h.slice('projects.'.length))));
  const { text: next, removed } = removeTomlSections(text, drop);
  if (!removed.length) return false;
  try { require('smol-toml').parse(next); } catch { return false; } // never write a config codex cannot read
  steps.push({ scope: 'home', kind: 'codex', file, detail: `${dropServer ? `[mcp_servers.${OLD}] removed` : ''}${dropServer && trust.length ? '; ' : ''}${trust.length ? `${trust.length} trust entr${trust.length === 1 ? 'y' : 'ies'} for legacy worktrees removed` : ''}`,
    apply: () => writeFileAtomic(file, next) });
  return dropServer;
}
function unquoteKey(k: string): string { try { return k.startsWith('"') ? JSON.parse(k) : k; } catch { return k; } }

function skillSteps(steps: TakeoverStep[]): boolean {
  const dir = path.join(os.homedir(), '.claude', 'skills', LEGACY_SKILL);
  const doc = read(path.join(dir, 'SKILL.md'));
  if (!doc || !new RegExp(`^name:\\s*${LEGACY_SKILL}\\s*$`, 'm').test(doc)) return false;
  const others = (() => { try { return fs.readdirSync(dir).filter((f) => f !== 'SKILL.md'); } catch { return []; } })();
  steps.push({ scope: 'home', kind: 'skill', file: others.length ? path.join(dir, 'SKILL.md') : dir, detail: `legacy orchestrator skill removed${others.length ? ' (other files in the folder kept)' : ''}`,
    apply: () => { if (others.length) fs.rmSync(path.join(dir, 'SKILL.md'), { force: true }); else fs.rmSync(dir, { recursive: true, force: true }); } });
  return true;
}

/**
 * The home dir: its CLAUDE.md/AGENTS.md/.claude/.cursor treated like a checkout, plus the global pieces — the Claude
 * orchestrator skill and the Codex MCP server / worktree trust entries. Kora equivalents for the GLOBAL pieces are
 * returned as `agents` ('skill', 'codex'); the home-level instruction blocks are NOT replaced with kora's, because
 * ~/CLAUDE.md is loaded into every session on the machine and would claim a code graph in unindexed directories.
 */
export function planHome(): TakeoverPlan {
  const home = os.homedir();
  const plan = planRepo(home, 'home');
  const agents: string[] = [];
  if (skillSteps(plan.steps)) agents.push('skill');
  if (codexSteps(plan.steps)) agents.push('codex');
  return { root: home, steps: plan.steps, agents };
}

export function applyPlan(plan: TakeoverPlan): { applied: TakeoverStep[]; failed: Array<{ step: TakeoverStep; error: string }> } {
  const applied: TakeoverStep[] = []; const failed: Array<{ step: TakeoverStep; error: string }> = [];
  for (const s of plan.steps) { try { s.apply(); applied.push(s); } catch (e: any) { failed.push({ step: s, error: String(e?.message || e) }); } }
  return { applied, failed };
}

// ---- discovery: every checkout the previous product ever touched ----
const TMP_RE = /^(\/private)?\/(tmp|var\/folders)\//;
function gitTop(dir: string): string | null {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout.trim() ? gitPath(r.stdout.trim()) : null;
  } catch { return null; }
}
/**
 * Candidate roots from: the previous product's saved workspaces (~/.<old>/state*.json), the graph store's repository
 * list, and the directories Claude Code and Codex have opened (~/.claude.json projects, codex config projects).
 * Excluded: the previous product's own home and checkouts (history, not ours to edit), temp dirs, the home dir
 * itself (planHome), and anything that no longer exists.
 */
export function knownRoots(): { roots: string[]; sources: Record<string, number> } {
  const home = os.homedir();
  const found = new Map<string, string>(); const sources: Record<string, number> = {};
  const add = (p: unknown, src: string) => { if (typeof p === 'string' && p) { if (!found.has(p)) found.set(p, src); sources[src] = (sources[src] || 0) + 1; } };
  try {
    for (const f of fs.readdirSync(legacyHome()).filter((n) => /^state.*\.json$/.test(n))) {
      const s = readJson(path.join(legacyHome(), f));
      for (const w of s?.workspaces || []) { add(w?.cwd, 'legacy-state'); for (const p of w?.panes || []) add(p?.cwd, 'legacy-state'); }
    }
  } catch { /* none */ }
  try {
    const { graphDbPath } = require('../graph/embedded');
    const db = graphDbPath();
    if (fs.existsSync(db)) {
      const Database = require('better-sqlite3'); const h = new Database(db, { readonly: true, fileMustExist: true });
      try { for (const r of h.prepare('SELECT full_path FROM repositories').all() as any[]) add(r.full_path, 'graph-store'); } finally { h.close(); }
    }
  } catch { /* no store */ }
  try { for (const p of Object.keys(readJson(path.join(home, '.claude.json'))?.projects || {})) add(p, 'claude-projects'); } catch { /* none */ }
  try { for (const p of Object.keys(require('smol-toml').parse(read(codexConfigPath()) || '')?.projects || {})) add(p, 'codex-projects'); } catch { /* none */ }
  const roots = new Set<string>();
  const legacy = legacyHome() + path.sep;
  for (const p of found.keys()) {
    const abs = path.resolve(p);
    if (abs === home || abs.startsWith(legacy) || TMP_RE.test(abs) || !fs.existsSync(abs)) continue;
    let st: fs.Stats; try { st = fs.statSync(abs); } catch { continue; } if (!st.isDirectory()) continue;
    const root = gitTop(abs) || abs;
    if (root === home || root.startsWith(legacy) || new RegExp(`^${OLD}`, 'i').test(path.basename(root))) continue;
    roots.add(root);
  }
  return { roots: [...roots].sort(), sources };
}

// ---- the automatic path (enforcer install/prepare) ----
const done = new Map<string, number>();
let homeDone = false;
/**
 * Remove the previous product's entries from `root` (at most once a minute per root) and, once per process, from the
 * home dir. Never throws; returns what it changed so the caller can note it. The caller installs kora's own entries.
 */
export function takeoverOnce(root: string, log?: (s: string) => void): string[] {
  const notes: string[] = [];
  try {
    if (!homeDone && process.env.KORA_TAKEOVER_HOME !== '0') { // KORA_TAKEOVER_HOME=0: leave ~ to the user
      homeDone = true;
      const h = planHome(); const r = applyPlan(h);
      for (const s of r.applied) notes.push(`takeover: ${s.file} — ${s.detail}`);
      if (h.agents.includes('skill')) { try { installKoraSkill(); } catch { /* advisory */ } }
      if (h.agents.includes('codex')) { try { require('./mcpconfig').upsertCodexMcp(); } catch { /* advisory */ } }
    }
    const key = path.resolve(root); const last = done.get(key);
    if (!last || Date.now() - last > 60_000) {
      capSize(done, 2000); done.set(key, Date.now());
      if (key !== os.homedir()) for (const s of applyPlan(planRepo(key)).applied) notes.push(`takeover: ${s.file} — ${s.detail}`);
    }
  } catch (e: any) { notes.push(`takeover skipped: ${e?.message || e}`); }
  if (log) for (const n of notes) log(n);
  return notes;
}
/** Test hook: forget what takeoverOnce already did in this process. */
export function resetTakeoverMemo(): void { done.clear(); homeDone = false; }

export function installKoraSkill(): string {
  const { claudeSkillDoc } = require('../server/orchestrator-skill');
  const file = path.join(os.homedir(), '.claude', 'skills', 'kora-orchestrator', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, claudeSkillDoc());
  // The Swarm-mode skill (koraswarm) ships beside the orchestrator skill; advisory — never fails the takeover.
  try { require('../server/swarm-skill').installSwarmSkill(); } catch { /* best effort */ }
  return file;
}

// Enforcer — dispatches to per-agent adapters, owns the shims and the brief cache, and runs the
// doctor. prepare() is on the pane-spawn path: it must be fast and must never throw.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { envPath, whichSync } from '../util/win-exec';
import type { AgentId } from '../protocol/types';
import { defaultSocketPath } from '../protocol/types';
import type { AdapterResult, DoctorCheck, EnforcePlan, Enforcer, PrepareInput } from './index';
import type { Adapter, AdapterCtx } from './adapters/types';
import { claudeAdapter, hooksInstalled, withGuardSettings } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import { geminiAdapter, opencodeAdapter, cursorAdapter, genericAdapter } from './adapters/others';
import { ensureShims, ensureShellRcs, shimsStatus, removeShims, pathWithShims, shimsDir, shimsOnPath } from './shims';
import { claudeMcpJsonPath, mcpEnabledFor } from './mcpconfig';
import { untrustedAgentEnv } from '../trust/gate';
import { KORA_BIN, NODE_BIN, gitTopLevel, graphDbPath, kg, socketReachable, withTimeout, unsafeIndexRoot } from '../graph/embedded';
import { createGraphService } from '../graph/index';
import { takeoverOnce } from './takeover';
import { capSize } from '../util/bounded';
import { recordTouchedRepo } from './repo-footprint';
import type { GraphService } from '../graph/index';

const BRIEF_TTL_MS = 30_000;
const PREPARE_BRIEF_WAIT_MS = 1200;

export const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  // Antigravity (`agy`) loads AGENTS.md (and GEMINI.md); one rulebook block in AGENTS.md, shared with Codex/OpenCode.
  antigravity: genericAdapter('antigravity', 'agy'),
  amp: genericAdapter('amp', 'amp'),
  droid: genericAdapter('droid', 'droid'),
  copilot: genericAdapter('copilot', 'copilot'),
  grok: genericAdapter('grok', 'grok'),
  kimi: genericAdapter('kimi', 'kimi'),
  qwen: genericAdapter('qwen', 'qwen'),
  aider: genericAdapter('aider', 'aider'),
  unknown: genericAdapter('unknown', null),
};

export function which(bin: string): string | null {
  if (process.platform === 'win32') return whichSync(bin);
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
  } catch { return null; }
}

let installedCache: { at: number; agents: AgentId[] } | null = null;
/** Agents whose binary is on PATH. Cached for the process life (60s). */
export function installedAgents(): AgentId[] {
  if (installedCache && Date.now() - installedCache.at < 60_000) return installedCache.agents;
  const agents = (Object.values(ADAPTERS).filter((a) => a.bin && which(a.bin)).map((a) => a.id)) as AgentId[];
  installedCache = { at: Date.now(), agents };
  return agents;
}

export function createEnforcer(opts: { graph?: GraphService } = {}): Enforcer {
  let graph: GraphService | null = opts.graph || null;
  const g = () => (graph ||= createGraphService());
  const briefCache = new Map<string, { at: number; text: string | null; pending: Promise<string | null> | null }>();

  function resolveRoot(cwd: string): string { return gitTopLevel(cwd) || path.resolve(cwd); }
  /**
   * Why no rulebook / hooks may be written for cwd, or null. The rulebook says "THIS REPOSITORY HAS A CODE GRAPH", and a
   * graph only exists for a git checkout that is a real project. Measured: a chat opened in ~ wrote ~/CLAUDE.md (which
   * Claude Code then loads for EVERY session under the home dir, in Kora or not) and ~/.claude/settings.local.json; a
   * chat in any plain folder (~/Documents/notes) got both files dropped into it.
   */
  function noEnforcementReason(cwd: string): string | null {
    const top = gitTopLevel(cwd);
    if (!top) return `${path.resolve(cwd)} is not a git checkout`;
    const unsafe = unsafeIndexRoot(top);
    return unsafe ? `${top} is a ${unsafe === 'home folder' ? 'home folder' : 'system folder'}` : null;
  }

  function refreshBrief(root: string, agent: AgentId): Promise<string | null> {
    const entry = briefCache.get(root) || { at: 0, text: null, pending: null };
    if (!entry.pending) {
      entry.pending = g().brief(root, agent).then((t) => { entry.text = t; entry.at = Date.now(); return t; }, () => entry.text).finally(() => { entry.pending = null; });
      capSize(briefCache, 500); briefCache.set(root, entry);
    }
    return entry.pending;
  }
  async function briefFor(root: string, agent: AgentId, waitMs: number): Promise<string | null> {
    const entry = briefCache.get(root);
    if (entry && entry.text && Date.now() - entry.at < BRIEF_TTL_MS) return entry.text;
    const p = refreshBrief(root, agent);
    if (waitMs <= 0) return entry?.text || null;
    return withTimeout(p, waitMs, entry?.text || null);
  }

  /** Does `root` have a code graph? undefined when the store did not answer in time (the full rulebook is then kept). */
  async function indexedState(root: string, waitMs: number): Promise<boolean | undefined> {
    try { return await withTimeout(g().status(root).then((st) => st.indexed === true), waitMs, undefined as boolean | undefined); }
    catch { return undefined; }
  }

  function ctxFor(root: string, brief: string | null, extra: Partial<AdapterCtx> = {}): AdapterCtx {
    return { root, brief, binPath: KORA_BIN, nodeBin: NODE_BIN, create: true, ...extra };
  }

  function adaptersFor(agent: AgentId | 'all'): Adapter[] {
    if (agent !== 'all') return [ADAPTERS[agent] || ADAPTERS.unknown];
    const ids = new Set<string>(installedAgents());
    ids.add('unknown'); // AGENTS.md for whatever else runs here
    return [...ids].map((id) => ADAPTERS[id]);
  }

  async function prepare(input: PrepareInput): Promise<EnforcePlan> {
    const notes: string[] = [];
    const env: Record<string, string> = {};
    try {
      env.KORA_NODE = NODE_BIN;
      // The shims dir goes first on the pane's PATH. Windows: the caller's env spells it `Path` (a copy of process.env),
      // and the plan is merged over it with Object.assign, so set that same key — a second `PATH` key would give the
      // child two PATHs. (Windows shims: kora/claude/codex .cmd launchers; no search shims yet, docs/windows/PORT.md.)
      const pathKey = (process.platform === 'win32' && Object.keys(input.env ?? {}).find((k) => k.toUpperCase() === 'PATH')) || 'PATH';
      env[pathKey] = pathWithShims(input.env ? envPath(input.env) : undefined);
      env.KORA_SHIMS_DIR = shimsDir();
      try { ensureShims(); ensureShellRcs(); notes.push(`PATH shims: ${shimsDir()}`); } catch (e: any) { notes.push(`shims skipped: ${e.message}`); }
      if (input.agent === 'shell') return { command: input.command, args: input.args, env, notes };
      // An untrusted folder (trust/store.ts): OpenCode / Koragent load no project config, plugins or tools from it —
      // set before any early return below, so a folder without a graph is restricted too.
      const restricted = untrustedAgentEnv(input.agent, input.cwd);
      if (Object.keys(restricted).length) { Object.assign(env, restricted); notes.push(`folder trust: ${Object.keys(restricted).join(', ')}`); }
      const why = noEnforcementReason(input.cwd);
      if (why) {
        notes.push(`no rulebook/hooks: ${why} (no code graph there)`);
        // No repo hooks here, so a Claude pane would run with no credential guard: pass it as flag settings.
        if (input.agent === 'claude') { const g = withGuardSettings(input.args, { binPath: KORA_BIN, nodeBin: NODE_BIN }); notes.push(g.note); return { command: input.command, args: g.args, env, notes }; }
        return { command: input.command, args: input.args, env, notes };
      }
      const root = resolveRoot(input.cwd);
      // The previous runtime's hooks/blocks in this repo (and, once, the home dir) would fire inside this session.
      if (!input.noRepoWrites) notes.push(...takeoverOnce(root));
      const adapter = ADAPTERS[input.agent] || ADAPTERS.unknown;
      const brief = await briefFor(root, input.agent, adapter.needsBrief ? PREPARE_BRIEF_WAIT_MS : 0);
      if (adapter.needsBrief && !brief) notes.push('brief not ready yet (cached for the next spawn)');
      if (!input.noRepoWrites) recordTouchedRepo(root);
      // Not indexed yet: the rulebook says so instead of promising a graph the agent's first `kora graph` call would not find.
      const indexed = await indexedState(root, PREPARE_BRIEF_WAIT_MS);
      const delta = adapter.prepare({ ...input, binPath: KORA_BIN }, ctxFor(root, brief, { ...(input.noRepoWrites ? { readOnly: true } : {}), ...(indexed === undefined ? {} : { indexed }) }));
      Object.assign(env, delta.env);
      notes.push(...delta.notes);
      return { command: input.command, args: delta.args, env, notes };
    } catch (e: any) {
      notes.push(`enforcement skipped: ${e?.message || e}`);
      return { command: input.command, args: input.args, env, notes };
    }
  }

  async function install(o: { agent: AgentId | 'all'; cwd: string; create?: boolean; replaceKoragraphHooks?: boolean }) {
    const root = resolveRoot(o.cwd);
    const results: AdapterResult[] = [];
    const why = noEnforcementReason(o.cwd);
    if (why) {
      results.push({ agent: o.agent === 'all' ? 'unknown' : o.agent, action: 'skipped', file: root, detail: `no rulebook/hooks: ${why} (no code graph there)` });
      try { results.push(...ensureShims(), ...ensureShellRcs()); } catch (e: any) { results.push({ agent: 'shims', action: 'skipped', file: shimsDir(), detail: e.message }); }
      return { results };
    }
    for (const n of takeoverOnce(root)) results.push({ agent: 'takeover', action: 'removed', file: n.replace(/^takeover: /, '').split(' — ')[0], detail: n.split(' — ')[1] });
    const brief = await briefFor(root, o.agent === 'all' ? 'unknown' : o.agent, 8000);
    recordTouchedRepo(root);
    const indexed = await indexedState(root, 3000);
    for (const a of adaptersFor(o.agent)) {
      try { results.push(...a.install(ctxFor(root, brief, { create: o.create !== false, replaceKoragraphHooks: o.replaceKoragraphHooks, ...(indexed === undefined ? {} : { indexed }) }))); }
      catch (e: any) { results.push({ agent: a.id, action: 'skipped', file: root, detail: e.message }); }
    }
    try { results.push(...ensureShims(), ...ensureShellRcs()); } catch (e: any) { results.push({ agent: 'shims', action: 'skipped', file: shimsDir(), detail: e.message }); }
    return { results };
  }

  async function uninstall(o: { agent: AgentId | 'all'; cwd: string; keepShims?: boolean }) {
    const root = resolveRoot(o.cwd);
    const results: AdapterResult[] = [];
    const adapters = o.agent === 'all' ? Object.values(ADAPTERS) : adaptersFor(o.agent);
    const seen = new Set<string>(); // AGENTS.md is shared by many adapters: report each file's 'absent' once
    for (const a of adapters) {
      try {
        for (const r of a.uninstall(ctxFor(root, null))) {
          const key = `${r.file}|${r.action}`;
          if (r.action === 'absent' && seen.has(key)) continue;
          seen.add(key);
          results.push(r);
        }
      } catch (e: any) { results.push({ agent: a.id, action: 'skipped', file: root, detail: e.message }); }
    }
    if (o.agent === 'all' && !o.keepShims) results.push(...removeShims());
    return { results };
  }

  async function status(o: { agent: AgentId | 'all'; cwd: string }) {
    const root = resolveRoot(o.cwd);
    const results: AdapterResult[] = [];
    for (const a of adaptersFor(o.agent)) {
      try { results.push(...a.status(ctxFor(root, null))); }
      catch (e: any) { results.push({ agent: a.id, action: 'skipped', file: root, detail: e.message }); }
    }
    results.push(...shimsStatus());
    return { results };
  }

  async function doctor(o: { cwd: string }): Promise<{ checks: DoctorCheck[] }> {
    const checks: DoctorCheck[] = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'node', ok: major >= 22, detail: `node ${process.version} at ${NODE_BIN}`, fix: major >= 22 ? undefined : 'install Node 22+ (https://nodejs.org) and reinstall kora' });
    for (const [mod, why] of [['node-pty', 'panes need a pty'], ['better-sqlite3', 'the graph store is SQLite']] as const) {
      try { require(mod); checks.push({ name: mod, ok: true, detail: `${mod} loads (${why})` }); }
      catch (e: any) { checks.push({ name: mod, ok: false, detail: `${mod} failed to load: ${String(e.message).split('\n')[0]}`, fix: `cd ${path.dirname(KORA_BIN)}/.. && npm rebuild ${mod}` }); }
    }
    const dbFile = graphDbPath();
    let repos = -1;
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try { repos = db.prepare('SELECT count(*) AS n FROM repositories').get().n; } finally { db.close(); }
      checks.push({ name: 'graph store', ok: repos > 0, detail: `${dbFile} — ${repos} repositor${repos === 1 ? 'y' : 'ies'}`, fix: repos > 0 ? undefined : 'kora ingest <repo-path>' });
      // Repos whose checkout is gone (folder renamed / moved / deleted) keep a full index that nothing can use: the store
      // only grows. Report them with what they cost; `kora graph prune` removes them.
      try {
        const { folderState } = kg('src/services/repo-name.js');
        const db2 = new Database(dbFile, { readonly: true, fileMustExist: true });
        try {
          const rows = db2.prepare(`SELECT r.name, r.full_path, (SELECT count(*) FROM repository_branches b JOIN nodes n ON n.repository_branch_id = b.id WHERE b.repository_id = r.id AND n.approval_status != 'ARCHIVED') AS nodes FROM repositories r WHERE r.is_archived = 0`).all() as { name: string; full_path: string; nodes: number }[];
          const ghosts = rows.filter((r) => folderState(r.full_path) === 'gone');
          if (ghosts.length) checks.push({ name: 'graph store hygiene', ok: false, detail: `${ghosts.length} indexed repositor${ghosts.length === 1 ? 'y has' : 'ies have'} no folder any more: ${ghosts.map((g) => `${g.name} (${g.nodes.toLocaleString()} nodes)`).join(', ')}`, fix: 'kora graph prune --dry-run   (then kora graph prune --now)' });
        } finally { db2.close(); }
      } catch { /* hygiene is advisory */ }
    } catch (e: any) {
      const damaged = fs.existsSync(dbFile) && /file is not a database|malformed/i.test(String(e?.message));
      checks.push({ name: 'graph store', ok: false, detail: `${dbFile}: ${fs.existsSync(dbFile) ? String(e.message).split('\n')[0] : 'missing'}`, fix: damaged ? 'kora ingest <repo-path>   (moves the damaged store aside to graph.db.damaged-<time> and rebuilds; index other repos again the same way)' : 'kora ingest <repo-path>' });
    }
    const root = gitTopLevel(o.cwd);
    if (!root) checks.push({ name: 'repo', ok: false, detail: `${o.cwd} is not inside a git checkout`, fix: 'cd into a git repository (or git init) and re-run' });
    else {
      const st = await g().status(root);
      try {
        const { ingestErrorFile } = require('../graph/service');
        const rec = JSON.parse(fs.readFileSync(ingestErrorFile(root), 'utf8'));
        checks.push({ name: 'last index', ok: false, detail: `the last index of ${root} failed ${rec.at ? `at ${rec.at}` : ''}: ${rec.error}`, fix: `kora ingest ${root}   (details: ~/.kora/ingest.log)` });
      } catch { /* no failure recorded */ }
      checks.push({ name: 'repo indexed', ok: st.indexed, detail: st.indexed ? `${root}: ${st.nodes} nodes, ${st.edges} edges, last ingest ${st.lastIngestAt ? new Date(st.lastIngestAt).toISOString() : 'unknown'}` : st.incomplete ? `${root}: the last full index did not finish (${st.nodes} of its nodes are in the store) — the graph is partial` : `${root} is not in the graph`, fix: st.indexed ? undefined : `kora ingest ${root}` });
      if (st.indexed && st.indexedFrom) checks.push({ name: 'index origin', ok: !st.staleForCheckout, detail: st.staleForCheckout ? `the index was built from ${st.indexedFrom} and a sample of its files is missing here — file:line answers may point at files this checkout does not have` : `matched by name to the index built from ${st.indexedFrom} (files sampled present)`, fix: st.staleForCheckout ? `kora ingest ${root}` : undefined });
      if (st.indexed) {
        try {
          const gs = kg('src/services/graph-staleness.js');
          const state = await withTimeout(gs.graphStaleness({ repoName: path.basename(root) }), 3000, null as any); // one repo, not the whole store
          const mine = state?.stale?.find((s: any) => s.repo.toLowerCase() === path.basename(root).toLowerCase());
          checks.push({ name: 'graph fresh', ok: !mine, detail: mine ? `indexed ${mine.indexed}, HEAD ${mine.head}` : 'graph matches HEAD (or cannot be checked)', fix: mine ? `kora ingest ${root}` : undefined });
        } catch { /* unknown is not stale */ }
      }
      const agents = installedAgents();
      checks.push({ name: 'agents on PATH', ok: agents.length > 0, detail: agents.length ? agents.join(', ') : 'none of claude/codex/gemini/opencode/cursor-agent found', fix: agents.length ? undefined : 'install at least one coding agent, then kora setup' });
      // Enforcement is written lazily: the rulebook + hooks land when the first session opens in a repo (chat or pane),
      // so a repo nobody has opened in Kora yet is not broken — it used to print four ✗ rows on a fresh install. Only a
      // HALF-installed agent (some of its files managed, some missing) is a problem.
      const inRepo = (f: string) => { const rel = path.relative(root, f); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
      const perAgent = agents.map((id) => ({ id, rows: ADAPTERS[id].status(ctxFor(root, null)) }));
      const anyInRepo = perAgent.some((a) => a.rows.some((r) => r.action === 'managed' && inRepo(r.file)));
      if (!anyInRepo) checks.push({ name: 'enforcement', ok: true, detail: `not set up in this repo yet — Kora writes the rulebook (CLAUDE.md / AGENTS.md) and the Claude hooks when the first session opens here (or run \`kora setup\`)` });
      else for (const { id, rows } of perAgent) {
        const repoRows = rows.filter((r) => inRepo(r.file));
        const bad = repoRows.filter((r) => r.action !== 'managed');
        const managed = repoRows.length - bad.length;
        if (managed === 0) { checks.push({ name: `enforce ${id}`, ok: true, detail: `not installed for ${id} (installed when a ${id} session first opens here)` }); continue; }
        checks.push({ name: `enforce ${id}`, ok: bad.length === 0, optional: id !== 'claude' || undefined, detail: bad.length ? `half-installed: ${bad.map((r) => `${path.relative(root, r.file) || r.file}: ${r.action}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}` : `${managed} file(s) managed`, fix: bad.length ? `kora enforce install --agent ${id} ${root}` : undefined });
      }
      const h = hooksInstalled(root);
      if (h.koragraphPresent) checks.push({ name: 'koragraph hooks', ok: false, detail: '.claude/settings.json also carries koragraph\'s own hook scripts — they double-fire with kora\'s', fix: `kora enforce install --agent claude --replace-koragraph-hooks ${root}` });
    }
    const sock = defaultSocketPath();
    if (socketReachable(sock)) {
      try {
        const { callOnce } = require('../protocol/client');
        const r = await withTimeout(callOnce('server.ping', {}, undefined, 2000), 2000, null as any);
        checks.push({ name: 'server', ok: !!r, detail: r ? `reachable at ${sock} (v${r.version}, pid ${r.pid})` : `${sock} exists but does not answer`, fix: r ? undefined : 'kora server stop && kora server start' });
      } catch (e: any) { checks.push({ name: 'server', ok: false, detail: `${sock}: ${e.message}`, fix: 'kora server start' }); }
    } else checks.push({ name: 'server', ok: true, detail: `not running (${sock}) — fine outside a kora session; CLI/hook calls run in-process` });
    const shimRows = shimsStatus();
    const shimsOk = shimRows.every((r) => r.action === 'managed');
    const inPane = process.env.KORA_ENV === '1';
    checks.push({ name: 'shims', ok: shimsOk && (!inPane || shimsOnPath()), detail: `${shimsDir()}: ${shimsOk ? (process.platform === 'win32' ? 'kora/claude/codex launchers present' : 'grep/rg/ag/find present') : shimRows.filter((r) => r.action !== 'managed').map((r) => `${path.basename(r.file)} ${r.action}`).join(', ')}${inPane ? (shimsOnPath() ? '; on PATH' : '; NOT on PATH in this pane') : '; injected into PATH per pane'}`, fix: shimsOk && (!inPane || shimsOnPath()) ? undefined : 'kora setup' });
    // MCP is OFF for claude by default (hooks + rulebook + CLI are the channels; the MCP schema is re-billed for
    // nothing). So a missing claude MCP config is the healthy default, not a problem — only flag it when MCP is
    // actually enabled for claude (KORA_MCP=1) but the file is absent.
    const claudeMcpOn = mcpEnabledFor('claude');
    const mcpExists = fs.existsSync(claudeMcpJsonPath());
    const mcpOk = claudeMcpOn ? mcpExists : true;
    checks.push({ name: 'mcp config', ok: mcpOk,
      detail: claudeMcpOn ? (mcpExists ? `${claudeMcpJsonPath()} (claude --mcp-config); per-agent files in the repo` : `${claudeMcpJsonPath()} missing`) : 'off for claude by default — graph runs via hooks + rulebook + CLI (KORA_MCP=1 to enable)',
      fix: mcpOk ? undefined : 'kora setup' });
    return { checks };
  }

  return { prepare, install, uninstall, status, doctor };
}

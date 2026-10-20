// GraphService — the embedded koragraph as an in-process library. Every caller (server, CLI, hooks,
// MCP bridge) goes through this; koragraph modules are loaded lazily through kg() so `--help` stays
// cheap and stdout is redirected before any koragraph module can log on it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import type { AgentId, GraphTool, PaneGraphInfo } from '../protocol/types';
import { GRAPH_TOOLS } from '../protocol/types';
import type { GraphService, GraphToolResult } from './index';
import { kg, KORA_BIN, NODE_BIN, gitTopLevel, graphDbPath, koraHome, repoIdentity, socketReachable, withTimeout, unsafeIndexRoot, UnsafeIndexRootError, isStoreCorruptError, storeDamage, quarantineStore } from './embedded';
import { howToSection } from './howto';
import { capSize } from '../util/bounded';
import { lockHolder } from './lock';

const STATUS_TTL_MS = 10_000;
const BRIEF_MAX = 2500;

export class GraphToolError extends Error {
  constructor(message: string, public code: string, public data?: unknown) { super(message); }
}

interface StatusCache { at: number; value: PaneGraphInfo }

export interface ProgressInput {
  done: number; total: number;          // files finished / files the ingest will visit (0 = the store has no row yet)
  elapsedMs: number; estMs: number;     // whole-ingest elapsed / time estimate — the fallback when total is 0
  filesPhaseDone: boolean;              // every file visited; the post-file passes (secondary_passes / post_tail) are running
  tailElapsedMs?: number; tailEstMs?: number; // since the files phase ended / estimate for the tail
}
/**
 * Indexing-bar percentage. File completion (real, polled from the store) maps to 3–85; the post-file passes have no
 * per-item signal, so they map to 85–95 by time against the tail estimate; the caller reports 100 on exit. With no
 * repository row yet (`total` 0) the old time estimate stands in, capped at 85 so it cannot overshoot what the real
 * signal says a moment later (the caller also never lets the bar move backwards).
 */
export function progressPct(p: ProgressInput): number {
  if (p.filesPhaseDone) { const est = Math.max(1, p.tailEstMs ?? 1); return 85 + Math.round(10 * Math.min(1, Math.max(0, p.tailElapsedMs ?? 0) / est)); }
  if (p.total > 0) return 3 + Math.round(82 * Math.min(1, Math.max(0, p.done) / p.total));
  return Math.min(85, Math.max(0, Math.round((p.elapsedMs / Math.max(1, p.estMs)) * 100)));
}

/** Managed-block / hook markers that mean "enforcement is installed here". Cheap fs reads only. */
export function enforcementPresent(root: string | null): boolean {
  if (!root) return false;
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', path.join('.cursor', 'rules', 'kora.mdc')];
  for (const f of candidates) {
    try { if (fs.readFileSync(path.join(root, f), 'utf8').includes('<!-- kora:begin -->')) return true; } catch { /* absent */ }
  }
  try { if (/kora(\.js\}?["']?)?\s+hook\s/.test(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'))) return true; } catch { /* absent */ }
  return false;
}

/** The engine names its own CLI (`koragraph ingest`, `koragraph status`, `koragraph mcp`) in answers and progress lines;
 *  a Kora user has only `kora`. Rewritten on the way out, never in the engine (keeps the vendored tree unpatched). */
export function koraWording(text: string): string {
  return text
    .replace(/Re-run: koragraph ingest(?!\s*\S)/g, 'Re-run: kora ingest .')
    .replace(/, or `koragraph mcp` to serve it/g, '')
    .replace(/`koragraph status`/g, '`kora graph status`')
    .replace(/`koragraph hooks status`/g, '`kora doctor`')
    .replace(/\bkoragraph ingest\b/g, 'kora ingest');
}

function fireReportGraphUse(tool: string, ms: number): void {
  const paneId = process.env.KORA_PANE_ID;
  if (!paneId || !socketReachable()) return;
  try {
    const { KoraClient } = require('../protocol/client');
    const c = new KoraClient();
    // Bounded: a daemon that accepts the connection but never answers (a stalled event loop) must not keep a one-shot hook process
    // alive past its tool call (Claude waits for the process to exit, up to the hook's timeout).
    const t = setTimeout(() => c.close(), 1500); t.unref?.();
    c.connect(500).then(() => c.call('pane.reportGraphUse', { paneId, tool, ms }).catch(() => {}).finally(() => { clearTimeout(t); c.close(); }), () => { clearTimeout(t); });
  } catch { /* best effort */ }
}

/**
 * What `kora ingest <target>` actually indexes. The graph is keyed by the MAIN checkout and shared by every linked
 * worktree (paths are identical across them), so an ingest run from inside an agent's worktree must index the main
 * checkout — measured: an agent told "INDEX MISMATCH, run kora ingest ." inside its worktree created a throwaway
 * store row at the worktree path, which dies with the worktree and re-triggers the warning for the next one.
 */
export function ingestRoot(target: string): { root: string; fromWorktree: string | null } {
  // The REAL path: every reader keys the checkout by git's toplevel, which is symlink-resolved. Indexing a symlinked
  // spelling (~/code → ~/Projects, /tmp → /private/tmp) created a second, full index under the link's name that no
  // query or chip ever found (measured: `kora ingest <link>` → a duplicate repository row).
  let abs = path.resolve(target); try { abs = fs.realpathSync(abs); } catch { /* not there (yet): keep */ }
  try {
    const { isLinkedWorktree, mainRoot } = require('../server/worktree');
    const top = gitTopLevel(abs);
    if (top && isLinkedWorktree(top)) { const main = mainRoot(top); if (main && main !== top) return { root: main, fromWorktree: top }; }
  } catch { /* keep */ }
  return { root: abs, fromWorktree: null };
}

/** HEAD of a checkout (full sha), null outside git. ~5 ms. */
const headMemo = new Map<string, { at: number; v: string | null }>();
/** HEAD of root, memoized for 2 s (a burst of briefs/status asks the same repo; one sync spawn each blocked the loop). */
/** Source files whose edits the graph tracks; a changed README or lockfile never makes the index stale. */
const INDEXED_SRC_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|cpp|cc|cxx|c|h|hpp|m|mm|scala|dart|lua|ex|exs|vue|svelte|sh)$/i;
/**
 * How many SOURCE files in the working tree carry uncommitted changes newer than `coveredAt` (epoch ms) — the part of
 * freshness a HEAD comparison cannot see (an agent edits, then asks the graph). Async `git status` (never a sync git on
 * the daemon's event loop), a hard timeout, a stat per candidate (capped). 0 when unknown.
 */
export function dirtySourceFilesSince(root: string, coveredAt: number): Promise<number> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 << 20 }, (err, out) => {
        if (err || !out) { resolve(0); return; }
        const parts = String(out).split('\0'); const files: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const e = parts[i]!; if (e.length < 4) continue;
          const x = e[0], y = e[1], f = e.slice(3);
          if (x === 'R' || x === 'C') i++; // the next entry is the rename's origin
          if (x === 'D' || y === 'D') continue; // a deleted file has no mtime; catch-up on the next commit/ingest handles it
          if (INDEXED_SRC_RE.test(f)) files.push(f);
        }
        let n = 0;
        for (const f of files.slice(0, 400)) { try { if (fs.statSync(path.join(root, f)).mtimeMs > coveredAt + 500) n++; } catch { /* gone */ } }
        resolve(n);
      });
    } catch { resolve(0); }
  });
}

export function headSha(root: string): string | null {
  const hit = headMemo.get(root);
  if (hit && Date.now() - hit.at < 2_000) return hit.v;
  const v = headShaUncached(root);
  headMemo.set(root, { at: Date.now(), v });
  return v;
}
function headShaUncached(root: string): string | null {
  try { const r = require('node:child_process').spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }); return r.status === 0 ? String(r.stdout).trim() || null : null; } catch { return null; }
}
/**
 * koragraph's git hooks (post-commit / checkout / merge / rewrite → background re-ingest), pointed at kora's bin.
 * Installed after every index the runtime runs, so a graph kora built stays fresh across commits without a
 * `kora setup` — before, only setup installed them and every auto-indexed repo drifted stale on its first commit.
 */
export function ensureGitHooks(root: string, project = 'default'): { ok: boolean; detail: string } {
  try {
    const gh = kg('src/services/git-hooks.js');
    // A non-default home/store (Kora Dev, a test daemon) travels with the hook: git runs it in the committer's env.
    const env: Record<string, string> = {};
    for (const k of ['KORA_HOME', 'KORAGRAPH_HOME', 'KORAGRAPH_DB', 'KORAGRAPH_PRACTICE_DB']) if (process.env[k]) env[k] = process.env[k] as string;
    const { results } = gh.installHooks(root, { nodeBin: NODE_BIN, cliEntry: KORA_BIN, repoPath: root, project, env });
    return { ok: true, detail: results.map((h: any) => `${h.hook}:${h.action}`).join(', ') };
  } catch (e: any) { return { ok: false, detail: String(e?.message || e) }; }
}

/**
 * The last failed index of a checkout, for the graph chip and doctor. The chip's Index / Re-index runs `kora ingest` as
 * a DETACHED child: before this, a run that failed before it wrote its job row (refused path, store damaged, lock
 * timeout, a crash at start-up) left the chip on "Not indexed · Index?" with the reason only in ingest.log. Written on
 * failure, removed on success. Keyed like the ui-server reads it: sha1 of the resolved root.
 */
export function ingestErrorFile(root: string): string {
  return path.join(koraHome(), 'ingest-errors', `${crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`);
}
export function recordIngestOutcome(root: string, error: string | null): void {
  const files = new Set([ingestErrorFile(root)]); try { files.add(ingestErrorFile(fs.realpathSync(root))); } catch { /* gone */ }
  for (const f of files) {
    try {
      if (error === null) fs.rmSync(f, { force: true });
      else { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ root, at: new Date().toISOString(), error: error.slice(0, 600) })); }
    } catch { /* best effort */ }
  }
}

/**
 * A detached index (the chip's Index / Re-index, a prompt's catch-up) that dies without recording why: killed, crashed,
 * out of memory, a V8 abort. Before, the chip went straight back to "Not indexed · Index?" as if the click did nothing
 * (found 2026-10-04: a first index killed half a second in left no job row and no error). The indexer records its own
 * failures; this records the ones it cannot, and never overwrites a reason it wrote during this run.
 */
export function noteDetachedIngestExit(root: string, startedAt: number, code: number | null, signal: NodeJS.Signals | null): void {
  if (code === 0) return;
  try {
    const own = fs.statSync(ingestErrorFile(root), { throwIfNoEntry: false });
    if (own && own.mtimeMs >= startedAt - 1000) return;
  } catch { /* none */ }
  recordIngestOutcome(root, signal ? `the indexer was stopped (${signal}) before it finished` : `the indexer exited with code ${code} — details in ~/.kora/ingest.log`);
}

export function createGraphService(): GraphService {
  const statusCache = new Map<string, StatusCache>();
  const rootCache = new Map<string, { at: number; root: string | null }>();
  const storeNames = new Map<string, string>(); // repo root → repositories.name as the store spells it

  /** A caller that already knows cwd's graph root (a worktree it just created) records it: no sync git to derive it. */
  function primeRepoRoot(cwd: string, root: string): void { capSize(rootCache, 4000); rootCache.set(cwd, { at: Date.now(), root }); }
  function repoRoot(cwd: string): string | null {
    const hit = rootCache.get(cwd);
    if (hit && Date.now() - hit.at < (hit.root ? 60_000 : STATUS_TTL_MS)) return hit.root; // a dir's repo root does not move
    let root = gitTopLevel(cwd);
    // A linked worktree (an agent's own checkout) shares its main checkout's index: the graph is keyed by the
    // main root, and repo-relative paths are identical across worktrees.
    if (root) { try { const { isLinkedWorktree, mainRoot } = require('../server/worktree'); if (isLinkedWorktree(root)) root = mainRoot(root) || root; } catch { /* keep */ } }
    // A plain (non-git) folder someone indexed on purpose (`kora ingest <dir>`, the chip's "Index anyway"): its root is
    // the indexed folder that contains cwd. Without this its index was invisible (status "not indexed", no injection) and
    // every query from inside it ran unscoped across the whole store.
    else root = indexedFolderFor(cwd);
    capSize(rootCache, 4000); rootCache.set(cwd, { at: Date.now(), root });
    return root;
  }

  function indexedFolderFor(cwd: string): string | null {
    try {
      const dbFile = graphDbPath(); if (!fs.existsSync(dbFile)) return null;
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        db.pragma('busy_timeout = 300');
        const abs = path.resolve(cwd); let real = abs; try { real = fs.realpathSync(abs); } catch { /* keep */ }
        const row = db.prepare(`SELECT full_path FROM repositories WHERE is_archived = 0 AND full_path IS NOT NULL AND full_path != ''
            AND (full_path IN (?, ?) OR substr(?, 1, length(full_path) + 1) = full_path || ? OR substr(?, 1, length(full_path) + 1) = full_path || ?)
          ORDER BY length(full_path) DESC LIMIT 1`).get(abs, real, abs, path.sep, real, path.sep) as { full_path: string } | undefined;
        // Never the home dir / fs root (a stray index of ~ must not swallow every folder under it).
        if (!row || unsafeIndexRoot(row.full_path)) return null;
        // Nor a workspace folder that holds checkouts (~/Projects/koraplex with kora/, kora-dev/ …): its index covers only
        // the loose files around them, so from there every real symbol read "NO DECLARATION NAMED X EXISTS" (found
        // 2026-10-15: 84 of 104 sessions opened in such a folder never used the graph). Refuse and name the checkouts.
        return holdsCheckouts(db, row.full_path) ? null : row.full_path;
      } finally { db.close(); }
    } catch { return null; }
  }

  /** A non-git folder that contains an indexed repository, or a git checkout one level down. */
  function holdsCheckouts(db: any, folder: string): boolean {
    try {
      const inside = db.prepare(`SELECT 1 FROM repositories WHERE is_archived = 0 AND full_path != ? AND substr(full_path, 1, length(?) + 1) = ? || ? LIMIT 1`).get(folder, folder, folder, path.sep);
      if (inside) return true;
      return fs.readdirSync(folder, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(folder, d.name, '.git')));
    } catch { return false; }
  }

  /** Indexed git checkouts under a folder, for a refusal that says where to go instead. */
  function indexedCheckoutsUnder(cwd: string, limit = 6): string[] {
    try {
      const dbFile = graphDbPath(); if (!fs.existsSync(dbFile)) return [];
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const abs = path.resolve(cwd);
        const rows = db.prepare(`SELECT name, full_path FROM repositories WHERE is_archived = 0 AND substr(full_path, 1, length(?) + 1) = ? || ?
            ORDER BY length(full_path), full_path`).all(abs, abs, path.sep) as { name: string; full_path: string }[];
        return rows.filter((r) => fs.existsSync(path.join(r.full_path, '.git'))).slice(0, limit).map((r) => `${path.relative(abs, r.full_path)} (--repo ${r.name})`);
      } finally { db.close(); }
    } catch { return []; }
  }

  async function scopeNameFor(cwd: string): Promise<string | null> {
    try {
      const root = repoRoot(cwd);
      if (!root) return null;
      if (!storeNames.has(root)) await status(cwd);
      return storeNames.get(root) || null;
    } catch { return null; }
  }

  // koragraph's query-time freshness is bounded here, from outside. A file-scoped call (neighbours/recall with
  // `file`, blast_radius files_changed) catches up SYNCHRONOUSLY, and that catch-up waits up to 10 min for the
  // repo's ingest lock: measured 65 s for one `neighbours --file` while another process (a runaway ingest from
  // the previous runtime, a git hook) held it. So: when another live process holds the lock, answer from the index
  // as it stands; otherwise wait at most FRESH_WAIT_MS and let the catch-up finish behind the answer.
  function boundedFreshness(f: any): any {
    const waitMs = Number(process.env.KORA_FRESHNESS_WAIT_MS) > 0 ? Number(process.env.KORA_FRESHNESS_WAIT_MS) : 3000;
    const heldElsewhere = (cwd: string): boolean => {
      try {
        const lk = kg('src/services/ingest-lock.js');
        for (const r of new Set([gitTopLevel(cwd), repoRoot(cwd)].filter(Boolean) as string[])) {
          const h = lk.holder(r); const pid = Number(h?.pid);
          if (!h || !pid || pid === process.pid || Date.now() - Number(h.at || 0) > 2 * 60 * 60 * 1000) continue;
          try { process.kill(pid, 0); return true; } catch (e: any) { if (e?.code === 'EPERM') return true; }
        }
      } catch { /* no lock module: fall through to the time bound */ }
      return false;
    };
    const guard = (fn: (o: any) => Promise<unknown>) => async (o: any) => {
      if (typeof fn !== 'function') return;
      if (heldElsewhere(o?.cwd || process.cwd())) return;
      await withTimeout(Promise.resolve().then(() => fn.call(f, o)), waitMs, undefined);
    };
    return { ...f, ensureRepoFresh: guard(f.ensureRepoFresh), ensureFilesFresh: guard(f.ensureFilesFresh), ensureFileFresh: guard(f.ensureFileFresh) };
  }
  async function runTool(name: string, args: Record<string, unknown>, cwd: string, fresh: boolean): Promise<GraphToolResult> {
    if (!(GRAPH_TOOLS as readonly string[]).includes(name)) throw new GraphToolError(`Unknown graph tool "${name}". Available: ${GRAPH_TOOLS.join(', ')}`, 'unknown_tool');
    const protocol = kg('src/mcp/protocol.js');
    // Identity from the MAIN checkout: a linked worktree's own basename (`codex-quiet-fox`) matches no repository
    // row, and the store then fell through to a same-named file in a stale row of another repo — the merge gate
    // and every explore inside a worktree were answered from the wrong index. `cwd` stays the worktree so file
    // reads (freshness, overlay) see the branch's actual contents.
    const { repoId } = repoIdentity(repoRoot(cwd) || cwd);
    const deps: Record<string, unknown> = { cwd, repoId };
    if (fresh) { try { deps.freshness = boundedFreshness(kg('src/services/live-freshness.js')); } catch { /* no-op freshness */ } }
    // Scope to the repository containing cwd by default — a pane lives in one repo, and the store
    // holds many. `project_id: null` (CLI: --repo all) asks for the whole store explicitly.
    const callArgs: Record<string, unknown> = { ...(args || {}) };
    if (callArgs.project_id === null) delete callArgs.project_id;
    // file_symbols is scoped too (koragraph accepts project_id on it now): unscoped, a path was looked up
    // store-wide and a file ADDED on this branch came back as another repository's same-named file.
    else if (callArgs.project_id === undefined && name !== 'overview') {
      const storeName = await scopeNameFor(cwd);
      if (storeName) callArgs.project_id = storeName;
      // A git repo that is NOT in the store (never indexed, an index that died part-way, or another checkout's row)
      // used to run store-wide: an agent in an unindexed Go repo was answered with Python hits from a repo it had never
      // heard of. Say so instead. (`--repo all` / overview still ask the whole store on purpose.)
      else if (repoRoot(cwd) && (await status(cwd)).storeError) {
        throw new GraphToolError(`The code graph store (${graphDbPath()}) is damaged and cannot be read (${(await status(cwd)).storeError}). Re-index this repository (Re-index on the graph chip, or \`kora ingest ${repoRoot(cwd)}\`): the damaged file is moved aside and the graph rebuilt. Until then grep and Read are the right tools.`, 'store_damaged');
      }
      else if (!repoRoot(cwd)) {
        // Not inside any repository or indexed folder (~/Downloads, the chat surface): same rule, the store holds other
        // people's code as far as this cwd is concerned.
        const under = indexedCheckoutsUnder(cwd);
        if (under.length) throw new GraphToolError(`${path.resolve(cwd)} is a folder of checkouts, not one repository, so there is no single code graph to search here. Indexed checkouts in it: ${under.join(', ')}. cd into one (\`cd <dir> && kora graph …\`) or pass its --repo name.`, 'not_indexed');
        throw new GraphToolError(`${path.resolve(cwd)} is not inside a git repository or an indexed folder, so there is no code graph to search here. cd into an indexed repository, or pass --repo all to search every indexed repository on purpose.`, 'not_indexed');
      } else {
        const root = repoRoot(cwd) as string;
        const st = await status(cwd); const half = st.incomplete;
        if (st.firstIndexRunning) throw new GraphToolError(`The code graph of this repository (${path.basename(root)}) is being built right now (first index, ${st.nodes.toLocaleString()} declarations so far). Answering from a half-built graph would silently miss code, so until it finishes grep and Read are the right tools.`, 'indexing');
        throw new GraphToolError(half
          ? `The graph of this repository (${path.basename(root)}) is incomplete: an earlier full index was interrupted, so answering from it would silently miss code. Kora re-indexes it on the next message (or the user clicks Re-index on the graph chip); until then grep and Read are the right tools.`
          : `This repository (${path.basename(root)}) is not indexed in the code graph, so there is nothing to search yet. Only the user starts a first index (Index on the graph chip); do not index it yourself. Use grep and Read.`, 'not_indexed');
      }
    }
    const t0 = Date.now();
    const res = await protocol.callTool(name, callArgs, deps);
    const ms = Date.now() - t0;
    const text = koraWording((res.content || []).map((c: any) => c.text).filter(Boolean).join('\n'));
    if (res.isError) throw new GraphToolError(text || 'graph tool failed', res.structuredContent?.code || 'tool_error', res.structuredContent);
    return { text, data: res.structuredContent, ms };
  }

  // Short cache of a checkout's divergence-from-index (2 git calls) so a burst of graph calls in one turn does not
  // re-shell it each time. Keyed by cwd; invalidated by time only (a stale-by-2s overlay note is harmless).
  const divCache = new Map<string, { at: number; sha: string | null; div: { changed: string[]; truncated: boolean } }>();
  async function divergence(cwd: string): Promise<{ root: string | null; div: { changed: string[]; truncated: boolean } }> {
    const root = repoRoot(cwd);
    if (!root) return { root: null, div: { changed: [], truncated: false } };
    // Only a WORKTREE needs the overlay. In the main checkout on the indexed branch, koragraph's live-freshness
    // pass already re-extracts changed files at query time, so results there are current — a "may have moved" label
    // would be a false alarm. A worktree is on its own branch, which freshness cannot reach; that is the gap.
    let linked = false; try { linked = require('../server/worktree').isLinkedWorktree(cwd); } catch { /* not git */ }
    if (!linked) return { root, div: { changed: [], truncated: false } };
    const hit = divCache.get(cwd);
    let sha: string | null;
    if (hit && Date.now() - hit.at < 2000) sha = hit.sha; else { try { sha = (await status(cwd)).indexedSha ?? null; } catch { sha = null; } }
    if (hit && Date.now() - hit.at < 2000) return { root, div: hit.div };
    let div = { changed: [] as string[], truncated: false };
    try { const { changedSinceIndex } = require('./worktree-overlay'); div = changedSinceIndex(cwd, sha); } catch { /* no overlay */ }
    divCache.set(cwd, { at: Date.now(), sha, div });
    return { root, div };
  }
  async function callTool(name: GraphTool, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<GraphToolResult> {
    const cwd = opts?.cwd || process.cwd();
    let r: GraphToolResult;
    try { r = await runTool(name, args, cwd, opts?.fresh !== false); }
    catch (e) {
      // The highest-value honesty case: blast_radius/neighbours/explore for a symbol the graph has never seen
      // ERRORS ("no declaration named …"). If that symbol is declared in a file this branch changed, it is NEW on
      // the branch — answer that plainly (and point at grep) instead of a bare error the agent can't act on.
      if (e instanceof GraphToolError && /not found|no declaration|no such|unknown symbol|could not (?:find|resolve)|no match/i.test(e.message)) {
        try {
          const { div } = await divergence(cwd); const root = repoRoot(cwd);
          const { subjectSymbol, declaredInChanged } = require('./worktree-overlay');
          const sym = subjectSymbol(name, args);
          if (root && div.changed.length && sym) {
            const declFile = declaredInChanged(cwd, div.changed, sym);
            if (declFile) { fireReportGraphUse(name, 0); return { text: `${sym} is NEW on this branch — declared in ${declFile}, which the code graph has not indexed yet, so it has no callers/dependents recorded. grep for "${sym.replace(/^.*[.:#]/, '')}" to find call sites.`, data: { newOnBranch: true, symbol: sym, file: declFile } as any, ms: 0 }; }
          }
        } catch { /* fall through to the original error */ }
      }
      throw e;
    }
    fireReportGraphUse(name, r.ms);
    let out = args.detail === 'full' ? r : slim(name, r, repoRoot(cwd));
    // A miss on a symbol that only exists in an UNCOMMITTED edit of the main checkout: the query-time catch-up runs
    // detached, so the first query after the edit answers from the index as it stood ("NO DECLARATION NAMED
    // brandNewFn EXISTS" while it sat in the working tree). Say where it is instead of a confident negative.
    try {
      const { subjectSymbol, declaredInChanged } = require('./worktree-overlay');
      const sym: string | null = subjectSymbol(name, args);
      const bare = sym ? sym.replace(/^.*[.:#]/, '') : '';
      // no hit line declares the symbol itself (`METHOD sym:12`, `■ METHOD sym @ f:12`, `METHOD sym @ f:L12`)
      const exact = bare && new RegExp(`(?:^|[\\s,■])[A-Z_]+ ${bare.replace(/[$]/g, '\\$')}(?=[:\\s@])`, 'm').test(out.text);
      if (sym && bare && !exact) {
        const root = repoRoot(cwd);
        let linked = false; try { linked = require('../server/worktree').isLinkedWorktree(cwd); } catch { /* not git */ }
        if (sym && root && !linked) {
          // Async: with the worker pool off (inline fallback) a sync git status blocked the daemon's loop up to 2 s per miss.
          const stdout = await new Promise<string>((resolve) => {
            require('node:child_process').execFile('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 << 20 }, (_e: unknown, out: string) => resolve(String(out || '')));
          });
          const ents = stdout.split('\0'); const dirty: string[] = [];
          for (let i = 0; i < ents.length && dirty.length < 300; i++) { const e = ents[i]; if (e.length < 4) continue; if (e[0] !== 'D' && e[1] !== 'D') dirty.push(e.slice(3)); if (e[0] === 'R' || e[0] === 'C') i++; }
          let file = dirty.length ? declaredInChanged(root, dirty, sym) : null;
          let why = 'an uncommitted change';
          if (!file) {
            // Committed after the last index (HEAD moved: a pull, a branch switch, the agent's own commit): that catch-up
            // runs detached as well, and the first query said a confident "(nothing)" for a symbol sitting in HEAD.
            const s0: any = await status(cwd).catch(() => null);
            if (s0?.indexed && s0.stale && s0.indexedSha) {
              const { changedSinceIndex } = require('./worktree-overlay');
              const changed: string[] = changedSinceIndex(root, s0.indexedSha).changed;
              file = changed.length ? declaredInChanged(root, changed, sym) : null;
              if (file) why = `committed after the graph was last indexed (at ${String(s0.indexedSha).slice(0, 7)}), a change`;
            }
          }
          if (file) out = { ...out, text: out.text.replace(/\s*$/, '') + `\n(${sym} is declared in ${file}, ${why} the graph is still catching up with — Read ${file}, or ask again in a few seconds.)` };
        }
      }
    } catch { /* best effort */ }
    // Worktree/working-tree overlay: append honest labels when this checkout diverges from the index. Stores
    // nothing; a clean checkout at the indexed commit adds zero text. Never rewrites the result, only appends.
    try {
      const { root, div } = await divergence(cwd);
      if (root && div.changed.length) {
        const { overlayNotes, reresolveLines, subjectSymbol } = require('./worktree-overlay');
        const rr = reresolveLines(name, out.text, cwd, new Set(div.changed), subjectSymbol(name, args)); // THIS checkout's files
        if (rr.files.length) out = { ...out, text: rr.text };
        const note = overlayNotes({ name, args, text: out.text, root: cwd, div, reresolved: rr.files }); // read changed files from THIS checkout (a worktree), not main
        if (note) return { ...out, text: out.text.replace(/\s*$/, '') + '\n' + note };
      }
    } catch { /* overlay is best-effort */ }
    return out;
  }

  // Result slimming. Measured on a real A/B: one concise `explore` pasted 3,082 tokens of source for a symbol
  // the task only needed the LOCATION of, and that text is re-billed on every later turn. The graph's job is to
  // point; a Read with offset/limit is the cheap way to look. So: pasted source is capped per hit (the range is
  // kept, so the agent can Read exactly it), and self-referential file-level pseudo-callers (`x.js@x.js:1`) are
  // dropped. `detail:"full"` / --full bypasses all of it.
  const SOURCE_MAX_LINES = Number(process.env.KORA_SOURCE_LINES) > 0 ? Number(process.env.KORA_SOURCE_LINES) : 25;
  function slimText(text: string): string {
    const out: string[] = []; const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)--- source (\S+):(\d+)-(\d+) ---\s*$/.exec(lines[i]);
      if (!m) { out.push(lines[i].replace(/,?\s*[\w./-]+\.\w+@[\w./-]+\.\w+:1(?: \(call at [^)]*\))?(?=,|\s|$)/g, '')); continue; }
      const indent = m[1], file = m[2], a = Number(m[3]), b = Number(m[4]);
      // collect the block: until the next header-ish line (■/blank line followed by ■) — koragraph ends a source
      // block at the next symbol header or EOF; we take until a line starting with '■' or another '--- source'
      let j = i + 1; const body: string[] = [];
      while (j < lines.length && !/^\s*■/.test(lines[j]) && !/^\s*--- source /.test(lines[j])) { body.push(lines[j]); j++; }
      if (body.length > SOURCE_MAX_LINES) {
        out.push(lines[i]); out.push(...body.slice(0, SOURCE_MAX_LINES));
        out.push(`${indent}  … ${body.length - SOURCE_MAX_LINES} more lines — Read ${file} offset=${a + SOURCE_MAX_LINES} limit=${Math.max(1, b - a - SOURCE_MAX_LINES + 1)} if you need the rest`);
      } else { out.push(lines[i]); out.push(...body); }
      i = j - 1;
    }
    return out.join('\n');
  }
  function slimData(v: any): any {
    if (Array.isArray(v)) return v.map(slimData);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) {
        if ((k === 'source' || k === 'body' || k === 'snippet') && typeof val === 'string' && val.split('\n').length > SOURCE_MAX_LINES) {
          const ls = val.split('\n'); o[k] = ls.slice(0, SOURCE_MAX_LINES).join('\n') + `\n… ${ls.length - SOURCE_MAX_LINES} more lines (Read the file range)`;
        } else o[k] = slimData(val);
      }
      return o;
    }
    return v;
  }
  // Existence filter. A store row can be matched by NAME to a checkout that is not the one it was indexed from
  // (a copy, a worktree of an older revision, or — measured — a checkout with directories the index has and this
  // tree does not). A hit at a path that does not exist here is worse than no hit: the agent walks to a file it
  // cannot open. Drop those lines; if most hits vanish, say so in the header so the user re-indexes.
  const HIT_LINE = /^(\s*(?:■|d\d)\s+\S+\s+\S+\s+@\s+|\s*(?:METHOD|FUNCTION|CLASS|VARIABLE|CONST|TYPE|INTERFACE|FILE)\s+\S+\s+@\s+)(\S+?):L?\d+/;
  const FILE_FIRST_LINE = /^ {2}([^\s:][^\s]*\.[A-Za-z0-9]+): (?:[A-Z_]+ |DOC )/;
  function existsFilter(text: string, root: string | null): string {
    if (!root) return text;
    const out: string[] = []; let dropped = 0, kept = 0, skipping = false;
    for (const line of text.split('\n')) {
      // search_code / file_symbols lists FILE-FIRST: `  lib/x.js: METHOD foo:12, FILE lib/x.js:1`.
      const fm = FILE_FIRST_LINE.exec(line);
      if (fm && !fs.existsSync(path.join(root, fm[1]))) { dropped++; continue; }
      const m = HIT_LINE.exec(line);
      if (m) {
        const rel = m[2]; const ok = fs.existsSync(path.join(root, rel));
        if (!ok) { dropped++; skipping = /^\s*■/.test(line); continue; }
        kept++; skipping = false; out.push(line); continue;
      }
      if (skipping && /^\s+/.test(line)) continue; // body of a dropped ■ hit (callers/callees/source)
      skipping = false;
      // Inline references (`callers: a@src/x.js:12, b@test/unit/y.test.js:3`): drop the ones whose file is not here.
      // Measured: an agent spent five calls hunting a test/unit directory that only the index's checkout has.
      if (/^\s*(callers|callees|imports|importers|dependents):/i.test(line) && /@\S+?:L?\d+/.test(line)) {
        const [head, ...rest] = line.split(/:(.+)/); const refs = (rest.join('') || '').split(/,\s*/).map((r) => r.trim()).filter(Boolean);
        const kept = refs.filter((r) => { const m = /@(\S+?):L?\d+/.exec(r); return !m || fs.existsSync(path.join(root, m[1])); });
        if (kept.length !== refs.length) dropped += refs.length - kept.length;
        out.push(kept.length ? `${head}: ${kept.join(', ')}` : `${head}: (none in this checkout)`); continue;
      }
      out.push(line);
    }
    if (dropped && dropped >= kept) out.splice(1, 0, `  (${dropped} hit(s) omitted: their files do not exist in this checkout — the index is behind it (a branch switch or a deleted file; it catches up on its own) or was built from another copy (then run \`kora ingest .\` here))`);
    return out.join('\n');
  }
  function slim(name: string, r: GraphToolResult, root: string | null = null): GraphToolResult {
    let text = existsFilter(r.text, root);
    if (name !== 'explore' && name !== 'neighbours' && name !== 'blast_radius') return { ...r, text };
    return { ...r, text: slimText(text), data: slimData(r.data) };
  }

  /** A row indexed under this checkout's NAME whose recorded folder is gone: the repo was moved/renamed. A row whose
   *  folder still exists is a DIFFERENT checkout that happens to share the basename, and must not answer for this one.
   *  Nor may a gone row that is not this REPOSITORY: a deleted `~/old/app` and an unrelated `~/new/app` share only the
   *  basename (audit 2026-10-15 #2: the old row was read as "this repo, moved", flagged staleForCheckout, and a silent
   *  full index started on pane open; its files that happen to exist here were injected with wrong lines). */
  async function movedRow(db: any, root: string): Promise<any> {
    const row = db.prepare(
      `SELECT r.id, r.name, r.full_path, r.web_url, rb.id AS branch_id, rb.last_synced_at, rb.node_count, rb.last_commit_sha
         FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id
        WHERE lower(r.name) = lower(?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(path.basename(root));
    if (!row) return undefined;
    // A row whose folder is still there is another checkout — unless it is THIS folder spelled differently (macOS /var vs
    // /private/var, a symlinked parent), which is the same repo.
    try { if (kg('src/services/repo-name.js').sameCheckout(row.full_path, root) === false) return undefined; } catch { /* keep */ }
    // Identity, not a name: the row's indexed commit must be in this checkout's history (and a recorded remote agree).
    // A row with no commit to check (a plain folder) is not adopted either — this is a read path, it can only guess.
    try { if (await kg('src/services/repo-name.js').sameRepoIdentityAsync(row, root) !== true) return undefined; } catch { return undefined; }
    return row;
  }
  /** The checkout's FIRST full index is running right now (a live RUNNING/PENDING full job, and no full job before it
   *  ever finished). The store already holds part of the graph — measured mid-ingest: 21k of 41k nodes — and answering
   *  from it said "NO DECLARATION NAMED freshenIndex EXISTS" about a symbol it simply had not reached yet. */
  function firstIndexInFlight(db: any, root: string, real: string): boolean {
    try {
      const job = db.prepare(`SELECT id, status FROM ingest_jobs WHERE local_path IN (?, ?) AND coalesce(job_type, 'FULL') != 'INCREMENTAL' ORDER BY id DESC LIMIT 1`).get(root, real);
      if (!job || (job.status !== 'RUNNING' && job.status !== 'PENDING')) return false;
      if (indexDiedPartWay(db, root, real)) return false; // nobody behind it: that is "incomplete", not "indexing"
      const done = db.prepare(`SELECT 1 FROM ingest_jobs WHERE local_path IN (?, ?) AND coalesce(job_type, 'FULL') != 'INCREMENTAL' AND status IN ('COMPLETE', 'DEGRADED') AND id < ? LIMIT 1`).get(root, real, job.id);
      return !done;
    } catch { return false; }
  }
  /** The latest FULL ingest of this checkout ended FAILED, or is RUNNING with nobody alive behind it. */
  function indexDiedPartWay(db: any, root: string, real: string): boolean {
    try {
      // The latest FULL job decides, not the latest job: a query-time catch-up (INCREMENTAL, COMPLETE) run on top of a
      // half-built graph must not make it look whole.
      const job = db.prepare(`SELECT status, job_type, started_at, updated_at FROM ingest_jobs WHERE local_path IN (?, ?) AND coalesce(job_type, 'FULL') != 'INCREMENTAL' ORDER BY id DESC LIMIT 1`).get(root, real);
      if (!job) return false;
      if (job.status === 'FAILED') return true;
      if (job.status !== 'RUNNING' && job.status !== 'PENDING') return false;
      if (lockHolder(root) || lockHolder(real)) return false; // someone is indexing it right now
      try { const h = kg('src/services/ingest-lock.js').holder(root); if (h && Number(h.pid)) { process.kill(Number(h.pid), 0); return false; } } catch (e: any) { if (e?.code === 'EPERM') return false; }
      const t = Date.parse(String(job.updated_at || job.started_at || '')); // no live lock: give a just-started job a moment
      return !Number.isFinite(t) || Date.now() - t > 15_000;
    } catch { return false; }
  }

  async function status(cwd: string, sopts?: { nocache?: boolean }): Promise<PaneGraphInfo> {
    const root = repoRoot(cwd);
    const key = root || `cwd:${cwd}`;
    const hit = statusCache.get(key);
    if (hit && !sopts?.nocache && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const value: PaneGraphInfo = { repoRoot: root, indexed: false, nodes: 0, edges: 0, lastIngestAt: null, enforced: enforcementPresent(root), toolCalls: 0 };
    let coveredAt: number | null = null; // the newest moment an ingest started that the working tree is known to be folded into
    if (root) {
      try {
        const dbFile = graphDbPath();
        if (fs.existsSync(dbFile)) {
          const Database = require('better-sqlite3');
          const db = new Database(dbFile, { readonly: true, fileMustExist: true });
          try {
            db.pragma('busy_timeout = 300');
            let real = root; try { real = fs.realpathSync(root); } catch { /* keep */ }
            const byPath = db.prepare(
              `SELECT r.id, r.name, rb.id AS branch_id, rb.last_synced_at, rb.node_count, rb.last_commit_sha
                 FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id
                WHERE r.full_path IN (?, ?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(root, real)
              || await movedRow(db, root);
            if (byPath) {
              storeNames.set(root, byPath.name); // (dropped again below when the index turns out to be incomplete)
              // Matched by NAME to a row indexed from another checkout? Sample the indexed files: if a chunk of them
              // is missing here, the index is from a different copy or revision and every file:line it returns is
              // suspect. Surfaced on the pane, in the brief, and by doctor. (Measured: a store row carried two
              // directories this checkout never had.)
              if (byPath.full_path && byPath.full_path !== root && byPath.full_path !== real) {
                value.indexedFrom = String(byPath.full_path);
                try {
                  const sample = db.prepare(`SELECT path FROM files WHERE repository_branch_id = ? ORDER BY random() LIMIT 30`).all(byPath.branch_id) as { path: string }[];
                  const missing = sample.filter((f) => !fs.existsSync(path.join(root, f.path))).length;
                  value.staleForCheckout = sample.length >= 10 && missing / sample.length > 0.2;
                } catch { /* older schema */ }
              }
              const nodes = db.prepare(`SELECT count(*) AS n FROM nodes WHERE repository_branch_id = ? AND approval_status != 'ARCHIVED'`).get(byPath.branch_id).n as number;
              const edges = db.prepare(`SELECT count(*) AS n FROM edges e JOIN nodes n ON n.id = e.from_node_id WHERE n.repository_branch_id = ?`).get(byPath.branch_id).n as number;
              // A FULL index that failed or was killed part-way leaves a partial graph that looks exactly like an index:
              // the store row is COMPLETE and holds some nodes. The job row is the only witness.
              const incomplete = nodes > 0 && indexDiedPartWay(db, root, real);
              const building = !incomplete && nodes > 0 && firstIndexInFlight(db, root, real);
              value.incomplete = incomplete || undefined;
              value.firstIndexRunning = building || undefined;
              if (incomplete || building) storeNames.delete(root); // queries must not answer from a half-built graph
              value.indexed = nodes > 0 && !incomplete && !building;
              value.nodes = nodes; value.edges = edges;
              const t = byPath.last_synced_at ? Date.parse(byPath.last_synced_at) : NaN;
              value.lastIngestAt = Number.isFinite(t) ? t : null;
              // Freshness: the commit the index was built at vs HEAD here. Uncommitted edits are folded in at
              // query time by koragraph's live-freshness pass; a moved HEAD means whole files may have changed.
              value.indexedSha = byPath.last_commit_sha ? String(byPath.last_commit_sha) : null;
              value.headSha = headSha(root);
              value.stale = !!(value.indexed && value.indexedSha && value.headSha && !value.headSha.startsWith(value.indexedSha) && !value.indexedSha.startsWith(value.headSha));
              // The latest finished ingest of any kind (an incremental one over a dirty tree does not move last_synced_at).
              coveredAt = value.lastIngestAt;
              try {
                const j = db.prepare(`SELECT started_at FROM ingest_jobs WHERE local_path IN (?, ?) AND status NOT IN ('FAILED') ORDER BY id DESC LIMIT 1`).get(root, real);
                const t = j?.started_at ? Date.parse(String(j.started_at)) : NaN;
                if (Number.isFinite(t) && (coveredAt == null || t > coveredAt)) coveredAt = t;
              } catch { /* older schema */ }
            }
          } finally { db.close(); }
          // Uncommitted edits: the index follows commits, so a dirty tree is stale too (before this an agent that wrote a
          // function and then asked the graph for it was told "no declaration named X exists").
          if (value.indexed && !value.stale && coveredAt != null && !lockHolder(root)) {
            const n = await dirtySourceFilesSince(root, coveredAt);
            if (n > 0) { value.stale = true; value.dirtyFiles = n; }
          }
        }
      } catch (e) { if (isStoreCorruptError(e)) value.storeError = String((e as any)?.message || e); /* else zeros */ }
    }
    capSize(statusCache, 2000); statusCache.set(key, { at: Date.now(), value });
    return value;
  }

  async function ingest(target: string, opts: { project?: string; wait?: boolean; full?: boolean; force?: boolean; io?: { out: (s: string) => void; err: (s: string) => void } } = {}): Promise<{ ok: true; nodes?: number; edges?: number }> {
    const { root: abs, fromWorktree } = ingestRoot(target);
    const unsafe = opts.force ? null : unsafeIndexRoot(abs);
    if (unsafe) throw new UnsafeIndexRootError(abs, unsafe);
    if (opts.wait === false) return ingestOnce(abs, fromWorktree, opts);
    try { const r = await ingestOnce(abs, fromWorktree, opts); recordIngestOutcome(abs, null); return r; }
    catch (e: any) { recordIngestOutcome(abs, String(e?.message || e)); throw e; }
  }
  async function ingestOnce(abs: string, fromWorktree: string | null, opts: { project?: string; wait?: boolean; full?: boolean; force?: boolean; io?: { out: (s: string) => void; err: (s: string) => void } }): Promise<{ ok: true; nodes?: number; edges?: number }> {
    if (fromWorktree && opts.io) opts.io.err(`${path.basename(fromWorktree)} is a worktree of ${abs} — indexing the main checkout (the graph is shared by every worktree)\n`);
    const project = opts.project || 'default';
    if (opts.wait === false) {
      fs.mkdirSync(koraHome(), { recursive: true });
      const log = fs.openSync(path.join(koraHome(), 'ingest.log'), 'a');
      const child = spawn(NODE_BIN, ['--liftoff-only', KORA_BIN, 'ingest', abs, '--project', project, ...(opts.full ? ['--full'] : []), ...(opts.force ? ['--force'] : [])], { detached: true, stdio: ['ignore', log, log], env: process.env });
      const startedAt = Date.now();
      child.on('exit', (code, signal) => noteDetachedIngestExit(abs, startedAt, code, signal));
      child.unref();
      fs.closeSync(log);
      return { ok: true };
    }
    const { waitLock } = require('./lock');
    const lock = await waitLock(abs, 15 * 60 * 1000);
    if (!lock) throw new Error(`another process is still indexing ${abs} (see ~/.kora/locks)`);
    // A store SQLite cannot open fails every ingest ("file is not a database") and answers no query: move it aside and
    // start a fresh one (derived data — each repo re-indexes from its checkout).
    try {
      const damage = storeDamage();
      if (damage) { const moved = await quarantineStore(); (opts.io || { err: (t: string) => process.stderr.write(t) }).err(`The graph store was damaged (${damage}); moved it to ${moved} and starting a fresh one. Other repositories it held need indexing again (Index on their graph chip, or \`kora ingest <path>\`).\n`); }
    } catch (e: any) { lock.release(); throw new Error(`the graph store is damaged and could not be moved aside: ${e?.message || e}`); }
    const cli = kg('src/cli/ingest.js');
    const parsed = cli.parse([abs, '--project', project, '--no-hooks', ...(opts.full ? ['--full'] : [])]);
    let captured = '';
    const io = opts.io || { out: (s: string) => process.stderr.write(s), err: (s: string) => process.stderr.write(s) };
    let code: number;
    let lastErrLine = '';
    try { code = await cli.run(parsed, { out: (s: string) => { captured += s; io.out(s); }, err: (s: string) => { const t = koraWording(s); const l = t.trim().split('\n').filter(Boolean).pop(); if (l && /error|fail|cannot|refus/i.test(l)) lastErrLine = l.slice(0, 300); io.err(t); } }); } finally { lock.release(); }
    statusCache.clear();
    try { kg('src/services/graph-staleness.js').resetStalenessCache(); } catch { /* fine */ }
    if (code !== 0) throw new Error(`ingest failed (exit ${code})${lastErrLine ? `: ${lastErrLine}` : ''}`);
    const m = /(\d+) nodes\s+(\d+) edges/.exec(captured);
    return m ? { ok: true, nodes: Number(m[1]), edges: Number(m[2]) } : { ok: true };
  }

  // First index of a repo, with a progress signal the server can draw. koragraph's ingest has no per-file callback,
  // but it does write per-file state: each file's `files` row is upserted PENDING as it is visited and flipped to
  // COMPLETE/DEGRADED/FAILED when done (ingest.js upsertFile, ingest-file-processor.js), and `ingest_jobs` carries
  // files_total (written before the file loop) and files_done (per file). Measured on an isolated store (KoragraphMCP
  // clone, 267 files, 6.2 s): a concurrent readonly connection polling every 500 ms saw 9 → 56 → 63 → 80 → 128 → 136
  // → 187 → 209/209 (WAL: every commit is visible), then ~1.1 s of post-file passes. So progress is REAL for the
  // files phase; the time estimate (files-per-second EMA against `git ls-files`, re-learned per completed ingest)
  // stands in only until the repository row exists, and sizes the post-file tail. Phase labels still come off the
  // child's stderr tags. Every store read is readonly, busy_timeout 50 ms, and in try/catch: a locked or older store
  // just keeps the last numbers.
  async function ingestWithProgress(target: string, onProgress: (p: { phase: string; pct: number; files: number; filesTotal?: number; elapsedMs: number; etaMs: number }) => void, opts: { project?: string } = {}): Promise<{ ok: boolean; nodes?: number; edges?: number; error?: string; ms: number }> {
    const abs = ingestRoot(target).root;
    const unsafe = unsafeIndexRoot(abs); // only ever an automatic index: never forced
    if (unsafe) return { ok: false, error: new UnsafeIndexRootError(abs, unsafe).message, ms: 0 };
    let real = abs; try { real = fs.realpathSync(abs); } catch { /* keep */ }
    const { spawn: sp } = require('node:child_process');
    let files = 0; // async: a sync `git ls-files` on a huge repo stalled the daemon's loop for seconds
    try { files = (await new Promise<string>((res) => execFile('git', ['-c', 'core.fsmonitor=false', 'ls-files'], { cwd: abs, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 10_000 }, (_e, out) => res(String(out || ''))))).split('\n').filter(Boolean).length; } catch { files = 0; }
    const rateFile = path.join(koraHome(), 'ingest-rate.json');
    let rate = 45; // files/s, conservative default
    try { rate = Number(JSON.parse(fs.readFileSync(rateFile, 'utf8')).rate) || rate; } catch { /* default */ }
    const estMs = Math.max(4000, (files / rate) * 1000);
    const t0 = Date.now();
    const startedIso = new Date(t0 - 1000).toISOString(); // the job row this run opens (koragraph stamps started_at with sqlite's UTC 'now')
    let phase = 'scanning';
    let done = 0, total = 0, filesDoneAt: number | null = null, lastPct = 0;
    const pollStore = () => {
      let db: any = null;
      try {
        const dbFile = graphDbPath(); if (!fs.existsSync(dbFile)) return;
        const Database = require('better-sqlite3');
        db = new Database(dbFile, { readonly: true, fileMustExist: true }); db.pragma('busy_timeout = 50');
        const row = db.prepare(`SELECT rb.id AS branch_id FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id
                                 WHERE r.full_path IN (?, ?) ORDER BY rb.is_tracked DESC, rb.id DESC LIMIT 1`).get(abs, real);
        if (!row) return;
        let job: any = null;
        try { job = db.prepare(`SELECT files_total, files_done FROM ingest_jobs WHERE local_path IN (?, ?) AND started_at >= ? ORDER BY id DESC LIMIT 1`).get(abs, real, startedIso); } catch { /* older schema: files table only */ }
        // Rows the post-file passes add (docs, manifests, presence-floor stubs) stay PENDING; never count those. On a
        // re-index the previous run's COMPLETE rows are still there, so the job's own counter is preferred when present.
        const nonPending = db.prepare(`SELECT count(*) AS n FROM files WHERE repository_branch_id = ? AND index_status != 'PENDING'`).get(row.branch_id).n as number;
        const jobTotal = Number(job?.files_total) || 0;
        total = jobTotal > 0 ? jobTotal : files;
        done = jobTotal > 0 ? Math.min(jobTotal, Number(job.files_done) || 0) : Math.min(total || nonPending, nonPending);
        if (filesDoneAt == null && total > 0 && done >= total) filesDoneAt = Date.now();
      } catch { /* locked (busy_timeout hit) or schema mismatch: keep the last numbers */ } finally { try { db?.close(); } catch { /* gone */ } }
    };
    const tick = () => {
      const el = Date.now() - t0;
      // Tail estimate: the post-file passes took ~23% of the files phase on the measured run; 25% with a 1 s floor.
      const tailEstMs = filesDoneAt != null ? Math.max(1000, 0.25 * (filesDoneAt - t0)) : 0;
      const tailElapsedMs = filesDoneAt != null ? Date.now() - filesDoneAt : 0;
      const pct = Math.max(lastPct, progressPct({ done, total, elapsedMs: el, estMs, filesPhaseDone: filesDoneAt != null, tailElapsedMs, tailEstMs }));
      lastPct = pct;
      let etaMs: number;
      if (filesDoneAt != null) etaMs = Math.max(0, Math.round(tailEstMs - tailElapsedMs));
      else if (total > 0 && done > 0) etaMs = Math.max(0, Math.round((total - done) * (el / done) + 0.25 * el * (total / done))); // remaining files at the observed rate, plus the tail
      else etaMs = Math.max(0, estMs - el);
      // koragraph's stderr filter emits no tag during the file loop, so the label would sit at "scanning" for the
      // whole files phase; once real counts exist the honest label is "indexing".
      // The stderr tags are internal pass names (`DEGRADED`, `resolveImportFacts`, `topic`): never shown once real counts exist.
      onProgress({ phase: filesDoneAt != null ? 'finishing' : (total > 0 ? 'indexing' : phase), pct, files: done, filesTotal: total || undefined, elapsedMs: el, etaMs });
    };
    const timer = setInterval(() => { pollStore(); tick(); }, 500); tick();
    fs.mkdirSync(koraHome(), { recursive: true });
    const logFd = fs.openSync(path.join(koraHome(), 'ingest.log'), 'a');
    let captured = '';
    const code: number = await new Promise((resolve) => {
      const child = sp(NODE_BIN, ['--liftoff-only', KORA_BIN, 'ingest', abs, ...(opts.project ? ['--project', opts.project] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      child.stdout.on('data', (d: Buffer) => { captured += d.toString(); fs.writeSync(logFd, d); });
      child.stderr.on('data', (d: Buffer) => {
        fs.writeSync(logFd, d);
        const m = /\[([\w-]+)\](?:\s+\[([\w-]+)\])?/.exec(d.toString()); if (m) phase = (m[1] === 'ingest' ? m[2] : m[1]) || phase;
        if (/still working: ([\w-]+)/.test(d.toString())) phase = RegExp.$1;
      });
      child.on('close', (c: number) => resolve(c ?? 1)); // 'close', not 'exit': pipes may still deliver data after exit, and logFd is closed below
      child.on('error', () => resolve(1));
    });
    clearInterval(timer); fs.closeSync(logFd);
    const ms = Date.now() - t0;
    if (code === 0 && files > 0 && ms > 1000) { const measured = files / (ms / 1000); const next = rate === 45 ? measured : rate * 0.5 + measured * 0.5; try { fs.writeFileSync(rateFile, JSON.stringify({ rate: Math.round(next * 10) / 10, samples: files, at: new Date().toISOString() })); } catch { /* fine */ } }
    statusCache.clear();
    try { kg('src/services/graph-staleness.js').resetStalenessCache(); } catch { /* fine */ }
    onProgress({ phase: code === 0 ? 'done' : 'failed', pct: 100, files: total > 0 ? done : files, filesTotal: total || undefined, elapsedMs: ms, etaMs: 0 });
    const m = /(\d+) nodes\s+(\d+) edges/.exec(captured);
    if (code !== 0) recordIngestOutcome(abs, `ingest exited ${code} (see ${path.join(koraHome(), 'ingest.log')})`); // the child clears it on success itself
    return code === 0 ? { ok: true, nodes: m ? Number(m[1]) : undefined, edges: m ? Number(m[2]) : undefined, ms } : { ok: false, error: `ingest exited ${code} (see ~/.kora/ingest.log)`, ms };
  }

  // A pane opens by launching a real agent, and the agent's SessionStart hook waits for this brief before the pane
  // is usable — on a large graph the overview/status/staleness queries take several seconds, which is felt directly
  // as "why is this slower than a terminal". The brief is stable until the graph changes, so cache it to
  // disk keyed by (repo root, agent) and invalidate whenever graph.db is newer than the cache (a
  // re-ingest). First open in a repo pays the cost; every later open is a file read (~ms). A hard TTL
  // bounds staleness for the parts that change without a db write.
  const BRIEF_CACHE_HARD_TTL_MS = 15 * 60_000;
  function briefCacheFile(root: string, agent?: AgentId): string {
    const key = crypto.createHash('sha1').update(`${root} ${agent || ''}`).digest('hex').slice(0, 16);
    return path.join(koraHome(), 'brief-cache', `${key}.txt`);
  }
  function newestSourceMtime(): number {
    let m = 0;
    for (const f of [safe(graphDbPath)]) { try { if (f) m = Math.max(m, fs.statSync(f).mtimeMs); } catch { /* missing */ } }
    return m;
    function safe(fn: () => string): string { try { return fn(); } catch { return ''; } }
  }
  /** 2 significant figures: 13306 → 13000, 26637 → 27000, 842 → 840. */
  function roundCount(n: number): string { if (!Number.isFinite(n) || n < 100) return String(n); const p = Math.pow(10, Math.floor(Math.log10(n)) - 1); return String(Math.round(n / p) * p); }
  async function brief(cwd: string, agent?: AgentId): Promise<string> {
    if (process.env.KORA_BRIEF_NOCACHE === '1') return computeBrief(cwd, agent);
    const root = repoRoot(cwd) || repoIdentity(cwd).repoRoot || cwd;
    const cacheFile = briefCacheFile(root, agent);
    try {
      const st = fs.statSync(cacheFile);
      if (Date.now() - st.mtimeMs < BRIEF_CACHE_HARD_TTL_MS && st.mtimeMs >= newestSourceMtime()) return fs.readFileSync(cacheFile, 'utf8');
    } catch { /* no usable cache */ }
    const text = await computeBrief(cwd, agent);
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, text); } catch { /* best effort */ }
    return text;
  }

  // The brief sits in context for the whole session, so for an agent that already carries the rulebook in its
  // instruction file (claude: CLAUDE.md + system prompt) the how-to section is pure duplication and is dropped.
  async function computeBrief(cwd: string, agent?: AgentId): Promise<string> {
    const id = repoIdentity(cwd);
    // repoRoot(cwd) maps a linked worktree back to its MAIN checkout (the graph is keyed there); prefer it over
    // repoIdentity's raw root, which for a worktree is the worktree dir (whose basename — an agent slug like
    // claude-wry-newt — is not a repo the store knows, so the overview headline said "no repository named …").
    const root = repoRoot(cwd) || id.repoRoot || cwd;
    const repoName = path.basename(root);
    const full = process.env.KORA_BRIEF_FULL === '1';
    type Section = { prio: number; lines: string[]; minLines: number };
    const sections: Section[] = [];

    // (a) overview headline for THIS repo
    let overviewLines: string[] = [];
    try {
      const st = await withTimeout(status(cwd), 1500, null as PaneGraphInfo | null);
      if (st && !st.indexed) {
        overviewLines = [`This repository (${repoName}) is not indexed yet, so grep and Read are the right tools and nothing is denied. Only the user starts a first index (Index on the graph chip); do not index it yourself.`];
      } else if (full) {
        // Human-facing `kora graph brief --full` / overview: the weighted-hub list is worth the graph scan.
        const r = await withTimeout(runTool('overview', { repo: storeNames.get(root) || repoName, limit: 5 }, cwd, false), 4000, null as GraphToolResult | null);
        if (r) overviewLines = r.text.split('\n').filter((l) => l.trim()).slice(0, 30);
      } else if (st) {
        // Agent session brief: a cheap one-line headline from the counts we ALREADY fetched in status() — no graph
        // scan. The weighted-hub overview costs a full scan of a large graph for a line the agent doesn't act on
        // ("orientation for a human"); an agent that has explore/blast_radius pulls the hubs it needs on demand.
        // Rounded on purpose: exact counts move with every incremental re-index and would make the brief — and with
        // it the cached prompt prefix — differ between sessions for nothing.
        overviewLines = [`${repoName}: ≈${roundCount(st.nodes)} nodes, ≈${roundCount(st.edges)} edges — indexed. Query it with \`kora graph explore "<symbol or phrase>"\`.`];
      }
    } catch (e: any) {
      overviewLines = [`Graph overview unavailable: ${String(e?.message || e).split('\n')[0]}`];
    }
    if (overviewLines.length) sections.push({ prio: 9, lines: ['GRAPH — ' + repoName, ...overviewLines.map((l) => '  ' + l)], minLines: 2 });

    // (c′) index from a different checkout
    try {
      const st0 = await withTimeout(status(cwd), 1500, null as PaneGraphInfo | null);
      if (st0?.staleForCheckout) sections.push({ prio: 8, lines: [`INDEX MISMATCH: the graph for ${repoName} was built from ${st0.indexedFrom}, a different copy of this repo, and some of its files do not exist here. until the user re-indexes it (Index on the graph chip), verify any graph file:line with a Read. Do not index it yourself.`], minLines: 1 });
    } catch { /* fine */ }
    // (c) staleness
    try {
      const gs = kg('src/services/graph-staleness.js');
      // Scoped to this repo: the store-wide probe runs a synchronous `git rev-parse` per indexed repo on the daemon's
      // event loop, once per brief (CPU profile, swarm e2e: 5 s stalls with ~40 indexed repos).
      const state = await withTimeout(gs.graphStaleness({ repoName }), 2500, null as any);
      const mine = state?.stale?.find((s: any) => s.repo === repoName);
      if (mine) sections.push({ prio: 8, lines: [`STALE: graph for ${repoName} is at ${mine.indexed}, HEAD is ${mine.head} — kora re-indexes it in the background when it runs the pane (the header says "stale · reindexing" until done); until then verify graph file:line with a Read. Outside kora: \`kora ingest .\`.`], minLines: 1 });
    } catch { /* unknown is not stale */ }

    const header = `kora session brief — ${repoName}${agent ? ` (${agent})` : ''} — the code graph is mandatory here.`;
    const howto = agent === 'claude' ? '' : howToSection(); // claude carries the rulebook in CLAUDE.md + system prompt already
    const order = sections.slice();
    const render = () => [header, ...order.filter((s) => sections.includes(s)).map((s) => s.lines.join('\n')), howto].join('\n\n');
    if (!full) {
      // Shrink lowest-priority sections first, one line at a time, then drop them; the how-to always stays.
      let text = render();
      const byPrio = () => sections.slice().sort((a, b) => a.prio - b.prio);
      for (const s of byPrio()) {
        while (text.length > BRIEF_MAX && s.lines.length > s.minLines) { s.lines.pop(); text = render(); }
      }
      for (const s of byPrio()) {
        if (text.length <= BRIEF_MAX) break;
        sections.splice(sections.indexOf(s), 1); text = render();
      }
      return text.length > BRIEF_MAX ? text.slice(0, BRIEF_MAX) : text;
    }
    return render();
  }

  return { callTool, status, ingest, ingestWithProgress, brief, repoRoot, primeRepoRoot, __slim: slim } as any;
}

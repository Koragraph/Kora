// `kora graph <tool> …` — the shell face of the embedded graph. Works with no server running
// (in-process); inside a pane with a live socket it routes through the server so the sidebar counts
// the call, falling back to in-process on any error.
import fs from 'node:fs';
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str, num } from '../args';
import { GRAPH_TOOLS, type GraphTool, type AgentId } from '../../protocol/types';
import { createGraphService } from '../../graph/index';
import { socketReachable } from '../../graph/embedded';
import { loadConfig } from '../../config';
import * as resultCache from '../../graph/result-cache';
import { identifierOf, shimHits } from '../../enforce/search-shape';

export const summary = 'Query the code graph';
export const usage = `Usage: kora graph <tool> [query|symbol|file] [options]

Tools (positional maps to the tool's primary argument):
  explore <query>            symbol OR plain-English phrase → ranked declarations + source/callers/callees
  search_code <query>        locate a declaration by name/path/description
  neighbours <symbol>        callers/callees           [--file F] [--direction in|out|both] [--depth N]
  changes_with <symbol>      git-mined co-change        [--file F]
  blast_radius               --file <path> [--file <path>…] | --symbol S   [--depth N] [--task-type T]
  file_symbols <path>        everything in one file
  overview                   orient in the repo         [--repo NAME]
  brief                      the session-start brief for this cwd [--agent X]
  status                     graph status for this cwd (JSON with --json)
  ingest <path>              index a repository [--project P] [--no-wait] [--full: re-extract every file]
                             [--force: allow a home folder / filesystem root / shallow path]
  plan-check                 check a plan before spawning: --slices '<json [{title,files,symbols}]>' | --file plan.json
  report                     the repo's code map: areas, hubs, entry points, how they connect [--out FILE] [--json]
                             (a client of the running daemon; needs the UI token, so run it yourself)
  prune                      garbage-collect the store: repos whose folder is gone, old archived nodes
                             [--dry-run] [--now] [--grace-days N] [--archived-days N] [--vacuum]

Common options: --limit N  --full (detail:"full")  --json  --repo R|all (scope; default: the repo containing cwd)  --cwd DIR
                --no-cache (inside a session an identical query against an unchanged index prints a pointer to the earlier result)
Inside a kora pane (KORA_PANE_ID set) calls are routed through the server so they are counted.`;

const VALUE_FLAGS = ['file', 'symbol', 'repo', 'limit', 'direction', 'depth', 'task-type', 'agent', 'project', 'cwd', 'query', 'path', 'timeout', 'grace-days', 'archived-days', 'out', 'slices'];

export function buildToolArgs(tool: string, positional: string[], flags: Record<string, string | boolean>): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  const p0 = positional[0];
  const file = str(flags.file);
  const symbol = str(flags.symbol);
  switch (tool) {
    case 'explore': case 'search_code':
      a.query = str(flags.query) ?? positional.join(' ');
      break;
    case 'neighbours': case 'changes_with':
      a.symbol = symbol ?? p0; if (file) a.file = file;
      if (tool === 'neighbours') { const d = str(flags.direction); if (d) a.direction = d; const depth = num(flags.depth); if (depth) a.depth = depth; }
      break;
    case 'blast_radius': {
      const files: string[] = [];
      const fl = flags.file; if (typeof fl === 'string') files.push(...fl.split(','));
      if (symbol) a.symbol = symbol;
      if (!files.length && positional.length) files.push(...positional);
      if (files.length) a.files_changed = files;
      const depth = num(flags.depth); if (depth) a.depth = depth;
      const tt = str(flags['task-type']); if (tt) a.task_type = tt;
      break;
    }
    case 'file_symbols':
      a.path = str(flags.path) ?? file ?? p0;
      break;
    case 'overview': {
      const repo = str(flags.repo); if (repo) a.repo = repo;
      break;
    }
  }
  const limit = num(flags.limit); if (limit && tool !== 'explore') a.limit = limit;
  if (flags.full) a.detail = 'full';
  const repo = str(flags.repo); if (repo && tool !== 'overview') a.project_id = repo === 'all' ? null : repo;
  return a;
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv, VALUE_FLAGS);
  const [tool, ...rest] = positional;
  const cwd = path.resolve(str(flags.cwd) || process.cwd());
  if (!tool || flags.help) { io.out(usage + '\n'); return tool ? 0 : 2; }
  // Shims run us with a hard deadline: a graph that hangs must never delay the real grep.
  const deadline = num(flags.timeout) ?? Number(process.env.KORA_GRAPH_TIMEOUT_MS || 0);
  if (deadline > 0) setTimeout(() => process.exit(3), deadline).unref();

  if (tool === 'report') return (require('./graph-report') as typeof import('./graph-report')).runReport(flags, cwd, io);
  const graph = createGraphService();
  if (tool === 'plan-check') {
    let raw = str(flags.slices) ?? '';
    const pf = str(flags.file);
    try { if (!raw && pf) raw = fs.readFileSync(path.resolve(cwd, pf), 'utf8'); } catch (e: any) { io.err(`kora graph plan-check: cannot read ${pf}: ${e.message}\n`); return 2; }
    let slices: unknown;
    try { slices = JSON.parse(raw); } catch { io.err(`kora graph plan-check: give --slices '<json>' or --file plan.json: [{"title":"…","files":["src/x.js"],"symbols":["f"]}]\n`); return 2; }
    if (slices && !Array.isArray(slices) && Array.isArray((slices as any).slices)) slices = (slices as any).slices;
    if (!Array.isArray(slices)) { io.err('kora graph plan-check: the plan must be a JSON array of slices\n'); return 2; }
    const { planCheck } = require('../../server/swarm-context') as typeof import('../../server/swarm-context');
    io.out(await planCheck({ cwd, slices: slices as any, graphCall: (name, args, opts) => graph.callTool(name as GraphTool, args, { cwd: opts?.cwd ?? cwd }) as any }) + '\n');
    return 0;
  }
  if (tool === 'brief') {
    const text = await graph.brief(cwd, str(flags.agent) as AgentId | undefined);
    io.out(flags.json ? JSON.stringify({ text }) + '\n' : text + '\n');
    return 0;
  }
  if (tool === 'status') {
    const st = await graph.status(cwd);
    // A linked worktree shares its main checkout's index: say which checkout the caller is in, not only whose graph answers.
    let checkout: string | null = null;
    try { const top = require('../../graph/embedded').gitTopLevel(cwd) as string | null; const real = (x: string) => { try { return fs.realpathSync(x); } catch { return x; } }; if (top && st.repoRoot && real(top) !== real(st.repoRoot)) checkout = top; } catch { /* not git */ }
    if (flags.json) io.out(JSON.stringify(checkout ? { ...st, checkout, worktreeOf: st.repoRoot } : st) + '\n');
    else io.out([...(checkout ? [`checkout: ${checkout}  (a linked worktree: it shares the graph of the main checkout)`] : []), `repo:     ${st.repoRoot || '(not a git checkout)'}`, `indexed:  ${st.indexed ? 'yes' : 'no'}`, `nodes:    ${st.nodes}`, `edges:    ${st.edges}`, `ingested: ${st.lastIngestAt ? new Date(st.lastIngestAt).toISOString() : '-'}`, ...(st.stale ? [`stale:    yes${st.dirtyFiles ? ` (${st.dirtyFiles} uncommitted source file(s) newer than the index)` : ' (HEAD moved)'} — re-indexes on your next message, or run: kora ingest .`] : []), `enforced: ${st.enforced ? 'yes' : 'no'}`].join('\n') + '\n');
    return 0;
  }
  if (tool === 'prune') {
    const { pruneStore, formatPrune } = require('../../graph/prune');
    const dryRun = flags['dry-run'] === true;
    const rep = await pruneStore({ dryRun, now: flags.now === true, graceDays: num(flags['grace-days']), archivedDays: num(flags['archived-days']), vacuum: flags.vacuum === true });
    if (flags.json) io.out(JSON.stringify(rep) + '\n'); else io.out(formatPrune(rep, dryRun));
    return 0;
  }
  if (tool === 'ingest') {
    const target = rest[0] || cwd;
    const wait = flags.wait !== false;
    const refusal = await (require('../../graph/index-consent') as typeof import('../../graph/index-consent')).agentFirstIndexRefusal(graph, path.resolve(target));
    if (refusal) { io.err(`kora graph ingest: ${refusal}\n`); return 2; }
    let r: unknown;
    try { r = await graph.ingest(target, { project: str(flags.project), wait, full: flags.full === true, force: flags.force === true, io } as any); }
    catch (e: any) { if (e?.code === 'unsafe_root') { io.err(`kora graph ingest: ${e.message}\n`); return 2; } throw e; }
    if (!wait) io.out(`ingest started in the background for ${path.resolve(target)} (log: ~/.kora/ingest.log)\n`);
    else if (flags.json) io.out(JSON.stringify(r) + '\n');
    return 0;
  }
  if (!(GRAPH_TOOLS as readonly string[]).includes(tool)) {
    io.err(`kora graph: unknown tool "${tool}". Tools: ${GRAPH_TOOLS.join(', ')}, brief, status, ingest\n`);
    return 2;
  }
  const args = buildToolArgs(tool, rest, flags);
  // The grep/rg PATH shim (enforce/shims.ts) asks for search_code on every search a pane runs. Only a search for one code
  // identifier gets graph hits, and only the hits that declare it; everything else prints nothing (and skips the lookup).
  const shim = process.env.KORA_SHIM_ACTIVE === '1' && tool === 'search_code' && !flags.json;
  const shimIdent = shim ? identifierOf(args.query) : null;
  if (shim && !shimIdent) return 0;
  // Same query, same graph, same answer (config.graphCache): only inside a session, only for plain-text output.
  let cacheQ: resultCache.CacheLookup | null = null;
  if (flags.cache !== false && !flags.json && !shim) { // a shim's hits are never a pointer to an earlier answer
    try {
      const session = resultCache.currentSession();
      if (session && loadConfig().graphCache) {
        const st = await graph.status(cwd);
        if (st.repoRoot && st.indexed && st.lastIngestAt) {
          cacheQ = { repoRoot: st.repoRoot, generation: String(st.lastIngestAt), tool, args, session };
          const hit = resultCache.lookup(cacheQ);
          if (hit) { io.out(resultCache.pointerText(hit) + '\n'); return 0; }
        }
      }
    } catch { cacheQ = null; }
  }
  let result: { text: string; data: unknown; ms: number } | null = null;
  const paneId = process.env.KORA_PANE_ID;
  if (paneId && socketReachable()) {
    try {
      const { callOnce } = require('../../protocol/client');
      result = await callOnce('graph.tool', { name: tool, args, cwd, paneId, channel: process.env.KORA_SHIM_ACTIVE === '1' ? 'shim' : 'cli' });
    } catch { result = null; }
  }
  try {
    if (!result) result = await graph.callTool(tool as GraphTool, args, { cwd });
  } catch (e: any) {
    if (flags.json) io.out(JSON.stringify({ error: e.message, code: e.code || 'tool_error' }) + '\n');
    else io.err(`${e.message}\n`);
    return 1;
  }
  if (flags.json) io.out(JSON.stringify({ tool, args, ms: result.ms, text: result.text, data: result.data }) + '\n');
  else if (!shimIdent) io.out(result.text.replace(/\s*$/, '') + '\n');
  if (shimIdent) { const hits = shimHits(result.text, shimIdent); if (hits) io.out(hits + '\n'); return 0; }
  if (cacheQ && result.text.trim()) { try { resultCache.remember({ ...cacheQ, text: result.text, turn: resultCache.currentTurn() }); } catch { /* fine */ } }
  return 0;
}

// Graph context packets (PLAN X1) and the spawn-time overlap check (X3).
//
// buildSwarmContextPacket: a swarm worker runs a small free model that has never seen this repo. Before its task we
// prepend what the code graph already knows about the symbols the task names — declarations with file:line, the top
// hit's callers — so the worker starts at the right place instead of grepping around. It shares its query
// distillation and result rendering with per-prompt injection (graph/prompt-inject.ts). Hard rules: one 1.5 s budget
// for everything, `{text:'', files:[]}` on an unindexed repo / a miss / a timeout / any error, never throws — a spawn
// must never wait on the graph.
//
// checkSwarmOverlap: pure. Which running workers already touched a file the new task's packet points at.
import fs from 'node:fs';
import path from 'node:path';
import type { DriverDeps } from '../session/session-driver';
import { declarationLines, distillQuery, hitRelevant, isPathHint, looksTextHunt, FILEISH_RE } from '../graph/prompt-inject';

/** A running worker whose touched files overlap the new task's context files. */
export interface SwarmOverlap { paneId: string; files: string[] }

const PACKET_BUDGET_MS = 1500;
const PACKET_MAX_CHARS = 1800;
const PACKET_HEADER = '## Context (from Kora graph)';
const PACKET_TRAILER = '(resolved from the code graph at spawn time; line numbers may be slightly off — open the file before editing)';
const EMPTY = (): { text: string; files: string[] } => ({ text: '', files: [] });

/** `path:line` locations in ■ / ranked-tail hit lines → repo-relative paths, in order, deduped. */
function hitFiles(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = /@\s+(\S+?):\d+/.exec(l);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Paths named in the task text that exist under cwd (`src/auth.ts`, `./lib/x.py`). */
function namedFiles(task: string, cwd: string): string[] {
  const out: string[] = [];
  for (const raw of task.match(/(?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z]{1,5}\b/g) || []) {
    const rel = raw.replace(/^\.\//, '');
    if (!FILEISH_RE.test(rel) || out.includes(rel)) continue;
    try { if (fs.statSync(path.join(cwd, rel)).isFile()) out.push(rel); } catch { /* not a file here */ }
    if (out.length >= 6) break;
  }
  return out;
}

const sleep = <T>(ms: number, v: T) => new Promise<T>((r) => { const t = setTimeout(() => r(v), ms); t.unref?.(); });

/**
 * The relevant declarations / callers / signatures for `task`, under a `## Context (from Kora graph)` header.
 * Returns `{ text: '', files: [] }` when the repo is not indexed or the lookup takes longer than 1.5 s — it must
 * never block a spawn.
 */
export async function buildSwarmContextPacket(input: { cwd: string; task: string; graphCall: DriverDeps['graphCall']; focus?: string[] }): Promise<{ text: string; files: string[] }> {
  if (input.focus?.length) return focusPacket({ cwd: input.cwd, focus: input.focus, graphCall: input.graphCall });
  try {
    const deadline = Date.now() + PACKET_BUDGET_MS;
    const task = String(input.task || '');
    if (!task.trim() || looksTextHunt(task)) return EMPTY();
    const named = namedFiles(task, input.cwd);
    const distilled = distillQuery(task);
    const idents = distilled.idents.filter((i) => !isPathHint(i, input.cwd));
    const tokens = distilled.tokens.length ? distilled.tokens : idents.map((i) => i.toLowerCase());
    // Identifiers name the declarations outright; without one, the prose query is too noisy to be worth a packet.
    if (!idents.length) return EMPTY();
    const query = idents.slice(0, 3).join(' ');
    const call = Promise.resolve()
      .then(() => input.graphCall('explore', { query }, { cwd: input.cwd, fresh: false }))
      .catch(() => null);
    const res = await Promise.race([call, sleep(Math.max(0, deadline - Date.now()), null)]);
    if (!res || typeof res.text !== 'string' || !res.text.trim()) return EMPTY();
    const head = res.text.split('\n').find((l) => l.trim()) || '';
    if (/not indexed|NO DECLARATION NAMED/i.test(head)) return EMPTY();
    const budget = PACKET_MAX_CHARS - PACKET_HEADER.length - PACKET_TRAILER.length - 4;
    const lines = declarationLines(res.text, budget, 0, tokens);
    // A wrong declaration is worse than none: at least one hit must actually be about a symbol the task names.
    if (!lines.some((l) => /^\s*■/.test(l) && hitRelevant(l, tokens))) return EMPTY();
    const files = hitFiles(lines);
    for (const n of named) if (!files.includes(n)) files.push(n);
    return { text: [PACKET_HEADER, ...lines, PACKET_TRAILER].join('\n'), files };
  } catch {
    return EMPTY();
  }
}

/**
 * The packet when the lead aimed the worker (kora_spawn focus: symbols, files, or a short behaviour phrase it found
 * with kora_locate): each focus item is looked up on its own and the declarations are kept as given — the lead already
 * judged relevance. A symptom-only task names no identifiers, so without focus the task-text packet was always empty
 * (bench5x T2). Bigger budget than a plain spawn: the lead asked for it.
 */
export const FOCUS_PACKET_BUDGET_MS = 6000;
const FOCUS_MAX_CHARS = 3200;
async function focusPacket(input: { cwd: string; focus: string[]; graphCall: DriverDeps['graphCall'] }): Promise<{ text: string; files: string[] }> {
  try {
    const items = [...new Set(input.focus.map((f) => String(f).trim()).filter(Boolean))].slice(0, 5);
    const results = await Promise.all(items.map((q) => Promise.race([
      Promise.resolve().then(() => input.graphCall('explore', { query: q }, { cwd: input.cwd, fresh: false })).catch(() => null),
      sleep(FOCUS_PACKET_BUDGET_MS, null),
    ])));
    const per = Math.floor((FOCUS_MAX_CHARS - PACKET_HEADER.length - PACKET_TRAILER.length) / Math.max(1, items.length));
    const lines: string[] = [];
    items.forEach((q, i) => {
      const r = results[i];
      if (!r || typeof r.text !== 'string' || /not indexed|NO DECLARATION NAMED/i.test(r.text.split('\n')[0] || '')) return;
      const got = declarationLines(r.text, per, 0, distillQuery(q).tokens);
      if (got.length) lines.push(`# ${q}`, ...got);
    });
    const files = hitFiles(lines);
    for (const f of items) if (FILEISH_RE.test(f) && !files.includes(f)) files.push(f);
    return lines.length ? { text: [PACKET_HEADER, ...lines, PACKET_TRAILER].join('\n'), files } : { text: '', files };
  } catch {
    return EMPTY();
  }
}

/**
 * kora_locate: where each symptom or behaviour lives, from the graph, compact — so a lead can aim workers without
 * reading code. One graph explore per query (in parallel), the top declarations only.
 */
export async function locate(input: { cwd: string; queries: string[]; graphCall: DriverDeps['graphCall']; perQueryChars?: number }): Promise<string> {
  const qs = [...new Set(input.queries.map((q) => String(q).trim()).filter(Boolean))].slice(0, 8);
  if (!qs.length) return 'give queries: a symptom, behaviour or symbol per item';
  const res = await Promise.all(qs.map((q) => Promise.race([
    Promise.resolve().then(() => input.graphCall('explore', { query: q }, { cwd: input.cwd, fresh: false })).catch((e: any) => ({ text: `error: ${e?.message ?? e}`, data: null, ms: 0 })),
    sleep(12_000, { text: 'timed out', data: null, ms: 0 }),
  ])));
  return qs.map((q, i) => {
    const t = res[i]?.text ?? '';
    if (/not indexed/i.test(t)) return `## ${q}\n(repo not indexed)`;
    const lines = declarationLines(t, input.perQueryChars ?? 450, 0, distillQuery(q).tokens);
    return `## ${q}\n${lines.length ? lines.join('\n') : '(no confident hit — try a symbol name or narrower phrase)'}`;
  }).join('\n\n');
}

const norm = (f: string) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '');

/** Advisory only: the running workers (files = their `git diff --name-only`) that touch any of `files`. */
export function checkSwarmOverlap(input: { files: string[]; running: { paneId: string; files: string[] }[] }): SwarmOverlap[] {
  const wanted = new Set((input.files || []).map(norm).filter(Boolean));
  if (!wanted.size) return [];
  const out: SwarmOverlap[] = [];
  for (const r of input.running || []) {
    const hit = Array.from(new Set((r.files || []).map(norm).filter((f) => wanted.has(f)))).sort();
    if (hit.length) out.push({ paneId: r.paneId, files: hit });
  }
  return out;
}

/** One slice of a lead's plan: one worker's task, with the files and symbols it edits. */
export type PlanSlice = { title: string; files: string[]; symbols?: string[] };

const PLAN_MAX_SLICES = 12;
const PLAN_MAX_SYMBOLS = 40;
const PLAN_MAX_CHARS = 2000;
const PLAN_CALL_MS = 12_000;
const PLAN_UNCOVERED_PER_SYMBOL = 4;
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|(?:^|\/)spec[^/]*$/i;

type InEdge = { kind: 'call' | 'import'; file: string; line: number; name: string | null };
/** The incoming edges of a neighbours answer: structured (data.neighbours.in) when present, else the text rows
 *  `  in   ← CALLS ←  METHOD postPayment @ src/ledger.js:L57 (line 64)`. CONTAINS rows (file/dir ownership) are not relations. */
function incomingEdges(res: { text: string; data: unknown }): InEdge[] {
  const out = new Map<string, InEdge>();
  const put = (edge: string, type: string, name: string, file: string, line: number) => {
    const e = edge.toUpperCase();
    if (!file || e.includes('CONTAIN')) return;
    const f = norm(file);
    out.set(`${f}:${line}:${e}`, { kind: e.includes('IMPORT') ? 'import' : 'call', file: f, line, name: type.toUpperCase() === 'FILE' || type.toUpperCase() === 'DIRECTORY' ? null : name || null });
  };
  const inn = (res.data as any)?.neighbours?.in;
  if (Array.isArray(inn)) {
    for (const o of inn) if (o && typeof o.file === 'string') put(String(o.edge_type ?? 'CALLS'), String(o.type ?? ''), String(o.name ?? ''), o.file, Number(o.line) || 0);
    return [...out.values()];
  }
  const re = /^\s*in\s+←\s+(\w+)\s+←\s+(\w+)\s+(.+?)\s+@\s+(\S+?):L?(\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.text || '')) !== null) put(m[1], m[2], m[3], m[4], Number(m[5]));
  return [...out.values()];
}

/**
 * Check a plan against the graph before anyone is spawned: two slices on one file, and a changed symbol whose callers
 * sit in another slice or in none. One line per finding, slices numbered from 1. Advisory; never throws.
 */
export async function planCheck(input: { cwd: string; slices: PlanSlice[]; graphCall: DriverDeps['graphCall'] }): Promise<string> {
  try {
    const { parseDeclarations } = require('../graph/cross-worktree') as typeof import('../graph/cross-worktree');
    const slices = (Array.isArray(input.slices) ? input.slices : []).slice(0, PLAN_MAX_SLICES).map((s) => ({
      title: String(s?.title ?? ''),
      files: [...new Set((Array.isArray(s?.files) ? s.files : []).map((f) => norm(String(f))).filter(Boolean))],
      symbols: [...new Set((Array.isArray(s?.symbols) ? s.symbols : []).map((x) => String(x).trim()).filter(Boolean))],
    }));
    if (!slices.length) return 'plan check: give slices ({ title, files, symbols })';
    const lines: string[] = [];

    // Which slice edits which file.
    const owners = new Map<string, number[]>();
    slices.forEach((s, i) => s.files.forEach((f) => owners.set(f, [...(owners.get(f) ?? []), i + 1])));
    for (const [f, who] of owners) {
      if (who.length < 2) continue;
      lines.push(`slices ${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} both edit ${f}: merge them or run them in order`);
    }

    // Symbols: one neighbours call each, in parallel, capped at 40 overall.
    const jobs: { slice: number; symbol: string }[] = [];
    slices.forEach((s, i) => s.symbols.forEach((symbol) => { if (jobs.length < PLAN_MAX_SYMBOLS) jobs.push({ slice: i + 1, symbol }); }));
    type R = { text: string; data: unknown; ms?: number };
    const call = async (name: string, args: Record<string, unknown>): Promise<R | 'timeout' | 'error'> => Promise.race([
      Promise.resolve().then(() => input.graphCall(name as any, args, { cwd: input.cwd, fresh: false })).catch(() => 'error' as const),
      sleep(PLAN_CALL_MS, 'timeout' as const),
    ]);
    // neighbours resolves a near-miss name to whatever it finds ("allocat" → allocate + allocatePayment), so a symbol is
    // real only if search_code lists a declaration with exactly that name (the last segment of Class.method / Class#method).
    const results = await Promise.all(jobs.map(async (j) => {
      const [sc, nb] = await Promise.all([call('search_code', { query: j.symbol }), call('neighbours', { symbol: j.symbol, direction: 'in' })]);
      const bad = [sc, nb].find((x) => typeof x === 'string') as 'timeout' | 'error' | undefined;
      if (bad) return { j, state: bad, edges: [] as InEdge[] };
      const first = (x: R) => (x.text || '').split('\n')[0] || '';
      if (/not indexed/i.test(first(sc as R)) || /not indexed/i.test(first(nb as R))) return { j, state: 'unindexed' as const, edges: [] };
      const last = j.symbol.split(/[.#]|::/).filter(Boolean).pop() ?? j.symbol;
      const exact = parseDeclarations(sc as R).some((d) => d.name === j.symbol || d.name === last || d.name.split(/[.#]|::/).pop() === last);
      if (!exact) return { j, state: 'unknown' as const, edges: [] };
      return { j, state: 'ok' as const, edges: incomingEdges(nb as R) };
    }));

    const tests = new Map<number, Set<string>>();
    const addTest = (slice: number, f: string) => { if (!tests.has(slice)) tests.set(slice, new Set()); tests.get(slice)!.add(f); };
    slices.forEach((s, i) => s.files.forEach((f) => { if (TEST_FILE_RE.test(f)) addTest(i + 1, f); }));
    let noCallers = 0;
    let findings = lines.length; // file overlaps so far
    const finding = (l: string) => { lines.push(l); findings++; };
    for (const { j, state, edges } of results) {
      if (state === 'timeout') { finding(`could not check ${j.symbol} (graph timeout)`); continue; }
      if (state === 'error') { finding(`could not check ${j.symbol} (graph error)`); continue; }
      if (state === 'unindexed') { finding(`could not check ${j.symbol} (repo not indexed)`); continue; }
      if (state === 'unknown') { finding(`not in the graph: ${j.symbol} (new, or a typo?)`); continue; }
      const crossSeen = new Set<string>();
      const uncovered: string[] = [];
      const importers = new Set<string>();
      let callers = 0;
      for (const e of edges) {
        if (e.kind === 'import') { if (TEST_FILE_RE.test(e.file)) addTest(j.slice, e.file); else importers.add(e.file); continue; }
        callers++;
        if (TEST_FILE_RE.test(e.file) && !owners.has(e.file)) { addTest(j.slice, e.file); continue; }
        const mine = owners.get(e.file) ?? [];
        if (mine.includes(j.slice)) continue;
        if (mine.length) {
          for (const n of mine) if (!crossSeen.has(String(n))) { crossSeen.add(String(n)); finding(`slice ${n} edits a caller of ${j.symbol} (slice ${j.slice}): run ${j.slice} first or give ${n} the new signature`); }
        } else {
          uncovered.push(`uncovered caller: ${e.name ? `${e.name} @ ` : ''}${e.file}:${e.line} calls ${j.symbol} (slice ${j.slice}): add it to a slice or keep the signature`);
        }
      }
      for (const u of uncovered.slice(0, PLAN_UNCOVERED_PER_SYMBOL)) finding(u);
      if (uncovered.length > PLAN_UNCOVERED_PER_SYMBOL) finding(`+${uncovered.length - PLAN_UNCOVERED_PER_SYMBOL} more uncovered callers of ${j.symbol}`);
      if (importers.size) lines.push(`importers of ${j.symbol}: ${[...importers].sort().slice(0, 6).join(', ')}${importers.size > 6 ? ` (+${importers.size - 6})` : ''}`);
      if (!callers) {
        noCallers++;
        lines.push(`${j.symbol} (slice ${j.slice}): no callers in the graph; calls through an instance are not tracked, so grep \`.${j.symbol.split(/[.#]|::/).pop()}(\``);
      }
    }
    for (const [slice, fs_] of [...tests].sort((a, b) => a[0] - b[0])) lines.push(`tests for slice ${slice}: ${[...fs_].sort().slice(0, 5).join(', ')}${fs_.size > 5 ? ` (+${fs_.size - 5})` : ''}`);

    if (!findings) lines.unshift(noCallers ? `plan check: no collisions found; ${noCallers} symbol(s) have no graph callers (see above)` : 'plan check: no collisions, every caller covered');
    let out = '';
    for (const l of lines) { if (out.length + l.length + 1 > PLAN_MAX_CHARS) { out += '…'; break; } out += (out ? '\n' : '') + l; }
    return out;
  } catch (e: any) {
    return `plan check failed: ${e?.message ?? e}`;
  }
}

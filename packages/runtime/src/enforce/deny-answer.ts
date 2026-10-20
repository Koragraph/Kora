// Answer-in-deny (SAV-A, 2026-10-15). A cold Grep / Bash rg for one code identifier is denied once and the agent is told to
// ask the graph; that costs it one more round trip, and every round trip re-sends the whole context (~100k tokens). Here the
// deny message carries the graph's answer for the identifier itself: where it is declared and who calls it. Two bounded
// reads (search_code + neighbours, in parallel), one short block. Null on anything short of an exact declaration, so the
// caller keeps today's plain redirect. Pure apart from the graph reads; every failure is a null, never a throw.
import { exactDecls, type DeclHit } from '../graph/quick-answer';
import { socketReachable } from '../graph/embedded';

/** `callTool(name, args)` -> the tool's text, or null (error / not indexed / slow). */
export type DenyGraphCall = (name: string, args: Record<string, unknown>) => Promise<string | null>;
export interface DenyCaller { name: string; file: string; line: number }

export const DENY_ANSWER_MAX_CHARS = 600;
export const DENY_ANSWER_TIMEOUT_MS = 1500;

/** In-edges of a `neighbours X --direction in` answer, minus the CONTAINS edge from the declaring file. */
export function parseCallers(text: string): DenyCaller[] {
  const out: DenyCaller[] = []; const seen = new Set<string>();
  for (const l of (text || '').split('\n')) {
    const m = /←\s*([A-Z_]+)\s*←\s+([A-Z_]+)\s+(\S+)\s+@\s+(\S+?):L(\d+)(?:\s+\(line (\d+)\))?/.exec(l);
    if (!m || m[1] === 'CONTAINS' || m[2] === 'FILE') continue;
    const line = Number(m[6] ?? m[5]); const key = `${m[3]}@${m[4]}:${line}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ name: m[3]!, file: m[4]!, line });
  }
  return out;
}

/** `src/a.js: foo:12, bar:30` per file, in first-seen order, as many as fit `room` chars; returns the lines and how many callers were left out. */
function callerLines(callers: DenyCaller[], room: number): { lines: string[]; left: number } {
  const byFile = new Map<string, string[]>();
  for (const c of callers) { const l = byFile.get(c.file) ?? []; l.push(`${c.name}:${c.line}`); byFile.set(c.file, l); }
  const lines: string[] = []; let used = 0; let shown = 0;
  for (const [file, names] of byFile) {
    let line = `    ${file}: ${names.join(', ')}`;
    if (used + line.length + 1 > room) {
      // squeeze what fits of this file's callers before giving up
      const keep: string[] = []; let w = `    ${file}: `.length;
      for (const n of names) { if (used + w + n.length + 2 > room) break; keep.push(n); w += n.length + 2; }
      if (!keep.length) break;
      line = `    ${file}: ${keep.join(', ')}`; shown += keep.length; lines.push(line); used += line.length + 1; break;
    }
    lines.push(line); used += line.length + 1; shown += names.length;
  }
  return { lines, left: callers.length - shown };
}

/** The deny text: the declaration(s), the callers grouped by file, how to read the range. Tight enough to stay near DENY_ANSWER_MAX_CHARS. */
export function renderDenyAnswer(ident: string, decls: DeclHit[], callers: DenyCaller[]): string {
  const shown = decls.slice(0, 3);
  const lines = [`kora: \`${ident}\` is a code identifier and this repo has a code graph, which already answers this search (resolved, no need to grep):`];
  for (const d of shown) lines.push(`  ${d.kind} ${ident} — ${d.file}:${d.line}`);
  if (decls.length > shown.length) lines.push(`  (+${decls.length - shown.length} more declaration(s))`);
  let left = 0;
  if (callers.length) {
    const head = lines.join('\n').length;
    const c = callerLines(callers, Math.max(120, DENY_ANSWER_MAX_CHARS - head - 40));
    left = c.left;
    lines.push(`  called from ${callers.length} place(s):`, ...c.lines);
    if (left > 0) lines.push(`    (+${left} more: \`kora graph neighbours ${ident} --direction in\` lists them all)`);
  } else lines.push('  callers: none found in the graph');
  const d0 = shown[0]!;
  lines.push(`Read the range with offset/limit (e.g. ${d0.file} from line ${Math.max(1, d0.line - 2)}) instead of re-searching. Searches for TEXT (strings, config keys, logs) are never blocked.`);
  return lines.join('\n');
}

/**
 * The graph's answer for `ident`, or null (no exact declaration, graph slow or down). `call` is the graph transport (the
 * pane's daemon or an in-process service); the whole thing is bounded by `timeoutMs` and fails open to null.
 */
export async function denyAnswerFor(ident: string, call: DenyGraphCall, opts: { timeoutMs?: number } = {}): Promise<string | null> {
  const budget = opts.timeoutMs ?? DENY_ANSWER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<string | null> => {
    const [loc, nb] = await Promise.all([
      call('search_code', { query: ident }).catch(() => null),
      call('neighbours', { symbol: ident, direction: 'in' }).catch(() => null),
    ]);
    const decls = exactDecls(loc ?? '', ident);
    if (!decls.length) return null;
    // neighbours on a name declared in several places merges them; its callers are still the right hint, but only when it answered at all.
    const callers = nb && !/NO DECLARATION NAMED|not indexed/i.test((nb.split('\n')[0] ?? '')) ? parseCallers(nb) : [];
    return renderDenyAnswer(ident, decls, callers);
  })();
  const deadline = new Promise<null>((res) => { timer = setTimeout(() => res(null), budget); timer.unref?.(); });
  try { return await Promise.race([work, deadline]); } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

let testTransport: DenyGraphCall | null = null;
/** Tests: replace the graph transport (null restores it). */
export function setDenyGraphForTests(call: DenyGraphCall | null): void { testTransport = call; }

/**
 * The graph transport of a hook process: the daemon when this is a pane with a reachable socket (its warm service), else an
 * in-process read-only service. Same choice `kora hook` makes for a Read outline. One call = one bounded read; null on any failure.
 */
export function hookGraphCall(cwd: string, budgetMs: number = DENY_ANSWER_TIMEOUT_MS): DenyGraphCall {
  if (testTransport) return testTransport;
  return async (name, args) => {
    try {
      const paneId = process.env.KORA_PANE_ID;
      if (paneId && socketReachable()) {
        const { callOnce } = require('../protocol/client') as typeof import('../protocol/client');
        const r = await callOnce('graph.tool', { name, args, cwd, paneId, channel: 'hook', fresh: false }, undefined, budgetMs) as { text?: unknown } | null;
        return r?.text ? String(r.text) : null;
      }
      const { createGraphService } = require('../graph/index') as typeof import('../graph/index');
      const r = await createGraphService().callTool(name as never, args, { cwd, fresh: false } as never);
      return r?.text ? String(r.text) : null;
    } catch { return null; }
  };
}

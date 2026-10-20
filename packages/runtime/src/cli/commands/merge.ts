import type { IO } from '../main';
import { spawnSync } from 'node:child_process';
import { isSafeGitRef } from '../../util/safe-path';

export const summary = 'Graph-verified merge: catch cross-diff semantic conflicts git merges clean';
export const usage = `Usage: kora merge check <refA> <refB> [<refC> …] [--into <branch>] [--base <ref>] [--json]
       kora merge plan  <refA> <refB> [<refC> …] [--into <branch>] [--base <ref>] [--json]
       kora merge do    <refA> <refB> [<refC> …] [--into <branch>] [--base <ref>] [--yes]

refs are branch names, commit SHAs, or on-disk worktree paths. Each ref is diffed from its own merge-base with the
branch it will be merged into (--into, default: the current HEAD), so an already-merged ref shows nothing.
--base <ref> overrides that with one explicit base for every ref.

check  runs the semantic gate and prints each pair ✓ clean / ■ semantic / ? needs-human with blame.
plan   prints a suggested merge order (fewest conflicts + smallest blast radius first).
do     runs check; merges the refs in order into the current branch (or --into). Stops on any ■ semantic
       pair unless --yes, which merges only the clean pairs and reports the rest.

Exit codes (the CI contract):  0 all clean · 3 a semantic conflict · 4 needs-human (and no semantic).

Git tells you two diffs touch the same LINES. Only the code graph can tell you branch A rewrote a symbol whose
callers live in a file branch B changed — git merges both hunks clean and the composition is broken. That is what
this catches.`;

interface Pair { a: string; b: string; status: 'clean' | 'semantic' | 'needs-human'; reason?: string; blame?: { file: string; line: number; symbol: string; byWorker: string; kind?: 'dependent' | 'reference'; inHunk?: boolean; removed?: boolean }[] }
interface Report { pairs: Pair[]; order: string[]; base: string; refs: string[] }

const GLYPH = { clean: '✓', semantic: '■', 'needs-human': '?' } as const;

function render(io: IO, r: Report) {
  io.out(`base ${r.base ? r.base.slice(0, 12) : '(unknown)'}   refs: ${r.refs.join(', ')}\n`);
  for (const p of r.pairs) {
    io.out(`  ${GLYPH[p.status]} ${p.a} × ${p.b}  ${p.status}${p.reason ? `  — ${p.reason}` : ''}\n`);
    for (const b of p.blame ?? []) io.out(`      ${b.file}:${b.line}  ${b.symbol}  (${b.removed ? 'removed' : 'changed'} by ${b.byWorker}${b.kind === 'reference' ? ', new reference' : ''}${b.inHunk ? ', edited line' : ''})\n`);
  }
  const bad = r.pairs.filter((p) => p.status !== 'clean').length;
  io.out(bad ? `\n${bad} pair(s) need attention.\n` : `\nall clear — no cross-diff semantic conflicts.\n`);
}

function exitFor(r: Report): number {
  if (r.pairs.some((p) => p.status === 'semantic')) return 3;
  if (r.pairs.some((p) => p.status === 'needs-human')) return 4;
  return 0;
}

export async function run(argv: string[], io: IO): Promise<number> {
  const { callOnce } = require('../../protocol/client');
  const verb = argv[0];
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const flagVals = new Set(['--base', '--into']);
  // ref collection: everything after the verb that is not a flag and not a flag's value
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { if (flagVals.has(a)) i++; continue; } positional.push(a); }

  if (!verb || !['check', 'plan', 'do'].includes(verb) || positional.length < 2) { io.err(usage + '\n'); return 2; }
  // Every ref ends up as a git positional (checkout / merge): one starting with `-` would be an option.
  for (const r of [...positional, get('--base'), get('--into')]) {
    if (r !== undefined && !isSafeGitRef(r)) { io.err(`kora merge: not a plain git ref: ${JSON.stringify(r)}\n`); return 2; }
  }

  let report: Report;
  try {
    report = await callOnce('merge.verify', { cwd: process.cwd(), refs: positional, baseRef: get('--base'), targetRef: get('--base') ? undefined : (get('--into') || 'HEAD') });
  } catch (e: any) { io.err(`kora merge: ${e.message}\n`); return 1; }

  if (flags.has('--json')) { io.out(JSON.stringify(report, null, 2) + '\n'); return exitFor(report); }

  if (verb === 'plan') {
    io.out(`merge order: ${report.order.join(' → ')}\n`);
    render(io, report);
    return 0;
  }

  if (verb === 'check') { render(io, report); return exitFor(report); }

  // do
  render(io, report);
  const code = exitFor(report);
  if (code === 3 && !flags.has('--yes')) { io.err(`\nrefusing to merge: semantic conflict(s) present. Re-run with --yes to merge only the clean pairs.\n`); return 3; }
  // Merge in the computed order, skipping refs that participate in a semantic pair when --yes was needed.
  const semanticRefs = new Set<string>();
  for (const p of report.pairs) if (p.status === 'semantic') { semanticRefs.add(p.a); semanticRefs.add(p.b); }
  const code2 = mergeRefsInOrder(process.cwd(), report.order, semanticRefs, io, get('--into'));
  return code2 !== 0 ? code2 : semanticRefs.size ? 3 : 0;
}

/** `kora merge do`'s git merges, under the same cross-process lock as kora_merge: a daemon merging a worker into this
 *  checkout at the same moment failed on git's index.lock (test/fleet 2026-10-14). */
export function mergeRefsInOrder(cwd: string, order: string[], skip: Set<string>, io: Pick<IO, 'out' | 'err'>, into?: string, maxWaitMs?: number): number {
  const { withMergeLock } = require('../../server/worktree') as typeof import('../../server/worktree');
  const r = withMergeLock(cwd, () => {
    if (into) { const co = spawnSync('git', ['checkout', into, '--'], { cwd, encoding: 'utf8' }); if (co.status !== 0) { io.err(`kora merge: cannot checkout ${into}: ${co.stderr}\n`); return 1; } }
    let merged = 0;
    for (const ref of order) {
      if (skip.has(ref)) { io.out(`  skip ${ref} (in a semantic pair)\n`); continue; }
      if (!isSafeGitRef(ref)) { io.err(`  ✗ ${ref}: not a plain git ref — skipped\n`); return 1; }
      const m = spawnSync('git', ['merge', '--no-edit', ref], { cwd, encoding: 'utf8' });
      if (m.status !== 0) { io.err(`  ✗ ${ref}: ${(m.stderr || m.stdout || '').split('\n')[0]}\n     (git-level conflict — resolve, then re-run)\n`); return 1; }
      io.out(`  ✓ merged ${ref}\n`); merged++;
    }
    io.out(`\n${merged} ref(s) merged.\n`);
    return 0;
  }, maxWaitMs);
  if (r === null) { io.err('kora merge: Kora is merging into this checkout right now; try again in a moment\n'); return 1; }
  return r;
}

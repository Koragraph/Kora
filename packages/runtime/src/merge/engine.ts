// The graph-verified merge ENGINE — the front-end-neutral core shared by `kora merge`, `kora pr`, and the
// orchestrator's `worktree.mergeVerify`. It turns arbitrary git refs (branch names, SHAs, worktree paths, PR heads)
// into diffable trees, resolves the base they should be compared against (their merge-base), computes each ref's
// changed files vs that base, and hands the set to the pure cross-diff semantic gate (`crossWorktreeConflicts`).
//
// It owns exactly two things the gate does not: (1) materializing a ref into a throwaway detached worktree so its
// tree can be diffed and its files fed to koragraph, and (2) picking the base. Everything semantic — resolving a
// changed symbol to its dependents and flagging a dependent inside another ref's diff — stays in the gate. Refs in,
// verdict out; no pane ids, no fleet, no GitHub knowledge here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MergePair } from '../protocol/types';
import { crossWorktreeConflicts, type GraphLike, type WorktreeInput } from '../graph/cross-worktree';
import { changedSinceRef } from '../graph/worktree-overlay';
import { koraHome } from '../protocol/types';
import { isSafeGitRef } from '../util/safe-path';

/** Throwaway checkouts of non-worktree refs: under KORA_HOME (an isolated daemon must never write the real ~/.kora). */
export function mergeScratchRoot(repoRoot: string): string { return path.join(koraHome(), 'merge-check', path.basename(repoRoot)); }

export type MergeRef =
  | { kind: 'branch'; name: string }
  | { kind: 'sha'; sha: string }
  | { kind: 'worktree'; path: string; label?: string } // already on disk — used in place, never removed; label = how the caller names it (a pane id)
  | { kind: 'pr'; number: number; head: string }; // pr front-end resolves head to a local ref first

export interface VerifyResult {
  pairs: MergePair[]; order: string[];
  /** The base every ref was diffed from — or, with a target, the target commit (see `bases`). */
  base: string; refs: string[];
  /** Per-ref base when a target was given: each ref's merge-base with the target. */
  bases?: Record<string, string>;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    // Hooks off: materializing a worker's commit (worktree add) must not run a post-checkout it authored. fsmonitor off:
    // a repo's .git/config naming an fsmonitor command must not get it run by a background verify.
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: r.status === 0, out: String(r.stdout || '').trim() };
  } catch { return { ok: false, out: '' }; }
}

const refLabel = (r: MergeRef): string =>
  r.kind === 'branch' ? r.name : r.kind === 'sha' ? r.sha.slice(0, 12) : r.kind === 'pr' ? `#${r.number}` : r.label || path.basename(r.path);

// The commit each ref resolves to, from the perspective of repoRoot (branches/SHAs/PR-heads live there; a worktree's
// HEAD is read in the worktree). Returns null if a ref cannot be resolved — caller turns that into an error.
function resolveCommit(repoRoot: string, r: MergeRef): string | null {
  if (r.kind === 'worktree') { const h = git(r.path, ['rev-parse', 'HEAD']); return h.ok ? h.out : null; }
  const spec = r.kind === 'branch' ? r.name : r.kind === 'pr' ? r.head : r.sha;
  const h = git(repoRoot, ['rev-parse', '--verify', `${spec}^{commit}`]);
  return h.ok ? h.out : null;
}

// The base to diff every ref against: the merge-base of all resolved commits. Two refs → `git merge-base A B`;
// N refs → `git merge-base --octopus …` (falls back to the pairwise-reduced base if octopus is unavailable).
function computeBase(repoRoot: string, commits: string[]): string | null {
  if (commits.length < 2) return commits[0] ?? null;
  const oct = git(repoRoot, ['merge-base', '--octopus', ...commits]);
  if (oct.ok && oct.out) return oct.out.split('\n')[0].trim();
  let acc = commits[0];
  for (let i = 1; i < commits.length; i++) {
    const mb = git(repoRoot, ['merge-base', acc, commits[i]]);
    if (!mb.ok || !mb.out) return null;
    acc = mb.out.split('\n')[0].trim();
  }
  return acc;
}

/**
 * Verify a set of refs for cross-diff semantic conflicts. Materializes each non-worktree ref into a throwaway
 * detached worktree, diffs it against the shared base, and runs the pure gate. Throwaway worktrees are always
 * cleaned up (even on error); `worktree`-kind refs are used in place and never removed.
 */
export async function verifyMerge(
  repoRoot: string,
  refs: MergeRef[],
  graph: GraphLike,
  opts?: { baseRef?: string; targetRef?: string },
): Promise<VerifyResult> {
  // Refs arrive from the CLI, a PR head or a lead's tool call; one that starts with `-` would be a git OPTION.
  for (const r of refs) {
    const spec = r.kind === 'branch' ? r.name : r.kind === 'pr' ? r.head : r.kind === 'sha' ? r.sha : null;
    if (spec !== null && !isSafeGitRef(spec)) throw new Error(`refusing ref ${JSON.stringify(String(spec)).slice(0, 80)}: not a plain git ref`);
  }
  for (const [k, v] of [['base', opts?.baseRef], ['target', opts?.targetRef]] as const) {
    if (v !== undefined && v !== null && v !== '' && !isSafeGitRef(v)) throw new Error(`refusing ${k} ref ${JSON.stringify(String(v)).slice(0, 80)}: not a plain git ref`);
  }
  const labels = refs.map(refLabel);
  if (refs.length < 2) return { pairs: [], order: labels, base: opts?.baseRef ?? '', refs: labels };

  const commits: string[] = [];
  for (const r of refs) {
    const c = resolveCommit(repoRoot, r);
    if (!c) throw new Error(`cannot resolve ref: ${refLabel(r)}`);
    commits.push(c);
  }

  // Which commit each ref is diffed FROM:
  //   --base <ref>      one explicit base for all;
  //   target given      each ref's own merge-base with the target it will be merged into — so a ref already merged
  //                     shows nothing, and a ref forked after another one landed is not blamed for that one's work;
  //   neither           the refs' common merge-base (their fork point) — "how do these refs relate to each other".
  let base = '';
  const bases: string[] = [];
  if (opts?.baseRef) {
    base = git(repoRoot, ['rev-parse', '--verify', `${opts.baseRef}^{commit}`]).out || opts.baseRef;
    for (const _ of commits) bases.push(base);
  } else if (opts?.targetRef) {
    const target = git(repoRoot, ['rev-parse', '--verify', `${opts.targetRef}^{commit}`]).out;
    if (!target) throw new Error(`cannot resolve target ref: ${opts.targetRef}`);
    for (let i = 0; i < commits.length; i++) {
      const mb = git(repoRoot, ['merge-base', target, commits[i]]);
      if (!mb.ok || !mb.out) throw new Error(`${labels[i]} shares no history with ${opts.targetRef}`);
      bases.push(mb.out.split('\n')[0].trim());
    }
    base = target;
  } else {
    base = computeBase(repoRoot, commits) ?? '';
    for (const _ of commits) bases.push(base);
  }
  if (!base) throw new Error('cannot compute a common merge-base for the given refs');

  const scratchRoot = mergeScratchRoot(repoRoot);
  const throwaway: string[] = [];
  try {
    const workers: WorktreeInput[] = [];
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      let treePath: string;
      if (r.kind === 'worktree') {
        treePath = r.path;
      } else {
        fs.mkdirSync(scratchRoot, { recursive: true });
        treePath = path.join(scratchRoot, `${Date.now().toString(36)}-${i}-${labels[i].replace(/[^\w.-]+/g, '_')}`);
        const add = git(repoRoot, ['worktree', 'add', '--detach', '--force', treePath, commits[i]]);
        if (!add.ok) throw new Error(`failed to materialize ${labels[i]} as a worktree`);
        throwaway.push(treePath);
      }
      const div = changedSinceRef(treePath, bases[i]);
      workers.push({ paneId: labels[i], path: treePath, indexedSha: bases[i], base: bases[i], changed: div.changed, truncated: div.truncated });
    }
    const { pairs, order } = await crossWorktreeConflicts(workers, graph);
    const perRef: Record<string, string> = {}; labels.forEach((l, i) => { perRef[l] = bases[i]; });
    return { pairs, order, base, refs: labels, ...(opts?.targetRef ? { bases: perRef } : {}) };
  } finally {
    for (const p of throwaway) { git(repoRoot, ['worktree', 'remove', '--force', p]); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
    git(repoRoot, ['worktree', 'prune']);
  }
}

// Map a verdict to the CLI/CI exit code contract, shared by `kora merge` and `kora pr`:
//   0 = all clean · 3 = at least one semantic conflict · 4 = at least one needs-human (and no semantic).
export function exitCodeFor(pairs: MergePair[]): 0 | 3 | 4 {
  if (pairs.some((p) => p.status === 'semantic')) return 3;
  if (pairs.some((p) => p.status === 'needs-human')) return 4;
  return 0;
}

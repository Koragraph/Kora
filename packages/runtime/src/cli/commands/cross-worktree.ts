// Internal: run the graph-verified merge gate in a CHILD PROCESS. The gate is CPU-bound and synchronous underneath
// (git diffs via spawnSync + sqlite graph queries — measured ~60 s on a fresh repo); run in the daemon's own event
// loop it stalled every websocket ping and dropped all clients. The Runtime spawns `kora cross-worktree` with the
// job as JSON on stdin and reads the verdict from stdout. Two job shapes:
//   { repoRoot, refs: MergeRef[], baseRef?, targetRef? }   → merge/engine.verifyMerge (fleet worktrees, branches, PRs)
//   { workers: WorktreeInput[] }                           → the bare gate (legacy fleet shape; no engine, no base logic)
import type { IO } from '../main';

export const summary = 'Internal: graph-verified merge gate worker (JSON stdin → JSON stdout)';
export const usage = `kora cross-worktree   (stdin: {"repoRoot","refs":[…],"targetRef"?} or {"workers":[…]})`;

export async function run(_argv: string[], io: IO): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  let job: any;
  try { job = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch (e: any) { io.err(`cross-worktree: bad stdin JSON: ${e?.message ?? e}\n`); return 2; }
  const { createGraphService } = require('../../graph');
  const svc = createGraphService();
  try {
    if (Array.isArray(job.refs) && job.repoRoot) {
      const { verifyMerge } = require('../../merge/engine');
      const result = await verifyMerge(String(job.repoRoot), job.refs, svc, { baseRef: job.baseRef, targetRef: job.targetRef });
      io.out(JSON.stringify(result));
      return 0;
    }
    const { crossWorktreeConflicts } = require('../../graph/cross-worktree');
    const result = await crossWorktreeConflicts(job.workers ?? [], svc);
    io.out(JSON.stringify(result));
    return 0;
  } catch (e: any) {
    io.err(`cross-worktree: ${e?.message ?? e}\n`);
    return 1;
  }
}

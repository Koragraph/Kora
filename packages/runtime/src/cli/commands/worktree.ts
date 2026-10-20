import type { IO } from '../main';
export const summary = 'Per-agent git worktrees: list, merge an agent\'s work into the main checkout, remove';
export const usage = `Usage: kora worktree list [--cwd <path>] [--json]
       kora worktree merge <paneId|path> [--into <branch>] [--no-commit]
       kora worktree remove <paneId|path> [--force] [--delete-branch]
       kora worktree sweep [--dry-run] [--json]   orphan sweep: clean+unowned removed, dirty/ahead reported, dead-parent parked

merge commits the agent's uncommitted work first by default (its own files, never kora's rulebook/hooks), the
same as ctrl+b m in the runtime. Pass --no-commit to merge only what the agent already committed.

Every \`kora agent spawn\` gets its own worktree under ~/.kora/worktrees/<repo>/<slug> on branch kora/<slug>
(unless --no-worktree, or the repo has no commits). Agents never collide; the graph is shared with the main checkout.
merge refuses when the main checkout is dirty and aborts cleanly on conflicts, listing the files.`;
export async function run(argv: string[], io: IO): Promise<number> {
  const { callOnce } = require('../../protocol/client');
  const [verb, target] = argv; const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const isPane = (t?: string) => !!t && /^p\d+$/.test(t);
  try {
    if (!verb || verb === 'list') {
      const r = await callOnce('worktree.list', { cwd: get('--cwd') || process.cwd() });
      if (flags.has('--json')) { io.out(JSON.stringify(r, null, 2) + '\n'); return 0; }
      if (!r.worktrees.length) { io.out('no kora worktrees\n'); return 0; }
      for (const w of r.worktrees) io.out(`${(w.paneId ?? '-').padEnd(4)} ${w.branch.padEnd(28)} ${w.head ?? '-'}  +${w.ahead} commits  ${w.dirty ? `${w.dirty} dirty` : 'clean'}  ${w.path}\n`);
      return 0;
    }
    if (verb === 'merge') {
      if (!target) { io.err(usage + '\n'); return 2; }
      const r = await callOnce('worktree.merge', { ...(isPane(target) ? { paneId: target } : { path: target }), into: get('--into'), commitFirst: !flags.has('--no-commit') });
      io.out(`${r.ok ? '✓' : '✗'} ${r.message}${r.merged ? ` (${r.merged} → ${r.into})` : ''}${r.conflicts.length ? '\n  conflicts: ' + r.conflicts.join(', ') : ''}\n`);
      return r.ok ? 0 : 1;
    }
    if (verb === 'remove') {
      if (!target) { io.err(usage + '\n'); return 2; }
      const r = await callOnce('worktree.remove', { ...(isPane(target) ? { paneId: target } : { path: target }), force: flags.has('--force'), deleteBranch: flags.has('--delete-branch') });
      io.out(`${r.ok ? '✓' : '✗'} ${r.message}\n`); return r.ok ? 0 : 1;
    }
    if (verb === 'sweep') {
      const r = await callOnce('worktree.sweep', { dryRun: flags.has('--dry-run') });
      if (flags.has('--json')) { io.out(JSON.stringify(r, null, 2) + '\n'); return 0; }
      io.out(`${r.scanned} scanned · ${r.removed.length} removed · ${r.orphans.length} orphan(s) kept · ${r.parked.length} parked (main checkout gone) · ${r.busy.length} busy · ${r.errors.length} error(s)${flags.has('--dry-run') ? '  (dry run)' : ''}\n`);
      for (const o of r.orphans) io.out(`  orphan  ${(o.branch ?? '-').padEnd(28)} ${o.dirty} dirty, +${o.ahead} commits  ${o.path}\n`);
      for (const x of r.parked) io.out(`  parked  ${x}\n`);
      if (r.reclaimedBytes) io.out(`  reclaimed ${(r.reclaimedBytes / 1024 / 1024).toFixed(1)} MB\n`);
      for (const b of r.branchesDeleted ?? []) io.out(`  branch  ${b}  deleted (already merged)\n`);
      for (const b of r.branchesKept ?? []) io.out(`  branch  ${b.branch}  kept: ${b.ahead < 0 ? 'unknown' : `+${b.ahead}`} commit(s) not in HEAD  (${b.root})\n`);
      for (const e of r.errors) io.out(`  error   ${e.path}: ${e.message}\n`);
      return r.errors.length ? 1 : 0;
    }
    io.err(usage + '\n'); return 2;
  } catch (e: any) { io.err(`kora worktree: ${e.message}\n`); return 1; }
}

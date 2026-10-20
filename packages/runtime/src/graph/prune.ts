// `kora graph prune` — the store's garbage collector, on demand. The same passes an ingest runs once a day
// (koragraph/src/services/store-hygiene.js), but immediate and reportable:
//   · repositories whose checkout is gone (folder renamed / moved / deleted, or emptied): removed after --grace-days
//     (default 7; the first run only NOTES them, so an unplugged disk never costs an index), or now with --now;
//   · ARCHIVED nodes (soft-deleted declarations) older than --archived-days (default 14);
//   · --vacuum rewrites the file to give the space back (needs the daemon and every other reader stopped).
import fs from 'node:fs';
import path from 'node:path';
import { kg, graphDbPath } from './embedded';
import { withStoreMaintenance } from './store-maintenance';

export interface PruneOptions { dryRun?: boolean; now?: boolean; graceDays?: number; archivedDays?: number; vacuum?: boolean }
export interface PruneReport {
  pruned: { id: number; name: string; path: string; nodes: number; reason: string }[];
  pending: { id: number; name: string; path: string; nodes: number; reason: string; daysLeft: number }[];
  archivedDeleted: number; sizeBefore: number; sizeAfter: number; vacuumed: boolean;
}

export async function pruneStore(opts: PruneOptions = {}): Promise<PruneReport> {
  const pool = kg('src/db/pool.js');
  try { pool.db.pragma('busy_timeout = 120000'); } catch { /* fine */ }
  const hyg = kg('src/services/store-hygiene.js');
  const file = graphDbPath();
  const size = () => { try { return fs.statSync(file).size; } catch { return 0; } };
  const sizeBefore = size();
  const graceHours = opts.now ? 0 : (opts.graceDays ?? hyg.PRUNE_GRACE_HOURS / 24) * 24;
  const { pruned, pending } = await hyg.pruneMissingRepos(pool, { graceHours, dryRun: !!opts.dryRun });
  let archivedDeleted = 0;
  if (opts.dryRun) {
    const days = opts.archivedDays ?? hyg.ARCHIVE_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    archivedDeleted = Number(pool.db.prepare("SELECT count(*) AS n FROM nodes WHERE approval_status = 'ARCHIVED' AND last_updated_at < ?").get(cutoff).n);
  } else {
    archivedDeleted = await hyg.gcArchivedNodes(pool, { days: opts.archivedDays ?? hyg.ARCHIVE_RETENTION_DAYS });
    await hyg.cleanOrphans(pool);
    if (pruned.length || archivedDeleted) { try { pool.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('optimize')"); } catch { /* fine */ } }
  }
  let vacuumed = false;
  if (opts.vacuum && !opts.dryRun) {
    // On Windows the readers are asked to close first and a refusal is retried (store-maintenance.ts); elsewhere one try.
    try { await withStoreMaintenance('vacuum', () => { pool.db.pragma('wal_checkpoint(TRUNCATE)'); pool.db.exec('VACUUM'); }, { announce: 'first' }, file); vacuumed = true; } catch { /* readers hold it */ }
  }
  const sizeAfter = size();
  try { await pool.end(); } catch { /* fine */ }
  return { pruned, pending, archivedDeleted, sizeBefore, sizeAfter, vacuumed };
}

export function formatPrune(r: PruneReport, dryRun: boolean): string {
  const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
  const L: string[] = [];
  const WHY = (reason: string) => reason === 'emptied' ? 'no longer that repo' : reason === 'holds-checkouts' ? 'a folder of checkouts, indexed only for its loose files' : 'gone';
  for (const p of r.pruned) L.push(`${dryRun ? 'would remove' : 'removed'}  ${p.name}  (${p.nodes.toLocaleString()} nodes; ${p.path} is ${WHY(p.reason)})`);
  for (const p of r.pending) L.push(`missing      ${p.name}  (${p.nodes.toLocaleString()} nodes; ${p.path} is ${WHY(p.reason)}) — ${dryRun ? 'would be' : 'will be'} removed in ${p.daysLeft.toFixed(1)} day(s); \`kora graph prune --now\` to do it now`);
  L.push(`${dryRun ? 'would collect' : 'collected'}   ${r.archivedDeleted.toLocaleString()} old archived node(s)`);
  if (!dryRun) L.push(`store        ${path.basename(graphDbPath())}: ${mb(r.sizeBefore)} → ${mb(r.sizeAfter)}${r.vacuumed ? '' : (r.pruned.length || r.archivedDeleted ? ' (file shrinks after `kora graph prune --vacuum` with the daemon stopped)' : '')}`);
  return L.join('\n') + '\n';
}

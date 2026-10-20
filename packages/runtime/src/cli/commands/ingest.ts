// `kora ingest <path> [--project P]` — alias of `graph ingest` (waits, prints koragraph's counts).
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str } from '../args';
import { createGraphService } from '../../graph/index';
import { KG_ROOT } from '../../graph/embedded';

export const summary = 'Index a repository into the embedded graph';
export const usage = `Usage: kora ingest [<path>] [--project <name>] [--no-wait] [--full] [--force]

Indexes the repository at <path> (default: the current git checkout). A repository already in the
graph is re-indexed incrementally. Progress goes to stderr; the summary line
(project/repo branch  nodes  edges) to stdout. --no-wait runs it detached (log: ~/.kora/ingest.log).
--full re-extracts every file even when the repository is already indexed at HEAD.
A home folder, the filesystem root, a parent of home or a too-shallow path (/tmp) is refused unless --force.`;

export async function run(argv: string[], io: IO): Promise<number> {
  const { flags, positional } = parseArgs(argv, ['project']);
  if (flags.help) { io.out(usage + '\n'); return 0; }
  const target = path.resolve(positional[0] || process.cwd());
  const graph = createGraphService();
  const wait = flags.wait !== false;
  const refusal = await (require('../../graph/index-consent') as typeof import('../../graph/index-consent')).agentFirstIndexRefusal(graph, target);
  if (refusal) { io.err(`kora ingest: ${refusal}\n`); return 2; }
  let r: { nodes?: number; edges?: number };
  try { r = await graph.ingest(target, { project: str(flags.project), wait, full: flags.full === true, force: flags.force === true, io } as any); }
  catch (e: any) { if (e?.code === 'unsafe_root') { io.err(`kora ingest: ${e.message}\n`); return 2; } throw e; }
  if (!wait) { io.out(`ingest started in the background for ${target} (log: ~/.kora/ingest.log)\n`); return 0; }
  const { ingestRoot } = require('../../graph/service');
  if (r.nodes != null) io.err(`Indexed ${ingestRoot(target).root}: ${r.nodes} nodes, ${r.edges} edges.\n`);
  // Close the store handle so a WAL database leaves no -wal/-shm behind (koragraph's own CLI does the same).
  try { const p = path.join(KG_ROOT, 'src', 'db', 'pool.js'); if (require.cache[require.resolve(p)]) await require(p).end().catch(() => {}); } catch { /* fine */ }
  return 0;
}

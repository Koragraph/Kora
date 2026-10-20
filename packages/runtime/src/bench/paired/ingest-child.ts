// Child process of the Kora arm: index one repository into the (isolated) graph store, then exit.
// Run as `node --liftoff-only ingest-child.js <repo>` (wasm grammars need the flag; see CLAUDE.md "Wasm grammars").
// This calls the graph service directly, not `kora ingest`: the CLI refuses a first index from an agent process, and
// this is the benchmark harness, an explicit act of its operator.
import { createGraphService } from '../../graph/index';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error('usage: ingest-child <repo>');
  const graph = createGraphService();
  const r = await graph.ingest(target, { wait: true, force: true });
  let indexed: boolean | null = null;
  try { indexed = !!(await graph.status(target, { nocache: true })).indexed; } catch { /* status is advisory */ }
  process.stdout.write(JSON.stringify({ ok: r.ok, nodes: r.nodes ?? null, edges: r.edges ?? null, indexed }) + '\n');
}

main().then(() => process.exit(0), (e) => { process.stderr.write(`ingest failed: ${e && e.message ? e.message : e}\n`); process.exit(1); });

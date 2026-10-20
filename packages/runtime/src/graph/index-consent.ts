// "Never index on open" (the user's rule, 2026-10-12): the FIRST index of a repository is started only by the user
// (the graph chip's Index, or `kora ingest` typed in a terminal). An agent Kora runs may re-index a repository the user
// already indexed (stale, interrupted), but it may not start one: graph error texts used to tell agents to run
// `kora ingest <root>`, and an agent that did indexed folders the user never chose (deep audit 2026-10-13 A2-3).
import { isAgentOrigin } from '../server/control-auth';

interface StatusLike { indexed: boolean; incomplete?: boolean; firstIndexRunning?: boolean; staleForCheckout?: boolean; nodes?: number }

/** Why this process may not index `target`, or null. Only agent processes are ever refused. */
export async function agentFirstIndexRefusal(graph: { status(cwd: string, o?: { nocache?: boolean }): Promise<StatusLike> }, target: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!isAgentOrigin(env)) return null;
  let st: StatusLike | null = null;
  try { st = await graph.status(target, { nocache: true }); } catch { st = null; }
  if (st && (st.indexed || st.incomplete || st.firstIndexRunning || st.staleForCheckout || (st.nodes ?? 0) > 0)) return null;
  return `${target} is not indexed, and only the user starts a first index (Index on the graph chip beside the project name). Do not index it yourself: use grep, glob and Read.`;
}

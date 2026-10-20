/** Summarize observed states without treating idle or missing agents as completed. */

import {
  type RuntimeSubagent,
  isTerminalSubagentStatus,
  isActiveSubagentStatus,
} from "@kora/client-runtime/store/subagentRuntime";

type SpawnedAgent = Pick<RuntimeSubagent, "status" | "kind">;

function countWhere(agents: ReadonlyArray<SpawnedAgent>, test: (agent: SpawnedAgent) => boolean) {
  let total = 0;
  for (const agent of agents) {
    if (test(agent)) total += 1;
  }
  return total;
}

function describeSubjects(individuals: number, batches: number): string {
  const parts: string[] = [];
  if (individuals > 0) {
    parts.push(`${individuals} subagent${individuals === 1 ? "" : "s"}`);
  }
  if (batches > 0) {
    const qualifier = individuals > 0 ? "" : "subagent ";
    parts.push(`${batches} ${qualifier}batch${batches === 1 ? "" : "es"}`);
  }
  return parts.join(" and ");
}

export function deriveAgentSpawnSummary(input: {
  agents: ReadonlyArray<SpawnedAgent>;
  coordinatorStatus?: RuntimeSubagent["status"] | undefined;
  agentCount: number;
}) {
  const { agents, coordinatorStatus, agentCount } = input;
  const working = countWhere(agents, (agent) => isActiveSubagentStatus(agent.status));
  const idle = countWhere(agents, (agent) => agent.status === "idle");
  const failed = countWhere(agents, (agent) => agent.status === "failed");
  const stopped = countWhere(
    agents,
    (agent) => agent.status === "interrupted" || agent.status === "cancelled",
  );
  const batches = countWhere(agents, (agent) => agent.kind === "subagent_batch");
  const individuals = agentCount - batches;

  // Workflow coordinators can keep running between dynamic member launches.
  const live =
    coordinatorStatus === undefined ? working > 0 : !isTerminalSubagentStatus(coordinatorStatus);

  let verb = "Ran";
  if (live) verb = "Kicked off";
  if (batches > 0) verb = "Launched";
  const lead = `${verb} ${describeSubjects(individuals, batches) || "subagents"}`;

  const coordinatorStopped =
    coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted";
  const unknown =
    coordinatorStatus !== "completed" && (agents.length === 0 || agents.length < agentCount);
  let status: string;
  if (live) {
    status = working > 0 ? `${working} working` : "working";
  } else if (coordinatorStatus === "failed") {
    status = "Workflow failed";
  } else if (coordinatorStopped) {
    status = "Workflow stopped";
  } else if (failed > 0) {
    status = `${failed} failed`;
  } else if (stopped > 0) {
    status = `${stopped} stopped`;
  } else if (idle > 0) {
    status = `${idle} idle`;
  } else {
    status = unknown ? "Status unavailable" : "✓ completed";
  }

  let tone: "working" | "failed" | "completed" | "inactive" = "inactive";
  if (live) tone = "working";
  else if (failed > 0 || coordinatorStatus === "failed") tone = "failed";
  else if (status === "✓ completed") tone = "completed";

  return { status, tone, live, lead };
}

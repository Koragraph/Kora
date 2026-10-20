import type { FleetSwarmAttempt, FleetSwarmWorker } from "@kora/contracts";
import { useEffect, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatSwarmModel } from "~/util/swarm";

export interface SwarmWorkerBadgeProps {
  readonly swarm: FleetSwarmWorker;
}

/** How long the "↻ on <model>" flash stays after a failover (ref-ui B3). */
export const SWARM_RESPAWN_FLASH_MS = 10_000;

const OUTCOME_WORD: Record<FleetSwarmAttempt["outcome"], string> = {
  running: "running",
  ok: "ok",
  "rate-limited": "rate-limited",
  "model-gone": "model gone",
  crashed: "crashed",
  "auth-failed": "key rejected",
  stalled: "too slow",
};

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The badge tooltip: the task, and every model this task ran on, oldest first. */
export function swarmAttemptsTooltip(swarm: FleetSwarmWorker): string {
  const head = `swarm task ${swarm.taskId} · ${swarm.model}`;
  if (swarm.attempts.length <= 1) return head;
  const chain = swarm.attempts
    .map((a) => `${a.model} (${a.paneId}) ${OUTCOME_WORD[a.outcome]} ${clock(a.at)}`)
    .join(" → ");
  return `${head}\n${chain}`;
}

/** The tile title badge (`zen · big-pickle`, attempts in the tooltip) plus a short "respawned" flash. */
export function SwarmWorkerBadge({ swarm }: SwarmWorkerBadgeProps) {
  const lastAt = swarm.attempts.at(-1)?.at ?? 0;
  const respawned = swarm.attempt > 1 && swarm.previousPaneIds.length > 0;
  // Derived at render; the effect only schedules the one re-render that ends the flash.
  const [, setExpired] = useState(0);
  const flash = respawned && Date.now() - lastAt < SWARM_RESPAWN_FLASH_MS;
  useEffect(() => {
    if (!flash) return;
    const ms = Math.max(0, SWARM_RESPAWN_FLASH_MS - (Date.now() - lastAt));
    const t = window.setTimeout(() => setExpired((n) => n + 1), ms);
    return () => window.clearTimeout(t);
  }, [flash, lastAt]);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<span className="fleet-badge swarm" data-swarm-task={swarm.taskId} />}
        >
          {formatSwarmModel(swarm.provider, swarm.modelLabel)}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {swarmAttemptsTooltip(swarm)}
        </TooltipPopup>
      </Tooltip>
      {flash ? (
        <span className="fleet-badge respawned">
          ↻ on {swarm.provider}/{swarm.modelLabel}
        </span>
      ) : null}
    </>
  );
}

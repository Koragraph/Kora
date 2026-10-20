import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  FileTextIcon,
  HexagonIcon,
  HourglassIcon,
  ListChecksIcon,
  PanelRightOpenIcon,
  RotateCwIcon,
  SquareIcon,
  Undo2Icon,
  WaypointsIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { humanizeIsoTimestamps } from "~/timeFormat";
import { cn } from "~/util/utils";
import {
  agentModeLabel,
  parseWorkerActivity,
  type WorkerActivityKind,
} from "~/util/workerActivity";

interface WorkerActivityRowProps {
  kind: WorkerActivityKind;
  summary: string;
  payload: Record<string, unknown> | null | undefined;
  onOpenFleet?: (() => void) | undefined;
  /** The swarm lead's name for the copy; Claude when absent. */
  lead?: string | undefined;
}

/**
 * A fleet happening in an orchestrator thread: a worker was spawned / steered / blocked /
 * finished, or the plan changed. Each row links to the fleet panel where the worker's live
 * terminal is.
 */
/** "opencode/space-bunny-free" → "space-bunny": the provider prefix and free suffix are noise in a row. */
function shortModel(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/:free$/, "").replace(/-free$/, "") || id;
}

export const WorkerActivityRow = memo(function WorkerActivityRow({
  kind,
  summary,
  payload,
  onOpenFleet,
  lead = "Claude",
}: WorkerActivityRowProps) {
  const fields = parseWorkerActivity(payload);
  let icon: ReactNode;
  let tone = "text-secondary-label";
  const readableSummary = humanizeIsoTimestamps(summary);
  let label = readableSummary;
  let detail: string | null = null;
  switch (kind) {
    case "worker.attached":
      icon = <BotIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-info";
      label = `spawned worker ${fields.paneId ?? ""}`.trim();
      detail = [fields.agent, fields.title].filter(Boolean).join(" · ") || null;
      break;
    case "worker.steered":
      icon = <WaypointsIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-warning";
      label = `you steered ${fields.paneId ?? "a worker"}`;
      detail = fields.text;
      break;
    case "worker.blocked":
      icon = <CircleAlertIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-destructive";
      label = `${fields.paneId ?? "worker"} needs attention`;
      detail = fields.blocker;
      break;
    case "worker.done":
      icon = <CheckIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-success";
      label = `${fields.paneId ?? "worker"} finished${fields.exitCode != null && fields.exitCode !== 0 ? ` (exit ${fields.exitCode})` : ""}`;
      detail = fields.title;
      break;
    case "worker.idle":
      icon = fields.problem ? (
        <CircleAlertIcon className="size-4 stroke-[1.8]" aria-hidden />
      ) : (
        <CheckIcon className="size-4 stroke-[1.8]" aria-hidden />
      );
      tone = fields.problem ? "text-destructive" : "text-secondary-label";
      label = fields.problem
        ? `${fields.paneId ?? "worker"} stopped on an error`
        : `${fields.paneId ?? "worker"} finished its turn`;
      detail = fields.problem ?? fields.title;
      break;
    case "worker.detached":
      icon = <SquareIcon className="size-4 stroke-[1.8]" aria-hidden />;
      label = readableSummary;
      break;
    case "fleet.plan":
      icon = <ListChecksIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-info";
      label = "plan updated";
      detail = fields.plan ? fields.plan.split("\n")[0]!.slice(0, 120) : null;
      break;
    case "worker.report":
      icon = <FileTextIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = fields.verifyState === "failed" ? "text-destructive" : "text-success";
      label = `${fields.paneId ?? "worker"} wrote its report`;
      detail =
        fields.verifyState === "passed"
          ? `verified${fields.verifyBounces ? ` after ${fields.verifyBounces} bounce${fields.verifyBounces === 1 ? "" : "s"}` : ""}`
          : fields.verifyState === "failed"
            ? `verification failed${fields.verifySummary ? `: ${fields.verifySummary}` : ""}`
            : fields.verifyState;
      break;
    case "worker.respawned":
      icon = <RotateCwIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-warning";
      label = "switched to another free model";
      detail =
        fields.fromModel && fields.toModel
          ? `${shortModel(fields.fromModel)} was busy or down, now ${shortModel(fields.toModel)}`
          : null;
      break;
    case "worker.rate-limited":
      icon = <HourglassIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-destructive";
      label = `${fields.paneId ?? "worker"} paused: every free model is rate-limited`;
      detail = fields.tried.length > 0 ? `tried ${fields.tried.join(", ")}` : null;
      break;
    case "worker.bounced":
      icon = <Undo2Icon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = "text-warning";
      label = `${fields.paneId ?? "worker"} failed verification — sent back`;
      detail = fields.verifySummary;
      break;
    case "agent-mode.switched":
      icon =
        fields.to === "swarm" ? (
          <HexagonIcon className="size-4 stroke-[1.8]" aria-hidden />
        ) : (
          <WaypointsIcon className="size-4 stroke-[1.8]" aria-hidden />
        );
      tone = "text-info";
      label = `switched to ${agentModeLabel(fields.to)}`;
      detail = fields.from ? `from ${agentModeLabel(fields.from)}` : null;
      break;
    case "leader.rate-limited":
      icon = <HourglassIcon className="size-4 stroke-[1.8]" aria-hidden />;
      tone = fields.until !== null ? "text-warning" : "text-secondary-label";
      label =
        fields.until !== null
          ? `${lead} is rate-limited until ${new Date(fields.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : readableSummary;
      detail = fields.until !== null ? `the swarm keeps working; ${lead} gets a digest` : null;
      break;
  }

  return (
    <div className="group/worker flex select-none items-center gap-1.5 py-0.5">
      <span className={cn("flex size-6 shrink-0 items-center justify-center", tone)}>{icon}</span>
      <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
        <span className="shrink-0 truncate text-secondary-label">{label}</span>
        {detail ? <span className="min-w-0 truncate text-muted-foreground">{detail}</span> : null}
      </p>
      {onOpenFleet ? (
        <button
          type="button"
          onClick={onOpenFleet}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent/40 hover:text-foreground focus-visible:opacity-100 group-hover/worker:opacity-100"
          aria-label="Open the fleet panel"
        >
          <PanelRightOpenIcon className="size-3.5" aria-hidden />
          fleet
        </button>
      ) : null}
    </div>
  );
});

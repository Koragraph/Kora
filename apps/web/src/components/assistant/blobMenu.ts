/**
 * The blob's action menu (right-click on SwarmBlob, or the "⋯" button in WorkerFloatingWindow's
 * title bar) — one item builder shared by both trigger sites, rendered through the app's
 * `contextMenu.show` (native desktop menu, or `showContextMenuFallback` in the browser — see
 * localApi.ts). Pure: no DOM, no atoms, so enable/disable logic is unit-testable on its own.
 */
import type { ContextMenuItem, FleetWorker } from "@kora/contracts";

export type BlobMenuActionId =
  | "open-terminal"
  | "reference"
  | "retry"
  | "extend-menu"
  | "extend-5"
  | "extend-15"
  | "extend-30"
  | "stop";

const FINISHED_PHASES = new Set(["done", "exhausted", "failed"]);

/** A swarm worker's task is over — retrying or giving it more time no longer makes sense. */
export function isWorkerFinished(worker: FleetWorker): boolean {
  if (worker.state === "exited" || worker.state === "asleep") return true;
  const phase = worker.swarm?.phase;
  return phase != null && FINISHED_PHASES.has(phase);
}

export function buildBlobMenuItems(worker: FleetWorker): ContextMenuItem<BlobMenuActionId>[] {
  const isSwarm = worker.swarm != null;
  const finished = isWorkerFinished(worker);
  const retryDisabled = !isSwarm || finished;
  const extendDisabled = !isSwarm || finished;
  const stopDisabled = worker.state === "exited" || worker.state === "asleep";

  return [
    { id: "open-terminal", label: "Open terminal" },
    { id: "reference", label: "Reference in message" },
    {
      id: "retry",
      label: "Retry on a different model",
      disabled: retryDisabled,
      separatorBefore: true,
    },
    {
      id: "extend-menu",
      label: "Give it more time",
      disabled: extendDisabled,
      children: [
        { id: "extend-5", label: "5 min", disabled: extendDisabled },
        { id: "extend-15", label: "15 min", disabled: extendDisabled },
        { id: "extend-30", label: "30 min", disabled: extendDisabled },
      ],
    },
    {
      id: "stop",
      label: "Stop",
      destructive: true,
      disabled: stopDisabled,
      separatorBefore: true,
    },
  ];
}

/** Minutes to extend by for an `extend-N` action id; null for every other action. */
export function extendMinutesForAction(id: BlobMenuActionId): number | null {
  switch (id) {
    case "extend-5":
      return 5;
    case "extend-15":
      return 15;
    case "extend-30":
      return 30;
    default:
      return null;
  }
}

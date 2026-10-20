import type { FleetWorker } from "@kora/contracts";

/**
 * Finished workers leave the main pane grid and become small markers. A worker is finished once its process has
 * exited (done, failed or stopped by the human); everything still alive keeps its full tile.
 */
export type FinishedTone = "done" | "failed" | "stopped";

export interface FinishedMarker {
  readonly paneId: string;
  readonly agent: string;
  readonly title: string;
  readonly tone: FinishedTone;
  /** One short line for the hover: how it ended. */
  readonly result: string;
}

export function isFinishedWorker(worker: FleetWorker): boolean {
  return worker.state === "exited";
}

export function finishedTone(worker: FleetWorker): FinishedTone {
  if (worker.stoppedByUser) return "stopped";
  if (worker.exitCode !== null && worker.exitCode !== 0) return "failed";
  if (worker.swarm?.phase === "failed" || worker.swarm?.verify?.state === "failed") return "failed";
  return "done";
}

export function finishedMarker(worker: FleetWorker, merged: boolean): FinishedMarker {
  const tone = finishedTone(worker);
  const result =
    tone === "stopped"
      ? "Stopped by you"
      : tone === "failed"
        ? worker.exitCode !== null && worker.exitCode !== 0
          ? `Failed (exit ${worker.exitCode})`
          : "Failed"
        : merged
          ? "Done, merged"
          : worker.worktree
            ? "Done, branch kept"
            : "Done";
  return {
    paneId: worker.paneId,
    agent: worker.agent,
    title: worker.title.trim() || worker.agent,
    tone,
    result,
  };
}

/** Splits a roster into the workers that keep a tile and the finished ones that become markers. */
export function splitFinishedWorkers(workers: ReadonlyArray<FleetWorker>): {
  readonly active: ReadonlyArray<FleetWorker>;
  readonly finished: ReadonlyArray<FleetWorker>;
} {
  const active: FleetWorker[] = [];
  const finished: FleetWorker[] = [];
  for (const worker of workers) (isFinishedWorker(worker) ? finished : active).push(worker);
  return { active, finished };
}

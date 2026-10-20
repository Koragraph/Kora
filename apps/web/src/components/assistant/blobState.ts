/**
 * Pure state mapping for the Swarm blob dock (SwarmBlobDock.tsx): a `FleetWorker` → one of a small set of sprite
 * states, the accessory its agent wears, and the dock's grouping (working on top, the finished folded into a pile).
 * No React, no atoms — easy to unit test in isolation.
 */
import type { FleetWorker } from "@kora/contracts";

import type { SpriteAccessory, SpriteState } from "~/components/sprite";

/** The states the dock tells apart. `starting` is transient. */
export type BlobState = "starting" | "working" | "idle" | "blocked" | "done" | "failed" | "asleep";

/** Worker state -> sprite frame. */
export const SPRITE_STATE: Record<BlobState, SpriteState> = {
  starting: "idle",
  idle: "idle",
  working: "walk",
  blocked: "wait",
  done: "done",
  failed: "fail",
  asleep: "sleep",
};

/** One line for the tooltip / pane header. */
export function blobStateWord(state: BlobState): string {
  switch (state) {
    case "starting":
      return "starting…";
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "blocked":
      return "needs you";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "asleep":
      return "asleep";
  }
}

/**
 * Maps a worker's raw fleet state (+ swarm phase, when present) to one blob state. A live dialog
 * (blocked) or an exit always wins, mirroring `workerTileInfo` in FleetPanel.tsx — the two views
 * must never disagree about whether a worker needs the human.
 */
export function deriveBlobState(worker: FleetWorker): BlobState {
  // Asleep after work: no process, its answer and transcript kept (Wake resumes it).
  if (worker.state === "asleep") return "asleep";
  if (worker.state === "blocked") return "blocked";
  if (worker.state === "exited") {
    if (worker.swarm?.phase === "failed") return "failed";
    return worker.exitCode === null || worker.exitCode === 0 ? "done" : "failed";
  }
  const swarm = worker.swarm;
  if (swarm?.phase === "exhausted") return "blocked";
  if (swarm?.phase === "failed") return "failed";
  // A swarm task whose report passed the gate is finished even though its OpenCode pane idles on.
  if (swarm?.phase === "done" && worker.state !== "working") return "done";
  if (swarm?.phase === "starting" && (worker.state === "unknown" || worker.state === "idle")) {
    return "starting";
  }
  if (worker.state === "working") return "working";
  if (worker.stoppedOnError) return "failed";
  if (worker.turnEndedAt !== undefined) return "done"; // its turn finished: the answer is ready
  return "idle"; // idle or unknown, once past the starting window
}

/**
 * The harness, worn: every worker's sprite carries its agent's accessory, so the dock tells Claude from Codex without
 * a logo or a label beside it. Unknown agents go bare.
 */
export function agentAccessory(agent: string): SpriteAccessory | null {
  switch (agent) {
    case "claude":
      return "phones";
    case "codex":
      return "shades";
    case "antigravity":
    case "agy":
      return "cap";
    case "gemini":
      return "beret";
    case "opencode":
      return "beanie";
    case "koragent":
      return "tophat";
    case "cursor":
      return "square";
    case "grok":
      return "monocle";
    default:
      return null;
  }
}

/** Everything a sprite in the dock needs, computed once per worker. */
export interface BlobViewModel {
  readonly paneId: string;
  readonly title: string;
  readonly state: BlobState;
  readonly stateWord: string;
  readonly accessory: SpriteAccessory | null;
}

export function toBlobViewModel(worker: FleetWorker): BlobViewModel {
  const state = deriveBlobState(worker);
  return {
    paneId: worker.paneId,
    title: worker.title,
    state,
    stateWord: blobStateWord(state),
    accessory: agentAccessory(worker.agent),
  };
}

/** Finished, failed or asleep: folded into the dock's pile under the live ones. */
const RESTING: ReadonlySet<BlobState> = new Set(["done", "failed", "asleep"]);

/** Live workers' order: working first, always; then the ones waiting on the human; then starting / idle. */
const LIVE_RANK: Record<BlobState, number> = {
  working: 0,
  blocked: 1,
  starting: 2,
  idle: 2,
  done: 3,
  failed: 3,
  asleep: 3,
};

/**
 * The dock's two groups. `live`: working workers on top, then the rest still in play (needs you, starting, idle).
 * `resting`: done, failed and asleep workers, folded into one pile below. Each group keeps snapshot order within a
 * rank (a stable sort), so equal workers never swap places.
 */
export function dockGroups(workers: readonly FleetWorker[]): {
  readonly live: BlobViewModel[];
  readonly resting: BlobViewModel[];
} {
  const vms = workers.map((worker, index) => ({ vm: toBlobViewModel(worker), index }));
  const byRank = (
    a: { vm: BlobViewModel; index: number },
    b: { vm: BlobViewModel; index: number },
  ) => LIVE_RANK[a.vm.state] - LIVE_RANK[b.vm.state] || a.index - b.index;
  return {
    live: vms
      .filter((e) => !RESTING.has(e.vm.state))
      .sort(byRank)
      .map((e) => e.vm),
    resting: vms.filter((e) => RESTING.has(e.vm.state)).map((e) => e.vm),
  };
}

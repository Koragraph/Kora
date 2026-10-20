import type { FleetWorker } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import { buildBlobMenuItems, extendMinutesForAction, isWorkerFinished } from "./blobMenu";

const BASE: FleetWorker = {
  ...SWARM_FLEET_WORKER,
  state: "working",
  swarm: { ...SWARM_FLEET_WORKER.swarm!, phase: "running" },
} as FleetWorker;

function worker(over: Partial<FleetWorker>): FleetWorker {
  const merged: Record<string, unknown> = { ...BASE, ...over };
  return merged as FleetWorker;
}

function findItem(items: ReturnType<typeof buildBlobMenuItems>, id: string) {
  for (const item of items) {
    if (item.id === id) return item;
    for (const child of item.children ?? []) {
      if (child.id === id) return child;
    }
  }
  throw new Error(`menu item ${id} not found`);
}

describe("buildBlobMenuItems", () => {
  it("always offers Open terminal and Reference in message, enabled", () => {
    const items = buildBlobMenuItems(worker({}));
    expect(findItem(items, "open-terminal").disabled).toBeFalsy();
    expect(findItem(items, "reference").disabled).toBeFalsy();
  });

  it("enables retry and give-more-time for a live swarm worker", () => {
    const items = buildBlobMenuItems(worker({}));
    expect(findItem(items, "retry").disabled).toBeFalsy();
    expect(findItem(items, "extend-5").disabled).toBeFalsy();
    expect(findItem(items, "extend-15").disabled).toBeFalsy();
    expect(findItem(items, "extend-30").disabled).toBeFalsy();
  });

  it("disables retry and extend for a non-swarm (plain orchestrator) worker", () => {
    const merged: Record<string, unknown> = { ...worker({}) };
    delete merged.swarm;
    const items = buildBlobMenuItems(merged as FleetWorker);
    expect(findItem(items, "retry").disabled).toBe(true);
    expect(findItem(items, "extend-5").disabled).toBe(true);
  });

  it("disables retry and extend once the worker is exited", () => {
    const items = buildBlobMenuItems(worker({ state: "exited", exitCode: 0 }));
    expect(findItem(items, "retry").disabled).toBe(true);
    expect(findItem(items, "extend-15").disabled).toBe(true);
  });

  it("disables retry and extend once the swarm task is exhausted", () => {
    const items = buildBlobMenuItems(worker({ swarm: { ...BASE.swarm!, phase: "exhausted" } }));
    expect(findItem(items, "retry").disabled).toBe(true);
    expect(findItem(items, "extend-30").disabled).toBe(true);
  });

  it("disables retry and extend once the swarm task is done", () => {
    const items = buildBlobMenuItems(
      worker({ state: "idle", swarm: { ...BASE.swarm!, phase: "done" } }),
    );
    expect(findItem(items, "retry").disabled).toBe(true);
  });

  it("disables Stop only once the worker has exited", () => {
    expect(findItem(buildBlobMenuItems(worker({ state: "working" })), "stop").disabled).toBeFalsy();
    expect(
      findItem(buildBlobMenuItems(worker({ state: "exited", exitCode: 0 })), "stop").disabled,
    ).toBe(true);
  });
});

describe("isWorkerFinished", () => {
  it("true once exited, or the swarm phase is done/exhausted/failed", () => {
    expect(isWorkerFinished(worker({ state: "exited", exitCode: 0 }))).toBe(true);
    expect(isWorkerFinished(worker({ swarm: { ...BASE.swarm!, phase: "done" } }))).toBe(true);
    expect(isWorkerFinished(worker({ swarm: { ...BASE.swarm!, phase: "exhausted" } }))).toBe(true);
    expect(isWorkerFinished(worker({ swarm: { ...BASE.swarm!, phase: "failed" } }))).toBe(true);
  });

  it("false for a live worker", () => {
    expect(isWorkerFinished(worker({ state: "working" }))).toBe(false);
  });
});

describe("extendMinutesForAction", () => {
  it("maps extend-N ids to minutes, everything else to null", () => {
    expect(extendMinutesForAction("extend-5")).toBe(5);
    expect(extendMinutesForAction("extend-15")).toBe(15);
    expect(extendMinutesForAction("extend-30")).toBe(30);
    expect(extendMinutesForAction("retry")).toBeNull();
    expect(extendMinutesForAction("stop")).toBeNull();
  });
});

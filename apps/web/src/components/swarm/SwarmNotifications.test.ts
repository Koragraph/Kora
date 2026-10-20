import type { FleetSwarmWorker, FleetWorker } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import { swarmNotices } from "./SwarmNotifications";
import { deriveSwarmTask, type SwarmTask } from "./swarmTasks";

const base = SWARM_FLEET_WORKER.swarm as FleetSwarmWorker;
const task = (
  taskId: string,
  over: Partial<FleetSwarmWorker>,
  w: Partial<FleetWorker> = {},
): SwarmTask =>
  deriveSwarmTask([
    { ...SWARM_FLEET_WORKER, ...w, swarm: { ...base, taskId, ...over } } as FleetWorker,
  ])!;
const running = (id: string) => task(id, { phase: "running", verify: null, report: null });
const passed = (id: string) => task(id, {});

describe("swarmNotices", () => {
  it("the first reading is a baseline: nothing is announced", () => {
    expect(swarmNotices(null, [passed("a"), task("b", { phase: "failed", verify: null })])).toEqual(
      [],
    );
  });

  it("no notice while workers are simply working or one of several finishes", () => {
    expect(swarmNotices([running("a")], [running("a")])).toEqual([]);
    expect(swarmNotices([running("a"), running("b")], [passed("a"), running("b")])).toEqual([]);
  });

  it("one completion notice when the whole batch has settled", () => {
    const [n] = swarmNotices([passed("a"), running("b")], [passed("a"), passed("b")]);
    expect(n).toMatchObject({
      kind: "completion",
      title: "2 swarm tasks finished",
      body: "2 done",
    });
  });

  it("a worker that needs you is announced once, with what it needs", () => {
    const asking = task(
      "a",
      { phase: "running", verify: null },
      {
        state: "blocked",
        blocker: "Overwrite config?",
      },
    );
    const notices = swarmNotices([running("a"), running("b")], [asking, running("b")]);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "input",
        title: "Swarm worker needs you",
        body: "Add input validation to the signup form — Asking: Overwrite config?",
      }),
    ]);
    expect(swarmNotices([asking, running("b")], [asking, running("b")])).toEqual([]);
  });

  it("a failure is announced, and the batch end counts it", () => {
    const failed = task("b", { phase: "failed", verify: null }, { state: "exited", exitCode: 1 });
    const notices = swarmNotices([passed("a"), running("b")], [passed("a"), failed]);
    expect(notices.map((n) => [n.kind, n.title])).toEqual([
      ["input", "Swarm task failed"],
      ["completion", "2 swarm tasks finished"],
    ]);
    expect(notices[1]!.body).toBe("1 done · 1 failed");
  });
});

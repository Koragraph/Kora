import type { FleetWorker } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import {
  agentAccessory,
  blobStateWord,
  deriveBlobState,
  dockGroups,
  toBlobViewModel,
} from "./blobState";

const BASE: FleetWorker = {
  ...SWARM_FLEET_WORKER,
  agent: "opencode",
  swarm: { ...SWARM_FLEET_WORKER.swarm!, phase: "running" },
} as FleetWorker;

function worker(over: Partial<FleetWorker>): FleetWorker {
  return { ...BASE, ...over } as FleetWorker;
}

/** A worker with no `swarm` at all (a plain orchestrator worker), plus any other overrides. */
function workerNoSwarm(over: Partial<Omit<FleetWorker, "swarm">> = {}): FleetWorker {
  const merged: Record<string, unknown> = { ...BASE, ...over };
  delete merged.swarm;
  return merged as FleetWorker;
}

describe("deriveBlobState", () => {
  it("a CLI worker whose turn finished is done; one stopped on an API error has failed", () => {
    expect(deriveBlobState(workerNoSwarm({ state: "idle", turnEndedAt: 1 }))).toBe("done");
    expect(deriveBlobState(workerNoSwarm({ state: "idle", stoppedOnError: "500" }))).toBe("failed");
    expect(deriveBlobState(workerNoSwarm({ state: "idle" }))).toBe("idle");
  });
  it("a swarm task whose report passed is done while its pane idles on", () => {
    expect(
      deriveBlobState(worker({ state: "idle", swarm: { ...BASE.swarm!, phase: "done" } })),
    ).toBe("done");
    expect(
      deriveBlobState(worker({ state: "working", swarm: { ...BASE.swarm!, phase: "done" } })),
    ).toBe("working");
  });

  it("blocked wins outright, regardless of swarm phase", () => {
    expect(deriveBlobState(worker({ state: "blocked" }))).toBe("blocked");
    expect(
      deriveBlobState(worker({ state: "blocked", swarm: { ...BASE.swarm!, phase: "running" } })),
    ).toBe("blocked");
  });

  it("exited: exitCode 0 or null is done, non-zero is failed, and a swarm crash is always failed", () => {
    expect(deriveBlobState(worker({ state: "exited", exitCode: 0 }))).toBe("done");
    expect(deriveBlobState(worker({ state: "exited", exitCode: null }))).toBe("done");
    expect(deriveBlobState(worker({ state: "exited", exitCode: 1 }))).toBe("failed");
    expect(
      deriveBlobState(
        worker({
          state: "exited",
          exitCode: 0,
          swarm: { ...BASE.swarm!, phase: "failed" },
        }),
      ),
    ).toBe("failed");
  });

  it("swarm phase exhausted reads as needing the human; failed reads as failed", () => {
    expect(
      deriveBlobState(worker({ state: "idle", swarm: { ...BASE.swarm!, phase: "exhausted" } })),
    ).toBe("blocked");
    expect(
      deriveBlobState(worker({ state: "idle", swarm: { ...BASE.swarm!, phase: "failed" } })),
    ).toBe("failed");
  });

  it("starting only applies while the worker itself hasn't confirmed working yet", () => {
    expect(
      deriveBlobState(worker({ state: "unknown", swarm: { ...BASE.swarm!, phase: "starting" } })),
    ).toBe("starting");
    expect(
      deriveBlobState(worker({ state: "idle", swarm: { ...BASE.swarm!, phase: "starting" } })),
    ).toBe("starting");
    expect(
      deriveBlobState(worker({ state: "working", swarm: { ...BASE.swarm!, phase: "starting" } })),
    ).toBe("working");
  });

  it("working and idle map directly; unknown (no swarm) falls back to idle", () => {
    expect(deriveBlobState(workerNoSwarm({ state: "working" }))).toBe("working");
    expect(deriveBlobState(workerNoSwarm({ state: "idle" }))).toBe("idle");
    expect(deriveBlobState(workerNoSwarm({ state: "unknown" }))).toBe("idle");
  });
});

describe("blobStateWord", () => {
  it("has a distinct, non-empty word per state", () => {
    const states = ["starting", "working", "idle", "blocked", "done", "failed"] as const;
    const words = states.map(blobStateWord);
    expect(new Set(words).size).toBe(states.length);
    for (const w of words) expect(w.length).toBeGreaterThan(0);
  });
});

describe("agentAccessory", () => {
  it("dresses each harness differently, so the dock tells Claude from Codex without a label", () => {
    const worn = [
      "claude",
      "codex",
      "antigravity",
      "gemini",
      "opencode",
      "koragent",
      "cursor",
      "grok",
    ].map(agentAccessory);
    expect(worn).toEqual([
      "phones",
      "shades",
      "cap",
      "beret",
      "beanie",
      "tophat",
      "square",
      "monocle",
    ]);
    expect(new Set(worn).size).toBe(worn.length);
    expect(agentAccessory("agy")).toBe("cap");
    expect(agentAccessory("something-new")).toBeNull();
  });
});

describe("toBlobViewModel", () => {
  it("carries the worker identity, title and derived state word through", () => {
    const vm = toBlobViewModel(worker({ paneId: "p42", title: "Summarize the docs" }));
    expect(vm.paneId).toBe("p42");
    expect(vm.title).toBe("Summarize the docs");
    expect(vm.stateWord).toBe(blobStateWord(vm.state));
  });
});

describe("dockGroups", () => {
  const ids = (vms: ReadonlyArray<{ paneId: string }>) => vms.map((vm) => vm.paneId);

  it("puts working workers on top, then needs-you, then starting / idle; finished ones go to the pile", () => {
    const { live, resting } = dockGroups([
      worker({ paneId: "p1", state: "idle" }),
      worker({ paneId: "p2", state: "exited", exitCode: 0 }), // done
      worker({ paneId: "p3", state: "blocked" }),
      worker({ paneId: "p4", state: "working" }),
      worker({ paneId: "p5", state: "exited", exitCode: 1 }), // failed
      worker({ paneId: "p6", state: "working" }),
      worker({ paneId: "p7", state: "asleep" }),
    ]);
    expect(ids(live)).toEqual(["p4", "p6", "p3", "p1"]);
    expect(ids(resting)).toEqual(["p2", "p5", "p7"]);
  });

  it("a live worker whose turn ended folds into the pile, and climbs back on top when it works again", () => {
    const before = dockGroups([
      workerNoSwarm({ paneId: "a", state: "idle", turnEndedAt: 5 }), // done turn, still live
      workerNoSwarm({ paneId: "b", state: "working" }),
      workerNoSwarm({ paneId: "c", state: "idle", stoppedOnError: "500" }), // stopped on an error
    ]);
    expect(ids(before.live)).toEqual(["b"]);
    expect(ids(before.resting)).toEqual(["a", "c"]);
    const after = dockGroups([
      workerNoSwarm({ paneId: "a", state: "working" }),
      workerNoSwarm({ paneId: "b", state: "working" }),
    ]);
    expect(ids(after.live)).toEqual(["a", "b"]);
  });

  it("keeps snapshot order among equals, and carries each worker's accessory", () => {
    const { live } = dockGroups([
      workerNoSwarm({ paneId: "x", agent: "codex", state: "working" }),
      workerNoSwarm({ paneId: "y", agent: "claude", state: "working" }),
    ]);
    expect(live.map((vm) => [vm.paneId, vm.accessory])).toEqual([
      ["x", "shades"],
      ["y", "phones"],
    ]);
  });

  it("returns empty groups for an empty roster", () => {
    expect(dockGroups([])).toEqual({ live: [], resting: [] });
  });
});

import type { FleetSnapshot, FleetSwarmWorker, FleetWorker } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import {
  deriveSwarmTask,
  deriveSwarmTasks,
  formatSwarmValueMeter,
  leadName,
  formatTaskElapsed,
  isSwarmTaskSettled,
} from "./swarmTasks";

const base = SWARM_FLEET_WORKER.swarm as FleetSwarmWorker;
const worker = (over: Partial<FleetSwarmWorker> = {}, w: Partial<FleetWorker> = {}): FleetWorker =>
  ({ ...SWARM_FLEET_WORKER, ...w, swarm: { ...base, ...over } }) as FleetWorker;
const task = (over: Partial<FleetSwarmWorker> = {}, w: Partial<FleetWorker> = {}) =>
  deriveSwarmTask([worker(over, w)])!;

describe("deriveSwarmTask", () => {
  it("a worker the human stopped reads as Stopped (settled, nothing needs them), never Failed", () => {
    const t = task(
      { phase: "failed", verify: null, report: null },
      { state: "exited", stoppedByUser: true },
    );
    expect(t).toMatchObject({
      state: "stopped",
      needsYou: false,
      activity: "Stopped by you · its branch is kept",
    });
    expect(isSwarmTaskSettled(t)).toBe(true);
    expect(task({ phase: "failed", verify: null, report: null }, { state: "exited" }).state).toBe(
      "failed",
    );
  });

  it("the fixture: finished, checked after one bounce → passed, report first line as activity", () => {
    const t = task();
    expect(t).toMatchObject({
      taskId: "s3",
      title: "Add input validation to the signup form",
      state: "passed",
      model: "zen · big-pickle",
      attempt: 2,
      maxAttempts: null,
      activity: "Added zod validation to src/signup/form.ts; 3 new tests pass.",
      needsYou: false,
      startedAt: 1790000200000,
      endedAt: 1790000500000,
      paneIds: ["p5", "p7"],
    });
    expect(isSwarmTaskSettled(t)).toBe(true);
  });

  it("maps every phase to a calm state with a plain-language line", () => {
    const live = { verify: null, report: null };
    expect(task({ ...live, phase: "starting" }, { state: "unknown" })).toMatchObject({
      state: "queued",
      endedAt: null,
    });
    expect(task({ ...live, phase: "starting" }, { state: "working" }).state).toBe("running");
    expect(task({ ...live, phase: "running" }).state).toBe("running");
    expect(task({ ...live, phase: "rate-limited" })).toMatchObject({
      state: "cooling-down",
      activity: "big-pickle is rate-limited; waiting or switching to another free model",
    });
    expect(task({ ...live, phase: "respawning" }).state).toBe("cooling-down");
    expect(task({ ...live, phase: "exhausted" })).toMatchObject({
      state: "cooling-down",
      needsYou: true,
    });
    expect(task({ ...live, phase: "failed" }, { state: "exited", exitCode: 1 })).toMatchObject({
      state: "failed",
      activity: "OpenCode stopped (exit code 1)",
      needsYou: true,
    });
    expect(task({ ...live, phase: "done" }).state).toBe("done");
  });

  it("the merge check: pending → checking, bounced → retrying with the finding, failed → failed", () => {
    expect(task({ verify: { state: "pending", bounces: 0, summary: null } })).toMatchObject({
      state: "checking",
      endedAt: null,
    });
    expect(
      task({
        phase: "running",
        verify: { state: "bounced", bounces: 1, summary: "broken caller" },
      }),
    ).toMatchObject({ state: "retrying", activity: "Sent back to fix: broken caller" });
    expect(task({ verify: { state: "failed", bounces: 2, summary: "types" } })).toMatchObject({
      state: "failed",
      needsYou: true,
      activity: "The change failed its check: types",
    });
  });

  it("a worker's question always shows, and flags the task", () => {
    expect(
      task({ phase: "running" }, { state: "blocked", blocker: "Overwrite file?" }),
    ).toMatchObject({
      needsYou: true,
      activity: "Asking: Overwrite file?",
    });
  });

  it("renders the foreman stage when present (optional field)", () => {
    const withForeman = (foreman: unknown) =>
      deriveSwarmTask([worker({ phase: "running", verify: null, foreman } as never)])!;
    expect(
      withForeman({ state: "checking", attempt: 1, maxAttempts: 3, verdicts: [] }),
    ).toMatchObject({ state: "checking", attempt: 2, maxAttempts: 3 });
    expect(
      withForeman({
        state: "retrying",
        attempt: 2,
        maxAttempts: 3,
        verdicts: [{ failure: "check" }],
      }),
    ).toMatchObject({ state: "retrying", activity: "Retrying: the done-check failed" });
    expect(
      withForeman({
        state: "escalated",
        attempt: 3,
        maxAttempts: 3,
        verdicts: [],
        result: { kind: "escalation", lastFailure: "3 tests fail\nmore" },
      }),
    ).toMatchObject({
      state: "failed",
      needsYou: true,
      activity: "Gave up: 3 tests fail",
      attempt: 3,
    });
    expect(
      withForeman({
        state: "passed",
        attempt: 1,
        maxAttempts: 3,
        verdicts: [],
        result: { kind: "pass", diffStat: "2 files changed, 10 insertions(+)" },
      }),
    ).toMatchObject({ state: "passed", activity: "2 files changed, 10 insertions(+)" });
  });
});

describe("deriveSwarmTasks", () => {
  it("groups a failover's panes into one task (newest attempt) and skips non-swarm workers", () => {
    const old = worker(
      { attempt: 1, supersededBy: "p7", phase: "respawning" },
      { paneId: "p5", createdAt: 1 },
    );
    const other = worker({ taskId: "s4", attempt: 1, previousPaneIds: [] }, { paneId: "p8" });
    const plain = { ...SWARM_FLEET_WORKER, paneId: "p9", agent: "claude" } as FleetWorker;
    delete (plain as { swarm?: unknown }).swarm;
    const tasks = deriveSwarmTasks({
      workers: [old, worker(), other, plain],
    } as unknown as FleetSnapshot);
    expect(tasks.map((t) => [t.taskId, t.worker.paneId])).toEqual([
      ["s3", "p7"],
      ["s4", "p8"],
    ]);
    expect(deriveSwarmTasks(null)).toEqual([]);
  });
});

describe("leadName", () => {
  it("names the thread's driver, else its provider pick, else Claude", () => {
    expect(leadName({ session: { providerName: "codex" } })).toBe("Codex");
    expect(leadName({ session: null, modelSelection: { instanceId: "opencode" } })).toBe(
      "OpenCode",
    );
    expect(leadName(null)).toBe("Claude");
    expect(leadName({ session: { providerName: "antigravity" } })).toBe("The lead");
  });
});

describe("formatSwarmValueMeter", () => {
  const activity = {
    delegated: 3,
    reportsReturned: 3,
    respawns: 0,
    passedFirstTry: 2,
    bounced: 1,
    byModel: [
      {
        provider: "zen" as const,
        model: "opencode/big-pickle",
        modelLabel: "big-pickle",
        workers: 1,
      },
    ],
    exhausted: false,
  };

  it("measured numbers only; missing parts are left out, never estimated", () => {
    expect(formatSwarmValueMeter(null).summary).toBe("workers did 0 tasks");
    expect(formatSwarmValueMeter(activity).summary).toBe("workers did 3 tasks (free)");
    const full = formatSwarmValueMeter({
      ...activity,
      leaderTokens: { input: 1_500, cached: 250_000, output: 8_000, turns: 2 },
      workerTokens: { input: 300_000, cached: 100_000, output: 10_000, tasks: 3 },
    });
    expect(full.summary).toBe(
      "Claude used 9.5k new tokens (+250k cached) · workers did 3 tasks (410k tokens, free)",
    );
    expect(full.detail.join("\n")).toContain("measured by OpenCode for 3 tasks");
    const codex = formatSwarmValueMeter(
      { ...activity, leaderTokens: { input: 1_500, cached: 0, output: 8_000, turns: 2 } },
      "Codex",
    );
    expect(codex.summary).toContain("Codex used 9.5k new tokens");
    expect(codex.detail[0]).toMatch(/^Codex: /);
    for (const line of [full.summary, ...full.detail]) {
      expect(line).not.toContain("$");
      expect(line.toLowerCase()).not.toContain("sav");
    }
  });

  it("does not call a paid model's work free", () => {
    const paid = formatSwarmValueMeter({
      ...activity,
      byModel: [
        {
          provider: "openrouter",
          model: "openrouter/qwen/qwen3-coder",
          modelLabel: "qwen",
          workers: 1,
        },
      ],
      workerTokens: { input: 1000, cached: 0, output: 10, tasks: 1 },
    });
    expect(paid.summary).toBe("workers did 3 tasks (1k tokens)");
  });
});

describe("formatTaskElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatTaskElapsed(42_400)).toBe("42s");
    expect(formatTaskElapsed(185_000)).toBe("3m 05s");
    expect(formatTaskElapsed(3_720_000)).toBe("1h 02m");
    expect(formatTaskElapsed(-5)).toBe("0s");
  });
});

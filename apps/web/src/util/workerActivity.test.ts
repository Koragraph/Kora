import { describe, expect, it } from "vite-plus/test";

import {
  agentModeLabel,
  isWorkerActivityKind,
  leaderRateLimitedUntil,
  parseWorkerActivity,
} from "./workerActivity";

describe("worker activity kinds", () => {
  it("knows the swarm, mode and leader kinds", () => {
    for (const kind of [
      "worker.report",
      "worker.respawned",
      "worker.rate-limited",
      "worker.bounced",
      "agent-mode.switched",
      "leader.rate-limited",
      "worker.attached",
    ]) {
      expect(isWorkerActivityKind(kind)).toBe(true);
    }
    expect(isWorkerActivityKind("tool_result")).toBe(false);
    expect(isWorkerActivityKind(undefined)).toBe(false);
  });

  it("parses the swarm payload fields", () => {
    const report = parseWorkerActivity({
      paneId: "p4",
      taskId: "t1",
      verify: { state: "passed", bounces: 1, summary: null },
    });
    expect(report).toMatchObject({ paneId: "p4", verifyState: "passed", verifyBounces: 1 });
    const hop = parseWorkerActivity({
      paneId: "p5",
      newPaneId: "p7",
      fromModel: "a",
      toModel: "b",
    });
    expect(hop).toMatchObject({ newPaneId: "p7", fromModel: "a", toModel: "b" });
    expect(parseWorkerActivity({ tried: ["x", 3, "y"] }).tried).toEqual(["x", "y"]);
    expect(parseWorkerActivity({ from: "chat", to: "swarm" })).toMatchObject({
      from: "chat",
      to: "swarm",
    });
    expect(parseWorkerActivity(null).until).toBeNull();
  });

  it("reads the leader's rate-limit window from the latest leader.rate-limited activity", () => {
    const now = 1_000_000;
    const hit = { kind: "leader.rate-limited", payload: { until: now + 60_000 } };
    const reset = { kind: "leader.rate-limited", payload: { until: null } };
    const other = { kind: "worker.report", payload: {} };
    expect(leaderRateLimitedUntil([hit, other], now)).toBe(now + 60_000);
    expect(leaderRateLimitedUntil([hit, reset], now)).toBeNull();
    expect(leaderRateLimitedUntil([hit], now + 120_000)).toBeNull();
    expect(leaderRateLimitedUntil([], now)).toBeNull();
  });

  it("labels agent modes", () => {
    expect(agentModeLabel("swarm")).toBe("Stretch");
    expect(agentModeLabel("orchestrator")).toBe("Orchestrator");
    expect(agentModeLabel(null)).toBe("");
  });
});

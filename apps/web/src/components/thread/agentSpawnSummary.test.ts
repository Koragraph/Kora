import type { RuntimeSubagent } from "@kora/client-runtime/store/subagentRuntime";
import { describe, expect, test } from "vite-plus/test";

import { deriveAgentSpawnSummary } from "./agentSpawnSummary";

type State = RuntimeSubagent["status"];
const one = (status: State) => ({ kind: "subagent" as const, status });
const batch = (status: State) => ({ kind: "subagent_batch" as const, status });

describe("deriveAgentSpawnSummary", () => {
  test.each([
    ["failed", "Workflow failed", "failed"],
    ["cancelled", "Workflow stopped", "inactive"],
  ] as const)(
    "a %s coordinator wins even if every child completed",
    (coordinatorStatus, status, tone) => {
      expect(
        deriveAgentSpawnSummary({ agents: [one("completed")], agentCount: 1, coordinatorStatus }),
      ).toMatchObject({
        live: false,
        status,
        tone,
      });
    },
  );

  test("a running coordinator stays live between child launches", () => {
    expect(
      deriveAgentSpawnSummary({
        agents: [one("completed")],
        agentCount: 1,
        coordinatorStatus: "running",
      }),
    ).toMatchObject({ live: true, status: "working", tone: "working" });
  });

  test("a roster shorter than the announced count never claims completion", () => {
    expect(deriveAgentSpawnSummary({ agents: [one("completed")], agentCount: 2 })).toMatchObject({
      tone: "inactive",
      status: "Status unavailable",
    });
  });

  test.each([
    ["completed", "✓ completed", "completed"],
    ["failed", "1 failed", "failed"],
    ["interrupted", "1 stopped", "inactive"],
    ["cancelled", "1 stopped", "inactive"],
    ["idle", "1 idle", "inactive"],
  ] as const)("next to a completed agent, one that is %s reads '%s'", (state, status, tone) => {
    expect(
      deriveAgentSpawnSummary({ agents: [one("completed"), one(state)], agentCount: 2 }),
    ).toMatchObject({
      live: false,
      status,
      tone,
    });
  });

  test("agents and batches are counted separately in the lead sentence", () => {
    expect(
      deriveAgentSpawnSummary({
        agentCount: 3,
        agents: [one("running"), batch("running"), batch("idle")],
      }).lead,
    ).toBe("Launched 1 subagent and 2 batches");
  });

  test.each([
    ["running", { tone: "working", status: "1 working", live: true }],
    ["idle", { tone: "inactive", status: "1 idle", live: false }],
  ] as const)(
    "a lone %s batch is reported without guessing how many children it has",
    (state, expected) => {
      expect(deriveAgentSpawnSummary({ agents: [batch(state)], agentCount: 1 })).toEqual({
        ...expected,
        lead: "Launched 1 subagent batch",
      });
    },
  );
});

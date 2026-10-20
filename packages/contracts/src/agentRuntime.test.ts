import { describe, expect, it } from "vite-plus/test";

import { classifyTaskAgentKind } from "./agentRuntime.ts";

const kindOf = (taskType: string | undefined, agentId?: string) =>
  classifyTaskAgentKind(agentId === undefined ? { taskType } : { taskType, agentId });

describe("task agent kind", () => {
  it("counts agent and workflow tasks, unknown types and untyped tasks as agents", () => {
    for (const type of ["local_agent", "local_workflow", "something_new", undefined]) {
      expect(kindOf(type), String(type)).toBe("agent");
    }
  });

  it("counts shell, monitor and plan tasks as background work", () => {
    for (const type of ["local_bash", "monitor", "plan"]) expect(kindOf(type)).toBe("background");
  });

  it("treats a task owned by an agent as background unless it is itself an agent", () => {
    expect(kindOf("local_bash", "parent")).toBe("background");
    expect(kindOf(undefined, "parent")).toBe("background");
    // A nested agent can outlive its parent, so it stays in the roster.
    expect(kindOf("local_agent", "parent")).toBe("agent");
  });
});

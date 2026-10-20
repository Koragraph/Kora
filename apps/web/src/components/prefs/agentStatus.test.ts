import { AgentId, AgentProfileId, type AgentStatus } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { getAgentSummary } from "./agentStatus";

const READY: AgentStatus = {
  models: [],
  skills: [],
  slashCommands: [],
  checkedAt: "2026-08-23T00:00:00.000Z",
  auth: { status: "authenticated", label: "ChatGPT" },
  status: "ready",
  version: "1.0.0",
  installed: true,
  enabled: true,
  driver: AgentId.make("codex"),
  instanceId: AgentProfileId.make("codex"),
};
const summary = (over: Partial<AgentStatus>) => getAgentSummary({ ...READY, ...over });

describe("getAgentSummary", () => {
  test("a disabled status reads Disabled even before the enabled flag catches up", () => {
    expect(summary({ status: "disabled" }).headline).toBe("Disabled");
  });

  test.each([
    [
      "an auth failure stays actionable",
      { status: "error", auth: { status: "unauthenticated" }, message: "Run codex login." },
      { headline: "Not signed in", detail: "Run codex login." },
    ],
    [
      "a warning is not hidden behind being signed in",
      { status: "warning", message: "Unsupported version." },
      { headline: "Needs attention", detail: "Unsupported version." },
    ],
    [
      "an error is not hidden behind a previous signed-in state",
      { status: "error", message: "Failed to start." },
      { headline: "Unavailable", detail: "Failed to start." },
    ],
    [
      "ready with unknown auth is simply available",
      { auth: { status: "unknown" } },
      { headline: "Available", detail: null },
    ],
  ] as const)("%s", (_label, over, expected) => {
    expect(summary(over as Partial<AgentStatus>)).toEqual(expected);
  });
});

import {
  AgentId,
  DEFAULT_UNIFIED_PREFS,
  AgentProfileId,
  type AgentStatus,
  type UnifiedPrefs,
} from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentReadiness, buildAgentRows, partitionAgentRows } from "./agentRows";

const claude = AgentId.make("claude");
const codex = AgentId.make("codex");

function live(patch: Partial<AgentStatus>): AgentStatus {
  return {
    instanceId: AgentProfileId.make("claude"),
    driver: claude,
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

describe("buildAgentRows", () => {
  it("lists each driver's built-in slot, then its extra instances, then unknown drivers", () => {
    const settings = {
      ...DEFAULT_UNIFIED_PREFS,
      providerInstances: {
        [AgentProfileId.make("codex_work")]: { driver: codex, enabled: true },
        [AgentProfileId.make("forkd")]: { driver: AgentId.make("forkd"), enabled: true },
      },
    } as unknown as UnifiedPrefs;
    const rows = buildAgentRows(settings, [codex, claude]);
    expect(rows.map((row) => [String(row.instanceId), row.isDefault])).toEqual([
      ["codex", true],
      ["codex_work", false],
      ["claude", true],
      ["forkd", false],
    ]);
  });

  it("marks a built-in slot dirty only when it differs from the shipped defaults", () => {
    const rows = buildAgentRows(DEFAULT_UNIFIED_PREFS as UnifiedPrefs, [claude]);
    expect(rows[0]?.isDirty).toBe(false);
  });
});

describe("agentReadiness", () => {
  it("reads Off for a turned-off agent whatever its last probe said", () => {
    expect(agentReadiness({ driver: claude, enabled: false }, live({})).state).toBe("off");
  });

  it("maps the daemon's probe onto ready / attention / error / checking", () => {
    const on = { driver: claude, enabled: true } as const;
    expect(agentReadiness(on, live({})).headline).toBe("Ready · signed in");
    expect(agentReadiness(on, live({ auth: { status: "unauthenticated" } })).state).toBe(
      "attention",
    );
    expect(agentReadiness(on, live({ installed: false })).headline).toBe("Not installed");
    expect(agentReadiness(on, live({ status: "error" })).state).toBe("error");
    expect(agentReadiness(on, undefined).state).toBe("checking");
  });
});

describe("partitionAgentRows", () => {
  it("splits on the enabled flag and keeps order", () => {
    const rows = [
      { id: 1, instance: { driver: claude, enabled: true } },
      { id: 2, instance: { driver: codex, enabled: false } },
      { id: 3, instance: { driver: codex, enabled: true } },
    ];
    const { on, off } = partitionAgentRows(rows);
    expect(on.map((row) => row.id)).toEqual([1, 3]);
    expect(off.map((row) => row.id)).toEqual([2]);
  });
});

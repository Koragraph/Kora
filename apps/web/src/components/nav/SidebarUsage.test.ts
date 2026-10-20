import { describe, expect, it } from "vite-plus/test";
import type { AgentStatus } from "@kora/contracts";

import { pickUsageProvider } from "./SidebarUsage";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const limits = (used: number) =>
  ({
    checkedAt: "2026-10-13T11:56:00Z",
    plan: "Max",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour session",
        usedPercent: used,
        resetsAt: "2026-10-13T14:00:00Z",
      },
    ],
  }) as never;
const status = (driver: string, usageLimits?: never) =>
  ({ driver, instanceId: driver, usageLimits }) as unknown as AgentStatus;

describe("pickUsageProvider", () => {
  it("prefers the open thread's agent when it has a plan reading", () => {
    const list = [status("claude", limits(10)), status("codex", limits(50))];
    expect(pickUsageProvider(list, "codex", null, NOW)?.driver).toBe("codex");
  });

  it("falls back to the first plan with data, and to nothing", () => {
    const list = [status("opencode"), status("claude", limits(10))];
    expect(pickUsageProvider(list, "opencode", null, NOW)?.driver).toBe("claude");
    expect(pickUsageProvider([status("opencode")], "opencode", null, NOW)).toBeNull();
  });
});

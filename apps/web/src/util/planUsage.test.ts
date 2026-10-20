import { describe, expect, it } from "vite-plus/test";
import type { AgentUsageLimits } from "@kora/contracts";

import {
  activePlanLimit,
  formatDuration,
  formatResetPhrase,
  headlineWindow,
  planWindowViews,
  usageTone,
} from "./planUsage";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const limits: AgentUsageLimits = {
  checkedAt: "2026-10-02T11:59:00Z",
  plan: "Max",
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour session",
      usedPercent: 92,
      resetsAt: "2026-10-02T14:14:00Z",
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly · all models",
      usedPercent: 40,
      resetsAt: "2026-10-01T00:00:00Z",
    },
  ],
};

describe("planUsage", () => {
  it("shows a window whose reset already passed as empty, and colours by how full it is", () => {
    const views = planWindowViews(limits, NOW);
    expect(views.map((v) => [v.id, v.usedPercent, v.hasReset, v.tone])).toEqual([
      ["five_hour", 92, false, "critical"],
      ["seven_day", 0, true, "normal"],
    ]);
    expect(headlineWindow(views)?.id).toBe("five_hour");
    expect(planWindowViews(null, NOW)).toEqual([]);
    expect(usageTone(75)).toBe("warning");
    expect(usageTone(74.9)).toBe("normal");
  });

  it("a hit limit is active until its reset, then lifts without a new probe", () => {
    const hit: AgentUsageLimits = {
      ...limits,
      limited: { resetsAt: "2026-10-16T14:55:00Z", message: "You’ve hit your usage limit." },
    };
    expect(activePlanLimit(hit, NOW)).toEqual({
      resetsAt: Date.parse("2026-10-16T14:55:00Z"),
      message: "You’ve hit your usage limit.",
    });
    expect(activePlanLimit(hit, Date.parse("2026-10-17T00:00:00Z"))).toBeNull();
    expect(activePlanLimit({ ...limits, limited: {} }, NOW)).toEqual({
      resetsAt: null,
      message: null,
    });
    expect(activePlanLimit(limits, NOW)).toBeNull();
  });

  it("phrases resets relative when close, by weekday this week, by date later", () => {
    expect(formatResetPhrase(NOW + 2 * 3_600_000 + 14 * 60_000, NOW)).toBe("resets in 2h 14m");
    expect(formatResetPhrase(Date.parse("2026-10-05T21:00:00Z"), NOW, "UTC")).toBe(
      "resets Mon 9:00 PM",
    );
    expect(formatResetPhrase(Date.parse("2026-10-16T14:55:00Z"), NOW, "UTC")).toBe(
      "resets Oct 16, 2:55 PM",
    );
    expect(formatResetPhrase(NOW - 1, NOW)).toBe("reset");
    expect(formatResetPhrase(null, NOW)).toBeNull();
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });
});

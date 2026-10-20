import { describe, expect, it } from "vite-plus/test";

import { remainingPercent } from "./planLimits.ts";

const weekly = {
  resetsAt: "2025-08-01T00:00:00.000Z",
  windowDurationMins: 7 * 24 * 60,
  label: "Week",
  kind: "weekly",
  id: "seven_day",
} as const;

describe("remaining usage", () => {
  it.each([
    [25, 75],
    [0, 100],
    [100, 0],
    [66.6, 33],
    [12.4, 88],
  ])("%d%% used leaves %d%%", (usedPercent, left) => {
    expect(remainingPercent({ ...weekly, usedPercent })).toBe(left);
  });
});
